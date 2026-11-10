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
