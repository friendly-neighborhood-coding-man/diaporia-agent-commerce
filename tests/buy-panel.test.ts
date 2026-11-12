/**
 * DIAPORIA Buy panel (docs/BUY_PANEL.md): the browser shopping UI is an observer and interaction surface over the same
 * purchase session as the MCP tools. These tests drive the panel API like the browser does and check the invariants:
 * capability-bound access, server-side identity/price/payment status, unchanged owner and buyer approval, MOCK only.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createDemoWorldApp } from "../scripts/buy-panel/demo-app.js";
import type { App } from "../src/http/server.js";

const TOKEN = "dct_panel_test_token_0000000000000";
const RO_TOKEN = "dct_panel_readonly_token_000000000";
const OWNER = "dok_panel_owner_key_00000000000000";
const REQUEST = "wireless headphones under $150 with multipoint and a lanyard loop, lowest total price";
const DEST = { country: "US", region: "CA" };

interface H { app: App; url: string; clock: { offsetMs: number }; close(): Promise<void> }
const open: H[] = [];
afterEach(async () => { while (open.length) await open.pop()!.close(); });

async function port() {
  const p = createServer(); await new Promise<void>((r) => p.listen(0, "127.0.0.1", r));
  const n = (p.address() as AddressInfo).port; await new Promise<void>((r) => p.close(() => r())); return n;
}
async function start(dbPath = ":memory:", n?: number, researchDelayMs = 0): Promise<H> {
  const pt = n ?? await port(); const url = `http://127.0.0.1:${pt}`; const clock = { offsetMs: 0 };
  const { app } = createDemoWorldApp({ host: "127.0.0.1", port: pt, baseUrl: url, dbPath, userId: "alice", clientToken: TOKEN, ownerKey: OWNER, researchDelayMs, now: () => Date.now() + clock.offsetMs });
  // A second, research+read-only client of the same user (cannot prepare checkouts) and another user (bob).
  app.auth.addClientToken(RO_TOKEN, "alice", ["purchase.research", "purchase.read"]);
  app.auth.addClientToken("dct_bob_panel_token_00000000000000", "bob", ["purchase.research", "purchase.read", "purchase.prepare"]);
  await new Promise<void>((r) => app.server.listen(pt, "127.0.0.1", r));
  const h = { app, url, clock, close: () => new Promise<void>((r) => { app.server.close(() => r()); app.server.closeAllConnections(); }) };
  open.push(h); return h;
}
async function mcp(url: string, token = TOKEN) {
  const c = new Client({ name: "panel-test", version: "1" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  await c.listTools();
  return c;
}
async function tool(c: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const r = await c.callTool({ name, arguments: args });
  if (r.isError) throw new Error((r.content as Array<{ text: string }>)[0]!.text);
  return r.structuredContent;
}
function link(panelUrl: string) {
  const u = new URL(panelUrl); const p = new URLSearchParams(u.hash.slice(1));
  return { run: p.get("run")!, key: p.get("k")! };
}
async function api(h: H, l: { run: string; key: string }, path = "", body?: unknown, headers: Record<string, string> = {}) {
  // After a server restart on the same port the client may hold a pooled socket of the old server: retry once.
  const go = () => fetch(`${h.url}/buy/api/runs/${l.run}${path}`, { method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${l.key}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const r = await go().catch(go);
  return { status: r.status, body: await r.json() as any };
}
async function researched(h: H, token = TOKEN) {
  const c = await mcp(h.url, token);
  const out = await tool(c, "start_shopping_panel", { request: REQUEST, currency: "USD" });
  await h.app.panel!.settled(out.runId);
  await c.close();
  return { out, l: link(out.panelUrl) };
}
const form = (origin: string, body: Record<string, string>, cookie?: string) => ({ method: "POST", redirect: "manual" as const,
  headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: origin, ...(cookie ? { Cookie: cookie } : {}) }, body: new URLSearchParams(body).toString() });
/** The SIMULATED human owner on the existing owner page (owner key → review → preview → authorize). */
async function ownerAuthorizes(url: string, maximum: string) {
  const origin = new URL(url).origin;
  const r1 = await fetch(url, form(origin, { action: "review", ownerKey: OWNER })); const h1 = await r1.text();
  const cookie = r1.headers.get("set-cookie")!.split(";")[0]!; const csrf = /name="csrf" value="([^"]+)"/.exec(h1)![1]!;
  const r2 = await fetch(url, form(origin, { action: "preview", csrf, maximum }, cookie)); const h2 = await r2.text();
  const minor = /name="maximum_minor" value="(\d+)"/.exec(h2)![1]!;
  const r3 = await fetch(url, form(origin, { action: "authorize", csrf, maximum, maximum_minor: minor }, cookie));
  return { status: r3.status, location: r3.headers.get("location") };
}

describe("DIAPORIA Buy panel", () => {
  it("runs the whole MOCK slice: progress → three cards → detail → select → compare → prepare → owner + buyer approval → receipt", async () => {
    const h = await start();
    const c = await mcp(h.url);
    const tools = (await c.listTools()).tools.map((t) => t.name);
    expect(tools).toEqual(expect.arrayContaining(["start_shopping_panel", "open_shopping_panel", "get_shopping_panel"]));
    const out = await tool(c, "start_shopping_panel", { request: REQUEST, currency: "USD" });
    expect(out.state).toBe("RESEARCHING");
    expect(out.panelUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/buy\/#run=br_[0-9a-f-]{36}&k=dpl_/);
    expect(out.openIn.join(" ")).toMatch(/Codex Desktop/);
    const l = link(out.panelUrl);
    await h.app.panel!.settled(out.runId);

    const v1 = (await api(h, l)).body;
    expect(v1.runState).toBe("READY");
    expect(v1.view).toBe("RESULTS");
    expect(v1.paymentEnvironment).toBe("MOCK");
    expect(v1.progress.map((p: any) => p.step)).toEqual(expect.arrayContaining(["QUEUED", "SEARCH", "EVIDENCE", "DONE"]));
    expect(v1.candidates.length).toBeGreaterThan(0);
    expect(v1.candidates.length).toBeLessThanOrEqual(3);
    expect(v1.candidates.every((x: any) => x.status === "ELIGIBLE" || x.status === "NEEDS_VERIFICATION")).toBe(true);
    const top = v1.candidates[0];
    expect(top.title).toMatch(/Halden A8/);
    expect(top.status).toBe("ELIGIBLE");

    // The same purchase session is visible to the MCP side.
    const viaMcp = await tool(c, "get_shopping_panel", { runId: out.runId });
    expect(viaMcp.session.purchaseSessionId).toBe(v1.session.purchaseSessionId);

    const d = (await api(h, l, `/candidates/${encodeURIComponent(top.productId)}`)).body;
    expect(d.identity.brand).toBe("Halden");
    expect(d.validated.filter((x: any) => x.strength === "MUST" && x.status === "VERIFIED_TRUE").length).toBeGreaterThanOrEqual(2);
    expect(Array.isArray(d.unresolved)).toBe(true);

    expect((await api(h, l, "/compare", { destination: DEST })).body.error.code).toBe("INVALID_STATE");   // nothing selected yet
    const s = await api(h, l, "/select", { productId: top.productId });
    expect(s.status).toBe(200);
    expect(s.body.selection.productId).toBe(top.productId);
    const cmp = await api(h, l, "/compare", { destination: DEST });
    expect(cmp.status).toBe(200);
    expect(cmp.body.view).toBe("COMPARE");
    expect(cmp.body.comparison.state).toBe("OFFER_VERIFIED");
    const best = cmp.body.comparison.lowestVerifiedEligibleOffer;
    expect(best.cost.totalMinor).toBeGreaterThan(0);
    expect(cmp.body.comparison.ineligibleOffers.some((o: any) => /alpha-audi0/.test(o.merchantDomain))).toBe(true);   // look-alike rejected

    const ordersBefore = h.app.mockPayPal!.calls.createOrder;
    // A browser-supplied price, identity or status is ignored: only offerId is read.
    const p = await api(h, l, "/prepare", { offerId: best.offerId, totalMinor: 1, maximumApprovedTotalMinor: 1, productIdentity: { brand: "X", model: "Y" }, state: "COMPLETED" });
    expect(p.status).toBe(200);
    expect(p.body.view).toBe("CHECKOUT");
    const st = p.body.checkout.status;
    expect(st.state).toBe("APPROVAL_REQUIRED");
    expect(st.amount.totalMinor).toBe(best.cost.totalMinor);
    expect(p.body.checkout.handoff.kind).toBe("OWNER_AUTHORIZATION");
    expect(p.body.checkout.handoff.url).toBe(`${h.url}/authorize/${st.checkoutSessionId}`);
    expect(p.body.receipt).toBeNull();
    // No payment order without the owner's spending limit.
    expect(h.app.mockPayPal!.calls.createOrder).toBe(ordersBefore);
    // The panel cannot reach the owner step: the owner page still needs the owner key.
    expect((await fetch(p.body.checkout.handoff.url, form(h.url, { action: "review", ownerKey: l.key }))).status).toBe(401);

    const own = await ownerAuthorizes(p.body.checkout.handoff.url, (best.cost.totalMinor / 100).toFixed(2));
    expect(own.status).toBe(303);
    const v2 = (await api(h, l)).body;
    expect(v2.checkout.status.state).toBe("APPROVAL_REQUIRED");
    expect(v2.checkout.handoff.kind).toBe("BUYER_PAYMENT_APPROVAL");
    expect(v2.receipt).toBeNull();

    // The (MOCK) buyer step still needs the owner key; the panel capability is not accepted there.
    const orderId = new URL(v2.checkout.handoff.url).pathname.split("/").pop()!;
    const bad = await fetch(`${h.url}/mock-paypal/checkout/${orderId}/approve`, form(h.url, { owner_key: l.key }));
    expect(bad.status).toBe(401);
    const ok = await fetch(`${h.url}/mock-paypal/checkout/${orderId}/approve`, form(h.url, { owner_key: OWNER }));
    expect(ok.status).toBe(303);
    const ret = await fetch(ok.headers.get("location")!, { redirect: "manual" });
    expect(await ret.text()).toMatch(/href="\/buy\/"/);

    const v3 = (await api(h, l)).body;
    expect(v3.view).toBe("RECEIPT");
    expect(v3.checkout.status.state).toBe("COMPLETED");
    expect(v3.receipt.paymentResult.status).toBe("COMPLETED");
    expect(v3.receipt.merchantOrder.status).toBe("NOT_VERIFIED");
    expect(v3.receipt.paymentEnvironment).toBe("MOCK");
    await c.close();
  }, 60_000);

  it("server-enforced access: capability bound to one run, never another user's, origin checked, expiring", async () => {
    const h = await start();
    const a = await researched(h);
    const b = await researched(h);
    expect((await api(h, { run: a.l.run, key: "" })).status).toBe(401);
    expect((await api(h, { run: a.l.run, key: "dpl_" + "A".repeat(43) })).status).toBe(401);
    expect((await api(h, { run: a.l.run, key: b.l.key })).status).toBe(401);            // B's link cannot read A
    expect((await api(h, a.l, "", undefined, { Origin: "https://evil.example" })).status).toBe(403);
    expect((await api(h, a.l, "", undefined, { "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    expect((await api(h, a.l, "/select", { productId: "ch3:not-a-candidate" })).status).toBe(404);
    // Another user's MCP token cannot read the run.
    const bob = await mcp(h.url, "dct_bob_panel_token_00000000000000");
    const r = await bob.callTool({ name: "get_shopping_panel", arguments: { runId: a.out.runId } });
    expect(r.isError).toBe(true);
    // ...nor open a panel on alice's purchase session.
    const ps = (await api(h, a.l)).body.session.purchaseSessionId;
    expect((await bob.callTool({ name: "open_shopping_panel", arguments: { purchaseSessionId: ps } })).isError).toBe(true);
    await bob.close();
    // Links expire.
    h.clock.offsetMs = 3 * 60 * 60_000;
    expect((await api(h, a.l)).status).toBe(401);
  }, 60_000);

  it("a panel minted by a connection without the prepare scope cannot prepare; offers outside the verified comparison are refused", async () => {
    const h = await start();
    const ro = await researched(h, RO_TOKEN);
    const v = (await api(h, ro.l)).body;
    expect(v.capabilities.prepare).toBe(false);
    await api(h, ro.l, "/select", { productId: v.candidates[0].productId });
    const cmp = (await api(h, ro.l, "/compare", { destination: DEST })).body;
    const pr = await api(h, ro.l, "/prepare", { offerId: cmp.comparison.lowestVerifiedEligibleOffer.offerId });
    expect(pr.status).toBe(403);
    expect(pr.body.error.code).toBe("FORBIDDEN");

    const full = await researched(h);
    const fv = (await api(h, full.l)).body;
    await api(h, full.l, "/select", { productId: fv.candidates[0].productId });
    const fc = (await api(h, full.l, "/compare", { destination: DEST })).body;
    const rejected = fc.comparison.ineligibleOffers[0].offerId;
    expect((await api(h, full.l, "/prepare", { offerId: rejected })).body.error.code).toBe("OFFER_NOT_ELIGIBLE");
    expect((await api(h, full.l, "/prepare", { offerId: "offer-made-up" })).body.error.code).toBe("OFFER_NOT_ELIGIBLE");
    expect((await api(h, full.l, "/prepare", {})).status).toBe(400);
    // Wrong content type is refused (no form posts).
    const r = await fetch(`${h.url}/buy/api/runs/${full.l.run}/select`, { method: "POST", headers: { Authorization: `Bearer ${full.l.key}`, "Content-Type": "text/plain" }, body: "{}" });
    expect(r.status).toBe(415);
  }, 60_000);

  it("live updates: the event stream sends full snapshots; research progress is visible while it runs", async () => {
    const h = await start(":memory:", undefined, 40);
    const c = await mcp(h.url);
    const out = await tool(c, "start_shopping_panel", { request: REQUEST, currency: "USD" });
    const l = link(out.panelUrl);
    const ctrl = new AbortController();
    const r = await fetch(`${h.url}/buy/api/runs/${l.run}/events`, { headers: { Authorization: `Bearer ${l.key}` }, signal: ctrl.signal });
    expect(r.headers.get("content-type")).toMatch(/text\/event-stream/);
    const reader = r.body!.getReader(); const dec = new TextDecoder(); let buf = ""; const views: string[] = [];
    while (!views.includes("RESULTS")) {
      const x = await reader.read(); if (x.done) break;
      buf += dec.decode(x.value, { stream: true });
      for (const m of buf.matchAll(/event: snapshot\ndata: (.*)\n\n/g)) views.push(JSON.parse(m[1]!).view);
      buf = buf.slice(buf.lastIndexOf("\n\n") + 2);
    }
    ctrl.abort();
    expect(views[0]).toBe("PROGRESS");
    expect(views).toContain("RESULTS");
    // Without the capability the stream is refused.
    expect((await fetch(`${h.url}/buy/api/runs/${l.run}/events`)).status).toBe(401);
    await c.close();
  }, 60_000);

  it("resumes after a server restart; research cut by a restart is reported as interrupted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "buy-panel-"));
    const db = join(dir, "d.sqlite");
    const pt = await port();
    let h = await start(db, pt);
    const done = await researched(h);
    await api(h, done.l, "/select", { productId: (await api(h, done.l)).body.candidates[0].productId });
    const c = await mcp(h.url);
    const running = link((await tool(c, "start_shopping_panel", { request: REQUEST, currency: "USD" })).panelUrl);
    await c.close();
    await open.pop()!.close();
    h = await start(db, pt);
    const v = (await api(h, done.l)).body;
    expect(v.view).toBe("RESULTS");
    expect(v.selection.productId).toBe(v.candidates[0].productId);
    const i = (await api(h, running)).body;
    // Either research finished before the restart, or it is reported as interrupted (never left "running" forever).
    expect(["READY", "INTERRUPTED"]).toContain(i.runState);
  }, 60_000);

  it("serves one static frontend with a strict CSP and no secret in the page", async () => {
    const h = await start();
    const r = await fetch(`${h.url}/buy/`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-security-policy")).toMatch(/script-src 'self'/);
    const html = await r.text();
    expect(html).toMatch(/<script src="\/buy\/panel\.js"><\/script>/);
    expect(html).not.toMatch(/<script>/);
    const js = await (await fetch(`${h.url}/buy/panel.js`)).text();
    expect(js).not.toMatch(/\.innerHTML\s*=|insertAdjacentHTML|document\.write/);
    expect((await fetch(`${h.url}/buy`, { redirect: "manual" })).status).toBe(308);
  });
});
