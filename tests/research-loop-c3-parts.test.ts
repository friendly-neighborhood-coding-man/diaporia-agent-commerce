/**
 * Post-submission loop, cycle 3 (F3): a part titled with the family name is the part candidate, its fit to the exact host is a
 * separate must-have, and the host is never the part. Builder-written fictional products only; nothing is copied from any IW set.
 */
import { describe, expect, it } from "vitest";
import { parseResearchIntent } from "../src/intent/ResearchIntentV2.js";
import { extractIdentity } from "../src/identity/ProductIdentityExtractor.js";
import { resolveExactV2 } from "../src/identity/ProductResolverV2.js";
import { fitStatement, fitKey } from "../src/research/capabilities.js";

const intent = (request: string) => parseResearchIntent({ request } as any) as any;
const product = (id: string, title: string, brand: string, category = "unknown"): any =>
  ({ productId: id, title, category, identity: { ...extractIdentity(title, brand), brand, variant: null, condition: "new", sku: null }, description: null, capabilities: [], offers: [] });
const offers = (id: string) => [{ productId: id, offerId: `o-${id}`, availability: "IN_STOCK", currency: "USD", itemPriceMinor: 5000, listedIdentity: { condition: "new" } }] as any;
const resolve = (request: string, listings: any[]) => resolveExactV2(intent(request), listings, offers) as any;

const world = [
  product("w1", "Fennick Rover 1-Seat Bike Trailer", "Fennick", "bike-trailers"),
  product("w2", "Fennick Rover 2-Seat Bike Trailer", "Fennick", "bike-trailers"),
  product("pad", "Fennick Rover Comfort Seat Pad", "Fennick", "bike-trailer-accessories"),
  product("r60", "Larkspur Tidy 60ft Hose Reel", "Larkspur", "hose-reels"),
  product("r90", "Larkspur Tidy 90ft Hose Reel", "Larkspur", "hose-reels"),
  product("lead", "Larkspur Tidy Lead Hose", "Larkspur", "hose-reel-accessories"),
  product("br90", "Larkspur Tidy 90ft Wall Bracket", "Larkspur", "hose-reel-accessories"),
];

describe("cycle 3: a family-titled part is locked through its fit to the requested host", () => {
  it("the part is locked with fitModel = the full host", () => {
    const r = resolve("comfort seat pad for the Fennick Rover 1-Seat", world);
    expect(r).toMatchObject({ status: "LOCKED", productId: "pad", fitModel: "Rover 1-Seat" });
    expect(resolve("lead hose for the Larkspur Tidy 90ft", world)).toMatchObject({ status: "LOCKED", productId: "lead", fitModel: "Tidy 90ft" });
  });
  it("the fit must be stated by the manufacturer: a list that names the host verifies it, a sibling-only list does not", () => {
    const key = fitKey("Rover 1-Seat");
    expect(fitStatement("The Fennick Rover Comfort Seat Pad fits the Fennick Rover 1-Seat and Rover 2-Seat Bike Trailers.", key)).toBe(true);
    expect(fitStatement("The pad fits the Fennick Rover 2-Seat only.", key)).toBeNull();
    expect(fitStatement("It does not fit the Rover 1-Seat.", key)).toBe(false);
  });
  it("negative controls: a part numbered for a sibling, the host itself, or two candidates lock nothing", () => {
    expect(resolve("wall bracket for the Larkspur Tidy 60ft", world).status).not.toBe("LOCKED");
    const twoPads = [...world, product("pad2", "Fennick Rover Deluxe Seat Pad", "Fennick", "bike-trailer-accessories")];
    expect(resolve("seat pad for the Fennick Rover 1-Seat", twoPads).status).not.toBe("LOCKED");
    const r = resolve("lead hose for the Larkspur Tidy 60ft", [world[3], world[4]]);
    expect(r.status).not.toBe("LOCKED");
  });
  it("the standalone product request is unchanged", () => {
    expect(resolve("Fennick Rover 1-Seat", world)).toMatchObject({ status: "LOCKED", productId: "w1" });
  });
});

describe("cycle 3 (after the first seen rerun): the fit of a family-titled part is read, and the host number is not a quantity", () => {
  it("a part whose parsed model holds its whole name still counts its own fit statement", async () => {
    const { statementFrom } = await import("../src/evidence/EvidenceV2.js");
    const tails = product("t", "Fennick Rover Trail Tails", "Fennick");
    const page = { title: "Fennick Rover Trail Tails", snippet: "The Fennick Rover Trail Tails fit the Fennick Rover 1-Seat and Rover 2-Seat. They do not fit the Rover 2-Seat Sport." };
    expect(statementFrom(page, tails, fitKey("Rover 1-Seat"))?.value).toBe(true);
    expect(statementFrom(page, tails, fitKey("Rover 2-Seat Sport"))?.value).toBe(false);
  });
  it("'clips onto' and 'attaches to' state a fit", () => {
    expect(fitStatement("The lamp clips onto the Moravel Spire 6A and Spire 12A.", fitKey("Spire 6A"))).toBe(true);
    expect(fitStatement("The hook attaches to the Moravel Spire 12A only.", fitKey("Spire 6A"))).toBeNull();
  });
  it("'for the <host with a number>' in a part request is the host, not a quantity must-have", () => {
    expect(intent("comfort seat pad for the Fennick Rover 1-Seat").unresolvedMust).toEqual([]);
    expect(intent("Fennick Rover 2-Seat for my 38 lb daughter").unresolvedMust).toContain("unrecognized:for-my-38-lb-daughter");
  });
});
