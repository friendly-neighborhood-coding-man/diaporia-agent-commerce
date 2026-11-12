/**
 * Post-submission loop, cycle 4 (findings from the independent IW-21 run, now seen): a model number is not a year, a
 * numbered sibling's page is not this model's, a condition after "for" is a requirement, "X only" is never dropped, a
 * threshold is not an exact attribute, and an unknown part noun after the model can still name a listed part.
 * Builder-written fictional products only (Harlow, Quenby, Dorrit, Pellam, Sarrow); nothing is copied from any IW set.
 */
import { describe, expect, it } from "vitest";
import { parseResearchIntent } from "../src/intent/ResearchIntentV2.js";
import { extractIdentity, mentionsExactModel, stripYear } from "../src/identity/ProductIdentityExtractor.js";
import { resolveExactV2 } from "../src/identity/ProductResolverV2.js";
import { PURPOSE_FOR } from "../src/intent/Requirements.js";

const intent = (request: string) => parseResearchIntent({ request } as any) as any;
const product = (id: string, title: string, brand: string, category = "unknown"): any =>
  ({ productId: id, title, category, identity: { ...extractIdentity(title, brand), brand, variant: null, condition: "new", sku: null }, description: null, capabilities: [], offers: [] });
const offers = (id: string) => [{ productId: id, offerId: `o-${id}`, availability: "IN_STOCK", currency: "USD", itemPriceMinor: 5000, listedIdentity: { condition: "new" } }] as any;
const lockOf = (request: string, listings: any[]) => { const r: any = resolveExactV2(intent(request), listings, offers); return r.status === "LOCKED" ? r.productId : r.status; };

describe("cycle 4: a model number is not a model year", () => {
  it("2000..2004 stay in the model; a real model year is still stripped", () => {
    expect(extractIdentity("Harlow Basin 2000 Fountain Pump", "Harlow").model).toBe("Basin 2000");
    expect(stripYear("Drift 15 2024")).toBe("Drift 15");
    expect(stripYear("Basin 2000")).toBe("Basin 2000");
  });
  it("a numbered sibling's name never counts as a digit-less model", () => {
    expect(mentionsExactModel("The Harlow Basin 4000 Fountain Pump lifts water up to 14 ft.", "Basin")).toBe(false);
    expect(mentionsExactModel("The Harlow Basin fountain pump lifts water.", "Basin")).toBe(true);
    // A number with a unit after the model is a spec, not a sibling.
    expect(mentionsExactModel("The Harlow Basin 20 ft cord reaches the outlet.", "Basin")).toBe(true);
  });
});

describe("cycle 4: 'for' + a condition is a requirement; 'X only' is never dropped", () => {
  it("'for heavy snow' must be confirmed; 'for heavy use' stays context", () => {
    expect(intent("cold frame for heavy snow").unresolvedMust).toContain("unrecognized:for-heavy-snow");
    expect(PURPOSE_FOR.test("for heavy snow")).toBe(false);
    expect(PURPOSE_FOR.test("for light loads")).toBe(false);
    expect(PURPOSE_FOR.test("for heavy use")).toBe(true);
    expect(PURPOSE_FOR.test("for my long commute")).toBe(true);
  });
  it("an occasion with one modifier is still an occasion", () => {
    expect(PURPOSE_FOR.test("for a garden party next week")).toBe(true);
    expect(PURPOSE_FOR.test("for a garden pond")).toBe(false);
  });
  it("'<feature> only' after a named product blocks until settled", () => {
    const i = intent("Quenby Hearth 22, Bluetooth only");
    expect(i.uninterpreted.map((u: any) => u.text)).toContain("Bluetooth only");
  });
});

describe("cycle 4: a threshold is a requirement on a number, never an exact attribute", () => {
  it("'at least 50 liters' sets no exact capacity", () => {
    const i = intent("cash box with at least 50 liters");
    expect(i.attributes.capacity).toBeUndefined();
    expect(i.unresolvedMust).toContain("unrecognized:at-least-50-liters");
    expect(intent("cash box, 50 liters or more").attributes.capacity).toBeUndefined();
  });
  it("negative control: an exact size in the name is still exact", () => {
    expect(intent("Dorrit Vault 60L cash box").target.model).toBe("Vault 60L");
  });
});

describe("cycle 4: an unknown part noun after the model can name a listed part", () => {
  const world = [
    product("pump", "Pellam Rill 3000 Fountain Pump", "Pellam", "fountain-pumps"),
    product("sponge", "Pellam Rill 3000 Intake Sponge", "Pellam", "fountain-pump-accessories"),
  ];
  it("the part is locked, not the host", () => {
    expect(lockOf("Pellam Rill 3000 intake sponge", world)).toBe("sponge");
  });
  it("negative controls: the host request still locks the host; no listed part leaves the old reading", () => {
    expect(lockOf("Pellam Rill 3000 fountain pump", world)).toBe("pump");
    // With no listed part, the reading is unchanged: the host is the candidate and its unstated tail blocks downstream.
    const r: any = resolveExactV2(intent("Pellam Rill 3000 intake sponge"), [world[0]], offers);
    expect(r).toMatchObject({ status: "LOCKED", productId: "pump" });
    expect(r.fitModel).toBeUndefined();
  });
});
