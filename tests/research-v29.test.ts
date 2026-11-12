/**
 * V2.9: variant words after a model code are compared by name, never by a suffix allow-list, after the first scored
 * IW-10 run (IW-10 is now seen; these tests use builder-written fictional products only: Corvan, Mirelle, Toska,
 * Pellan, Quillon, Abrin, Contoso). Nothing is copied from any IW set.
 */
import { describe, expect, it } from "vitest";
import { parseResearchIntent } from "../src/intent/ResearchIntentV2.js";
import { extractIdentity } from "../src/identity/ProductIdentityExtractor.js";
import { resolveExactV2 } from "../src/identity/ProductResolverV2.js";
import { mentionsOtherVariant, missingNameWords, pickVariant, variantRuns } from "../src/identity/VariantTail.js";
import { statementFrom } from "../src/evidence/EvidenceV2.js";
import { Channel3ResearchAdapter } from "../src/research/Channel3ResearchAdapter.js";

const intent = (request: string) => parseResearchIntent({ request } as any) as any;
const product = (id: string, title: string, brand: string, category = "unknown"): any =>
  ({ productId: id, title, category, identity: { ...extractIdentity(title, brand), brand, variant: null, condition: "new", sku: null }, description: null, capabilities: [], offers: [] });
const offers = (id: string) => [{ productId: id, offerId: `o-${id}`, availability: "IN_STOCK", currency: "USD", itemPriceMinor: 5000, listedIdentity: { condition: "new" } }] as any;

describe("V2.9 the words right after the model code tell siblings apart", () => {
  it("a name word, a short code or an inserted feature word is a variant; shared words and descriptors are not", () => {
    expect(variantRuns(["Toska R9 Electric Scooter", "Toska R9 Dual Electric Scooter"], "Toska", "R9")).toEqual([[], ["Dual"]]);
    expect(variantRuns(["Toska BM-3 Video Baby Monitor", "Toska BM-3 HD Video Baby Monitor"], "Toska", "BM-3")).toEqual([[], ["HD"]]);
    expect(variantRuns(["Pellan F2 Water Flosser", "Pellan F2 Cordless Water Flosser"], "Pellan", "F2")).toEqual([[], ["Cordless"]]);
    expect(variantRuns(["Corvan CX-7 Wireless Bluetooth Headphones", "Corvan CX-7 Active Noise Canceling Headphones"], "Corvan", "CX-7")).toEqual([[], []]);
    expect(variantRuns(["Pellan LX-2 27-inch 4K Monitor", "Pellan LX-2 27-inch QHD Monitor"], "Pellan", "LX-2")).toEqual([[], []]);
  });
  it("the plain request keeps the plain listing; a tie between two named variants keeps nothing", () => {
    const t = (x: string) => x;
    expect(pickVariant(["Toska R9 Electric Scooter", "Toska R9 Dual Electric Scooter"], t, "Toska", "R9", []).keep).toEqual(["Toska R9 Electric Scooter"]);
    expect(pickVariant(["Toska R9 Electric Scooter", "Toska R9 Dual Electric Scooter"], t, "Toska", "R9", ["Dual"]).keep).toEqual(["Toska R9 Dual Electric Scooter"]);
    expect(pickVariant(["Toska R9 Dual Scooter", "Toska R9 Solo Scooter"], t, "Toska", "R9", []).keep).toEqual([]);
  });
  it("every name word the user wrote after the code must be in the listing", () => {
    expect(missingNameWords("Toska R9 Electric Scooter", ["Dual"])).toEqual(["Dual"]);
    expect(missingNameWords("Toska R9 Dual Electric Scooter", ["Dual"])).toEqual([]);
    expect(missingNameWords("Toska R9 Electric Scooter", ["black", "scooter"])).toEqual([]);
  });
});

describe("V2.9 resolver: a variant the request names is locked by its full name, never the shorter sibling", () => {
  const listings = [product("plain", "Toska R9 Electric Scooter", "Toska"), product("dual", "Toska R9 Dual Electric Scooter", "Toska")];
  it("'R9 Dual' locks the Dual and says so in the locked model", () => {
    const r: any = resolveExactV2(intent("Toska R9 Dual electric scooter"), listings, offers);
    expect(r.status).toBe("LOCKED");
    expect(r.productId).toBe("dual");
    expect(r.identity.model).toMatch(/R9 Dual/);
  });
  it("'R9' locks the plain listing, never the Dual", () => {
    const r: any = resolveExactV2(intent("Toska R9 electric scooter"), listings, offers);
    expect(r.status).toBe("LOCKED");
    expect(r.productId).toBe("plain");
  });
  it("'R9 Dual' with only the plain listing found fails closed", () => {
    const r: any = resolveExactV2(intent("Toska R9 Dual electric scooter"), [listings[0]], offers);
    expect(r.status).toBe("NOT_FOUND");
  });
});

describe("V2.9 evidence about a sibling variant never counts", () => {
  const plain = product("p", "Pellan A5 Action Camera", "Pellan", "action-cameras");
  it("a page about 'A5 4K' says nothing about the A5, not even in a pronoun clause", () => {
    const hit = { title: "Pellan A5 4K Action Camera specifications", snippet: "Unlike the Pellan A5, which tops out at 1080p, the Pellan A5 4K records 4K video. It is waterproof to 10 m." };
    expect(mentionsOtherVariant(hit.snippet, plain.title, "A5")).toBe(true);
    expect(statementFrom(hit, plain, "waterproof")).toBeNull();
    expect(statementFrom({ title: "Pellan A5 Action Camera specifications", snippet: "The Pellan A5 is waterproof to 10 m." }, plain, "waterproof")?.value).toBe(true);
  });
});

describe("V2.9 the adapter never merges or pools sibling variants", () => {
  const item = (id: string, title: string) => ({ id, title, brands: [{ name: "Pellan" }],
    offers: [{ domain: `${id}.example`, url: `https://${id}.example/p`, price: { price: 99.5, currency: "USD" }, availability: "InStock", condition: null }] });
  const fake = (pages: unknown[]) => { let n = 0; return (async () => Response.json(pages[n++])) as unknown as typeof fetch; };
  it("'A5 4K' stays its own product beside 'A5', and the A5's offers never include it", async () => {
    const a = new Channel3ResearchAdapter("ch3-FAKE-KEY-0123456789", { fetchImpl: fake([{ products: [item("a5", "Pellan A5 Action Camera"), item("a54k", "Pellan A5 4K Action Camera")] }]) });
    const r = await a.searchPage({ text: "x", category: null, brand: null, model: null, query: "pellan a5" });
    expect(r.products).toHaveLength(2);
    const k = r.products.find((p) => p.title.includes("4K"))!;
    expect(k.research!.variantRun).toEqual(["4K"]);
    const plain = r.products.find((p) => !p.title.includes("4K"))!;
    const o = await a.findOffers(plain.identity);
    expect(o.filter((x) => x.listedIdentity.model === plain.identity.model).map((x) => x.merchantDomain)).toEqual(["a5.example"]);
  });
});

describe("V2.9 a weight is not money", () => {
  it("'250 grams' is a quantity, the dollar amount is the budget", () => {
    const i = intent("Quillon kitchen scale that weighs up to 250 grams, under $30");
    expect(i.budgetMinor ?? i.budget?.amountMinor).toBe(3000);
  });
});

describe("V2.9 a part noun after or before the model asks for the part", () => {
  it("'<model> battery', '<model> Belt' and 'dive housing for <model>' are accessory requests", () => {
    expect(intent("Corvan Q8 battery").target).toMatchObject({ model: "Q8", kind: "ACCESSORY", accessoryNoun: "battery" });
    expect(intent("Mirelle T5 Belt").target).toMatchObject({ model: "T5", kind: "ACCESSORY" });
    expect(intent("dive housing for the Pellan A5").target).toMatchObject({ model: "A5", kind: "ACCESSORY", accessoryNoun: "dive housing" });
    expect(intent("Pellan 10-inch frying pan under $40").target).toBeNull();
  });
  it("the part listing is locked, never the product it fits", () => {
    const listings = [product("drone", "Corvan Q8 Drone", "Corvan"), product("batt", "Replacement Battery for Corvan Q8 Drone", "Corvan")];
    const r: any = resolveExactV2(intent("Corvan Q8 battery"), listings, offers);
    expect(r.status).toBe("LOCKED");
    expect(r.productId).toBe("batt");
  });
  it("a listing of another kind is never the noun the request names", () => {
    const r: any = resolveExactV2(intent("Pellan A5 drone"), [product("cam", "Pellan A5 Action Camera", "Pellan")], offers);
    expect(r.status).toBe("NOT_FOUND");
  });
});

describe("V2.10 the direction of 'up to' comes from the verb (IW-11 is seen; fictional products only)", () => {
  it("after a capacity verb it is a minimum; after a weight word a maximum; otherwise it must be met exactly", async () => {
    const { clauseStatement } = await import("../src/research/capabilities.js");
    const must = (r: string) => intent(r).unresolvedMust as string[];
    expect(must("Abrin smart scale that supports up to 180 kg")).toContain("unrecognized:at-least-180-kg");
    expect(clauseStatement("It supports users up to 150 kg.", "unrecognized:at-least-180-kg")).toBe(false);
    expect(clauseStatement("Rated for users up to 200 kg.", "unrecognized:at-least-180-kg")).toBe(true);
    expect(must("Contoso laptop that weighs up to 1.5 kg")).toContain("unrecognized:at-most-1.5-kg");
    expect(must("Toska vacuum with up to 60 minutes")).toContain("unrecognized:up-to-60-minutes");
    expect(clauseStatement("It runs for up to 45 minutes.", "unrecognized:up-to-60-minutes")).toBe(false);
  });
  it("a limit word inside a model name is never money", () => {
    const i = intent("Quillon K2 Max 3D printer");
    expect(i.target.model).toBe("K2 Max 3D");
    expect(i.budgetMinor ?? null).toBeNull();
  });
  it("'doesn't need X' excludes X", () => {
    const m = intent("smart scale that doesn't need an app subscription").unresolvedMust as string[];
    expect(m).toContain("not:app-subscription");
    expect(m.some((k) => /^unrecognized:.*app-subscription/.test(k))).toBe(false);
  });
});

describe("V2.11 a part listed under the base model is checked against the maker's fit statement (IW-11 is seen; fictional products only)", () => {
  it("the fit statement must list the full requested model; a negated fit says it does not fit", async () => {
    const { fitStatement, fitKey } = await import("../src/research/capabilities.js");
    const s = "The Toska R9 Spare Battery fits the Toska R9 and R9 Dual Electric Scooters.";
    expect(fitStatement(s, fitKey("R9 Dual"))).toBe(true);
    expect(fitStatement(s, fitKey("R9 Max"))).toBeNull();
    expect(fitStatement("It does not fit the R9 Max, whose battery is built in.", fitKey("R9 Max"))).toBe(false);
    expect(fitStatement("It fits the Pellan SD-4 and SD-4P Dehumidifiers.", fitKey("SD-4P"))).toBe(true);
    expect(fitStatement("It fits the Pellan Note 3 and Note 3 Pro E-Readers.", fitKey("Note 3 Colour"))).toBeNull();
  });
  it("a part request for a longer host name locks the base-model part only with a fit requirement", () => {
    const listings = [product("dual", "Toska R9 Dual Electric Scooter", "Toska"), product("batt", "Toska R9 Spare Battery", "Toska")];
    const i = intent("spare battery for the Toska R9 Dual");
    expect(i.target).toMatchObject({ kind: "ACCESSORY", accessoryNoun: "battery" });
    const r: any = resolveExactV2(i, listings, offers);
    expect(r.status).toBe("LOCKED");
    expect(r.productId).toBe("batt");
    expect(r.fitModel).toBe("R9 Dual");
  });
  it("a hyphenated name word stays in the requested model", () => {
    expect(intent("Pellan C3 Step-Through").target.model).toBe("C3 Step-Through");
  });
});

describe("V2.11 category names, spec lines and part pages", () => {
  it("everyday category names are categories, and the noun before a threshold is not a requirement of its own", async () => {
    const { requestCategory } = await import("../src/research/capabilities.js");
    expect(requestCategory("e-bike")?.id).toBe("electric-bikes");
    expect(requestCategory("robotic lawnmower")?.id).toBe("robot-lawn-mowers");
    expect(requestCategory("ebook reader")?.id).toBe("e-readers");
    expect(intent("electric scooter with a range of at least 40 km").unresolvedMust).toEqual(["unrecognized:at-least-40-km"]);
  });
  it("'Built-in pump: no' denies the pump", async () => {
    const { clauseStatement } = await import("../src/research/capabilities.js");
    expect(clauseStatement("Built-in pump: no.", "unrecognized:pump")).toBe(false);
    expect(clauseStatement("Built-in pump: yes.", "unrecognized:pump")).toBe(true);
  });
  it("a page about a part of the model says nothing about the product itself", () => {
    const bike = product("c3", "Pellan C3 Electric Bike", "Pellan", "electric-bikes");
    expect(statementFrom({ title: "Pellan C3 Spare Battery", snippet: "The Pellan C3 Spare Battery fits the Pellan C3 Electric Bike, which is cordless." }, bike, "cordless")).toBeNull();
  });
});
