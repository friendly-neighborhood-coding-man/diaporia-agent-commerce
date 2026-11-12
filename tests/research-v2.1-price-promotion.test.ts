/**
 * V2.1 Phase 3: a search-time listing price is never presented as a merchant-verified total (QuotePromotion policy).
 */
import { afterEach, describe, expect, it } from "vitest";
import { priceProvenance } from "../src/engine/QuotePromotion.js";
import type { VerifiedOffer } from "../src/merchant/MerchantOfferVerifier.js";
import { buildWorldApp, loadRoot } from "../scripts/research-eval-v2/run.js";

const L = await loadRoot(new URL("..", import.meta.url).pathname);

const offer = (item: number, total: number | null, extra: Partial<VerifiedOffer> = {}): VerifiedOffer => ({
  offerId: "o1", merchantId: "m", merchantName: "m", merchantDomain: "m.example", listingUrl: null,
  listedIdentity: { brand: "B", model: "M", variant: null, condition: "new", sku: null }, identityMatch: true, quoteId: "q1",
  cost: { currency: "USD", itemMinor: item, shippingMinor: 500, taxMinor: 0, feesMinor: 0, discountMinor: 0, totalMinor: total, unknownComponents: [] },
  listingPriceMinor: item, freshness: { observedAt: "2026-11-10T12:00:00Z", quotedAt: "2026-11-10T12:00:00Z", quoteExpiresAt: null, quoteAgeSeconds: 0 },
  checkoutPath: "EXTERNAL_MERCHANT_CHECKOUT", eligible: true, issues: [], listingContent: null, ...extra });
const row = (productId: string, listing: number | null, eligible = true) => ({ productId, eligible, price: { lowestListingMinor: listing, merchantDomain: "m.example" } });

describe("price provenance", () => {
  it("keeps the research listing and the quoted total apart, each labelled", () => {
    const p = priceProvenance({ productId: "a", currency: "USD", objective: "BEST_SUITABILITY", ranking: [row("a", 10_000)], lowest: offer(10_000, 10_500) });
    expect(p.status).toBe("VERIFIED_TOTAL");
    expect(p.research).toMatchObject({ listingMinor: 10_000, basis: "SEARCH_TIME_LISTING_PRICE" });
    expect(p.verified).toMatchObject({ itemMinor: 10_000, totalMinor: 10_500, basis: "MERCHANT_QUOTE" });
    expect(p.notes).toEqual(["LISTING_PRICE_IS_NOT_A_TOTAL"]);
  });
  it("no eligible complete quote → no verified total, even though a listing exists", () => {
    expect(priceProvenance({ productId: "a", currency: "USD", objective: null, ranking: [row("a", 10_000)], lowest: null }).verified).toBeNull();
    expect(priceProvenance({ productId: "a", currency: "USD", objective: null, ranking: [row("a", 10_000)], lowest: offer(10_000, null) }).status).toBe("NO_VERIFIED_TOTAL");
    expect(priceProvenance({ productId: "a", currency: "USD", objective: null, ranking: [row("a", 10_000)], lowest: offer(10_000, 10_500, { eligible: false }) }).status).toBe("NO_VERIFIED_TOTAL");
    expect(priceProvenance({ productId: "a", currency: "EUR", objective: null, ranking: [row("a", 10_000)], lowest: offer(10_000, 10_500) }).status).toBe("NO_VERIFIED_TOTAL");
  });
  it("a quote that moved since research is reported, and the research order may no longer hold", () => {
    const p = priceProvenance({ productId: "a", currency: "USD", objective: "LOWEST_VERIFIED_TOTAL", ranking: [row("a", 10_000), row("b", 10_400)], lowest: offer(11_000, 11_500) });
    expect(p.notes).toEqual(expect.arrayContaining(["PRICE_CHANGED_SINCE_RESEARCH", "RESEARCH_ORDER_MAY_HAVE_CHANGED", "OTHER_CANDIDATES_NOT_QUOTED"]));
  });
  it("within tolerance and no cheaper candidate: no change notes", () => {
    const p = priceProvenance({ productId: "a", currency: "USD", objective: "BEST_SUITABILITY", ranking: [row("a", 10_000), row("b", 20_000)], lowest: offer(10_300, 10_800) });
    expect(p.notes).toEqual(["LISTING_PRICE_IS_NOT_A_TOTAL"]);
  });
});

describe("end to end: compare reports provenance from the quote, never from research", () => {
  let w: ReturnType<typeof buildWorldApp> | null = null;
  afterEach(() => { w?.close(); w = null; });
  it("the verified figures equal the comparison's merchant cost; the listing is the research listing", async () => {
    w = buildWorldApp(L);
    const out: any = await w.app.gateway.researchPurchase("alice", { request: "Over-ear headphones under $60" });
    const c = out.candidates.find((x: any) => x.productId === "ch3:h_fab_lite");
    const cmp: any = await w.app.gateway.compareOffers("alice", { researchSessionId: out.purchaseSessionId, productIdentity: c.identity, destination: { country: "US", region: "CA" } });
    const pp = cmp.priceProvenance;
    const rankRow = out.decision.ranking.find((r: any) => r.productId === "ch3:h_fab_lite");
    expect(pp.research.listingMinor).toBe(rankRow.price.lowestListingMinor);
    expect(pp.verified.totalMinor).toBe(cmp.lowestVerifiedEligibleOffer.cost.totalMinor);
    expect(pp.verified.basis).toBe("MERCHANT_QUOTE");
    expect(pp.notes).toContain("LISTING_PRICE_IS_NOT_A_TOTAL");
  });
});
