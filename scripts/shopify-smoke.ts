/**
 * REAL Shopify Development Store smoke test (Storefront Cart API, read/write cart only).
 * Creates ONE throwaway cart, adds a delivery address, selects a rate, prints the observed quote.
 * It never completes checkout and creates no order.
 *
 *   SHOPIFY_STORE_DOMAIN=your-dev-store.myshopify.com \
 *   SHOPIFY_VARIANT_ID=gid://shopify/ProductVariant/1234567890 \
 *   [SHOPIFY_STOREFRONT_TOKEN=...] [SHOPIFY_TOKEN_TYPE=public|private] \
 *   [SHOPIFY_COUNTRY=US SHOPIFY_PROVINCE=CA SHOPIFY_ZIP=94103] \
 *   npx tsx scripts/shopify-smoke.ts
 */
import { ShopifyCartQuoteProvider, SHOPIFY_STOREFRONT_API_VERSION } from "../src/quote/ShopifyCartQuoteProvider.js";
import { isCurrency } from "../src/domain/money.js";

const e = process.env;
if (!e.SHOPIFY_STORE_DOMAIN || !e.SHOPIFY_VARIANT_ID) {
  console.log(`Not configured: no live evidence produced.
Setup (Shopify Development Store, free via a Shopify Partner account):
  1. Create a development store and add one physical product with a price and stock.
  2. Configure at least one shipping rate for your test destination country.
  3. Optional: create a Storefront API access token (Headless channel or custom app). Cart read/write also works tokenless (complexity-limited).
  4. Find the variant GID (Admin > product > variant URL id) and run with SHOPIFY_STORE_DOMAIN and SHOPIFY_VARIANT_ID set.
API version used: ${SHOPIFY_STOREFRONT_API_VERSION}`);
  process.exit(2);
}
const currency = (e.SHOPIFY_CURRENCY ?? "USD").toUpperCase();
if (!isCurrency(currency)) { console.error("Unsupported currency"); process.exit(2); }
const p = new ShopifyCartQuoteProvider({ shopDomain: e.SHOPIFY_STORE_DOMAIN, token: e.SHOPIFY_STOREFRONT_TOKEN ?? null,
  tokenType: e.SHOPIFY_TOKEN_TYPE === "private" ? "private" : "public", provenance: "MERCHANT_API",
  allowedCheckoutHosts: (e.SHOPIFY_CHECKOUT_HOSTS ?? "").split(",").filter(Boolean) });
const country = (e.SHOPIFY_COUNTRY ?? "US").toUpperCase();
const ev = await p.quote({ variantId: e.SHOPIFY_VARIANT_ID, quantity: 1, currency, countryCode: country,
  destination: { countryCode: country, provinceCode: e.SHOPIFY_PROVINCE, zip: e.SHOPIFY_ZIP, city: e.SHOPIFY_CITY } });
console.log(JSON.stringify({ ...ev, externalCheckoutUrl: ev.externalCheckoutUrl ? `${new URL(ev.externalCheckoutUrl).origin}/… (redacted)` : null }, null, 2));
