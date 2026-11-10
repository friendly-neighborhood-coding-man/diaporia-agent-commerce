/**
 * Offline, credential-free demo of the full purchase path over real MCP HTTP.
 * Everything is MOCK: fixture catalog, fictional merchants, mock PayPal.
 *   npm run demo:e2e
 */
import type { AddressInfo } from "node:net";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/http/server.js";
import { ALL_CLIENT_SCOPES, DevAuth, randomSecret } from "../src/auth/devAuth.js";
import { formatMinor } from "../src/domain/money.js";

const usd = (m: number | null) => (m === null ? "unknown" : `$${formatMinor(m, "USD")}`);
const step = (n: string, s: string) => console.log(`\n\x1b[1m${n}\x1b[0m ${s}`);

const probe = createServer();
await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
const port = (probe.address() as AddressInfo).port;
await new Promise<void>((r) => probe.close(() => r()));
const token = randomSecret("dct"); const ownerKey = randomSecret("dok");
const auth = new DevAuth(); auth.addClientToken(token, "demo-user", ALL_CLIENT_SCOPES); auth.addOwnerKey(ownerKey, "demo-user");
const baseUrl = `http://127.0.0.1:${port}`;
const app = createApp({ host: "127.0.0.1", port, baseUrl, authMode: "dev", dbPath: ":memory:", auth });
await new Promise<void>((r) => app.server.listen(port, "127.0.0.1", r));

const client = new Client({ name: "demo-ai-client", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
const call = async (name: string, args: Record<string, unknown>): Promise<any> => {
  const r = await client.callTool({ name, arguments: args });
  return r.isError ? { error: JSON.parse((r.content as Array<{ text: string }>)[0]!.text).error } : r.structuredContent;
};

console.log("DIAPORIA Agent Commerce: offline MCP demo (MOCK data, MOCK PayPal; no network, no money)");
const tools = await client.listTools();
step("0.", `AI client discovered tools: ${tools.tools.map((t) => `${t.name}${t.annotations?.readOnlyHint ? " [read-only]" : ""}`).join(", ")}`);

const sony = { brand: "Sony", model: "WH-CH720N", variant: "Black", condition: "new", sku: "WHCH720N/B" };
await fetch(`${baseUrl}/owner/mandates`, { method: "POST", headers: { "Content-Type": "application/json", "X-Owner-Key": ownerKey },
  body: JSON.stringify({ productIdentity: sony, currency: "USD", maximumTotalMinor: 6000 }) });
step("1.", "The human (owner key, not the AI) created a mandate: Sony WH-CH720N Black, new, max $60.00, 1 transaction.");

const request = "Buy Sony WH-CH720N Black for the lowest total price, but never exceed $60.";
const research = await call("research_purchase", { request, currency: "USD" });
step("2.", `research_purchase → mode ${research.mode}, identity ${research.identity.status} (${JSON.stringify(research.identity.lockedIdentity)})`);
const flagged = research.candidates[0].untrustedContent.filter((u: any) => u.flags.length);
console.log(`   untrusted review text flagged and ignored: ${flagged.map((f: any) => f.flags.join("+")).join(", ")}`);

const compare = await call("compare_purchase_offers", { researchSessionId: research.purchaseSessionId, productIdentity: sony, destination: { country: "US", region: "CA" } });
step("3.", `compare_purchase_offers → ${compare.state}`);
for (const o of [...compare.eligibleOffers, ...compare.ineligibleOffers])
  console.log(`   ${o.eligible ? "ELIGIBLE  " : "rejected  "} ${o.merchantName.padEnd(26)} listing ${usd(o.listingPriceMinor).padEnd(9)} total ${usd(o.cost?.totalMinor ?? null).padEnd(9)} ${o.issues.join(", ")}`);
console.log(`   lowest verified eligible: ${compare.lowestVerifiedEligibleOffer.merchantName} at ${usd(compare.lowestVerifiedEligibleOffer.cost.totalMinor)}`);

const attack = await call("research_purchase", { request: "Buy Sony WH-CH720N Black", currency: "USD", budgetMinor: 1_000_000 });
await call("compare_purchase_offers", { researchSessionId: attack.purchaseSessionId, productIdentity: sony, destination: { country: "US", region: "CA" } });
const before = app.mockPayPal!.calls.createOrder;
const big = await call("prepare_checkout", { purchaseSessionId: attack.purchaseSessionId, offerId: "off_india", maximumApprovedTotalMinor: 600000, currency: "USD", quantity: 1 });
step("4.", `Misled AI tries a $6,000.00 checkout (client says budget $10,000) → state ${big.state}, policy ${big.policy.code}; PayPal createOrder calls during attempt: ${app.mockPayPal!.calls.createOrder - before}`);

const prep = await call("prepare_checkout", { purchaseSessionId: research.purchaseSessionId, offerId: compare.lowestPayPalCheckoutableOffer.offerId, maximumApprovedTotalMinor: 6000, currency: "USD", quantity: 1 });
step("5.", `prepare_checkout → ${prep.state}, policy ${prep.policy.code}, total ${usd(prep.purchaseSummary.totalMinor)}, captured: no`);
console.log(`   approval URL for the user: ${prep.approvalUrl}`);

const orderId = new URL(prep.approvalUrl).pathname.split("/").pop();
const approve = await fetch(`${baseUrl}/mock-paypal/checkout/${orderId}/approve`, { method: "POST", redirect: "manual" });
await fetch(approve.headers.get("location")!);
step("6.", "Buyer approved on the (mock) PayPal page; server verified approval with the provider and captured once.");

const status = await call("get_checkout_status", { checkoutSessionId: prep.checkoutSessionId });
step("7.", `get_checkout_status → ${status.state} (server-verified), ${usd(status.amount.totalMinor)}, capture ${status.capture.captureId}, fulfillment ${status.fulfillment}
   purchaseOutcome: payment ${status.purchaseOutcome.payment}, merchant order ${status.purchaseOutcome.merchantOrderConfirmation}, fulfillment ${status.purchaseOutcome.fulfillment}, merchantPurchaseComplete ${status.purchaseOutcome.merchantPurchaseComplete}
   "${status.purchaseOutcome.statement}"`);
const receipt = await call("get_purchase_receipt", { checkoutSessionId: prep.checkoutSessionId });
step("8.", `get_purchase_receipt → ${receipt.paymentStatusNote} Merchant order: ${receipt.merchantOrder.status}. Audit events: ${receipt.auditTimeline.map((e: any) => e.type).join(" → ")}`);

await client.close();
await new Promise<void>((r) => app.server.close(() => r()));
console.log("\nDone. All data above is mock data; see docs/TEST_REPORT.md for what is and is not live-verified.");
