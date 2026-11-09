import { formatMinor, isCurrency, parseDecimalToMinor } from "../domain/money.js";
import {
  ProviderError, ProviderTimeoutError, type CreateOrderInput, type PaymentProvider, type ProviderCapture,
  type ProviderCaptureStatus, type ProviderMoney, type ProviderOrder, type ProviderOrderStatus,
} from "./PaymentProvider.js";

/** The only PayPal host this code will ever call. Live is refused by construction. */
export const PAYPAL_SANDBOX_API = "https://api-m.sandbox.paypal.com";
const ID_RE = /^[A-Z0-9]{8,36}$/;

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});

export interface PayPalSandboxConfig { clientId: string; clientSecret: string; env: string; timeoutMs?: number; fetchImpl?: typeof fetch }

/**
 * PayPal Orders v2 adapter (intent CAPTURE), Sandbox only. Credentials stay server-side;
 * error messages carry only HTTP status and PayPal debug id, never bodies or secrets.
 */
export class PayPalSandboxProvider implements PaymentProvider {
  readonly name = "PAYPAL_SANDBOX" as const;
  private token: { value: string; expiresAt: number } | null = null;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly cfg: PayPalSandboxConfig) {
    if (cfg.env.toUpperCase() !== "SANDBOX") throw new Error("PayPalSandboxProvider refuses any PAYPAL_ENV other than SANDBOX");
    if (!cfg.clientId || !cfg.clientSecret) throw new Error("PayPal Sandbox credentials are not configured");
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  private async send(path: string, init: RequestInit, label: string): Promise<{ status: number; body: Json; debugId: string | null }> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${PAYPAL_SANDBOX_API}${path}`, { ...init, signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 20_000) });
    } catch (e) {
      throw new ProviderTimeoutError(`PayPal ${label}: network error or timeout (${e instanceof Error ? e.name : "unknown"})`);
    }
    const text = await res.text();
    let body: Json = {};
    try { body = text ? obj(JSON.parse(text)) : {}; } catch { /* non-JSON */ }
    return { status: res.status, body, debugId: res.headers.get("paypal-debug-id") };
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const basic = Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString("base64");
    const r = await this.send("/v1/oauth2/token", { method: "POST", headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" }, body: "grant_type=client_credentials" }, "oauth");
    if (r.status !== 200 || typeof r.body.access_token !== "string") throw new ProviderError(`PayPal OAuth failed HTTP ${r.status}`, r.status, r.debugId);
    const ttl = typeof r.body.expires_in === "number" ? r.body.expires_in : 300;
    this.token = { value: r.body.access_token, expiresAt: Date.now() + ttl * 1000 };
    return this.token.value;
  }

  private async api(method: "GET" | "POST", path: string, label: string, body?: unknown, requestId?: string) {
    const token = await this.accessToken();
    const r = await this.send(path, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Prefer: "return=representation", ...(requestId ? { "PayPal-Request-Id": requestId } : {}) },
      ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
    }, label);
    if (r.status >= 500) throw new ProviderTimeoutError(`PayPal ${label} HTTP ${r.status} (debug ${r.debugId ?? "n/a"}); outcome unknown, reconcile`);
    if (r.status < 200 || r.status >= 300) {
      const issue = typeof obj(Array.isArray(r.body.details) ? r.body.details[0] : null).issue === "string" ? String(obj((r.body.details as unknown[])[0]).issue) : String(r.body.name ?? "ERROR");
      throw new ProviderError(`PayPal ${label} failed HTTP ${r.status} ${issue} (debug ${r.debugId ?? "n/a"})`, r.status, r.debugId);
    }
    return r.body;
  }

  async createOrder(input: CreateOrderInput) {
    const body = {
      intent: "CAPTURE",
      purchase_units: [{
        reference_id: "diaporia-agent-commerce", custom_id: input.checkoutSessionId, description: input.description.slice(0, 127),
        amount: { currency_code: input.amount.currency, value: formatMinor(input.amount.amountMinor, input.amount.currency) },
        ...(input.payeeMerchantId ? { payee: { merchant_id: input.payeeMerchantId } } : {}),
      }],
      payment_source: { paypal: { experience_context: {
        user_action: "PAY_NOW", shipping_preference: "NO_SHIPPING", brand_name: "DIAPORIA Sandbox Demo",
        return_url: input.returnUrl, cancel_url: input.cancelUrl,
      } } },
    };
    const r = await this.api("POST", "/v2/checkout/orders", "create order", body, input.idempotencyKey);
    const id = r.id;
    if (typeof id !== "string" || !ID_RE.test(id)) throw new ProviderError("PayPal order id missing", null, null);
    const links = Array.isArray(r.links) ? r.links.map(obj) : [];
    const approve = links.find((l) => l.rel === "payer-action" || l.rel === "approve");
    const href = typeof approve?.href === "string" ? approve.href : null;
    if (!href || !/^https:\/\/www\.sandbox\.paypal\.com\//.test(href)) throw new ProviderError("PayPal Sandbox approval link missing or not a sandbox URL", null, null);
    return { orderId: id, approvalUrl: href };
  }

  async getOrder(orderId: string): Promise<ProviderOrder> {
    if (!ID_RE.test(orderId)) throw new ProviderError("Invalid order id", null, null);
    const r = await this.api("GET", `/v2/checkout/orders/${orderId}`, "get order");
    const pu = obj(Array.isArray(r.purchase_units) ? r.purchase_units[0] : null);
    const caps = Array.isArray(obj(pu.payments).captures) ? (obj(pu.payments).captures as unknown[]).map(parseCapture) : [];
    const payeeId = obj(pu.payee).merchant_id;
    const payeeEmail = obj(pu.payee).email_address;
    return { orderId: String(r.id), status: orderStatus(r.status), amount: money(pu.amount), customId: typeof pu.custom_id === "string" ? pu.custom_id : null, captures: caps,
      payee: { merchantId: typeof payeeId === "string" ? payeeId : null, emailAddress: typeof payeeEmail === "string" ? payeeEmail : null } };
  }

  async captureOrder(orderId: string, idempotencyKey: string): Promise<ProviderCapture> {
    if (!ID_RE.test(orderId)) throw new ProviderError("Invalid order id", null, null);
    const r = await this.api("POST", `/v2/checkout/orders/${orderId}/capture`, "capture order", {}, idempotencyKey);
    const pu = obj(Array.isArray(r.purchase_units) ? r.purchase_units[0] : null);
    const caps = obj(pu.payments).captures;
    const first = Array.isArray(caps) ? caps[0] : null;
    if (!first) throw new ProviderTimeoutError("PayPal capture response had no capture; reconcile");
    return parseCapture(first);
  }

  async getCapture(captureId: string): Promise<ProviderCapture> {
    if (!ID_RE.test(captureId)) throw new ProviderError("Invalid capture id", null, null);
    return parseCapture(await this.api("GET", `/v2/payments/captures/${captureId}`, "get capture"));
  }
}

const ORDER_STATUSES: ProviderOrderStatus[] = ["CREATED", "SAVED", "APPROVED", "VOIDED", "COMPLETED", "PAYER_ACTION_REQUIRED"];
const CAPTURE_STATUSES: ProviderCaptureStatus[] = ["COMPLETED", "PENDING", "DECLINED", "FAILED", "REFUNDED", "PARTIALLY_REFUNDED"];
function orderStatus(v: unknown): ProviderOrderStatus { return ORDER_STATUSES.includes(v as ProviderOrderStatus) ? (v as ProviderOrderStatus) : "UNRECOGNIZED"; }
function money(v: unknown): ProviderMoney | null {
  const m = obj(v);
  if (!isCurrency(m.currency_code) || typeof m.value !== "string") return null;
  try { return { currency: m.currency_code, amountMinor: parseDecimalToMinor(m.value, m.currency_code) }; } catch { return null; }
}
export function parseCapture(v: unknown): ProviderCapture {
  const c = obj(v);
  const status = CAPTURE_STATUSES.includes(c.status as ProviderCaptureStatus) ? (c.status as ProviderCaptureStatus) : "UNRECOGNIZED";
  const reason = obj(c.status_details).reason;
  return { captureId: String(c.id ?? ""), status, amount: money(c.amount), reason: typeof reason === "string" ? reason : null };
}
