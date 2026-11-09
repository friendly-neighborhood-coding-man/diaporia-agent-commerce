/**
 * Integration demo over real MCP HTTP, ALL MOCK providers (no keys, no network, no money):
 * request → catalog discovery → Evidence Router (Tavily/KERNEL only where justified) → merchant offers →
 * purchase authority vs service billing kept separate → usage ledger → community vs managed (simulated) billing.
 *   npm run demo:service
 */
import type { AddressInfo } from "node:net";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/http/server.js";
import { ALL_CLIENT_SCOPES, DevAuth, randomSecret } from "../src/auth/devAuth.js";
import { Store } from "../src/store/Database.js";
import { UsageLedger } from "../src/metering/UsageLedger.js";
import { EvidenceRouter } from "../src/evidence/EvidenceRouter.js";
import { MockKernelInspector, MockTavilySearch } from "../src/evidence/providers.js";
import { MockPayPalBillingProvider } from "../src/billing/Billing.js";
import { formatMinor } from "../src/domain/money.js";

async function run(mode: "community" | "managed") {
  const store = new Store(":memory:"); const ledger = new UsageLedger(store);
  const tavily = new MockTavilySearch(); const kernel = new MockKernelInspector();
  const billing = new MockPayPalBillingProvider(store, randomSecret("whsec"));
  if (mode === "managed") billing.setFixtureState("demo-user", "ACTIVE");
  const probe = createServer(); await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as AddressInfo).port; await new Promise<void>((r) => probe.close(() => r()));
  const token = randomSecret("dct"); const auth = new DevAuth(); auth.addClientToken(token, "demo-user", ALL_CLIENT_SCOPES);
  const app = createApp({ host: "127.0.0.1", port, baseUrl: `http://127.0.0.1:${port}`, authMode: "dev", dbPath: ":memory:", auth,
    service: { mode, ledger, router: new EvidenceRouter(store, ledger, tavily, kernel, { billable: mode === "managed" }), billing: mode === "managed" ? billing : null, managedSimulation: mode === "managed" } });
  await new Promise<void>((r) => app.server.listen(port, "127.0.0.1", r));
  const client = new Client({ name: "service-demo", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  await client.listTools();
  const call = async (name: string, args: Record<string, unknown>): Promise<any> => (await client.callTool({ name, arguments: args })).structuredContent;

  console.log(`\n=== ${mode.toUpperCase()} mode${mode === "managed" ? " (SIMULATION: mock billing, dev auth on localhost)" : " (no DIAPORIA billing)"} ===`);
  const r = await call("research_purchase", { request: "Find good headphones under $100", mustHave: ["active_noise_cancellation"], currency: "USD" });
  console.log(`1-2. research_purchase → ${r.candidates.length} catalog candidates [${r.dataSource.mockData ? "MOCK catalog" : "live catalog"}]`);
  for (const c of r.candidates) {
    const steps = c.evidenceRouting.flatMap((e: any) => e.steps.map((s: any) => `${s.provider}:${s.action}`));
    console.log(`   ${c.title.padEnd(48)} ${c.suitability.padEnd(18)} ${steps.length ? steps.join(" → ") : "no extra research (existing evidence sufficient)"}`);
  }
  console.log(`3-5. provider calls: Tavily ${tavily.calls}, KERNEL ${kernel.calls} (only where the sufficiency rule required)`);
  const lumen = r.candidates.find((x: any) => x.productId === "prd_lumen_q3");
  const c = await call("compare_purchase_offers", { researchSessionId: r.purchaseSessionId, productIdentity: lumen.identity, destination: { country: "US", region: "CA" } });
  const o = [...c.eligibleOffers, ...c.ineligibleOffers][0];
  console.log(`6. merchant quote for Lumen Q3: ${o?.merchantName} → ${o?.offerEvidenceClass}, issues ${o?.issues.join(",") || "none"} (no order: ${o?.merchantOrderStatus})`);
  console.log("7. purchase authority (owner mandate + PayPal buyer approval) and service billing are separate; this demo makes no purchase.");
  const u = await call("get_usage_summary", {});
  console.log(`8. ledger ${u.usage.period}: ${u.usage.lines.map((l: any) => `${l.provider}:${l.operation} x${l.operations} est ${l.estimatedSupplierMicroUsd}µUSD billable ${l.billableMinor}¢`).join("; ")}`);
  if (mode === "managed") console.log(`10. simulated service-billing summary: ${u.billing.billingAuthorization.status} [${u.billing.billingAuthorization.source}], $${formatMinor(u.billing.periodSummary.billableMinor, "USD")} ${u.billing.periodSummary.status}`);
  else console.log(`9. community: ${u.billing.status}`);
  await client.close(); await new Promise<void>((r2) => app.server.close(() => r2()));
}
await run("community");
await run("managed");
console.log("\nAll providers were MOCK. Prices are placeholders, not provider or DIAPORIA prices. No PayPal call was made.");
