/**
 * Merchant identity demo: a valid merchant vs. an impersonator using stolen registration details.
 * Everything is MOCK (fictional registries, mock recipient attestation, mock PayPal). No network.
 *   npm run demo:identity
 */
import type { AddressInfo } from "node:net";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/http/server.js";
import { ALL_CLIENT_SCOPES, DevAuth, randomSecret } from "../src/auth/devAuth.js";
import { formatMinor } from "../src/domain/money.js";

const usd = (m: number | null | undefined) => (m == null ? "unknown" : `$${formatMinor(m, "USD")}`);
const probe = createServer();
await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
const port = (probe.address() as AddressInfo).port;
await new Promise<void>((r) => probe.close(() => r()));
const token = randomSecret("dct"), ownerKey = randomSecret("dok");
const auth = new DevAuth(); auth.addClientToken(token, "demo-user", ALL_CLIENT_SCOPES); auth.addOwnerKey(ownerKey, "demo-user");
const baseUrl = `http://127.0.0.1:${port}`;
const app = createApp({ host: "127.0.0.1", port, baseUrl, authMode: "dev", dbPath: ":memory:", auth });
await new Promise<void>((r) => app.server.listen(port, "127.0.0.1", r));
const client = new Client({ name: "identity-demo", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
await client.listTools();
const call = async (name: string, args: Record<string, unknown>): Promise<any> => {
  const r = await client.callTool({ name, arguments: args });
  return r.isError ? { error: JSON.parse((r.content as Array<{ text: string }>)[0]!.text).error } : r.structuredContent;
};
// The MOCK buyer step needs the owner key (stand-in for the buyer's PayPal login) on a same-origin POST (WP-1).
const mockBuyer = { headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: new URL(baseUrl).origin }, body: new URLSearchParams({ owner_key: ownerKey }).toString() };
const sony = { brand: "Sony", model: "WH-CH720N", variant: "Black", condition: "new", sku: "WHCH720N/B" };
await fetch(`${baseUrl}/owner/mandates`, { method: "POST", headers: { "Content-Type": "application/json", "X-Owner-Key": ownerKey }, body: JSON.stringify({ productIdentity: sony, currency: "USD", maximumTotalMinor: 6000, autoUse: true }) });

console.log("DIAPORIA merchant identity demo — ALL MOCK: fictional registries, mock recipient attestation, mock PayPal.\n");
const research = await call("research_purchase", { request: "Buy Sony WH-CH720N Black, never exceed $60", currency: "USD" });
const compare = await call("compare_purchase_offers", { researchSessionId: research.purchaseSessionId, productIdentity: sony, destination: { country: "US", region: "CA" } });
const all = [...compare.eligibleOffers, ...compare.ineligibleOffers];
for (const id of ["off_alpha", "off_imposter"]) {
  const o = all.find((x: any) => x.offerId === id);
  const mi = o.merchantIdentity;
  console.log(`${o.merchantDomain}  total ${usd(o.cost?.totalMinor)}  →  ${o.eligible ? "ELIGIBLE" : "REJECTED " + o.issues.join(",")}`);
  console.log(`  claims: registration ${mi.identifierMasked}, legal entity "${mi.verifiedLegalName}"`);
  console.log(`  legal entity: ${mi.legalEntity}   payment relationship: ${mi.paymentRelationship}   overall: ${mi.overall}`);
  for (const c of mi.checks) console.log(`    ${c.result.padEnd(8)} ${c.check.padEnd(28)} [${c.provenance ?? "-"}] ${c.detail}`);
  console.log("");
}
console.log(`The impersonator is ${usd(all.find((x: any) => x.offerId === "off_imposter").cost.totalMinor)}, cheaper than the real merchant, and quotes the real company's registration number.`);
console.log(`Lowest verified eligible offer: ${compare.lowestVerifiedEligibleOffer.merchantDomain} at ${usd(compare.lowestVerifiedEligibleOffer.cost.totalMinor)}\n`);

const prep = await call("prepare_checkout", { purchaseSessionId: research.purchaseSessionId, offerId: "off_alpha", maximumApprovedTotalMinor: 6000, currency: "USD", quantity: 1 });
const b = prep.purchaseSummary.merchantIdentity;
console.log(`prepare_checkout → ${prep.state}; bound: payee ${b.intendedPayeeId} (${b.payeeRelationship}), attestation ${b.attestationId} until ${b.attestationExpiresAt}, provenance ${b.provenance.join(",")}`);

// Attack: the PayPal order's recipient is swapped after preparation.
const orderId = new URL(prep.approvalUrl).pathname.split("/").pop()!;
app.mockPayPal!.substitutePayee(orderId, "MOCKPAYEE-ZULU");
const approve = await fetch(`${baseUrl}/mock-paypal/checkout/${orderId}/approve`, { method: "POST", redirect: "manual", headers: mockBuyer.headers, body: mockBuyer.body });
await fetch(approve.headers.get("location")!);
const s = await call("get_checkout_status", { checkoutSessionId: prep.checkoutSessionId });
console.log(`Recipient swapped to MOCKPAYEE-ZULU after approval → ${s.state} / ${s.failure?.code}; captures: ${app.mockPayPal!.calls.captureOrder}`);

// Clean run with a new mandate: recipient verified, payment captured.
await fetch(`${baseUrl}/owner/mandates`, { method: "POST", headers: { "Content-Type": "application/json", "X-Owner-Key": ownerKey }, body: JSON.stringify({ productIdentity: sony, currency: "USD", maximumTotalMinor: 6000, autoUse: true }) });
const r2 = await call("research_purchase", { request: "Buy Sony WH-CH720N Black, never exceed $60", currency: "USD" });
await call("compare_purchase_offers", { researchSessionId: r2.purchaseSessionId, productIdentity: sony, destination: { country: "US", region: "CA" } });
const p2 = await call("prepare_checkout", { purchaseSessionId: r2.purchaseSessionId, offerId: "off_alpha", maximumApprovedTotalMinor: 6000, currency: "USD", quantity: 1 });
const o2 = new URL(p2.approvalUrl).pathname.split("/").pop()!;
const a2 = await fetch(`${baseUrl}/mock-paypal/checkout/${o2}/approve`, { method: "POST", redirect: "manual", headers: mockBuyer.headers, body: mockBuyer.body });
await fetch(a2.headers.get("location")!);
const s2 = await call("get_checkout_status", { checkoutSessionId: p2.checkoutSessionId });
console.log(`Untampered checkout → ${s2.state}; recipient ${s2.recipient.actualRecipientId} verified=${s2.recipient.verified} [${s2.recipient.provenance}]; fulfillment ${s2.fulfillment}`);

await client.close();
await new Promise<void>((r) => app.server.close(() => r()));
console.log("\nNo official registry, and no PayPal merchant-identity attestation, was contacted. See README: Merchant Identity Verification — Mocked Future Integration.");
