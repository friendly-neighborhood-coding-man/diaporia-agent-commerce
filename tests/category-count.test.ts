import { describe, expect, it } from "vitest";
import { ARMS, FACETS, FINE, STATUSES, TAXONOMY, fineOf, groupOf, categoriesOf } from "../src/intent/hybrid/category/CategoryTaxonomy.js";
import { validateDocument, projectToV11, classify, documentSchema } from "../src/intent/hybrid/category/CategoryIntent.js";
import { SemanticIntentV1 } from "../src/intent/hybrid/SemanticIntent.js";

const unit = (o: Record<string, unknown>): any => ({ attribute: null, operator: null, value: null, unit: null, target: "item", component: null, resolution: "resolved", en: "x", brand_latin: null, brand_latin_alternatives: [], ...o });

describe("category-count taxonomies", () => {
  it("every arm partitions the seven fine categories exactly once", () => {
    for (const arm of ARMS) {
      const t = TAXONOMY[arm === "K3F" ? "K3" : arm];
      expect(t.flatMap((c) => c.fine).sort()).toEqual([...FINE].sort());
      expect(t.length).toBe(arm === "K3F" ? 3 : Number(arm.slice(1)));
    }
  });
  it("is a nested refinement chain K3 -> K7", () => {
    const order = ["K3", "K4", "K5", "K6", "K7"] as const;
    for (let i = 1; i < order.length; i++) for (const f of FINE) {
      const fineGroup = TAXONOMY[order[i]!].find((c) => c.fine.includes(f))!.fine;
      const coarseGroup = TAXONOMY[order[i - 1]!].find((c) => c.fine.includes(f))!.fine;
      expect(fineGroup.every((x) => coarseGroup.includes(x))).toBe(true);
    }
  });
  it("unresolved is never a category", () => { for (const a of ARMS) expect(categoriesOf(a).map((c) => c.toLowerCase())).not.toContain("unresolved"); });
  it("fineOf is total over meaningful facet/status pairs and groupOf maps into the arm", () => {
    for (const f of FACETS) for (const s of STATUSES) { const fine = fineOf(f, s); if (fine) for (const a of ARMS) expect(categoriesOf(a)).toContain(groupOf(a, fine)); }
    expect(fineOf("background", "mandatory")).toBeNull();
    expect(fineOf("feature", "forbidden")).toBe("EXCLUSION");
    expect(fineOf("condition", "forbidden")).toBe("PURCHASE");
  });
});

describe("validation and projection", () => {
  const req = "roof box for a car with raised side rails, no crossbars, under $500";
  const units = [
    unit({ span: "roof box", category: "IDENTITY", facet: "product_type", status: "mandatory", operator: "is" }),
    unit({ span: "for a car with raised side rails", category: "BINDING", facet: "compatibility", status: "mandatory", operator: "fits", target: "host" }),
    unit({ span: "no crossbars", category: "NON_BINDING", facet: "feature", status: "forbidden" }), // conflict: forbidden is BINDING in K3
    unit({ span: "under $500", category: "BINDING", facet: "budget", status: "mandatory", operator: "<", value: 500, unit: "USD", target: "purchase" }),
  ];
  const doc = { taxonomy: "K3", language: "en", item_kind: "STANDALONE", units, unresolved: [] };
  it("flags classification conflicts and withholds them from execution", () => {
    const { doc: d, v } = validateDocument("K3", req, doc);
    expect(v.schemaValid).toBe(true);
    expect(v.conflicts).toHaveLength(1);
    expect(v.uncovered).toEqual([]);
    const p = projectToV11("K3", req, d!);
    expect(p.trace.withheld.map((w) => w.span)).toEqual(["no crossbars"]);
    expect(SemanticIntentV1.safeParse(p.v11).success).toBe(true);
    expect((p.v11 as any).constraints.map((c: any) => c.role)).toEqual(["compatibility"]);
    expect((p.v11 as any).budget).toEqual({ span: "under $500" });
  });
  it("the same atomic units project identically in every arm", () => {
    const k7 = units.map((u) => ({ ...u, category: groupOf("K7", fineOf(u.facet as any, u.status as any)!) }));
    const outs = ARMS.map((a) => { const us = k7.map((u) => ({ ...u, category: groupOf(a, fineOf(u.facet as any, u.status as any)!), ...(a === "K3F" ? { subtype: null } : {}) }));
      const { doc: d } = validateDocument(a, req, { ...doc, taxonomy: a, units: us }); return JSON.stringify(projectToV11(a, req, d!).v11); });
    expect(new Set(outs).size).toBe(1);
  });
  it("reports uncovered meaningful words and rejects non-verbatim spans", () => {
    const { v } = validateDocument("K7", "tent with a vestibule", { taxonomy: "K7", language: "en", item_kind: "STANDALONE", units: [unit({ span: "tents", category: "IDENTITY", facet: "product_type", status: "mandatory" })], unresolved: [] });
    expect(v.nonVerbatim).toEqual(["tents"]);
    expect(v.uncovered).toEqual(["tent", "vestibule"]);
  });
  it("K3F sub-type must agree with the atomic fields", () => {
    const u = { ...unit({ span: "no wifi", category: "BINDING", facet: "feature", status: "forbidden" }), subtype: "REQUIREMENT" };
    expect(classify("K3F", u as any).ok).toBe(false);
    expect(classify("K3F", { ...u, subtype: "EXCLUSION" } as any).ok).toBe(true);
    expect(documentSchema("K7").safeParse({ taxonomy: "K7", language: "en", item_kind: "STANDALONE", units: [{ ...u, category: "EXCLUSION" }], unresolved: [] }).success).toBe(true);
  });
});
