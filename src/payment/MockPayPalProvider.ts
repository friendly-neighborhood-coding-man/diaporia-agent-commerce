import { randomBytes } from "node:crypto";
import {
  ProviderTimeoutError, type CreateOrderInput, type PaymentProvider, type ProviderCapture, type ProviderOrder,
} from "./PaymentProvider.js";

export type MockCaptureOutcome = "COMPLETED" | "PENDING" | "DECLINED" | "TIMEOUT_BEFORE_CAPTURE" | "TIMEOUT_AFTER_CAPTURE";

interface MockOrder extends ProviderOrder { returnUrl: string; cancelUrl: string; createKey: string }

/**
 * Offline stand-in for PayPal Orders v2. Every id is prefixed MOCK so it can never be
 * mistaken for Sandbox evidence. Buyer approval happens on a local page labelled MOCK.
 */
export class MockPayPalProvider implements PaymentProvider {
  readonly name = "MOCK_PAYPAL" as const;
  readonly calls = { createOrder: 0, getOrder: 0, captureOrder: 0, getCapture: 0 };
  private readonly orders = new Map<string, MockOrder>();
  private readonly byCreateKey = new Map<string, string>();
  private readonly captureByKey = new Map<string, ProviderCapture>();
  private readonly captures = new Map<string, ProviderCapture>();
  /** Outcomes consumed by successive capture calls; defaults to COMPLETED. */
  captureOutcomes: MockCaptureOutcome[] = [];

  constructor(private readonly baseUrl: string) {}

  async createOrder(input: CreateOrderInput) {
    this.calls.createOrder++;
    const existing = this.byCreateKey.get(input.idempotencyKey);
    if (existing) return { orderId: existing, approvalUrl: this.approvalUrl(existing) };
    const orderId = `MOCK${randomBytes(8).toString("hex").toUpperCase()}`;
    this.orders.set(orderId, { orderId, status: "CREATED", amount: { ...input.amount }, customId: input.checkoutSessionId, captures: [],
      payee: { merchantId: input.payeeMerchantId ?? "MOCKPAYEE-PLATFORM" },
      returnUrl: input.returnUrl, cancelUrl: input.cancelUrl, createKey: input.idempotencyKey });
    this.byCreateKey.set(input.idempotencyKey, orderId);
    return { orderId, approvalUrl: this.approvalUrl(orderId) };
  }

  private approvalUrl(orderId: string) { return `${this.baseUrl}/mock-paypal/checkout/${orderId}`; }

  /** Simulates the buyer approving on the hosted page. Returns the merchant return URL. */
  buyerApprove(orderId: string): string {
    const o = this.mustGet(orderId);
    if (o.status === "CREATED") o.status = "APPROVED";
    const u = new URL(o.returnUrl);
    u.searchParams.set("token", orderId);
    return u.toString();
  }

  buyerCancel(orderId: string): string {
    const o = this.mustGet(orderId);
    const u = new URL(o.cancelUrl);
    u.searchParams.set("token", orderId);
    return u.toString();
  }

  describe(orderId: string) { const o = this.orders.get(orderId); return o ? { ...o, captures: [...o.captures] } : null; }

  async getOrder(orderId: string): Promise<ProviderOrder> {
    this.calls.getOrder++;
    const o = this.mustGet(orderId);
    return { orderId: o.orderId, status: o.status, amount: o.amount, customId: o.customId, captures: o.captures.map((c) => ({ ...c })), payee: { ...o.payee } };
  }

  async captureOrder(orderId: string, idempotencyKey: string): Promise<ProviderCapture> {
    this.calls.captureOrder++;
    const replay = this.captureByKey.get(idempotencyKey);
    if (replay) return { ...replay };
    const o = this.mustGet(orderId);
    const outcome = this.captureOutcomes.shift() ?? "COMPLETED";
    if (outcome === "TIMEOUT_BEFORE_CAPTURE") throw new ProviderTimeoutError("Mock network timeout before the capture reached PayPal");
    if (o.status !== "APPROVED") throw new Error(`Mock order ${orderId} is ${o.status}, not APPROVED`);
    const status = outcome === "TIMEOUT_AFTER_CAPTURE" ? "COMPLETED" : outcome;
    const capture: ProviderCapture = { captureId: `MOCKCAP${randomBytes(6).toString("hex").toUpperCase()}`, status, amount: o.amount,
      reason: status === "PENDING" ? "PENDING_REVIEW" : status === "DECLINED" ? "INSTRUMENT_DECLINED" : null };
    o.captures.push(capture);
    if (status === "COMPLETED" || status === "PENDING") o.status = "COMPLETED";
    this.captures.set(capture.captureId, capture);
    this.captureByKey.set(idempotencyKey, capture);
    if (outcome === "TIMEOUT_AFTER_CAPTURE") throw new ProviderTimeoutError("Mock network timeout after the capture was processed");
    return { ...capture };
  }

  /** Test hook: the next N getCapture calls fail like a network timeout. */
  getCaptureFailures = 0;

  async getCapture(captureId: string): Promise<ProviderCapture> {
    this.calls.getCapture++;
    if (this.getCaptureFailures > 0) { this.getCaptureFailures--; throw new ProviderTimeoutError("Mock timeout reading capture"); }
    const c = this.captures.get(captureId);
    if (!c) throw new Error("Unknown mock capture");
    return { ...c };
  }

  /** Test hook: simulate an order whose recipient was substituted after creation. */
  substitutePayee(orderId: string, merchantId: string | null, emailAddress?: string | null) { this.mustGet(orderId).payee = { merchantId, ...(emailAddress !== undefined ? { emailAddress } : {}) }; }

  /** Test hook: move a pending capture to a final state, as PayPal would later. */
  /** Test hook: provider-side refund of a capture (as PayPal would report it later). */
  refundCapture(captureId: string) { const c = this.captures.get(captureId); if (c) c.status = "REFUNDED"; }

  /** Test hook: report a different amount for a capture (provider/local conflict). */
  tamperCaptureAmount(captureId: string, amountMinor: number) { const c = this.captures.get(captureId); if (c && c.amount) c.amount = { ...c.amount, amountMinor }; }

  settleCapture(captureId: string, status: "COMPLETED" | "DECLINED") {
    const c = this.captures.get(captureId);
    if (c) { c.status = status; c.reason = null; }
  }

  private mustGet(orderId: string): MockOrder {
    const o = this.orders.get(orderId);
    if (!o) throw new Error("Unknown mock order");
    return o;
  }
}
