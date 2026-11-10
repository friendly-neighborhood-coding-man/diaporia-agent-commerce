import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { OWNER, TOKENS, buyer, call, createMandate, mcpClient, researchAndCompare, SONY_BLACK, startHarness, type Harness } from "./helpers.js";
import { sharedBrowser, closeSharedBrowser } from "./handoff-helpers.js";

/**
 * DF-4 (Scenario I run 2, 2026-11-10). The owner submitted the approval page of an EXPIRED checkout. The server
 * created an ACTIVE, unbound $60 mandate anyway, and the host's next prepare_checkout for the same product reserved
 * it and created a provider order without the owner ever seeing the new checkout.
 * Invariants under test:
 *  I1 an owner-page authorization is bound to its checkout (and through it to identity, merchant, amount,
 *     currency) and never authorizes another checkout, automatically or otherwise;
 *  I2 reusable owner-API mandates stay distinguishable and keep working;
 *  I3 an ineligible checkout (expired, completed, cancelled, already authorized) creates no authority;
 *  I4 eligibility and creation are atomic: concurrent or duplicate submits create at most one authorization;
 *  I5 failed payment start withdraws the authorization; UNKNOWN keeps it bound and non-transferable.
 */
vi.setConfig({ testTimeout: 60_000 });

let h: Harness;
beforeEach(async () => { h = await startHarness(); });
afterEach(async () => { await h.close(); });
// Launch Chromium once, outside the first browser test's 60 s budget (cold launch on a contended CI runner), as phase-c-handoff does.
beforeAll(async () => { await sharedBrowser(); }, 120_000);
afterAll(async () => { await closeSharedBrowser(); });

const form = (body: Record<string, string>, cookie?: string) => ({ method: "POST", redirect: "manual" as const,
  headers: { "Content-Type": "application/x-www-form-urlencoded", ...(cookie ? { Cookie: cookie } : {}) }, body: new URLSearchParams(body).toString() });
async function review(url: string) {
  const r = await fetch(url, form({ action: "review", ownerKey: OWNER.alice }));
  const html = await r.text();
  return { cookie: r.headers.get("set-cookie")?.split(";")[0] ?? "", csrf: /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? "" };
}
async function authorize(url: string, maximum = "60.00") { const r = await review(url); return fetch(url, form({ action: "authorize", csrf: r.csrf, maximum }, r.cookie)); }
async function prepare(client: Awaited<ReturnType<typeof mcpClient>>) {
  const { research } = await researchAndCompare(client);
  return call(client, "prepare_checkout", { purchaseSessionId: research.purchaseSessionId, offerId: "off_alpha", maximumApprovedTotalMinor: 6000, currency: "USD", quantity: 1 });
}
const db = () => h.app.store.db;
const liveMandates = () => db().prepare("SELECT id, created_via, bound_checkout_session_id, status FROM mandates WHERE user_id = 'alice' AND status = 'ACTIVE'").all() as any[];
const needsOwner = (p: any) => p.state === "APPROVAL_REQUIRED" && p.authorizationRequirements.includes("OWNER_MANDATE_REQUIRED") && !p.approvalUrl;

describe("DF-4: owner-page authorization is bound to one checkout", () => {
  it("exact run-2 sequence in a real Chromium: expired checkout A → owner submits A's page → new checkout B still needs the owner", async () => {
    const client = await mcpClient(h.url, TOKENS.alice);
    const a = await prepare(client);
    expect(needsOwner(a)).toBe(true);
    h.clock.offsetMs += 16 * 60_000; // past A's 15-minute expiry, as at 12:41:52Z → 12:43:21Z

    const ctx = await (await sharedBrowser()).newContext();
    try {
      const page = await ctx.newPage();
      await page.goto(a.userAuthorizationUrl);
      await page.fill("input[name=ownerKey]", OWNER.alice);
      await page.click("button");
      // The review page may still render (the checkout exists); the authorize submit must be refused.
      if (await page.locator("input[name=maximum]").count()) {
        await page.fill("input[name=maximum]", "60.00");
        const [resp] = await Promise.all([page.waitForResponse((r) => r.request().method() === "POST"), page.click("form:has(input[name=action][value=authorize]) button")]);
        expect(resp.status()).toBe(409);
        expect(await page.textContent("body")).toContain("No new spending limit was created");
        expect(await page.textContent(".state")).toBe("EXPIRED");      // the state after the re-check, not before it
      }
    } finally { await ctx.close(); }

    expect(liveMandates()).toEqual([]);
    const b = await prepare(client);                                // the host's rerun
    expect(needsOwner(b)).toBe(true);
    expect(h.mock.calls.createOrder).toBe(0);                       // no provider order without the owner
    expect(db().prepare("SELECT count(*) n FROM audit_events WHERE subject_id = ? AND type = 'OWNER_AUTHORIZATION_REFUSED'").get(a.checkoutSessionId)).toEqual({ n: 1 });
    await client.close();
  });

  it("a live page authorization for A is never used for a new checkout B (not selected, and refused by policy if forced)", async () => {
    const client = await mcpClient(h.url, TOKENS.alice);
    const a = await prepare(client);
    expect((await authorize(a.userAuthorizationUrl)).status).toBe(303);           // A authorized, awaiting buyer
    const m = liveMandates();
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ created_via: "OWNER_APPROVAL_PAGE", bound_checkout_session_id: a.checkoutSessionId });
    const b = await prepare(client);
    expect(needsOwner(b)).toBe(true);
    expect(h.mock.calls.createOrder).toBe(1);                                      // only A's order
    const mandate = h.app.gateway.mandates.get(m[0].id, "alice")!;
    expect(mandate.scope).toBe("CHECKOUT_BOUND");
    const forced = h.app.gateway.policy.evaluate(mandate, { userId: "alice", checkoutSessionId: b.checkoutSessionId, productIdentity: SONY_BLACK, merchantId: "alpha-audio.example", currency: "USD", quantity: 1, totalMinor: 5939 });
    expect(forced.code).toBe("BOUND_TO_OTHER_CHECKOUT");
    await client.close();
  });

  it("a legacy unbound page mandate (as left by run 2) is unusable: never selected, refused for any checkout", async () => {
    const client = await mcpClient(h.url, TOKENS.alice);
    const now = Date.now();
    db().prepare(`INSERT INTO mandates(id,user_id,identity_json,currency,max_total_minor,max_quantity,max_transactions,expires_at,merchant_constraints_json,status,created_via,created_at)
      VALUES ('mdt_00000000-0000-4000-8000-00000000df04','alice',?,'USD',6000,1,1,?,?,'ACTIVE','OWNER_APPROVAL_PAGE',?)`)
      .run(JSON.stringify(SONY_BLACK), now + 30 * 60_000, JSON.stringify({ allowedMerchantIds: ["alpha-audio.example"] }), now);
    const b = await prepare(client);
    expect(needsOwner(b)).toBe(true);
    expect(h.mock.calls.createOrder).toBe(0);
    await client.close();
  });

  it("completed, cancelled and already-authorized checkouts create no new authority", async () => {
    const client = await mcpClient(h.url, TOKENS.alice);
    const done = await prepare(client);
    const ok = await authorize(done.userAuthorizationUrl);
    await buyer(h, ok.headers.get("location")!);
    expect((await authorize(done.userAuthorizationUrl)).status).toBe(409);       // completed

    const pending = await prepare(client);
    expect((await authorize(pending.userAuthorizationUrl)).status).toBe(303);
    expect((await authorize(pending.userAuthorizationUrl)).status).toBe(409);    // already authorized

    const cancelled = await prepare(client);
    const c = await fetch(`${h.url}/owner/checkouts/${cancelled.checkoutSessionId}/cancel`, { method: "POST", headers: { "X-Owner-Key": OWNER.alice } });
    expect(c.status).toBe(200);
    expect((await authorize(cancelled.userAuthorizationUrl)).status).toBe(409);  // cancelled

    const bound = db().prepare("SELECT bound_checkout_session_id b, status FROM mandates WHERE user_id = 'alice' ORDER BY created_at").all() as any[];
    expect(bound.map((r) => r.b)).toEqual([done.checkoutSessionId, pending.checkoutSessionId]);   // exactly one per authorized checkout
    await client.close();
  });

  it("concurrent submits for one checkout create exactly one authorization and one provider order", async () => {
    const client = await mcpClient(h.url, TOKENS.alice);
    const a = await prepare(client);
    const sessions = await Promise.all(Array.from({ length: 6 }, () => review(a.userAuthorizationUrl)));
    const results = await Promise.all(sessions.map((s) => fetch(a.userAuthorizationUrl, form({ action: "authorize", csrf: s.csrf, maximum: "60.00" }, s.cookie))));
    const codes = results.map((r) => r.status).sort();
    expect(codes).toEqual([303, 409, 409, 409, 409, 409]);
    expect(db().prepare("SELECT count(*) n FROM mandates WHERE bound_checkout_session_id = ?").get(a.checkoutSessionId)).toEqual({ n: 1 });
    expect(h.mock.calls.createOrder).toBe(1);
    await client.close();
  });

  it("the database refuses a second live authorization for the same checkout even outside the gateway (cross-process backstop)", async () => {
    const client = await mcpClient(h.url, TOKENS.alice);
    const a = await prepare(client);
    const mk = () => h.app.gateway.mandates.create({ userId: "alice", productIdentity: SONY_BLACK, currency: "USD", maximumTotalMinor: 6000, createdVia: "OWNER_APPROVAL_PAGE", boundCheckoutSessionId: a.checkoutSessionId });
    const first = mk();
    expect(mk).toThrow(/UNIQUE/);
    h.app.gateway.mandates.revoke(first.mandateId, "alice");
    expect(() => mk()).not.toThrow();                             // a revoked one no longer blocks (e.g. a retry after HOLD)
    expect(() => h.app.gateway.mandates.create({ userId: "alice", productIdentity: SONY_BLACK, currency: "USD", maximumTotalMinor: 6000, createdVia: "OWNER_APPROVAL_PAGE" })).toThrow(/bound/);
    await client.close();
  });

  it("payment start failures: an error withdraws the authorization; a create timeout keeps it UNKNOWN, bound and non-transferable", async () => {
    const client = await mcpClient(h.url, TOKENS.alice);
    const failed = await prepare(client);
    h.mock.createOutcomes.push("ERROR");
    await authorize(failed.userAuthorizationUrl);
    expect((await call(client, "get_checkout_status", { checkoutSessionId: failed.checkoutSessionId })).state).toBe("FAILED");
    expect(liveMandates()).toEqual([]);

    const unknown = await prepare(client);
    h.mock.createOutcomes.push("TIMEOUT_AFTER_CREATE");
    await authorize(unknown.userAuthorizationUrl);
    expect((await call(client, "get_checkout_status", { checkoutSessionId: unknown.checkoutSessionId })).state).toBe("UNKNOWN");
    const kept = liveMandates();
    expect(kept).toHaveLength(1);
    expect(kept[0].bound_checkout_session_id).toBe(unknown.checkoutSessionId);
    const ordersBefore = h.mock.calls.createOrder;
    const next = await prepare(client);
    expect(needsOwner(next)).toBe(true);                          // the UNKNOWN checkout's authority does not transfer
    expect(h.mock.calls.createOrder).toBe(ordersBefore);          // and no second payment is started
    await client.close();
  });

  it("an UNKNOWN create timeout is reconciled by idempotent replay of the same order (never a second order), then completes and consumes the bound authorization", async () => {
    const client = await mcpClient(h.url, TOKENS.alice);
    const a = await prepare(client);
    h.mock.createOutcomes.push("TIMEOUT_AFTER_CREATE");
    await authorize(a.userAuthorizationUrl);
    const orderIds = () => (db().prepare("SELECT provider_order_id FROM checkout_sessions WHERE id = ?").get(a.checkoutSessionId) as any).provider_order_id;
    expect(orderIds()).toBeNull();
    const reconcile = () => fetch(`${h.url}/owner/checkouts/${a.checkoutSessionId}/reconcile`, { method: "POST", headers: { "X-Owner-Key": OWNER.alice } }).then((r) => r.json() as any);
    const r1 = await reconcile();
    expect(r1.state).toBe("UNKNOWN");                                   // order recovered, buyer has not approved yet
    const recovered = orderIds();
    expect(recovered).toMatch(/^MOCK/);
    expect((h.mock as any).orders.size).toBe(1);                         // the same order, not a second one
    await reconcile();
    expect(orderIds()).toBe(recovered);                                  // replays stay idempotent
    expect((h.mock as any).orders.size).toBe(1);
    const approvalUrl = (db().prepare("SELECT approval_url FROM checkout_sessions WHERE id = ?").get(a.checkoutSessionId) as any).approval_url;
    await buyer(h, approvalUrl, "approve");
    const st = await call(client, "get_checkout_status", { checkoutSessionId: a.checkoutSessionId });
    expect(st.state).toBe("COMPLETED");
    expect(h.mock.calls.captureOrder).toBe(1);
    const m = db().prepare("SELECT status, reserved_minor, transactions_used FROM mandates WHERE bound_checkout_session_id = ?").get(a.checkoutSessionId) as any;
    expect(m).toMatchObject({ status: "EXHAUSTED", reserved_minor: 0, transactions_used: 1 });
    expect(liveMandates()).toEqual([]);
    await client.close();
  });

  it("an UNKNOWN create timeout whose order was never approved is closed after expiry and its bound authorization revoked", async () => {
    const client = await mcpClient(h.url, TOKENS.alice);
    const a = await prepare(client);
    h.mock.createOutcomes.push("TIMEOUT_AFTER_CREATE");
    await authorize(a.userAuthorizationUrl);
    h.clock.offsetMs = 16 * 60_000;
    const r = await fetch(`${h.url}/owner/checkouts/${a.checkoutSessionId}/reconcile`, { method: "POST", headers: { "X-Owner-Key": OWNER.alice } }).then((x) => x.json() as any);
    expect(r.state).toBe("CANCELLED");
    expect(h.mock.calls.captureOrder).toBe(0);
    expect(liveMandates()).toEqual([]);
    expect((db().prepare("SELECT status FROM mandates WHERE bound_checkout_session_id = ?").get(a.checkoutSessionId) as any).status).toBe("REVOKED");
    await client.close();
  });

  it("an expired UNKNOWN checkout racing a late buyer approval: no capture, the reservation released exactly once (review N1 + expiry hardening)", async () => {
    const client = await mcpClient(h.url, TOKENS.alice);
    await createMandate(h.url, OWNER.alice, { productIdentity: SONY_BLACK, currency: "USD", maximumTotalMinor: 6000 });
    const { research } = await researchAndCompare(client);
    h.mock.createOutcomes.push("TIMEOUT_AFTER_CREATE");
    const a = await call(client, "prepare_checkout", { purchaseSessionId: research.purchaseSessionId, offerId: "off_alpha", maximumApprovedTotalMinor: 6000, currency: "USD", quantity: 1 });
    h.clock.offsetMs += 16 * 60_000;
    // Hold the owner's reconcile at its first order read (status CREATED) while the buyer approves and returns.
    const orig = h.mock.getOrder.bind(h.mock);
    let open!: () => void; const gate = new Promise<void>((r) => (open = r)); let n = 0;
    (h.mock as any).getOrder = async (id: string) => { n++; const o = await orig(id); if (n === 1) { const snap = structuredClone(o); await gate; return snap; } return o; };
    const r1 = h.app.gateway.reconcile("alice", a.checkoutSessionId);
    await new Promise((r) => setTimeout(r, 20));
    const orderId = (db().prepare("SELECT provider_order_id p FROM checkout_sessions WHERE id = ?").get(a.checkoutSessionId) as any).p;
    h.mock.buyerApprove(orderId);
    const r2 = await h.app.gateway.handleBuyerReturn(a.checkoutSessionId, orderId);
    expect(r2.state).toBe("FAILED");
    expect(r2.failureCode).toBe("CHECKOUT_EXPIRED_BEFORE_CAPTURE");
    open();
    const after1 = await r1;                                                  // the held reconcile sees the moved checkout and does nothing
    expect(after1.state).toBe("FAILED");
    expect(h.mock.calls.captureOrder).toBe(0);
    expect(db().prepare("SELECT status, reserved_minor, consumed_minor, transactions_used FROM mandates WHERE user_id = 'alice'").all())
      .toEqual([{ status: "ACTIVE", reserved_minor: 0, consumed_minor: 0, transactions_used: 0 }]);   // released once, never negative, nothing consumed
    await client.close();
  });

  it("buyer cancellation at the provider revokes the bound authorization instead of returning it to a pool", async () => {
    const client = await mcpClient(h.url, TOKENS.alice);
    const a = await prepare(client);
    const r = await authorize(a.userAuthorizationUrl);
    await buyer(h, r.headers.get("location")!, "cancel");
    expect(liveMandates()).toEqual([]);
    expect(needsOwner(await prepare(client))).toBe(true);
    await client.close();
  });

  it("explicitly created reusable owner-API mandates are distinguishable and still authorize matching checkouts", async () => {
    const client = await mcpClient(h.url, TOKENS.alice);
    const m = await createMandate(h.url, OWNER.alice, { productIdentity: SONY_BLACK, currency: "USD", maximumTotalMinor: 6000 });
    expect(m.status).toBe(201);
    expect(m.body).toMatchObject({ scope: "REUSABLE", boundCheckoutSessionId: null, createdVia: "OWNER_API" });
    const p = await prepare(client);
    expect(p.state).toBe("APPROVAL_REQUIRED");
    expect(p.authorizationRequirements).toEqual(["PAYPAL_BUYER_APPROVAL_REQUIRED"]);
    expect(h.mock.calls.createOrder).toBe(1);
    await client.close();
  });
});
