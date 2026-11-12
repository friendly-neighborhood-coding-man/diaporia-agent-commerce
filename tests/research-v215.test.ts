/**
 * V2.15: IW-15 is SEEN; these tests use builder-written fictional products only (Corvan, Mirelle, Toska, Pellan,
 * Quillon, Abrin, Contoso). Nothing is copied from any IW set.
 */
import { describe, expect, it } from "vitest";
import { parseResearchIntent } from "../src/intent/ResearchIntentV2.js";
import { extractIdentity } from "../src/identity/ProductIdentityExtractor.js";
import { variantRuns } from "../src/identity/VariantTail.js";
import { statementFrom } from "../src/evidence/EvidenceV2.js";

const intent = (request: string) => parseResearchIntent({ request } as any) as any;
const product = (model: string): any => ({ productId: "p", title: `Toska ${model} Pump`, category: "pumps",
  identity: { brand: "Toska", model, variant: null, condition: "new", sku: null }, capabilities: [], description: null, reviews: [] });

describe("V2.15 a listing title is read with the request identity rules", () => {
  it("the model ends at its number; a code word after it is the title's tail", () => {
    expect(extractIdentity("Toska Fuse 300B MIG Welder", "Toska").model).toBe("Fuse 300B");
    expect(extractIdentity("Pellan Arc 90 EQ Telescope", "Pellan").model).toBe("Arc 90");
  });
  it("a word inserted after the model makes a sibling, and the plain listing has no tail", () => {
    const runs = variantRuns(["Quillon Bake 30L Food Dryer", "Quillon Bake 30L Steel Food Dryer"], "Quillon", "Bake 30L");
    expect(runs.map((r) => r.join(" "))).toEqual(["", "Steel"]);
  });
});

describe("V2.15 multi-word modifiers stay whole", () => {
  it("'stainless steel' is one requirement, never dropped", () => {
    const i = intent("Toska food dryer with stainless steel trays, under 150 dollars");
    expect(JSON.stringify(i.unresolvedMust ?? [])).toContain("stainless-steel");
  });
});

describe("V2.15 any noun phrase before 'for the <model>' is a part", () => {
  it("is never the model itself", () => {
    expect(intent("mesh sheets for the Quillon Bake 30L").target.kind).toBe("ACCESSORY");
    expect(intent("welding wire for the Toska Fuse 300B").target.kind).toBe("ACCESSORY");
    expect(intent("cutting wheel for the Toska TC-20").target.kind).toBe("ACCESSORY");
  });
  it("a person, a purpose or a vague word is still not a part", () => {
    expect(intent("something warm for the Pellan Arc 90").target.kind).toBe("STANDALONE");
    expect(intent("Corvan Q5 headphones").target.kind).toBe("STANDALONE");
  });
});

describe("V2.15 feature evidence comes only from the product's own page", () => {
  it("a sibling's page that mentions this model as not fitting says nothing about this model", () => {
    const hit = { title: "Toska TP-4 Max Hooded Pump", snippet: "The hood does not fit the Toska TP-4, only the Toska TP-4 Max." };
    expect(statementFrom(hit, product("TP-4"), "hooded")).toBeNull();
  });
  it("the product's own page still counts", () => {
    expect(statementFrom({ title: "Toska TP-4 Pump specifications", snippet: "The Toska TP-4 is cordless." }, product("TP-4"), "cordless")?.value).toBe(true);
  });
});
