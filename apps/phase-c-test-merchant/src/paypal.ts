import { fromValue } from "./catalog.js";
import { PAYPAL_SANDBOX_API_ORIGIN } from "./config.js";

/**
 * Seller-side PayPal Orders v2 access. ONLY the merchant server holds this; DIAPORIA never sees it.
 * Two implementations: an in-process MOCK (default, offline) and a Sandbox REST client whose only reachable origin
 * is https://api-m.sandbox.paypal.com.
 */
export interface CaptureView { id: string; status: string; amountMinor: number | null; currency: string | null }
export interface OrderView {
  id: string;
  status: string;
  amountMinor: number | null;
  currency: string | null;
  payeeMerchantId: string | null;
  customId: string | null;
  referenceId: string | null;
  captures: CaptureView[];
}

/** The outcome is not known (timeout, 5xx, network). Never treat as success or failure; reconcile with GET first. */
export class PayPalOutcomeUnknownError extends Error { constructor(readonly label: string, readonly httpStatus: number | null, readonly debugId: string | null = null) { super(`PayPal ${label}: outcome unknown (${httpStatus ?? "network"})`); } }
/** PayPal answered with a definite 4xx refusal; `issue` is PayPal's issue code when present (e.g. INSTRUMENT_DECLINED). */
export class PayPalRejectedError extends Error { constructor(readonly label: string, readonly httpStatus: number, readonly issue: string | null, readonly debugId: string | null = null) { super(`PayPal ${label}: rejected HTTP ${httpStatus}${issue ? ` ${issue}` : ""}`); } }

export interface MerchantPayPal {
  readonly kind: "MOCK" | "SANDBOX";
  createOrder(body: Record<string, unknown>, requestId: string): Promise<OrderView>;
  getOrder(orderId: string): Promise<OrderView>;
  captureOrder(orderId: string, requestId: string): Promise<OrderView>;
}

export const ORDER_ID = /^[A-Z0-9]{8,36}$/;
type Json = Record<string, any>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});

/** Reads only the fields the merchant verifies. Unknown/missing values become null, never defaults. */
export function parseOrderView(body: unknown): OrderView {
  const b = obj(body);
  const pu = obj(Array.isArray(b.purchase_units) ? b.purchase_units[0] : null);
  const amount = obj(pu.amount);
  const caps = Array.isArray(obj(pu.payments).captures) ? (obj(pu.payments).captures as unknown[]) : [];
  return {
    id: typeof b.id === "string" ? b.id : "",
    status: typeof b.status === "string" ? b.status : "UNKNOWN",
    amountMinor: fromValue(amount.value), currency: typeof amount.currency_code === "string" ? amount.currency_code : null,
    payeeMerchantId: typeof obj(pu.payee).merchant_id === "string" ? obj(pu.payee).merchant_id : null,
    customId: typeof pu.custom_id === "string" ? pu.custom_id : null,
    referenceId: typeof pu.reference_id === "string" ? pu.reference_id : null,
    captures: caps.map((c) => { const x = obj(c); const a = obj(x.amount);
      return { id: typeof x.id === "string" ? x.id : "", status: typeof x.status === "string" ? x.status : "UNKNOWN", amountMinor: fromValue(a.value), currency: typeof a.currency_code === "string" ? a.currency_code : null }; }),
  };
}

export interface SandboxClientOptions { clientId: string; clientSecret: string; fetchImpl?: typeof fetch; timeoutMs?: number; now?: () => number }

/** PayPal Orders v2 REST client, Sandbox only. Errors carry HTTP status and PayPal-Debug-Id, never bodies or secrets. */
export class PayPalSandboxOrdersClient implements MerchantPayPal {
  readonly kind = "SANDBOX" as const;
  #secret: string;
  #token: { value: string; expiresAt: number } | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  constructor(private readonly o: SandboxClientOptions) {
    if (!o.clientId || !o.clientSecret) throw new Error("Sandbox credentials missing");
    this.#secret = o.clientSecret;
    this.fetchImpl = o.fetchImpl ?? fetch;
    this.now = o.now ?? Date.now;
  }
  toJSON() { return { kind: this.kind, clientSecret: "[SECRET]" }; }

  private async send(path: string, init: RequestInit, label: string): Promise<{ status: number; body: Json; debugId: string | null }> {
    const url = new URL(path, PAYPAL_SANDBOX_API_ORIGIN);
    // Defense in depth: even a crafted path can never leave the Sandbox API origin.
    if (url.origin !== PAYPAL_SANDBOX_API_ORIGIN) throw new Error("refusing non-Sandbox PayPal origin");
    let res: Response;
    try { res = await this.fetchImpl(url.href, { ...init, redirect: "error", signal: AbortSignal.timeout(this.o.timeoutMs ?? 20_000) }); }
    catch { throw new PayPalOutcomeUnknownError(label, null); }
    const text = await res.text().catch(() => "");
    let body: Json = {};
    try { body = text ? obj(JSON.parse(text)) : {}; } catch { /* non-JSON */ }
    return { status: res.status, body, debugId: res.headers.get("paypal-debug-id") };
  }

  private async token(): Promise<string> {
    if (this.#token && this.#token.expiresAt > this.now() + 60_000) return this.#token.value;
    const basic = Buffer.from(`${this.o.clientId}:${this.#secret}`).toString("base64");
    const r = await this.send("/v1/oauth2/token", { method: "POST", headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: "grant_type=client_credentials" }, "oauth");
    if (r.status !== 200 || typeof r.body.access_token !== "string") throw new PayPalRejectedError("oauth", r.status, null, r.debugId);
    this.#token = { value: r.body.access_token, expiresAt: this.now() + (typeof r.body.expires_in === "number" ? r.body.expires_in : 300) * 1000 };
    return this.#token.value;
  }

  private async api(method: "GET" | "POST", path: string, label: string, body?: unknown, requestId?: string): Promise<OrderView> {
    const t = await this.token();
    const r = await this.send(path, { method, headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json", Prefer: "return=representation",
      ...(requestId ? { "PayPal-Request-Id": requestId } : {}) }, ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}) }, label);
    if (r.status >= 200 && r.status < 300) {
      const v = parseOrderView(r.body);
      if (!ORDER_ID.test(v.id)) throw new PayPalOutcomeUnknownError(label, r.status, r.debugId);
      return v;
    }
    if (r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429) {
      const issue = Array.isArray(r.body.details) && typeof obj(r.body.details[0]).issue === "string" ? obj(r.body.details[0]).issue : (typeof r.body.name === "string" ? r.body.name : null);
      throw new PayPalRejectedError(label, r.status, issue, r.debugId);
    }
    throw new PayPalOutcomeUnknownError(label, r.status, r.debugId);
  }

  createOrder(body: Record<string, unknown>, requestId: string) { return this.api("POST", "/v2/checkout/orders", "create order", body, requestId); }
  getOrder(orderId: string) {
    if (!ORDER_ID.test(orderId)) throw new Error("bad order id");
    return this.api("GET", `/v2/checkout/orders/${orderId}`, "get order");
  }
  captureOrder(orderId: string, requestId: string) {
    if (!ORDER_ID.test(orderId)) throw new Error("bad order id");
    return this.api("POST", `/v2/checkout/orders/${orderId}/capture`, "capture", {}, requestId);
  }
}

export interface MockKnobs {
  /** Outcome of capture in the mock. */
  captureOutcome: "COMPLETED" | "PENDING" | "DECLINED" | "TIMEOUT";
  /** Mock PayPal reports a different payee than the configured seller. */
  payeeOverride: string | null;
  /** Mock PayPal reports a different amount than requested. */
  amountOverrideMinor: number | null;
  /** Create order times out (outcome unknown). */
  createTimeout: boolean;
}

/**
 * Deterministic, offline stand-in for PayPal Orders v2. Order ids are a counter (MOCKORDER000001...).
 * Honors PayPal-Request-Id like the real API: the same request id returns the same resource.
 * "Buyer approval" is simulated by `buyerApprove`, called from the merchant's MOCK popup page.
 */
export class MockMerchantPayPal implements MerchantPayPal {
  readonly kind = "MOCK" as const;
  knobs: MockKnobs = { captureOutcome: "COMPLETED", payeeOverride: null, amountOverrideMinor: null, createTimeout: false };
  readonly calls = { create: 0, get: 0, capture: 0 };
  private seq = 0;
  private readonly orders = new Map<string, Json>();
  private readonly byRequestId = new Map<string, string>();
  constructor(knobs: Partial<MockKnobs> = {}) { Object.assign(this.knobs, knobs); }

  async createOrder(body: Record<string, unknown>, requestId: string): Promise<OrderView> {
    this.calls.create++;
    if (this.knobs.createTimeout) throw new PayPalOutcomeUnknownError("create order", null);
    const seen = this.byRequestId.get(`c:${requestId}`);
    if (seen) return parseOrderView(this.orders.get(seen));
    const id = `MOCKORDER${String(++this.seq).padStart(6, "0")}`;
    const pu = obj((body.purchase_units as unknown[] | undefined)?.[0]);
    const amount = { ...obj(pu.amount) };
    if (this.knobs.amountOverrideMinor !== null) amount.value = (this.knobs.amountOverrideMinor / 100).toFixed(2);
    const payee = { merchant_id: this.knobs.payeeOverride ?? obj(pu.payee).merchant_id };
    this.orders.set(id, { id, status: "CREATED", purchase_units: [{ ...pu, amount, payee }] });
    this.byRequestId.set(`c:${requestId}`, id);
    return parseOrderView(this.orders.get(id));
  }
  async getOrder(orderId: string): Promise<OrderView> {
    this.calls.get++;
    const o = this.orders.get(orderId);
    if (!o) throw new PayPalRejectedError("get order", 404, "RESOURCE_NOT_FOUND");
    return parseOrderView(o);
  }
  async captureOrder(orderId: string, requestId: string): Promise<OrderView> {
    this.calls.capture++;
    const o = this.orders.get(orderId);
    if (!o) throw new PayPalRejectedError("capture", 404, "RESOURCE_NOT_FOUND");
    const seen = this.byRequestId.get(`k:${requestId}`);
    if (seen === orderId) return parseOrderView(o);
    if (o.status === "COMPLETED") throw new PayPalRejectedError("capture", 422, "ORDER_ALREADY_CAPTURED");
    if (o.status !== "APPROVED") throw new PayPalRejectedError("capture", 422, "ORDER_NOT_APPROVED");
    if (this.knobs.captureOutcome === "TIMEOUT") {
      // The capture DID happen at "PayPal", but the response was lost: the merchant must not assume either way.
      this.applyCapture(o, "COMPLETED"); this.byRequestId.set(`k:${requestId}`, orderId);
      throw new PayPalOutcomeUnknownError("capture", null);
    }
    if (this.knobs.captureOutcome === "DECLINED") throw new PayPalRejectedError("capture", 422, "INSTRUMENT_DECLINED");
    this.applyCapture(o, this.knobs.captureOutcome);
    this.byRequestId.set(`k:${requestId}`, orderId);
    return parseOrderView(o);
  }
  private applyCapture(o: Json, status: "COMPLETED" | "PENDING") {
    const pu = o.purchase_units[0];
    o.status = status === "COMPLETED" ? "COMPLETED" : "APPROVED";
    pu.payments = { captures: [{ id: `MOCKCAP${o.id.slice(-6)}`, status, amount: { ...pu.amount } }] };
    if (status === "PENDING") o.status = "COMPLETED"; // PayPal: order COMPLETED while the capture itself is PENDING
  }
  /** MOCK popup only: the simulated buyer approves at "PayPal". */
  buyerApprove(orderId: string): boolean {
    const o = this.orders.get(orderId);
    if (!o || o.status !== "CREATED") return false;
    o.status = "APPROVED";
    return true;
  }
  /** Test hook: settle a PENDING capture. */
  settlePending(orderId: string, to: "COMPLETED" | "DECLINED") {
    const c = this.orders.get(orderId)?.purchase_units?.[0]?.payments?.captures?.[0];
    if (c) c.status = to;
  }
}
