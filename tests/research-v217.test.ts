/**
 * V2.17: IW-17 is SEEN; these tests use builder-written fictional products only (Corvan, Mirelle, Toska, Pellan,
 * Quillon, Abrin, Contoso). Nothing is copied from any IW set.
 */
import { describe, expect, it } from "vitest";
import { parseResearchIntent } from "../src/intent/ResearchIntentV2.js";
import { extractIdentity } from "../src/identity/ProductIdentityExtractor.js";

const intent = (request: string) => parseResearchIntent({ request } as any) as any;

describe("V2.17 every request word is accounted for", () => {
  it("a generic word that describes the product is a must-have, never dropped", () => {
    expect(intent("air cycling trainer").unresolvedMust).toContain("unrecognized:air");
  });
  it("a trailing restriction is a must-have; a purpose phrase stays background", () => {
    expect(intent("Toska tower fan, heating only").unresolvedMust).toContain("unrecognized:heating");
    expect(intent("Corvan Q5 headphones for my daily commute").unresolvedMust).toEqual([]);
  });
});

describe("V2.17 any number with a unit next to a word-only name is the model", () => {
  it("joined and spaced forms are the same model", () => {
    expect(intent("Toska Haul 70lb winch").target.model).toBe("Haul 70lb");
    expect(intent("Toska Haul 70 lb winch").target.model).toBe("Haul 70lb");
    expect(intent("Pellan Split 9 T log splitter").target.model).toBe("Split 9T");
    expect(extractIdentity("Toska Haul 45lb Winch", "Toska").model).toBe("Haul 45lb");
  });
});
