/**
 * Demo: product discovery → merchant cart quote → external checkout handoff, over real MCP HTTP.
 * Uses SYNTHETIC Shopify fixtures unless SHOPIFY_STORE_DOMAIN + SHOPIFY_VARIANT_ID are set
 * (then one real dev-store cart is created). No order, no payment, no PayPal call.
 *   npm run demo:quote
 */
import type { AddressInfo } from "node:net";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/http/server.js";
import { ALL_CLIENT_SCOPES, DevAuth, randomSecret } from "../src/auth/devAuth.js";
import { MockCommerceResearchAdapter } from "../src/research/CommerceResearchAdapter.js";
import { ShopifyCartQuoteProvider } from "../src/quote/ShopifyCartQuoteProvider.js";
import { ShopifyQuoteResearchAdapter } from "../src/quote/ShopifyQuoteResearchAdapter.js";
import { shopifyFixtureFetch, FIXTURE_SHOP, FIXTURE_VARIANT } from "../src/quote/shopifyFixtures.js";
import { formatMinor } from "../src/domain/money.js";

const live = !!(process.env.SHOPIFY_STORE_DOMAIN && process.env.SHOPIFY_VARIANT_ID);
const shop = live ? process.env.SHOPIFY_STORE_DOMAIN! : FIXTURE_SHOP;
const provider = new ShopifyCartQuoteProvider(live
  ? { shopDomain: shop, token: process.env.SHOPIFY_STOREFRONT_TOKEN ?? null, provenance: "MERCHANT_API" }
  : { shopDomain: shop, fetchImpl: shopifyFixtureFetch("OK_TWO_RATES"), provenance: "FIXTURE" });
const sony = { brand: "Sony", model: "WH-CH720N", variant: "Black", condition: "new" as const, sku: "WHCH720N/B" };
const research = new ShopifyQuoteResearchAdapter(new MockCommerceResearchAdapter(), provider, [{
  offerId: "off_shopify_demo", productId: "prd_sony_whch720n_black", identity: sony, variantId: live ? process.env.SHOPIFY_VARIANT_ID! : FIXTURE_VARIANT,
  merchantName: live ? `Shopify dev store ${shop}` : "DIAPORIA demo dev store (Shopify, SYNTHETIC fixture)", shopDomain: shop, listingPriceMinor: 5499, currency: "USD",
}], { defaultCountry: "US", providerIsFixture: !live });

const probe = createServer(); await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
const port = (probe.address() as AddressInfo).port; await new Promise<void>((r) => probe.close(() => r()));
const token = randomSecret("dct"); const auth = new DevAuth(); auth.addClientToken(token, "demo-user", ALL_CLIENT_SCOPES);
const app = createApp({ host: "127.0.0.1", port, baseUrl: `http://127.0.0.1:${port}`, authMode: "dev", dbPath: ":memory:", auth, research });
await new Promise<void>((r) => app.server.listen(port, "127.0.0.1", r));
const client = new Client({ name: "quote-demo", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
await client.listTools();
const call = async (name: string, args: Record<string, unknown>): Promise<any> => (await client.callTool({ name, arguments: args })).structuredContent;
const usd = (m: number | null | undefined) => (m == null ? "unknown" : `$${formatMinor(m, "USD")}`);

console.log(`Merchant Quote V0 demo — Shopify provider: ${live ? "LIVE dev store " + shop : "SYNTHETIC FIXTURE (no Shopify call)"}; payments: none\n`);
const r = await call("research_purchase", { request: "Buy Sony WH-CH720N Black", currency: "USD" });
console.log(`1. research_purchase → ${r.mode}, identity ${r.identity.status}`);
const c = await call("compare_purchase_offers", { researchSessionId: r.purchaseSessionId, productIdentity: sony, destination: { country: "US", region: "CA", postalCode: "94103" } });
const s = c.ineligibleOffers.find((o: any) => o.offerId === "off_shopify_demo") ?? c.eligibleOffers.find((o: any) => o.offerId === "off_shopify_demo");
console.log(`2. compare_purchase_offers → Shopify offer quote status ${s.quote?.status ?? "NO QUOTE"} [${s.quote?.provenance ?? "-"}]`);
if (s.quote) {
  console.log(`   listing price ${usd(s.listingPriceMinor)} (LISTING_PRICE) · cart subtotal ${usd(s.cost?.itemMinor)} · delivery options ${s.quote.deliveryOptions.map((o: any) => `${o.title} ${usd(o.costMinor)}`).join(", ")}`);
  console.log(`   selected ${s.quote.selectedDeliveryOption?.title ?? "none"} · merchant cart total ${usd(s.quote.merchantTotalMinor)} (estimated=${s.quote.totalEstimated}) · DIAPORIA verified total: ${usd(s.cost?.totalMinor)}`);
  console.log(`   issues: ${s.issues.join(", ")}`);
  console.log(`3. external checkout handoff (merchant-hosted, DIAPORIA does not pay): ${s.quote.externalCheckoutUrl ? new URL(s.quote.externalCheckoutUrl).origin + "/cart/c/…" : "none"}`);
}
console.log(`   lowest VERIFIED eligible offer is still ${c.lowestVerifiedEligibleOffer?.merchantName ?? "none"} at ${usd(c.lowestVerifiedEligibleOffer?.cost?.totalMinor)}`);
console.log(`\nNo cart was checked out, no order exists, and no payment was made. PayPal createOrder calls: ${app.mockPayPal?.calls.createOrder ?? 0}`);
await client.close(); await new Promise<void>((r2) => app.server.close(() => r2()));
