import { createHash } from "node:crypto";
import type { CatalogProduct, MerchantOffer, MerchantQuote, ProductIdentity, ShippingDestination } from "../domain/types.js";
import { FIXTURE_OFFERS, FIXTURE_PRODUCTS } from "./fixtures.js";
import { normalizeModel } from "../identity/ProductIdentityResolver.js";
import { MERCHANT_CLAIMS } from "../merchant-identity/fixtures.js";

export interface ProductSearchQuery {
  text: string;
  category: string | null;
  brand: string | null;
  model: string | null;
  /** Research V2 (optional; adapters that do not support a field ignore it). Explicit provider query string. */
  query?: string;
  currency?: string | null;
  country?: string | null;
  /** Upper price filter in minor units of `currency` (a search filter only, never a budget authority). */
  maxPriceMinor?: number | null;
  conditions?: Array<"new" | "used">;
  mode?: "default" | "keyword" | "agentic";
  limit?: number;
}

/** One provider page (research V2). */
export interface SearchPage {
  products: CatalogProduct[];
  nextPageToken: string | null;
  /** Provider HTTP attempts this page cost (including bounded retries). */
  providerCalls: number;
  locale?: { currencyRequested: string | null; currencySent: string | null; supported: boolean };
}

/**
 * Port for product research, offer discovery and merchant quotes. Implementations:
 * - MockCommerceResearchAdapter: deterministic public fixtures (this repo).
 * - A private DIAPORIA Buy adapter (Channel3 catalog + Tavily/Kernel evidence) may
 *   implement the same port; it is not part of the public release.
 */
export interface CommerceResearchAdapter {
  readonly name: string;
  /** True when results come from fixtures, so every output is labelled as mock data. */
  readonly isMock: boolean;
  searchProducts(query: ProductSearchQuery): Promise<CatalogProduct[]>;
  getProduct(productId: string): Promise<CatalogProduct | null>;
  /** Offers that MAY be the requested product. Verification decides whether they are. */
  findOffers(identity: ProductIdentity): Promise<MerchantOffer[]>;
  /** Merchant-attested quote. Returns null when the merchant offers no quote. */
  getQuote(offerId: string, quantity: number, destination: ShippingDestination | null): Promise<MerchantQuote | null>;
  /** Optional (research V2): one metered provider page. Absent = searchProducts is the only search. */
  searchPage?(query: ProductSearchQuery, pageToken: string | null, page: number): Promise<SearchPage>;
}

export class MockCommerceResearchAdapter implements CommerceResearchAdapter {
  readonly name = "mock-fixtures";
  readonly isMock = true;
  constructor(private readonly now: () => number = Date.now) {}

  async searchProducts(query: ProductSearchQuery): Promise<CatalogProduct[]> {
    const text = query.text.toLowerCase();
    return structuredClone(FIXTURE_PRODUCTS.filter((p) => {
      if (query.model) return normalizeModel(p.identity.model) === normalizeModel(query.model);
      if (query.brand && p.identity.brand.toLowerCase() !== query.brand.toLowerCase()) return false;
      if (query.category) return p.category === query.category;
      return /headphone|earbud|earphone|audio/.test(text) ? p.category === "headphones" : false;
    }));
  }

  async getProduct(productId: string): Promise<CatalogProduct | null> {
    const p = FIXTURE_PRODUCTS.find((x) => x.productId === productId);
    return p ? structuredClone(p) : null;
  }

  async findOffers(identity: ProductIdentity): Promise<MerchantOffer[]> {
    const observedAt = new Date(this.now() - 60_000).toISOString();
    const productIds = new Set(FIXTURE_PRODUCTS
      .filter((p) => p.identity.brand.toLowerCase() === identity.brand.toLowerCase() && normalizeModel(p.identity.model) === normalizeModel(identity.model))
      .map((p) => p.productId));
    return FIXTURE_OFFERS.filter((f) => productIds.has(f.offer.productId))
      .map((f) => ({ ...structuredClone(f.offer), observedAt, identityClaim: structuredClone(MERCHANT_CLAIMS[f.offer.merchantDomain] ?? null) }));
  }

  async getQuote(offerId: string, quantity: number, destination: ShippingDestination | null): Promise<MerchantQuote | null> {
    const fixture = FIXTURE_OFFERS.find((f) => f.offer.offerId === offerId);
    if (!fixture?.quote || fixture.offer.availability !== "IN_STOCK") return null;
    const rule = fixture.quote;
    const item = fixture.offer.itemPriceMinor * quantity;
    const quotedAtMs = this.now() - rule.ageSeconds * 1000;
    // Tax can only be quoted for a known destination. Unknown tax stays null, never 0.
    const taxMinor = destination && rule.taxRateBps !== null ? Math.round((item * rule.taxRateBps) / 10_000) : null;
    const quoteId = "qt_" + createHash("sha256").update(`${offerId}|${quantity}|${JSON.stringify(destination)}|${quotedAtMs}`).digest("hex").slice(0, 20);
    return {
      quoteId, offerId, quantity, currency: fixture.offer.currency, itemPriceMinor: item,
      shippingMinor: rule.shippingMinor, taxMinor, feesMinor: 0, discountMinor: 0,
      quotedAt: new Date(quotedAtMs).toISOString(), expiresAt: new Date(quotedAtMs + rule.ttlSeconds * 1000).toISOString(),
      source: "MOCK_MERCHANT_QUOTE_API",
    };
  }
}
