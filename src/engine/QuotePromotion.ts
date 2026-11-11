/**
 * Research-to-quote promotion policy (V2.1 Phase 3). Research ranks by SEARCH-TIME LISTING PRICES; a listing price is
 * never a total. This module states, for one compare result, which number is which and whether research's price-based
 * ordering still holds. It is descriptive only: eligibility, budget and stock are enforced by MerchantOfferVerifier on
 * the merchant quote, and payment preparation is gated by PurchaseGate. Nothing here touches mandates or capture.
 *
 * POLICY
 *  P1. A "verified total" exists only for an offer the verifier made eligible: a fresh merchant quote for that offer, the
 *      locked identity, the session currency and every component (item, shipping, tax, fees) known.
 *  P2. Promotion copies nothing from research: every verified figure comes from the quote. The research listing is kept
 *      next to it, labelled, so the user can see the difference.
 *  P3. The objective LOWEST_VERIFIED_TOTAL names the user's goal. Research can only approximate it with listing prices;
 *      it is met only when compare returns a verified total. Other research candidates were not quoted, so a cheaper
 *      verified total elsewhere is not excluded: that is reported, never claimed away.
 *  P4. A quoted item price that differs from the research listing by more than 5% (or any currency change) is reported
 *      as PRICE_CHANGED_SINCE_RESEARCH; if it is now above the research listing of another eligible candidate, the
 *      research order may no longer hold (RESEARCH_ORDER_MAY_HAVE_CHANGED).
 */
import type { VerifiedOffer } from "../merchant/MerchantOfferVerifier.js";

export const PRICE_CHANGE_TOLERANCE = 0.05;

export interface PriceProvenance {
  status: "VERIFIED_TOTAL" | "NO_VERIFIED_TOTAL";
  currency: string;
  research: { listingMinor: number | null; merchantDomain: string | null; basis: "SEARCH_TIME_LISTING_PRICE" } | null;
  verified: { offerId: string; merchantDomain: string; itemMinor: number; totalMinor: number; quoteId: string | null; quotedAt: string | null; basis: "MERCHANT_QUOTE" } | null;
  notes: Array<"PRICE_CHANGED_SINCE_RESEARCH" | "RESEARCH_ORDER_MAY_HAVE_CHANGED" | "OTHER_CANDIDATES_NOT_QUOTED" | "LISTING_PRICE_IS_NOT_A_TOTAL">;
  explanation: string[];
}

interface RankingRow { productId: string; eligible: boolean; price: { lowestListingMinor: number | null; merchantDomain: string | null } }

export function priceProvenance(o: { productId: string | null; currency: string; objective: string | null; ranking: RankingRow[] | null; lowest: VerifiedOffer | null }): PriceProvenance {
  const row = o.ranking?.find((r) => r.productId === o.productId) ?? null;
  const research = row ? { listingMinor: row.price.lowestListingMinor, merchantDomain: row.price.merchantDomain, basis: "SEARCH_TIME_LISTING_PRICE" as const } : null;
  const v = o.lowest;
  const verified = v && v.eligible && v.cost && v.cost.totalMinor !== null && v.cost.currency === o.currency
    ? { offerId: v.offerId, merchantDomain: v.merchantDomain, itemMinor: v.cost.itemMinor, totalMinor: v.cost.totalMinor, quoteId: v.quoteId, quotedAt: v.freshness.quotedAt, basis: "MERCHANT_QUOTE" as const }
    : null;
  const notes: PriceProvenance["notes"] = ["LISTING_PRICE_IS_NOT_A_TOTAL"];
  const explanation = ["Research prices are search-time listing prices (item only). Only a merchant quote gives a total."];
  if (verified && research?.listingMinor) {
    const delta = verified.itemMinor - research.listingMinor;
    if (Math.abs(delta) > research.listingMinor * PRICE_CHANGE_TOLERANCE) {
      notes.push("PRICE_CHANGED_SINCE_RESEARCH");
      explanation.push(`The quoted item price differs from the research listing by ${delta > 0 ? "+" : ""}${delta} minor units.`);
    }
    const cheaperElsewhere = (o.ranking ?? []).some((r) => r.productId !== o.productId && r.eligible && r.price.lowestListingMinor !== null && r.price.lowestListingMinor < verified.itemMinor);
    if (delta > 0 && cheaperElsewhere) {
      notes.push("RESEARCH_ORDER_MAY_HAVE_CHANGED");
      explanation.push("Another eligible candidate had a lower research listing than this quoted item price; the research order may no longer hold.");
    }
  }
  if (o.objective === "LOWEST_VERIFIED_TOTAL" && (o.ranking ?? []).filter((r) => r.eligible).length > 1) {
    notes.push("OTHER_CANDIDATES_NOT_QUOTED");
    explanation.push("Only this product was quoted. Other eligible research candidates have listing prices only, so a lower verified total elsewhere is not excluded.");
  }
  if (!verified) explanation.push("No verified total: no offer has a fresh, complete merchant quote that meets every requirement.");
  return { status: verified ? "VERIFIED_TOTAL" : "NO_VERIFIED_TOTAL", currency: o.currency, research, verified, notes, explanation };
}
