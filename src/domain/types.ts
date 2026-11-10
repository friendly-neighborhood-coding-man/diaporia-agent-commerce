import type { Currency } from "./money.js";

/** "unknown": the listing does not state a condition (Channel3 returns null). Never equal to a requested condition. */
export type Condition = "new" | "refurbished" | "used" | "open_box" | "unknown";

/** Exact product identity. `null` means the field was not specified / not available. */
export interface ProductIdentity {
  brand: string;
  model: string;
  variant: string | null;
  condition: Condition;
  sku: string | null;
}

/**
 * Evidence source classes. MANUFACTURER and INDEPENDENT_REVIEW are the only strong classes. The research-V2 router
 * also records weak classes so they stay visible, but they never establish a capability:
 * RETAILER_ASSERTION (a seller's page), USER_FORUM (forums, Q&A), SEARCH_SNIPPET (an unclassified site's snippet).
 */
export type EvidenceKind = "MANUFACTURER" | "INDEPENDENT_REVIEW" | "CATALOG_LISTING" | "RETAILER_ASSERTION" | "USER_FORUM" | "SEARCH_SNIPPET";

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
  /** Research V2 (optional): how the identity was established and where the listing came from. */
  research?: CatalogResearchInfo;
}
export interface CatalogResearchInfo {
  kind: "STANDALONE" | "BUNDLE" | "ACCESSORY";
  modelBasis: "MODEL_NUMBER" | "NAMED_MODEL" | "NONE";
  attributes: Partial<Record<"color" | "memory" | "storage" | "capacity" | "size" | "pack", string>>;
  /** Attribute axes whose value conflicts between the provider's structured variant data and the title. */
  conflictingAxes: string[];
  categoryTitle: string | null;
  titleCondition: "refurbished" | "used" | "open_box" | null;
  provenance: { provider: string; providerProductId: string; observedAt: string; query: string | null; page: number | null; mode: string | null };
  /** Other provider listings merged into this product because their identity is identical. */
  alsoListedAs: string[];
  /** Provider variant options that point to OTHER products (never substituted). */
  siblingVariants: Array<{ axis: string; label: string; providerProductId: string | null }>;
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
  /** Where availability came from. Channel3 reports offers with no availability data as InStock (documented). */
  availabilitySource?: "PROVIDER_LISTING" | "MERCHANT";
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
