/**
 * V2.4: generic fixes after the first scored IW-5 run (IW-5 is now seen; these tests use builder-written fictional
 * products only: Corvan, Mirelle, Toska, Pellan, Quillon, Abrin). Nothing is copied from any IW set.
 */
import { describe, expect, it } from "vitest";
import { clauseStatement } from "../src/research/capabilities.js";
import { parseResearchIntent } from "../src/intent/ResearchIntentV2.js";
import { extractIdentity } from "../src/identity/ProductIdentityExtractor.js";
import { statementFrom } from "../src/evidence/EvidenceV2.js";

const intent = (request: string) => parseResearchIntent({ request } as any) as any;
const product = (title: string, brand: string): any => ({ productId: "x", title, identity: { ...extractIdentity(title, brand), variant: null }, description: null, capabilities: [], offers: [] });

describe("V2.4 numbers and units", () => {
  it("thousands separators and decimals are never cut", () => {
    expect(intent("air fryer with at least 1,700 W power").unresolvedMust).toEqual(["unrecognized:at-least-1700-w-power"]);
    expect(intent("hiking pack under 0.9 kg").unresolvedMust).toContain("unrecognized:at-most-0.9-kg");
  });
  it("a stated value with thousands satisfies or fails a threshold", () => {
    expect(clauseStatement("Peak output is 1,800 W.", "unrecognized:at-least-1700-w-power")).toBe(null); // "power" not stated
    expect(clauseStatement("Peak power is 1,800 W.", "unrecognized:at-least-1700-w-power")).toBe(true);
    expect(clauseStatement("Peak power is 1,500 W.", "unrecognized:at-least-1700-w-power")).toBe(false);
  });
  it("a bare spec inside a longer requirement is not a second claim", () => {
    expect(intent("the Corvan GX-2 kit with the 60W charger").unresolvedMust).toEqual(["unrecognized:60w-charger"]);
  });
  it("a capacity in words or digits is the same", () => {
    expect(intent("dome tent for three people").unresolvedMust).toContain("unrecognized:3-person");
    expect(clauseStatement("It is a three-person dome tent.", "unrecognized:3-person")).toBe(true);
  });
});

describe("V2.4 requirement wording", () => {
  it("a contracted negation excludes the capability", () => {
    const i = intent("office chair that isn't wireless");
    expect(i.mustHave).not.toContain("wireless");
    expect(i.unresolvedMust).toContain("not:wireless");
    expect(i.uninterpreted).toEqual([]);
  });
  it("'is good with X' is one evaluative claim, judged by wording, not by exact words", () => {
    expect(intent("air purifier that is good with cat dander").unresolvedMust).toEqual(["unrecognized:good-with-cat-dander"]);
    const id = "unrecognized:good-with-cat-dander";
    expect(clauseStatement("It handled cat dander very well in our tests.", id)).toBe(true);
    expect(clauseStatement("It struggled with cat dander.", id)).toBe(false);
    expect(clauseStatement("It is not good with cat dander.", id)).toBe(false);
    expect(clauseStatement("We tested cat dander removal.", id)).toBe(null);
  });
  it("'Xs itself' is the self-X property", () => {
    expect(intent("window robot that cleans itself").unresolvedMust).toContain("unrecognized:self-cleaning");
  });
  it("a measurement verb is not a requirement of its own", () => {
    expect(intent("tripod that weighs less than 1.1 kg").unresolvedMust).toEqual(["unrecognized:at-most-1.1-kg"]);
  });
  it("a negation in another predicate does not deny the phrase", () => {
    expect(clauseStatement("The Toska T4 Espresso Machine has a steel boiler and is not programmable.", "unrecognized:steel-boiler")).toBe(true);
  });
});

describe("V2.4 structural guard noise", () => {
  it("product-type words, decorative nouns, Korean endings and contractions are not uninterpreted", () => {
    expect(intent("pellet smoker under $500").uninterpreted).toEqual([]);
    expect(intent("pellet smoker under $500").productTypeWords).toEqual(["pellet", "smoker"]);
    expect(intent("desk lamp, ideally dimmable, minimalist design").uninterpreted).toEqual([]);
    expect(intent("Abrin AQ-3 가습기 사고 싶어요").uninterpreted).toEqual([]);
  });
  it("a word that is neither still blocks", () => {
    expect(intent("pellet smoker under $500, frobnicated").uninterpreted.map((u: any) => u.text)).toEqual(["frobnicated"]);
  });
});

describe("V2.4 identity", () => {
  it("a part named after the model is an accessory of it", () => {
    expect(extractIdentity("Pellan Arc 3 Replacement Ear Cushions", "Pellan")).toMatchObject({ model: "Arc 3", kind: "ACCESSORY" });
    expect(extractIdentity("Mirelle Dome 4 Footprint", "Mirelle")).toMatchObject({ model: "Dome 4", kind: "ACCESSORY" });
    expect(extractIdentity("Mirelle Dome 4 Camping Tent", "Mirelle")).toMatchObject({ model: "Dome 4", kind: "STANDALONE" });
  });
  it("a descriptive word after a numbered name is not the model; a family suffix is", () => {
    expect(extractIdentity("Corvan GX-2 Lite Gaming Mouse", "Corvan").model).toBe("GX-2 Lite");
    expect(extractIdentity("Quillon Nook 6 Waterproof E-Reader", "Quillon").model).toBe("Nook 6");
  });
  it("a request that names the product locks it, unless it compares", () => {
    expect(intent("Mirelle Dome 4 tent")).toMatchObject({ mode: "EXACT_PRODUCT_PURCHASE", lockBasis: "NAMED", target: { model: "Dome 4", kind: "STANDALONE" } });
    expect(intent("replacement ear cushions for my Pellan Arc 3").target).toMatchObject({ model: "Arc 3", kind: "ACCESSORY" });
    expect(intent("something like the Mirelle Dome 4 but cheaper").mode).toBe("PRODUCT_DISCOVERY");
    expect(intent("tent with an H13 rating").mode).toBe("PRODUCT_DISCOVERY");
  });
  it("'backpacking tent' is not a backpack", () => {
    expect(intent("backpacking tent under $300").category).not.toBe("backpacks");
  });
});

describe("V2.4 attribution", () => {
  it("a component chemistry and a unit after a number are not other products", () => {
    const p = product("Abrin PB-20 Power Bank", "Abrin");
    expect(statementFrom({ title: "Abrin PB-20 specifications", snippet: "The Abrin PB-20 Power Bank stores 74 Wh in a LiPo battery and charges at 2,000 mA." }, p, "unrecognized:at-least-70-wh")).toMatchObject({ value: true });
  });
});
