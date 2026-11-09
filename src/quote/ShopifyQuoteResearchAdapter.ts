import { randomUUID } from "node:crypto";
import type { CatalogProduct, MerchantOffer, MerchantQuote, ProductIdentity, ShippingDestination } from "../domain/types.js";
import type { Currency } from "../domain/money.js";
import type { CommerceResearchAdapter, ProductSearchQuery } from "../research/CommerceResearchAdapter.js";
import { QuoteProviderError } from "./types.js";
import type { ShopifyCartQuoteProvider } from "./ShopifyCartQuoteProvider.js";

/** A Shopify merchant listing DIAPORIA knows about (configured, not scraped). */
export interface ShopifyListing {
  offerId: string;
  productId: string;
  identity: ProductIdentity;
  variantId: string;
  merchantName: string;
  shopDomain: string;
  /** Catalog/listing price for one unit. A LISTING_PRICE, never a checkout total. */
  listingPriceMinor: number;
  currency: Currency;
}

/**
 * Adds Shopify-quoted offers to an existing research adapter. Catalog and identity research stay with
 * the base adapter; this adapter only contributes merchant offers and cart-based quotes.
 * Shopify offers are always EXTERNAL_CHECKOUT_ONLY: DIAPORIA hands off to the merchant's checkout
 * and never pays the merchant through its own PayPal account.
 */
export class ShopifyQuoteResearchAdapter implements CommerceResearchAdapter {
  readonly name: string;
  readonly isMock: boolean;
  /** Last provider failure per offer, for diagnostics (no secrets). */
  readonly lastErrors = new Map<string, string>();

  constructor(private readonly base: CommerceResearchAdapter, private readonly provider: ShopifyCartQuoteProvider,
    private readonly listings: ShopifyListing[], private readonly opts: { defaultCountry: string; providerIsFixture: boolean; now?: () => number }) {
    this.name = `${base.name}+shopify-cart${opts.providerIsFixture ? "(fixture)" : ""}`;
    this.isMock = base.isMock || opts.providerIsFixture;
  }

  searchProducts(q: ProductSearchQuery): Promise<CatalogProduct[]> { return this.base.searchProducts(q); }
  getProduct(id: string) { return this.base.getProduct(id); }

  async findOffers(identity: ProductIdentity): Promise<MerchantOffer[]> {
    const observedAt = new Date((this.opts.now ?? Date.now)()).toISOString();
    const extra = this.listings.filter((l) => l.identity.brand.toLowerCase() === identity.brand.toLowerCase() &&
      l.identity.model.replace(/[^A-Z0-9]/gi, "").toUpperCase() === identity.model.replace(/[^A-Z0-9]/gi, "").toUpperCase())
      .map((l): MerchantOffer => ({
        offerId: l.offerId, productId: l.productId, merchantId: `mer_shopify_${l.shopDomain.split(".")[0]!.replace(/-/g, "_")}`,
        merchantName: l.merchantName, merchantDomain: l.shopDomain, listedIdentity: l.identity, itemPriceMinor: l.listingPriceMinor, currency: l.currency,
        // Availability is only known once the merchant prices a cart.
        availability: "UNKNOWN", listingUrl: `https://${l.shopDomain}/`, checkoutCapability: "EXTERNAL_CHECKOUT_ONLY", listingText: null, observedAt,
        identityClaim: null,
      }));
    return [...(await this.base.findOffers(identity)), ...extra];
  }

  isShopifyOffer(offerId: string) { return this.listings.some((l) => l.offerId === offerId); }

  async getQuote(offerId: string, quantity: number, destination: ShippingDestination | null): Promise<MerchantQuote | null> {
    const l = this.listings.find((x) => x.offerId === offerId);
    if (!l) return this.base.getQuote(offerId, quantity, destination);
    let ev;
    try {
      ev = await this.provider.quote({ variantId: l.variantId, quantity, currency: l.currency, countryCode: destination?.country ?? this.opts.defaultCountry,
        destination: destination ? { countryCode: destination.country, provinceCode: destination.region, zip: destination.postalCode } : null });
      this.lastErrors.delete(offerId);
    } catch (e) {
      this.lastErrors.set(offerId, e instanceof QuoteProviderError ? `${e.code}: ${e.message}` : "provider error");
      return null; // shows up as NO_MERCHANT_QUOTE; never a guessed price
    }
    return {
      quoteId: ev.cartRef ?? `qt_${randomUUID()}`, offerId, quantity, currency: ev.currency ?? l.currency,
      itemPriceMinor: ev.subtotalMinor ?? l.listingPriceMinor * quantity,
      shippingMinor: ev.selectedDeliveryOption?.costMinor ?? null,
      taxMinor: null,   // Storefront CartCost does not itemize tax (deprecated fields not used)
      feesMinor: null,  // duties/fees are not itemized either
      discountMinor: 0,
      quotedAt: ev.observedAt, expiresAt: ev.expiresAt, source: `SHOPIFY_STOREFRONT_CART:${ev.provenance}`,
      evidence: ev,
    };
  }
}
