import type { CheckoutCapability, MerchantOffer, MerchantQuote, ProductIdentity } from "../domain/types.js";
import { sumKnown, type Currency } from "../domain/money.js";
import { compareIdentity, type IdentityMismatch } from "../identity/ProductIdentityResolver.js";
import { inspectUntrusted, isManipulative, type InspectedText } from "../security/untrusted.js";
import type { MerchantIdentityAssessment } from "../merchant-identity/types.js";

export type OfferIssue =
  | `IDENTITY_MISMATCH_${IdentityMismatch}`
  | "OUT_OF_STOCK" | "AVAILABILITY_UNKNOWN"
  | "NO_MERCHANT_QUOTE" | "QUOTE_STALE" | "QUOTE_OFFER_MISMATCH"
  | "TOTAL_UNKNOWN" | "CURRENCY_MISMATCH" | "OVER_BUDGET"
  | "SUSPICIOUS_LISTING_CONTENT" | "NO_CHECKOUT_PATH" | "MERCHANT_IDENTITY_MISMATCH" | "MERCHANT_IDENTITY_UNKNOWN";

export interface CostBreakdown {
  currency: Currency;
  itemMinor: number;
  shippingMinor: number | null;
  taxMinor: number | null;
  feesMinor: number | null;
  discountMinor: number;
  /** null whenever any component is unknown. Unknown is never treated as zero. */
  totalMinor: number | null;
  unknownComponents: Array<"shipping" | "tax" | "fees">;
}

export interface VerifiedOffer {
  offerId: string;
  merchantId: string;
  merchantName: string;
  merchantDomain: string;
  listingUrl: string | null;
  listedIdentity: ProductIdentity;
  identityMatch: boolean;
  quoteId: string | null;
  cost: CostBreakdown | null;
  listingPriceMinor: number;
  freshness: { observedAt: string; quotedAt: string | null; quoteExpiresAt: string | null; quoteAgeSeconds: number | null };
  checkoutPath: "PAYPAL_SANDBOX_DEMO_MERCHANT" | "EXTERNAL_MERCHANT_CHECKOUT" | "NONE";
  eligible: boolean;
  issues: OfferIssue[];
  listingContent: InspectedText | null;
  /** Present when merchant identity verification ran. Public subset only (masked identifier). */
  merchantIdentity?: PublicMerchantIdentity;
}

export type PublicMerchantIdentity = Pick<MerchantIdentityAssessment, "overall" | "legalEntity" | "paymentRelationship" | "identifierMasked" | "verifiedLegalName" | "checks" | "disclosure">;
export function publicIdentity(a: MerchantIdentityAssessment): PublicMerchantIdentity {
  return { overall: a.overall, legalEntity: a.legalEntity, paymentRelationship: a.paymentRelationship, identifierMasked: a.identifierMasked,
    verifiedLegalName: a.verifiedLegalName, checks: a.checks, disclosure: a.disclosure };
}

export interface OfferComparison {
  eligible: VerifiedOffer[];
  ineligible: VerifiedOffer[];
  lowestVerifiedEligible: VerifiedOffer | null;
  lowestPayPalCheckoutable: VerifiedOffer | null;
  disclosure: string;
}

const PATH: Record<CheckoutCapability, VerifiedOffer["checkoutPath"]> = {
  DIAPORIA_SANDBOX_DEMO_MERCHANT: "PAYPAL_SANDBOX_DEMO_MERCHANT",
  EXTERNAL_CHECKOUT_ONLY: "EXTERNAL_MERCHANT_CHECKOUT",
  NONE: "NONE",
};

export interface VerifyOptions {
  now: number;
  currency: Currency;
  budgetMinor: number | null;
  /** Quotes older than this are stale even before their stated expiry. */
  maxQuoteAgeSeconds?: number;
}

/**
 * Verifies merchant offers against a LOCKED identity. Eligible requires: exact identity,
 * in stock, a fresh merchant quote whose total is fully known, matching currency, within
 * budget, no manipulative merchant content, and some checkout path.
 */
export class MerchantOfferVerifier {
  verifyOne(locked: ProductIdentity, offer: MerchantOffer, quote: MerchantQuote | null, opts: VerifyOptions, identity?: MerchantIdentityAssessment): VerifiedOffer {
    const issues: OfferIssue[] = [];
    if (identity?.overall === "MISMATCH") issues.push("MERCHANT_IDENTITY_MISMATCH");
    if (identity?.overall === "UNKNOWN") issues.push("MERCHANT_IDENTITY_UNKNOWN");
    const mismatches = compareIdentity(locked, offer.listedIdentity);
    for (const m of mismatches) issues.push(`IDENTITY_MISMATCH_${m}`);
    if (offer.availability === "OUT_OF_STOCK") issues.push("OUT_OF_STOCK");
    if (offer.availability === "UNKNOWN") issues.push("AVAILABILITY_UNKNOWN");
    if (offer.currency !== opts.currency) issues.push("CURRENCY_MISMATCH");
    const listingContent = offer.listingText ? inspectUntrusted(offer.listingText) : null;
    if (listingContent && isManipulative(listingContent)) issues.push("SUSPICIOUS_LISTING_CONTENT");
    const checkoutPath = PATH[offer.checkoutCapability];
    if (checkoutPath === "NONE") issues.push("NO_CHECKOUT_PATH");

    let cost: CostBreakdown | null = null;
    let quoteAgeSeconds: number | null = null;
    if (!quote) issues.push("NO_MERCHANT_QUOTE");
    else {
      if (quote.offerId !== offer.offerId) issues.push("QUOTE_OFFER_MISMATCH");
      if (quote.currency !== opts.currency) issues.push("CURRENCY_MISMATCH");
      const quotedAt = Date.parse(quote.quotedAt);
      const expiresAt = Date.parse(quote.expiresAt);
      quoteAgeSeconds = Number.isFinite(quotedAt) ? Math.max(0, Math.floor((opts.now - quotedAt) / 1000)) : null;
      if (!Number.isFinite(expiresAt) || expiresAt <= opts.now || quoteAgeSeconds === null || quoteAgeSeconds > (opts.maxQuoteAgeSeconds ?? 1800))
        issues.push("QUOTE_STALE");
      const unknownComponents: CostBreakdown["unknownComponents"] = [];
      if (quote.shippingMinor === null) unknownComponents.push("shipping");
      if (quote.taxMinor === null) unknownComponents.push("tax");
      if (quote.feesMinor === null) unknownComponents.push("fees");
      const gross = sumKnown([quote.itemPriceMinor, quote.shippingMinor, quote.taxMinor, quote.feesMinor]);
      const totalMinor = gross === null ? null : Math.max(0, gross - quote.discountMinor);
      cost = { currency: quote.currency, itemMinor: quote.itemPriceMinor, shippingMinor: quote.shippingMinor, taxMinor: quote.taxMinor,
        feesMinor: quote.feesMinor, discountMinor: quote.discountMinor, totalMinor, unknownComponents };
      if (totalMinor === null) issues.push("TOTAL_UNKNOWN");
      else if (opts.budgetMinor !== null && totalMinor > opts.budgetMinor) issues.push("OVER_BUDGET");
    }
    return {
      offerId: offer.offerId, merchantId: offer.merchantId, merchantName: offer.merchantName, merchantDomain: offer.merchantDomain,
      listingUrl: offer.listingUrl, listedIdentity: offer.listedIdentity, identityMatch: mismatches.length === 0,
      quoteId: quote?.quoteId ?? null, cost, listingPriceMinor: offer.itemPriceMinor,
      freshness: { observedAt: offer.observedAt, quotedAt: quote?.quotedAt ?? null, quoteExpiresAt: quote?.expiresAt ?? null, quoteAgeSeconds },
      checkoutPath, eligible: issues.length === 0, issues, listingContent,
      ...(identity ? { merchantIdentity: publicIdentity(identity) } : {}),
    };
  }

  compare(locked: ProductIdentity, items: Array<{ offer: MerchantOffer; quote: MerchantQuote | null; identity?: MerchantIdentityAssessment }>, opts: VerifyOptions): OfferComparison {
    const verified = items.map(({ offer, quote, identity }) => this.verifyOne(locked, offer, quote, opts, identity));
    const byTotal = (a: VerifiedOffer, b: VerifiedOffer) => a.cost!.totalMinor! - b.cost!.totalMinor! || a.offerId.localeCompare(b.offerId);
    const eligible = verified.filter((v) => v.eligible).sort(byTotal);
    const ineligible = verified.filter((v) => !v.eligible);
    return {
      eligible, ineligible,
      lowestVerifiedEligible: eligible[0] ?? null,
      lowestPayPalCheckoutable: eligible.find((v) => v.checkoutPath === "PAYPAL_SANDBOX_DEMO_MERCHANT") ?? null,
      disclosure: "Totals use merchant-quoted item, shipping, tax and fees. Any unknown component makes the total unknown and the offer ineligible. Listing prices alone are never ranked as totals.",
    };
  }
}
