# Merchant Quote V0 — Shopify Storefront Cart API

**Status:** the provider is implemented and contract-tested against **synthetic fixtures**. No real Shopify store has been called, because none is configured for this project. `npm run smoke:shopify` performs the real dev-store check once credentials exist.

## What it does

`ShopifyCartQuoteProvider` (Storefront API **2026-10**, schema checked on shopify.dev on 2026-11-09) works in three steps:

1. **`cartCreate`** makes a fresh cart per quote: `lines [{ merchandiseId: <ProductVariant GID>, quantity }]`, `buyerIdentity.countryCode`, and `@inContext(country:)`.
2. **`cartDeliveryAddressesAdd`** adds `{ selected: true, oneTimeUse: true, address: { deliveryAddress: { countryCode, provinceCode?, zip?, city?, address1? } } }`. Only the destination the caller supplied is sent; no names, emails or phone numbers.
3. **`cartSelectedDeliveryOptionsUpdate`** selects the cheapest option per delivery group, or an explicit handle. Every mutation returns `cart { … }`, `userErrors` and `warnings`.

It reads:
- **Line merchandise:** variant id, title, sku, `availableForSale`.
- **Cost:** `cost { subtotalAmount, subtotalAmountEstimated, totalAmount, totalAmountEstimated }`.
- **Delivery:** `deliveryGroups { deliveryOptions { handle title deliveryMethodType estimatedCost } selectedDeliveryOption }`.
- **Checkout:** `checkoutUrl`.

The deprecated `totalTaxAmount` and `totalDutyAmount` fields are deliberately not used.

The result is a `QuoteEvidence`, attached to the existing `MerchantQuote` as `evidence`, with:
- provenance (`FIXTURE` / `MOCK` / `MERCHANT_API`) and the API version;
- observation and expiry timestamps;
- the requested vs returned variant, plus delivery options and the selected option;
- the merchant total and whether it is estimated;
- a validated external checkout URL, and an opaque cart reference (the raw cart id and key are never exposed);
- issues.

## Quote states (never promoted)

| State | Meaning | Produced by |
|---|---|---|
| `LISTING_PRICE` | Catalog unit price, not a checkout total | listings |
| `CART_ESTIMATE` | The merchant priced a cart; not a commitment | Shopify provider (always, at best) |
| `FINAL_QUOTE_VERIFIED` | Merchant-attested, fully itemized, non-estimated total with expiry | **no provider today** |
| `UNAVAILABLE` | The merchant reports the variant not for sale | Shopify provider |
| `UNKNOWN` | Variant, quantity or currency mismatch, user error, missing cost | Shopify provider |

How a Shopify quote reaches the existing verifier:
- **Item and shipping** are the subtotal and the selected option.
- **Tax and fees are `null`.** The non-deprecated CartCost does not itemize them, so the total is unknown, never zero.
- The verifier adds `QUOTE_IS_ESTIMATE`, `TOTAL_UNKNOWN`, `MERCHANT_REPORTS_UNAVAILABLE` or `QUOTE_UNVERIFIABLE` as appropriate.
- A cart estimate therefore **never** becomes the "lowest verified eligible" offer, and `prepare_checkout` refuses it.
- The merchant's `checkoutUrl` is shown as an **external handoff only**. DIAPORIA does not route this merchant's payment through its PayPal Sandbox account, and creates no order.

Errors are handled as follows:
- GraphQL `THROTTLED` / `ACCESS_DENIED`, HTTP 401/403/429/430/5xx, and timeouts raise `QuoteProviderError`. The offer then shows `NO_MERCHANT_QUOTE`, never a guessed price.
- A `checkoutUrl` that is not HTTPS on the shop's domain (or an allowed custom domain) is dropped, and `CHECKOUT_URL_INVALID` is raised.
- `diffQuoteObservations` reports subtotal, shipping, total, currency or status changes between two observations.

## Setup for a real smoke test

See `scripts/shopify-smoke.ts`:
1. Use a Shopify Partner development store with one priced, stocked physical product and a shipping rate.
2. Set `SHOPIFY_STORE_DOMAIN` and `SHOPIFY_VARIANT_ID`, and optionally `SHOPIFY_STOREFRONT_TOKEN`. Shopify allows tokenless cart access, with complexity limits.
3. The script creates one throwaway cart and prints the evidence, with the checkout URL redacted. It never checks out.

## Gap between a merchant quote and a confirmed order

Even a perfect cart estimate is not an order:
- inventory is not reserved;
- prices, tax and shipping can change until the merchant's checkout completes;
- the buyer pays the merchant directly in the merchant's checkout;
- DIAPORIA receives no order confirmation, because there is no order webhook or Admin API access.

Closing the gap would need merchant-side order confirmation, for example a merchant app or webhook, or PayPal Store Sync / Agent Ready style access. None of that exists here.
