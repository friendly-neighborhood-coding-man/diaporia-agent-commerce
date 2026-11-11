/**
 * V2.3: closes the V2.2 independent-review findings with generic rules (spec numbers, relative clauses, named
 * model-less binding, numeric thresholds, joined requirements, the structural guard for words nothing interpreted,
 * port counts that are not model numbers, sibling pages, network speeds that are not memory). Builder-written fictional
 * products and pages only (Kestrel, Voltaro-like "Brisk", Pellan, Marlow); nothing from IW-1.1, IW-2, IW-3 or IW-4.
 */
import { afterEach, describe, expect, it } from "vitest";
import { clauseStatement, numericProposition } from "../src/research/capabilities.js";
import { parseResearchIntent } from "../src/intent/ResearchIntentV2.js";
import { extractIdentity, parseAttributes } from "../src/identity/ProductIdentityExtractor.js";
import { statementFrom } from "../src/evidence/EvidenceV2.js";
import { CA, OWNER, SONY_BLACK, TOKENS, call, mcpClient, ownerConfirmsHold, startHarness, type Harness } from "./helpers.js";
import { miniWorld, type MiniHit, type MiniProduct } from "./helpers/miniWorld.js";

const intent = (request: string) => parseResearchIntent({ request } as any) as any;

describe("V2.3 requirement extraction", () => {
  it("a spec number before a capability is its own MUST proposition (never dropped)", () => {
    const i = intent("Brisk power bank with 140W USB-C charging under $90");
    expect(i.unresolvedMust).toContain("unrecognized:140w-usb-c-charging");
  });
  it("a relative clause states a requirement", () => {
    expect(intent("a rain jacket that rolls into its own hood, under $150").unresolvedMust).toContain("unrecognized:rolls-into-its-own-hood");
    expect(intent("a lamp that must have a warm dimming curve").unresolvedMust).toEqual(["unrecognized:warm-dimming-curve"]);
  });
  it("numeric thresholds keep the number and the direction", () => {
    expect(intent("coffee grinder with at least 25 grind settings under $120").unresolvedMust).toContain("unrecognized:at-least-25-grind-settings");
  });
  it("joined requirements are verified one by one", () => {
    const i = intent("router with Wi-Fi 7 and 10 Gb Ethernet under $250");
    expect(i.unresolvedMust).toEqual(expect.arrayContaining(["unrecognized:wi-fi-7", "unrecognized:10-gb-ethernet"]));
    expect(i.attributes.memory).toBeUndefined();
  });
  it("a named model-less product binds its model name", () => {
    expect(intent("Buy the Pellan Drift trail running shoes").requestedModel).toBe("Drift");
  });
  it("a currency code is never a brand", () => {
    expect(intent("electric kettle, USD 80 max").target?.brand ?? null).toBeNull();
  });
  it("Korean is head-final: the last product noun is the product", () => {
    expect(intent("노트북 충전기 5만원 이하").queries.primary).toMatch(/charger/);
  });
});

describe("V2.3 numeric statements", () => {
  it.each([
    ["Supports 140W USB-C charging.", "unrecognized:140w-usb-c-charging", true],
    ["Supports 65W USB-C charging.", "unrecognized:140w-usb-c-charging", false],
    ["USB-C with 90 W power delivery.", "unrecognized:at-least-65-w-usb-c-power-delivery", true],
    ["USB-C with 45W power delivery.", "unrecognized:at-least-65-w-usb-c-power-delivery", false],
    ["It has 40 grind settings.", "unrecognized:at-least-25-grind-settings", true],
    ["It has 12 grind settings.", "unrecognized:at-least-25-grind-settings", false],
    ["Noise is 28 dB.", "unrecognized:at-most-30-db", true],
    ["It has no 140W charging.", "unrecognized:140w", null],
  ])("%s → %s = %s", (clause, id, v) => { expect(clauseStatement(clause, id)).toBe(v); });
  it("parses the threshold", () => {
    expect(numericProposition("unrecognized:at-least-65-w-usb-c-power-delivery")).toMatchObject({ dir: "AT_LEAST", n: 65, unit: "w" });
  });
});

describe("V2.3 identity and attribution", () => {
  it("a port count or a technology acronym is not part of the model", () => {
    expect(extractIdentity("Brisk 140W GaN USB-C Charger, 4-Port", "Brisk").model).toBeNull();
    expect(extractIdentity("Marlow MC-8 IH Rice Cooker, 8-Cup", "Marlow")).toMatchObject({ model: "MC-8", modelBasis: "MODEL_NUMBER" });
  });
  it("network speed is not memory", () => {
    expect(parseAttributes("router with 10 Gb Ethernet")).toEqual({});
    expect(parseAttributes("laptop with 16GB RAM").memory).toBe("16GB");
  });
  it("a sibling page that does not state the title's spec is not attributed to a model-less product", () => {
    const title = "Brisk 140W GaN USB-C Laptop Charger, 4-Port";
    const p: any = { productId: "x", title, identity: { ...extractIdentity(title, "Brisk"), variant: null }, description: null, capabilities: [], offers: [] };
    expect(statementFrom({ title: "Brisk 65W GaN charger", snippet: "Brisk 65W GaN laptop charger: two ports, 65 W maximum output." }, p, "unrecognized:140w")).toBeNull();
    expect(statementFrom({ title: "Brisk 140W GaN charger", snippet: "Brisk 140W GaN laptop charger: four ports and 140 W USB-C Power Delivery." }, p, "unrecognized:140w")).toMatchObject({ value: true });
  });
  it("'per dose' is not reported speech; units and cooking styles are not other products", () => {
    const title = "Marlow MG-7 Coffee Grinder";
    const p: any = { productId: "y", title, identity: { ...extractIdentity(title, "Marlow"), variant: null }, description: null, capabilities: [], offers: [] };
    expect(statementFrom({ title: "Marlow MG-7 tested", snippet: "We measured the Marlow MG-7 at 0.1 g per dose, which is low retention." }, p, "unrecognized:low-retention")).toMatchObject({ value: true });
    expect(statementFrom({ title: "Marlow MG-7 specs", snippet: "The Marlow MG-7 has 30 grind settings, from espresso to French press, and runs at 40 °C." }, p, "unrecognized:at-least-25-grind-settings")).toMatchObject({ value: true });
  });
});

describe("V2.3 structural guard (words nothing interpreted)", () => {
  it("reports content words that became neither identity, requirement, category nor money", () => {
    expect(intent("wireless headphones under $200, zorblyfied").uninterpreted.map((u: any) => u.text)).toEqual(["zorblyfied"]);
    expect(intent("Buy Sony WH-CH720N Black for the lowest total price, never exceed $100").uninterpreted).toEqual([]);
  });

  let w: ReturnType<typeof miniWorld> | null = null;
  afterEach(() => { w?.close(); w = null; });
  const K9: MiniProduct = { id: "k9", title: "Kestrel K9 Wireless Headphones", brand: "Kestrel", category: "headphones", categoryTitle: "Headphones", price: 129 };
  const manu: MiniHit = { match: /Kestrel K9/i, title: "Kestrel K9 specifications", url: "https://kestrel-audio.example/k9", content: "The Kestrel K9 is wireless." };
  it("never RECOMMENDs while a word is uninterpreted; the same request without it does", async () => {
    w = miniWorld([K9], [manu], { officialDomains: { Kestrel: ["kestrel-audio.example"] } });
    const ok: any = await w.app.gateway.researchPurchase("alice", { request: "Buy the Kestrel K9 wireless headphones" });
    expect(ok.decision.state).toBe("RECOMMEND");
    w.close();
    w = miniWorld([K9], [manu], { officialDomains: { Kestrel: ["kestrel-audio.example"] } });
    const guarded: any = await w.app.gateway.researchPurchase("alice", { request: "Buy the Kestrel K9 wireless headphones, zorblyfied" });
    expect(guarded.decision.state).not.toBe("RECOMMEND");
    expect(guarded.decision.ranking[0].blockers.map((b: any) => b.code)).toContain("REQUEST_UNINTERPRETED");
  });

  let h: Harness | null = null;
  afterEach(async () => { await h?.close(); h = null; });
  it("the owner can attest an uninterpreted word through the protected flow; recorded as OWNER_ATTESTED, never VERIFIED", async () => {
    h = await startHarness();
    const client = await mcpClient(h.url, TOKENS.alice);
    const r = await call(client, "research_purchase", { request: "Buy Sony WH-CH720N Black for the lowest total price, never exceed $100, zorblyfied", currency: "USD" });
    const KEY = "must:uninterpreted:zorblyfied";
    const before = await call(client, "compare_purchase_offers", { researchSessionId: r.purchaseSessionId, productIdentity: SONY_BLACK, destination: CA });
    expect(before.purchaseReadiness.open.join(" ")).toContain("uninterpreted:zorblyfied");
    const p = await call(client, "resolve_research_hold", { purchaseSessionId: r.purchaseSessionId, kind: "ATTEST_REQUIREMENT", requirement: KEY, currency: "USD", userStatement: "The user means the matte finish." });
    expect((await ownerConfirmsHold(p.ownerConfirmationUrl, OWNER.alice)).status).toBe(200);
    const after = await call(client, "compare_purchase_offers", { researchSessionId: r.purchaseSessionId, productIdentity: SONY_BLACK, destination: CA });
    expect(after.requirementStatus.find((x: any) => x.key === KEY)).toMatchObject({ verification: "OWNER_ATTESTED" });
    expect(after.purchaseReadiness.open.join(" ")).not.toContain("zorblyfied");
    await client.close();
  });
});
