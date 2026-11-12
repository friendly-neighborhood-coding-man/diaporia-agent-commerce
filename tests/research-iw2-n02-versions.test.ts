/**
 * N-02 / N-04 / N-05 (IW-2 verification of 7d1fe4f): model year and generation are identity attributes independent of
 * the model name; an unstated version never resolves to one listing when several versions are known; category nouns
 * never become part of the model; evidence never migrates between generations.
 * Builder-written fictional products only (Quillon Ember 6, Corvel Pods, Ostra Wave 300); nothing from IW-1.1/IW-2.
 */
import { afterEach, describe, expect, it } from "vitest";
import { statementFrom } from "../src/evidence/EvidenceV2.js";
import { extractIdentity } from "../src/identity/ProductIdentityExtractor.js";
import { parseResearchIntent } from "../src/intent/ResearchIntentV2.js";
import type { CatalogProduct } from "../src/domain/types.js";
import { miniWorld, type MiniProduct } from "./helpers/miniWorld.js";

const ereader = (id: string, title: string, price: number): MiniProduct => ({ id, title, brand: "Quillon", category: "e-readers", categoryTitle: "E-Readers", price });
const E23 = ereader("qe6_2023", "Quillon Ember 6 E-Reader (2023)", 99);
const E25 = ereader("qe6_2025", "Quillon Ember 6 E-Reader (2025)", 129);
const ENY = ereader("qe6_ny", "Quillon Ember 6 E-Reader", 109);
const pods = (id: string, title: string, price: number): MiniProduct => ({ id, title, brand: "Corvel", category: "headphones", categoryTitle: "Headphones", price });
const P1 = pods("cp_g1", "Corvel Pods (1st Gen) Wireless Earbuds", 79);
const P2 = pods("cp_g2", "Corvel Pods (2nd Gen) Wireless Earbuds", 119);

describe("N-02/N-04/N-05 parsing", () => {
  it.each([["Corvel Pods (1st Gen) Wireless Earbuds", "Pods", "1"], ["Corvel Pods 2nd Gen Earbuds", "Pods", "2"], ["Corvel Pods Gen 3", "Pods", "3"], ["Corvel Pods 2세대 이어폰", "Pods", "2"]])(
    "%s → model %s, generation %s", (t, model, g) => {
      const e = extractIdentity(t, "Corvel");
      expect(e.model).toBe(model); expect(e.attributes.generation).toBe(g);
    });
  it.each([["Buy the Ostra Wave 300 speaker", "Wave 300"], ["Buy the Ostra T44 TV", "T44"], ["Buy the Quillon Ember 6 e-reader", "Ember 6"], ["Buy Corvel Pods earbuds", "Pods"]])(
    "a category noun after the model is not part of it: %s → %s", (r, model) => {
      expect(parseResearchIntent({ request: r } as any).target?.model).toBe(model);
    });
  it("a year or generation written before the brand is read (N-04)", () => {
    expect(parseResearchIntent({ request: "Buy a 2023 Quillon Ember 6 e-reader" } as any).attributes.year).toBe("2023");
    expect(parseResearchIntent({ request: "Buy the 2nd gen Corvel Pods" } as any).attributes.generation).toBe("2");
  });
});

describe("N-02 end to end: an unstated version never resolves to one listing", () => {
  let w: ReturnType<typeof miniWorld> | null = null;
  afterEach(() => { w?.close(); w = null; });
  const research = (products: MiniProduct[], request: string) => { w = miniWorld(products); return w.app.gateway.researchPurchase("alice", { request }) as Promise<any>; };

  it("2023, 2025 and an undated listing, no year asked → HOLD with a year question (the undated one is not picked)", async () => {
    const out = await research([E23, E25, ENY], "Buy the Quillon Ember 6 e-reader");
    expect(out.identity.status).toBe("AMBIGUOUS");
    expect(out.decision.state).toBe("HOLD");
    expect(out.decision.holdReasons.join(" ")).toMatch(/model year/);
  });
  it("only an undated listing plus a dated one → still HOLD", async () => {
    const out = await research([ENY, E25], "Buy the Quillon Ember 6 e-reader");
    expect(out.identity.status).toBe("AMBIGUOUS");
  });
  it("a stated year written before the brand locks that year", async () => {
    const out = await research([E23, E25, ENY], "Buy a 2023 Quillon Ember 6 e-reader");
    expect(out.identity.status).toBe("LOCKED");
    expect(out.identity.lockedIdentity.variant).toMatch(/year=2023/);
  });
  it("1st and 2nd Gen, none asked → HOLD with a generation question", async () => {
    const out = await research([P1, P2], "Buy Corvel Pods earbuds");
    expect(out.identity.status).toBe("AMBIGUOUS");
    expect(out.decision.holdReasons.join(" ")).toMatch(/generation/);
  });
  it("a stated generation locks only that generation, through compare", async () => {
    const out = await research([P1, P2], "Buy Corvel Pods (2nd Gen)");
    expect(out.identity.status).toBe("LOCKED");
    expect(out.identity.lockedIdentity.variant).toMatch(/generation=2/);
    const wrong = { ...out.identity.lockedIdentity, variant: out.identity.lockedIdentity.variant.replace("generation=2", "generation=1") };
    await expect(w!.app.gateway.compareOffers("alice", { researchSessionId: out.purchaseSessionId, productIdentity: wrong, destination: { country: "US", region: "CA" } })).rejects.toMatchObject({ code: "IDENTITY_MISMATCH" });
  });
  it("control: a family known in one version only needs no question", async () => {
    const out = await research([E25], "Buy the Quillon Ember 6 e-reader");
    expect(out.identity.status).toBe("LOCKED");
  });
});

describe("N-02 evidence never migrates between generations", () => {
  const prod = (gen: string | null): CatalogProduct => ({ productId: "p", title: `Corvel Pods${gen ? ` (${gen === "1" ? "1st" : "2nd"} Gen)` : ""} Earbuds`, category: "headphones",
    identity: { brand: "Corvel", model: "Pods", variant: gen ? `generation=${gen}` : null, condition: "new", sku: null }, capabilities: [], description: null, reviews: [],
    research: { kind: "STANDALONE", modelBasis: "NAMED_MODEL", attributes: gen ? { generation: gen } : {}, conflictingAxes: [], categoryTitle: "Headphones", titleCondition: null,
      provenance: { provider: "t", providerProductId: "p", observedAt: "", query: null, page: null, mode: null }, alsoListedAs: [], siblingVariants: [] } } as CatalogProduct);
  const st = (p: CatalogProduct, title: string, snippet: string) => statementFrom({ title, snippet }, p, "multipoint");
  it("a page about the 2nd Gen does not count for the 1st Gen, nor the reverse", () => {
    expect(st(prod("1"), "Corvel Pods (2nd Gen) specs", "The Corvel Pods (2nd Gen) support multipoint.")).toBeNull();
    expect(st(prod("2"), "Corvel Pods (1st Gen) specs", "The Corvel Pods support multipoint.")).toBeNull();
  });
  it("an undated family page does not count for a specific generation; a generation page does not count for an unknown one", () => {
    expect(st(prod("2"), "Corvel Pods specs", "The Corvel Pods support multipoint.")).toBeNull();
    expect(st(prod(null), "Corvel Pods (2nd Gen) specs", "The Corvel Pods support multipoint.")).toBeNull();
  });
  it("controls: the same generation counts, in English and Korean", () => {
    expect(st(prod("2"), "Corvel Pods (2nd Gen) specs", "The Corvel Pods (2nd Gen) support multipoint.")?.value).toBe(true);
    expect(st(prod("2"), "Corvel Pods 2세대 사양", "Corvel Pods 2세대는 멀티포인트를 지원한다.")?.value).toBe(true);
  });
});
