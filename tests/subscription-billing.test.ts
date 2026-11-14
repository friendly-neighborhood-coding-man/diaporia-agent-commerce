/**
 * Managed Billing Integration V1: PayPal Subscriptions adapter (fake HTTP only), lifecycle state machine,
 * entitlement enforcement in the UsageLedger, idempotency and webhook replay protection. ALL MOCK:
 * every PayPal response comes from FakePayPalSubscriptions through the adapter's injected fetch.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store/Database.js";
import { UsageLedger, UsageLimitError, PLACEHOLDER_PRICING } from "../src/metering/UsageLedger.js";
import { EvidenceRouter } from "../src/evidence/EvidenceRouter.js";
import { MockKernelInspector, MockTavilySearch } from "../src/evidence/providers.js";
import type { ServicePlane } from "../src/engine/ServicePlane.js";
import { ALLOWED_ENDPOINTS, PayPalPostbackWebhookVerifier, PayPalSubscriptionsSandboxAdapter } from "../src/billing/subscriptions/PayPalSubscriptionsAdapter.js";
import { ManagedSubscriptionBilling, SUBSCRIPTION_TRANSITIONS, TERMINAL_STATES, addOneMonthUtc } from "../src/billing/subscriptions/ManagedSubscriptionBilling.js";
import { FakePayPalSubscriptions } from "../src/billing/subscriptions/FakePayPalSubscriptions.js";
import { MANAGED_PLANS_PRICES_UNKNOWN, termsDigest, validateTerms, type ManagedPlanTerms } from "../src/billing/subscriptions/plans.js";
import { createManagedBilling } from "../src/billing/subscriptions/factory.js";
import { call, callError, CA, mcpClient, OWNER, SONY_BLACK, startHarness, TOKENS, type Harness } from "./helpers.js";

const T0 = Date.parse("2026-11-10T00:00:00Z");
const PLAN: ManagedPlanTerms = { planKey: "test-plan", version: "t1-placeholder", name: "Test plan (placeholder)", currency: "USD", monthlyPriceMinor: 900,
  includedAllowanceMinor: 10, operationCaps: { "CHANNEL3:search": 3 }, hardSpendLimitMinor: 900, overage: "DENY", priceLabel: "PLACEHOLDER (test)" };
const DIGEST = termsDigest(PLAN);

const dirs: string[] = []; const hs: Harness[] = [];
const fakes: FakePayPalSubscriptions[] = [];
afterEach(async () => {
  // Global invariant: no test ever made the adapter call a capture/activate/vault/order endpoint.
  for (const f of fakes.splice(0)) expect(f.forbiddenCalls()).toEqual([]);
  for (const h of hs.splice(0)) await h.close().catch(() => {});
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(o: { path?: string; plans?: ManagedPlanTerms[]; clock?: { t: number }; fake?: FakePayPalSubscriptions; verifier?: boolean } = {}) {
  const clock = o.clock ?? { t: T0 };
  const now = () => clock.t;
  const store = new Store(o.path ?? ":memory:");
  const ledger = new UsageLedger(store, PLACEHOLDER_PRICING, { perRequestSupplierMicro: 10_000_000, monthlyBillableMinor: 100_000 }, now);
  const fake = o.fake ?? new FakePayPalSubscriptions("MOCKWEBHOOK0001", now);
  fakes.push(fake);
  const adapter = new PayPalSubscriptionsSandboxAdapter({ clientId: "MOCK-CLIENT", clientSecret: "MOCK-SECRET", env: "SANDBOX", fetchImpl: fake.fetch, label: "MOCK" });
  const billing = new ManagedSubscriptionBilling(store, ledger, adapter, { plans: o.plans ?? [PLAN], baseUrl: "http://127.0.0.1:8790",
    webhookVerifier: o.verifier === false ? null : new PayPalPostbackWebhookVerifier(adapter, fake.webhookId), now });
  return { clock, store, ledger, fake, adapter, billing };
}
type S = ReturnType<typeof setup>;
async function subscribed(s: S, user = "alice") {
  await s.billing.ensurePlan(PLAN.planKey);
  return (await s.billing.subscribe(user, PLAN.planKey, DIGEST)).subscription;
}
async function active(s: S, user = "alice") {
  const sub = await subscribed(s, user);
  s.fake.buyerApproves(sub.paypalSubscriptionId!);
  await s.billing.handleBuyerReturn(sub.id, sub.paypalSubscriptionId);
  return s.billing.byId(sub.id)!;
}
let seq = 0;
function op(s: S, user = "alice", provider: "TAVILY" | "CHANNEL3" | "KERNEL" | "MODEL" = "TAVILY") {
  const i = ++seq;
  const [operation, unit] = provider === "KERNEL" ? ["inspect", "browser_second"] : provider === "MODEL" ? ["call", "token_1k"] : ["search", "search"];
  return s.ledger.begin({ userId: user, requestId: `req-${i}`, provider, operation, logicalKey: `k-${i}`, quantity: 1, unit, provenance: "MOCK", billable: true });
}
function denied(fn: () => unknown): string {
  try { fn(); } catch (e) { if (e instanceof UsageLimitError && e.code === "ENTITLEMENT_DENIED") return e.reason!; throw e; }
  throw new Error("expected ENTITLEMENT_DENIED");
}

describe("PayPal Subscriptions adapter (Sandbox only, fake HTTP)", () => {
  it("refuses LIVE, refuses endpoints outside the allowlist (no capture/activate/vault/orders), refuses unpriced plans", async () => {
    expect(() => new PayPalSubscriptionsSandboxAdapter({ clientId: "x", clientSecret: "y", env: "LIVE" })).toThrow(/SANDBOX/);
    const s = setup();
    for (const path of ["/v1/billing/subscriptions/I-MOCKAAAAAAAA/capture", "/v1/billing/subscriptions/I-MOCKAAAAAAAA/activate", "/v3/vault/payment-tokens", "/v2/checkout/orders", "/v1/billing-agreements/agreement-tokens"])
      await expect((s.adapter as any).send("POST", path, { headers: {} }, "t")).rejects.toThrow(/Endpoint not allowed/);
    expect(ALLOWED_ENDPOINTS.some(([, re]) => re.test("/v1/billing/subscriptions/I-MOCKAAAAAAAA/capture"))).toBe(false);
    const prod = await s.adapter.createProduct({ name: "x", description: "y", requestId: "r1" });
    await expect(s.adapter.createPlan({ productId: prod.productId, terms: MANAGED_PLANS_PRICES_UNKNOWN[0]!, requestId: "r2" })).rejects.toThrow(/no known price/);
    expect(validateTerms(MANAGED_PLANS_PRICES_UNKNOWN[0]!)).toEqual({ offerable: false, reason: "PRICE_UNKNOWN" });
    expect(() => validateTerms({ ...PLAN, hardSpendLimitMinor: 2000 })).toThrow(/no overage billing/);
  });

  it("sends PayPal-Request-Id on every POST and maps the plan to a fixed monthly price; retries reuse the same PayPal object", async () => {
    const s = setup();
    const seen: Array<{ path: string; reqId: string | null; body: any }> = [];
    const spy: typeof fetch = async (u, init) => { const url = new URL(String(u)); if (url.pathname !== "/v1/oauth2/token") seen.push({ path: url.pathname, reqId: new Headers(init?.headers).get("paypal-request-id"), body: init?.body ? JSON.parse(String(init.body)) : null }); return s.fake.fetch(u, init); };
    const a = new PayPalSubscriptionsSandboxAdapter({ clientId: "MOCK-CLIENT", clientSecret: "MOCK-SECRET", env: "SANDBOX", fetchImpl: spy, label: "MOCK" });
    const { productId } = await a.createProduct({ name: "DIAPORIA", description: "d", requestId: "prod-1" });
    const p1 = await a.createPlan({ productId, terms: PLAN, requestId: "plan-1" });
    const p2 = await a.createPlan({ productId, terms: PLAN, requestId: "plan-1" });
    expect(p2.planId).toBe(p1.planId);
    expect(seen.filter((x) => x.path !== "/v1/oauth2/token").every((x) => x.reqId)).toBe(true);
    const plan = seen.find((x) => x.path === "/v1/billing/plans")!.body;
    expect(plan.billing_cycles).toEqual([expect.objectContaining({ tenure_type: "REGULAR", total_cycles: 0, frequency: { interval_unit: "MONTH", interval_count: 1 }, pricing_scheme: { fixed_price: { value: "9.00", currency_code: "USD" } } })]);
    expect(plan.payment_preferences.auto_bill_outstanding).toBe(false);
    const sub = await a.createSubscription({ planId: p1.planId, customId: "sub_x", returnUrl: "http://127.0.0.1/r", cancelUrl: "http://127.0.0.1/c", requestId: "s-1" });
    expect(sub).toMatchObject({ status: "APPROVAL_PENDING", approvalUrl: expect.stringMatching(/^https:\/\/www\.sandbox\.paypal\.com\//) });
    expect(sub.subscriptionId).toMatch(/^I-MOCK/);
  });

  it("webhook verification uses PayPal's postback API with the RAW event; HMAC-signed or tampered bodies fail", async () => {
    const s = setup();
    const ev = s.fake.makeWebhook("BILLING.SUBSCRIPTION.ACTIVATED", { id: "I-MOCKAAAAAAAA" });
    expect(await s.adapter.verifyWebhookSignature(s.fake.webhookId, ev.headers, ev.rawBody)).toEqual({ ok: true });
    expect((await s.adapter.verifyWebhookSignature(s.fake.webhookId, ev.headers, ev.rawBody.replace("ACTIVATED", "CANCELLED"))).ok).toBe(false);
    expect((await s.adapter.verifyWebhookSignature("OTHERWEBHOOK01", ev.headers, ev.rawBody)).ok).toBe(false);
    const hmac = createHmac("sha256", "mock-billing-webhook-secret-0001").update(ev.rawBody).digest("base64");
    expect((await s.adapter.verifyWebhookSignature(s.fake.webhookId, { ...ev.headers, transmissionSig: hmac }, ev.rawBody)).ok).toBe(false);
    expect((await s.adapter.verifyWebhookSignature(s.fake.webhookId, { ...ev.headers, certUrl: undefined }, ev.rawBody)).ok).toBe(false);
    // The raw received bytes are what PayPal is asked to verify (not a re-serialized object).
    let sent = "";
    const spy: typeof fetch = async (u, init) => { if (String(u).endsWith("/verify-webhook-signature")) sent = String(init?.body); return s.fake.fetch(u, init); };
    const a = new PayPalSubscriptionsSandboxAdapter({ clientId: "MOCK-CLIENT", clientSecret: "MOCK-SECRET", env: "SANDBOX", fetchImpl: spy, label: "MOCK" });
    await a.verifyWebhookSignature(s.fake.webhookId, ev.headers, ev.rawBody);
    expect(sent.endsWith(`"webhook_event":${ev.rawBody}}`)).toBe(true);
  });
});

describe("subscription lifecycle (state machine)", () => {
  it("transition table: terminal states have no exits; ACTIVE only reachable from PayPal-read states", () => {
    for (const t of TERMINAL_STATES) expect(SUBSCRIPTION_TRANSITIONS[t]).toEqual([]);
    expect(SUBSCRIPTION_TRANSITIONS.DRAFT).not.toContain("ACTIVE");
  });

  it("subscribing requires the exact terms digest; unknown prices and unknown plans fail closed", async () => {
    const s = setup({ plans: [PLAN, { ...MANAGED_PLANS_PRICES_UNKNOWN[0]! }] });
    await expect(s.billing.ensurePlan("managed-starter")).rejects.toMatchObject({ code: "PRICE_UNKNOWN" });
    await expect(s.billing.subscribe("alice", "managed-starter", "x")).rejects.toMatchObject({ code: "PRICE_UNKNOWN" });
    await expect(s.billing.subscribe("alice", PLAN.planKey, DIGEST)).rejects.toMatchObject({ code: "PLAN_NOT_AVAILABLE" }); // not created at provider yet
    await s.billing.ensurePlan(PLAN.planKey);
    expect((await s.billing.ensurePlan(PLAN.planKey)).created).toBe(false);
    await expect(s.billing.subscribe("alice", PLAN.planKey, "0".repeat(64))).rejects.toMatchObject({ code: "TERMS_NOT_ACCEPTED" });
    await expect(s.billing.subscribe("alice", "nope", DIGEST)).rejects.toMatchObject({ code: "PLAN_NOT_AVAILABLE" });
    expect(s.billing.listPlans().map((p) => [p.terms.planKey, p.offerable])).toEqual([["test-plan", true], ["managed-starter", false]]);
  });

  it("a browser redirect never activates: return before approval stays APPROVAL_PENDING; APPROVED-not-active is not entitled; forged return ids are refused", async () => {
    const s = setup();
    const sub = await subscribed(s);
    expect(sub.state).toBe("APPROVAL_PENDING");
    expect((await s.billing.handleBuyerReturn(sub.id, sub.paypalSubscriptionId)).state).toBe("APPROVAL_PENDING");
    expect((await s.billing.getAuthorization("alice")).status).toBe("APPROVAL_PENDING");
    await expect(s.billing.handleBuyerReturn(sub.id, "I-MOCKFORGED0001")).rejects.toMatchObject({ code: "RETURN_MISMATCH" });
    s.fake.buyerApprovesPendingActivation(sub.paypalSubscriptionId!);
    expect((await s.billing.refresh(sub.id)).state).toBe("APPROVAL_PENDING");
    expect(denied(() => op(s))).toBe("APPROVAL_PENDING");
    // PayPal activates and collects the first cycle: only now does the authoritative read make it ACTIVE + entitled.
    s.fake.setStatus(sub.paypalSubscriptionId!, "APPROVAL_PENDING"); s.fake.buyerApproves(sub.paypalSubscriptionId!);
    expect((await s.billing.handleBuyerReturn(sub.id, sub.paypalSubscriptionId)).state).toBe("ACTIVE");
    expect((await s.billing.getAuthorization("alice"))).toMatchObject({ status: "ACTIVE", entitlement: { entitled: true, allowanceMinor: 10, consumedMinor: 0 } });
    expect(s.billing.auditTrail(sub.id).map((a) => a.type)).toEqual(expect.arrayContaining(["BUYER_RETURNED_NOT_TRUSTED", "PROVIDER_STATUS_ACTIVE", "ENTITLEMENT_GRANTED"]));
  });

  it("ACTIVE without a confirmed payment is not entitled; payment amount mismatch and binding mismatch put a hold", async () => {
    const s = setup();
    const sub = await subscribed(s);
    s.fake.buyerApproves(sub.paypalSubscriptionId!, { pay: false });
    await s.billing.refresh(sub.id);
    expect(denied(() => op(s))).toBe("AWAITING_PAYMENT_CONFIRMATION");
    expect((await s.billing.getAuthorization("alice")).status).toBe("UNKNOWN");
    s.fake.collectCycle(sub.paypalSubscriptionId!, "1.00"); // PayPal reports a different amount than the authorized plan price
    await s.billing.refresh(sub.id);
    expect(s.billing.byId(sub.id)!.holdReason).toBe("PAYMENT_AMOUNT_MISMATCH");
    expect(s.billing.grants(sub.id)).toEqual([]);
    expect(denied(() => op(s))).toBe("HOLD_PAYMENT_AMOUNT_MISMATCH");

    const s2 = setup();
    const sub2 = await active(s2);
    s2.fake.tamperSubscriptionRead = (b) => ({ ...b, custom_id: "sub_someone_else" });
    s2.clock.t += 60_000;
    expect((await s2.billing.refresh(sub2.id)).state).toBe("UNKNOWN");
    expect(denied(() => op(s2))).toBe("HOLD_BINDING_MISMATCH");
  });

  it("one open subscription per user; concurrent subscribe calls return the same PayPal subscription", async () => {
    const s = setup();
    await s.billing.ensurePlan(PLAN.planKey);
    const outs = await Promise.all(Array.from({ length: 5 }, () => s.billing.subscribe("alice", PLAN.planKey, DIGEST)));
    expect(new Set(outs.map((o) => o.subscription.id)).size).toBe(1);
    expect(s.fake.subs.size).toBe(1);
    expect(s.billing.forUser("alice")).toHaveLength(1);
    // A provider timeout leaves DRAFT; the retry uses the same PayPal-Request-Id (no second PayPal subscription).
    s.fake.failNext = { n: 1, kind: "timeout" };
    await expect(s.billing.subscribe("bob", PLAN.planKey, DIGEST)).rejects.toMatchObject({ code: "PROVIDER_UNCERTAIN" });
    expect(s.billing.forUser("bob")[0]!.state).toBe("DRAFT");
    const retry = await s.billing.subscribe("bob", PLAN.planKey, DIGEST);
    expect(retry.subscription.state).toBe("APPROVAL_PENDING");
    expect(s.fake.subs.size).toBe(2);
    const a = await active(setup(), "carol");
    expect(a.state).toBe("ACTIVE");
  });

  it("cancel: ACTIVE → CANCELLED at PayPal, paid period honoured until its end; timeouts stay CANCEL_REQUESTED and retry; unapproved → ABANDONED", async () => {
    const s = setup();
    const sub = await active(s);
    s.fake.failNext = { n: 1, kind: "timeout" };
    expect((await s.billing.cancel("alice", sub.id)).state).toBe("CANCEL_REQUESTED");
    op(s); // paid period still usable while the cancel is in flight
    expect((await s.billing.cancel("alice", sub.id)).state).toBe("CANCELLED");
    expect(s.fake.subs.get(sub.paypalSubscriptionId!)!.status).toBe("CANCELLED");
    op(s);
    s.clock.t = s.billing.grants(sub.id)[0]!.periodEnd + 1;
    expect(denied(() => op(s))).toBe("NO_PAID_PERIOD");
    await expect(s.billing.cancel("bob", sub.id)).rejects.toMatchObject({ code: "NOT_FOUND" });

    const s2 = setup();
    const pending = await subscribed(s2);
    expect((await s2.billing.cancel("alice", pending.id)).state).toBe("ABANDONED");
    expect(s2.fake.calls.some((c) => c.endsWith("/cancel"))).toBe(false);
    // The buyer later approves the old link anyway: DIAPORIA neither activates nor auto-cancels; it holds for the owner.
    s2.fake.buyerApproves(pending.paypalSubscriptionId!);
    const after = await s2.billing.refresh(pending.id);
    expect(after).toMatchObject({ state: "ABANDONED", holdReason: "PROVIDER_ACTIVE_AFTER_LOCAL_TERMINAL" });
    expect(denied(() => op(s2))).toMatch(/^HOLD_|NO_PAID_PERIOD/);
  });
});

describe("entitlement enforcement in the UsageLedger", () => {
  it("allowance and per-operation caps are hard limits; overage is denied, never billed; unknown prices and MODEL usage are denied", async () => {
    const s = setup();
    expect(denied(() => op(s))).toBe("NO_SUBSCRIPTION");
    await active(s);
    for (let i = 0; i < 3; i++) op(s, "alice", "CHANNEL3"); // 3 × 1 cent, cap 3
    expect(denied(() => op(s, "alice", "CHANNEL3"))).toBe("OPERATION_CAP");
    op(s); op(s); op(s);                                   // 3 × 2 cents → 9 of 10
    expect(denied(() => op(s))).toBe("ALLOWANCE_EXHAUSTED");
    expect(denied(() => op(s, "alice", "KERNEL"))).toBe("ALLOWANCE_EXHAUSTED"); // 5 cents > 1 left
    expect(denied(() => op(s, "alice", "MODEL"))).toBe("NOT_A_DIAPORIA_SERVICE");
    expect(denied(() => s.ledger.begin({ userId: "alice", requestId: "r-x", provider: "TAVILY", operation: "extract", logicalKey: "k-extract", quantity: 1, unit: "extract", provenance: "MOCK", billable: true }))).toBe("PRICE_UNKNOWN");
    // Non-billable (community-style) reservations never consult the guard.
    s.ledger.begin({ userId: "zed", requestId: "r-c", provider: "TAVILY", operation: "search", logicalKey: "k-c", quantity: 1, unit: "search", provenance: "MOCK", billable: false });
    const st = s.billing.statement("alice");
    expect(st.amounts!.servicePrice).toMatchObject({ planMonthlyPriceMinor: 900, includedAllowanceMinor: 10, consumedAtListPriceMinor: 9, remainingAllowanceMinor: 1 });
    expect(st.amounts!.billedAmount).toMatchObject({ minor: 900, currency: "USD" });
    expect(st.amounts!.estimatedSupplierCost.knownMicroUsd).toBe(6_000 + 3 * 8_000);
    expect(st.amounts!.providerCost).toMatchObject({ reconciledMicroUsd: null, reconciledRecords: 0 });
  });

  it("failed provider calls release allowance (never billed); a retry of the same logical operation is not charged twice", async () => {
    const s = setup();
    await active(s);
    const r = op(s);
    s.ledger.complete(r.record.id, { success: false, failureReason: "timeout" });
    s.ledger.abandonRequest(r.record.requestId, "alice");
    expect(s.billing.statement("alice").amounts!.servicePrice.consumedAtListPriceMinor).toBe(0);
    const again = s.ledger.begin({ userId: "alice", requestId: "req-again", provider: "TAVILY", operation: "search", logicalKey: r.record.logicalKey, quantity: 1, unit: "search", provenance: "MOCK", billable: true });
    s.ledger.complete(again.record.id, { success: true }); s.ledger.settleRequest("req-again", "alice");
    const reuse = s.ledger.begin({ userId: "alice", requestId: "req-3", provider: "TAVILY", operation: "search", logicalKey: r.record.logicalKey, quantity: 1, unit: "search", provenance: "MOCK", billable: true });
    expect(reuse.reuse).toBe(true);
    expect(s.billing.statement("alice").amounts!.servicePrice.consumedAtListPriceMinor).toBe(2);
  });

  it("two connections on one database cannot overspend the allowance together (IMMEDIATE transaction)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dac-sub-")); dirs.push(dir);
    const path = join(dir, "svc.sqlite");
    const clock = { t: T0 };
    const fake = new FakePayPalSubscriptions("MOCKWEBHOOK0001", () => clock.t);
    const a = setup({ path, clock, fake });
    await active(a);
    const b = setup({ path, clock, fake });
    let ok = 0, refused = 0;
    for (let i = 0; i < 10; i++) {
      try { op(i % 2 ? a : b); ok++; } catch (e) { if (e instanceof UsageLimitError) refused++; else throw e; }
    }
    expect(ok).toBe(5); expect(refused).toBe(5); // 5 × 2 cents = allowance 10
    a.store.close(); b.store.close();
  });

  it("status is re-verified: stale verification fails closed; PayPal outage beyond the max age → UNKNOWN; suspension denies; renewal opens a fresh allowance", async () => {
    const s = setup();
    const sub = await active(s);
    op(s); op(s); op(s); op(s); op(s);
    expect(denied(() => op(s))).toBe("ALLOWANCE_EXHAUSTED");
    // 2 days later with no successful PayPal read: stale → denied by the ledger guard itself.
    s.clock.t += 2 * 86_400_000;
    expect(denied(() => op(s))).toBe("STATUS_STALE");
    s.fake.failNext = { n: 1, kind: 500 };
    expect((await s.billing.getAuthorization("alice")).status).toBe("UNKNOWN");
    // PayPal suspends after a failed payment.
    s.fake.setStatus(sub.paypalSubscriptionId!, "SUSPENDED");
    expect((await s.billing.getAuthorization("alice")).status).toBe("SUSPENDED");
    expect(denied(() => op(s))).toBe("SUSPENDED");
    // Reactivated and the next cycle collected one month later: new grant, fresh allowance, still exactly one grant per cycle.
    s.clock.t = addOneMonthUtc(T0) + 1000;
    s.fake.setStatus(sub.paypalSubscriptionId!, "ACTIVE"); s.fake.collectCycle(sub.paypalSubscriptionId!);
    await s.billing.refresh(sub.id); await s.billing.refresh(sub.id);
    expect(s.billing.grants(sub.id).map((g) => g.periodKey)).toEqual(["REGULAR-1", "REGULAR-2"]);
    op(s);
    expect(s.billing.statement("alice").period!.key).toBe("REGULAR-2");
  });
});

describe("verified billing webhooks: replay and concurrency", () => {
  it("valid event triggers an authoritative read; replays are DUPLICATE; forged, tampered, HMAC-mock and stale deliveries are rejected", async () => {
    const s = setup();
    const sub = await subscribed(s);
    s.fake.buyerApproves(sub.paypalSubscriptionId!);
    const ev = s.fake.makeWebhook("BILLING.SUBSCRIPTION.ACTIVATED", { id: sub.paypalSubscriptionId, status: "ACTIVE" });
    expect(await s.billing.handlePayPalWebhook(ev.headers, ev.rawBody)).toEqual({ http: 200, outcome: "RECONCILED_ACTIVE" });
    for (let i = 0; i < 3; i++) expect(await s.billing.handlePayPalWebhook(ev.headers, ev.rawBody)).toEqual({ http: 200, outcome: "DUPLICATE" });
    expect(s.billing.grants(sub.id)).toHaveLength(1);
    expect((await s.billing.handlePayPalWebhook(ev.headers, ev.rawBody.replace("ACTIVE\"", "CANCELLED\""))).http).toBe(401);
    expect((await s.billing.handlePayPalWebhook({ ...ev.headers, transmissionSig: "AAAA" }, ev.rawBody)).http).toBe(401);
    const old = s.fake.makeWebhook("BILLING.SUBSCRIPTION.ACTIVATED", { id: sub.paypalSubscriptionId }, { sentAt: T0 - 4 * 86_400_000 });
    expect(await s.billing.handlePayPalWebhook(old.headers, old.rawBody)).toEqual({ http: 401, outcome: "REJECTED_TRANSMISSION_TIME" });
    // The event's own claims are never trusted: a genuine CANCELLED event while PayPal still says ACTIVE changes nothing.
    const lie = s.fake.makeWebhook("BILLING.SUBSCRIPTION.CANCELLED", { id: sub.paypalSubscriptionId, status: "CANCELLED" });
    expect(await s.billing.handlePayPalWebhook(lie.headers, lie.rawBody)).toEqual({ http: 200, outcome: "RECONCILED_ACTIVE" });
    const unrelated = s.fake.makeWebhook("BILLING.SUBSCRIPTION.ACTIVATED", { id: "I-MOCKUNRELATED01" });
    expect((await s.billing.handlePayPalWebhook(unrelated.headers, unrelated.rawBody)).outcome).toBe("IGNORED_UNRELATED_SUBSCRIPTION");
    expect((await setup({ verifier: false }).billing.handlePayPalWebhook(ev.headers, ev.rawBody)).http).toBe(503);
  });

  it("concurrent deliveries and refreshes create exactly one grant; a provider failure is retryable, not swallowed as DUPLICATE", async () => {
    const s = setup();
    const sub = await subscribed(s);
    s.fake.buyerApproves(sub.paypalSubscriptionId!);
    const events = Array.from({ length: 6 }, (_, i) => s.fake.makeWebhook(i % 2 ? "PAYMENT.SALE.COMPLETED" : "BILLING.SUBSCRIPTION.ACTIVATED",
      i % 2 ? { id: `MOCKSALEX${i}AAAAA`, billing_agreement_id: sub.paypalSubscriptionId } : { id: sub.paypalSubscriptionId }));
    const same = events[0]!;
    const outs = await Promise.all([...events.map((e) => s.billing.handlePayPalWebhook(e.headers, e.rawBody)), s.billing.handlePayPalWebhook(same.headers, same.rawBody),
      s.billing.refresh(sub.id), s.billing.handleBuyerReturn(sub.id, sub.paypalSubscriptionId)]);
    expect(s.billing.grants(sub.id)).toHaveLength(1);
    expect(outs.slice(0, 7).filter((o: any) => o.outcome === "RECONCILED_ACTIVE")).toHaveLength(6);
    expect(outs.slice(0, 7).filter((o: any) => ["DUPLICATE", "IN_PROGRESS"].includes(o.outcome))).toHaveLength(1);

    const s2 = setup();
    const sub2 = await subscribed(s2);
    s2.fake.buyerApproves(sub2.paypalSubscriptionId!);
    const e2 = s2.fake.makeWebhook("BILLING.SUBSCRIPTION.ACTIVATED", { id: sub2.paypalSubscriptionId });
    // Verification succeeds, then the authoritative GET fails once: the event must stay re-processable.
    const realFetch = s2.fake.fetch;
    let failGet = true;
    (s2.adapter as any).fetchImpl = async (u: any, init: any) => { if (failGet && String(u).includes("/v1/billing/subscriptions/I-") && (init?.method ?? "GET") === "GET") { failGet = false; return new Response("{}", { status: 503 }); } return realFetch(u, init); };
    expect(await s2.billing.handlePayPalWebhook(e2.headers, e2.rawBody)).toEqual({ http: 503, outcome: "FAILED_RETRYABLE" });
    expect(await s2.billing.handlePayPalWebhook(e2.headers, e2.rawBody)).toEqual({ http: 200, outcome: "RECONCILED_ACTIVE" });
    expect(await s2.billing.handlePayPalWebhook(e2.headers, e2.rawBody)).toEqual({ http: 200, outcome: "DUPLICATE" });
  });

  it("refund or reversal (confirmed by reading the sale) revokes the current grant and holds the subscription", async () => {
    const s = setup();
    const sub = await active(s);
    op(s);
    const saleId = [...s.fake.sales.values()].find((x) => x.billing_agreement_id === sub.paypalSubscriptionId)!.id;
    const claim = s.fake.makeWebhook("PAYMENT.SALE.REFUNDED", { id: "MOCKREFUND000001", sale_id: saleId });
    expect((await s.billing.handlePayPalWebhook(claim.headers, claim.rawBody)).outcome).toBe("NO_CHANGE_SALE_COMPLETED"); // PayPal says still completed
    s.fake.refundSale(saleId);
    const ev = s.fake.makeWebhook("PAYMENT.SALE.REFUNDED", { id: "MOCKREFUND000002", sale_id: saleId });
    expect((await s.billing.handlePayPalWebhook(ev.headers, ev.rawBody)).outcome).toBe("HOLD_PAYMENT_REVERSED");
    expect(s.billing.grants(sub.id)[0]!.status).toBe("REVOKED");
    expect(denied(() => op(s))).toBe("HOLD_PAYMENT_REFUNDED_OR_REVERSED");
  });
});

describe("managed MCP path with subscription billing; separation from purchases; community untouched", () => {
  function plane(mode: "community" | "managed") {
    const store = new Store(":memory:");
    const ledger = new UsageLedger(store, PLACEHOLDER_PRICING, { perRequestSupplierMicro: 200_000, monthlyBillableMinor: 10_000 });
    const tavily = new MockTavilySearch();
    const fake = new FakePayPalSubscriptions(); fakes.push(fake);
    const adapter = new PayPalSubscriptionsSandboxAdapter({ clientId: "MOCK-CLIENT", clientSecret: "MOCK-SECRET", env: "SANDBOX", fetchImpl: fake.fetch, label: "MOCK" });
    const billing = mode === "managed" ? new ManagedSubscriptionBilling(store, ledger, adapter, { plans: [{ ...PLAN, includedAllowanceMinor: 300, operationCaps: {} }], baseUrl: "http://127.0.0.1", webhookVerifier: new PayPalPostbackWebhookVerifier(adapter, fake.webhookId) }) : null;
    const svc: ServicePlane = { mode, ledger, router: new EvidenceRouter(store, ledger, tavily, new MockKernelInspector(), { billable: mode === "managed" }), billing, managedSimulation: mode === "managed" };
    return { svc, ledger, tavily, fake, billing };
  }
  const DISCOVERY = { request: "Find good headphones under $100", mustHave: ["active_noise_cancellation"], currency: "USD" };

  it("subscribe once via the owner API, approve on (fake) PayPal, then research runs without per-call approval; AI tokens cannot subscribe", async () => {
    const p = plane("managed");
    const h = await startHarness({ service: p.svc }); hs.push(h);
    const c = await mcpClient(h.url, TOKENS.alice);
    expect((await callError(c, "research_purchase", DISCOVERY)).code).toBe("BILLING_AUTHORIZATION_REQUIRED");
    expect(p.tavily.calls).toBe(0);
    await p.billing!.ensurePlan(PLAN.planKey);
    const plans = await (await fetch(`${h.url}/billing/plans`)).json();
    const digest = plans.plans[0].termsDigest;
    const post = (key: string | null, body: unknown) => fetch(`${h.url}/owner/billing/subscriptions`, { method: "POST", headers: { "content-type": "application/json", ...(key ? { "x-owner-key": key } : {}) }, body: JSON.stringify(body) });
    expect((await post(TOKENS.alice, { planKey: PLAN.planKey, acceptTermsDigest: digest })).status).toBe(401); // AI client token is not an owner key
    expect((await post(OWNER.alice, { planKey: PLAN.planKey, acceptTermsDigest: "bad" })).status).toBe(409);
    const created = await (await post(OWNER.alice, { planKey: PLAN.planKey, acceptTermsDigest: digest })).json();
    expect(created).toMatchObject({ state: "APPROVAL_PENDING", environment: "MOCK_PAYPAL_SUBSCRIPTIONS" });
    const ppId = p.billing!.byId(created.subscriptionId)!.paypalSubscriptionId!;
    // Redirect before approval: page shows the server-verified state; still no entitlement.
    const early = await (await fetch(`${h.url}/billing/subscription/return?subscription=${created.subscriptionId}&subscription_id=${ppId}`)).text();
    expect(early).toContain("APPROVAL_PENDING");
    expect((await callError(c, "research_purchase", DISCOVERY)).code).toBe("BILLING_AUTHORIZATION_REQUIRED");
    p.fake.buyerApproves(ppId);
    const ev = p.fake.makeWebhook("BILLING.SUBSCRIPTION.ACTIVATED", { id: ppId });
    const wh = await fetch(`${h.url}/billing/paypal/webhook`, { method: "POST", body: ev.rawBody, headers: { "paypal-transmission-id": ev.headers.transmissionId,
      "paypal-transmission-time": ev.headers.transmissionTime, "paypal-transmission-sig": ev.headers.transmissionSig, "paypal-cert-url": ev.headers.certUrl, "paypal-auth-algo": ev.headers.authAlgo } });
    expect(await wh.json()).toEqual({ outcome: "RECONCILED_ACTIVE" });
    const r = await call(c, "research_purchase", DISCOVERY);
    expect(r.usage.records.some((u: any) => u.billableMinor > 0)).toBe(true);
    const u = await call(c, "get_usage_summary", {});
    expect(u.billing.billingAuthorization).toMatchObject({ status: "ACTIVE", source: "MOCK_PAYPAL_SUBSCRIPTIONS", entitlement: { entitled: true } });
    expect(u.billing.subscriptionStatement.amounts).toMatchObject({ billedAmount: { minor: 900 }, servicePrice: { planMonthlyPriceMinor: 900 } });
    expect(u.billing.periodSummary).toBeUndefined();
    // Bob has nothing from Alice's subscription.
    const bob = await mcpClient(h.url, TOKENS.bob);
    expect((await callError(bob, "research_purchase", DISCOVERY)).code).toBe("BILLING_AUTHORIZATION_REQUIRED");
    // Separation: an entitled subscription never authorizes a merchandise purchase.
    const rr = await call(c, "research_purchase", { request: "Buy Sony WH-CH720N Black", currency: "USD" });
    await call(c, "compare_purchase_offers", { researchSessionId: rr.purchaseSessionId, productIdentity: SONY_BLACK, destination: CA });
    const prep = await call(c, "prepare_checkout", { purchaseSessionId: rr.purchaseSessionId, offerId: "off_alpha", maximumApprovedTotalMinor: 6000, currency: "USD", quantity: 1 });
    expect(prep.authorizationRequirements).toContain("OWNER_MANDATE_REQUIRED");
    expect(h.mock.calls.createOrder).toBe(0);
    // Owner cancels; the owner API reports the authoritative state.
    const cancel = await (await fetch(`${h.url}/owner/billing/subscriptions/${created.subscriptionId}/cancel`, { method: "POST", headers: { "x-owner-key": OWNER.alice } })).json();
    expect(cancel.state).toBe("CANCELLED");
    await c.close(); await bob.close();
  });

  it("community mode: no subscription routes, no entitlement guard, research works without any billing", async () => {
    const p = plane("community");
    expect(p.ledger.hasEntitlementGuard).toBe(false);
    const h = await startHarness({ service: p.svc }); hs.push(h);
    expect((await fetch(`${h.url}/billing/plans`)).status).toBe(404);
    const c = await mcpClient(h.url, TOKENS.alice);
    await call(c, "research_purchase", DISCOVERY);
    expect((await call(c, "get_usage_summary", {})).billing).toMatchObject({ status: "NOT_APPLICABLE_COMMUNITY" });
    expect(p.fake.calls).toEqual([]);
    await c.close();
  });

  it("factory: default managed billing is the MOCK subscription stack; Sandbox without explicit placeholder prices offers nothing", () => {
    const store = new Store(":memory:");
    const b = createManagedBilling({}, store, new UsageLedger(store), "http://127.0.0.1:8790");
    expect(b.name).toBe("mock-paypal-subscriptions-v1");
    const store2 = new Store(":memory:");
    const sb = createManagedBilling({ MANAGED_BILLING: "paypal-sandbox-subscriptions", PAYPAL_CLIENT_ID: "x", PAYPAL_CLIENT_SECRET: "y", PAYPAL_ENV: "SANDBOX" }, store2, new UsageLedger(store2), "http://127.0.0.1:8790") as ManagedSubscriptionBilling;
    expect(sb.listPlans().every((p) => !p.offerable)).toBe(true);
    const store3 = new Store(":memory:");
    expect(() => createManagedBilling({ MANAGED_BILLING: "paypal-sandbox-subscriptions", PAYPAL_CLIENT_ID: "x", PAYPAL_CLIENT_SECRET: "y", PAYPAL_ENV: "LIVE" }, store3, new UsageLedger(store3), "x")).toThrow(/SANDBOX/);
  });
});
