/**
 * Post-submission loop, cycle 1 (F5): one canonical (number, unit) token in a model name, and a lowercase brand that is
 * only a guess until the catalog lists it. Builder-written fictional products only (Kelbrook, Moravel, Ostrel, Fennick,
 * Larkspur, Quillby); nothing is copied from any IW set.
 */
import { describe, expect, it } from "vitest";
import { parseResearchIntent } from "../src/intent/ResearchIntentV2.js";
import { canonicalUnits, extractIdentity } from "../src/identity/ProductIdentityExtractor.js";
import { resolveExactV2 } from "../src/identity/ProductResolverV2.js";

const intent = (request: string) => parseResearchIntent({ request } as any) as any;
const product = (id: string, title: string, brand: string, category = "unknown"): any =>
  ({ productId: id, title, category, identity: { ...extractIdentity(title, brand), brand, variant: null, condition: "new", sku: null }, description: null, capabilities: [], offers: [] });
const offers = (id: string) => [{ productId: id, offerId: `o-${id}`, availability: "IN_STOCK", currency: "USD", itemPriceMinor: 5000, listedIdentity: { condition: "new" } }] as any;
const lockOf = (request: string, listings: any[]) => { const r: any = resolveExactV2(intent(request), listings, offers); return r.status === "LOCKED" ? r.productId : r.status; };

const reels = [
  product("r75", "Kelbrook Arden 75ft Hose Reel", "Kelbrook", "hose-reels"),
  product("r125", "Kelbrook Arden 125ft Hose Reel", "Kelbrook", "hose-reels"),
  product("r125x", "Kelbrook Arden 125ft Swivel Hose Reel", "Kelbrook", "hose-reels"),
];
const chargers = [product("c6", "Moravel Spire 6A Battery Charger", "Moravel"), product("c12", "Moravel Spire 12A Battery Charger", "Moravel")];

describe("cycle 1: a quantity in a model name has one spelling", () => {
  it("spaced, hyphenated and spelled units become the joined token", () => {
    expect(canonicalUnits("Arden 125 ft")).toBe("Arden 125ft");
    expect(canonicalUnits("Arden 125-foot Swivel")).toBe("Arden 125ft Swivel");
    expect(canonicalUnits("Spire 12-amp")).toBe("Spire 12A");
    expect(canonicalUnits("Spire 12 A charger")).toBe("Spire 12A charger");
    expect(canonicalUnits("Vane 46 centimeter")).toBe("Vane 46cm");
    expect(canonicalUnits('Gate 36" wide')).toBe("Gate 36in wide");
    expect(canonicalUnits("Tank 55 gallon")).toBe("Tank 55gal");
    expect(canonicalUnits("Burner 9-kilowatt")).toBe("Burner 9kW");
  });
  it("a lowercase article, a spaced 'in' and plain numbers are left alone", () => {
    expect(canonicalUnits("for a 10 a day habit")).toBe("for a 10 a day habit");
    expect(canonicalUnits("40 in the box")).toBe("40 in the box");
    expect(canonicalUnits("2 Burner")).toBe("2 Burner");
  });
  it("ft is a model unit like in: siblings of different lengths are different models", () => {
    expect(extractIdentity("Kelbrook Arden 75ft Hose Reel", "Kelbrook").model).toBe("Arden 75ft");
    expect(extractIdentity("Kelbrook Arden 125ft Hose Reel", "Kelbrook").model).toBe("Arden 125ft");
  });
  it("every spelling of the requested length locks that length, and only that one", () => {
    for (const r of ["Kelbrook Arden 125ft hose reel", "Kelbrook Arden 125 ft", "Kelbrook Arden 125-foot hose reel", "Kelbrook Arden 125 feet"]) expect(lockOf(r, reels)).toBe("r125");
    expect(lockOf("Kelbrook Arden 125-foot Swivel", reels)).toBe("r125x");
    expect(lockOf("Kelbrook Arden 75 ft", reels)).toBe("r75");
    expect(lockOf("Moravel Spire 12-amp charger", chargers)).toBe("c12");
    expect(lockOf("Moravel Spire 12 A charger", chargers)).toBe("c12");
  });
  it("negative controls: a length nobody lists locks nothing; a threshold is never a model", () => {
    expect(lockOf("Kelbrook Arden 100 ft", reels)).not.toMatch(/^r/);
    const t = intent("hose reel for at least 100 feet of hose");
    expect(t.target).toBeNull();
    expect(t.unresolvedMust).toContain("unrecognized:at-least-100-feet");
  });
  it("words after a spelled unit stay part of the request (no lost sibling tail)", () => {
    const i = intent("Ostrel Brazier 9-kilowatt Ducted heater");
    expect(i.target.model).toBe("Brazier 9kW");
    expect(i.requestTail).toEqual(["Ducted", "heater"]);
    expect(i.uninterpreted).toEqual([]);
  });
});

describe("cycle 1: a lowercase brand is a guess the catalog must confirm", () => {
  it("brand + name + unit model in lowercase is read as that brand, with a no-brand fallback", () => {
    const i = intent("fennick lumen 46cm");
    expect(i.target).toMatchObject({ brand: "fennick", model: "lumen 46cm" });
    expect(i.brandGuess.brand).toBe("fennick");
    expect(i.brandGuess.fallback.target).toBeNull();
    expect(i.brandGuess.fallback.mode).toBe("PRODUCT_DISCOVERY");
  });
  it("a capitalized brand is never a guess", () => {
    expect(intent("Fennick Lumen 46cm").brandGuess).toBeUndefined();
  });
});

describe("cycle 1 (F3): a part noun inside the host's own product noun is not the part", () => {
  const listings = [product("reel", "Larkspur Tidy 90ft Retract Hose Reel", "Larkspur", "hose-reels"), product("lead", "Larkspur Tidy Lead Hose", "Larkspur", "hose-reel-accessories")];
  it("'lead hose for the Tidy 90ft Retract' never locks the hose reel", () => {
    expect(lockOf("lead hose for the Larkspur Tidy 90ft Retract", listings)).not.toBe("reel");
  });
  it("a part that is the head noun after the model still counts as that part", () => {
    const belt = [product("belt", "Quillby Rota 3 Replacement Belt", "Quillby")];
    expect(lockOf("Quillby Rota 3 belt", belt)).toBe("belt");
  });
});
