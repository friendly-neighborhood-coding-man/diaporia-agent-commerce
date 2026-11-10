/**
 * Regression tests for the security work packages WP-1..WP-5 (independent review of 759bd37, findings IR-01, IR-02,
 * IR-11, IR-09, IR-10). Every test runs in-process against a disposable MOCK app on 127.0.0.1 with ":memory:" or a
 * fresh temp SQLite file. No PayPal, no KERNEL, no Cloudflare, no network beyond loopback.
 *
 * These are the implementer's own tests. The reviewer's ATTACK/CONTROL probes live in
 * tests/security-review/independent-probes.test.ts and are not edited here.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OWNER, SONY_BLACK, TOKENS, buyer, call, mcpClient, researchAndCompare, startHarness, type Harness } from "./helpers.js";
import { startHandoffHarness } from "./handoff-helpers.js";
import { Store } from "../src/store/Database.js";
import { MandateRepository } from "../src/policy/PurchaseMandate.js";
import { MockCommerceResearchAdapter } from "../src/research/CommerceResearchAdapter.js";

/** The MOCK catalog with realistic merchant-quote latency, as in the reviewer's IR-02 probe. */
class SlowQuotes extends MockCommerceResearchAdapter {
  override async getQuote(...a: Parameters<MockCommerceResearchAdapter["getQuote"]>) { await new Promise((r) => setTimeout(r, 150)); return super.getQuote(...a); }
}

vi.setConfig({ testTimeout: 60_000 });
const open: Array<{ close(): Promise<void> }> = [];
const tmp: string[] = [];
afterEach(async () => { for (const h of open.splice(0)) await h.close().catch(() => {}); for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true }); });
async function harness(o: Parameters<typeof startHarness>[0] = {}) { const h = await startHarness(o); open.push(h); return h; }
function tempDb() { const d = mkdtempSync(join(tmpdir(), "diaporia-fix-")); tmp.push(d); return join(d, "fix.sqlite"); }
const prepareArgs = (ps: string) => ({ purchaseSessionId: ps, offerId: "off_alpha", maximumApprovedTotalMinor: 6000, currency: "USD", quantity: 1 });
/** Raw owner-API mandate creation: exactly the body given (no helper default). */
async function rawMandate(url: string, body: Record<string, unknown>, ownerKey = OWNER.alice) {
  const r = await fetch(`${url}/owner/mandates`, { method: "POST", headers: { "Content-Type": "application/json", "X-Owner-Key": ownerKey }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() as any };
}
const formPost = (body: Record<string, string>, headers: Record<string, string> = {}) => ({ method: "POST", redirect: "manual" as const,
  headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(body).toString() });
const orderOf = (approvalUrl: string) => new URL(approvalUrl).pathname.split("/").pop()!;
function audit(h: Harness, subjectId: string): Array<{ type: string; data: any }> {
  return (h.app.store.db.prepare("SELECT type, data_json FROM audit_events WHERE subject_id = ? ORDER BY seq").all(subjectId) as Array<{ type: string; data_json: string }>)
    .map((r) => ({ type: r.type, data: JSON.parse(r.data_json) }));
}
/** An auto-use mandate (the pre-WP-1 automatic flow), then prepare: APPROVAL_REQUIRED with a provider order. */
async function autoPrepared(h: Harness) {
  expect((await rawMandate(h.url, { productIdentity: SONY_BLACK, currency: "USD", maximumTotalMinor: 6000, autoUse: true })).status).toBe(201);
  const ai = await mcpClient(h.url, TOKENS.alice);
  const { research } = await researchAndCompare(ai);
  const p = await call(ai, "prepare_checkout", prepareArgs(research.purchaseSessionId));
  expect(p.state).toBe("APPROVAL_REQUIRED"); expect(p.approvalUrl).toBeTruthy();
  return { ai, p };
}

describe("WP-1 (IR-01): no purchase completes without a human step", () => {
  it("the MOCK buyer approve/cancel needs the checkout owner's key on a strict same-origin POST", async () => {
    const h = await harness();
    const { ai, p } = await autoPrepared(h);
    const u = `${h.url}/mock-paypal/checkout/${orderOf(p.approvalUrl)}/approve`;
    // The IR-01 reproduction: a bare POST (no key, no cookie, no Origin).
    expect((await fetch(u, { method: "POST", redirect: "manual" })).status).toBe(403);
    // Same-origin but no owner key, then the wrong owner's key, then the right key from a cross-site page.
    expect((await fetch(u, formPost({}, { Origin: h.url }))).status).toBe(401);
    expect((await fetch(u, formPost({ owner_key: "dok_not_a_real_owner_key_000000000" }, { Origin: h.url }))).status).toBe(401);
    expect((await fetch(u, formPost({ owner_key: OWNER.bob }, { Origin: h.url }))).status).toBe(403);
    expect((await fetch(u, formPost({ owner_key: OWNER.alice }, { Origin: "http://evil.example" }))).status).toBe(403);
    expect((await fetch(u, formPost({ owner_key: OWNER.alice }))).status).toBe(403);                         // key alone, no browser origin signal
    expect((await fetch(u, formPost({ owner_key: OWNER.alice }, { Origin: "null" }))).status).toBe(403);
    expect((await fetch(u, formPost({ owner_key: OWNER.alice }, { Origin: h.url, "Sec-Fetch-Site": "cross-site" }))).status).toBe(403);
    expect((await call(ai, "get_checkout_status", { checkoutSessionId: p.checkoutSessionId })).state).toBe("APPROVAL_REQUIRED");
    expect(h.mock.describe(orderOf(p.approvalUrl))!.status).toBe("CREATED");                                 // nothing was approved
    // The owner (human) does it: works, with Sec-Fetch-Site alone as the browser's same-origin signal.
    const ok = await fetch(u, formPost({ owner_key: OWNER.alice }, { "Sec-Fetch-Site": "same-origin" }));
    expect(ok.status).toBe(303);
    await fetch(ok.headers.get("location")!, { redirect: "manual" });
    expect((await call(ai, "get_checkout_status", { checkoutSessionId: p.checkoutSessionId })).state).toBe("COMPLETED");
    await ai.close();
  });

  it("the MOCK page asks for the owner key and says it is MOCK; cancel is gated the same way", async () => {
    const h = await harness();
    const { ai, p } = await autoPrepared(h);
    const page = await (await fetch(p.approvalUrl)).text();
    expect(page).toContain('name="owner_key"'); expect(page).toContain("MOCK");
    const c = `${h.url}/mock-paypal/checkout/${orderOf(p.approvalUrl)}/cancel`;
    expect((await fetch(c, { method: "POST", redirect: "manual" })).status).toBe(403);
    expect((await fetch(c, formPost({ owner_key: OWNER.bob }, { Origin: h.url }))).status).toBe(403);
    const r = await buyer(h, p.approvalUrl, "cancel");
    expect(r.returnStatus).toBe(200);
    expect((await call(ai, "get_checkout_status", { checkoutSessionId: p.checkoutSessionId })).state).toBe("CANCELLED");
    await ai.close();
  });

  it("a REUSABLE mandate is NOT used automatically by default: prepare goes to APPROVAL_REQUIRED, reserves nothing, creates no order", async () => {
    const h = await harness();
    const m = await rawMandate(h.url, { productIdentity: SONY_BLACK, currency: "USD", maximumTotalMinor: 6000 });
    expect(m.status).toBe(201); expect(m.body.scope).toBe("REUSABLE"); expect(m.body.autoUse).toBe(false);
    const ai = await mcpClient(h.url, TOKENS.alice);
    const { research } = await researchAndCompare(ai);
    const p = await call(ai, "prepare_checkout", prepareArgs(research.purchaseSessionId));
    expect(p.state).toBe("APPROVAL_REQUIRED");
    expect(p.approvalUrl).toBeNull();
    expect(p.userAuthorizationUrl).toContain(`/authorize/${p.checkoutSessionId}`);
    expect(h.mock.calls.createOrder).toBe(0);
    const row = h.app.store.db.prepare("SELECT reserved_minor, transactions_used FROM mandates WHERE id = ?").get(m.body.mandateId) as any;
    expect(row).toEqual({ reserved_minor: 0, transactions_used: 0 });
    const ev = audit(h, p.checkoutSessionId);
    expect(ev.map((e) => e.type)).not.toContain("MANDATE_RESERVED");
    expect(ev.find((e) => e.type === "OWNER_AUTHORIZATION_REQUIRED")!.data.reason).toBe("REUSABLE_MANDATE_NOT_AUTO_USE");
    await ai.close();
  });

  it("with autoUse=true the owner-approved automatic flow still works (still needs the human MOCK buyer step)", async () => {
    const h = await harness();
    const { ai, p } = await autoPrepared(h);
    expect(h.mock.calls.createOrder).toBe(1);
    await buyer(h, p.approvalUrl);
    expect((await call(ai, "get_checkout_status", { checkoutSessionId: p.checkoutSessionId })).state).toBe("COMPLETED");
    await ai.close();
  });

  it("autoUse must be a boolean, and only reusable owner-API mandates may carry it", async () => {
    const h = await harness();
    for (const autoUse of ["true", 1, null]) expect((await rawMandate(h.url, { productIdentity: SONY_BLACK, currency: "USD", maximumTotalMinor: 6000, autoUse })).status).toBe(400);
    const repo = new MandateRepository(h.app.store);
    expect(() => repo.create({ userId: "alice", productIdentity: SONY_BLACK, currency: "USD", maximumTotalMinor: 6000, createdVia: "OWNER_APPROVAL_PAGE",
      boundCheckoutSessionId: "cs_00000000-0000-0000-0000-000000000000", autoUse: true })).toThrow(/autoUse/);
  });

  it("migration is additive and fails safe: an existing REUSABLE mandate row gets autoUse=false", () => {
    const db = tempDb();
    const s1 = new Store(db);
    s1.db.exec("ALTER TABLE mandates DROP COLUMN auto_use");                       // a database from before WP-1
    s1.db.prepare(`INSERT INTO mandates(id,user_id,identity_json,currency,max_total_minor,max_quantity,max_transactions,expires_at,merchant_constraints_json,status,created_via,created_at)
      VALUES ('mdt_legacy','alice',?,'USD',6000,1,1,?,'{"allowedMerchantIds":null}','ACTIVE','OWNER_API',?)`).run(JSON.stringify(SONY_BLACK), Date.now() + 3600_000, Date.now());
    s1.close();
    const s2 = new Store(db);
    const m = new MandateRepository(s2).get("mdt_legacy", "alice")!;
    expect(m.scope).toBe("REUSABLE"); expect(m.autoUse).toBe(false);
    s2.close();
  });

  it("state-changing browser form routes refuse a POST with neither Origin nor Sec-Fetch-Site (strict); /authorize refuses cross-site browser signals", async () => {
    const h = await harness({ authMode: "oauth" });
    // OAuth consent (owner key in the form): strict.
    expect((await fetch(`${h.url}/oauth/authorize`, formPost({ request_id: "x", csrf: "y", decision: "approve", owner_key: OWNER.alice }))).status).toBe(403);
    expect((await fetch(`${h.url}/oauth/authorize`, formPost({ request_id: "x", csrf: "y", decision: "approve", owner_key: OWNER.alice }, { Origin: h.url }))).status).toBe(400);
    // /authorize: any request a browser marks cross-site is refused, before the owner key is even looked at.
    const cs = `${h.url}/authorize/cs_00000000-0000-0000-0000-000000000000`;
    expect((await fetch(cs, formPost({ action: "review", ownerKey: OWNER.alice }, { Origin: "http://evil.example" }))).status).toBe(403);
    expect((await fetch(cs, formPost({ action: "review", ownerKey: OWNER.alice }, { Origin: "null" }))).status).toBe(403);
    expect((await fetch(cs, formPost({ action: "review", ownerKey: OWNER.alice }, { "Sec-Fetch-Site": "cross-site" }))).status).toBe(403);
    expect((await fetch(cs, formPost({ action: "review", ownerKey: OWNER.alice }, { Origin: h.url, "Sec-Fetch-Site": "same-site" }))).status).toBe(403);
    expect((await fetch(cs, formPost({ action: "review", ownerKey: OWNER.alice }, { Origin: h.url }))).status).toBe(404);   // allowed through; unknown checkout
    // Header-authenticated owner API keeps the lenient check (non-browser clients send no Origin).
    expect((await rawMandate(h.url, { productIdentity: SONY_BLACK, currency: "USD", maximumTotalMinor: 6000 })).status).toBe(201);
  });

  it("the handoff page POST is strict too", async () => {
    const h = await startHandoffHarness(); open.push(h);
    const u = `${h.url}/handoff/ho_00000000-0000-0000-0000-000000000000`;
    expect((await fetch(u, formPost({ action: "review", ownerKey: OWNER.alice }))).status).toBe(403);
    expect((await fetch(u, formPost({ action: "review", ownerKey: OWNER.alice }, { Origin: h.url }))).status).toBe(404);
    expect((await fetch(u, formPost({ action: "review", ownerKey: OWNER.alice }, { "Sec-Fetch-Site": "same-origin" }))).status).toBe(404);
  });

  it("provenance: each step toward capture records who caused it, never a raw token or key", async () => {
    const h = await harness();
    const ai = await mcpClient(h.url, TOKENS.alice);
    const { research } = await researchAndCompare(ai);
    const p = await call(ai, "prepare_checkout", prepareArgs(research.purchaseSessionId));   // no mandate: owner page
    const rv = await fetch(p.userAuthorizationUrl, formPost({ action: "review", ownerKey: OWNER.alice }, { Origin: h.url }));
    const cookie = rv.headers.get("set-cookie")!.split(";")[0]!; const csrf = /name="csrf" value="([^"]+)"/.exec(await rv.text())![1]!;
    const a = await fetch(p.userAuthorizationUrl, formPost({ action: "authorize", csrf, maximum: "60.00" }, { Origin: h.url, Cookie: cookie }));
    expect(a.status).toBe(303);
    await buyer(h, a.headers.get("location")!);
    expect((await call(ai, "get_checkout_status", { checkoutSessionId: p.checkoutSessionId })).state).toBe("COMPLETED");
    const ev = audit(h, p.checkoutSessionId);
    const actorOf = (t: string) => ev.find((e) => e.type === t)?.data.actor;
    expect(actorOf("CHECKOUT_PREPARED")).toMatch(/^MCP_TOKEN:[0-9a-f]{12}$/);
    expect(actorOf("MANDATE_CREATED_BY_OWNER")).toBe("OWNER_SESSION:alice");
    expect(actorOf("MANDATE_RESERVED")).toBe("OWNER_SESSION:alice");
    expect(actorOf("PROVIDER_ORDER_CREATED")).toBe("OWNER_SESSION:alice");
    expect(actorOf("MOCK_BUYER_APPROVED")).toBe("OWNER_SESSION:alice");
    expect(actorOf("BUYER_RETURNED")).toBe("PROVIDER_RETURN");
    expect(actorOf("CAPTURE_REQUESTED")).toBe("PROVIDER_RETURN");
    expect(actorOf("PAYMENT_COMPLETED_VERIFIED")).toBe("PROVIDER_RETURN");
    const all = JSON.stringify(h.app.store.db.prepare("SELECT data_json FROM audit_events").all());
    for (const secret of [TOKENS.alice, OWNER.alice, OWNER.bob]) expect(all).not.toContain(secret);
    await ai.close();
  });

  it("provenance: an automatic (autoUse) reservation is attributed to the MCP token, and reconcile to RECONCILE", async () => {
    const h = await harness();
    expect((await rawMandate(h.url, { productIdentity: SONY_BLACK, currency: "USD", maximumTotalMinor: 6000, autoUse: true })).status).toBe(201);
    const ai = await mcpClient(h.url, TOKENS.alice);
    const { research } = await researchAndCompare(ai);
    h.mock.createOutcomes.push("TIMEOUT_AFTER_CREATE");
    const p = await call(ai, "prepare_checkout", prepareArgs(research.purchaseSessionId));
    expect(p.state).toBe("UNKNOWN");
    await fetch(`${h.url}/owner/checkouts/${p.checkoutSessionId}/reconcile`, { method: "POST", headers: { "X-Owner-Key": OWNER.alice } });
    const ev = audit(h, p.checkoutSessionId);
    expect(ev.find((e) => e.type === "MANDATE_RESERVED")!.data.actor).toMatch(/^MCP_TOKEN:[0-9a-f]{12}$/);
    expect(ev.find((e) => e.type === "PROVIDER_ORDER_RECOVERED")!.data.actor).toBe("RECONCILE");
    await ai.close();
  });
});

describe("WP-2 (IR-02): one purchase session pays at most once, under concurrency", () => {
  const liveCheckouts = (h: Harness, ps: string) => (h.app.store.db.prepare("SELECT count(*) n FROM checkout_sessions WHERE purchase_session_id = ?").get(ps) as any).n as number;

  it("concurrent identical prepare_checkout (slow quotes): one checkout, one createOrder, one reservation; the loser is deduplicated", async () => {
    const h = await harness({ research: new SlowQuotes() });
    const m = await rawMandate(h.url, { productIdentity: SONY_BLACK, currency: "USD", maximumTotalMinor: 12000, maximumTransactions: 2, autoUse: true });
    const a = await mcpClient(h.url, TOKENS.alice); const b = await mcpClient(h.url, TOKENS.alice);
    const { research } = await researchAndCompare(a);
    const [p1, p2] = await Promise.all([call(a, "prepare_checkout", prepareArgs(research.purchaseSessionId)), call(b, "prepare_checkout", prepareArgs(research.purchaseSessionId))]);
    expect(p1.checkoutSessionId).toBe(p2.checkoutSessionId);
    expect([p1.deduplicated, p2.deduplicated].sort()).toEqual([false, true]);
    expect(liveCheckouts(h, research.purchaseSessionId)).toBe(1);
    expect(h.mock.calls.createOrder).toBe(1);
    const row = h.app.store.db.prepare("SELECT reserved_minor, transactions_used FROM mandates WHERE id = ?").get(m.body.mandateId) as any;
    expect(row.transactions_used).toBe(1); expect(row.reserved_minor).toBe(p1.purchaseSummary.totalMinor);
    const winner = [p1, p2].find((p) => !p.deduplicated)!;
    await buyer(h, winner.approvalUrl);
    expect((await call(a, "get_checkout_status", { checkoutSessionId: winner.checkoutSessionId })).state).toBe("COMPLETED");
    // After completion an identical prepare returns the completed checkout; still one order.
    const again = await call(b, "prepare_checkout", prepareArgs(research.purchaseSessionId));
    expect(again.checkoutSessionId).toBe(winner.checkoutSessionId); expect(again.deduplicated).toBe(true);
    expect(h.mock.calls.createOrder).toBe(1);
    await a.close(); await b.close();
  });

  it("five concurrent identical prepares still give exactly one checkout and one provider order", async () => {
    const h = await harness({ research: new SlowQuotes() });
    await rawMandate(h.url, { productIdentity: SONY_BLACK, currency: "USD", maximumTotalMinor: 30000, maximumTransactions: 5, autoUse: true });
    const clients = await Promise.all([1, 2, 3, 4, 5].map(() => mcpClient(h.url, TOKENS.alice)));
    const { research } = await researchAndCompare(clients[0]!);
    const out = await Promise.all(clients.map((c) => call(c, "prepare_checkout", prepareArgs(research.purchaseSessionId))));
    expect(new Set(out.map((p) => p.checkoutSessionId)).size).toBe(1);
    expect(out.filter((p) => !p.deduplicated)).toHaveLength(1);
    expect(h.mock.calls.createOrder).toBe(1);
    for (const c of clients) await c.close();
  });

  it("two server processes on ONE SQLite file: concurrent identical prepares create one checkout and one provider order in total", async () => {
    const dbPath = tempDb();
    const h1 = await harness({ dbPath, research: new SlowQuotes() }); const h2 = await harness({ dbPath, research: new SlowQuotes() });
    await rawMandate(h1.url, { productIdentity: SONY_BLACK, currency: "USD", maximumTotalMinor: 12000, maximumTransactions: 2, autoUse: true });
    const a = await mcpClient(h1.url, TOKENS.alice); const b = await mcpClient(h2.url, TOKENS.alice);
    const { research } = await researchAndCompare(a);
    const [p1, p2] = await Promise.all([call(a, "prepare_checkout", prepareArgs(research.purchaseSessionId)), call(b, "prepare_checkout", prepareArgs(research.purchaseSessionId))]);
    expect(p1.checkoutSessionId).toBe(p2.checkoutSessionId);
    expect([p1.deduplicated, p2.deduplicated].sort()).toEqual([false, true]);
    expect(liveCheckouts(h1, research.purchaseSessionId)).toBe(1);
    expect(h1.mock.calls.createOrder + h2.mock.calls.createOrder).toBe(1);
    await a.close(); await b.close();
  });

  it("the database refuses a second live checkout for the same (user, session, offer, quantity), and allows one after a terminal state", async () => {
    const h = await harness();
    const ai = await mcpClient(h.url, TOKENS.alice);
    const { research } = await researchAndCompare(ai);
    const p = await call(ai, "prepare_checkout", prepareArgs(research.purchaseSessionId));   // no mandate: APPROVAL_REQUIRED
    const db = h.app.store.db;
    const cols = "id,user_id,purchase_session_id,offer_id,merchant_id,quote_id,identity_json,quantity,currency,cost_json,total_minor,client_max_minor,summary_json,summary_hash,state,provider,create_key,capture_key,expires_at,created_at,updated_at";
    const copy = (id: string, state: string) => db.prepare(`INSERT INTO checkout_sessions(${cols}) SELECT ?,user_id,purchase_session_id,offer_id,merchant_id,quote_id,identity_json,quantity,currency,cost_json,total_minor,client_max_minor,summary_json,summary_hash,?,provider,?,?,expires_at,created_at,updated_at FROM checkout_sessions WHERE id = ?`)
      .run(id, state, `k-${id}`, `c-${id}`, p.checkoutSessionId);
    for (const state of ["PREPARED", "HOLD", "APPROVAL_REQUIRED", "APPROVED", "CAPTURE_PENDING", "UNKNOWN", "COMPLETED"])
      expect(() => copy(`cs_dup_${state}`, state)).toThrow(/UNIQUE constraint failed/);
    for (const state of ["CANCELLED", "FAILED", "EXPIRED", "REFUNDED"]) expect(() => copy(`cs_ok_${state}`, state)).not.toThrow();
    // A terminal non-completed checkout allows a new attempt through the tool as well.
    expect((await fetch(`${h.url}/owner/checkouts/${p.checkoutSessionId}/cancel`, { method: "POST", headers: { "X-Owner-Key": OWNER.alice } })).status).toBe(200);
    const p2 = await call(ai, "prepare_checkout", prepareArgs(research.purchaseSessionId));
    expect(p2.checkoutSessionId).not.toBe(p.checkoutSessionId); expect(p2.deduplicated).toBe(false);
    await ai.close();
  });
});

describe("WP-3 (IR-11): reconcile never replays create-order after expiry or outside the idempotency window", () => {
  async function timedOut(h: Harness) {
    const m = await rawMandate(h.url, { productIdentity: SONY_BLACK, currency: "USD", maximumTotalMinor: 6000, autoUse: true });
    const ai = await mcpClient(h.url, TOKENS.alice);
    const { research } = await researchAndCompare(ai);
    h.mock.createOutcomes.push("TIMEOUT_AFTER_CREATE");
    const p = await call(ai, "prepare_checkout", prepareArgs(research.purchaseSessionId));
    expect(p.state).toBe("UNKNOWN");
    await ai.close();
    return { p, mandateId: m.body.mandateId as string };
  }
  const reconcile = (h: Harness, cs: string) => fetch(`${h.url}/owner/checkouts/${cs}/reconcile`, { method: "POST", headers: { "X-Owner-Key": OWNER.alice } });
  const row = (h: Harness, cs: string) => h.app.store.db.prepare("SELECT state, provider_order_id, failure_code, failure_reason, reserved_minor, create_requested_at, created_at FROM checkout_sessions WHERE id = ?").get(cs) as any;
  const reserved = (h: Harness, m: string) => (h.app.store.db.prepare("SELECT reserved_minor FROM mandates WHERE id = ?").get(m) as any).reserved_minor as number;

  it("the create attempt time is stored durably before the provider call", async () => {
    const h = await harness();
    const before = Date.now();
    const { p } = await timedOut(h);
    const r = row(h, p.checkoutSessionId);
    expect(r.create_requested_at).toBeGreaterThanOrEqual(before);
    expect(r.create_requested_at).toBeGreaterThanOrEqual(r.created_at);
  });

  it("an expired UNKNOWN create-timeout checkout + owner reconcile: no createOrder, stays UNKNOWN, reservation kept, audited", async () => {
    const h = await harness();
    const { p, mandateId } = await timedOut(h);
    const held = reserved(h, mandateId);
    expect(held).toBeGreaterThan(0);
    h.clock.offsetMs += 16 * 60_000;                                       // past the 15-minute checkout expiry
    const before = h.mock.calls.createOrder;
    expect((await reconcile(h, p.checkoutSessionId)).status).toBe(200);
    expect((await reconcile(h, p.checkoutSessionId)).status).toBe(200);   // repeated reconcile: still nothing
    expect(h.mock.calls.createOrder).toBe(before);
    const r = row(h, p.checkoutSessionId);
    expect(r.state).toBe("UNKNOWN"); expect(r.provider_order_id).toBeNull(); expect(r.failure_code).toBe("CREATE_ORDER_TIMEOUT");
    expect(r.failure_reason).toMatch(/outside the safe replay window/);
    expect(reserved(h, mandateId)).toBe(held);
    const skipped = audit(h, p.checkoutSessionId).filter((e) => e.type === "RECOVER_CREATE_SKIPPED");
    expect(skipped.length).toBe(2); expect(skipped[0]!.data.reason).toBe("CHECKOUT_EXPIRED");
  });

  it("a non-expired checkout inside the window still recovers by idempotent replay", async () => {
    const h = await harness();
    const { p } = await timedOut(h);
    h.clock.offsetMs += 60_000;
    const before = h.mock.calls.createOrder;
    await reconcile(h, p.checkoutSessionId);
    expect(h.mock.calls.createOrder).toBe(before + 1);
    expect(row(h, p.checkoutSessionId).provider_order_id).toMatch(/^MOCK/);
    expect(audit(h, p.checkoutSessionId).map((e) => e.type)).toContain("PROVIDER_ORDER_RECOVERED");
  });

  it("an attempt older than 5 h is never replayed, even when the checkout itself has not expired", async () => {
    const h = await harness();
    const { p, mandateId } = await timedOut(h);
    h.app.store.db.prepare("UPDATE checkout_sessions SET expires_at = ? WHERE id = ?").run(Date.now() + 24 * 3600_000, p.checkoutSessionId);
    h.clock.offsetMs += 5 * 3600_000 + 60_000;
    const before = h.mock.calls.createOrder; const held = reserved(h, mandateId);
    await reconcile(h, p.checkoutSessionId);
    expect(h.mock.calls.createOrder).toBe(before);
    expect(row(h, p.checkoutSessionId).state).toBe("UNKNOWN"); expect(reserved(h, mandateId)).toBe(held);
    expect(audit(h, p.checkoutSessionId).find((e) => e.type === "RECOVER_CREATE_SKIPPED")!.data.reason).toBe("OUTSIDE_SAFE_REPLAY_WINDOW");
  });

  it("a row from before create_requested_at existed falls back to createdAt", async () => {
    const h = await harness();
    const { p } = await timedOut(h);
    h.app.store.db.prepare("UPDATE checkout_sessions SET expires_at = ?, create_requested_at = NULL WHERE id = ?").run(Date.now() + 24 * 3600_000, p.checkoutSessionId);
    h.clock.offsetMs += 5 * 3600_000 + 60_000;
    const before = h.mock.calls.createOrder;
    await reconcile(h, p.checkoutSessionId);
    expect(h.mock.calls.createOrder).toBe(before);
    expect(audit(h, p.checkoutSessionId).find((e) => e.type === "RECOVER_CREATE_SKIPPED")!.data.createRequestedAt).toBe(row(h, p.checkoutSessionId).created_at);
  });

  it("the gateway reconcile entry point (also used by a buyer return to an UNKNOWN checkout) does not replay after expiry either", async () => {
    const h = await harness();
    const { p } = await timedOut(h);
    h.clock.offsetMs += 16 * 60_000;
    const before = h.mock.calls.createOrder;
    await h.app.gateway.reconcile("alice", p.checkoutSessionId);
    expect(h.mock.calls.createOrder).toBe(before);
  });
});
