/** V2.19.2: generic fixes after the first scored IW-20 run (IW-20 is now seen; fictional builder products only). */
import { describe, expect, it } from "vitest";
import { parseResearchIntent } from "../src/intent/ResearchIntentV2.js";

const must = (request: string) => (parseResearchIntent({ request } as any) as any).unresolvedMust as string[];

describe("V2.19.2 for-phrases with an activity or a quantity are checked", () => {
  it("an activity the product must be fit for is a must-have, with or without 'too'", () => {
    expect(must("Corvan helmet for cycling too")).toContain("unrecognized:for-cycling");
    expect(must("Mirelle tent for camping")).toContain("unrecognized:for-camping");
  });
  it("a weight, household size or altitude is a must-have, never context or dropped", () => {
    expect(must("Corvan trailer for my 45 lb son")).toContain("unrecognized:for-my-45-lb-son");
    expect(must("Toska softener for a family of 5")).toContain("unrecognized:for-a-family-of-5");
    expect(must("Abrin Hob 2-Burner for use at 3,800 m")).toContain("unrecognized:for-use-at-3-800-m");
    expect(must("Pellan Tote 1-Seat for a 45 lb child")).toContain("unrecognized:for-a-45-lb-child");
  });
  it("a price or an existing threshold is not duplicated", () => {
    expect(must("Corvan T4 kettle for $40").some((k) => /for/.test(k))).toBe(false);
    expect(must("robot mower for a lawn of 800 m²")).toEqual(["unrecognized:at-least-800-m2-lawn"]);
  });
});
