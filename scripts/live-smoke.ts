/**
 * BOUNDED LIVE provider smoke test (no checkout, no PayPal). Requires --confirm-live.
 *   node --env-file=<env with CHANNEL3_API_KEY [TAVILY_API_KEY]> --import tsx scripts/live-smoke.ts --confirm-live
 * Budget (enforced by the ledger's per-request call caps; supplier prices are UNKNOWN and recorded as such):
 *   Channel3 ≤ 1 search per request · Tavily ≤ 2 searches per request (only if a key exists) · KERNEL ≤ 1 page (adapter not in public repo)
 * The same research request is run twice to show reuse (no second Channel3 call).
 */
import type { AddressInfo } from "node:net";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/http/server.js";
import { ALL_CLIENT_SCOPES, DevAuth, randomSecret } from "../src/auth/devAuth.js";
import { Store } from "../src/store/Database.js";
import { UsageLedger, LIVE_PRICES_UNKNOWN } from "../src/metering/UsageLedger.js";
import { EvidenceRouter } from "../src/evidence/EvidenceRouter.js";
import { TavilySearch } from "../src/evidence/providers.js";
import { Channel3ResearchAdapter } from "../src/research/Channel3ResearchAdapter.js";

if (!process.argv.includes("--confirm-live")) { console.error("Refusing to make live provider calls without --confirm-live"); process.exit(2); }
const env = process.env;
const budget = { CHANNEL3: 1, TAVILY: 2, KERNEL: 1 };
const availability = { CHANNEL3: !!env.CHANNEL3_API_KEY, TAVILY: !!env.TAVILY_API_KEY, KERNEL: false };
console.log("Budget (per request):", JSON.stringify(budget), "· prices: UNKNOWN (ledger records NULL cost) · availability:", JSON.stringify(availability));
if (!availability.CHANNEL3) { console.error("CHANNEL3_API_KEY not configured: stopping (no fixture substitution)."); process.exit(3); }

let channel3Http = 0;
const countingFetch: typeof fetch = async (u, init) => { if (String(u).includes("trychannel3.com")) channel3Http++; return fetch(u, init); };
const channel3 = new Channel3ResearchAdapter(env.CHANNEL3_API_KEY!, { limit: 10, fetchImpl: countingFetch });
const store = new Store(":memory:");
const ledger = new UsageLedger(store, LIVE_PRICES_UNKNOWN, { perRequestSupplierMicro: 0, monthlyBillableMinor: 0, perRequestCalls: budget });
const tavily = availability.TAVILY ? new TavilySearch(env.TAVILY_API_KEY!, "community") : null;
const router = new EvidenceRouter(store, ledger, tavily, null, { billable: false });

const probe = createServer(); await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
const port = (probe.address() as AddressInfo).port; await new Promise<void>((r) => probe.close(() => r()));
const token = randomSecret("dct"); const auth = new DevAuth(); auth.addClientToken(token, "live-smoke", ALL_CLIENT_SCOPES);
const app = createApp({ host: "127.0.0.1", port, baseUrl: `http://127.0.0.1:${port}`, authMode: "dev", dbPath: ":memory:", auth, research: channel3,
  service: { mode: "community", ledger, router, billing: null } });
await new Promise<void>((r) => app.server.listen(port, "127.0.0.1", r));
const client = new Client({ name: "live-smoke", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
await client.listTools();
const call = async (name: string, args: Record<string, unknown>): Promise<any> => {
  const r = await client.callTool({ name, arguments: args });
  return r.isError ? { error: JSON.parse((r.content as Array<{ text: string }>)[0]!.text).error } : r.structuredContent;
};

const req = { request: "Buy Sony WH-CH720N Black", currency: "USD", mustHave: ["active_noise_cancellation"] };
const startedAt = new Date().toISOString();
const r1 = await call("research_purchase", req);
const callsAfter1 = channel3Http;
let compare: any = null;
if (r1.identity?.status === "LOCKED") compare = await call("compare_purchase_offers", { researchSessionId: r1.purchaseSessionId, productIdentity: r1.identity.lockedIdentity, destination: { country: "US", region: "CA" } });
const r2 = await call("research_purchase", req);
const usage = await call("get_usage_summary", {});
await client.close(); await new Promise<void>((r) => app.server.close(() => r()));

const evidence = {
  kind: "LIVE_PROVIDER_SMOKE", startedAt, finishedAt: new Date().toISOString(), budget, availability,
  channel3HttpCalls: { afterFirstRequest: callsAfter1, total: channel3Http },
  firstRequest: r1.error ? { error: r1.error } : {
    mode: r1.mode, state: r1.state, identity: r1.identity, candidates: r1.candidates?.map((c: any) => ({ productId: c.productId, title: c.title, identity: c.identity, suitability: c.suitability,
      mustHave: c.mustHave, evidenceRouting: c.evidenceRouting, lowestListing: c.listingPrice })), unknowns: r1.unknowns, usage: r1.usage,
  },
  compare: compare && !compare.error ? { state: compare.state, eligible: compare.eligibleOffers.length, ineligible: compare.ineligibleOffers.map((o: any) => ({ merchant: o.merchantDomain,
    listingUrl: o.listingUrl, listedIdentity: o.listedIdentity, identityMatch: o.identityMatch, listingPriceMinor: o.listingPriceMinor, issues: o.issues, evidenceClass: o.offerEvidenceClass })), holdReasons: compare.holdReasons } : compare,
  secondRequest: r2.error ? { error: r2.error } : { state: r2.state, identity: r2.identity?.status, evidenceRouting: r2.candidates?.map((c: any) => c.evidenceRouting), usage: r2.usage },
  usageSummary: usage.usage,
};
mkdirSync("docs/evidence", { recursive: true });
const file = `docs/evidence/live-smoke-${startedAt.slice(0, 10)}.json`;
writeFileSync(file, JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({ file, channel3HttpCalls: evidence.channel3HttpCalls, identity: r1.identity?.status, candidates: r1.candidates?.length,
  compareState: compare?.state, eligible: compare?.eligibleOffers?.length, secondRequestChannel3Calls: channel3Http - callsAfter1 }, null, 1));
