/**
 * V2.1 Phase 2: attribution and source identity against adversarial inputs (generalizing review R-01 / R-02).
 * Every case is a statement that must NOT verify the candidate, or a control that must still count. Fail closed:
 * when attribution is ambiguous the clause yields no statement, so the capability stays UNVERIFIED (never wrong-true).
 */
import { describe, expect, it } from "vitest";
import { statementFrom, classifyItem, judgeV2, namesOtherProduct, type EvidenceItem } from "../src/evidence/EvidenceV2.js";
import { SourceRegistry } from "../src/evidence/SourceRegistry.js";
import { mentionsExactModel } from "../src/identity/ProductIdentityExtractor.js";
import { clauseStatement } from "../src/research/capabilities.js";
import type { CatalogProduct } from "../src/domain/types.js";
import { EvidenceRouter } from "../src/evidence/EvidenceRouter.js";
import { TavilySearch } from "../src/evidence/providers.js";
import { Store } from "../src/store/Database.js";
import { UsageLedger, PLACEHOLDER_PRICING } from "../src/metering/UsageLedger.js";

const NOW = Date.parse("2026-11-10T12:00:00.000Z");
const product = (title: string, brand: string, model: string): CatalogProduct =>
  ({ productId: "p", title, category: "headphones", identity: { brand, model, variant: null, condition: "new", sku: null }, capabilities: [], description: null, reviews: [] });
const cx = product("Contoso CX-500 Wireless Headphones", "Contoso", "CX-500");
const aero = product("Northwind Aero Headphones", "Northwind", "Aero");
const st = (title: string, snippet: string, p = cx, cap = "multipoint") => statementFrom({ title, snippet }, p, cap);

describe("unknown brands and product families (not in any starter list)", () => {
  it("a clause about an unlisted brand's product never counts, on a single-product page", () => {
    expect(st("Contoso CX-500 review", "We also tried the Zorvex Aero. It has multipoint.")).toBeNull();
    expect(st("Contoso CX-500 review", "The Zorvex Aero has multipoint.")).toBeNull();
    expect(st("Contoso CX-500 review", "Unlike Zorvex, the headphones have no multipoint.")).toBeNull();
  });
  it("controls: own-brand pronoun clause and a clause naming only this model still count", () => {
    expect(st("Contoso CX-500 review", "It supports multipoint pairing.")).toMatchObject({ value: true });
    expect(st("Contoso CX-500 review", "The Contoso CX-500 supports multipoint.")).toMatchObject({ value: true });
    expect(st("Contoso CX-500 review", "Multipoint works with Spotify Connect and Google Fast Pair turned off.")).toBeNull(); // names Google: fail closed
  });
  it("a word-like model (\"Aero\") needs its brand: another brand's Aero is not this product", () => {
    expect(st("Northwind Aero review", "The Zorvex Aero supports multipoint.", aero)).toBeNull();
    expect(st("Zorvex Aero review", "The Aero supports multipoint.", aero)).toBeNull();
    expect(st("Northwind Aero review", "The Northwind Aero supports multipoint.", aero)).toMatchObject({ value: true });
    expect(st("Northwind Aero review", "It supports multipoint.", aero)).toMatchObject({ value: true });
  });
});

describe("several products in one clause", () => {
  it("a clause naming this model and another product never counts (who has what is ambiguous)", () => {
    expect(st("Contoso CX-500 review", "The Zorvex Aero beats the CX-500 because it has multipoint.")).toBeNull();
    expect(st("Contoso CX-500 review", "Both the CX-500 and the Zorvex Aero support multipoint.")).toBeNull();
    expect(st("Contoso CX-500 review", "The CX-500, like the ZX-9, supports multipoint.")).toBeNull();
  });
});

describe("aliases, versions and suffixes are different models", () => {
  it.each(["CX-500 Gen 2", "CX-500 (2nd Gen)", "CX-500 Mk II", "CX-500 Mark II", "CX-500 V2", "CX-500 2nd generation", "CX-500 프로", "CX-500 Pro", "CX-500S", "CX500X"])("%s is not CX-500", (s) => {
    expect(mentionsExactModel(`The ${s} supports multipoint.`, "CX-500")).toBe(false);
  });
  it.each(["CX-500", "CX500", "cx 500", "CX-500's", "CX-500은"])("%s is CX-500", (s) => {
    expect(mentionsExactModel(`The ${s} supports multipoint.`, "CX-500")).toBe(true);
  });
  it("a successor's statement does not verify the original", () => {
    expect(st("Contoso CX-500 Gen 2 review", "The CX-500 Gen 2 adds multipoint.")).toBeNull();
  });
});

describe("pronouns in comparison reviews", () => {
  it("a pronoun after another product's sentence is about that product", () => {
    expect(st("Contoso CX-500 vs Zorvex Aero", "It has multipoint.")).toBeNull();
    expect(st("Contoso CX-500: our pick", "Our runner-up is the Zorvex Aero. It has multipoint.")).toBeNull();
    expect(st("Contoso CX-500 review", "Compared with the Zorvex Aero, it lacks multipoint.")).toBeNull();
  });
  it("reported or second-hand statements are not independent evidence", () => {
    expect(st("Contoso CX-500 review", "According to RTINGS, the CX-500 supports multipoint.")).toBeNull();
    expect(st("Contoso CX-500 review", "Via rtings.com: the CX-500 supports multipoint.")).toBeNull();
    expect(st("Contoso CX-500 review", "Contoso says the CX-500 supports multipoint.")).toBeNull();
  });
});

describe("English and Korean claims", () => {
  it("Korean statements are read, with negation", () => {
    expect(clauseStatement("CX-500은 멀티포인트를 지원합니다", "multipoint")).toBe(true);
    expect(clauseStatement("CX-500은 멀티포인트를 지원하지 않습니다", "multipoint")).toBe(false);
    expect(clauseStatement("멀티포인트 미지원", "multipoint")).toBe(false);
    expect(clauseStatement("노이즈 캔슬링 기능이 없습니다", "active_noise_cancellation")).toBe(false);
    expect(clauseStatement("노이즈 캔슬링 성능이 뛰어납니다", "active_noise_cancellation")).toBe(true);
    expect(clauseStatement("방수 기능은 없다", "waterproof")).toBe(false);
  });
  it("Korean attribution: another brand named in Hangul, or a Hangul model suffix, never counts", () => {
    expect(st("Contoso CX-500 리뷰", "소니 WH-1000XM5는 멀티포인트를 지원한다.")).toBeNull();
    expect(st("Contoso CX-500 리뷰", "소니 제품은 멀티포인트를 지원한다.")).toBeNull();
    expect(st("Contoso CX-500 리뷰", "CX-500 프로는 멀티포인트를 지원한다.")).toBeNull();
    expect(st("Contoso CX-500 리뷰", "CX-500은 멀티포인트를 지원한다.")).toMatchObject({ value: true });
    expect(st("Contoso CX-500 리뷰", "이 제품은 멀티포인트를 지원하지 않는다.")).toMatchObject({ value: false });
    expect(st("Contoso CX-500 vs 소니 WH-1000XM5 비교", "멀티포인트를 지원한다.")).toBeNull();
  });
  it("a Korean claim about another product inside a Korean comparison does not count", () => {
    expect(namesOtherProduct("삼성 갤럭시 버즈는 멀티포인트를 지원한다", cx)).toBe(true);
  });
});

describe("manufacturer, retailer and expert domain impersonation", () => {
  const reg = new SourceRegistry({ officialDomains: { Contoso: ["contoso.com"] }, expertReviewDomains: ["reviewlab.example"] });
  it.each([
    "https://contoso-official.com/cx-500", "https://contoso.com.evil.net/cx-500", "https://shop-contoso.com/cx", "https://contoso.co/cx",
    "https://xn--cntoso-3ve.com/cx", "https://contoso.store/cx", "https://contosocom.net/cx",
  ])("%s is not the manufacturer", (u) => expect(reg.classify(u, "Contoso")).not.toBe("MANUFACTURER"));
  it("user content hosted on a manufacturer or expert domain is a forum, not the source", () => {
    const r = new SourceRegistry({ officialDomains: { Contoso: ["contoso.com"], Google: ["google.com"] }, expertReviewDomains: ["reviewlab.example"] });
    expect(r.classify("https://community.contoso.com/t/cx-500-multipoint", "Contoso")).toBe("USER_FORUM");
    expect(r.classify("https://discussions.contoso.com/thread/1", "Contoso")).toBe("USER_FORUM");
    expect(r.classify("https://www.contoso.com/community/cx-500", "Contoso")).toBe("USER_FORUM");
    expect(r.classify("https://contoso.com/support/questions/123", "Contoso")).toBe("USER_FORUM");
    expect(r.classify("https://sites.google.com/view/pixel-buds-specs", "Google")).toBe("USER_FORUM");
    expect(r.classify("https://reviewlab.example/forum/cx-500", null)).toBe("USER_FORUM");
    expect(r.classify("https://www.contoso.com/cx-500/specs", "Contoso")).toBe("MANUFACTURER");
  });
  it.each(["https://reviewlab.example.attacker.net/cx", "https://reviewlab-example.com/cx", "https://amazon.com-deals.shop/cx"])("%s gets no registered class", (u) => {
    const c = reg.classify(u, "Contoso");
    expect(c === "UNKNOWN" || c === "USER_FORUM").toBe(true);
  });
  it("a catalog claim's self-declared kind is not trusted without a registered identity", () => {
    const r = new SourceRegistry({ officialDomains: { Contoso: ["contoso.com"] } });
    expect(r.confirmDeclared("MANUFACTURER", "https://contoso-specs.net/cx", "Contoso", null)).toBe("UNKNOWN");
    expect(r.confirmDeclared("INDEPENDENT_REVIEW", "https://some-blog.net/cx", "Contoso", null)).toBe("UNKNOWN");
    expect(r.confirmDeclared("MANUFACTURER", "https://contoso.com/cx", "Contoso", null)).toBe("MANUFACTURER");
  });
});

describe("cross-site copies", () => {
  const item = (domain: string, quote: string): EvidenceItem => classifyItem({ url: `https://${domain}/r`, domain, sourceClass: "EXPERT_REVIEW", value: true, quote,
    publishedDate: "2026-01-01", provider: "t", requestId: null, observedAt: new Date(NOW).toISOString() }, NOW);
  it("short identical statements on two expert domains are one group (syndication), not two", () => {
    expect(judgeV2("multipoint", [item("a-lab.example", "Has multipoint."), item("b-lab.example", "has multipoint")]).status).toBe("UNVERIFIED");
  });
  it("light edits of a copied paragraph are still one group", () => {
    const q = "The CX-500 supports multipoint pairing with two devices at once and switches between them quickly";
    expect(judgeV2("multipoint", [item("a-lab.example", q), item("b-lab.example", `${q}.`.toUpperCase())]).status).toBe("UNVERIFIED");
  });
  it("control: two different expert statements are two groups", () => {
    expect(judgeV2("multipoint", [item("a-lab.example", "The CX-500 supports multipoint."), item("b-lab.example", "In our tests multipoint pairing worked well on the CX-500.")]).status).toBe("VERIFIED_TRUE");
  });
});

describe("stale registries and ownership changes", () => {
  it("a registered domain whose ownership changed only counts for content published inside its validity window", () => {
    const r = new SourceRegistry({ expertReviewDomains: ["oldlab.example"], domainValidity: { "oldlab.example": { until: "2025-06-30" } }, now: () => NOW });
    expect(r.classify("https://oldlab.example/r", null, [], "2024-05-01")).toBe("EXPERT_REVIEW");
    expect(r.classify("https://oldlab.example/r", null, [], "2026-01-01")).toBe("UNKNOWN");
    expect(r.classify("https://oldlab.example/r", null, [], null)).toBe("UNKNOWN");
  });
  it("a brand's former official domain stops being the manufacturer after the change", () => {
    const r = new SourceRegistry({ officialDomains: { Contoso: ["contoso-audio.com", "contoso.com"] }, domainValidity: { "contoso-audio.com": { until: "2025-01-01" } }, now: () => NOW });
    expect(r.classify("https://contoso-audio.com/cx", "Contoso", [], "2026-03-01")).toBe("UNKNOWN");
    expect(r.classify("https://contoso.com/cx", "Contoso", [], "2026-03-01")).toBe("MANUFACTURER");
  });
  it("a registry older than its maximum age registers nothing (fail closed)", () => {
    const r = new SourceRegistry({ officialDomains: { Contoso: ["contoso.com"] }, expertReviewDomains: ["lab.example"], asOf: "2024-01-01", maxAgeDays: 365, now: () => NOW });
    expect(r.isStale()).toBe(true);
    expect(r.classify("https://contoso.com/cx", "Contoso")).toBe("UNKNOWN");
    expect(r.classify("https://lab.example/cx", null)).toBe("UNKNOWN");
    expect(r.classify("https://amazon.com/dp/1", null)).toBe("RETAILER");
  });
});

describe("router integration: classification uses the registry, the publication date and confirmed declared kinds", () => {
  const ledgerFor = (store: Store) => new UsageLedger(store, PLACEHOLDER_PRICING, { perRequestSupplierMicro: 10_000_000, monthlyBillableMinor: 0, perRequestCalls: { TAVILY: 1 } }, () => NOW);
  it("a product claim declared MANUFACTURER on an unregistered domain does not verify", async () => {
    const store = new Store(":memory:");
    const router = new EvidenceRouter(store, ledgerFor(store), null, null, { billable: false, now: () => NOW, policy: "v2", sources: { officialDomains: { Contoso: ["contoso.com"] } } });
    const p = { ...cx, capabilities: [{ capability: "multipoint", value: true, source: { kind: "MANUFACTURER" as const, url: "https://contoso-specs.net/cx", title: "spec", retrievedAt: new Date(NOW).toISOString() } }] };
    const r = await router.verifyMany(p, ["multipoint"], { userId: "u", requestId: "r" });
    expect(r.verdicts.multipoint!.status).toBe("UNVERIFIED");
    const ok = { ...cx, capabilities: [{ capability: "multipoint", value: true, source: { kind: "MANUFACTURER" as const, url: "https://contoso.com/cx", title: "spec", retrievedAt: new Date(NOW).toISOString() } }] };
    expect((await router.verifyMany(ok, ["multipoint"], { userId: "u", requestId: "r2" })).verdicts.multipoint!.status).toBe("VERIFIED_TRUE");
    store.close();
  });
  it("search hits: a brand community page and a post-ownership-change page never verify", async () => {
    const fetchImpl = (async () => Response.json({ request_id: "q", usage: { credits: 1 }, results: [
      { url: "https://community.contoso.com/t/1", title: "Contoso CX-500", content: "The Contoso CX-500 supports multipoint.", published_date: "2026-01-01" },
      { url: "https://oldlab.example/cx-500", title: "Contoso CX-500 review", content: "The CX-500 supports multipoint.", published_date: "2026-02-01" },
      { url: "https://lab.example/cx-500", title: "Contoso CX-500 review", content: "The CX-500 supports multipoint.", published_date: "2026-02-01" }] })) as unknown as typeof fetch;
    const store = new Store(":memory:");
    const router = new EvidenceRouter(store, ledgerFor(store), new TavilySearch("tvly-TEST-0000000", "community", fetchImpl), null, { billable: false, now: () => NOW, policy: "v2",
      sources: { officialDomains: { Contoso: ["contoso.com"] }, expertReviewDomains: ["oldlab.example", "lab.example"], domainValidity: { "oldlab.example": { until: "2025-06-30" } } } });
    const r = await router.verifyMany(cx, ["multipoint"], { userId: "u", requestId: "r" });
    const classes = r.verdicts.multipoint!.evidence.map((e) => `${e.domain}:${e.sourceClass}`);
    expect(classes).toEqual(expect.arrayContaining(["community.contoso.com:USER_FORUM", "oldlab.example:UNKNOWN", "lab.example:EXPERT_REVIEW"]));
    expect(r.verdicts.multipoint!.status).toBe("UNVERIFIED"); // one expert group only
    store.close();
  });
});
