import { describe, expect, it } from "vitest";
import { claimsOf, nameSubject, pageSubject, statementFor, describe as d } from "../src/verification/SubjectBinding.js";

// Fictional products only (no evaluation-set names). Each test states a general mechanism, not a phrase.
const P = (id: string, title: string, brand: string, model: string, category = "x") => ({ productId: id, title, identity: { brand, model }, category } as any);
const LIST = [
  P("w10", "Marlowe Tidal 10 Kayak", "Marlowe", "Tidal 10"),
  P("w10t", "Marlowe Tidal 10 Touring Kayak", "Marlowe", "Tidal 10"),
  P("w12", "Marlowe Tidal 12 Kayak", "Marlowe", "Tidal 12"),
  P("skirt", "Marlowe Tidal 10 Spray Skirt", "Marlowe", "Tidal 10"),
];

describe("E4.1 shared subject binder", () => {
  it("a page title that adds a variant word names that variant, never the base listing", () => {
    expect(d(pageSubject("Marlowe Tidal 10 Touring Kayak specifications", LIST))).toBe("w10t");
    expect(d(pageSubject("Marlowe Tidal 10 Kayak specifications", LIST))).toBe("w10");
  });
  it("a page title that continues the model with a product noun is about that other product", () => {
    expect(d(pageSubject("Marlowe Tidal 10 Spray Skirt", LIST))).toBe("skirt");
    expect(pageSubject("Marlowe Tidal 12 Cockpit Cover", LIST).kind).toBe("OTHER");
  });
  it("a pronoun claim on an accessory page never contradicts the host", () => {
    const cl = claimsOf({ title: "Marlowe Tidal 12 Cockpit Cover", snippet: "It is a cockpit cover, not a kayak." }, LIST);
    expect(statementFor(cl, "w12", "unrecognized:kayak").value).toBeNull();
  });
  it("a contrast 'A, not B' is a denial of B even when A matches the same requirement lexicon", () => {
    const cl = claimsOf({ title: "Marlowe Tidal 12 Kayak specifications", snippet: "The hull is water-resistant, not waterproof." }, LIST);
    expect(statementFor(cl, "w12", "waterproof").value).toBe(false);
  });
  it("a condition lead makes the claim conditional: it neither credits nor contradicts the product", () => {
    const cl = claimsOf({ title: "Marlowe Tidal 12 Cockpit Cover", snippet: "With the cockpit cover fitted, the Tidal 12 is fully waterproof." }, LIST);
    const st = statementFor(cl, "w12", "waterproof");
    expect(st.value).toBeNull();
    expect(st.conditional?.condition).toMatch(/cockpit cover/);
  });
  it("a comparison lead keeps the main clause's own subject", () => {
    const cl = claimsOf({ title: "Marlowe Tidal 10 Touring Kayak specifications", snippet: "Unlike the Tidal 10, the Marlowe Tidal 10 Touring Kayak has a rudder." }, LIST);
    expect(statementFor(cl, "w10t", "unrecognized:rudder").value).toBe(true);
    expect(statementFor(cl, "w10", "unrecognized:rudder").value).toBeNull();
  });
  it("a sentence subject without its product noun binds to the plain listing, not to a variant or a part", () => {
    expect(d(nameSubject("the Tidal 10", LIST, true))).toBe("w10");
    expect(d(nameSubject("the Tidal 10 Spray Skirt", LIST, true))).toBe("skirt");
    // An attribute after the model is the model's own ("the Tidal 10 seat height").
    expect(d(nameSubject("the Tidal 10 seat height", LIST, true))).toBe("w10");
  });
  it("retailer titles of one model that differ only by descriptors all share a page that names just the model", () => {
    const L = [P("a", "Quenby Q7 Wireless Headphones", "Quenby", "Q7"), P("b", "Quenby Q7 Wireless Noise Cancelling Headphones", "Quenby", "Q7")];
    const s = pageSubject("Quenby Q7 specifications", L);
    expect(s.kind).toBe("LISTING");
    expect(d(s).split("+").sort()).toEqual(["a", "b"]);
  });
  it("a negated sentence about a sibling never contradicts the variant that has the feature", () => {
    const cl = claimsOf({ title: "Marlowe Tidal 10 Kayak specifications", snippet: "It has no rudder." }, LIST);
    expect(statementFor(cl, "w10", "unrecognized:rudder").value).toBe(false);
    expect(statementFor(cl, "w10t", "unrecognized:rudder").value).toBeNull();
  });
});
