/**
 * Typed Semantic Adapter v0.2 (experiment/typed-semantic-v02): verified non-Latin brand normalization.
 * Invented names only (Morvane / 모르반, Kestrin / 케스트린, Halden / 할든); nothing comes from any IW set.
 */
import { describe, expect, it } from "vitest";
import { parseResearchIntent } from "../src/intent/ResearchIntentV2.js";
import { extractIdentity } from "../src/identity/ProductIdentityExtractor.js";
import { applyTypedSemanticIntent } from "../src/intent/hybrid/typed/TypedSemanticIntent.js";
import { applyTypedSemanticIntentV02 } from "../src/intent/hybrid/typed/TypedSemanticIntentV02.js";
import { runResearchV2 } from "../src/research/ResearchPlannerV2.js";

const P = (i: { request: string }) => parseResearchIntent(i);
const si = (item: Record<string, unknown>, constraints: unknown[] = []) => {
  const { brand: bp, ...rest } = item as { brand?: { span: string; brand_latin?: string; brand_latin_alternatives?: string[] } };
  return { language: "ko", item: { kind: "STANDALONE", product_type: null, brand: bp ? { text: bp.span, span: bp.span } : null, model: null, host: null, ...rest }, constraints, budget: null, condition: null, ambiguities: [], confidence: "high",
    ...(bp?.brand_latin ? { brand_proposal: { span: bp.span, brand_latin: bp.brand_latin, brand_latin_alternatives: bp.brand_latin_alternatives ?? [] } } : {}) };
};
const v02 = (request: string, raw: unknown) => applyTypedSemanticIntentV02(P({ request }), raw, { request }, "SELECTIVE", P);
const brand = (span: string, latin: string, alternatives: string[] = []) => ({ text: span, span, brand_latin: latin, brand_latin_alternatives: alternatives });

const product = (id: string, title: string, b: string): any =>
  ({ productId: id, title, category: "unknown", identity: { ...extractIdentity(title, b), brand: b, variant: null, condition: "new", sku: null }, description: null, capabilities: [], offers: [] });
async function plan(intent: any, listings: any[]) {
  const queries: string[] = [];
  const research: any = { isMock: true, findOffers: async (id: any) => listings.filter((p) => p.identity.model === id.model && p.identity.brand === id.brand).map((p) => ({ productId: p.productId, offerId: `o-${p.productId}`, merchantId: "m1", availability: "IN_STOCK", currency: "USD", itemPriceMinor: 5000, listedIdentity: { condition: "new" } })) };
  const r = await runResearchV2(intent, { research, router: null, ctx: { userId: "u", requestId: "r" }, now: () => 0,
    searchPage: async (q) => { queries.push(q.query ?? q.text); const words = (q.query ?? q.text).toLowerCase().split(/\s+/).filter(Boolean); return { products: listings.filter((p) => words.some((w) => p.title.toLowerCase().includes(w))), nextPageToken: null, providerCalls: 1 }; } });
  return { r, queries };
}

describe("v0.2 brand proposal: interpreter proposes, the adapter checks, the catalog decides", () => {
  const req = "모르반 Tarn 40 침낭";
  const raw = si({ brand: brand("모르반", "Morvane"), model: { text: "Tarn 40", span: "Tarn 40" }, product_type: { text: "침낭", span: "침낭", en: "sleeping bag" } });

  it("a passing proposal yields the Latin reading with the as-written reading as fallback", () => {
    const r = v02(req, raw);
    expect(r.trace.brand.outcome).toBe("PROPOSED_TO_CATALOG");
    expect(r.intent.target).toMatchObject({ brand: "Morvane", model: "Tarn 40" });
    expect(r.intent.brandProposal).toMatchObject({ brand: "Morvane", original: "모르반" });
    // the fallback is exactly what v0.1 produces on the request as written
    expect(r.intent.brandProposal!.fallback).toEqual(applyTypedSemanticIntent(P({ request: req }), raw, { request: req }, "SELECTIVE", P).intent);
  });
  it("money and condition come from the original request", () => {
    const q = "모르반 Tarn 40 침낭 $120 이하";
    const r = v02(q, si({ brand: brand("모르반", "Morvane"), model: { text: "Tarn 40", span: "Tarn 40" } }));
    expect(r.intent.budgetMinor).toBe(P({ request: q }).budgetMinor);
  });
  it("a spelling for a brand written in Latin, a non-verbatim span or a non-Latin spelling is refused", () => {
    expect(v02("Morvane Tarn 40", si({ brand: brand("Morvane", "Morvan") })).trace.brand.outcome).not.toBe("PROPOSED_TO_CATALOG");
    expect(v02(req, si({ brand: brand("모르밴", "Morvane") })).trace.brand.why).toBe("brand span not verbatim");
    expect(v02(req, si({ brand: brand("모르반", "모르반") })).trace.brand.why).toBe("proposed spelling is not a Latin brand name");
  });
  it("a changed model or kind is refused (accessory never becomes the host)", () => {
    const acc = "모르반 Tarn 40 전용 압축색";
    const r = v02(acc, si({ kind: "ACCESSORY", brand: brand("모르반", "Morvane"), model: { text: "Tarn 40", span: "Tarn 40" }, host: { text: "Morvane Tarn 40", span: "Tarn 40" } }));
    expect(r.trace.brand.outcome).toBe("REJECTED");
    expect(r.intent.brandProposal).toBeUndefined();
    const m = v02(req, si({ brand: brand("모르반", "Morvane"), model: { text: "Tarn 45", span: "Tarn 40" } }));
    expect(m.trace.brand.why).toMatch(/model "Tarn 45" not kept/);
  });
  it("an identity the parser already read is never replaced", () => {
    const r = v02("Halden 모르반 Tarn 40", si({ brand: brand("모르반", "Morvane") }));
    expect(r.trace.brand.outcome).toBe("REJECTED");
  });
  it("no proposal: v0.2 is exactly v0.1", () => {
    const r = v02(req, si({ brand: { text: "모르반", span: "모르반" } }));
    expect(r.trace.brand.outcome).toBe("NONE");
    expect(r.intent).toEqual(applyTypedSemanticIntent(P({ request: req }), si({ brand: { text: "모르반", span: "모르반" } }), { request: req }, "SELECTIVE", P).intent);
  });
});

describe("planner: the catalog brand decides the proposal", () => {
  const req = "모르반 Tarn 40 침낭";
  const raw = (alts: string[] = []) => si({ brand: brand("모르반", "Morvane", alts), model: { text: "Tarn 40", span: "Tarn 40" } });
  it("verified: the catalog lists exactly that brand; the exact reading is kept and locks", async () => {
    const iv = v02(req, raw()).intent;
    const { r } = await plan(iv, [product("t40", "Morvane Tarn 40 Sleeping Bag", "Morvane"), product("t45", "Morvane Tarn 45 Sleeping Bag", "Morvane")]);
    expect(r.intent).toBe(iv);
    expect(r.resolution?.status).toBe("LOCKED");
    expect((r.resolution as any).productId).toBe("t40");
  });
  it("not listed: results are discarded and the as-written reading is researched", async () => {
    const iv = v02(req, raw()).intent;
    const { r } = await plan(iv, [product("x", "Morvana Tarn 40 Sleeping Bag", "Morvana")]); // near-spelling: never fuzzy-matched
    expect(r.intent).toBe(iv.brandProposal!.fallback);
    expect(r.resolution?.status ?? "NONE").not.toBe("LOCKED");
    expect(r.trace.stops.join(" ")).toMatch(/not verified/);
  });
  it("ambiguous: an alternative spelling is also listed, so nothing is locked by transliteration", async () => {
    const iv = v02(req, raw(["Morvan"])).intent;
    const { r } = await plan(iv, [product("a", "Morvane Tarn 40 Sleeping Bag", "Morvane"), product("b", "Morvan Tarn 40 Sleeping Bag", "Morvan")]);
    expect(r.intent).toBe(iv.brandProposal!.fallback);
    expect(r.trace.stops.join(" ")).toMatch(/ambiguous/);
  });
  it("ambiguous: the original spelling is itself a catalog brand", async () => {
    const iv = v02(req, raw()).intent;
    const { r } = await plan(iv, [product("a", "Morvane Tarn 40 Sleeping Bag", "Morvane"), product("k", "모르반 Tarn 40", "모르반")]);
    expect(r.intent).toBe(iv.brandProposal!.fallback);
  });
  it("a TypeScript-only intent never carries a proposal (other arms are unaffected)", () => {
    expect(P({ request: req }).brandProposal).toBeUndefined();
    expect(P({ request: "Morvane Tarn 40" }).brandProposal).toBeUndefined();
  });
});
