/**
 * P1 (IW-2 verification of 7d1fe4f): N-03 magnitude suffixes, N-05 category nouns after a model (end to end), N-06
 * model-less products with an authentic identity, N-07 Korean queries and accessory requests, R-C the budget warning,
 * and the KRW policy (parsing is not price verification). Builder-written fictional products only.
 */
import { afterEach, describe, expect, it } from "vitest";
import { parseResearchIntent } from "../src/intent/ResearchIntentV2.js";
import { statedBudget } from "../src/intent/ResearchIntentV2.js";
import { requestCategory } from "../src/research/capabilities.js";
import { miniWorld, type MiniProduct } from "./helpers/miniWorld.js";
import { CA, OWNER, TOKENS, call, callError, mcpClient, startHarness, type Harness } from "./helpers.js";

const parse = (request: string, extra: Record<string, unknown> = {}) => parseResearchIntent({ request, ...extra } as any);

describe("N-03: a magnitude suffix is part of the amount", () => {
  it.each([
    ["Buy a Norvik L5 laptop under $1.2k", 120_000],
    ["laptop, never exceed $2k", 200_000],
    ["desk, max 1.5k usd", 150_000],
    ["sofa under 2 thousand dollars", 200_000],
    ["bike under $900", 90_000],
    ["speaker under 40 bucks", 4_000],
  ])("%s → %i minor units", (r, minor) => {
    const i = parse(r);
    expect(i.budgetMinor).toBe(minor);
    expect(i.currency).toBe("USD");
  });
  it("a bare amount with a suffix and no currency stays unresolved (never assumed USD)", () => {
    const i = parse("drone within 3k");
    expect(i.budgetMinor).toBeNull();
    expect(i.budgetUnresolved).toBeTruthy();
  });
  it("units are still not money: km, kg, kWh", () => {
    expect(parse("e-bike with range under 80 km").budgetMinor).toBeNull();
    expect(parse("stroller under 7 kg").budgetMinor).toBeNull();
  });
});

describe("N-05 end to end: a category noun after the model does not break exact identity", () => {
  let w: ReturnType<typeof miniWorld> | null = null;
  afterEach(() => { w?.close(); w = null; });
  const P = (id: string, title: string, brand: string, category: string, categoryTitle: string, price: number): MiniProduct => ({ id, title, brand, category, categoryTitle, price });
  it.each([
    [[P("mk9", "Marlo K9 Projector", "Marlo", "projectors", "Projectors", 299)], "Buy the Marlo K9 projector", "K9"],
    [[P("va3", "Velda Air 3 Soundbar", "Velda", "soundbars", "Soundbars", 149)], "Buy a Velda Air 3 soundbar", "Air 3"],
    [[P("qh5", "Quenby Halo 500 Bluetooth Speaker", "Quenby", "speakers", "Speakers", 129)], "Buy the Quenby Halo 500 speaker under $200", "Halo 500"],
  ])("%#: %s locks the model", async (products, request, model) => {
    w = miniWorld(products as MiniProduct[]);
    const out: any = await w.app.gateway.researchPurchase("alice", { request });
    expect(out.identity.status).toBe("LOCKED");
    expect(out.identity.lockedIdentity.model).toBe(model);
  });
});

describe("N-06: a product without a model is identified by its provider key, never by brand alone", () => {
  let w: ReturnType<typeof miniWorld> | null = null;
  afterEach(() => { w?.close(); w = null; });
  // Titles with no model name or number: everything after the brand is a generic word.
  const throwA: MiniProduct = { id: "hw_linen", title: "Hanwell Portable Bluetooth Speaker", brand: "Hanwell", category: "speakers", categoryTitle: "Speakers", price: 59 };
  const throwB: MiniProduct = { id: "hw_wool", title: "Hanwell Waterproof Bluetooth Speaker", brand: "Hanwell", category: "speakers", categoryTitle: "Speakers", price: 89 };
  it("two model-less products of one brand get distinct identities; compare accepts model \"\" with its key and never mixes offers", async () => {
    w = miniWorld([throwA, throwB]);
    const out: any = await w.app.gateway.researchPurchase("alice", { request: "a bluetooth speaker under $100" });
    const cands = out.candidates.filter((c: any) => c.identity.brand === "Hanwell");
    expect(cands).toHaveLength(2);
    for (const c of cands) { expect(c.identity.model).toBe(""); expect(c.identity.sku).toMatch(/^ch3:hw_/); }
    expect(new Set(cands.map((c: any) => c.identity.sku)).size).toBe(2);
    const linen = cands.find((c: any) => c.identity.sku === "ch3:hw_linen");
    const cmp: any = await w.app.gateway.compareOffers("alice", { researchSessionId: out.purchaseSessionId, productIdentity: linen.identity, destination: CA });
    const all = [...cmp.eligibleOffers, ...cmp.ineligibleOffers];
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((o: any) => o.offerId.startsWith("ch3:hw_linen:"))).toBe(true);
  });
  it("a model-less identity without its key is refused (it could name any product of the brand)", async () => {
    w = miniWorld([throwA, throwB]);
    const out: any = await w.app.gateway.researchPurchase("alice", { request: "a bluetooth speaker under $100" });
    await expect(w.app.gateway.compareOffers("alice", { researchSessionId: out.purchaseSessionId, productIdentity: { brand: "Hanwell", model: "", variant: null, condition: "new", sku: null } as any, destination: CA }))
      .rejects.toMatchObject({ code: "IDENTITY_MISMATCH" });
  });
  it("the MCP schema accepts model \"\" (the gateway then requires the key)", async () => {
    const h: Harness = await startHarness();
    try {
      const client = await mcpClient(h.url, TOKENS.alice);
      const r = await call(client, "research_purchase", { request: "Buy Sony WH-CH720N Black, never exceed $100", currency: "USD" });
      const e = await callError(client, "compare_purchase_offers", { researchSessionId: r.purchaseSessionId, productIdentity: { brand: "Sony", model: "", variant: null, condition: "new", sku: null }, destination: CA });
      expect(e.code).toBe("IDENTITY_MISMATCH"); // not a schema (PROTOCOL / invalid params) error
      await client.close();
    } finally { await h.close(); }
  });
});

describe("N-07: Korean requests and accessory requests", () => {
  it.each([
    ["앰버 조명 되는 전자책 리더기 20만원 이하", "e-reader"],
    ["IH 압력 밥솥 30만원 이하", "IH rice cooker"],
    ["노트북 충전기 5만원 이하", "laptop charger"],
    ["헤드폰 케이스", "headphones case"],
  ])("%s → English query %s (no Hangul is sent to the provider)", (r, q) => {
    const i = parse(r);
    expect(i.queries.primary).toBe(q);
    expect(i.queries.primary).not.toMatch(/\p{Script=Hangul}/u);
    if (i.queries.fallback) expect(i.queries.fallback).not.toMatch(/\p{Script=Hangul}/u);
  });
  it("a Korean request with no product word makes no catalog call and does not recommend", async () => {
    const w = miniWorld([{ id: "x1", title: "Ostra Wave 300 Speaker", brand: "Ostra", category: "speakers", categoryTitle: "Speakers", price: 99 }]);
    try {
      const out: any = await w.app.gateway.researchPurchase("alice", { request: "가성비 좋은 것 추천해줘" });
      expect(w.counters.channel3Search).toBe(0);
      expect(out.decision.state).not.toBe("RECOMMEND");
      expect(out.intent.v2.queries.primary).toBe("");
    } finally { w.close(); }
  });
  it.each([["laptop charger under $60", null], ["a sleeve for a 14 inch laptop", null], ["headphones for running", "headphones"], ["노트북 충전기", null], ["a laptop under $900", "laptops"], ["무선 헤드폰", "headphones"]])(
    "%s → request category %s (an accessory of a category is not that category)", (r, cat) => {
      expect(requestCategory(r)?.id ?? null).toBe(cat);
    });
  it("controls: Korean category requests still query in English", () => {
    expect(parse("무선 헤드폰 20만원 이하").queries.primary).toMatch(/headphones/);
    expect(parse("무선 청소기").queries.primary).toMatch(/vacuum cleaner/);
  });
});

describe("R-C: the budget-increase warning reads the request with the research parser", () => {
  it("statedBudget keeps currency and magnitude", () => {
    expect(statedBudget("노이즈 캔슬링 헤드폰 30만원 이하")).toMatchObject({ currency: "KRW", budgetMinor: 300_000 });
    expect(statedBudget("laptop under $1.2k")).toMatchObject({ currency: "USD", budgetMinor: 120_000 });
    expect(statedBudget("headphones, max 90").bareAmountMinor("USD")).toBe(9_000);
  });
  it("a KRW amount in a USD session is shown as KRW, never compared as 30 dollars", async () => {
    const h: Harness = await startHarness();
    try {
      const client = await mcpClient(h.url, TOKENS.alice);
      const r = await call(client, "research_purchase", { request: "노이즈 캔슬링 헤드폰 30만원 이하", currency: "USD" });
      const p = await call(client, "resolve_research_hold", { purchaseSessionId: r.purchaseSessionId, kind: "CONFIRM_BUDGET", budgetMinor: 25_000, currency: "USD", userStatement: "user wants $250" });
      const rv = await fetch(p.ownerConfirmationUrl, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: h.url }, body: new URLSearchParams({ action: "review", ownerKey: OWNER.alice }).toString() });
      const html = await rv.text();
      expect(html).toMatch(/your request states 300,?000 KRW, a different currency/);
      expect(html).not.toMatch(/higher than the amount in your request \(30\.00/);
      await client.close();
    } finally { await h.close(); }
  });
});

describe("KRW policy: correct parsing is not market-price verification", () => {
  let w: ReturnType<typeof miniWorld> | null = null;
  afterEach(() => { w?.close(); w = null; });
  it("a KRW budget in a KRW session is kept as parsed (not unresolved, not converted)", () => {
    const i = parse("무선 헤드폰 20만원 이하");
    expect(i).toMatchObject({ currency: "KRW", budgetMinor: 200_000, budgetUnresolved: null, budgetConflict: null });
  });
  it("with USD-only listings, a KRW session never recommends and never claims budget compliance", async () => {
    w = miniWorld([{ id: "ah1", title: "Corvel Arc Wireless Headphones", brand: "Corvel", category: "headphones", categoryTitle: "Headphones", price: 99 }]);
    const out: any = await w.app.gateway.researchPurchase("alice", { request: "무선 헤드폰 20만원 이하" });
    expect(out.intent.v2 ?? out.intent).toBeTruthy();
    expect(out.decision.state).not.toBe("RECOMMEND");
    expect(["HOLD", "INVESTIGATE", "NO_MATCH"]).toContain(out.decision.state);
    const text = JSON.stringify(out.decision);
    expect(text).toMatch(/PRICE_NOT_IN_REQUESTED_CURRENCY|currency/i);
    expect(text).not.toMatch(/within budget/i);
  });
});
