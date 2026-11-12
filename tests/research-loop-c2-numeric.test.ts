/**
 * Post-submission loop, cycle 2 (F4/F2): a number keeps its unit dimension, its direction and its role. Builder-written
 * sentences about fictional products only; nothing is copied from any IW set.
 */
import { describe, expect, it } from "vitest";
import { clauseStatement, numericProposition } from "../src/research/capabilities.js";
import { parseResearchIntent } from "../src/intent/ResearchIntentV2.js";

const st = (key: string, clause: string) => clauseStatement(clause, `unrecognized:${key}`);

describe("cycle 2: one unit dimension, many spellings", () => {
  it("a threshold reads the page's number whatever the unit spelling", () => {
    expect(st("at-least-6-amps", "It charges at 8 A.")).toBe(true);
    expect(st("at-least-6-amps", "It charges at 4 A.")).toBe(false);
    expect(st("at-least-3-kilowatts", "It delivers 5 kW of heat.")).toBe(true);
    expect(st("at-least-3-kilowatts", "It delivers 2 kW of heat.")).toBe(false);
    expect(st("at-least-90-feet", "The cart holds up to 110 ft of hose.")).toBe(true);
    expect(st("at-least-300-liters", "The cargo box holds 340 L.")).toBe(true);
    expect(st("at-least-300-liters", "The cargo box holds 280 L.")).toBe(false);
    expect(st("at-least-500-square-feet", "It warms up to 550 sq ft.")).toBe(true);
  });
  it("an amp-hour figure is not an amp figure", () => {
    expect(st("at-least-6-amps", "It supports batteries up to 120 Ah.")).toBeNull();
  });
  it("a count may be spelled, with a measurement between it and the noun", () => {
    expect(st("at-least-3-burners", "The range has four 9,000 BTU burners.")).toBe(true);
    expect(st("at-least-3-burners", "The range has two 9,000 BTU burners.")).toBe(false);
    // The BTU figure is never read as the burner count.
    expect(st("at-least-3-burners", "Each 9,000 BTU burner lights instantly.")).toBeNull();
  });
});

describe("cycle 2: 'for <a quantity>' is a value the product must accommodate", () => {
  it("the phrase becomes a WITHIN proposition on its number and unit", () => {
    expect(numericProposition("unrecognized:for-my-38-lb-daughter")).toMatchObject({ dir: "WITHIN", n: 38, unit: "lb" });
    expect(numericProposition("unrecognized:for-a-61-cm-head")).toMatchObject({ dir: "WITHIN", n: 61, unit: "cm" });
    expect(numericProposition("unrecognized:for-a-family-of-6")).toMatchObject({ dir: "WITHIN", n: 6, unit: "people" });
    expect(numericProposition("unrecognized:for-use-at-2-700-m")).toMatchObject({ dir: "WITHIN", n: 2700, unit: "m" });
    expect(numericProposition("unrecognized:for-a-480-sq-ft-shed")).toMatchObject({ dir: "WITHIN", n: 480, unit: "sq-ft" });
  });
  it("an upper limit or a range decides; a value outside it is FALSE", () => {
    expect(st("for-my-38-lb-daughter", "It carries one child up to 35 lb.")).toBe(false);
    expect(st("for-my-38-lb-daughter", "It carries two children up to 90 lb combined.")).toBe(true);
    expect(st("for-a-61-cm-head", "It fits heads 58 to 62 cm.")).toBe(true);
    expect(st("for-a-61-cm-head", "It fits heads 54 to 57 cm.")).toBe(false);
    expect(st("for-a-family-of-6", "Sized for homes of 4 to 7 people.")).toBe(true);
    expect(st("for-a-family-of-6", "Sized for homes of 1 to 3 people.")).toBe(false);
    expect(st("for-use-at-2-700-m", "Its regulator is rated for use up to 3,500 m altitude.")).toBe(true);
    expect(st("for-a-480-sq-ft-shed", "It heats up to 300 sq ft.")).toBe(false);
  });
  it("negative controls: a bare number is no limit; 'not above N' never affirms a value", () => {
    expect(st("for-my-38-lb-daughter", "The frame weighs 22 lb.")).toBeNull();
    expect(st("for-use-at-2-700-m", "It is not suitable for use above 2,000 m.")).toBe(false);
    expect(st("for-use-at-1-500-m", "It is not suitable for use above 2,000 m.")).toBeNull();
    // "up to N" in the request keeps its fail-closed exact reading (direction unclear).
    expect(numericProposition("unrecognized:up-to-70-lb-total")).toMatchObject({ dir: "EXACT" });
  });
  it("the request keeps the phrase whole as a must-have", () => {
    expect((parseResearchIntent({ request: "Fennick trailer for my 38 lb daughter" } as any) as any).unresolvedMust).toContain("unrecognized:for-my-38-lb-daughter");
  });
});

describe("cycle 2 (after the first seen rerun): a number that names a class of compatible object", () => {
  it("'for 30 lb propane tanks' is verified by a literal restatement when no limit speaks to it", () => {
    expect(st("for-30-lb-propane-tanks", "It connects directly to 30 lb propane tanks with the included hose.")).toBe(true);
    expect(st("for-30-lb-propane-tanks", "It needs an adapter for 30 lb propane tanks.")).not.toBe(true);
  });
});
