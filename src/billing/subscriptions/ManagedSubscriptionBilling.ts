import { randomUUID } from "node:crypto";
import type { Store } from "../../store/Database.js";
import { UsageLimitError, type EntitlementGuard, type UsageLedger } from "../../metering/UsageLedger.js";
import { ProviderError, ProviderTimeoutError } from "../../payment/PaymentProvider.js";
import type { WebhookHeaders, WebhookSignatureVerifier } from "../../payment/PayPalWebhook.js";
import type { BillingAuthorization, BillingAuthorizationStatus, BillingProvider } from "../Billing.js";
import { termsDigest, validateTerms, type ManagedPlanTerms } from "./plans.js";
import type { SubscriptionSnapshot, SubscriptionsProvider } from "./PayPalSubscriptionsAdapter.js";

/**
 * DIAPORIA Managed subscription billing (Billing bounded context).
 *
 * What it guarantees:
 *  - A subscription is ACTIVE only after an authoritative server-to-PayPal read says so. A browser redirect
 *    or a webhook only TRIGGERS that read; their content is never trusted for state.
 *  - Usage is entitled only inside a PAID period: a grant created from PayPal's reported completed cycle
 *    and last payment, whose amount must equal the plan price the user authorized. One grant per
 *    (subscription, cycle), enforced by a UNIQUE key, so webhook replays and concurrent refreshes cannot
 *    create a second grant.
 *  - Allowance and per-operation caps are checked inside the UsageLedger's IMMEDIATE transaction
 *    (EntitlementGuard), so concurrent requests cannot overspend the allowance.
 *  - Unknown subscription state, stale verification, unknown prices, binding mismatches, refunds and
 *    reversals all DENY paid operations (fail closed).
 *  - DIAPORIA never charges the user itself: PayPal bills the fixed plan price after the buyer approved it.
 *    There is no capture, no vault and no merchant-initiated charge anywhere in this module.
 *  - Purchase mandates and merchandise checkout are untouched: an ACTIVE subscription never authorizes a
 *    purchase, and a purchase mandate never creates an entitlement.
 */
export type SubscriptionState =
  | "DRAFT" | "APPROVAL_PENDING" | "ACTIVE" | "SUSPENDED" | "CANCEL_REQUESTED" | "UNKNOWN"
  | "CANCELLED" | "EXPIRED" | "ABANDONED" | "FAILED";

export const OPEN_STATES: readonly SubscriptionState[] = ["DRAFT", "APPROVAL_PENDING", "ACTIVE", "SUSPENDED", "CANCEL_REQUESTED", "UNKNOWN"];
export const TERMINAL_STATES: readonly SubscriptionState[] = ["CANCELLED", "EXPIRED", "ABANDONED", "FAILED"];

/** Server-side transition table. Anything not listed is refused. */
export const SUBSCRIPTION_TRANSITIONS: Readonly<Record<SubscriptionState, readonly SubscriptionState[]>> = Object.freeze({
  DRAFT: ["APPROVAL_PENDING", "FAILED", "UNKNOWN", "ABANDONED"],
  APPROVAL_PENDING: ["ACTIVE", "SUSPENDED", "CANCEL_REQUESTED", "CANCELLED", "EXPIRED", "ABANDONED", "UNKNOWN"],
  ACTIVE: ["SUSPENDED", "CANCEL_REQUESTED", "CANCELLED", "EXPIRED", "UNKNOWN"],
  SUSPENDED: ["ACTIVE", "CANCEL_REQUESTED", "CANCELLED", "EXPIRED", "UNKNOWN"],
  CANCEL_REQUESTED: ["ACTIVE", "SUSPENDED", "CANCELLED", "EXPIRED", "UNKNOWN"],
  UNKNOWN: ["APPROVAL_PENDING", "ACTIVE", "SUSPENDED", "CANCEL_REQUESTED", "CANCELLED", "EXPIRED", "ABANDONED"],
  CANCELLED: [], EXPIRED: [], ABANDONED: [], FAILED: [],
});

export class SubscriptionError extends Error {
  constructor(readonly code: "PLAN_NOT_AVAILABLE" | "PRICE_UNKNOWN" | "TERMS_NOT_ACCEPTED" | "ALREADY_SUBSCRIBED" | "NOT_FOUND" | "INVALID_TRANSITION" | "PROVIDER_FAILED" | "PROVIDER_UNCERTAIN" | "RETURN_MISMATCH", message: string) { super(message); }
}

export interface SubscriptionRecord {
  id: string; userId: string; planKey: string; planVersion: string; paypalPlanId: string; terms: ManagedPlanTerms; termsDigest: string;
  state: SubscriptionState; version: number; provider: string; paypalSubscriptionId: string | null; approvalUrl: string | null;
  providerStatus: string | null; holdReason: string | null; lastError: string | null; lastVerifiedAt: number | null; approvalExpiresAt: number; createdAt: number; updatedAt: number;
}
export interface Grant {
  id: string; subscriptionId: string; userId: string; periodKey: string; periodStart: number; periodEnd: number; allowanceMinor: number;
  operationCaps: Record<string, number>; billedMinor: number; currency: string; termsDigest: string; status: "ACTIVE" | "REVOKED"; revokedReason: string | null;
}

export interface ManagedSubscriptionBillingOptions {
  /** Offered plans (terms). Only offerable (priced) plans can be subscribed to. */
  plans: readonly ManagedPlanTerms[];
  baseUrl: string;
  /** Verifies billing webhooks with PayPal's mechanism. Unset = webhook endpoint disabled. */
  webhookVerifier?: WebhookSignatureVerifier | null;
  /** Re-read PayPal when the last verification is older than this. Default 15 min. */
  refreshAfterMs?: number;
  /** Deny paid operations when the last successful verification is older than this. Default 24 h. */
  maxStatusAgeMs?: number;
  /** Local expiry of an unapproved subscription. Default 24 h. */
  approvalTtlMs?: number;
  /** PayPal retries webhooks for up to 3 days; older transmissions are rejected. */
  maxWebhookAgeMs?: number;
  now?: () => number;
}

const DAY = 86_400_000;
const SUB_EVENTS = ["BILLING.SUBSCRIPTION.CREATED", "BILLING.SUBSCRIPTION.ACTIVATED", "BILLING.SUBSCRIPTION.UPDATED", "BILLING.SUBSCRIPTION.RE-ACTIVATED",
  "BILLING.SUBSCRIPTION.SUSPENDED", "BILLING.SUBSCRIPTION.CANCELLED", "BILLING.SUBSCRIPTION.EXPIRED", "BILLING.SUBSCRIPTION.PAYMENT.FAILED"];
const SALE_COMPLETED = "PAYMENT.SALE.COMPLETED";
const SALE_NEGATIVE = ["PAYMENT.SALE.REFUNDED", "PAYMENT.SALE.REVERSED"];

export class ManagedSubscriptionBilling implements BillingProvider, EntitlementGuard {
  readonly name: string;
  private readonly now: () => number;
  private readonly plans: Map<string, ManagedPlanTerms>;

  constructor(private readonly store: Store, private readonly ledger: UsageLedger, readonly provider: SubscriptionsProvider, private readonly opts: ManagedSubscriptionBillingOptions) {
    this.now = opts.now ?? Date.now;
    this.name = provider.name === "MOCK_PAYPAL_SUBSCRIPTIONS" ? "mock-paypal-subscriptions-v1" : "paypal-sandbox-subscriptions-v1";
    this.plans = new Map();
    for (const t of opts.plans) { validateTerms(t); this.plans.set(t.planKey, t); }
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS managed_plans (plan_key TEXT NOT NULL, version TEXT NOT NULL, provider TEXT NOT NULL, terms_json TEXT NOT NULL, terms_digest TEXT NOT NULL,
        paypal_product_id TEXT NOT NULL, paypal_plan_id TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, PRIMARY KEY (plan_key, version, provider));
      CREATE TABLE IF NOT EXISTS managed_subscriptions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, plan_key TEXT NOT NULL, plan_version TEXT NOT NULL, paypal_plan_id TEXT NOT NULL,
        terms_json TEXT NOT NULL, terms_digest TEXT NOT NULL, state TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0, provider TEXT NOT NULL,
        paypal_subscription_id TEXT UNIQUE, approval_url TEXT, create_key TEXT NOT NULL UNIQUE, cancel_key TEXT NOT NULL UNIQUE, provider_status TEXT,
        hold_reason TEXT, last_error TEXT, last_verified_at INTEGER, approval_expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS one_open_subscription_per_user ON managed_subscriptions(user_id)
        WHERE state IN ('DRAFT','APPROVAL_PENDING','ACTIVE','SUSPENDED','CANCEL_REQUESTED','UNKNOWN');
      CREATE TABLE IF NOT EXISTS entitlement_grants (id TEXT PRIMARY KEY, subscription_id TEXT NOT NULL REFERENCES managed_subscriptions(id), user_id TEXT NOT NULL,
        period_key TEXT NOT NULL, period_start INTEGER NOT NULL, period_end INTEGER NOT NULL, allowance_minor INTEGER NOT NULL CHECK (allowance_minor >= 0),
        op_caps_json TEXT NOT NULL, billed_minor INTEGER NOT NULL CHECK (billed_minor >= 0), currency TEXT NOT NULL, terms_digest TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('ACTIVE','REVOKED')), revoked_reason TEXT, created_at INTEGER NOT NULL,
        CHECK (period_end > period_start), UNIQUE (subscription_id, period_key));
      CREATE INDEX IF NOT EXISTS grants_by_user ON entitlement_grants(user_id, period_start);
      CREATE TABLE IF NOT EXISTS subscription_webhook_events (event_id TEXT PRIMARY KEY, event_type TEXT NOT NULL, resource_id TEXT, subscription_id TEXT,
        received_at INTEGER NOT NULL, outcome TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS subscription_audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, subscription_id TEXT NOT NULL, user_id TEXT NOT NULL, type TEXT NOT NULL,
        data_json TEXT NOT NULL, at INTEGER NOT NULL);`);
    ledger.useEntitlementGuard(this);
  }

  // ------------------------------------------------------------------ plans (operator action)
  /** Offered plans with their terms digest. Unpriced plans are listed as not offerable. */
  listPlans() {
    return [...this.plans.values()].map((t) => {
      const v = validateTerms(t);
      const reg = this.registeredPlan(t);
      return { terms: t, termsDigest: termsDigest(t), offerable: v.offerable && reg !== null, reason: v.reason ?? (reg ? null : "PLAN_NOT_CREATED_AT_PROVIDER") };
    });
  }

  /**
   * Creates the PayPal product + plan for an offerable plan version (idempotent: deterministic
   * PayPal-Request-Ids and a local registry). OPERATOR action; never reachable from an AI client.
   */
  async ensurePlan(planKey: string): Promise<{ paypalPlanId: string; created: boolean }> {
    const t = this.plans.get(planKey);
    if (!t) throw new SubscriptionError("PLAN_NOT_AVAILABLE", `Unknown plan ${planKey}`);
    if (!validateTerms(t).offerable) throw new SubscriptionError("PRICE_UNKNOWN", `Plan ${planKey} ${t.version} has an UNKNOWN price and cannot be created`);
    const existing = this.registeredPlan(t);
    if (existing) return { paypalPlanId: existing.paypalPlanId, created: false };
    const digest = termsDigest(t);
    const { productId } = await this.provider.createProduct({ name: "DIAPORIA Managed", description: "DIAPORIA managed research service (Channel3, Tavily, KERNEL) within plan limits", requestId: `diaporia-product-${planKey}` });
    const { planId } = await this.provider.createPlan({ productId, terms: t, requestId: `diaporia-plan-${planKey}-${t.version}-${digest.slice(0, 16)}` });
    this.store.db.prepare("INSERT OR IGNORE INTO managed_plans(plan_key,version,provider,terms_json,terms_digest,paypal_product_id,paypal_plan_id,created_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(t.planKey, t.version, this.provider.name, JSON.stringify(t), digest, productId, planId, this.now());
    return { paypalPlanId: this.registeredPlan(t)!.paypalPlanId, created: true };
  }

  private registeredPlan(t: ManagedPlanTerms): { paypalPlanId: string; termsDigest: string } | null {
    const r = this.store.db.prepare("SELECT paypal_plan_id, terms_digest FROM managed_plans WHERE plan_key=? AND version=? AND provider=?").get(t.planKey, t.version, this.provider.name) as { paypal_plan_id: string; terms_digest: string } | undefined;
    if (!r) return null;
    if (r.terms_digest !== termsDigest(t)) throw new Error(`Plan ${t.planKey} ${t.version} is registered with different terms; use a new version`);
    return { paypalPlanId: r.paypal_plan_id, termsDigest: r.terms_digest };
  }

  // ------------------------------------------------------------------ subscribe (owner action)
  /**
   * The human owner subscribes once, explicitly accepting the plan terms by digest. Returns the PayPal
   * approval URL. Nothing is active until PayPal reports it. Idempotent per user: an open subscription
   * is returned instead of creating a second one.
   */
  async subscribe(userId: string, planKey: string, acceptedTermsDigest: string): Promise<{ subscription: SubscriptionRecord; approvalUrl: string | null }> {
    const t = this.plans.get(planKey);
    if (!t) throw new SubscriptionError("PLAN_NOT_AVAILABLE", `Unknown plan ${planKey}`);
    if (!validateTerms(t).offerable) throw new SubscriptionError("PRICE_UNKNOWN", "This plan has no known price; subscriptions are refused.");
    const reg = this.registeredPlan(t);
    if (!reg) throw new SubscriptionError("PLAN_NOT_AVAILABLE", "This plan has not been created at the billing provider yet.");
    if (acceptedTermsDigest !== reg.termsDigest) throw new SubscriptionError("TERMS_NOT_ACCEPTED", "The accepted terms digest does not match the current plan terms.");

    let sub = this.store.transaction(() => {
      const open = this.openFor(userId);
      if (open) return open;
      const id = `sub_${randomUUID()}`, t0 = this.now();
      this.store.db.prepare(`INSERT INTO managed_subscriptions(id,user_id,plan_key,plan_version,paypal_plan_id,terms_json,terms_digest,state,provider,create_key,cancel_key,approval_expires_at,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,'DRAFT',?,?,?,?,?,?)`).run(id, userId, t.planKey, t.version, reg.paypalPlanId, JSON.stringify(t), reg.termsDigest, this.provider.name,
        `dsc-create-${randomUUID()}`, `dsc-cancel-${randomUUID()}`, t0 + (this.opts.approvalTtlMs ?? DAY), t0, t0);
      this.audit(id, userId, "SUBSCRIPTION_DRAFTED", { planKey: t.planKey, planVersion: t.version, termsDigest: reg.termsDigest });
      return this.byId(id)!;
    });
    if (sub.state === "APPROVAL_PENDING") return { subscription: sub, approvalUrl: sub.approvalUrl };
    if (sub.state !== "DRAFT") throw new SubscriptionError("ALREADY_SUBSCRIBED", `An open subscription already exists (${sub.state}).`);
    if (sub.termsDigest !== acceptedTermsDigest) throw new SubscriptionError("TERMS_NOT_ACCEPTED", "A pending draft exists for different terms; cancel it first.");

    // Same PayPal-Request-Id on every retry: PayPal returns the same subscription instead of a second one.
    const createKey = (this.store.db.prepare("SELECT create_key FROM managed_subscriptions WHERE id=?").get(sub.id) as { create_key: string }).create_key;
    let created;
    try {
      created = await this.provider.createSubscription({ planId: sub.paypalPlanId, customId: sub.id, requestId: createKey,
        returnUrl: `${this.opts.baseUrl}/billing/subscription/return?subscription=${sub.id}`, cancelUrl: `${this.opts.baseUrl}/billing/subscription/cancel?subscription=${sub.id}` });
    } catch (e) {
      if (e instanceof ProviderTimeoutError) {
        this.setError(sub.id, e.message);
        throw new SubscriptionError("PROVIDER_UNCERTAIN", "PayPal did not answer; the subscription stays DRAFT. Retrying is safe (same idempotency key).");
      }
      this.transition(sub, "FAILED", { lastError: e instanceof Error ? e.message.slice(0, 200) : "error" }, "SUBSCRIPTION_CREATE_FAILED");
      throw new SubscriptionError("PROVIDER_FAILED", "PayPal refused to create the subscription.");
    }
    sub = this.store.transaction(() => {
      const cur = this.byId(sub.id)!;
      if (cur.state !== "DRAFT") return cur; // a concurrent call already recorded it (same PayPal subscription)
      return this.transition(cur, "APPROVAL_PENDING", { paypalSubscriptionId: created.subscriptionId, approvalUrl: created.approvalUrl, providerStatus: created.status }, "SUBSCRIPTION_CREATED_AT_PROVIDER");
    });
    return { subscription: sub, approvalUrl: sub.state === "APPROVAL_PENDING" ? sub.approvalUrl : null };
  }

  // ------------------------------------------------------------------ authoritative status
  /** Buyer return from PayPal. Never activates by itself: it only triggers an authoritative read. */
  async handleBuyerReturn(localId: string, paypalSubscriptionId: string | null): Promise<SubscriptionRecord> {
    const sub = this.byId(localId);
    if (!sub) throw new SubscriptionError("NOT_FOUND", "Unknown subscription");
    if (paypalSubscriptionId !== null && sub.paypalSubscriptionId !== paypalSubscriptionId) {
      this.audit(sub.id, sub.userId, "RETURN_MISMATCH_IGNORED", {});
      throw new SubscriptionError("RETURN_MISMATCH", "Return parameters do not match this subscription.");
    }
    this.audit(sub.id, sub.userId, "BUYER_RETURNED_NOT_TRUSTED", {});
    return this.refresh(localId, "BUYER_RETURN");
  }

  /** Server-to-PayPal read, then a guarded local transition and (if paid) an idempotent grant. */
  async refresh(localId: string, source: "STATUS_CHECK" | "BUYER_RETURN" | "WEBHOOK" | "CANCEL" | "AUTHORIZATION" = "STATUS_CHECK"): Promise<SubscriptionRecord> {
    const sub = this.byId(localId);
    if (!sub) throw new SubscriptionError("NOT_FOUND", "Unknown subscription");
    if (!sub.paypalSubscriptionId) return sub;
    let snap: SubscriptionSnapshot;
    try { snap = await this.provider.getSubscription(sub.paypalSubscriptionId); }
    catch (e) { this.setError(sub.id, e instanceof Error ? e.message.slice(0, 200) : "error"); throw e; }
    return this.applySnapshot(sub.id, snap, source);
  }

  /** Pure DB step (synchronous, one IMMEDIATE transaction). Exposed for tests. */
  applySnapshot(localId: string, snap: SubscriptionSnapshot, source: string): SubscriptionRecord {
    return this.store.transaction(() => {
      const sub = this.byId(localId)!;
      const t = this.now();
      this.store.db.prepare("UPDATE managed_subscriptions SET provider_status=?, last_verified_at=?, last_error=NULL, updated_at=? WHERE id=?").run(snap.status, t, t, sub.id);
      // Binding: the PayPal object must be the one we created, for this local record and plan.
      if (snap.subscriptionId !== sub.paypalSubscriptionId || snap.customId !== sub.id || snap.planId !== sub.paypalPlanId) {
        this.hold(sub, "BINDING_MISMATCH", { source });
        return OPEN_STATES.includes(sub.state) && sub.state !== "UNKNOWN" && sub.state !== "DRAFT"
          ? this.transition(this.byId(sub.id)!, "UNKNOWN", {}, "BINDING_MISMATCH") : this.byId(sub.id)!;
      }
      let target: SubscriptionState;
      switch (snap.status) {
        case "APPROVAL_PENDING": case "APPROVED": target = snap.status === "APPROVAL_PENDING" && t > sub.approvalExpiresAt ? "ABANDONED" : "APPROVAL_PENDING"; break;
        case "ACTIVE": target = sub.state === "CANCEL_REQUESTED" ? "CANCEL_REQUESTED" : "ACTIVE"; break;
        case "SUSPENDED": target = "SUSPENDED"; break;
        case "CANCELLED": target = "CANCELLED"; break;
        case "EXPIRED": target = "EXPIRED"; break;
        default: target = "UNKNOWN";
      }
      let cur = this.byId(sub.id)!;
      if (TERMINAL_STATES.includes(cur.state)) {
        // E.g. abandoned locally but the buyer approved later: never auto-activate or auto-cancel; hold for the owner.
        if (snap.status === "ACTIVE" || snap.status === "SUSPENDED") this.hold(cur, "PROVIDER_ACTIVE_AFTER_LOCAL_TERMINAL", { source, localState: cur.state });
      } else if (target !== cur.state) {
        cur = this.transition(cur, target, {}, `PROVIDER_STATUS_${snap.status}`, { source });
      }
      if (snap.status === "ACTIVE" || snap.status === "CANCELLED" || snap.status === "SUSPENDED" || snap.status === "EXPIRED") this.maybeGrant(this.byId(sub.id)!, snap, source);
      return this.byId(sub.id)!;
    });
  }

  /** Creates the paid-period grant for PayPal's latest completed cycle, at most once. */
  private maybeGrant(sub: SubscriptionRecord, snap: SubscriptionSnapshot, source: string) {
    const n = snap.regularCyclesCompleted, lp = snap.lastPayment;
    if (!n || n < 1 || !lp) return;
    if (sub.holdReason) return;
    const terms = sub.terms;
    if (lp.amount.currency !== terms.currency || lp.amount.amountMinor !== terms.monthlyPriceMinor) {
      this.hold(sub, "PAYMENT_AMOUNT_MISMATCH", { source, reported: lp.amount, expectedMinor: terms.monthlyPriceMinor });
      return;
    }
    const start = Date.parse(lp.time);
    if (start > this.now() + 5 * 60_000) { this.hold(sub, "PAYMENT_TIME_IN_FUTURE", { source }); return; }
    const cap = addOneMonthUtc(start);
    const next = snap.nextBillingTime ? Date.parse(snap.nextBillingTime) : null;
    const end = next !== null && next > start ? Math.min(next, cap) : cap;
    const ins = this.store.db.prepare(`INSERT OR IGNORE INTO entitlement_grants(id,subscription_id,user_id,period_key,period_start,period_end,allowance_minor,op_caps_json,billed_minor,currency,terms_digest,status,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,'ACTIVE',?)`).run(`grt_${randomUUID()}`, sub.id, sub.userId, `REGULAR-${n}`, start, end, terms.includedAllowanceMinor,
      JSON.stringify(terms.operationCaps), lp.amount.amountMinor, lp.amount.currency, sub.termsDigest, this.now());
    if (ins.changes === 1) this.audit(sub.id, sub.userId, "ENTITLEMENT_GRANTED", { periodKey: `REGULAR-${n}`, periodStart: new Date(start).toISOString(), periodEnd: new Date(end).toISOString(), source });
  }

  // ------------------------------------------------------------------ cancel (owner action)
  async cancel(userId: string, localId: string, reason = "Cancelled by subscriber"): Promise<SubscriptionRecord> {
    let sub = this.byId(localId);
    if (!sub || sub.userId !== userId) throw new SubscriptionError("NOT_FOUND", "Unknown subscription");
    if (TERMINAL_STATES.includes(sub.state)) return sub;
    if (sub.state === "DRAFT" || (sub.state === "APPROVAL_PENDING" && sub.providerStatus !== "APPROVED")) {
      // Nothing to cancel at PayPal yet (it only cancels ACTIVE/SUSPENDED). If the buyer approves the old link
      // later, the refresh puts a hold on it for the owner; DIAPORIA does not auto-cancel.
      return this.store.transaction(() => this.transition(this.byId(localId)!, "ABANDONED", {}, "SUBSCRIPTION_ABANDONED_BY_OWNER"));
    }
    if (sub.state !== "CANCEL_REQUESTED") sub = this.store.transaction(() => this.transition(this.byId(localId)!, "CANCEL_REQUESTED", {}, "CANCEL_REQUESTED_BY_OWNER", { reason }));
    const key = (this.store.db.prepare("SELECT cancel_key FROM managed_subscriptions WHERE id=?").get(localId) as { cancel_key: string }).cancel_key;
    try { await this.provider.cancelSubscription(sub.paypalSubscriptionId!, reason, key); }
    catch (e) {
      if (e instanceof ProviderTimeoutError) { this.setError(localId, e.message); return this.byId(localId)!; } // retryable, stays CANCEL_REQUESTED
      this.store.transaction(() => this.transition(this.byId(localId)!, "UNKNOWN", { lastError: e instanceof Error ? e.message.slice(0, 200) : "error" }, "CANCEL_REFUSED_BY_PROVIDER"));
    }
    try { return await this.refresh(localId, "CANCEL"); } catch { return this.byId(localId)!; }
  }

  /** Operator clears a hold after review (e.g. refund resolved). Re-verification still required before use. */
  clearHold(localId: string, note: string) {
    const sub = this.byId(localId);
    if (!sub) throw new SubscriptionError("NOT_FOUND", "Unknown subscription");
    this.store.db.prepare("UPDATE managed_subscriptions SET hold_reason=NULL, last_verified_at=NULL, updated_at=? WHERE id=?").run(this.now(), localId);
    this.audit(localId, sub.userId, "HOLD_CLEARED_BY_OPERATOR", { previous: sub.holdReason, note: note.slice(0, 200) });
  }

  // ------------------------------------------------------------------ webhooks
  /**
   * Verified (PayPal's mechanism), replay-safe billing webhook. The event only says WHICH subscription or
   * sale to re-read; state comes from the authoritative read. Duplicate event ids are no-ops.
   */
  async handlePayPalWebhook(headers: WebhookHeaders, rawBody: string): Promise<{ http: number; outcome: string }> {
    const verifier = this.opts.webhookVerifier;
    if (!verifier) return { http: 503, outcome: "BILLING_WEBHOOKS_NOT_CONFIGURED" };
    const sent = Date.parse(headers.transmissionTime ?? "");
    const t = this.now();
    if (!Number.isFinite(sent) || sent > t + 5 * 60_000 || t - sent > (this.opts.maxWebhookAgeMs ?? 3 * DAY)) return { http: 401, outcome: "REJECTED_TRANSMISSION_TIME" };
    const v = await verifier.verify(headers, rawBody);
    if (!v.ok) return { http: 401, outcome: `REJECTED_SIGNATURE: ${v.reason}` };
    let e: Record<string, unknown>;
    try { e = JSON.parse(rawBody) as Record<string, unknown>; } catch { return { http: 400, outcome: "REJECTED_MALFORMED_JSON" }; }
    const id = e.id, type = e.event_type, res = (e.resource && typeof e.resource === "object" ? e.resource : {}) as Record<string, unknown>;
    if (typeof id !== "string" || !/^WH-[A-Z0-9-]{8,60}$/.test(id) || typeof type !== "string") return { http: 200, outcome: "IGNORED: malformed event" };
    let resourceId: string | null = null, kind: "SUB" | "SALE_OK" | "SALE_NEG" | null = null;
    if (SUB_EVENTS.includes(type)) { kind = "SUB"; resourceId = typeof res.id === "string" ? res.id : null; }
    else if (type === SALE_COMPLETED) { kind = "SALE_OK"; resourceId = typeof res.billing_agreement_id === "string" ? res.billing_agreement_id : null; }
    else if (SALE_NEGATIVE.includes(type)) { kind = "SALE_NEG"; resourceId = typeof res.sale_id === "string" ? res.sale_id : typeof res.id === "string" ? res.id : null; }
    if (!kind) return { http: 200, outcome: `IGNORED: unhandled event type ${type.slice(0, 50)}` };
    if (!resourceId || !/^[A-Z0-9-]{8,50}$/.test(resourceId)) return { http: 200, outcome: "IGNORED: missing resource id" };

    // Claim the event id atomically. A failed processing attempt can be re-claimed by PayPal's retry.
    const claimed = this.store.transaction(() => {
      const row = this.store.db.prepare("SELECT outcome FROM subscription_webhook_events WHERE event_id=?").get(id) as { outcome: string } | undefined;
      if (!row) { this.store.db.prepare("INSERT INTO subscription_webhook_events(event_id,event_type,resource_id,received_at,outcome) VALUES (?,?,?,?,'PROCESSING')").run(id, type, resourceId, t); return "NEW"; }
      if (row.outcome === "FAILED_RETRYABLE") { this.store.db.prepare("UPDATE subscription_webhook_events SET outcome='PROCESSING' WHERE event_id=?").run(id); return "RETRY"; }
      return row.outcome === "PROCESSING" ? "IN_PROGRESS" : "DUPLICATE";
    });
    if (claimed === "DUPLICATE") return { http: 200, outcome: "DUPLICATE" };
    if (claimed === "IN_PROGRESS") return { http: 409, outcome: "IN_PROGRESS" }; // non-2xx: PayPal retries later
    const finish = (outcome: string, subId: string | null = null, http = 200) => {
      this.store.db.prepare("UPDATE subscription_webhook_events SET outcome=?, subscription_id=? WHERE event_id=?").run(outcome, subId, id);
      return { http, outcome };
    };
    try {
      if (kind === "SALE_NEG") {
        const sale = await this.provider.getSale(resourceId);
        const sub = sale.billingAgreementId ? this.byPayPalId(sale.billingAgreementId) : null;
        if (!sub) return finish("IGNORED_UNRELATED_SALE");
        if (!["refunded", "partially_refunded", "reversed"].includes(sale.state)) return finish(`NO_CHANGE_SALE_${sale.state.toUpperCase().slice(0, 20)}`, sub.id);
        this.store.transaction(() => {
          this.hold(this.byId(sub.id)!, "PAYMENT_REFUNDED_OR_REVERSED", { saleState: sale.state });
          this.store.db.prepare("UPDATE entitlement_grants SET status='REVOKED', revoked_reason=? WHERE subscription_id=? AND status='ACTIVE' AND period_end>?").run(`SALE_${sale.state.toUpperCase()}`, sub.id, this.now());
        });
        return finish("HOLD_PAYMENT_REVERSED", sub.id);
      }
      const sub = this.byPayPalId(resourceId);
      if (!sub) return finish("IGNORED_UNRELATED_SUBSCRIPTION");
      this.audit(sub.id, sub.userId, "WEBHOOK_RECEIVED_NOT_TRUSTED", { eventId: id, eventType: type });
      const after = await this.refresh(sub.id, "WEBHOOK");
      return finish(`RECONCILED_${after.state}`, sub.id);
    } catch {
      return finish("FAILED_RETRYABLE", null, 503);
    }
  }

  // ------------------------------------------------------------------ entitlement
  /** Synchronous entitlement decision (used inside the ledger transaction). */
  entitlementFor(userId: string, at = this.now()) {
    const latest = this.store.db.prepare("SELECT * FROM managed_subscriptions WHERE user_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(userId) as Row | undefined;
    if (!latest) return { entitled: false as const, reason: "NO_SUBSCRIPTION", subscription: null, grant: null };
    const g = this.store.db.prepare("SELECT * FROM entitlement_grants WHERE user_id=? AND status='ACTIVE' AND period_start<=? AND period_end>? ORDER BY period_start DESC LIMIT 1").get(userId, at, at) as Row | undefined;
    const latestRec = toSub(latest);
    if (!g) {
      const reason = latestRec.holdReason ? `HOLD_${latestRec.holdReason}` : ({ DRAFT: "APPROVAL_PENDING", APPROVAL_PENDING: "APPROVAL_PENDING", ACTIVE: "AWAITING_PAYMENT_CONFIRMATION",
        SUSPENDED: "SUSPENDED", UNKNOWN: "STATUS_UNKNOWN" } as Record<string, string>)[latestRec.state] ?? "NO_PAID_PERIOD";
      return { entitled: false as const, reason, subscription: latestRec, grant: null };
    }
    const grant = toGrant(g);
    const sub = this.byId(grant.subscriptionId)!;
    if (sub.holdReason) return { entitled: false as const, reason: `HOLD_${sub.holdReason}`, subscription: sub, grant };
    if (!["ACTIVE", "CANCEL_REQUESTED", "CANCELLED"].includes(sub.state)) return { entitled: false as const, reason: sub.state === "UNKNOWN" ? "STATUS_UNKNOWN" : sub.state, subscription: sub, grant };
    if (sub.lastVerifiedAt === null || at - sub.lastVerifiedAt > (this.opts.maxStatusAgeMs ?? DAY)) return { entitled: false as const, reason: "STATUS_STALE", subscription: sub, grant };
    return { entitled: true as const, reason: null, subscription: sub, grant };
  }

  /** Service-price usage in the grant window, from the ledger (billed + reserved pending delivery). */
  private consumption(userId: string, grant: Grant) {
    const rows = this.store.db.prepare(`SELECT provider, operation, billing_state, billable_minor FROM usage_records WHERE user_id=? AND created_at>=? AND created_at<? AND billing_state IN ('BILLED','PENDING_DELIVERY')`)
      .all(userId, grant.periodStart, grant.periodEnd) as Array<{ provider: string; operation: string; billing_state: string; billable_minor: number }>;
    const ops: Record<string, number> = {};
    let minor = 0;
    for (const r of rows) {
      const k = `${r.provider}:${r.operation}`;
      ops[k] = (ops[k] ?? 0) + 1;
      minor += r.billing_state === "BILLED" ? r.billable_minor : (this.ledger.pricing.serviceMinorPerOperation[k] ?? 0);
    }
    return { consumedMinor: minor, operations: ops };
  }

  /** EntitlementGuard: runs inside UsageLedger.begin's IMMEDIATE transaction for every billable reservation. */
  check(ctx: Parameters<EntitlementGuard["check"]>[0]): void {
    const deny = (reason: string, msg: string) => { throw new UsageLimitError("ENTITLEMENT_DENIED", msg, reason); };
    if (ctx.provider === "MODEL") deny("NOT_A_DIAPORIA_SERVICE", "AI model usage belongs to the user's own AI host subscription; DIAPORIA never bills it.");
    if (ctx.servicePriceMinor === undefined) deny("PRICE_UNKNOWN", `No DIAPORIA service price for ${ctx.provider}:${ctx.operation}; denied.`);
    const e = this.entitlementFor(ctx.userId, ctx.at);
    if (!e.entitled) deny(e.reason, `Managed service not entitled (${e.reason}); paid operation denied.`);
    const grant = e.grant!;
    const used = this.consumption(ctx.userId, grant);
    const key = `${ctx.provider}:${ctx.operation}`;
    if (used.consumedMinor + ctx.servicePriceMinor! > grant.allowanceMinor) deny("ALLOWANCE_EXHAUSTED", `Included allowance for this period is used up (${used.consumedMinor}/${grant.allowanceMinor} cents). Overage is not billed; operation denied.`);
    const cap = grant.operationCaps[key];
    if (cap !== undefined && (used.operations[key] ?? 0) + 1 > cap) deny("OPERATION_CAP", `${key} cap for this period (${cap}) reached; operation denied.`);
  }

  // ------------------------------------------------------------------ BillingProvider
  async getAuthorization(userId: string): Promise<BillingAuthorization> {
    let latest = this.store.db.prepare("SELECT id FROM managed_subscriptions WHERE user_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(userId) as { id: string } | undefined;
    const source = this.provider.name === "MOCK_PAYPAL_SUBSCRIPTIONS" ? "MOCK_PAYPAL_SUBSCRIPTIONS" as const : "PAYPAL_SANDBOX_SUBSCRIPTIONS" as const;
    if (!latest) return { userId, status: "NONE", planId: null, source, subscriptionRef: null, verifiedAt: new Date(this.now()).toISOString(), entitlement: { entitled: false, reason: "NO_SUBSCRIPTION" } };
    const sub = this.byId(latest.id)!;
    let refreshError: string | null = null;
    if (sub.paypalSubscriptionId && !["CANCELLED", "EXPIRED", "ABANDONED", "FAILED"].includes(sub.state) && (sub.lastVerifiedAt === null || this.now() - sub.lastVerifiedAt > (this.opts.refreshAfterMs ?? 15 * 60_000))) {
      try { await this.refresh(sub.id, "AUTHORIZATION"); } catch (e) { refreshError = e instanceof Error ? e.message.slice(0, 120) : "error"; }
    }
    const e = this.entitlementFor(userId);
    const cur = this.byId(sub.id)!;
    const map: Record<SubscriptionState, BillingAuthorizationStatus> = { DRAFT: "APPROVAL_PENDING", APPROVAL_PENDING: "APPROVAL_PENDING", ACTIVE: "ACTIVE", CANCEL_REQUESTED: "ACTIVE",
      SUSPENDED: "SUSPENDED", UNKNOWN: "UNKNOWN", CANCELLED: "CANCELLED", EXPIRED: "EXPIRED", ABANDONED: "NONE", FAILED: "NONE" };
    // ACTIVE is reported only when the user is entitled right now (paid period, verified, no hold).
    const status: BillingAuthorizationStatus = e.entitled ? "ACTIVE" : (map[cur.state] === "ACTIVE" ? "UNKNOWN" : map[cur.state]);
    const usage = e.grant ? this.consumption(userId, e.grant) : null;
    return { userId, status, planId: cur.planKey, source, subscriptionRef: cur.id, verifiedAt: new Date(cur.lastVerifiedAt ?? 0).toISOString(),
      entitlement: { entitled: e.entitled, reason: e.reason, subscriptionState: cur.state, holdReason: cur.holdReason, refreshError,
        period: e.grant ? { key: e.grant.periodKey, start: new Date(e.grant.periodStart).toISOString(), end: new Date(e.grant.periodEnd).toISOString() } : null,
        allowanceMinor: e.grant?.allowanceMinor ?? null, consumedMinor: usage?.consumedMinor ?? null,
        remainingMinor: e.grant && usage ? Math.max(0, e.grant.allowanceMinor - usage.consumedMinor) : null, operationCaps: e.grant?.operationCaps ?? null, operationsUsed: usage?.operations ?? null } };
  }

  /**
   * Period statement. The four money values are kept apart and never summed into each other:
   *  billed amount (what PayPal charged, from the authoritative read), DIAPORIA service price (plan price
   *  and per-operation list prices consumed against the allowance), estimated supplier cost and
   *  reconciled provider cost (from the ledger; unknown stays null).
   */
  statement(userId: string, at = this.now()) {
    const e = this.entitlementFor(userId, at);
    const sub = e.subscription;
    const base = { kind: "SUBSCRIPTION_PERIOD_STATEMENT" as const, environment: this.provider.name, subscription: sub ? { id: sub.id, state: sub.state, planKey: sub.planKey, planVersion: sub.planVersion,
      termsDigest: sub.termsDigest, holdReason: sub.holdReason } : null, entitled: e.entitled, reason: e.reason };
    if (!e.grant || !sub) return { ...base, period: null, amounts: null, disclosure: "No paid period covers this time." };
    const g = e.grant;
    const used = this.consumption(userId, g);
    const cost = this.store.db.prepare(`SELECT SUM(CASE WHEN est_supplier_micro IS NULL THEN 1 ELSE 0 END) unknown_n, SUM(COALESCE(est_supplier_micro,0)) est,
      SUM(CASE WHEN final_supplier_micro IS NULL THEN 0 ELSE 1 END) rec_n, SUM(COALESCE(final_supplier_micro,0)) fin, COUNT(*) n
      FROM usage_records WHERE user_id=? AND created_at>=? AND created_at<?`).get(userId, g.periodStart, g.periodEnd) as Record<string, number | null>;
    const n = Number(cost.n ?? 0), unknownN = Number(cost.unknown_n ?? 0), recN = Number(cost.rec_n ?? 0);
    return { ...base,
      period: { key: g.periodKey, start: new Date(g.periodStart).toISOString(), end: new Date(g.periodEnd).toISOString() },
      amounts: {
        billedAmount: { minor: g.billedMinor, currency: g.currency, source: "PayPal subscription last_payment, read server-to-server" },
        servicePrice: { planMonthlyPriceMinor: sub.terms.monthlyPriceMinor, includedAllowanceMinor: g.allowanceMinor, consumedAtListPriceMinor: used.consumedMinor,
          remainingAllowanceMinor: Math.max(0, g.allowanceMinor - used.consumedMinor), operations: used.operations, operationCaps: g.operationCaps, priceLabel: sub.terms.priceLabel },
        estimatedSupplierCost: { knownMicroUsd: Number(cost.est ?? 0), unknownCostRecords: unknownN, complete: unknownN === 0, records: n },
        providerCost: { reconciledMicroUsd: recN > 0 ? Number(cost.fin ?? 0) : null, reconciledRecords: recN, unreconciledRecords: n - recN },
      },
      hardSpendLimitMinor: sub.terms.hardSpendLimitMinor, overage: "DENY" as const,
      disclosure: "Billed amount is what PayPal reported charging for this period. Service-price consumption is measured against the included allowance and is never billed separately. Supplier costs are estimates (null = unknown) until reconciled with provider statements.",
    };
  }

  // ------------------------------------------------------------------ helpers
  byId(id: string): SubscriptionRecord | null {
    const r = this.store.db.prepare("SELECT * FROM managed_subscriptions WHERE id=?").get(id) as Row | undefined;
    return r ? toSub(r) : null;
  }
  forUser(userId: string): SubscriptionRecord[] {
    return (this.store.db.prepare("SELECT * FROM managed_subscriptions WHERE user_id=? ORDER BY created_at DESC").all(userId) as Row[]).map(toSub);
  }
  grants(subscriptionId: string): Grant[] {
    return (this.store.db.prepare("SELECT * FROM entitlement_grants WHERE subscription_id=? ORDER BY period_start").all(subscriptionId) as Row[]).map(toGrant);
  }
  auditTrail(subscriptionId: string) {
    return (this.store.db.prepare("SELECT type, data_json, at FROM subscription_audit WHERE subscription_id=? ORDER BY seq").all(subscriptionId) as Array<{ type: string; data_json: string; at: number }>)
      .map((r) => ({ type: r.type, data: JSON.parse(r.data_json) as unknown, at: r.at }));
  }
  private byPayPalId(paypalId: string): SubscriptionRecord | null {
    const r = this.store.db.prepare("SELECT * FROM managed_subscriptions WHERE paypal_subscription_id=?").get(paypalId) as Row | undefined;
    return r ? toSub(r) : null;
  }
  private openFor(userId: string): SubscriptionRecord | null {
    const r = this.store.db.prepare(`SELECT * FROM managed_subscriptions WHERE user_id=? AND state IN (${OPEN_STATES.map(() => "?").join(",")})`).get(userId, ...OPEN_STATES) as Row | undefined;
    return r ? toSub(r) : null;
  }
  /** Guarded, versioned transition. Throws on a transition the table does not allow. */
  private transition(sub: SubscriptionRecord, to: SubscriptionState, fields: { paypalSubscriptionId?: string; approvalUrl?: string; providerStatus?: string; lastError?: string }, auditType: string, data: Record<string, unknown> = {}): SubscriptionRecord {
    if (!SUBSCRIPTION_TRANSITIONS[sub.state].includes(to)) throw new SubscriptionError("INVALID_TRANSITION", `Transition ${sub.state} -> ${to} is not allowed`);
    const r = this.store.db.prepare(`UPDATE managed_subscriptions SET state=?, version=version+1, paypal_subscription_id=COALESCE(?,paypal_subscription_id), approval_url=COALESCE(?,approval_url),
      provider_status=COALESCE(?,provider_status), last_error=COALESCE(?,last_error), updated_at=? WHERE id=? AND version=?`)
      .run(to, fields.paypalSubscriptionId ?? null, fields.approvalUrl ?? null, fields.providerStatus ?? null, fields.lastError ?? null, this.now(), sub.id, sub.version);
    if (r.changes !== 1) throw new SubscriptionError("INVALID_TRANSITION", "Concurrent modification; re-read and retry");
    this.audit(sub.id, sub.userId, auditType, { from: sub.state, to, ...data });
    return this.byId(sub.id)!;
  }
  private hold(sub: SubscriptionRecord, reason: string, data: Record<string, unknown>) {
    this.store.db.prepare("UPDATE managed_subscriptions SET hold_reason=COALESCE(hold_reason, ?), updated_at=? WHERE id=?").run(reason, this.now(), sub.id);
    this.audit(sub.id, sub.userId, "ENTITLEMENT_HOLD", { reason, ...data });
  }
  private setError(id: string, msg: string) { this.store.db.prepare("UPDATE managed_subscriptions SET last_error=?, updated_at=? WHERE id=?").run(msg.slice(0, 200), this.now(), id); }
  private audit(subscriptionId: string, userId: string, type: string, data: Record<string, unknown>) {
    this.store.db.prepare("INSERT INTO subscription_audit(subscription_id,user_id,type,data_json,at) VALUES (?,?,?,?,?)").run(subscriptionId, userId, type, JSON.stringify(data), this.now());
  }
}

type Row = Record<string, string | number | null>;
function toSub(r: Row): SubscriptionRecord {
  return { id: String(r.id), userId: String(r.user_id), planKey: String(r.plan_key), planVersion: String(r.plan_version), paypalPlanId: String(r.paypal_plan_id),
    terms: JSON.parse(String(r.terms_json)) as ManagedPlanTerms, termsDigest: String(r.terms_digest), state: r.state as SubscriptionState, version: Number(r.version),
    provider: String(r.provider), paypalSubscriptionId: r.paypal_subscription_id === null ? null : String(r.paypal_subscription_id), approvalUrl: r.approval_url === null ? null : String(r.approval_url),
    providerStatus: r.provider_status === null ? null : String(r.provider_status), holdReason: r.hold_reason === null ? null : String(r.hold_reason),
    lastError: r.last_error === null ? null : String(r.last_error), lastVerifiedAt: r.last_verified_at === null ? null : Number(r.last_verified_at),
    approvalExpiresAt: Number(r.approval_expires_at), createdAt: Number(r.created_at), updatedAt: Number(r.updated_at) };
}
function toGrant(r: Row): Grant {
  return { id: String(r.id), subscriptionId: String(r.subscription_id), userId: String(r.user_id), periodKey: String(r.period_key), periodStart: Number(r.period_start),
    periodEnd: Number(r.period_end), allowanceMinor: Number(r.allowance_minor), operationCaps: JSON.parse(String(r.op_caps_json)) as Record<string, number>,
    billedMinor: Number(r.billed_minor), currency: String(r.currency), termsDigest: String(r.terms_digest), status: r.status as Grant["status"], revokedReason: r.revoked_reason === null ? null : String(r.revoked_reason) };
}
/** Same day-of-month next month (clamped to month end), UTC. Upper bound of one monthly period. */
export function addOneMonthUtc(t: number): number {
  const d = new Date(t);
  const y = d.getUTCFullYear(), m = d.getUTCMonth();
  const lastDay = new Date(Date.UTC(y, m + 2, 0)).getUTCDate();
  return Date.UTC(y, m + 1, Math.min(d.getUTCDate(), lastDay), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
}
// Re-exported so callers can distinguish provider failures without importing the payment module.
export { ProviderError, ProviderTimeoutError };
