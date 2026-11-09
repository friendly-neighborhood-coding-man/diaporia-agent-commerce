/** Offline tests for the live adapters and for defects observed in the 2026-11-09 live smoke run. */
import { describe, expect, it } from "vitest";
import { Channel3ResearchAdapter, modelToken, BUNDLE_RE } from "../src/research/Channel3ResearchAdapter.js";
import { ProductIdentityResolver } from "../src/identity/ProductIdentityResolver.js";
import { EvidenceRouter } from "../src/evidence/EvidenceRouter.js";
import { Store } from "../src/store/Database.js";
import { UsageLedger, LIVE_PRICES_UNKNOWN } from "../src/metering/UsageLedger.js";
import type { IndependentSearchProvider } from "../src/evidence/EvidenceRouter.js";
import type { CatalogProduct } from "../src/domain/types.js";

const KEY = "ch3-FAKE-KEY-0123456789";
const sample = { products: [
  { id: "A1", title: "Sony WH-CH720N Wireless Noise Cancelling Headphone Black w/ Pro Stand Kit", brands: [{ name: "Sony" }],
    offers: [{ domain: "bestbuy.com", url: "https://buy.example/abc?aff=123", price: { price: 129.99, currency: "USD" }, availability: "InStock", condition: "New" }] },
  { id: "A2", title: "Sony WH-CH720N Noise Canceling Wireless Headphones - Black", brands: [{ name: "Sony" }],
    offers: [{ domain: "cdw.com", url: "https://buy.example/def", price: { price: 99.99, currency: "USD" }, availability: "InStock", condition: "New" }] },
  { id: "A3", title: "Wireless headphones", brands: [{ name: "Generic" }], offers: [] },
] };

describe("Channel3ResearchAdapter (fake HTTP)", () => {
  it("normalizes listings, separates bundles from the bare model, strips URL queries, never quotes, never leaks the key", async () => {
    let sentKey = ""; let body: any = null;
    const a = new Channel3ResearchAdapter(KEY, { fetchImpl: (async (_u: any, init: RequestInit) => { sentKey = (init.headers as Record<string, string>)["x-api-key"]!; body = JSON.parse(String(init.body)); return Response.json(sample); }) as typeof fetch });
    const products = await a.searchProducts({ text: "Buy Sony WH-CH720N Black", category: null, brand: "Sony", model: "WH-CH720N" });
    expect(sentKey).toBe(KEY);
    expect(body).toMatchObject({ query: "Sony WH-CH720N", config: { mode: "default" } });
    expect(products.map((p) => p.identity.variant)).toEqual(["Black BUNDLE", "Black"]);
    const res = new ProductIdentityResolver().resolve({ brand: "Sony", model: "WH-CH720N", variant: "Black", condition: null, sku: null }, products);
    expect(res.status).toBe("LOCKED");
    if (res.status === "LOCKED") expect(res.productId).toBe("ch3:A2"); // the bundle is not the exact product
    const offers = await a.findOffers(products[1]!.identity);
    expect(offers.every((o) => o.checkoutCapability === "EXTERNAL_CHECKOUT_ONLY" && !o.listingUrl?.includes("?"))).toBe(true);
    expect(await a.getQuote()).toBeNull();
    expect(JSON.stringify(a)).not.toContain(KEY);
    expect(modelToken("Sony WH-1000XM5 Black")).toBe("WH-1000XM5");
    expect(BUNDLE_RE.test("Sony WH-CH720N + Case")).toBe(true);
    expect(BUNDLE_RE.test("Sony WH-CH720N Wireless Headphones")).toBe(false);
  });
});

describe("Evidence Router negation and labels (observed live defect)", () => {
  const product: CatalogProduct = { productId: "p", title: "Sony WH-CH720N", category: "headphones", identity: { brand: "Sony", model: "WH-CH720N", variant: "Black", condition: "new", sku: null }, capabilities: [], description: null, reviews: [] };
  const run = async (hits: Array<{ url: string; title: string; snippet: string }>) => {
    const store = new Store(":memory:");
    const ledger = new UsageLedger(store, LIVE_PRICES_UNKNOWN, { perRequestSupplierMicro: 0, monthlyBillableMinor: 0, perRequestCalls: { TAVILY: 2 } });
    const search: IndependentSearchProvider = { name: "fake-tavily", provenance: "MOCK", search: async () => hits };
    return new EvidenceRouter(store, ledger, search, null).verify(product, "active_noise_cancellation", { userId: "u", requestId: "r" });
  };
  it("a comparative 'not as strong' sentence is not a denial of the feature", async () => {
    const r = await run([
      { url: "https://a.example/r", title: "Sony WH-CH720N review", snippet: "The Sony WH-CH720N noise cancelling is not as strong as the XM5, but it works well on trains." },
      { url: "https://b.example/r", title: "WH-CH720N tested", snippet: "Sony WH-CH720N active noise cancelling handled office chatter in our test." },
    ]);
    expect(r.sufficiency).toBe("SUFFICIENT_TRUE");
  });
  it("an explicit denial counts as negative; disagreement is labelled for review, not as sufficient", async () => {
    const r = await run([
      { url: "https://a.example/r", title: "Sony WH-CH720N", snippet: "The Sony WH-CH720N has no noise cancelling at all." },
      { url: "https://b.example/r", title: "WH-CH720N", snippet: "Sony WH-CH720N active noise cancelling handled office chatter." },
    ]);
    expect(r.sufficiency).toBe("CONTRADICTED");
    expect(r.reason).toBe("CONTRADICTED_EVIDENCE_NEEDS_REVIEW");
  });
});
