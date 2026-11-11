/** Research V2 Stage A: identity extraction and the Channel3 v1 contract adapter (fake HTTP, offline). */
import { describe, expect, it } from "vitest";
import { extractIdentity, canonicalVariant, mentionsExactModel, modelNumberToken, familyKey } from "../src/identity/ProductIdentityExtractor.js";
import { Channel3ResearchAdapter } from "../src/research/Channel3ResearchAdapter.js";

const KEY = "ch3-FAKE-KEY-0123456789";
const v = (t: string, b: string) => { const x = extractIdentity(t, b); return canonicalVariant(x.attributes, x.kind, x.accessoryNoun); };

describe("ProductIdentityExtractor (multi-category)", () => {
  it("units are never model numbers", () => {
    expect(modelNumberToken("Proseware Brewmaster 12-Cup Coffee Maker")).toBeNull();
    expect(modelNumberToken("Litware Nova 9 128GB")).toBeNull();
    expect(modelNumberToken("Contoso CX-500 Black")).toBe("CX-500");
  });
  it("named models keep their family extension (Nova 9 ≠ Nova 9 Pro)", () => {
    expect(extractIdentity("Litware Nova 9 Pro 256GB Black", "Litware").model).toBe("Nova 9 Pro");
    expect(extractIdentity("Litware Nova 9 128GB Black", "Litware").model).toBe("Nova 9");
    expect(familyKey("Litware", "Nova 9")).not.toBe(familyKey("Litware", "Nova 9 Pro"));
    expect(mentionsExactModel("The Nova 9 Pro is waterproof", "Nova 9")).toBe(false);
    expect(mentionsExactModel("The Nova 9 is waterproof", "Nova 9")).toBe(true);
  });
  it("sizes, capacities, storage and packs become variant axes", () => {
    expect(v("Woodgrove Trail Runner Moss Size 10.5", "Woodgrove")).toBe("Moss / size=10.5");
    expect(v("Proseware Brewmaster 8-Cup Coffee Maker", "Proseware")).toBe("capacity=8 cup");
    expect(v("Adatum Summit 32 oz Bottle 2-Pack", "Adatum")).toBe("capacity=32 oz / pack=2 BUNDLE");
  });
  it("accessories are never the product they fit", () => {
    const x = extractIdentity("Replacement Glass Carafe for Proseware Brewmaster 12-Cup", "Proseware");
    expect(x.kind).toBe("ACCESSORY");
    expect(x.model).toBe("Brewmaster");
  });
});

describe("Channel3ResearchAdapter v1 contract (fake HTTP)", () => {
  const item = (id: string, title: string, extra: Record<string, unknown> = {}) => ({ id, title, brands: [{ name: "Contoso" }],
    offers: [{ domain: `${id}.example`, url: `https://${id}.example/p?x=1`, price: { price: 99.5, currency: "USD" }, availability: "InStock", condition: null }], ...extra });
  const fake = (pages: unknown[], seen: any[]) => (async (_u: any, init: RequestInit) => { seen.push(JSON.parse(String(init.body))); return Response.json(pages[seen.length - 1]); }) as typeof fetch;

  it("sends documented body fields (limit ≤30, filters.price in major units, config currency/country); KRW is not sent", async () => {
    const seen: any[] = [];
    const a = new Channel3ResearchAdapter(KEY, { fetchImpl: fake([{ products: [] }, { products: [] }], seen) });
    await a.searchPage({ text: "x", category: null, brand: null, model: null, query: "wireless headphones", currency: "EUR", country: "DE", maxPriceMinor: 12_345, limit: 99, conditions: ["new"] });
    expect(seen[0]).toEqual({ query: "wireless headphones", limit: 30, filters: { conditions: ["new"], price: { max_price: 123.45 } }, config: { mode: "default", currency: "EUR", country: "DE" } });
    const p = await a.searchPage({ text: "x", category: null, brand: null, model: null, query: "q", currency: "KRW", country: "KR" });
    expect(seen[1].config).toEqual({ mode: "default" });
    expect(p.locale).toMatchObject({ currencyRequested: "KRW", currencySent: null, supported: false });
  });
  it("variants.selected is authoritative; a conflicting title makes that axis CONFLICT; null condition is unknown, never new", async () => {
    const seen: any[] = [];
    const a = new Channel3ResearchAdapter(KEY, { fetchImpl: fake([{ products: [
      item("a", "Contoso CX-500 Wireless Headphones", { variants: { options: [], selected: [{ name: "Color", label: "black" }] } }),
      item("b", "Contoso CX-500 Wireless Headphones White", { variants: { options: [], selected: [{ name: "Color", label: "Black" }] } }),
    ], next_page_token: "t2" }], seen) });
    const r = await a.searchPage({ text: "x", category: null, brand: null, model: null, query: "cx-500" });
    expect(r.products.map((p) => p.identity.variant)).toEqual(["Black", "CONFLICT"]);
    expect(r.products[1]!.research!.conflictingAxes).toEqual(["color"]);
    expect(r.nextPageToken).toBe("t2");
    const offers = await a.findOffers(r.products[0]!.identity);
    expect(offers.every((o) => o.listedIdentity.condition === "unknown" && o.listingUrl?.endsWith("/p"))).toBe(true);
  });
  it("duplicate listings of one identity merge offers and record the alias; bundles never merge with the bare product", async () => {
    const seen: any[] = [];
    const a = new Channel3ResearchAdapter(KEY, { fetchImpl: fake([{ products: [
      item("a", "Contoso CX-500 Black"), item("b", "Contoso CX500 Headphones - Black"), item("c", "Contoso CX-500 Black w/ Travel Case Bundle"),
    ] }], seen) });
    const r = await a.searchPage({ text: "x", category: null, brand: null, model: null, query: "cx-500" });
    expect(r.products).toHaveLength(2);
    expect(r.products[0]!.research!.alsoListedAs).toEqual(["b"]);
    expect((await a.findOffers(r.products[0]!.identity)).map((o) => o.merchantDomain).sort()).toEqual(["a.example", "b.example", "c.example"]);
    expect(r.products[1]!.identity.variant).toBe("Black BUNDLE");
  });
  it("retries only 429/5xx, bounded, and counts every attempt", async () => {
    let n = 0;
    const a = new Channel3ResearchAdapter(KEY, { retry: { attempts: 2, baseDelayMs: 1, maxRetryAfterMs: 1 },
      fetchImpl: (async () => { n++; return new Response("busy", { status: 429, headers: { "retry-after": "1" } }); }) as typeof fetch });
    await expect(a.searchPage({ text: "x", category: null, brand: null, model: null })).rejects.toThrow(/HTTP 429/);
    expect(n).toBe(2); expect(a.calls).toBe(2);
    let m = 0;
    const b = new Channel3ResearchAdapter(KEY, { fetchImpl: (async () => { m++; return new Response("bad", { status: 400 }); }) as typeof fetch });
    await expect(b.searchPage({ text: "x", category: null, brand: null, model: null })).rejects.toThrow(/HTTP 400/);
    expect(m).toBe(1);
  });
  it("resolveVariant reports a relaxed (impossible) selection as not honored", async () => {
    const a = new Channel3ResearchAdapter(KEY, { fetchImpl: (async () => Response.json(item("n128", "Contoso Nova 9 128GB Black",
      { variants: { options: [], selected: [{ name: "Storage", label: "128 GB" }] } }))) as typeof fetch });
    expect((await a.resolveVariant("ch3:n128", { Storage: "512GB" })).honored).toBe(false);
    expect((await a.resolveVariant("ch3:n128", { Storage: "128GB" })).honored).toBe(true);
  });
});
