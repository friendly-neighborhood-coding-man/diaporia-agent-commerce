/**
 * V2.19: generic fixes after the first scored IW-19 run (IW-19 is now seen; builder-written fictional products only).
 */
import { describe, expect, it } from "vitest";
import { clauseStatement } from "../src/research/capabilities.js";
import { statementFrom } from "../src/evidence/EvidenceV2.js";
import { extractIdentity } from "../src/identity/ProductIdentityExtractor.js";
import { parseResearchIntent } from "../src/intent/ResearchIntentV2.js";

const intent = (request: string) => parseResearchIntent({ request } as any) as any;

describe("V2.19 negated or excluded evidence never verifies", () => {
  it("a negated fitment or proposition is not proof", () => {
    expect(clauseStatement("Mounting bracket for bare roof rails is sold separately.", "unrecognized:for-bare-roof-rails")).not.toBe(true);
    expect(clauseStatement("Not compatible with bare roof rails.", "unrecognized:for-bare-roof-rails")).not.toBe(true);
  });
  it("a hedge, a restriction or a required adapter is not proof of fitment", () => {
    for (const s of ["Use it only at the bottom of stairs.", "It is unsafe at the top of stairs.", "Mount it at the bottom of stairs."])
      expect(clauseStatement(s, "unrecognized:for-top-of-stairs")).not.toBe(true);
    expect(clauseStatement("It needs a crossbar adapter for bare roof rails.", "unrecognized:for-bare-roof-rails")).not.toBe(true);
    expect(clauseStatement("It fits bare roof rails.", "unrecognized:for-bare-roof-rails")).toBe(true);
  });
  it("any part noun before 'for the <model>' is an accessory of it", () => {
    for (const r of ["check valve for the Corvan Delve 1/3HP", "support bracket for the Corvan Delve 2", "kid seat for the Mirelle Pacer 30", "work light for the Toska T4"])
      expect(intent(r).target).toMatchObject({ kind: "ACCESSORY" });
  });
  it("a compound requirement needs its whole compound, and a denial on the page wins", () => {
    const id = "unrecognized:for-an-in-ground-pool";
    expect(clauseStatement("The Abrin P1 Above Ground Pool Pump has a 1 HP motor.", id)).toBe(null);
    expect(clauseStatement("It is not for in-ground pools.", id)).toBe(false);
    const t = "Abrin P1 Above Ground Pool Pump";
    const p: any = { productId: "x", title: t, identity: { ...extractIdentity(t, "Abrin"), variant: null }, description: null, capabilities: [], offers: [] };
    expect(statementFrom({ title: "Abrin P1 Above Ground Pool Pump specifications", snippet: "The Abrin P1 Above Ground Pool Pump has a 1 HP motor. It is for in-ground pools as well. It is not for in-ground pools." }, p, id)).toMatchObject({ value: false });
  });
  it("a sibling named after own-name removal is about the sibling", () => {
    const t = "Abrin Vanta 1000W Power Inverter";
    const p: any = { productId: "x", title: t, identity: { ...extractIdentity(t, "Abrin"), variant: null }, description: null, capabilities: [], offers: [] };
    expect(statementFrom({ title: "Abrin Vanta 1000W vs Vanta 2000W", snippet: "Unlike the Abrin Vanta 1000W, the Abrin Vanta 2000W delivers 2,000 W." }, p, "unrecognized:at-least-1500-watts")).not.toMatchObject({ value: true });
  });
  it("a plain positive statement still verifies", () => {
    expect(clauseStatement("The Toska T4 Espresso Machine has a steel boiler and is not programmable.", "unrecognized:steel-boiler")).toBe(true);
  });
});

describe("V2.19 fitment for-phrases", () => {
  it("an article-less fitment target is a checked requirement", () => {
    const i = intent("Mirelle crossbar mount for bare roof rails");
    expect(i.unresolvedMust.some((u: string) => /for-bare-roof-rails/.test(u))).toBe(true);
  });
  it("a room, home or family use stays context; a terrain is checked", () => {
    expect(intent("Corvan baby gate for the twins' room").unresolvedMust.some((u: string) => /room/.test(u))).toBe(false);
    expect(intent("Mirelle tent for the family").unresolvedMust.some((u: string) => /family/.test(u))).toBe(false);
    expect(intent("snowshoes for backcountry").unresolvedMust).toContain("unrecognized:for-backcountry");
  });
  it("personal use stays context", () => {
    expect(intent("Corvan backpack for my commute").unresolvedMust.some((u: string) => /commute/.test(u))).toBe(false);
    expect(intent("Corvan backpack for travel").unresolvedMust.some((u: string) => /travel/.test(u))).toBe(false);
    expect(intent("Corvan backpack for the lowest total price").unresolvedMust.some((u: string) => /price/.test(u))).toBe(false);
  });
});
