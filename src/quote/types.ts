import type { Currency } from "../domain/money.js";

/**
 * How much a price can be trusted. Ordered from weakest to strongest; nothing is ever promoted
 * without the corresponding evidence.
 *  - LISTING_PRICE: a catalog/search price for one unit. Not a checkout total.
 *  - CART_ESTIMATE: a merchant system priced a cart (items, delivery option), but the merchant marks
 *    the total as estimated or a component (e.g. tax) is unknown. Not a commitment.
 *  - FINAL_QUOTE_VERIFIED: a merchant-attested, non-estimated, fully itemized total with an expiry.
 *    NO provider in this repository produces it (Shopify's Storefront Cart API gives no such guarantee).
 *  - UNAVAILABLE: the merchant reports the exact variant cannot be sold (out of stock / not for sale).
 *  - UNKNOWN: the observation could not establish the quote (identity mismatch, currency mismatch, error).
 */
export type QuoteStatus = "LISTING_PRICE" | "CART_ESTIMATE" | "FINAL_QUOTE_VERIFIED" | "UNAVAILABLE" | "UNKNOWN";

export type QuoteProvenance = "FIXTURE" | "MOCK" | "MERCHANT_API";

export type QuoteIssue =
  | "VARIANT_MISMATCH" | "VARIANT_UNAVAILABLE" | "QUANTITY_NOT_IN_CART" | "DESTINATION_MISSING" | "NO_DELIVERY_OPTIONS"
  | "DELIVERY_OPTION_NOT_SELECTED" | "TOTAL_ESTIMATED" | "TAX_NOT_ITEMIZED" | "CURRENCY_MISMATCH" | "CHECKOUT_URL_INVALID"
  | "MERCHANT_USER_ERROR" | "PROVIDER_WARNING";

export interface QuoteDeliveryOption {
  handle: string;
  title: string | null;
  methodType: string;
  costMinor: number;
  currency: Currency;
}

export interface QuoteEvidence {
  status: QuoteStatus;
  provider: string;
  provenance: QuoteProvenance;
  /** API version or fixture name the observation came from. */
  source: string;
  observedAt: string;
  expiresAt: string;
  currency: Currency | null;
  variant: { requestedId: string; returnedId: string | null; title: string | null; sku: string | null; availableForSale: boolean | null; quantity: number | null };
  subtotalMinor: number | null;
  subtotalEstimated: boolean | null;
  deliveryOptions: QuoteDeliveryOption[];
  selectedDeliveryOption: QuoteDeliveryOption | null;
  /** Cart total as the merchant reports it. Meaningful only together with totalEstimated. */
  merchantTotalMinor: number | null;
  totalEstimated: boolean | null;
  /** Merchant-hosted checkout for external handoff. DIAPORIA never pays this merchant. */
  externalCheckoutUrl: string | null;
  /** Opaque reference for audit; the raw cart id/key is never exposed. */
  cartRef: string | null;
  issues: QuoteIssue[];
  messages: string[];
}

export class QuoteProviderError extends Error {
  constructor(message: string, readonly code: "TIMEOUT" | "THROTTLED" | "ACCESS_DENIED" | "GRAPHQL_ERROR" | "HTTP_ERROR" | "INVALID_RESPONSE" | "CONFIG") { super(message); }
}
