/**
 * Post-submission loop, cycle 6 (safety only, after the independent IW-24 run, now seen): I6 a part requested for a
 * named host must be shown to fit that whole host; I7 words inside the named product are never request grammar.
 * Builder-written fictional products only (Tamsin, Corvell, Bracken); nothing is copied from any IW set.
 */
import { describe, expect, it } from "vitest";
import { parseResearchIntent } from "../src/intent/ResearchIntentV2.js";
import { fitStatement, fitKey } from "../src/research/capabilities.js";

const intent = (request: string) => parseResearchIntent({ request } as any) as any;

describe("I6: a part for a named host carries a fit requirement for the whole host", () => {
  it("every fit relation word adds the fit must-have", () => {
    for (const q of ["drip tray for the Tamsin Brewline 40", "drip tray to fit my Tamsin Brewline 40", "drip tray compatible with the Tamsin Brewline 40"])
      expect(intent(q).unresolvedMust).toContain(fitKey("Brewline 40"));
  });
  it("a fit statement that denies the host, or names only a longer sibling, never verifies it", () => {
    const k = fitKey("Brewline 40");
    expect(fitStatement("The Tamsin Brewline 40 Drip Tray fits the Brewline 40 Duo only.", k)).not.toBe(true);
    expect(fitStatement("It does not fit the Brewline 40, whose tray is fixed.", k)).toBe(false);
    expect(fitStatement("It fits the Brewline 30 and Brewline 40.", k)).toBe(true);
  });
  it("negative controls: no fit relation word, or a host request, adds nothing", () => {
    expect(intent("Tamsin Brewline 40 drip tray").unresolvedMust).not.toContain(fitKey("Brewline 40"));
    expect(intent("Tamsin Brewline 40 coffee maker").unresolvedMust).toEqual([]);
    expect(intent("gift for my Tamsin Brewline 40").unresolvedMust).toEqual([]);
  });
});

describe("I7: words inside the named product are never request grammar", () => {
  it("'VS' in a model name is not 'versus'", () => {
    const i = intent("tool rest for the Corvell Arbor 14 VS");
    expect(i.mode).toBe("EXACT_PRODUCT_PURCHASE");
    expect(i.target.model).toBe("Arbor 14 VS");
  });
  it("negative control: a real comparison outside the name still runs discovery", () => {
    expect(intent("Bracken Loft 12 vs Bracken Loft 14").mode).toBe("PRODUCT_DISCOVERY");
    expect(intent("something like the Corvell Arbor 14").mode).toBe("PRODUCT_DISCOVERY");
  });
});
