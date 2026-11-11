/**
 * V21-02 (independent review of V2.1): a requested model year is a hard identity attribute. New builder-written
 * fictional products only (Halcyon Drift 15, Ostrava Pebble S); no IW-1.1 case is copied.
 */
import { afterEach, describe, expect, it } from "vitest";
import { extractIdentity, modelYear, parseAttributes } from "../src/identity/ProductIdentityExtractor.js";
import { parseResearchIntent } from "../src/intent/ResearchIntentV2.js";
import { miniWorld, type MiniProduct } from "./helpers/miniWorld.js";

const lap = (id: string, title: string, price: number): MiniProduct => ({ id, title, brand: "Halcyon", category: "laptops", categoryTitle: "Laptops", price });
const D24 = lap("hd15_2024", "Halcyon Drift 15 Laptop (2024)", 899);
const D25 = lap("hd15_2025", "Halcyon Drift 15 Laptop (2025)", 1099);
const DNY = lap("hd15_noyear", "Halcyon Drift 15 Laptop", 949);

describe("V21-02 parsing: the year is an attribute, not part of the model", () => {
  it.each([["Buy the Halcyon Drift 15 (2025)", "2025"], ["Halcyon Drift 15 2024 model", "2024"], ["Halcyon Drift 15 model year 2025", "2025"],
    ["할시온 Drift 15 2025년형", "2025"], ["Halcyon Drift 15 '24 model", "2024"], ["Halcyon Drift 15 2025 Edition", "2025"]])("%s → year %s", (t, y) => {
    expect(modelYear(t)).toBe(y);
  });
  it.each(["Halcyon Drift 15 under 2025", "power bank 2025 mAh", "Corvid 2000 vacuum", "Halcyon X2025 dock", "laptop for $2025", "Halcyon Drift 15"])("no year: %s", (t) => {
    expect(modelYear(t)).toBeNull();
  });
  it("two listing titles of different years are the same model family with different years", () => {
    const a = extractIdentity(D24.title, "Halcyon"), b = extractIdentity(D25.title, "Halcyon");
    expect(a.model).toBe(b.model);
    expect([a.attributes.year, b.attributes.year]).toEqual(["2024", "2025"]);
  });
  it("a request's year goes to attributes; the target model has no year", () => {
    const i = parseResearchIntent({ request: "Buy the Halcyon Drift 15 (2025)" });
    expect(i.target?.model).toBe("Drift 15");
    expect(i.attributes.year).toBe("2025");
    expect(parseAttributes("Halcyon Drift 15 Laptop").year).toBeUndefined();
  });
});

describe("V21-02 end to end: an exact request never substitutes or guesses a year", () => {
  let w: ReturnType<typeof miniWorld> | null = null;
  afterEach(() => { w?.close(); w = null; });
  const research = (products: MiniProduct[], request: string) => { w = miniWorld(products); return w.app.gateway.researchPurchase("alice", { request }) as Promise<any>; };

  it("a stated year locks only that year", async () => {
    const out = await research([D24, D25], "Buy the Halcyon Drift 15 (2025)");
    expect(out.identity.status).toBe("LOCKED");
    expect(out.identity.lockedIdentity.variant).toMatch(/year=2025/);
    expect(out.candidates.map((c: any) => c.productId)).not.toContain("ch3:hd15_2024");
  });
  it("the other stated year locks the other listing", async () => {
    const out = await research([D24, D25], "Buy the Halcyon Drift 15 2024 model");
    expect(out.identity.status).toBe("LOCKED");
    expect(out.identity.lockedIdentity.variant).toMatch(/year=2024/);
  });
  it("a stated year is not satisfied by another year: HOLD, no lock", async () => {
    const out = await research([D24], "Buy the Halcyon Drift 15 (2025)");
    expect(out.identity.status).not.toBe("LOCKED");
    expect(out.decision.state).toBe("HOLD");
    expect(out.decision.recommendation).toBeNull();
  });
  it("a stated year is not satisfied by a listing that states no year: HOLD, no lock", async () => {
    const out = await research([DNY, D24], "Buy the Halcyon Drift 15 (2025)");
    expect(out.identity.status).not.toBe("LOCKED");
    expect(out.decision.state).toBe("HOLD");
    expect(JSON.stringify(out.identity)).toMatch(/year is not stated by the listing/);
  });
  it("no year requested and several years exist: HOLD and ask which year", async () => {
    const out = await research([D24, D25], "Buy the Halcyon Drift 15");
    expect(out.identity.status).toBe("AMBIGUOUS");
    expect(out.decision.state).toBe("HOLD");
    expect(out.decision.holdReasons.join(" ")).toMatch(/year/);
    expect(out.state).toBe("HOLD");
  });
  it("a year-unknown listing next to a dated one is ambiguous too (never assumed to be the same year)", async () => {
    const out = await research([DNY, D25], "Buy the Halcyon Drift 15");
    expect(out.identity.status).toBe("AMBIGUOUS");
    expect(out.decision.state).toBe("HOLD");
  });
  it("control: one listing and no year requested still locks", async () => {
    const out = await research([D25], "Buy the Halcyon Drift 15");
    expect(out.identity.status).toBe("LOCKED");
  });
});

describe("V21-02 discovery: a stated year filters candidates", () => {
  let w: ReturnType<typeof miniWorld> | null = null;
  afterEach(() => { w?.close(); w = null; });
  it("another year is disqualified; a listing with no year is blocked as unknown, never recommended", async () => {
    const pebble = (id: string, title: string, price: number): MiniProduct => ({ id, title, brand: "Ostrava", category: "laptops", categoryTitle: "Laptops", price });
    w = miniWorld([pebble("p24", "Ostrava Pebble S Laptop (2024)", 700), pebble("pny", "Ostrava Pebble S Laptop", 720), D25]);
    const out: any = await w.app.gateway.researchPurchase("alice", { request: "a 2025 model laptop under $1500" });
    const row = (id: string) => out.decision.ranking.find((r: any) => r.productId === id);
    expect(row("ch3:p24").disqualifiers.map((d: any) => d.code)).toContain("ATTRIBUTE_MISMATCH");
    expect(row("ch3:pny").blockers.map((d: any) => d.code)).toContain("ATTRIBUTE_UNKNOWN");
    expect(out.decision.recommendation?.productId ?? null).not.toBe("ch3:p24");
    expect(out.decision.recommendation?.productId ?? null).not.toBe("ch3:pny");
  });
});
