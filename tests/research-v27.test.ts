/**
 * V2.7: identity fails closed after the first scored IW-8 run (IW-8 is now seen; these tests use builder-written fictional
 * products only: Corvan, Mirelle, Toska, Pellan, Quillon, Abrin, Contoso). Nothing is copied from any IW set.
 */
import { describe, expect, it } from "vitest";
import { parseResearchIntent } from "../src/intent/ResearchIntentV2.js";
import { extractIdentity, mentionsExactModel, namedModelAfter } from "../src/identity/ProductIdentityExtractor.js";
import { clauseStatement } from "../src/research/capabilities.js";
import { namesUnknownEntity } from "../src/evidence/EvidenceV2.js";

const intent = (request: string) => parseResearchIntent({ request } as any) as any;

describe("V2.7 every name token next to the model is part of it", () => {
  it("a code or name word after the model number stays in the requested model", () => {
    expect(intent("Pellan Arc 90 EQ telescope").target.model).toBe("Arc 90 EQ");
    expect(intent("Toska TC-20 LTE dash cam").target.model).toBe("TC-20 LTE");
    expect(intent("Pellan HR-9 IH rice cooker").target.model).toBe("HR-9 IH");
  });
  it("colours and product nouns are still not part of the model", () => {
    expect(intent("Buy Corvan Q5 Black headphones").target.model).toBe("Q5");
    expect(extractIdentity("Pellan Arc 10x50 Binoculars", "Pellan").model).toBe("Arc 10x50");
  });
  it("a listing title keeps an upper-case name code, and trims descriptive codes", () => {
    expect(extractIdentity("Pellan Arc 90 EQ Telescope", "Pellan").model).toBe("Arc 90 EQ");
    expect(extractIdentity("Pellan Arc 90 Telescope", "Pellan").model).toBe("Arc 90");
    expect(extractIdentity("Toska TC-20 HD Dash Cam", "Toska").model).toBe("TC-20");
  });
  it("a page about the coded sibling never names the base model", () => {
    expect(mentionsExactModel("The Abrin Trail 5 GTX is waterproof.", "Trail 5")).toBe(false);
    expect(mentionsExactModel("The Abrin Trail 5 is not waterproof.", "Trail 5")).toBe(true);
    expect(mentionsExactModel("The Abrin Trail 5 GTX is waterproof.", "Trail 5 GTX")).toBe(true);
  });
});

describe("V2.7 greetings and pronouns are never a model", () => {
  it("a lead-in sentence before the brand is not part of the product name", () => {
    expect(namedModelAfter("Hi there", null)).toBeNull();
    expect(intent("Hi! Mirelle KM-5 Lite keyboard please").target.model).toBe("KM-5 Lite");
    expect(intent("Hello. I'm after the Quillon Nook 6").target.model).toBe("Nook 6");
  });
});

describe("V2.7 a size of the object a product is for", () => {
  it("is a verifiable claim about the product, not a size the listing must carry", () => {
    const i = intent("Toska LM-12 laminator for 12-inch posters, under 90 dollars");
    expect(i.target.model).toBe("LM-12");
    expect(i.attributes.size).toBeUndefined();
    expect(i.unresolvedMust).toEqual(["unrecognized:at-least-12-inch-posters"]);
    expect(clauseStatement("It takes documents up to 12 inches wide, so it handles A3 posters.", "unrecognized:at-least-12-inch-posters")).toBe(true);
    expect(clauseStatement("It takes documents up to 9 inches wide, fine for small posters.", "unrecognized:at-least-12-inch-posters")).toBe(false);
  });
  it("a paper size is not another product", () => {
    const p: any = { identity: { brand: "Toska", model: "LM-12" }, title: "Toska LM-12 Laminator" };
    expect(namesUnknownEntity("The Toska LM-12 handles A3 posters.", p)).toBe(false);
  });
});

describe("V2.7 a model named only as the comparison is not the subject", () => {
  it("'Like the X, it ...' on a sibling's page says nothing about X", async () => {
    const { statementFrom } = await import("../src/evidence/EvidenceV2.js");
    const p: any = { productId: "p", title: "Toska TP-4 Tire Pump", category: "pumps", identity: { brand: "Toska", model: "TP-4", variant: null, condition: "new", sku: null }, capabilities: [], description: null, reviews: [] };
    const hit = { title: "Toska TP-4 Max Tire Pump specifications", snippet: "The Toska TP-4 Max stops at the set pressure. Like the TP-4, it is cordless." };
    expect(statementFrom(hit, p, "cordless")).toBeNull();
    expect(statementFrom({ title: "Toska TP-4 Tire Pump specifications", snippet: "The Toska TP-4 is cordless." }, p, "cordless")?.value).toBe(true);
  });
});
