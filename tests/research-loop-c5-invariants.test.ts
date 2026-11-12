/**
 * Post-submission loop, cycle 5: five invariants that must hold for any wording, not only the phrases seen in IW-22.
 * I1 evidence names exactly the candidate; I2 context covers the whole phrase; I3 no request word is dropped without an
 * interpretation; I4 every product noun the request states must be the candidate's; I5 variant minimality.
 * Builder-written fictional products only (Wrenmoor, Halvard, Ostby, Pelling, Quarrel); nothing is copied from any IW set.
 */
import { describe, expect, it } from "vitest";
import { parseResearchIntent } from "../src/intent/ResearchIntentV2.js";
import { extractIdentity } from "../src/identity/ProductIdentityExtractor.js";
import { resolveExactV2 } from "../src/identity/ProductResolverV2.js";
import { PURPOSE_FOR } from "../src/intent/Requirements.js";
import { statementFrom } from "../src/evidence/EvidenceV2.js";

const intent = (request: string) => parseResearchIntent({ request } as any) as any;
const product = (id: string, title: string, brand: string, category = "unknown"): any =>
  ({ productId: id, title, category, identity: { ...extractIdentity(title, brand), brand, variant: null, condition: "new", sku: null }, description: null, capabilities: [], offers: [] });
const offers = (id: string) => [{ productId: id, offerId: `o-${id}`, availability: "IN_STOCK", currency: "USD", itemPriceMinor: 5000, listedIdentity: { condition: "new" } }] as any;
const lockOf = (request: string, listings: any[]) => { const r: any = resolveExactV2(intent(request), listings, offers); return r.status === "LOCKED" ? r.productId : r.status; };
const CAP = "unrecognized:with-a-2-hp-motor";

describe("I1: a statement verifies only the product it is about", () => {
  const lathe = product("l", "Wrenmoor Turnwell 12 Wood Lathe", "Wrenmoor");
  const latheXl = product("lx", "Wrenmoor Turnwell 12 Bowl Wood Lathe", "Wrenmoor");
  const bowlPage = { title: "Wrenmoor Turnwell 12 Bowl Wood Lathe specifications", snippet: "The Wrenmoor Turnwell 12 Bowl Wood Lathe has a 2 hp motor." };
  it("a listed sibling whose name extends this model owns its page", () => {
    expect(statementFrom(bowlPage, lathe, CAP, [lathe, latheXl])).toBeNull();
    expect(statementFrom(bowlPage, latheXl, CAP, [lathe, latheXl])?.value).toBe(true);
  });
  it("an unlisted product named by the page title owns the page too, and a clause naming both is about the pair", () => {
    const addOn = { title: "Wrenmoor Turnwell 12 Bed Extension", snippet: "The Wrenmoor Turnwell 12 Bed Extension fits the Turnwell 12 only. With the bed extension, the Turnwell 12 has a 2 hp motor." };
    expect(statementFrom(addOn, lathe, CAP, [lathe])).toBeNull();
  });
  it("negative controls: the product's own page, a review page and a punctuated title still count", () => {
    const own = { title: "Wrenmoor Turnwell 12 Wood Lathe specifications", snippet: "The Wrenmoor Turnwell 12 Wood Lathe has a 2 hp motor." };
    const review = { title: "Wrenmoor Turnwell 12 review", snippet: "The Wrenmoor Turnwell 12 has a 2 hp motor." };
    const pick = { title: "Wrenmoor Turnwell 12: our pick", snippet: "The Wrenmoor Turnwell 12 has a 2 hp motor." };
    for (const h of [own, review, pick]) expect(statementFrom(h, lathe, CAP, [lathe, latheXl])?.value).toBe(true);
  });
});

describe("I2: context covers the whole phrase", () => {
  it("a condition or activity is a requirement even after an occasion word", () => {
    for (const t of ["for winter camping", "for heavy snow", "for summer kayaking", "for light loads"]) expect(PURPOSE_FOR.test(t)).toBe(false);
  });
  it("occasions, times, uses and company stay context", () => {
    for (const t of ["for this winter", "for a family reunion", "for a weekend project", "for a camping trip with the kids", "for heavy use", "for camping trips", "for school too", "for my long commute"]) expect(PURPOSE_FOR.test(t)).toBe(true);
  });
});

describe("I3: a direction word after a number is never dropped", () => {
  it("Korean thresholds become must-haves", () => {
    expect(intent("8인용 이상 전기밥솥").unresolvedMust).toContain("unrecognized:at-least-8-people");
    expect(intent("20kg 이하 캠핑 의자").unresolvedMust).toContain("unrecognized:at-most-20-kg");
  });
});

describe("I4: every product noun the request states must be the candidate's", () => {
  const world = [product("tent", "Halvard Canopy 4P Rooftop Tent", "Halvard", "rooftop-tents"), product("awning", "Halvard Canopy 4P Side Awning", "Halvard", "rooftop-tent-accessories")];
  it("a noun phrase before 'for the <model>' is the part, even when its last word is an amount word", () => {
    expect(lockOf("side room for the Halvard Canopy 4P", [product("tent", "Halvard Canopy 4P Rooftop Tent", "Halvard"), product("room", "Halvard Canopy 4P Side Room", "Halvard", "rooftop-tent-accessories")])).toBe("room");
    // The invariant is that the host is never locked for a part request; this wording is AMBIGUOUS (asks which product).
    expect(lockOf("side awning for the Halvard Canopy 4P", world)).not.toBe("tent");
  });
  it("an unparsed noun before 'for the <model>' blocks instead of locking the host silently", () => {
    const i = intent("drip guard for the Halvard Canopy 4P");
    expect(i.target.kind === "ACCESSORY" || i.uninterpreted.length > 0).toBe(true);
  });
  it("negative controls: 'gift for my <model>' and 'something for the <model>' add nothing", () => {
    expect(intent("gift for my Halvard Canopy 4P").uninterpreted).toEqual([]);
    expect(intent("I need something for the Halvard Canopy 4P").uninterpreted).toEqual([]);
  });
});

describe("I5: a title that only adds words to a sibling's is never chosen for the plain name", () => {
  const hives = [product("h", "Ostby Larch 8-Frame Beehive", "Ostby"), product("hi", "Ostby Larch 8-Frame Insulated Beehive", "Ostby"), product("hs", "Ostby Larch 8-Frame Honey Super", "Ostby")];
  it("the plain listing is locked; naming the extra word locks the variant", () => {
    expect(lockOf("Ostby Larch 8-Frame", hives)).toBe("h");
    expect(lockOf("Ostby Larch 8-Frame Insulated", hives)).toBe("hi");
  });
  it("negative control: two variants that differ in different words stay ambiguous", () => {
    const two = [product("a", "Pelling Vane 3 Matte Kettle", "Pelling"), product("b", "Pelling Vane 3 Gloss Kettle", "Pelling")];
    expect(lockOf("Pelling Vane 3", two)).not.toMatch(/^[ab]$/);
  });
});
