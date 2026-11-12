/**
 * V2.16: IW-16 is SEEN; these tests use builder-written fictional products only (Corvan, Mirelle, Toska, Pellan,
 * Quillon, Abrin, Contoso). Nothing is copied from any IW set.
 */
import { describe, expect, it } from "vitest";
import { parseResearchIntent } from "../src/intent/ResearchIntentV2.js";
import { extractIdentity } from "../src/identity/ProductIdentityExtractor.js";
import { numberTokensCompatible } from "../src/research/Channel3ResearchAdapter.js";

const intent = (request: string) => parseResearchIntent({ request } as any) as any;

describe("V2.16 listings with different number tokens are never one product", () => {
  it("only titles whose numbers contain each other may merge", () => {
    expect(numberTokensCompatible("Toska Brim 4G Water Tank", "Toska Brim 9G Water Tank")).toBe(false);
    expect(numberTokensCompatible("Toska Brim 9G Water Tank", "Toska Brim 9G Water Tank, 120V")).toBe(true);
  });
});

describe("V2.16 any unit letter after a word-only name is the model number", () => {
  it("keeps the code in requests and titles", () => {
    expect(intent("Toska Brim 4G water tank").target.model).toBe("Brim 4G");
    expect(intent("Quillon Dune 3P tent").target.model).toBe("Dune 3P");
    expect(extractIdentity("Toska Brim 9G Water Tank", "Toska").model).toBe("Brim 9G");
  });
  it("a dimension string or a letter code after the number is never the model", () => {
    expect(extractIdentity("Contoso Loft 220 Printer, Auto Level, 220x220x250mm", "Contoso").model).toBe("Loft 220");
    expect(extractIdentity("Contoso Loft 300 3D Printer", "Contoso").model).toBe("Loft 300");
  });
});

describe("V2.16 nothing asked for 'for the <model>' resolves to the model itself", () => {
  it("a noun phrase ending in set or kit is a part", () => {
    expect(intent("drain hose set for the Toska Brim 9G").target.kind).toBe("ACCESSORY");
    expect(intent("price check for the Pellan Arc 90").target.kind).toBe("STANDALONE");
  });
});

describe("V2.16 a request word never vanishes", () => {
  it("'sealed' that describes the product is checked, a factory seal is the condition", () => {
    const w = intent("weather sealed Abrin trail camera");
    expect(JSON.stringify([w.uninterpreted, w.unresolvedMust])).toContain("sealed");
    expect(intent("Corvan Q5 headphones, factory sealed").uninterpreted.map((u: any) => u.text)).not.toContain("sealed");
  });
  it("a dishwasher is a product, only 'dishwasher safe' is the feature", () => {
    expect(intent("compact dishwasher for a small kitchen").mustHave).not.toContain("dishwasher_safe");
    expect(intent("kettle with a dishwasher-safe lid").mustHave).toEqual(["dishwasher_safe"]);
  });
});
