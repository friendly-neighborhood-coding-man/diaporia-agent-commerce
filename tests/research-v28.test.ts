/**
 * V2.8: fail closed on dropped name words and category clashes after the first scored IW-9 run (IW-9 is now seen; these
 * tests use builder-written fictional products only: Corvan, Mirelle, Toska, Pellan, Quillon, Abrin, Contoso).
 */
import { describe, expect, it } from "vitest";
import { parseResearchIntent } from "../src/intent/ResearchIntentV2.js";
import { extractIdentity } from "../src/identity/ProductIdentityExtractor.js";
import { resolveExactV2, targetNounMatch } from "../src/identity/ProductResolverV2.js";

const intent = (request: string) => parseResearchIntent({ request } as any) as any;
const product = (id: string, title: string, brand: string, category = "unknown"): any =>
  ({ productId: id, title, category, identity: { ...extractIdentity(title, brand), brand, variant: null, condition: "new", sku: null }, description: null, capabilities: [], offers: [] });
const offers = (id: string) => [{ productId: id, offerId: `o-${id}`, availability: "IN_STOCK", currency: "USD", itemPriceMinor: 5000, listedIdentity: { condition: "new" } }] as any;

describe("V2.8 a code after the model is part of the requested name", () => {
  it("'HD' and 'LED' after a model code stay in the model, spaced codes too", () => {
    expect(intent("Toska CM-4 HD baby monitor").target.model).toBe("CM-4 HD");
    expect(intent("Toska CM 4 HD baby monitor").target.model).toBe("CM 4 HD");
    expect(intent("Pellan TV-55 LED TV").target.model).toBe("TV-55 LED");
  });
  it("the plain model is never locked for the coded one, and the lock carries the full name", () => {
    const listings = [product("plain", "Toska CM-4 Video Baby Monitor", "Toska"), product("hd", "Toska CM-4 HD Video Baby Monitor", "Toska")];
    for (const req of ["Toska CM-4 HD baby monitor", "Toska CM 4 HD video baby monitor"]) {
      const r: any = resolveExactV2(intent(req), listings, offers);
      expect(r.status).toBe("LOCKED");
      expect(r.productId).toBe("hd");
      expect(r.identity.model.replace(/[\s-]/g, "")).toBe("CM4HD");
    }
  });
});

describe("V2.8 the product noun after the model is what the listing must be", () => {
  it("'<model> Headphones' never locks a product of another kind; it locks the headphones", () => {
    const i = intent("Corvan RD-7 Headphones");
    expect(i.targetNoun).toBe("headphones");
    const detector = product("det", "Corvan RD-7 Metal Detector", "Corvan");
    const phones = { ...product("ph", "Corvan RD-7 Headphones", "Corvan", "metal-detector-accessories"), identity: { brand: "Corvan", model: "RD-7", variant: null, condition: "new", sku: null } };
    expect(targetNounMatch(detector, "headphones")).toBe("NO");
    const r: any = resolveExactV2(i, [detector], offers);
    expect(r.status).toBe("NOT_FOUND");
    expect(r.excluded.find((e: any) => e.productId === "det").reason).toMatch(/not a headphones/);
    expect(targetNounMatch(phones, "headphones")).toBe("YES");
  });
  it("a noun of no known category is kept but unconfirmed; synonyms count", () => {
    expect(targetNounMatch(product("x", "Abrin Q4 Fish Finder", "Abrin"), "sonar unit")).toBe("UNKNOWN");
    expect(targetNounMatch(product("r", "Abrin T3 Two-Way Radio", "Abrin"), "walkie talkies")).toBe("YES");
  });
  it("words of the product noun are checked against the title, not left as unknown requirements", () => {
    const i = intent("Toska CM-4 HD video baby monitor");
    expect(i.uninterpreted).toEqual([]);
    expect(i.nounModifiers).toContain("video");
    const d = intent("waterproof metal detector for the beach under $240");
    expect(d.uninterpreted).toEqual([]);
    expect(d.productTypeWords).toEqual(expect.arrayContaining(["metal", "detector"]));
    expect(intent("ice maker that cleans itself, but not the nugget kind").uninterpreted.map((u: any) => u.text)).toContain("nugget");
  });
});

describe("V2.8 greetings and lowercase brands", () => {
  it("a greeting before the brand is never the brand", () => {
    expect(intent("Hello Quillon SD-6 soldering station please").target.brand).toBe("Quillon");
    expect(intent("Hey Mirelle KM-5 keyboard").target.brand).toBe("Mirelle");
  });
  it("a lowercase brand before a model code is read, and ordinary words are not", () => {
    const i = intent("quillon sd-6 pro");
    expect(i.target.brand.toLowerCase()).toBe("quillon");
    expect(i.target.model.toLowerCase()).toBe("sd-6 pro");
    expect(intent("kettle k9 under $50").target).toBeNull();
  });
});
