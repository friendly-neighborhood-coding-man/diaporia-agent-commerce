import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { OWNER, TOKENS, buyer, call, createMandate, mcpClient, researchAndCompare, SONY_BLACK, startHarness, type Harness } from "./helpers.js";
import { sharedBrowser, closeSharedBrowser } from "./handoff-helpers.js";
import { ProviderError, ProviderTimeoutError } from "../src/payment/PaymentProvider.js";

/**
 * Expiry hardening before Scenario I run 3 (owner request 2026-11-10 13:19Z). Before this change a buyer approval that
 * arrived after the checkout expired still captured. Invariants under test:
 *  E1 an expired checkout never initiates a new capture;
 *  E2 approval validity is re-checked at the capture decision itself, after every await, under concurrency;
 *  E3 reconcile tells an already requested capture (durable capture_requested_at) from a new attempt;
 *  E4 an expired checkout whose payment is uncertain stays reconcilable by reads only, with no blind retry;
 *  E5 no reservation is released while a requested capture could still succeed;
 *  E6 no "not paid" outcome without evidence (never-requested, or a VOIDED order with no capture);
 *  E7 no refunds; legitimate recovery before expiry still works.
 */
vi.setConfig({ testTimeout: 60_000 });

const TTL = 15 * 60_000;
let h: Harness;
beforeEach(async () => { h = await startHarness(); });
afterEach(async () => { await h.close(); });
// Launch Chromium once, outside the first browser test's 60 s budget (cold launch on a contended CI runner), as phase-c-handoff does.
beforeAll(async () => { await sharedBrowser(); }, 120_000);
afterAll(async () => { await closeSharedBrowser(); });

const form = (body: Record<string, string>, cookie?: string) => ({ method: "POST", redirect: "manual" as const,
  headers: { "Content-Type": "application/x-www-form-urlencoded", ...(cookie ? { Cookie: cookie } : {}) }, body: new URLSearchParams(body).toString() });
async function ownerAuthorize(url: string) {
  const r = await fetch(url, form({ action: "review", ownerKey: OWNER.alice }));
  const html = await r.text();
  const cookie = r.headers.get("set-cookie")?.split(";")[0] ?? ""; const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
  const a = await fetch(url, form({ action: "authorize", csrf, maximum: "60.00" }, cookie));
  expect(a.status).toBe(303);
  return a.headers.get("location")!;
}
type Client = Awaited<ReturnType<typeof mcpClient>>;
async function prepare(client: Client) {
  const { research } = await researchAndCompare(client);
  return call(client, "prepare_checkout", { purchaseSessionId: research.purchaseSessionId, offerId: "off_alpha", maximumApprovedTotalMinor: 6000, currency: "USD", quantity: 1 });
}
/** prepare + owner authorize: returns the checkout id and the MOCK approval URL. */
async function authorized(client: Client) { const p = await prepare(client); return { id: p.checkoutSessionId as string, approvalUrl: await ownerAuthorize(p.userAuthorizationUrl) }; }
const db = () => h.app.store.db;
const row = (id: string) => db().prepare("SELECT state, failure_code, reserved_minor, capture_requested_at, capture_id FROM checkout_sessions WHERE id = ?").get(id) as any;
const boundMandate = (id: string) => db().prepare("SELECT status, reserved_minor, consumed_minor, transactions_used FROM mandates WHERE bound_checkout_session_id = ?").get(id) as any;
const orderOf = (approvalUrl: string) => new URL(approvalUrl).pathname.split("/").pop()!;
const status = (client: Client, id: string) => call(client, "get_checkout_status", { checkoutSessionId: id });
const reconcile = (id: string) => fetch(`${h.url}/owner/checkouts/${id}/reconcile`, { method: "POST", headers: { "X-Owner-Key": OWNER.alice } }).then((r) => r.json() as any);
/** Wrap a mock provider method: `hook(n)` runs before the n-th call (1-based) and may move the clock or wait. */
function around(name: "getOrder" | "captureOrder", hook: (n: number) => Promise<void> | void) {
  const orig = (h.mock as any)[name].bind(h.mock); let n = 0;
  (h.mock as any)[name] = async (...args: unknown[]) => { n++; await hook(n); return orig(...args); };
}

describe("expired checkouts never start a capture (real Chromium)", () => {
  it("expiry before approval: the buyer approves on the MOCK page after expiry; nothing is captured and the bound authorization is revoked", async () => {
    const client = await mcpClient(h.url, TOKENS.alice);
    const a = await authorized(client);
    const ctx = await (await sharedBrowser()).newContext();
    try {
      const page = await ctx.newPage();
      await page.goto(a.approvalUrl);
      expect(await page.textContent("body")).toContain("MOCK PayPal");
      h.clock.offsetMs = TTL + 60_000;                                   // the buyer is a minute late
      await page.click("text=Approve (mock buyer)");
      await page.waitForURL(/\/paypal\/return/);
      expect(await page.textContent(".state")).toBe("EXPIRED");
    } finally { await ctx.close(); }
    expect(h.mock.calls.captureOrder).toBe(0);
    expect(row(a.id)).toMatchObject({ state: "EXPIRED", reserved_minor: 0, capture_requested_at: null });
    expect(boundMandate(a.id)).toMatchObject({ status: "REVOKED", reserved_minor: 0, consumed_minor: 0 });
    const ev = db().prepare("SELECT data_json FROM audit_events WHERE subject_id = ? AND type = 'BUYER_APPROVAL_AFTER_EXPIRY'").get(a.id) as any;
    expect(JSON.parse(ev.data_json)).toMatchObject({ providerStatus: "APPROVED", providerCaptures: 0, captureRequested: false });
    const st = await status(client, a.id);
    expect(st.state).toBe("EXPIRED");
    await client.close();
  });

  it("expiry before capture: the approval is verified in time, but a delayed provider read outlives the checkout; the capture gate refuses", async () => {
    const client = await mcpClient(h.url, TOKENS.alice);
    const a = await authorized(client);
    // getOrder #1 = approval check at return (in time); #2 = recipient read inside capture(): the clock passes expiry here.
    around("getOrder", (n) => { if (n === 2) h.clock.offsetMs = TTL + 1_000; });
    const ctx = await (await sharedBrowser()).newContext();
    try {
      const page = await ctx.newPage();
      await page.goto(a.approvalUrl);
      await page.click("text=Approve (mock buyer)");
      await page.waitForURL(/\/paypal\/return/);
      expect(await page.textContent(".state")).toBe("FAILED");
      expect(await page.textContent("body")).toContain("CHECKOUT_EXPIRED_BEFORE_CAPTURE");
    } finally { await ctx.close(); }
    expect(h.mock.calls.captureOrder).toBe(0);
    expect(row(a.id)).toMatchObject({ state: "FAILED", failure_code: "CHECKOUT_EXPIRED_BEFORE_CAPTURE", reserved_minor: 0, capture_requested_at: null });
    expect(boundMandate(a.id)).toMatchObject({ status: "REVOKED", consumed_minor: 0 });
    await client.close();
  });
});

describe("capture decision and reconciliation around expiry (deterministic)", () => {
  it("a capture requested before expiry whose provider response arrives after expiry is honoured (already initiated, not new)", async () => {
    const client = await mcpClient(h.url, TOKENS.alice);
    const a = await authorized(client);
    around("captureOrder", () => { h.clock.offsetMs = TTL + 60_000; });  // the response is late
    await buyer(h, a.approvalUrl, "approve");
    expect(row(a.id)).toMatchObject({ state: "COMPLETED" });
    expect(row(a.id).capture_requested_at).not.toBeNull();
    expect(boundMandate(a.id)).toMatchObject({ status: "EXHAUSTED", consumed_minor: 5939, transactions_used: 1 });
    await client.close();
  });

  it("uncertain capture (timeout before it reached the provider), then expiry: reconcile only reads, keeps the reservation, never retries; a VOIDED order then closes it", async () => {
    const client = await mcpClient(h.url, TOKENS.alice);
    const a = await authorized(client);
    h.mock.captureOutcomes.push("TIMEOUT_BEFORE_CAPTURE");
    await buyer(h, a.approvalUrl, "approve");
    expect(row(a.id)).toMatchObject({ state: "UNKNOWN", failure_code: "CAPTURE_OUTCOME_UNKNOWN", reserved_minor: 5939 });
    const requested = row(a.id).capture_requested_at;
    expect(requested).not.toBeNull();
    h.clock.offsetMs = TTL + 60_000;
    const calls = h.mock.calls.captureOrder;
    for (let i = 0; i < 3; i++) expect((await reconcile(a.id)).state).toBe("UNKNOWN");
    await buyer(h, a.approvalUrl, "approve");                               // a late duplicate return is not a retry either
    expect(h.mock.calls.captureOrder).toBe(calls);                         // E4: no blind retry
    expect(row(a.id)).toMatchObject({ state: "UNKNOWN", reserved_minor: 5939, capture_requested_at: requested });
    expect(boundMandate(a.id)).toMatchObject({ status: "ACTIVE", reserved_minor: 5939 });   // E5: kept, still bound
    const st = await status(client, a.id);
    expect(st.state).toBe("UNKNOWN");
    expect(JSON.stringify(st)).not.toMatch(/nothing was captured/i);       // E6: no "not paid" claim
    h.mock.voidOrder(orderOf(a.approvalUrl));                              // provider evidence: order voided, no capture
    expect((await reconcile(a.id)).state).toBe("FAILED");
    expect(row(a.id)).toMatchObject({ failure_code: "PROVIDER_ORDER_VOIDED", reserved_minor: 0 });
    expect(boundMandate(a.id)).toMatchObject({ status: "REVOKED", consumed_minor: 0 });
    await client.close();
  });

  it("capture processed but the response was lost, then expiry: reconcile adopts the existing capture without a new capture call", async () => {
    const client = await mcpClient(h.url, TOKENS.alice);
    const a = await authorized(client);
    h.mock.captureOutcomes.push("TIMEOUT_AFTER_CAPTURE");
    await buyer(h, a.approvalUrl, "approve");
    expect(row(a.id).state).toBe("UNKNOWN");
    h.clock.offsetMs = TTL + 60_000;
    const calls = h.mock.calls.captureOrder;
    expect((await reconcile(a.id)).state).toBe("COMPLETED");
    expect(h.mock.calls.captureOrder).toBe(calls);
    expect(boundMandate(a.id)).toMatchObject({ status: "EXHAUSTED", consumed_minor: 5939 });
    await client.close();
  });

  it("legitimate recovery before expiry is preserved: an uncertain capture is replayed once with the same request id and completes", async () => {
    const client = await mcpClient(h.url, TOKENS.alice);
    const a = await authorized(client);
    h.mock.captureOutcomes.push("TIMEOUT_BEFORE_CAPTURE");
    await buyer(h, a.approvalUrl, "approve");
    expect(row(a.id).state).toBe("UNKNOWN");
    expect((await reconcile(a.id)).state).toBe("COMPLETED");
    expect(h.mock.describe(orderOf(a.approvalUrl))!.captures).toHaveLength(1);
    const ev = db().prepare("SELECT data_json FROM audit_events WHERE subject_id = ? AND type = 'CAPTURE_REQUESTED' ORDER BY seq").all(a.id) as any[];
    expect(ev.map((e) => JSON.parse(e.data_json).replay)).toEqual([false, true]);   // E3: the replay is labelled as one
    await client.close();
  });

  it("an UNKNOWN checkout from before the capture_requested_at column (CAPTURE_REQUESTED only in the audit) is still treated as requested", async () => {
    const client = await mcpClient(h.url, TOKENS.alice);
    const a = await authorized(client);
    h.mock.captureOutcomes.push("TIMEOUT_BEFORE_CAPTURE");
    await buyer(h, a.approvalUrl, "approve");
    db().prepare("UPDATE checkout_sessions SET capture_requested_at = NULL, failure_code = 'LEGACY' WHERE id = ?").run(a.id);
    h.clock.offsetMs = TTL + 60_000;
    const calls = h.mock.calls.captureOrder;
    expect((await reconcile(a.id)).state).toBe("UNKNOWN");
    expect(h.mock.calls.captureOrder).toBe(calls);
    expect(row(a.id).reserved_minor).toBe(5939);
    await client.close();
  });

  it("concurrent late returns racing expiry: five returns, all held in the recipient read across expiry, give one FAILED, zero captures, one release", async () => {
    const client = await mcpClient(h.url, TOKENS.alice);
    await createMandate(h.url, OWNER.alice, { productIdentity: SONY_BLACK, currency: "USD", maximumTotalMinor: 6000 });   // reusable: a double release would show
    const p = await prepare(client);
    expect(p.approvalUrl).toBeTruthy();
    const orderId = orderOf(p.approvalUrl);
    h.mock.buyerApprove(orderId);
    let release!: () => void; const gate = new Promise<void>((r) => (release = r)); let held = 0;
    // Hold every recipient read inside capture() (the checkout is APPROVED by then); approval checks pass through.
    around("getOrder", async () => { if (row(p.checkoutSessionId).state === "APPROVED") { held++; await gate; } });
    const first = h.app.gateway.handleBuyerReturn(p.checkoutSessionId, orderId);
    while (held < 1) await new Promise((r) => setTimeout(r, 5));
    const more = Array.from({ length: 4 }, () => h.app.gateway.handleBuyerReturn(p.checkoutSessionId, orderId));   // late duplicates enter capture() too
    while (held < 5) await new Promise((r) => setTimeout(r, 5));
    h.clock.offsetMs = TTL + 1_000;                                        // expiry passes while all five wait on the provider
    release();
    await Promise.all([first, ...more]);
    expect(row(p.checkoutSessionId)).toMatchObject({ state: "FAILED", failure_code: "CHECKOUT_EXPIRED_BEFORE_CAPTURE", capture_requested_at: null });
    expect(h.mock.calls.captureOrder).toBe(0);
    expect(db().prepare("SELECT status, reserved_minor, consumed_minor, transactions_used FROM mandates WHERE user_id = 'alice'").all())
      .toEqual([{ status: "ACTIVE", reserved_minor: 0, consumed_minor: 0, transactions_used: 0 }]);
    expect((db().prepare("SELECT COUNT(*) n FROM audit_events WHERE subject_id = ? AND type = 'CAPTURE_REFUSED_CHECKOUT_EXPIRED'").get(p.checkoutSessionId) as any).n).toBe(1);
    await client.close();
  });

  it("concurrent in-time returns still capture exactly once", async () => {
    const client = await mcpClient(h.url, TOKENS.alice);
    const a = await authorized(client);
    const orderId = orderOf(a.approvalUrl);
    h.mock.buyerApprove(orderId);
    const out = await Promise.all(Array.from({ length: 5 }, () => h.app.gateway.handleBuyerReturn(a.id, orderId)));
    expect(out.some((c) => c.state === "COMPLETED")).toBe(true);
    expect(h.mock.describe(orderId)!.captures).toHaveLength(1);
    expect(row(a.id).state).toBe("COMPLETED");
    await client.close();
  });
});

describe("replays after an uncertain capture never fail closed on their own errors (independent review F1–F5)", () => {
  async function uncertain(client: Client) {
    const a = await authorized(client);
    h.mock.captureOutcomes.push("TIMEOUT_BEFORE_CAPTURE");
    await buyer(h, a.approvalUrl, "approve");
    expect(row(a.id)).toMatchObject({ state: "UNKNOWN", reserved_minor: 5939 });
    return a;
  }

  it("F1: a provider read failing during the replay keeps UNKNOWN and the reservation; a later reconcile completes", async () => {
    const client = await mcpClient(h.url, TOKENS.alice);
    const a = await uncertain(client);
    // reconcile: getOrder #1 = order read (APPROVED); #2 = recipient read inside capture(): fails once.
    around("getOrder", (n) => { if (n === 2) throw new ProviderTimeoutError("transient read failure"); });
    expect((await reconcile(a.id)).state).toBe("UNKNOWN");
    expect(row(a.id).reserved_minor).toBe(5939);
    expect(boundMandate(a.id)).toMatchObject({ status: "ACTIVE", reserved_minor: 5939 });
    expect(JSON.stringify(await status(client, a.id))).not.toMatch(/nothing was captured/i);
    expect((await reconcile(a.id)).state).toBe("COMPLETED");
    expect(h.mock.describe(orderOf(a.approvalUrl))!.captures).toHaveLength(1);
    await client.close();
  });

  it("F1 past expiry: an APPROVED row whose capture was already requested is never failed by a late buyer return", async () => {
    const client = await mcpClient(h.url, TOKENS.alice);
    const a = await uncertain(client);
    db().prepare("UPDATE checkout_sessions SET state = 'APPROVED' WHERE id = ?").run(a.id);   // crash between UNKNOWN→APPROVED and the gate
    h.clock.offsetMs = TTL + 60_000;
    // From APPROVED the return goes straight to capture(): getOrder #1 is the recipient read, and it fails.
    around("getOrder", (n) => { if (n === 1) throw new ProviderTimeoutError("transient read failure"); });
    await buyer(h, a.approvalUrl, "approve");
    expect(row(a.id)).toMatchObject({ state: "UNKNOWN", reserved_minor: 5939 });
    await client.close();
  });

  it("F2: a 4xx on a replayed capture (e.g. 409 same request in progress) is not a rejection: UNKNOWN, reservation kept", async () => {
    const client = await mcpClient(h.url, TOKENS.alice);
    const a = await uncertain(client);
    (h.mock as any).captureOrder = async () => { throw new ProviderError("409 previous request with this PayPal-Request-Id in progress", 409, null); };
    expect((await reconcile(a.id)).state).toBe("UNKNOWN");
    expect(row(a.id).reserved_minor).toBe(5939);
    expect(boundMandate(a.id)).toMatchObject({ status: "ACTIVE", reserved_minor: 5939 });
    await client.close();
  });

  it("a 4xx on the FIRST capture request is still a definite rejection (FAILED, released)", async () => {
    const client = await mcpClient(h.url, TOKENS.alice);
    const a = await authorized(client);
    (h.mock as any).captureOrder = async () => { throw new ProviderError("422 INSTRUMENT_DECLINED", 422, null); };
    await buyer(h, a.approvalUrl, "approve");
    expect(row(a.id)).toMatchObject({ state: "FAILED", failure_code: "CAPTURE_REJECTED", reserved_minor: 0 });
    await client.close();
  });

  it("F3: CAPTURE_PENDING with no capture id (process stopped mid-capture) is recovered by reconcile once stale, and left alone while recent", async () => {
    const client = await mcpClient(h.url, TOKENS.alice);
    const a = await uncertain(client);
    db().prepare("UPDATE checkout_sessions SET state = 'CAPTURE_PENDING', failure_code = NULL, updated_at = ? WHERE id = ?").run(Date.now() + h.clock.offsetMs, a.id);
    expect((await reconcile(a.id)).state).toBe("CAPTURE_PENDING");          // may still be in flight: untouched
    h.clock.offsetMs = 6 * 60_000;                                           // stale, checkout not expired yet
    expect((await reconcile(a.id)).state).toBe("COMPLETED");
    expect(h.mock.describe(orderOf(a.approvalUrl))!.captures).toHaveLength(1);
    await client.close();
  });

  it("F3 with a VOIDED order: the stuck capture closes with provider evidence", async () => {
    const client = await mcpClient(h.url, TOKENS.alice);
    const a = await uncertain(client);
    db().prepare("UPDATE checkout_sessions SET state = 'CAPTURE_PENDING', failure_code = NULL, updated_at = ? WHERE id = ?").run(Date.now(), a.id);
    h.clock.offsetMs = TTL + 60_000;
    h.mock.voidOrder(orderOf(a.approvalUrl));
    expect((await reconcile(a.id)).state).toBe("FAILED");
    expect(row(a.id)).toMatchObject({ failure_code: "PROVIDER_ORDER_VOIDED", reserved_minor: 0 });
    await client.close();
  });

  it("F4: concurrent reconciles and a buyer return during recovery give one capture and no thrown errors", async () => {
    const client = await mcpClient(h.url, TOKENS.alice);
    const a = await uncertain(client);
    const results = await Promise.allSettled([reconcile(a.id), reconcile(a.id), h.app.gateway.handleBuyerReturn(a.id, orderOf(a.approvalUrl)), h.app.gateway.reconcile("alice", a.id)]);
    expect(results.filter((r) => r.status === "rejected")).toEqual([]);
    expect(row(a.id).state).toBe("COMPLETED");
    expect(h.mock.describe(orderOf(a.approvalUrl))!.captures).toHaveLength(1);
    await client.close();
  });

  it("F5: an approval that expired before capture is reported as EXPIRED with no-payment wording backed by 'never requested'", async () => {
    const client = await mcpClient(h.url, TOKENS.alice);
    const a = await authorized(client);
    around("getOrder", (n) => { if (n === 2) h.clock.offsetMs = TTL + 1_000; });
    await buyer(h, a.approvalUrl, "approve");
    const st = await status(client, a.id);
    expect(st.paymentStatus).toBe("EXPIRED");
    expect(st.purchaseOutcome.statement).toMatch(/never requested one, so no payment was taken/);
    await client.close();
  });

  it("G1: a concurrent return whose recipient read fails cannot fail or release a capture already in flight", async () => {
    const client = await mcpClient(h.url, TOKENS.alice);
    const a = await authorized(client);
    const orderId = orderOf(a.approvalUrl);
    h.mock.buyerApprove(orderId);
    let openA!: () => void; const gateA = new Promise<void>((r) => (openA = r));
    let openCap!: () => void; const gateCap = new Promise<void>((r) => (openCap = r));
    let failB!: () => void; const gateB = new Promise<void>((r) => (failB = r));
    // getOrder #1 = A's approval check, #2 = A's recipient read (held), #3 = B's recipient read (held, then fails).
    around("getOrder", async (n) => { if (n === 2) await gateA; if (n === 3) { await gateB; throw new ProviderTimeoutError("B's recipient read failed"); } });
    let capStarted = false;
    around("captureOrder", async () => { capStarted = true; await gateCap; });
    const A = h.app.gateway.handleBuyerReturn(a.id, orderId);
    while (row(a.id).state !== "APPROVED") await new Promise((r) => setTimeout(r, 5));
    const B = h.app.gateway.handleBuyerReturn(a.id, orderId);              // reads APPROVED, enters capture(), waits on its recipient read
    await new Promise((r) => setTimeout(r, 30));
    openA();                                                               // A passes the gate; its capture is now at the provider
    while (!capStarted) await new Promise((r) => setTimeout(r, 5));
    expect(row(a.id).state).toBe("CAPTURE_PENDING");
    failB();
    const b = await B;                                                     // B must leave the in-flight capture alone
    expect(b.state).toBe("CAPTURE_PENDING");
    expect(row(a.id)).toMatchObject({ state: "CAPTURE_PENDING", reserved_minor: 5939 });
    openCap();
    expect((await A).state).toBe("COMPLETED");
    expect(h.mock.describe(orderId)!.captures).toHaveLength(1);
    expect(boundMandate(a.id)).toMatchObject({ status: "EXHAUSTED", consumed_minor: 5939 });
    await client.close();
  });
});
