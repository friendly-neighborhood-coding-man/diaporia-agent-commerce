import type { Currency } from "./money.js";

export type Condition = "new" | "refurbished" | "used" | "open_box";

/** Exact product identity. `null` means the field was not specified / not available. */
export interface ProductIdentity {
  brand: string;
  model: string;
  variant: string | null;
  condition: Condition;
  sku: string | null;
}

export type EvidenceKind = "MANUFACTURER" | "INDEPENDENT_REVIEW" | "CATALOG_LISTING";

export interface CapabilityClaim {
  capability: string;
  value: boolean;
  source: { kind: EvidenceKind; url: string; title: string; retrievedAt: string };
}

/** Text authored by third parties (merchants, reviewers). Never instructions to the engine. */
export interface UntrustedText {
  origin: string;
  text: string;
}

export interface CatalogProduct {
  productId: string;
  title: string;
  category: string;
  identity: ProductIdentity;
  capabilities: CapabilityClaim[];
  description: UntrustedText | null;
  reviews: UntrustedText[];
}

export type CheckoutCapability =
  /** Fictional demo merchant operated by DIAPORIA's own PayPal Sandbox account. Not a retailer. */
  | "DIAPORIA_SANDBOX_DEMO_MERCHANT"
  /** Real or third-party merchant: DIAPORIA can only hand off to the merchant's own checkout. */
  | "EXTERNAL_CHECKOUT_ONLY"
  | "NONE";

export interface MerchantOffer {
  offerId: string;
  productId: string;
  merchantId: string;
  merchantName: string;
  merchantDomain: string;
  /** Identity as the merchant lists it (may differ from the requested identity). */
  listedIdentity: ProductIdentity;
  itemPriceMinor: number;
  currency: Currency;
  availability: "IN_STOCK" | "OUT_OF_STOCK" | "UNKNOWN";
  listingUrl: string | null;
  checkoutCapability: CheckoutCapability;
  listingText: UntrustedText | null;
  observedAt: string;
  /** Merchant-published business identity claim (untrusted until verified). */
  identityClaim?: import("../merchant-identity/types.js").MerchantIdentityClaim | null;
}

export interface ShippingDestination {
  country: string;
  region?: string | undefined;
  postalCode?: string | undefined;
}

/** A merchant-attested price quote. Unknown components stay `null`. */
export interface MerchantQuote {
  quoteId: string;
  offerId: string;
  quantity: number;
  currency: Currency;
  itemPriceMinor: number;
  shippingMinor: number | null;
  taxMinor: number | null;
  feesMinor: number | null;
  discountMinor: number;
  quotedAt: string;
  expiresAt: string;
  source: string;
  /** Provider evidence (status, provenance, delivery options, checkout handoff). Absent for fixture quotes. */
  evidence?: import("../quote/types.js").QuoteEvidence | null;
}

export type IntentMode = "PRODUCT_DISCOVERY" | "EXACT_PRODUCT_PURCHASE";
