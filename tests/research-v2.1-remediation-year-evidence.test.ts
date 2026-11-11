/**
 * V21-03 (independent review of V2.1): evidence about one model year never establishes a capability for another, and
 * year-qualified evidence never verifies a product whose year is unknown. New builder-written fictional products
 * (Marrow Quill 13, Ferrous Tide 7) and pages; no IW-1.1 case is copied.
 */
import { afterEach, describe, expect, it } from "vitest";
import { statementFrom } from "../src/evidence/EvidenceV2.js";
import type { CatalogProduct } from "../src/domain/types.js";
import { miniWorld, type MiniProduct } from "./helpers/miniWorld.js";

const prod = (title: string, year: string | null): CatalogProduct => ({
  productId: "p", title, category: "laptops", identity: { brand: "Marrow", model: "Quill 13", variant: year ? `year=${year}` : null, condition: "new", sku: null },
  capabilities: [], description: null, reviews: [],
  research: { kind: "STANDALONE", modelBasis: "NAMED_MODEL", attributes: year ? { year } : {}, conflictingAxes: [], categoryTitle: "Laptops", titleCondition: null,
    provenance: { provider: "t", providerProductId: "p", observedAt: "", query: null, page: null, mode: null }, alsoListedAs: [], siblingVariants: [] } } as CatalogProduct);
const Q25 = prod("Marrow Quill 13 Laptop (2025)", "2025");
const QNY = prod("Marrow Quill 13 Laptop", null);
const st = (p: CatalogProduct, title: string, snippet: string) => statementFrom({ title, snippet }, p, "backlit_keyboard");

describe("V21-03 statementFrom: year attribution", () => {
  it("a page about the other year does not count", () => {
    expect(st(Q25, "Marrow Quill 13 (2024) specifications", "The Marrow Quill 13 has a backlit keyboard.")).toBeNull();
    expect(st(Q25, "Marrow Quill 13 2024 model", "It has a backlit keyboard.")).toBeNull();
  });
  it("a comparison of two years counts only a clause that names this year", () => {
    expect(st(Q25, "Marrow Quill 13 2024 vs 2025", "The 2024 Marrow Quill 13 has a backlit keyboard.")).toBeNull();
    expect(st(Q25, "Marrow Quill 13 2024 vs 2025", "It has a backlit keyboard.")).toBeNull();
    expect(st(Q25, "Marrow Quill 13 2024 vs 2025", "The Marrow Quill 13 (2025) has a backlit keyboard.")?.value).toBe(true);
  });
  it("relative-year phrases point at another product", () => {
    expect(st(Q25, "Marrow Quill 13 (2025) review", "Like last year's model, the Marrow Quill 13 has a backlit keyboard.")).toBeNull();
    expect(st(Q25, "Marrow Quill 13 (2025) review", "The previous generation of the Marrow Quill 13 had a backlit keyboard.")).toBeNull();
    expect(st(Q25, "Marrow Quill 13 (2025) 리뷰", "작년 모델 Marrow Quill 13은 백라이트 키보드를 지원한다.")).toBeNull();
  });
  it("an undated family page does not establish a capability for a dated product", () => {
    expect(st(Q25, "Marrow Quill 13 overview", "The Marrow Quill 13 has a backlit keyboard.")).toBeNull();
  });
  it("a year-qualified statement never verifies a product whose year is unknown", () => {
    expect(st(QNY, "Marrow Quill 13 (2025) specifications", "The Marrow Quill 13 has a backlit keyboard.")).toBeNull();
    expect(st(QNY, "Marrow Quill 13 review", "The 2025 Marrow Quill 13 has a backlit keyboard.")).toBeNull();
  });
  it("controls: the same year counts (English and Korean); an undated page still counts for an undated product; a calendar date is not a model year", () => {
    expect(st(Q25, "Marrow Quill 13 (2025) specifications", "The Marrow Quill 13 has a backlit keyboard.")?.value).toBe(true);
    expect(st(Q25, "Marrow Quill 13 2025년형 사양", "Marrow Quill 13 2025년형은 백라이트 키보드를 지원한다.")?.value).toBe(true);
    expect(st(QNY, "Marrow Quill 13 specifications", "The Marrow Quill 13 has a backlit keyboard.")?.value).toBe(true);
    expect(st(QNY, "Marrow Quill 13 specifications, updated March 2025", "The Marrow Quill 13 has a backlit keyboard.")?.value).toBe(true);
  });
});

describe("V21-03 end to end: only the other year's manufacturer page exists", () => {
  let w: ReturnType<typeof miniWorld> | null = null;
  afterEach(() => { w?.close(); w = null; });
  const tide = (id: string, title: string, price: number): MiniProduct => ({ id, title, brand: "Ferrous", category: "laptops", categoryTitle: "Laptops", price });
  const official = { Ferrous: ["ferrous.example"] };
  const page24 = { match: /tide 7/i, title: "Ferrous Tide 7 (2024) technical specifications", url: "https://ferrous.example/tide-7-2024", content: "The Ferrous Tide 7 has a backlit keyboard and USB-C charging." };
  const page25 = { match: /tide 7/i, title: "Ferrous Tide 7 (2025) technical specifications", url: "https://ferrous.example/tide-7-2025", content: "The Ferrous Tide 7 has a backlit keyboard and USB-C charging." };

  it("the 2025 laptop's backlit keyboard stays unverified when only the 2024 page is retrieved", async () => {
    w = miniWorld([tide("t25", "Ferrous Tide 7 Laptop (2025)", 999)], [page24], { officialDomains: official });
    const out: any = await w.app.gateway.researchPurchase("alice", { request: "Buy the Ferrous Tide 7 (2025) with a backlit keyboard" });
    expect(out.identity.status).toBe("LOCKED");
    expect(out.decision.state).not.toBe("RECOMMEND");
    const row = out.decision.ranking.find((r: any) => r.productId === "ch3:t25");
    expect(row.blockers.map((b: any) => b.code)).toContain("MUST_HAVE_UNVERIFIED");
  });
  it("control: the same year's manufacturer page verifies it", async () => {
    w = miniWorld([tide("t25", "Ferrous Tide 7 Laptop (2025)", 999)], [page25], { officialDomains: official });
    const out: any = await w.app.gateway.researchPurchase("alice", { request: "Buy the Ferrous Tide 7 (2025) with a backlit keyboard" });
    const row = out.decision.ranking.find((r: any) => r.productId === "ch3:t25");
    expect(row.blockers.map((b: any) => b.code)).not.toContain("MUST_HAVE_UNVERIFIED");
    expect(out.decision.state).toBe("RECOMMEND");
  });
});
