/** Evidence Router, Usage Ledger, community/managed separation and mock service billing. ALL MOCK. */
import { afterEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store/Database.js";
import { UsageLedger, UsageLimitError, PLACEHOLDER_PRICING } from "../src/metering/UsageLedger.js";
import { EvidenceRouter } from "../src/evidence/EvidenceRouter.js";
import { MockKernelInspector, MockTavilySearch, TavilySearch } from "../src/evidence/providers.js";
import { MockPayPalBillingProvider } from "../src/billing/Billing.js";
import type { ServicePlane } from "../src/engine/ServicePlane.js";
import { call, callError, CA, createMandate, mcpClient, OWNER, SONY_BLACK, startHarness, TOKENS, type Harness } from "./helpers.js";

const SECRET = "mock-billing-webhook-secret-0001";
function plane(mode: "community" | "managed", over: { limits?: ConstructorParameters<typeof UsageLedger>[2]; path?: string; tavily?: MockTavilySearch } = {}) {
  const store = new Store(over.path ?? ":memory:");
  const ledger = new UsageLedger(store, PLACEHOLDER_PRICING, over.limits ?? { perRequestSupplierMicro: 200_000, monthlyBillableMinor: 500 });
  const tavily = over.tavily ?? new MockTavilySearch(); const kernel = new MockKernelInspector();
  const billing = new MockPayPalBillingProvider(store, SECRET);
  const svc: ServicePlane = { mode, ledger, router: new EvidenceRouter(store, ledger, tavily, kernel, { billable: mode === "managed" }), billing: mode === "managed" ? billing : null, managedSimulation: mode === "managed" };
  return { svc, store, ledger, tavily, kernel, billing };
}
const hs: Harness[] = []; const dirs: string[] = [];
afterEach(async () => { for (const h of hs.splice(0)) await h.close().catch(() => {}); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
async function server(svc: ServicePlane, over: Parameters<typeof startHarness>[0] = {}) { const h = await startHarness({ service: svc, ...over }); hs.push(h); return h; }
const DISCOVERY = { request: "Find good headphones under $100", mustHave: ["active_noise_cancellation"], currency: "USD" };

describe("Evidence Router (deterministic, explicit sufficiency)", () => {
  it("verifies only what is insufficient: manufacturer evidence → no calls; listing claim → Tavily, then KERNEL only for the page that needs it", async () => {
    const p = plane("community");
    const h = await server(p.svc);
    const c = await mcpClient(h.url, TOKENS.alice);
    const r = await call(c, "research_purchase", DISCOVERY);
    const by = Object.fromEntries(r.candidates.map((x: any) => [x.productId, x]));
    expect(by.prd_sony_whch720n_black.evidenceRouting).toEqual([]);           // manufacturer claim: nothing routed
    expect(by.prd_lumen_q3.suitability).toBe("SUITABLE");                      // was NEEDS_VERIFICATION
    const steps = by.prd_lumen_q3.evidenceRouting[0].steps.map((s: any) => `${s.provider}:${s.action}`);
    expect(steps).toEqual(["TAVILY:CALLED", "KERNEL:CALLED"]);
    expect(by.prd_lumen_q3.mustHave[0].evidence.kind).toBe("INDEPENDENT_REVIEW");
    // Contoso has no ANC evidence at all, so it is searched too (no results → stays unverified).
    expect(by.prd_contoso_studio.evidenceRouting[0]).toMatchObject({ sufficiency: "INSUFFICIENT" });
    expect(p.tavily.calls).toBe(2); expect(p.kernel.calls).toBe(1);
    // A second identical request reuses stored evidence: no new provider calls.
    const r2 = await call(c, "research_purchase", DISCOVERY);
    expect(r2.candidates.find((x: any) => x.productId === "prd_lumen_q3").suitability).toBe("SUITABLE");
    expect(r2.candidates.find((x: any) => x.productId === "prd_contoso_studio").evidenceRouting[0].steps[0].action).toBe("REUSED_CACHED_QUERY");
    expect(p.tavily.calls).toBe(2); expect(p.kernel.calls).toBe(1);
    await c.close();
  });

  it("judge(): one independent source is not enough; two distinct hosts are; disagreement is CONTRADICTED", () => {
    const claim = (url: string, value: boolean, kind: "INDEPENDENT_REVIEW" | "MANUFACTURER" = "INDEPENDENT_REVIEW") => ({ capability: "x", value, source: { kind, url, title: "", retrievedAt: "" } });
    expect(EvidenceRouter.judge([claim("https://a.example/1", true)])).toBe("INSUFFICIENT");
    expect(EvidenceRouter.judge([claim("https://a.example/1", true), claim("https://a.example/2", true)])).toBe("INSUFFICIENT"); // same host
    expect(EvidenceRouter.judge([claim("https://a.example/1", true), claim("https://b.example/1", true)])).toBe("SUFFICIENT_TRUE");
    expect(EvidenceRouter.judge([claim("https://m.example", false, "MANUFACTURER"), claim("https://b.example/1", true)])).toBe("CONTRADICTED");
  });

  it("a cost limit never makes verification optional; provider timeouts are recorded as failed, not billed", async () => {
    const tight = plane("community", { limits: { perRequestSupplierMicro: 3_000, monthlyBillableMinor: 500 } }); // allows discovery (2,000) only
    const h = await server(tight.svc);
    const c = await mcpClient(h.url, TOKENS.alice);
    const r = await call(c, "research_purchase", DISCOVERY);
    const lumen = r.candidates.find((x: any) => x.productId === "prd_lumen_q3");
    expect(lumen.suitability).toBe("NEEDS_VERIFICATION");
    expect(lumen.evidenceRouting[0]).toMatchObject({ reason: "VERIFICATION_REQUIRED_BUT_LIMIT_REACHED", steps: [{ provider: "TAVILY", action: "BLOCKED_BY_LIMIT" }] });
    expect(r.unknowns.join(" ")).toMatch(/verification was not skipped/);
    expect(tight.tavily.calls).toBe(0);

    const flaky = plane("community"); flaky.tavily.failNext = 1;
    const h2 = await server(flaky.svc);
    const c2 = await mcpClient(h2.url, TOKENS.alice);
    const r2 = await call(c2, "research_purchase", DISCOVERY);
    expect(r2.candidates.find((x: any) => x.productId === "prd_lumen_q3").suitability).toBe("NEEDS_VERIFICATION");
    const failed = r2.usage.records.find((u: any) => u.provider === "TAVILY");
    expect(failed).toMatchObject({ status: "FAILED", billableMinor: 0 });
    await c.close(); await c2.close();
  });
});

describe("Usage Ledger (integer accounting)", () => {
  it("bills one logical operation once across duplicates and retries; supplier attempts are tracked separately", () => {
    const { ledger } = plane("managed");
    const op = { userId: "alice", requestId: "req1", provider: "TAVILY" as const, operation: "search", logicalKey: "tavily:q1", quantity: 1, unit: "search", provenance: "MOCK" as const, billable: true };
    const a = ledger.begin(op); ledger.complete(a.record.id, { success: false, failureReason: "timeout" });
    const b = ledger.begin(op); expect(b.reuse).toBe(false); expect(b.record.attempts).toBe(2);
    const done = ledger.complete(b.record.id, { success: true });
    expect(done).toMatchObject({ status: "SUCCEEDED", attempts: 2, estSupplierMicro: 16_000, billableMinor: 2 });
    const dup = ledger.begin(op); expect(dup.reuse).toBe(true);
    ledger.complete(done.id, { success: true }); // idempotent
    const s = ledger.summary("alice");
    expect(s.totals).toMatchObject({ billableMinor: 2, estimatedSupplierMicroUsd: 16_000 });
    expect(Number.isInteger(s.totals.estimatedSupplierMicroUsd)).toBe(true);
    expect(done.finalSupplierMicro).toBeNull(); // an estimate is not an invoice
    ledger.reconcileSupplierCost(done.id, 15_500);
    expect(ledger.summary("alice").lines[0]).toMatchObject({ reconciledRecords: 1, reconciledSupplierMicroUsd: 15_500 });
  });

  it("enforces per-request supplier caps and monthly billable caps before any provider call", () => {
    const { ledger } = plane("managed", { limits: { perRequestSupplierMicro: 20_000, monthlyBillableMinor: 4 } });
    const op = (k: string, req = "r1") => ({ userId: "alice", requestId: req, provider: "TAVILY" as const, operation: "search", logicalKey: k, quantity: 1, unit: "search", provenance: "MOCK" as const, billable: true });
    ledger.complete(ledger.begin(op("a")).record.id, { success: true });
    ledger.complete(ledger.begin(op("b")).record.id, { success: true });
    expect(() => ledger.begin(op("c"))).toThrow(UsageLimitError); // 24,000 > 20,000 per request
    expect(() => ledger.begin(op("d", "r2"))).toThrow(/Monthly billable/); // 2+2+2 > 4
    expect(ledger.summary("bob").totals.billableMinor).toBe(0); // per-user isolation
  });

  it("restart safety: a reserved operation from a crashed run is retried under the same logical key, not billed twice", () => {
    const dir = mkdtempSync(join(tmpdir(), "dac-led-")); dirs.push(dir);
    const path = join(dir, "s.sqlite");
    const op = { userId: "alice", requestId: "r", provider: "KERNEL" as const, operation: "inspect", logicalKey: "kernel:p1", quantity: 30, unit: "browser_second", provenance: "MOCK" as const, billable: true };
    const s1 = new Store(path); new UsageLedger(s1).begin(op); s1.close(); // crash before complete
    const s2 = new Store(path); const l2 = new UsageLedger(s2);
    const again = l2.begin(op); expect(again.record.attempts).toBe(2);
    l2.complete(again.record.id, { success: true, actualQuantity: 12 });
    expect(l2.summary("alice").totals.billableMinor).toBe(5);
    expect(l2.begin(op).reuse).toBe(true);
    s2.close();
  });
});

describe("community vs managed, service billing", () => {
  it("community: no billing, mock providers work without keys", async () => {
    const p = plane("community");
    const h = await server(p.svc);
    const c = await mcpClient(h.url, TOKENS.alice);
    await call(c, "research_purchase", DISCOVERY);
    const u = await call(c, "get_usage_summary", {});
    expect(u).toMatchObject({ mode: "community", billing: { status: "NOT_APPLICABLE_COMMUNITY" }, usage: { totals: { billableMinor: 0 } } });
    expect(u.usage.lines.every((l: any) => l.provenance === "MOCK")).toBe(true);
    await c.close();
  });

  it("managed: paid operations denied without ACTIVE billing (before any provider call); forged billing state rejected; unavailable billing fails closed", async () => {
    const p = plane("managed");
    const h = await server(p.svc);
    const c = await mcpClient(h.url, TOKENS.alice);
    expect((await callError(c, "research_purchase", DISCOVERY)).code).toBe("BILLING_AUTHORIZATION_REQUIRED");
    expect(p.tavily.calls).toBe(0);
    // Forged webhook: wrong signature.
    const forged = JSON.stringify({ id: "WH-B-1", event_type: "BILLING.SUBSCRIPTION.ACTIVATED", resource: { custom_id: "alice" } });
    const bad = await fetch(`${h.url}/billing/webhook/mock`, { method: "POST", headers: { "x-mock-billing-signature": "00".repeat(32) }, body: forged });
    expect(bad.status).toBe(401);
    expect((await callError(c, "research_purchase", DISCOVERY)).code).toBe("BILLING_AUTHORIZATION_REQUIRED");
    // Correctly signed (mock) activation; duplicate delivery applied once.
    const sig = createHmac("sha256", SECRET).update(forged).digest("hex");
    expect(await (await fetch(`${h.url}/billing/webhook/mock`, { method: "POST", headers: { "x-mock-billing-signature": sig }, body: forged })).json()).toEqual({ outcome: "APPLIED_ACTIVE" });
    expect(await (await fetch(`${h.url}/billing/webhook/mock`, { method: "POST", headers: { "x-mock-billing-signature": sig }, body: forged })).json()).toEqual({ outcome: "DUPLICATE" });
    const r = await call(c, "research_purchase", DISCOVERY);
    expect(r.usage.records.some((u: any) => u.billableMinor > 0)).toBe(true);
    const summary = await call(c, "get_usage_summary", {});
    expect(summary).toMatchObject({ mode: "managed", simulation: true, billing: { billingAuthorization: { status: "ACTIVE", source: "MOCK_PAYPAL_SUBSCRIPTIONS" }, periodSummary: { status: "DRAFT_NOT_INVOICED", currency: "USD" } } });
    expect(summary.billing.periodSummary.billableMinor).toBe(summary.usage.totals.billableMinor);
    // Bob sees only his own usage and has no billing authority from Alice.
    const bob = await mcpClient(h.url, TOKENS.bob);
    expect((await callError(bob, "research_purchase", DISCOVERY)).code).toBe("BILLING_AUTHORIZATION_REQUIRED");
    expect((await call(bob, "get_usage_summary", {})).usage.totals.billableMinor).toBe(0);
    // Billing provider outage: fail closed.
    p.billing.available = false;
    expect((await callError(c, "research_purchase", DISCOVERY)).code).toBe("BILLING_UNAVAILABLE");
    await c.close(); await bob.close();
  });

  it("monthly cap stops managed research spending; billing authority never authorizes a purchase", async () => {
    const p = plane("managed", { limits: { perRequestSupplierMicro: 200_000, monthlyBillableMinor: 1 } });
    p.billing.setFixtureState("alice", "ACTIVE");
    const h = await server(p.svc);
    const c = await mcpClient(h.url, TOKENS.alice);
    await call(c, "research_purchase", { request: "Buy Sony WH-CH720N Black", currency: "USD" }); // discovery: 1 minor unit
    expect((await callError(c, "research_purchase", { request: "Buy Sony WH-CH720N White", currency: "USD" })).code).toBe("USAGE_LIMIT");
    // Separation: ACTIVE service billing, but no purchase mandate → checkout still needs the owner.
    const p2 = plane("managed"); p2.billing.setFixtureState("alice", "ACTIVE");
    const h2 = await server(p2.svc);
    const c2 = await mcpClient(h2.url, TOKENS.alice);
    const r = await call(c2, "research_purchase", { request: "Buy Sony WH-CH720N Black", currency: "USD" });
    await call(c2, "compare_purchase_offers", { researchSessionId: r.purchaseSessionId, productIdentity: SONY_BLACK, destination: CA });
    const prep = await call(c2, "prepare_checkout", { purchaseSessionId: r.purchaseSessionId, offerId: "off_alpha", maximumApprovedTotalMinor: 6000, currency: "USD", quantity: 1 });
    expect(prep.authorizationRequirements).toContain("OWNER_MANDATE_REQUIRED");
    expect(h2.mock.calls.createOrder).toBe(0);
    // And a purchase mandate never activates service billing.
    const p3 = plane("managed"); const h3 = await server(p3.svc);
    await createMandate(h3.url, OWNER.alice, { productIdentity: SONY_BLACK, currency: "USD", maximumTotalMinor: 6000 });
    const c3 = await mcpClient(h3.url, TOKENS.alice);
    expect((await callError(c3, "research_purchase", DISCOVERY)).code).toBe("BILLING_AUTHORIZATION_REQUIRED");
    await c.close(); await c2.close(); await c3.close();
  });

  it("managed mode cannot start without production auth except as a loopback simulation", async () => {
    const p = plane("managed");
    await expect(startHarness({ service: { ...p.svc, managedSimulation: false } })).rejects.toThrow(/production authentication/);
    await expect(startHarness({ service: p.svc, baseUrl: "https://managed.example.org" })).rejects.toThrow(/production authentication/);
  });

  it("provider keys never leak into MCP outputs, usage records or serialization", async () => {
    const key = "tvly-THIS-IS-A-FAKE-KEY-123456";
    const t = new TavilySearch(key, "community", (async () => Response.json({ results: [] })) as typeof fetch);
    expect(JSON.stringify(t)).not.toContain(key);
    const store = new Store(":memory:"); const ledger = new UsageLedger(store);
    const svc: ServicePlane = { mode: "community", ledger, router: new EvidenceRouter(store, ledger, t, null), billing: null };
    const h = await server(svc);
    const c = await mcpClient(h.url, TOKENS.alice);
    const r = await c.callTool({ name: "research_purchase", arguments: DISCOVERY });
    const u = await c.callTool({ name: "get_usage_summary", arguments: {} });
    const everything = JSON.stringify([r, u, store.db.prepare("SELECT * FROM usage_records").all(), store.db.prepare("SELECT * FROM evidence_query_cache").all()]);
    expect(everything).not.toContain(key);
    expect(everything).toContain("BYOK_LIVE");
    await c.close();
  });
});
