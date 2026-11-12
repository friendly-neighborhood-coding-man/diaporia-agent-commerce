/**
 * V2.6: structural fixes after the first scored IW-7 run (IW-7 is now seen; these tests use builder-written fictional
 * products only: Corvan, Mirelle, Toska, Pellan, Quillon, Abrin, Contoso). Nothing is copied from any IW set.
 */
import { describe, expect, it } from "vitest";
import { parseResearchIntent } from "../src/intent/ResearchIntentV2.js";
import { extractIdentity, parseAttributes, stripYear } from "../src/identity/ProductIdentityExtractor.js";
import type { CatalogProduct } from "../src/domain/types.js";
import { EvidenceRouter } from "../src/evidence/EvidenceRouter.js";
import { TavilySearch } from "../src/evidence/providers.js";
import { Store } from "../src/store/Database.js";
import { UsageLedger, PLACEHOLDER_PRICING } from "../src/metering/UsageLedger.js";

const intent = (request: string) => parseResearchIntent({ request } as any) as any;
const NOW = Date.parse("2026-11-12T00:00:00.000Z");

describe("V2.6 model parsing", () => {
  it("a model number that looks like a year is never cut", () => {
    expect(stripYear("RX-2000")).toBe("RX-2000");
    expect(stripYear("Drift 15 2024")).toBe("Drift 15");
    expect(intent("Toska RX-2000 pressure washer").target.model).toBe("RX-2000");
  });
  it("a product noun ending a listing title is not a sibling suffix; a suffix ending a request is", () => {
    expect(extractIdentity("Pellan Arc 10x50 Binoculars", "Pellan").model).toBe("Arc 10x50");
    expect(intent("Pellan KX-40 Trio").target.model).toBe("KX-40 Trio");
  });
  it("'<model> <product noun> with the <contents> bundle' asks for the bundle", () => {
    const b = intent("Toska RX-2000 pressure washer with the hose reel bundle");
    expect(b.target.kind).toBe("BUNDLE");
    expect(b.productTypeWords).toContain("hose");
  });
  it("a Korean colour word inside a longer noun is not a colour", () => {
    expect(parseAttributes("블랙박스").color).toBeUndefined();
    expect(parseAttributes("블랙 색상").color).toBe("Black");
  });
});

describe("V2.6 unknown words: context by default, blocking when phrased as a requirement", () => {
  it("politeness, recipients and occasions do not block", () => {
    expect(intent("a birthday gift: kettle with a gooseneck spout, thanks").uninterpreted).toEqual([]);
    expect(intent("I'd like a gooseneck kettle").uninterpreted).toEqual([]);
  });
  it("a negated word, a comma item, a word after a feature verb or next to a noun, and a model-like token still block", () => {
    expect(intent("pellet smoker under $500, frobnicated").uninterpreted.map((u: any) => u.text)).toEqual(["frobnicated"]);
    expect(intent("smart lock keypad entry under $200").uninterpreted.length).toBeGreaterThan(0);
    expect(intent("Pellan QZ-77 블렌더 사 줘").uninterpreted.length).toBeGreaterThan(0);
  });
  it("'… and has a <feature>' is a requirement", () => {
    expect(intent("smart lock that fits a standard deadbolt and has a keypad").unresolvedMust).toContain("unrecognized:keypad");
  });
  it("an amount in words is never dropped: the budget stays unresolved", () => {
    const i = intent("smart lock with a keypad for under one hundred dollars");
    expect(i.budgetMinor).toBeNull();
    expect(i.budgetUnresolved).toMatch(/in words/);
    expect(i.uninterpreted).toEqual([]);
  });
});

describe("V2.6 evidence budget: results already retrieved are read for every candidate", () => {
  const ledgerFor = (store: Store) => new UsageLedger(store, PLACEHOLDER_PRICING, { perRequestSupplierMicro: 10_000_000, monthlyBillableMinor: 0, perRequestCalls: { TAVILY: 1 } }, () => NOW);
  const product = (id: string, title: string, model: string): CatalogProduct =>
    ({ productId: id, title, category: "headphones", identity: { brand: "Contoso", model, variant: null, condition: "new", sku: null }, capabilities: [], description: null, reviews: [] } as any);
  it("a sibling's search that returned this model's manufacturer page verifies it with no new search; attribution still holds", async () => {
    let calls = 0;
    const fetchImpl = (async () => { calls++; return Response.json({ request_id: "q", usage: { credits: 1 }, results: [
      { url: "https://contoso.com/cx-500", title: "Contoso CX-500 specifications", content: "The Contoso CX-500 has no multipoint.", published_date: "2026-01-01" },
      { url: "https://contoso.com/cx-700", title: "Contoso CX-700 specifications", content: "The Contoso CX-700 supports multipoint.", published_date: "2026-01-01" }] }); }) as unknown as typeof fetch;
    const store = new Store(":memory:");
    const router = new EvidenceRouter(store, ledgerFor(store), new TavilySearch("tvly-TEST-0000000", "community", fetchImpl), null, { billable: false, now: () => NOW, policy: "v2", sources: { officialDomains: { Contoso: ["contoso.com"] } } });
    const ctx = { userId: "u", requestId: "r" };
    const a = await router.verifyMany(product("a", "Contoso CX-500 Headphones", "CX-500"), ["multipoint"], ctx);
    expect(a.verdicts.multipoint!.status).toBe("VERIFIED_FALSE");
    expect(router.remainingSearches(ctx)).toBe(0);
    const b = await router.verifyMany(product("b", "Contoso CX-700 Headphones", "CX-700"), ["multipoint"], ctx, { maxSearches: 0 });
    expect(b.verdicts.multipoint!.status).toBe("VERIFIED_TRUE");
    expect(b.verdicts.multipoint!.evidence.every((e) => e.url === "https://contoso.com/cx-700")).toBe(true);
    const c = await router.verifyMany(product("c", "Contoso CX-900 Headphones", "CX-900"), ["multipoint"], ctx, { maxSearches: 0 });
    expect(c.verdicts.multipoint!.status).toBe("UNVERIFIED");
    expect(calls).toBe(1);
    store.close();
  });
});
