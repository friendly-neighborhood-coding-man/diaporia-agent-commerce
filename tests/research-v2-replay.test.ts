/**
 * REPLAY suite: the only inputs here are the two recorded LIVE observations already committed under docs/evidence/
 * (one Channel3 search on 2026-11-09 and one Tavily search on 2026-11-09). No network. The V2 components are run on
 * what the real providers actually returned, not on the synthetic eval world.
 *
 * Recorded data limits (stated, not hidden): the Channel3 smoke kept title + identity only (no offers), so offers are
 * a fixed placeholder; the Tavily check kept url + a 120-character statement, NOT the result titles. The evidence test
 * therefore runs twice: snippets as recorded (no title), and with the title assumed to name the model as each URL slug
 * does ("Sony WH-CH720N review"). That assumed title is the only reconstructed field.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseResearchIntent } from "../src/intent/ResearchIntentV2.js";
import { resolveExactV2 } from "../src/identity/ProductResolverV2.js";
import { SourceRegistry } from "../src/evidence/SourceRegistry.js";
import { classifyItem, judgeV2, statementFrom } from "../src/evidence/EvidenceV2.js";
import { decide } from "../src/decision/DecisionEngine.js";
import type { CatalogProduct, MerchantOffer } from "../src/domain/types.js";

const smoke = JSON.parse(readFileSync("docs/evidence/live-smoke-2026-11-09-16-05-08.json", "utf8"));
const check = JSON.parse(readFileSync("docs/evidence/live-evidence-check-2026-11-09-16-05-42.json", "utf8"));
const NOW = Date.parse("2026-11-10T00:00:00.000Z");

const products: CatalogProduct[] = smoke.channel3Observed.map((o: any, i: number) =>
  ({ productId: `live${i}`, title: o.title, category: "unknown", identity: o.identity, capabilities: [], description: null, reviews: [] }));
const offersOf = (id: string): MerchantOffer[] => [{ offerId: `${id}:o`, productId: id, merchantId: "m", merchantName: "m.example", merchantDomain: "m.example",
  listedIdentity: { brand: "Sony", model: "WH-CH720N", variant: null, condition: "new", sku: null }, itemPriceMinor: 9800, currency: "USD", availability: "IN_STOCK",
  listingUrl: "https://m.example/p", checkoutCapability: "EXTERNAL_CHECKOUT_ONLY", listingText: null, observedAt: new Date(NOW).toISOString(), identityClaim: null }];

describe("replay: recorded live Channel3 search (Sony WH-CH720N, 9 listings)", () => {
  it("'Buy Sony WH-CH720N Black' never locks the Black bundle or a listing whose color is not stated", () => {
    const r = resolveExactV2(parseResearchIntent({ request: "Buy Sony WH-CH720N Black" }) as any, products, offersOf);
    expect(r).toMatchObject({ status: "NOT_FOUND", code: "ATTRIBUTE_NOT_FOUND" });
    if (r.status !== "NOT_FOUND") return;
    const why = Object.fromEntries((r as any).excluded.map((x: any) => [x.productId, x.reason]));
    expect(why.live6).toMatch(/bundle/);
    expect(Object.values(why).filter((w) => /color is not stated/.test(String(w))).length).toBe(8);
  });
  it("'Buy Sony WH-CH720N' locks a standalone listing (never the bundle) and tells the user the variant is unstated", () => {
    const intent = parseResearchIntent({ request: "Buy Sony WH-CH720N" });
    const r = resolveExactV2(intent as any, products, offersOf);
    expect(r.status).toBe("LOCKED");
    if (r.status !== "LOCKED") return;
    expect(r.productId).not.toBe("live6");
    const locked = products.find((p) => p.productId === r.productId)!;
    const d = decide(intent, [{ product: locked, offers: offersOf(locked.productId), must: {}, nice: {}, notChecked: [], limitReached: false }],
      { exactLock: { productId: locked.productId }, now: NOW });
    expect(d.state).toBe("RECOMMEND");
    expect(d.recommendation!.verifyBeforePurchase.join(" ")).toMatch(/states no color or variant/);
    expect(d.recommendation!.priceEvidence.note).toMatch(/never a verified total/);
  });
});

describe("replay: recorded live Tavily results (8 claims V1 labelled INDEPENDENT_REVIEW)", () => {
  const reg = new SourceRegistry({});
  const sony = products[3]!; // "Sony WH-CH720N Wireless Noise Cancelling Headphone"
  const run = (title: string) => check.first.claims.map((c: any) => {
    const sourceClass = reg.classify(c.url, "Sony");
    const st = statementFrom({ title, snippet: c.statement }, sony, "active_noise_cancellation");
    return { url: c.url, sourceClass, item: st ? classifyItem({ url: c.url, domain: new URL(c.url).hostname, sourceClass, value: st.value, quote: st.quote,
      publishedDate: null, provider: "replay", requestId: null, observedAt: "" }, NOW) : null };
  });
  it("source classes: 3 expert, 3 unknown blogs, 1 retailer, 1 forum (V1 called all 8 independent reviews)", () => {
    const by = run("").reduce((m: Record<string, number>, x: any) => ({ ...m, [x.sourceClass]: (m[x.sourceClass] ?? 0) + 1 }), {});
    expect(by).toEqual({ EXPERT_REVIEW: 3, UNKNOWN: 3, RETAILER: 1, USER_FORUM: 1 });
  });
  it("as recorded (no titles), no snippet names the model, so nothing is attributable and ANC stays UNVERIFIED", () => {
    const items = run("").map((x: any) => x.item).filter(Boolean);
    expect(items).toEqual([]);
    expect(judgeV2("active_noise_cancellation", items).status).toBe("UNVERIFIED");
  });
  it("with model-naming titles: VERIFIED by soundguys + whathifi only; table row, retailer, forum and blogs never count", () => {
    const rows = run("Sony WH-CH720N review");
    const host = (u: string) => new URL(u).hostname.replace(/^www\./, "");
    expect(rows.find((x: any) => host(x.url) === "techgearlab.com")!.item).toBeNull(); // table row, not a statement
    expect(rows.find((x: any) => host(x.url) === "amazon.com")!.item).toBeNull();
    const v = judgeV2("active_noise_cancellation", rows.map((x: any) => x.item).filter(Boolean));
    expect(v).toMatchObject({ status: "VERIFIED_TRUE", basis: "TWO_EXPERT_GROUPS", independentGroups: 2 });
    expect(v.evidence.filter((e) => e.counts).map((e) => host(e.url)).sort()).toEqual(["soundguys.com", "whathifi.com"]);
    expect(v.evidence.filter((e) => !e.counts).map((e) => e.whyNotCounted)).toEqual(expect.arrayContaining(["user forum (anecdotal)", "unregistered site (search snippet only)"]));
  });
});
