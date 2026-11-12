/**
 * V2.2 WP-3 (H-3): exact product identity. A product noun phrase ends a named model ("Ostra AP-400 air purifier" keeps
 * model AP-400, never "AP-400 air"), and a listing of another model (AP-250) is never eligible for an AP-400 request, in
 * exact mode or in discovery. Builder-written fictional products only (Ostra, Kova, Arden, Brix, Halden); nothing from
 * IW-1.1, IW-2 or IW-3.
 */
import { afterEach, describe, expect, it } from "vitest";
import { extractIdentity } from "../src/identity/ProductIdentityExtractor.js";
import { parseResearchIntent } from "../src/intent/ResearchIntentV2.js";
import { miniWorld, type MiniProduct } from "./helpers/miniWorld.js";

const intent = (request: string) => parseResearchIntent({ request } as any);

describe("WP-3 request parsing: multi-word category nouns end the model", () => {
  it.each([
    ["Buy the Ostra AP-400 air purifier", "AP-400"],
    ["Buy the Ostra AP-400 air purifier under $300", "AP-400"],
    ["Buy the Brix T18 cordless drill", "T18"],
    ["Buy the Halden K2 robot vacuum", "K2"],
    ["Buy the Halden Breeze 9 air conditioner", "Breeze 9"],
    ["Buy the Ostra Mist 3 rice cooker", "Mist 3"],
    ["Buy the Halden Bolt 5 stand mixer", "Bolt 5"],
    ["Buy the Arden Glide electric toothbrush", "Glide"],
    ["Buy the Alder Trail Runner running shoes size 10", "Trail Runner"],
  ])("%s → model %s", (r, model) => {
    const i = intent(r);
    expect(i.mode).toBe("EXACT_PRODUCT_PURCHASE");
    expect(i.target?.model).toBe(model);
  });

  it("a product noun followed by a model token stays in the model (Watch 6, Laptop 5)", () => {
    expect(intent("Buy a Kova Galaxy Watch 6").target?.model).toBe("Galaxy Watch 6");
    expect(intent("Buy a Halden Surface Laptop 5").target?.model).toBe("Surface Laptop 5");
  });

  it("model suffixes and generations: AP-400 Gen 2 is model AP-400 (model number) with generation 2", () => {
    const i = intent("Buy the Ostra AP-400 Gen 2 air purifier");
    expect(i.target).toMatchObject({ model: "AP-400", modelBasis: "MODEL_NUMBER" });
    expect(i.attributes.generation).toBe("2");
    expect(intent("Buy the Kova Pulse 3 Pro smartwatch").target?.model).toBe("Pulse 3 Pro");
  });

  it.each([
    ["Buy the Ostra AP-400 replacement filter", "AP-400", "filter"],
    ["Buy the Arden Buds Pro 2 charging case", "Buds Pro 2", "case"],
    ["Buy the Kova Pulse watch band", "Pulse", "band"],
    ["Buy the Kova Pulse watch band for my wife", "Pulse", "band"],
    ["Buy a leather case for the Kova Pulse 3", "Pulse 3", "case"],
  ])("accessory request %s → accessory %s / %s", (r, model, noun) => {
    expect(intent(r).target).toMatchObject({ model, kind: "ACCESSORY", accessoryNoun: noun });
  });

  it("a requirement that ends in an accessory noun does not make the request an accessory", () => {
    const i = intent("Buy Sony WH-CH720N Black for the lowest total price, never exceed $100, it must have a wrist strap.");
    expect(i.target).toMatchObject({ model: "WH-CH720N", kind: "STANDALONE" });
  });

  it("the requested model number is recorded in English and Korean discovery requests", () => {
    expect(intent("Buy the Ostra AP-400 air purifier").requestedModel).toBe("AP-400");
    expect(intent("Recommend an AP-400 air purifier under $200").requestedModel).toBe("AP-400");
    expect(intent("오스트라 AP-400 공기청정기 구매, 30만원 이하").requestedModel).toBe("AP-400");
  });
  it("model-less products and spec tokens do not invent a requested model", () => {
    expect(intent("Recommend a quiet air purifier under $200").requestedModel ?? null).toBeNull();
    expect(intent("a laptop with an M2 chip under $1500").requestedModel ?? null).toBeNull();
    expect(intent("best 4K TV under $500").requestedModel ?? null).toBeNull();
    // V2.3 (V22-03): a named model-less product binds like a model number.
    expect(intent("Buy the Arden Glide electric toothbrush").requestedModel).toBe("Glide");
  });
});

describe("WP-3 listing titles", () => {
  it.each([
    ["Ostra AP-400 Air Purifier, HEPA, White", "Ostra", "AP-400", "STANDALONE"],
    ["Ostra AP-250 Air Purifier", "Ostra", "AP-250", "STANDALONE"],
    ["HEPA Replacement Filter for Ostra AP-400 Air Purifier", "Ostra", "AP-400", "ACCESSORY"],
    ["Silicone Band for Kova Pulse 3 Smartwatch", "Kova", "Pulse 3", "ACCESSORY"],
    ["Kova Pulse Watch Band for Women", "Kova", "Pulse", "ACCESSORY"],
  ])("%s → %s %s (%s)", (t, brand, model, kind) => {
    const e = extractIdentity(t, brand);
    expect(e.model).toBe(model); expect(e.kind).toBe(kind);
  });
});

const purifier = (id: string, model: string, price: number): MiniProduct => ({ id, title: `Ostra ${model} Air Purifier`, brand: "Ostra", category: "air-purifiers", categoryTitle: "Air Purifiers", price });
const AP250 = purifier("ap250", "AP-250", 149);
const AP400 = purifier("ap400", "AP-400", 249);
const AP4000 = purifier("ap4000", "AP-4000", 199);
const FILTER = { id: "ap400f", title: "Replacement HEPA Filter for Ostra AP-400 Air Purifier", brand: "Ostra", category: "air-purifiers", categoryTitle: "Air Purifiers", price: 39 } as MiniProduct;

describe("WP-3 end to end: no wrong-model listing becomes eligible", () => {
  let w: ReturnType<typeof miniWorld> | null = null;
  afterEach(() => { w?.close(); w = null; });
  const research = (products: MiniProduct[], request: string) => { w = miniWorld(products); return w.app.gateway.researchPurchase("alice", { request }) as Promise<any>; };
  const eligible = (out: any) => (out.decision.ranking as any[]).filter((r) => !r.disqualifiers.length).map((r) => r.productId as string);

  it("H-3 reproduction: only AP-250 is listed → an AP-400 request is not locked and AP-250 is not eligible", async () => {
    const out = await research([AP250], "Buy the Ostra AP-400 air purifier under $300");
    expect(out.identity.status).not.toBe("LOCKED");
    expect(out.decision.state).not.toBe("RECOMMEND");
    expect(eligible(out).some((id) => /ap250/.test(id))).toBe(false);
  });
  it("AP-250, AP-4000 and AP-400 listed → the AP-400 is locked (positive control)", async () => {
    const out = await research([AP250, AP4000, AP400], "Buy the Ostra AP-400 air purifier under $300");
    expect(out.identity.status).toBe("LOCKED");
    expect(out.identity.lockedIdentity.model).toBe("AP-400");
  });
  it("discovery naming AP-400: AP-250 and AP-4000 are disqualified as NOT_REQUESTED_MODEL, AP-400 stays eligible", async () => {
    const out = await research([AP250, AP4000, AP400], "Recommend an AP-400 air purifier under $300");
    const by = Object.fromEntries((out.decision.ranking as any[]).map((r) => [r.productId.replace(/^.*?(ap\d+)$/, "$1"), r.disqualifiers.map((d: any) => d.code)]));
    expect(by.ap250).toContain("NOT_REQUESTED_MODEL");
    expect(by.ap4000).toContain("NOT_REQUESTED_MODEL");
    expect(by.ap400 ?? []).not.toContain("NOT_REQUESTED_MODEL");
    if (out.decision.recommendation) expect(out.decision.recommendation.title).toMatch(/AP-400\b/);
  });
  it("Korean discovery naming AP-400: AP-250 never becomes the recommendation", async () => {
    const out = await research([AP250], "오스트라 AP-400 공기청정기 구매, 30만원 이하");
    expect(out.decision.state).not.toBe("RECOMMEND");
    expect(eligible(out)).toEqual([]);
  });
  it("an AP-400 filter request never locks the purifier itself", async () => {
    const out = await research([AP400, FILTER], "Buy the Ostra AP-400 replacement filter under $60");
    if (out.identity.status === "LOCKED") expect(out.identity.lockedIdentity.productId ?? out.identity.lockedIdentity.model).not.toMatch(/^ap400$/);
    if (out.decision.recommendation) expect(out.decision.recommendation.title).toMatch(/Filter/);
  });
});
