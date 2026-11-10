import { isCurrency, parseDecimalToMinor, formatMinor } from "../../domain/money.js";
import { ProviderError, ProviderTimeoutError, type ProviderMoney } from "../../payment/PaymentProvider.js";
import type { WebhookHeaders, WebhookSignatureVerifier, WebhookVerification } from "../../payment/PayPalWebhook.js";
import type { ManagedPlanTerms } from "./plans.js";
import { validateTerms } from "./plans.js";

/**
 * PayPal Subscriptions v1 adapter (Catalog Products v1 + Billing Plans/Subscriptions v1 + Notifications v1),
 * SANDBOX ONLY. Production-shaped: OAuth client credentials, PayPal-Request-Id idempotency on every POST,
 * strict response parsing, errors that carry only HTTP status and PayPal debug id.
 *
 * Structural limits (enforced by an endpoint allowlist in `send`, not by convention):
 *  - no /capture (outstanding-balance charge), no /activate, /suspend or /revise;
 *  - no Orders, Vault, payment-token, billing-agreement or reference-transaction endpoint;
 *  - so this code can never debit a PayPal balance on its own initiative (no merchant-initiated charges).
 * PayPal itself charges the fixed plan price each cycle after the BUYER approved the subscription on PayPal.
 */
export const PAYPAL_SANDBOX_API = "https://api-m.sandbox.paypal.com";

const SUB_ID = /^I-[A-Z0-9]{6,40}$/;
const PLAN_ID = /^P-[A-Z0-9]{6,40}$/;
const PROD_ID = /^PROD-[A-Z0-9]{6,40}$/;
const SALE_ID = /^[A-Z0-9]{8,40}$/;

/** Every endpoint this adapter may call. Anything else is refused before a request is made. */
export const ALLOWED_ENDPOINTS: ReadonlyArray<readonly [string, RegExp]> = Object.freeze([
  ["POST", /^\/v1\/oauth2\/token$/],
  ["POST", /^\/v1\/catalogs\/products$/],
  ["POST", /^\/v1\/billing\/plans$/],
  ["POST", /^\/v1\/billing\/subscriptions$/],
  ["GET", /^\/v1\/billing\/subscriptions\/I-[A-Z0-9]{6,40}$/],
  ["POST", /^\/v1\/billing\/subscriptions\/I-[A-Z0-9]{6,40}\/cancel$/],
  ["GET", /^\/v1\/payments\/sale\/[A-Z0-9]{8,40}$/],
  ["POST", /^\/v1\/notifications\/verify-webhook-signature$/],
] as const);

export type PayPalSubscriptionStatus = "APPROVAL_PENDING" | "APPROVED" | "ACTIVE" | "SUSPENDED" | "CANCELLED" | "EXPIRED" | "UNRECOGNIZED";

/** Authoritative subscription state as read from PayPal (GET /v1/billing/subscriptions/{id}). */
export interface SubscriptionSnapshot {
  subscriptionId: string;
  status: PayPalSubscriptionStatus;
  planId: string | null;
  customId: string | null;
  /** Completed REGULAR cycles (paid periods). null when PayPal did not report it. */
  regularCyclesCompleted: number | null;
  lastPayment: { amount: ProviderMoney; time: string } | null;
  nextBillingTime: string | null;
  failedPaymentsCount: number | null;
  outstandingBalance: ProviderMoney | null;
  statusUpdateTime: string | null;
}

export interface SaleSnapshot { saleId: string; state: string; billingAgreementId: string | null; amount: ProviderMoney | null }

export interface SubscriptionsProvider {
  readonly name: "PAYPAL_SANDBOX_SUBSCRIPTIONS" | "MOCK_PAYPAL_SUBSCRIPTIONS";
  createProduct(input: { name: string; description: string; requestId: string }): Promise<{ productId: string }>;
  createPlan(input: { productId: string; terms: ManagedPlanTerms; requestId: string }): Promise<{ planId: string; status: string }>;
  createSubscription(input: { planId: string; customId: string; returnUrl: string; cancelUrl: string; requestId: string }): Promise<{ subscriptionId: string; status: PayPalSubscriptionStatus; approvalUrl: string }>;
  getSubscription(subscriptionId: string): Promise<SubscriptionSnapshot>;
  cancelSubscription(subscriptionId: string, reason: string, requestId: string): Promise<{ alreadyInactive: boolean }>;
  getSale(saleId: string): Promise<SaleSnapshot>;
}

export interface PayPalSubscriptionsConfig {
  clientId: string; clientSecret: string; env: string;
  timeoutMs?: number;
  /** Injected HTTP. Tests and the MOCK demo pass a fake PayPal; production uses global fetch. */
  fetchImpl?: typeof fetch;
  /** "MOCK" labels every output as mock (fake HTTP). Defaults to Sandbox. */
  label?: "SANDBOX" | "MOCK";
  brandName?: string;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});

export class PayPalSubscriptionsSandboxAdapter implements SubscriptionsProvider {
  readonly name: SubscriptionsProvider["name"];
  private token: { value: string; expiresAt: number } | null = null;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly cfg: PayPalSubscriptionsConfig) {
    if (cfg.env.toUpperCase() !== "SANDBOX") throw new Error("PayPal Subscriptions adapter refuses any PAYPAL_ENV other than SANDBOX");
    if (!cfg.clientId || !cfg.clientSecret) throw new Error("PayPal Sandbox credentials are not configured");
    this.fetchImpl = cfg.fetchImpl ?? fetch;
    this.name = cfg.label === "MOCK" ? "MOCK_PAYPAL_SUBSCRIPTIONS" : "PAYPAL_SANDBOX_SUBSCRIPTIONS";
  }

  /** Raw HTTP with the endpoint allowlist. `rawBody` is sent verbatim (webhook verification needs exact bytes). */
  private async send(method: "GET" | "POST", path: string, init: { headers: Record<string, string>; rawBody?: string }, label: string) {
    if (!ALLOWED_ENDPOINTS.some(([m, re]) => m === method && re.test(path))) throw new ProviderError(`Endpoint not allowed: ${method} ${path.replace(/[^/A-Za-z0-9_-]/g, "")}`, null, null);
    let res: Response;
    try {
      res = await this.fetchImpl(`${PAYPAL_SANDBOX_API}${path}`, { method, headers: init.headers, ...(init.rawBody !== undefined ? { body: init.rawBody } : {}),
        signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 20_000) });
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
    const r = await this.send("POST", "/v1/oauth2/token", { headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" }, rawBody: "grant_type=client_credentials" }, "oauth");
    if (r.status !== 200 || typeof r.body.access_token !== "string") throw new ProviderError(`PayPal OAuth failed HTTP ${r.status}`, r.status, r.debugId);
    const ttl = typeof r.body.expires_in === "number" ? r.body.expires_in : 300;
    this.token = { value: r.body.access_token, expiresAt: Date.now() + ttl * 1000 };
    return this.token.value;
  }

  private async api(method: "GET" | "POST", path: string, label: string, opts: { body?: unknown; rawBody?: string; requestId?: string } = {}) {
    const token = await this.accessToken();
    const r = await this.send(method, path, {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Prefer: "return=representation", ...(opts.requestId ? { "PayPal-Request-Id": opts.requestId } : {}) },
      ...(method === "POST" ? { rawBody: opts.rawBody ?? JSON.stringify(opts.body ?? {}) } : {}),
    }, label);
    if (r.status >= 500) throw new ProviderTimeoutError(`PayPal ${label} HTTP ${r.status} (debug ${r.debugId ?? "n/a"}); outcome unknown`);
    if (r.status < 200 || r.status >= 300) throw new ProviderError(`PayPal ${label} failed HTTP ${r.status} ${issueOf(r.body)} (debug ${r.debugId ?? "n/a"})`, r.status, r.debugId);
    return r;
  }

  async createProduct(input: { name: string; description: string; requestId: string }) {
    const r = await this.api("POST", "/v1/catalogs/products", "create product", { requestId: input.requestId,
      body: { name: input.name.slice(0, 127), description: input.description.slice(0, 256), type: "SERVICE", category: "SOFTWARE" } });
    const id = r.body.id;
    if (typeof id !== "string" || !PROD_ID.test(id)) throw new ProviderError("PayPal product id missing or malformed", null, r.debugId);
    return { productId: id };
  }

  async createPlan(input: { productId: string; terms: ManagedPlanTerms; requestId: string }) {
    const v = validateTerms(input.terms);
    if (!v.offerable || input.terms.monthlyPriceMinor === null) throw new ProviderError(`Plan ${input.terms.planKey} has no known price; refusing to create it`, null, null);
    if (!PROD_ID.test(input.productId)) throw new ProviderError("Invalid product id", null, null);
    const body = {
      product_id: input.productId,
      name: `${input.terms.name} ${input.terms.version}`.slice(0, 127),
      description: `Fixed monthly plan. Included allowance ${formatMinor(input.terms.includedAllowanceMinor, "USD")} of service usage; overage denied.`.slice(0, 127),
      status: "ACTIVE",
      billing_cycles: [{
        frequency: { interval_unit: "MONTH", interval_count: 1 }, tenure_type: "REGULAR", sequence: 1, total_cycles: 0,
        pricing_scheme: { fixed_price: { value: formatMinor(input.terms.monthlyPriceMinor, "USD"), currency_code: "USD" } },
      }],
      // No setup fee; a failed payment is not retried into an outstanding balance that DIAPORIA would then capture.
      payment_preferences: { auto_bill_outstanding: false, setup_fee_failure_action: "CANCEL", payment_failure_threshold: 1 },
    };
    const r = await this.api("POST", "/v1/billing/plans", "create plan", { requestId: input.requestId, body });
    const id = r.body.id;
    if (typeof id !== "string" || !PLAN_ID.test(id)) throw new ProviderError("PayPal plan id missing or malformed", null, r.debugId);
    return { planId: id, status: String(r.body.status ?? "UNKNOWN") };
  }

  async createSubscription(input: { planId: string; customId: string; returnUrl: string; cancelUrl: string; requestId: string }) {
    if (!PLAN_ID.test(input.planId)) throw new ProviderError("Invalid plan id", null, null);
    const body = {
      plan_id: input.planId, custom_id: input.customId,
      application_context: { brand_name: this.cfg.brandName ?? "DIAPORIA Managed (Sandbox)", shipping_preference: "NO_SHIPPING", user_action: "SUBSCRIBE_NOW",
        return_url: input.returnUrl, cancel_url: input.cancelUrl },
    };
    const r = await this.api("POST", "/v1/billing/subscriptions", "create subscription", { requestId: input.requestId, body });
    const id = r.body.id;
    if (typeof id !== "string" || !SUB_ID.test(id)) throw new ProviderError("PayPal subscription id missing or malformed", null, r.debugId);
    const links = Array.isArray(r.body.links) ? r.body.links.map(obj) : [];
    const href = links.find((l) => l.rel === "approve")?.href;
    if (typeof href !== "string" || !/^https:\/\/www\.sandbox\.paypal\.com\//.test(href)) throw new ProviderError("PayPal Sandbox approval link missing or not a sandbox URL", null, r.debugId);
    return { subscriptionId: id, status: subStatus(r.body.status), approvalUrl: href };
  }

  async getSubscription(subscriptionId: string): Promise<SubscriptionSnapshot> {
    if (!SUB_ID.test(subscriptionId)) throw new ProviderError("Invalid subscription id", null, null);
    const r = await this.api("GET", `/v1/billing/subscriptions/${subscriptionId}`, "get subscription");
    return parseSubscription(r.body);
  }

  async cancelSubscription(subscriptionId: string, reason: string, requestId: string) {
    if (!SUB_ID.test(subscriptionId)) throw new ProviderError("Invalid subscription id", null, null);
    try {
      await this.api("POST", `/v1/billing/subscriptions/${subscriptionId}/cancel`, "cancel subscription", { requestId, body: { reason: reason.slice(0, 127) || "Cancelled by subscriber" } });
      return { alreadyInactive: false };
    } catch (e) {
      // 422 SUBSCRIPTION_STATUS_INVALID: already cancelled/expired (or not yet active). The caller re-reads status.
      if (e instanceof ProviderError && e.httpStatus === 422) return { alreadyInactive: true };
      throw e;
    }
  }

  async getSale(saleId: string): Promise<SaleSnapshot> {
    if (!SALE_ID.test(saleId)) throw new ProviderError("Invalid sale id", null, null);
    const r = await this.api("GET", `/v1/payments/sale/${saleId}`, "get sale");
    return { saleId: String(r.body.id ?? ""), state: String(r.body.state ?? "UNKNOWN"),
      billingAgreementId: typeof r.body.billing_agreement_id === "string" ? r.body.billing_agreement_id : null, amount: v1Amount(r.body.amount) };
  }

  /**
   * PayPal's own verification (POST /v1/notifications/verify-webhook-signature). The webhook_event is
   * spliced in as the RAW received JSON, so PayPal checks the exact bytes it signed (re-serializing a
   * parsed object can change them). Only verification_status === "SUCCESS" passes.
   */
  async verifyWebhookSignature(webhookId: string, h: WebhookHeaders, rawBody: string): Promise<WebhookVerification> {
    if (!h.transmissionId || !h.transmissionTime || !h.transmissionSig || !h.certUrl || !h.authAlgo) return { ok: false, reason: "missing PayPal transmission headers" };
    try { JSON.parse(rawBody); } catch { return { ok: false, reason: "body is not JSON" }; }
    const head = JSON.stringify({ auth_algo: h.authAlgo, cert_url: h.certUrl, transmission_id: h.transmissionId, transmission_sig: h.transmissionSig, transmission_time: h.transmissionTime, webhook_id: webhookId });
    const payload = `${head.slice(0, -1)},"webhook_event":${rawBody}}`;
    let r;
    try { r = await this.api("POST", "/v1/notifications/verify-webhook-signature", "verify webhook", { rawBody: payload }); }
    catch (e) { return { ok: false, reason: `verification call failed: ${e instanceof Error ? e.message.slice(0, 80) : "error"}` }; }
    return r.body.verification_status === "SUCCESS" ? { ok: true } : { ok: false, reason: "PayPal verification_status is not SUCCESS" };
  }
}

/** WebhookSignatureVerifier backed by PayPal's verification API (for the billing webhook listener). */
export class PayPalPostbackWebhookVerifier implements WebhookSignatureVerifier {
  constructor(private readonly adapter: PayPalSubscriptionsSandboxAdapter, private readonly webhookId: string) {
    if (!webhookId) throw new Error("PayPal billing webhook id is required");
  }
  verify(h: WebhookHeaders, rawBody: string) { return this.adapter.verifyWebhookSignature(this.webhookId, h, rawBody); }
}

const STATUSES: PayPalSubscriptionStatus[] = ["APPROVAL_PENDING", "APPROVED", "ACTIVE", "SUSPENDED", "CANCELLED", "EXPIRED"];
function subStatus(v: unknown): PayPalSubscriptionStatus { return STATUSES.includes(v as PayPalSubscriptionStatus) ? (v as PayPalSubscriptionStatus) : "UNRECOGNIZED"; }
function money(v: unknown): ProviderMoney | null {
  const m = obj(v);
  if (!isCurrency(m.currency_code) || typeof m.value !== "string") return null;
  try { return { currency: m.currency_code, amountMinor: parseDecimalToMinor(m.value, m.currency_code) }; } catch { return null; }
}
/** v1 Payments uses {total, currency}. */
function v1Amount(v: unknown): ProviderMoney | null {
  const m = obj(v);
  if (!isCurrency(m.currency) || typeof m.total !== "string") return null;
  try { return { currency: m.currency, amountMinor: parseDecimalToMinor(m.total, m.currency) }; } catch { return null; }
}
const isoOrNull = (v: unknown) => (typeof v === "string" && Number.isFinite(Date.parse(v)) ? v : null);

export function parseSubscription(v: unknown): SubscriptionSnapshot {
  const b = obj(v);
  const bi = obj(b.billing_info);
  const regular = (Array.isArray(bi.cycle_executions) ? bi.cycle_executions.map(obj) : []).find((c) => c.tenure_type === "REGULAR");
  const lp = obj(bi.last_payment);
  const lpAmount = money(lp.amount); const lpTime = isoOrNull(lp.time);
  return {
    subscriptionId: String(b.id ?? ""), status: subStatus(b.status), planId: typeof b.plan_id === "string" ? b.plan_id : null,
    customId: typeof b.custom_id === "string" ? b.custom_id : null,
    regularCyclesCompleted: regular && Number.isSafeInteger(regular.cycles_completed) ? Number(regular.cycles_completed) : null,
    lastPayment: lpAmount && lpTime ? { amount: lpAmount, time: lpTime } : null,
    nextBillingTime: isoOrNull(bi.next_billing_time),
    failedPaymentsCount: Number.isSafeInteger(bi.failed_payments_count) ? Number(bi.failed_payments_count) : null,
    outstandingBalance: money(bi.outstanding_balance), statusUpdateTime: isoOrNull(b.status_update_time),
  };
}
function issueOf(body: Json): string {
  const d = obj(Array.isArray(body.details) ? body.details[0] : null);
  return typeof d.issue === "string" ? d.issue : String(body.name ?? "ERROR");
}
