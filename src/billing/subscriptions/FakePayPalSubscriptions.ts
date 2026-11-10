import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { addOneMonthUtc } from "./ManagedSubscriptionBilling.js";

/**
 * In-memory FAKE of the PayPal Sandbox endpoints the subscriptions adapter uses. Used by tests and the
 * MOCK demo through the adapter's injected `fetchImpl`; it never opens a socket. Every id it issues
 * contains "MOCK" so it cannot be confused with a real Sandbox object.
 *
 * Webhook verification is modelled on PayPal's postback API: the fake "sends" an event (records the
 * transmission) and answers verify-webhook-signature with SUCCESS only for that exact transmission,
 * webhook id and event. Tampered bodies, forged headers or another webhook id get FAILURE.
 */
interface FakeSub {
  id: string; plan_id: string; custom_id: string; status: string; status_update_time: string; priceValue: string;
  cycles: number; last_payment: { amount: { currency_code: string; value: string }; time: string } | null; next_billing_time: string | null; failed: number;
}
interface FakeSale { id: string; state: string; billing_agreement_id: string; amount: { total: string; currency: string } }

export class FakePayPalSubscriptions {
  readonly calls: string[] = [];
  readonly products = new Map<string, { id: string; name: string }>();
  readonly plans = new Map<string, { id: string; product_id: string; price: string; currency: string }>();
  readonly subs = new Map<string, FakeSub>();
  readonly sales = new Map<string, FakeSale>();
  private readonly idem = new Map<string, { status: number; body: unknown }>();
  private readonly transmissions = new Map<string, { sig: string; time: string; certUrl: string; webhookId: string; event: unknown }>();
  /** Next N API calls (not OAuth) fail: "timeout" throws like a network error, 500 returns a server error. */
  failNext: { n: number; kind: "timeout" | 500 } = { n: 0, kind: "timeout" };
  /** Optional override of what GET subscription returns (e.g. a wrong custom_id) for negative tests. */
  tamperSubscriptionRead: ((body: Record<string, unknown>) => Record<string, unknown>) | null = null;

  constructor(readonly webhookId = "MOCKWEBHOOK0001", private readonly now: () => number = Date.now) {}

  private id(prefix: string) { return `${prefix}MOCK${randomBytes(6).toString("hex").toUpperCase()}`; }
  private iso(t = this.now()) { return new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z"); }

  /** The fetch implementation to inject into PayPalSubscriptionsSandboxAdapter. */
  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.pathname;
    this.calls.push(`${method} ${path}`);
    if (url.origin !== "https://api-m.sandbox.paypal.com") throw new TypeError("fake: non-sandbox host");
    const headers = new Headers(init?.headers);
    if (path === "/v1/oauth2/token") return json(200, { access_token: "MOCK-ACCESS-TOKEN", token_type: "Bearer", expires_in: 32400, scope: "mock" });
    if (headers.get("authorization") !== "Bearer MOCK-ACCESS-TOKEN") return json(401, { name: "AUTHENTICATION_FAILURE" });
    if (this.failNext.n > 0) {
      this.failNext.n--;
      if (this.failNext.kind === "timeout") throw new DOMException("The operation timed out", "TimeoutError");
      return json(500, { name: "INTERNAL_SERVER_ERROR" });
    }
    const body = typeof init?.body === "string" && init.body ? JSON.parse(init.body) as Record<string, unknown> : {};
    const reqId = headers.get("paypal-request-id");
    if (method === "POST" && reqId) {
      const hit = this.idem.get(`${path}|${reqId}`);
      if (hit) return json(hit.status, hit.body);
    }
    const out = this.route(method, path, body);
    if (method === "POST" && reqId && out.status < 300) this.idem.set(`${path}|${reqId}`, out);
    return json(out.status, out.body);
  };

  private route(method: string, path: string, b: Record<string, unknown>): { status: number; body: unknown } {
    if (method === "POST" && path === "/v1/catalogs/products") {
      const p = { id: this.id("PROD-"), name: String(b.name) }; this.products.set(p.id, p); return { status: 201, body: p };
    }
    if (method === "POST" && path === "/v1/billing/plans") {
      const cyc = (b.billing_cycles as Array<Record<string, any>>)[0]!;
      const fp = cyc.pricing_scheme.fixed_price as { value: string; currency_code: string };
      if (!this.products.has(String(b.product_id))) return { status: 422, body: { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "INVALID_PRODUCT" }] } };
      const p = { id: this.id("P-"), product_id: String(b.product_id), price: fp.value, currency: fp.currency_code };
      this.plans.set(p.id, p);
      return { status: 201, body: { id: p.id, status: "ACTIVE", product_id: p.product_id } };
    }
    if (method === "POST" && path === "/v1/billing/subscriptions") {
      const plan = this.plans.get(String(b.plan_id));
      if (!plan) return { status: 422, body: { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "INVALID_PLAN" }] } };
      const s: FakeSub = { id: this.id("I-"), plan_id: plan.id, custom_id: String(b.custom_id), status: "APPROVAL_PENDING", status_update_time: this.iso(), priceValue: plan.price,
        cycles: 0, last_payment: null, next_billing_time: null, failed: 0 };
      this.subs.set(s.id, s);
      return { status: 201, body: { id: s.id, status: s.status, links: [{ rel: "approve", method: "GET", href: `https://www.sandbox.paypal.com/webapps/billing/subscriptions?ba_token=BA-${s.id.slice(2)}` }, { rel: "self", href: `https://api-m.sandbox.paypal.com/v1/billing/subscriptions/${s.id}` }] } };
    }
    let m = /^\/v1\/billing\/subscriptions\/(I-[A-Z0-9]+)$/.exec(path);
    if (method === "GET" && m) {
      const s = this.subs.get(m[1]!);
      if (!s) return { status: 404, body: { name: "RESOURCE_NOT_FOUND" } };
      const body: Record<string, unknown> = { id: s.id, plan_id: s.plan_id, custom_id: s.custom_id, status: s.status, status_update_time: s.status_update_time,
        billing_info: { outstanding_balance: { currency_code: "USD", value: "0.00" }, cycle_executions: [{ tenure_type: "REGULAR", sequence: 1, cycles_completed: s.cycles, cycles_remaining: 0, total_cycles: 0 }],
          ...(s.last_payment ? { last_payment: s.last_payment } : {}), ...(s.next_billing_time ? { next_billing_time: s.next_billing_time } : {}), failed_payments_count: s.failed } };
      return { status: 200, body: this.tamperSubscriptionRead ? this.tamperSubscriptionRead(body) : body };
    }
    m = /^\/v1\/billing\/subscriptions\/(I-[A-Z0-9]+)\/cancel$/.exec(path);
    if (method === "POST" && m) {
      const s = this.subs.get(m[1]!);
      if (!s) return { status: 404, body: { name: "RESOURCE_NOT_FOUND" } };
      if (s.status !== "ACTIVE" && s.status !== "SUSPENDED") return { status: 422, body: { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "SUBSCRIPTION_STATUS_INVALID" }] } };
      s.status = "CANCELLED"; s.status_update_time = this.iso(); s.next_billing_time = null;
      return { status: 204, body: "" };
    }
    m = /^\/v1\/payments\/sale\/([A-Z0-9]+)$/.exec(path);
    if (method === "GET" && m) {
      const s = this.sales.get(m[1]!);
      return s ? { status: 200, body: s } : { status: 404, body: { name: "RESOURCE_NOT_FOUND" } };
    }
    if (method === "POST" && path === "/v1/notifications/verify-webhook-signature") {
      const t = this.transmissions.get(String(b.transmission_id));
      const ok = !!t && t.sig === b.transmission_sig && t.time === b.transmission_time && t.certUrl === b.cert_url && b.auth_algo === "SHA256withRSA"
        && b.webhook_id === this.webhookId && t.webhookId === this.webhookId && isDeepStrictEqual(t.event, b.webhook_event);
      return { status: 200, body: { verification_status: ok ? "SUCCESS" : "FAILURE" } };
    }
    return { status: 404, body: { name: "RESOURCE_NOT_FOUND" } };
  }

  // ---------------------------------------------------------------- simulation controls (the "buyer" and "PayPal" side)
  /** Buyer approves on PayPal; PayPal activates and collects the first cycle (fake only). */
  buyerApproves(subId: string, opts: { pay?: boolean } = {}) {
    const s = this.subs.get(subId)!;
    s.status = "ACTIVE"; s.status_update_time = this.iso();
    if (opts.pay !== false) this.collectCycle(subId);
  }
  /** Buyer approved but PayPal has not activated yet. */
  buyerApprovesPendingActivation(subId: string) { const s = this.subs.get(subId)!; s.status = "APPROVED"; }
  /** PayPal collects the next fixed-price cycle (fake). Returns the sale id. */
  collectCycle(subId: string, amountOverride?: string): string {
    const s = this.subs.get(subId)!;
    s.cycles += 1;
    const value = amountOverride ?? s.priceValue;
    s.last_payment = { amount: { currency_code: "USD", value }, time: this.iso() };
    s.next_billing_time = this.iso(addOneMonthUtc(this.now()));
    const sale: FakeSale = { id: `MOCKSALE${randomBytes(5).toString("hex").toUpperCase()}`, state: "completed", billing_agreement_id: s.id, amount: { total: value, currency: "USD" } };
    this.sales.set(sale.id, sale);
    return sale.id;
  }
  setStatus(subId: string, status: string) { const s = this.subs.get(subId)!; s.status = status; s.status_update_time = this.iso(); }
  refundSale(saleId: string) { this.sales.get(saleId)!.state = "refunded"; }

  /** Builds a webhook delivery PayPal would send, and remembers it so the postback check succeeds. */
  makeWebhook(eventType: string, resource: Record<string, unknown>, opts: { eventId?: string; sentAt?: number } = {}) {
    const event = { id: opts.eventId ?? `WH-MOCK${randomBytes(8).toString("hex").toUpperCase()}`, event_version: "1.0", create_time: this.iso(opts.sentAt), resource_type: eventType.startsWith("PAYMENT.SALE") ? "sale" : "subscription",
      event_type: eventType, summary: `MOCK ${eventType}`, resource };
    const rawBody = JSON.stringify(event);
    const transmissionId = `mock-${randomBytes(8).toString("hex")}`;
    const time = this.iso(opts.sentAt);
    const sig = randomBytes(32).toString("base64");
    const certUrl = "https://api-m.sandbox.paypal.com/v1/notifications/certs/CERT-MOCK-0001";
    this.transmissions.set(transmissionId, { sig, time, certUrl, webhookId: this.webhookId, event });
    return { rawBody, eventId: event.id, headers: { transmissionId, transmissionTime: time, transmissionSig: sig, certUrl, authAlgo: "SHA256withRSA" } };
  }
  /** Calls whose path matches this would be a merchant-initiated charge. Must stay empty. */
  forbiddenCalls(): string[] { return this.calls.filter((c) => /\/capture|\/activate|\/suspend|\/revise|vault|payment-tokens|billing-agreements|\/v2\/checkout\/orders/.test(c)); }
}

function json(status: number, body: unknown): Response {
  const text = body === "" ? "" : JSON.stringify(body);
  return new Response(status === 204 ? null : text, { status, headers: { "content-type": "application/json", "paypal-debug-id": "mockdebug0001" } });
}
