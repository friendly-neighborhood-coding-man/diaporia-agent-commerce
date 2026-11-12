/**
 * Regression tests for the independent review of PR #13 (RESEARCH-V2-INDEPENDENT-REVIEW.md, R-01…R-09). Each block
 * reproduces the reviewer's failing input and asserts the fixed behaviour.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseResearchIntent } from "../src/intent/ResearchIntentV2.js";
import { statementFrom, classifyItem, judgeV2 } from "../src/evidence/EvidenceV2.js";
import { SourceRegistry } from "../src/evidence/SourceRegistry.js";
import { resolveExactV2 } from "../src/identity/ProductResolverV2.js";
import { decide } from "../src/decision/DecisionEngine.js";
import { runResearchV2 } from "../src/research/ResearchPlannerV2.js";
import { Channel3ResearchAdapter } from "../src/research/Channel3ResearchAdapter.js";
import { TavilySearch } from "../src/evidence/providers.js";
import type { CatalogProduct, MerchantOffer } from "../src/domain/types.js";
import type { CapabilityVerdict } from "../src/evidence/EvidenceV2.js";

const NOW = Date.parse("2026-11-10T12:00:00.000Z");
const product = (id: string, title: string, brand: string, model: string, variant: string | null = null, extra: Partial<CatalogProduct> = {}): CatalogProduct =>
  ({ productId: id, title, category: "headphones", identity: { brand, model, variant, condition: "new", sku: null }, capabilities: [], description: null, reviews: [], ...extra });
const offer = (productId: string, price: number): MerchantOffer => ({ offerId: `${productId}:${price}`, productId, merchantId: "m", merchantName: "m.example", merchantDomain: "m.example",
  listedIdentity: { brand: "B", model: "M", variant: null, condition: "new", sku: null }, itemPriceMinor: price, currency: "USD", availability: "IN_STOCK", listingUrl: "https://m.example/p",
  checkoutCapability: "EXTERNAL_CHECKOUT_ONLY", listingText: null, observedAt: new Date(NOW).toISOString(), identityClaim: null });
const verified = (cap: string): CapabilityVerdict => ({ capability: cap, status: "VERIFIED_TRUE", basis: "MANUFACTURER", evidence: [], independentGroups: 0 });

describe("R-01 evidence attribution: a clause about another product never counts", () => {
  const xm5 = product("p", "Sony WH-1000XM5 Wireless Headphones", "Sony", "WH-1000XM5");
  it("comparison and best-of snippets give no statement for the candidate", () => {
    const vs = { title: "Sony WH-1000XM5 vs Bose QC Ultra", snippet: "We compared both. The Bose QC Ultra has multipoint and great ANC. Battery is 24 hours." };
    expect(statementFrom(vs, xm5, "multipoint")).toBeNull();
    expect(statementFrom(vs, xm5, "active_noise_cancellation")).toBeNull();
    expect(statementFrom({ title: "Best headphones 2026", snippet: "Sony WH-1000XM5: our top pick. Runner-up: the Anker Q20, which is waterproof." }, xm5, "waterproof")).toBeNull();
    expect(statementFrom({ title: "Sony WH-1000XM5 review", snippet: "Unlike its rival the AirPods Max, it does not have multipoint." }, xm5, "multipoint")).toBeNull();
  });
  it("a clause naming only this model still counts on a comparison page; a pronoun clause counts on a single-product review", () => {
    expect(statementFrom({ title: "Sony WH-1000XM5 vs Bose QC Ultra", snippet: "The Sony WH-1000XM5 supports multipoint. The Bose does too." }, xm5, "multipoint")).toMatchObject({ value: true });
    expect(statementFrom({ title: "Sony WH-1000XM5 review", snippet: "It supports multipoint pairing." }, xm5, "multipoint")).toMatchObject({ value: true });
    expect(statementFrom({ title: "Sony WH-1000XM5 review", snippet: "Is it waterproof?" }, xm5, "waterproof")).toBeNull();
  });
  it("two expert comparison pages about a rival can no longer verify the candidate", () => {
    const reg = new SourceRegistry();
    const hits = [{ url: "https://www.rtings.com/a", title: "Sony WH-1000XM5 vs Bose QC Ultra", snippet: "The Bose QC Ultra has multipoint." },
      { url: "https://www.soundguys.com/b", title: "Bose QC Ultra vs Sony WH-1000XM5", snippet: "Only the Bose QC Ultra supports multipoint." }];
    const items = hits.flatMap((h) => { const st = statementFrom(h, xm5, "multipoint"); return st ? [classifyItem({ url: h.url, domain: new URL(h.url).hostname, sourceClass: reg.classify(h.url, "Sony"),
      value: st.value, quote: st.quote, publishedDate: null, provider: "t", requestId: null, observedAt: "" }, NOW)] : []; });
    expect(judgeV2("multipoint", items).status).toBe("UNVERIFIED");
  });
});

describe("R-02 manufacturer: only registered official domains", () => {
  it("brand.<any tld> and look-alikes are UNKNOWN and cannot verify alone", () => {
    const reg = new SourceRegistry();
    for (const [u, b] of [["https://sony.shop/x", "Sony"], ["https://sony.xyz/r", "Sony"], ["https://nest.org/b", "Nest"], ["https://ring.io/x", "Ring"], ["https://sony.com.evil.example/p", "Sony"]] as const)
      expect(reg.classify(u, b)).toBe("UNKNOWN");
    expect(reg.classify("https://www.sony.com/p", "Sony")).toBe("MANUFACTURER");
    const item = classifyItem({ url: "https://sony.shop/x", domain: "sony.shop", sourceClass: reg.classify("https://sony.shop/x", "Sony"), value: true, quote: "has multipoint", publishedDate: null, provider: "t", requestId: null, observedAt: "" }, NOW);
    expect(judgeV2("multipoint", [item]).status).toBe("UNVERIFIED");
  });
});

describe("R-03 ranking: listing text never outranks price or utility among verified candidates", () => {
  it("cheapest objective recommends the $50 product, not the $200 one whose title says 'wireless'", () => {
    const intent = parseResearchIntent({ request: "cheapest wireless headphones under $300" });
    expect(intent.objective).toBe("LOWEST_VERIFIED_TOTAL");
    const a = product("a", "Brand A Headphones", "Brand", "A1");
    const b = product("b", "Brand B Wireless Headphones", "Brand", "B1");
    const d = decide(intent, [
      { product: a, offers: [offer("a", 5000)], must: { wireless: verified("wireless") }, nice: {}, notChecked: [], limitReached: false, listingClaims: 0 },
      { product: b, offers: [offer("b", 20000)], must: { wireless: verified("wireless") }, nice: {}, notChecked: [], limitReached: false, listingClaims: 1 }], { now: NOW });
    expect(d.state).toBe("RECOMMEND");
    expect(d.recommendation!.productId).toBe("a");
  });
  it("the listing-text prior still orders candidates whose must-haves are unverified", () => {
    const intent = parseResearchIntent({ request: "wireless headphones under $300" });
    const un = (id: string, claims: number, price: number) => ({ product: product(id, `Brand ${id}`, "Brand", id.toUpperCase() + "1"), offers: [offer(id, price)], must: {}, nice: {}, notChecked: [], limitReached: false, listingClaims: claims });
    const d = decide(intent, [un("x", 0, 5000), un("y", 1, 9000)], { now: NOW });
    expect(d.state).toBe("INVESTIGATE");
    expect(d.ranking[0]!.productId).toBe("y");
  });
});

describe("R-04 budget parser: quantities are not money", () => {
  it.each([
    ["wireless headphones with battery up to 30 hours, under $300", 30000],
    ["noise cancelling headphones, max 40 hours battery, budget $250", 25000],
    ["buy a coffee maker, holds up to 12 cups, under $80", 8000],
    ["waterproof running shoes within 2 weeks shipping under $120", 12000],
    ["headphones under $300.", 30000],
    ["headphones up to $200", 20000],
    ["monitor under 400 USD", 40000], // V21-01: a bare "under 400" with no currency is unresolved, see the next test
    ["laptop under $1,300 in black", 130000],
  ])("%s → %i", (request, minor) => { expect(parseResearchIntent({ request }).budgetMinor).toBe(minor); });
  it("keeps the battery requirement that the old parser consumed as a budget", () => {
    expect(parseResearchIntent({ request: "wireless headphones with battery up to 30 hours, under $300" }).mustHave).toContain("battery_30h");
    expect(parseResearchIntent({ request: "headphones with up to 40 hours, max 2 days shipping" }).budgetMinor).toBeNull();
  });
  it("V21-01: a bare amount with no currency is not assumed to be USD; it is unresolved", () => {
    expect(parseResearchIntent({ request: "monitor under 400" })).toMatchObject({ budgetMinor: null, budgetUnresolved: expect.stringContaining("no currency") });
    expect(parseResearchIntent({ request: "monitor under 400", currency: "USD" })).toMatchObject({ budgetMinor: 40000, budgetUnresolved: null });
  });
});

describe("R-06 a brandless listing never locks a branded request", () => {
  it("'Sony WH-1000XM5 in black' is NOT_FOUND against an unbranded 'compatible' listing", () => {
    const intent = parseResearchIntent({ request: "buy the Sony WH-1000XM5 in black" });
    const knock = product("k", "WH-1000XM5 Black Wireless Headphones (compatible)", "", "WH-1000XM5", "Black");
    const r = resolveExactV2(intent as any, [knock], (id) => [offer(id, 9900)]);
    expect(r.status).toBe("NOT_FOUND");
    expect(JSON.stringify(r)).toMatch(/states no brand; requested Sony/);
  });
});

describe("R-07 a text budget in another currency is never dropped silently", () => {
  it("records the conflict and the decision HOLDs with a question instead of 'No budget given'", () => {
    const intent = parseResearchIntent({ request: "노이즈캔슬링 헤드폰 30만원 이하", currency: "USD" });
    expect(intent.budgetMinor).toBeNull();
    expect(intent.budgetConflict).toMatch(/KRW/);
    expect(intent.assumptions.join(" ")).toMatch(/Budget not applied/);
    const d = decide(intent, [{ product: product("a", "Brand A", "Brand", "A1"), offers: [offer("a", 5000)], must: { active_noise_cancellation: verified("active_noise_cancellation") }, nice: {}, notChecked: [], limitReached: false }], { now: NOW });
    expect(d.state).toBe("HOLD");
    expect(d.holdReasons.join(" ")).toMatch(/currency conflict/);
  });
});

describe("R-08 service adapters: no redirects, one attempt per metered call", () => {
  const redirecting = () => {
    const calls: RequestInit[] = [];
    const f = (async (_u: unknown, init: RequestInit) => { calls.push(init); return new Response(null, { status: 302, headers: { location: "https://evil.example/" } }); }) as typeof fetch;
    return { f, calls };
  };
  it("Channel3 never follows a redirect and does not retry it", async () => {
    const { f, calls } = redirecting();
    const a = new Channel3ResearchAdapter("ch3-TEST-KEY-000000", { fetchImpl: f });
    await expect(a.searchPage({ text: "x", query: "x", limit: 5 } as any, null)).rejects.toThrow(/redirect refused/);
    expect(calls).toHaveLength(1); expect(calls[0]!.redirect).toBe("manual");
  });
  it("Tavily never follows a redirect and does not retry it", async () => {
    const { f, calls } = redirecting();
    const t = new TavilySearch("tvly-TEST-0000000", "community", f);
    await expect(t.searchV2({ query: "x" } as any)).rejects.toThrow(/redirect refused/);
    expect(calls).toHaveLength(1); expect(calls[0]!.redirect).toBe("manual");
  });
  it("main.ts builds both live adapters with one HTTP attempt per metered call", () => {
    const src = readFileSync("src/main.ts", "utf8");
    expect(src).toMatch(/new Channel3ResearchAdapter\(env\.CHANNEL3_API_KEY, \{ retry: \{ \.\.\.SERVICE_LIVE_RETRY \} \}\)/);
    expect(src).toMatch(/new TavilySearch\(env\.TAVILY_API_KEY!, deploymentMode, fetch, \{ \.\.\.SERVICE_LIVE_RETRY \}\)/);
  });
});

describe("R-09 planner: for the cheapest objective, evidence goes to the cheapest eligible candidate first", () => {
  it("with room to check one candidate, the $50 one is checked even though the $200 title claims the must-have", async () => {
    const intent = parseResearchIntent({ request: "cheapest wireless headphones under $300" });
    const a = product("a", "Brand A Headphones", "Brand", "A1"); const b = product("b", "Brand B Wireless Headphones", "Brand", "B1");
    const offers: Record<string, MerchantOffer[]> = { a: [offer("a", 5000)], b: [offer("b", 20000)] };
    const checked: string[] = [];
    const router = { policy: "v2", verifyMany: async (p: CatalogProduct, _c: string[], _x: unknown, o: { maxSearches?: number; broad?: boolean } = {}) => { if (o.maxSearches !== 0 && !o.broad) checked.push(p.productId); return { verdicts: { wireless: verified("wireless") }, steps: [], searchesSent: 1, blockedByLimit: [] }; } };
    const r = await runResearchV2(intent, { research: { findOffers: async (id: any) => offers[id.model === "A1" ? "a" : "b"]! } as any, router: router as any,
      searchPage: async () => ({ products: [b, a], nextPageToken: null, providerCalls: 1 }), ctx: { userId: "u", requestId: "r" }, now: () => NOW, limits: { maxEvidenceCandidates: 1 } });
    expect(checked).toEqual(["a"]); // V2.6: the brand-wide search and the free pooled pass are not per-candidate checks
    expect(r.decision.recommendation?.productId).toBe("a");
  });
});
