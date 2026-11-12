/**
 * V2.5: generic fixes after the first scored IW-6 run (IW-6 is now seen; these tests use builder-written fictional
 * products only: Corvan, Mirelle, Toska, Pellan, Quillon, Abrin). Nothing is copied from any IW set.
 */
import { describe, expect, it } from "vitest";
import { clauseStatement } from "../src/research/capabilities.js";
import { parseResearchIntent } from "../src/intent/ResearchIntentV2.js";
import { extractIdentity, mentionsExactModel } from "../src/identity/ProductIdentityExtractor.js";
import { resolveExactV2 } from "../src/identity/ProductResolverV2.js";

const intent = (request: string) => parseResearchIntent({ request } as any) as any;
const product = (id: string, title: string, brand: string): any => ({ productId: id, title, identity: { ...extractIdentity(title, brand), brand, variant: null, condition: "new", sku: null }, description: null, capabilities: [], offers: [] });

describe("V2.5 negation in a source statement", () => {
  it("a capability named only to deny it is false, never true", () => {
    expect(clauseStatement("The Toska Glow 3 charges over micro-USB, not USB-C.", "usb_c_charging")).toBe(false);
    expect(clauseStatement("It charges over micro-USB rather than USB-C.", "usb_c_charging")).toBe(false);
    expect(clauseStatement("Charging is via micro-USB (no USB-C).", "usb_c_charging")).toBe(false);
    expect(clauseStatement("USB-C charging is not supported.", "usb_c_charging")).toBe(false);
  });
  it("a plain statement still verifies", () => {
    expect(clauseStatement("It charges over USB-C in two hours.", "usb_c_charging")).toBe(true);
    expect(clauseStatement("Rechargeable via USB-C.", "usb_c_charging")).toBe(true);
  });
});

describe("V2.5 model sibling suffixes", () => {
  it("a capitalized suffix that ends the request stays in the model", () => {
    expect(intent("Pellan KX-40 Trio").target.model).toBe("KX-40 Trio");
    expect(intent("Pellan KX-40 Trio").requestedModel).toBe("KX-40 Trio");
  });
  it("descriptors, colours and product nouns are not suffixes", () => {
    expect(extractIdentity("Abrin Ridge 2 Backpacking Tent", "Abrin").model).toBe("Ridge 2");
    expect(extractIdentity("Pellan HR-9 Pressure Rice Cooker, 8 Cups", "Pellan").model).toBe("HR-9");
    expect(intent("Buy Corvan Q5 Black headphones").target.model).toBe("Q5");
  });
  it("the plain model never stands in for the suffixed one", () => {
    const listings = [product("trio", "Pellan KX-40 Trio Air Fryer", "Pellan"), product("plain", "Pellan KX-40 Air Fryer, 5 L", "Pellan")];
    const r = resolveExactV2(intent("Pellan KX-40 Trio"), listings, () => []);
    // (no offers in this fixture, so nothing can lock; what matters is which listing is the model)
    expect(r.excluded.find((e) => e.productId === "plain")?.reason).toMatch(/different model/);
    expect(r.excluded.find((e) => e.productId === "trio")?.reason ?? "").not.toMatch(/different model/);
    expect(mentionsExactModel("Pellan KX-40 Air Fryer, 5 L", "KX-40 Trio")).toBe(false);
    expect(mentionsExactModel("Pellan KX-40 Trio Air Fryer", "KX-40 Trio")).toBe(true);
  });
});

describe("V2.5 context is not a requirement", () => {
  it("purpose phrases, lead-ins and relative clauses about a person are optional context", () => {
    const a = intent("desk lamp with a dimmer for my reading nook, please");
    expect(a.unresolvedMust).toEqual(["unrecognized:dimmer"]);
    expect(a.uninterpreted).toEqual([]);
    expect(a.requirements.some((r: any) => r.note === "CONTEXT" && r.strength === "NICE")).toBe(true);
    const b = intent("present for my aunt who hikes on weekends: a waterproof lantern");
    expect(b.mustHave).toEqual(["waterproof"]);
    expect(b.unresolvedMust).toEqual([]);
    expect(intent("anything simple: the Quillon Nook 6 for travel").unresolvedMust).toEqual([]);
    expect(intent("Mirelle Arc 12 for my daily commute").uninterpreted).toEqual([]);
  });
  it("a capacity or a named product after 'for' is still a requirement or a target", () => {
    expect(intent("dome tent for four people").unresolvedMust).toContain("unrecognized:4-person");
    expect(intent("replacement strap for my Toska Pulse 7").target.kind).toBe("ACCESSORY");
  });
});

describe("V2.5 thresholds, units and stated properties", () => {
  it("'N unit or more' is a threshold, and a unit after a bare number is never money", () => {
    expect(intent("drone battery with 6,000 mAh or more").unresolvedMust).toEqual(["unrecognized:at-least-6000-mah"]);
    const p = intent("power station under 500 Wh");
    expect(p.budgetUnresolved).toBeNull();
    expect(p.unresolvedMust).toContain("unrecognized:at-most-500-wh");
    expect(clauseStatement("Suction reaches 18,000 Pa in boost mode.", "unrecognized:at-least-15000-pa-suction")).toBe(true);
  });
  it("an ingress rating and a power source are verifiable propositions", () => {
    expect(intent("headlamp rated IP68").unresolvedMust).toEqual(["unrecognized:ip68"]);
    expect(clauseStatement("Rated IPX4 splash resistant.", "unrecognized:ip68")).toBe(null);
    expect(intent("desk monitor powered by a single USB-C cable").unresolvedMust).toEqual(["unrecognized:single-usb-c-cable"]);
    expect(clauseStatement("One USB-C cable carries video and power.", "unrecognized:single-usb-c-cable")).toBe(true);
  });
  it("an adjective narrows a capability; a part noun after it is part of it", () => {
    expect(intent("camera with native 4K").unresolvedMust).toEqual(["unrecognized:native-4k"]);
    expect(clauseStatement("4K upscaled from 1080p.", "unrecognized:native-4k")).toBe(null);
    const k = intent("kettle with a dishwasher-safe lid");
    expect(k.mustHave).toEqual(["dishwasher_safe"]);
    expect(k.uninterpreted).toEqual([]);
  });
  it("a property is matched in its other wordings and forms", () => {
    expect(clauseStatement("The battery is removable for quick swaps.", "unrecognized:removable-battery")).toBe(true);
    expect(clauseStatement("The battery is not removable.", "unrecognized:removable-battery")).toBe(false);
    expect(clauseStatement("Wide-angle oscillation spreads the airflow.", "unrecognized:oscillates")).toBe(true);
  });
  it("a requested bundle's named contents must be in the listing title", () => {
    const b = intent("Toska K9 with the travel jar bundle");
    expect(b.target.kind).toBe("BUNDLE");
    expect(b.productTypeWords).toEqual(["travel", "jar"]);
    expect(b.unresolvedMust).toEqual([]);
  });
});
