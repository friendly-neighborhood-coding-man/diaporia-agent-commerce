/**
 * V2.18: IW-18 is SEEN; these tests use builder-written fictional products only (Corvan, Mirelle, Toska, Pellan,
 * Quillon, Abrin, Contoso). Nothing is copied from any IW set.
 */
import { describe, expect, it } from "vitest";
import { parseResearchIntent } from "../src/intent/ResearchIntentV2.js";

const intent = (request: string) => parseResearchIntent({ request } as any) as any;
const open = (i: any) => JSON.stringify([i.unresolvedMust, i.uninterpreted]);

describe("V2.18 what the product is for is checked", () => {
  it("'for a/an/the <thing>' is a must-have, a person's own use stays context", () => {
    expect(open(intent("Toska Gush 2 pump for an above-ground pond"))).toContain("above-ground");
    expect(intent("scooter for a 9 year old").unresolvedMust.length).toBeGreaterThan(0);
    expect(intent("Corvan Q5 headphones for my daily commute").unresolvedMust).toEqual([]);
  });
});

describe("V2.18 exclusive and part wording", () => {
  it("'<feature> only' stays open", () => {
    expect(intent("heater, propane only, with a thermostat").uninterpreted.map((u: any) => u.text)).toContain("propane only");
  });
  it("'<noun> kit for the <model>' is a part, not a bundle of the model", () => {
    expect(intent("mounting kit for the Toska Gush 2").target.kind).toBe("ACCESSORY");
  });
});

describe("V2.18 compound terms and conversation", () => {
  it("a modifier and the type word after it are one term", () => {
    expect(open(intent("dual fuel heater"))).toMatch(/dual[^"]*fuel|fuel[\s\S]*dual|dual[\s\S]*fuel/);
    expect(intent("very quiet mini fridge").unresolvedMust).toContain("unrecognized:quiet");
  });
  it("a delivery date and chat filler are never product properties", () => {
    expect(intent("Need it before the 4th of July: Toska Gush 2").unresolvedMust).toEqual([]);
    expect(intent("ugh our old pump finally quit lol, grab the Toska Gush 2 asap").unresolvedMust).toEqual([]);
  });
});
