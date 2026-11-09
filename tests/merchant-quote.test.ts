/** Merchant Quote V0: Shopify Storefront Cart provider against SYNTHETIC fixtures (no real store). */
import { afterEach, describe, expect, it } from "vitest";
import { ShopifyCartQuoteProvider, diffQuoteObservations, SHOPIFY_STOREFRONT_API_VERSION } from "../src/quote/ShopifyCartQuoteProvider.js";
import { shopifyFixtureFetch, FIXTURE_SHOP, FIXTURE_VARIANT, type FixtureState, type ShopifyScenario } from "../src/quote/shopifyFixtures.js";
import { ShopifyQuoteResearchAdapter, type ShopifyListing } from "../src/quote/ShopifyQuoteResearchAdapter.js";
import { MockCommerceResearchAdapter } from "../src/research/CommerceResearchAdapter.js";
import { MerchantOfferVerifier } from "../src/merchant/MerchantOfferVerifier.js";
import { QuoteProviderError } from "../src/quote/types.js";
import { call, callError, CA, mcpClient, SONY_BLACK, startHarness, TOKENS, type Harness } from "./helpers.js";

const newState = (): FixtureState => ({ carts: 0, calls: [], priceMinor: 5499 });
function provider(scenario: ShopifyScenario, state = newState(), over: Partial<ConstructorParameters<typeof ShopifyCartQuoteProvider>[0]> = {}) {
  return { state, p: new ShopifyCartQuoteProvider({ shopDomain: FIXTURE_SHOP, fetchImpl: shopifyFixtureFetch(scenario, state), provenance: "FIXTURE", ...over }) };
}
const req = (over: Record<string, unknown> = {}) => ({ variantId: FIXTURE_VARIANT, quantity: 1, currency: "USD" as const, countryCode: "US",
  destination: { countryCode: "US", provinceCode: "CA", zip: "94103" }, ...over });

describe("ShopifyCartQuoteProvider (fixtures)", () => {
  it("builds documented 2026-10 requests: fresh cart, delivery address, cheapest option selected", async () => {
    let seen: { url: string; headers: Record<string, string> }[] = [];
    const state = newState(); const base = shopifyFixtureFetch("OK_TWO_RATES", state);
    const p = new ShopifyCartQuoteProvider({ shopDomain: FIXTURE_SHOP, token: "public-token-fixture", provenance: "FIXTURE",
      fetchImpl: (async (u: string | URL, init?: RequestInit) => { seen.push({ url: String(u), headers: init!.headers as Record<string, string> }); return base(u, init); }) as typeof fetch });
    const ev = await p.quote(req());
    expect(SHOPIFY_STOREFRONT_API_VERSION).toBe("2026-10");
    expect(seen[0]!.url).toBe(`https://${FIXTURE_SHOP}/api/2026-10/graphql.json`);
    expect(seen[0]!.headers["X-Shopify-Storefront-Access-Token"]).toBe("public-token-fixture");
    expect(state.calls.map((c) => c.op)).toEqual(["cartCreate", "cartDeliveryAddressesAdd", "cartSelectedDeliveryOptionsUpdate"]);
    expect(state.calls[0]!.variables).toMatchObject({ country: "US", input: { lines: [{ merchandiseId: FIXTURE_VARIANT, quantity: 1 }], buyerIdentity: { countryCode: "US" } } });
    expect(state.calls[1]!.variables.addresses).toEqual([{ selected: true, oneTimeUse: true, address: { deliveryAddress: { countryCode: "US", provinceCode: "CA", zip: "94103" } } }]);
    expect(state.calls[2]!.variables.selected).toEqual([{ deliveryGroupId: "gid://shopify/CartDeliveryGroup/1", deliveryOptionHandle: "rate-standard" }]);
    expect(ev).toMatchObject({ status: "CART_ESTIMATE", provenance: "FIXTURE", currency: "USD", subtotalMinor: 5499, merchantTotalMinor: 6098, totalEstimated: false,
      selectedDeliveryOption: { handle: "rate-standard", costMinor: 599 }, variant: { requestedId: FIXTURE_VARIANT, returnedId: FIXTURE_VARIANT, availableForSale: true } });
    expect(ev.deliveryOptions.map((o) => o.costMinor)).toEqual([599, 1499]);
    expect(ev.externalCheckoutUrl).toMatch(new RegExp(`^https://${FIXTURE_SHOP}/cart/c/`));
  });

  it("exact variant match vs mismatch", async () => {
    expect((await provider("OK_TWO_RATES").p.quote(req())).issues).not.toContain("VARIANT_MISMATCH");
    const ev = await provider("VARIANT_MISMATCH").p.quote(req());
    expect(ev.status).toBe("UNKNOWN");
    expect(ev.issues).toContain("VARIANT_MISMATCH");
  });

  it("variant unavailable", async () => {
    const ev = await provider("UNAVAILABLE").p.quote(req());
    expect(ev.status).toBe("UNAVAILABLE");
    expect(ev.issues).toContain("VARIANT_UNAVAILABLE");
  });

  it("shipping destination missing: no shipping cost, total stays estimated", async () => {
    const { p, state } = provider("OK_TWO_RATES");
    const ev = await p.quote(req({ destination: null }));
    expect(state.calls.map((c) => c.op)).toEqual(["cartCreate"]);
    expect(ev).toMatchObject({ status: "CART_ESTIMATE", selectedDeliveryOption: null, totalEstimated: true });
    expect(ev.issues).toEqual(expect.arrayContaining(["DESTINATION_MISSING", "TOTAL_ESTIMATED"]));
  });

  it("multiple shipping rates: cheapest by default, explicit handle honored, no rates flagged", async () => {
    const ev = await provider("OK_TWO_RATES").p.quote(req({ deliveryOptionHandle: "rate-express" }));
    expect(ev.selectedDeliveryOption).toMatchObject({ handle: "rate-express", costMinor: 1499 });
    expect(ev.merchantTotalMinor).toBe(5499 + 1499);
    const none = await provider("NO_RATES").p.quote(req());
    expect(none.issues).toContain("NO_DELIVERY_OPTIONS");
    expect(none.selectedDeliveryOption).toBeNull();
  });

  it("tax or total not yet determined: never zero, never final", async () => {
    const ev = await provider("ESTIMATED_TOTAL").p.quote(req());
    expect(ev.totalEstimated).toBe(true);
    expect(ev.issues).toEqual(expect.arrayContaining(["TOTAL_ESTIMATED", "TAX_NOT_ITEMIZED"]));
    expect(ev.status).toBe("CART_ESTIMATE");
  });

  it("estimated vs verified total: a non-estimated cart is still only CART_ESTIMATE and never eligible as a verified total", async () => {
    const research = new ShopifyQuoteResearchAdapter(new MockCommerceResearchAdapter(), provider("OK_TWO_RATES").p, LISTINGS, { defaultCountry: "US", providerIsFixture: true });
    const offers = (await research.findOffers(SONY_BLACK)).filter((o) => o.offerId === "off_shopify_demo");
    const quote = await research.getQuote("off_shopify_demo", 1, CA);
    expect(quote!.evidence!.totalEstimated).toBe(false);
    expect(quote!.evidence!.status).not.toBe("FINAL_QUOTE_VERIFIED");
    expect(quote).toMatchObject({ itemPriceMinor: 5499, shippingMinor: 599, taxMinor: null, feesMinor: null });
    const v = new MerchantOfferVerifier().verifyOne(SONY_BLACK, offers[0]!, quote, { now: Date.now(), currency: "USD", budgetMinor: 10000 });
    expect(v.eligible).toBe(false);
    expect(v.issues).toEqual(expect.arrayContaining(["QUOTE_IS_ESTIMATE", "TOTAL_UNKNOWN"]));
    expect(v.issues).not.toContain("AVAILABILITY_UNKNOWN"); // the cart established availability
    expect(v.cost?.totalMinor).toBeNull();
  });

  it("currency mismatch", async () => {
    const ev = await provider("CURRENCY_MISMATCH").p.quote(req());
    expect(ev.status).toBe("UNKNOWN");
    expect(ev.issues).toContain("CURRENCY_MISMATCH");
  });

  it("stale quote: expired evidence is flagged by the verifier", async () => {
    let t = Date.now();
    const research = new ShopifyQuoteResearchAdapter(new MockCommerceResearchAdapter(),
      provider("OK_TWO_RATES", newState(), { now: () => t, quoteTtlSeconds: 60 }).p, LISTINGS, { defaultCountry: "US", providerIsFixture: true });
    const offer = (await research.findOffers(SONY_BLACK)).find((o) => o.offerId === "off_shopify_demo")!;
    const quote = await research.getQuote("off_shopify_demo", 1, CA);
    t += 5 * 60_000;
    expect(new MerchantOfferVerifier().verifyOne(SONY_BLACK, offer, quote, { now: t, currency: "USD", budgetMinor: null }).issues).toContain("QUOTE_STALE");
  });

  it("cart total changes between observations are detected", async () => {
    const state = newState();
    const { p } = provider("OK_TWO_RATES", state);
    const a = await p.quote(req());
    state.priceMinor = 5999;
    const b = await p.quote(req());
    expect(diffQuoteObservations(a, b)).toEqual(expect.arrayContaining(["SUBTOTAL", "TOTAL"]));
    expect(diffQuoteObservations(a, a)).toEqual([]);
  });

  it("GraphQL errors, user errors, HTTP errors and timeouts never produce a price", async () => {
    await expect(provider("THROTTLED").p.quote(req())).rejects.toMatchObject({ code: "THROTTLED" });
    await expect(provider("TIMEOUT").p.quote(req())).rejects.toMatchObject({ code: "TIMEOUT" });
    await expect(provider("HTTP_500").p.quote(req())).rejects.toBeInstanceOf(QuoteProviderError);
    const ue = await provider("USER_ERROR").p.quote(req());
    expect(ue).toMatchObject({ status: "UNKNOWN", subtotalMinor: null, merchantTotalMinor: null });
    expect(ue.issues).toContain("MERCHANT_USER_ERROR");
    const research = new ShopifyQuoteResearchAdapter(new MockCommerceResearchAdapter(), provider("THROTTLED").p, LISTINGS, { defaultCountry: "US", providerIsFixture: true });
    expect(await research.getQuote("off_shopify_demo", 1, CA)).toBeNull();
    expect(research.lastErrors.get("off_shopify_demo")).toMatch(/THROTTLED/);
  });

  it("invalid or unrelated checkout URL is dropped and flagged", async () => {
    const ev = await provider("BAD_CHECKOUT_URL").p.quote(req());
    expect(ev.externalCheckoutUrl).toBeNull();
    expect(ev.issues).toContain("CHECKOUT_URL_INVALID");
    expect(() => new ShopifyCartQuoteProvider({ shopDomain: "evil.example.com" })).toThrow(QuoteProviderError);
  });

  it("no cart secrets in evidence; a fresh cart per quote", async () => {
    const state = newState();
    const { p } = provider("OK_TWO_RATES", state);
    const a = await p.quote(req()); const b = await p.quote(req());
    expect(state.calls.filter((c) => c.op === "cartCreate")).toHaveLength(2);
    expect(a.cartRef).not.toBe(b.cartRef);
    const json = JSON.stringify({ ...a, externalCheckoutUrl: null });
    expect(json).not.toMatch(/gid:\/\/shopify\/Cart|secretkey/);
  });
});

const LISTINGS: ShopifyListing[] = [{ offerId: "off_shopify_demo", productId: "prd_sony_whch720n_black", identity: SONY_BLACK, variantId: FIXTURE_VARIANT,
  merchantName: "DIAPORIA demo dev store (Shopify, fixture)", shopDomain: FIXTURE_SHOP, listingPriceMinor: 5499, currency: "USD" }];

describe("Shopify quotes through MCP (fixtures)", () => {
  const hs: Harness[] = [];
  afterEach(async () => { for (const h of hs.splice(0)) await h.close(); });

  it("discovery → merchant cart estimate → external checkout handoff; no PayPal order; per-user isolation", async () => {
    const research = new ShopifyQuoteResearchAdapter(new MockCommerceResearchAdapter(), provider("OK_TWO_RATES").p, LISTINGS, { defaultCountry: "US", providerIsFixture: true });
    const h = await startHarness({ research }); hs.push(h);
    const alice = await mcpClient(h.url, TOKENS.alice);
    const r = await call(alice, "research_purchase", { request: "Buy Sony WH-CH720N Black", currency: "USD" });
    const c = await call(alice, "compare_purchase_offers", { researchSessionId: r.purchaseSessionId, productIdentity: SONY_BLACK, destination: CA });
    const shop = c.ineligibleOffers.find((o: any) => o.offerId === "off_shopify_demo");
    expect(shop.checkoutPath).toBe("EXTERNAL_MERCHANT_CHECKOUT");
    expect(shop.issues).toEqual(expect.arrayContaining(["QUOTE_IS_ESTIMATE", "TOTAL_UNKNOWN"]));
    expect(shop.quote).toMatchObject({ status: "CART_ESTIMATE", provenance: "FIXTURE", merchantTotalMinor: 6098, selectedDeliveryOption: { costMinor: 599 } });
    expect(shop.quote.externalCheckoutUrl).toMatch(new RegExp(`^https://${FIXTURE_SHOP}/`));
    expect(c.lowestVerifiedEligibleOffer.offerId).toBe("off_alpha"); // the estimate never outranks a verified total
    const prep = await callError(alice, "prepare_checkout", { purchaseSessionId: r.purchaseSessionId, offerId: "off_shopify_demo", maximumApprovedTotalMinor: 10000, currency: "USD", quantity: 1 });
    expect(prep.code).toBe("OFFER_NOT_ELIGIBLE");
    expect(h.mock.calls.createOrder).toBe(0);
    const bob = await mcpClient(h.url, TOKENS.bob);
    expect((await callError(bob, "compare_purchase_offers", { researchSessionId: r.purchaseSessionId, productIdentity: SONY_BLACK, destination: CA })).code).toBe("NOT_FOUND");
    const rb = await call(bob, "research_purchase", { request: "Buy Sony WH-CH720N Black", currency: "USD" });
    const cb = await call(bob, "compare_purchase_offers", { researchSessionId: rb.purchaseSessionId, productIdentity: SONY_BLACK, destination: CA });
    const bobUrl = cb.ineligibleOffers.find((o: any) => o.offerId === "off_shopify_demo").quote.externalCheckoutUrl;
    expect(bobUrl).not.toBe(shop.quote.externalCheckoutUrl); // separate carts per user request
    await alice.close(); await bob.close();
  });
});
