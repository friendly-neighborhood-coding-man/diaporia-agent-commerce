import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createApp, isLoopbackUrl } from "./http/server.js";
import { ALL_CLIENT_SCOPES, DevAuth, randomSecret } from "./auth/devAuth.js";
import { PayPalSandboxProvider } from "./payment/PayPalCheckoutAdapter.js";
import { MockPayPalProvider } from "./payment/MockPayPalProvider.js";
import { PayPalWebhookSignatureVerifier } from "./payment/PayPalWebhook.js";
import { Store } from "./store/Database.js";
import { createManagedBilling } from "./billing/subscriptions/factory.js";
import { UsageLedger, LIVE_PRICES_UNKNOWN, PLACEHOLDER_PRICING } from "./metering/UsageLedger.js";
import { Channel3ResearchAdapter } from "./research/Channel3ResearchAdapter.js";
import { EvidenceRouter } from "./evidence/EvidenceRouter.js";
import { MockKernelInspector, MockTavilySearch, TavilySearch } from "./evidence/providers.js";
import { KernelPageInspector } from "./evidence/KernelPageInspector.js";
import { MockPayPalBillingProvider } from "./billing/Billing.js";
import { randomBytes } from "node:crypto";
import { configureHandoffFromEnv } from "./handoff/config.js";

const env = process.env;
const host = env.HOST ?? "127.0.0.1";
const port = Number(env.PORT ?? 8790);
const baseUrl = (env.PUBLIC_BASE_URL ?? `http://${host}:${port}`).replace(/\/$/, "");
const authMode = env.DIAPORIA_AUTH_MODE === "public-readonly-demo" ? "public-readonly-demo" : env.DIAPORIA_AUTH_MODE === "oauth" ? "oauth" : "dev";
const provider = (env.PAYMENT_PROVIDER ?? "mock").toLowerCase();

const auth = DevAuth.fromEnv(env);
if ((authMode === "dev" && auth.empty) || (authMode === "oauth" && !env.DIAPORIA_OWNER_KEYS)) {
  // Local convenience: generate per-run dev credentials into .data/ (gitignored).
  const file = ".data/dev-credentials.json";
  let creds: { clientToken: string; ownerKey: string; userId: string };
  if (existsSync(file)) creds = JSON.parse(readFileSync(file, "utf8"));
  else {
    creds = { clientToken: randomSecret("dct"), ownerKey: randomSecret("dok"), userId: "demo-user" };
    mkdirSync(".data", { recursive: true });
    writeFileSync(file, JSON.stringify(creds, null, 2), { mode: 0o600 });
  }
  if (authMode === "dev") auth.addClientToken(creds.clientToken, creds.userId, ALL_CLIENT_SCOPES);
  auth.addOwnerKey(creds.ownerKey, creds.userId);
  console.log(`[diaporia] dev credentials for user "${creds.userId}" are in ${file} (local only; never share or commit).`);
}
if (authMode === "dev" && !isLoopbackUrl(baseUrl)) {
  console.warn("[diaporia] PUBLIC_BASE_URL is not loopback: dev-token auth is not production auth, so payment execution is DISABLED.");
}

// ---- Service plane: metering, evidence routing, deployment mode, billing ----
const deploymentMode = env.DIAPORIA_DEPLOYMENT_MODE === "managed" ? "managed" : "community";
const servicePath = env.DIAPORIA_DB_PATH === ":memory:" ? ":memory:" : (env.DIAPORIA_DB_PATH ?? ".data/diaporia.sqlite").replace(/\.sqlite$/, "") + "-service.sqlite";
const serviceStore = new Store(servicePath);
const byok = env.EVIDENCE_PROVIDERS === "byok" && env.TAVILY_API_KEY;
const liveCatalog = env.RESEARCH_PROVIDER === "channel3" && env.CHANNEL3_API_KEY ? new Channel3ResearchAdapter(env.CHANNEL3_API_KEY) : null;
// Live providers: supplier prices are UNKNOWN (never assumed), so explicit per-request call caps bound spending.
const ledger = byok || liveCatalog
  ? new UsageLedger(serviceStore, LIVE_PRICES_UNKNOWN, { perRequestSupplierMicro: 0, monthlyBillableMinor: 0, perRequestCalls: { CHANNEL3: 1, TAVILY: 2, KERNEL: 1 } })
  : new UsageLedger(serviceStore, PLACEHOLDER_PRICING);
// Independent explicit opt-in: merely keeping KERNEL_API_KEY in .env.local must NEVER trigger paid browsing.
// The remote egress controls are defense-in-depth, not an audited DNS rebinding / IP-layer firewall.
const kernelEnabled = !!byok && !!env.KERNEL_API_KEY && env.DIAPORIA_ENABLE_LIVE_KERNEL_INSPECTION === "1";
const kernel = kernelEnabled ? new KernelPageInspector(env.KERNEL_API_KEY!, deploymentMode, { maxSessions: Number(env.KERNEL_MAX_SESSIONS ?? 20) }) : null;
const evidenceRouter = new EvidenceRouter(serviceStore, ledger,
  byok ? new TavilySearch(env.TAVILY_API_KEY!, deploymentMode) : new MockTavilySearch(),
  byok ? kernel : new MockKernelInspector(),
  { billable: deploymentMode === "managed" });
const service = { mode: deploymentMode as "community" | "managed", ledger, router: evidenceRouter,
  billing: deploymentMode === "managed" ? createManagedBilling(env, serviceStore, ledger, baseUrl) : null, // MANAGED_BILLING=legacy-mock keeps MockPayPalBillingProvider
  managedSimulation: env.DIAPORIA_MANAGED_SIMULATION === "1" };
console.log(`[diaporia] deployment=${deploymentMode}${service.managedSimulation ? " (SIMULATION)" : ""}, catalog=${liveCatalog ? "Channel3 (live)" : "MOCK fixtures"}, evidence providers=${byok ? `BYOK Tavily, KERNEL ${kernel ? "BYOK (live, paid per browser-second)" : "disabled (requires key and explicit opt-in)"}` : "MOCK"}`);

const handoff = await configureHandoffFromEnv(env);
if (handoff) console.log(`[diaporia] browser checkout handoff: driver=${handoff.config.driver.name}${handoff.note ? ` (${handoff.note})` : ""}`);

const app = createApp({
  service,
  ...(handoff ? { handoff: handoff.config } : {}),
  ...(liveCatalog ? { research: liveCatalog } : {}),
  host, port, baseUrl, authMode, auth,
  webhookVerifier: env.PAYPAL_WEBHOOK_ID ? new PayPalWebhookSignatureVerifier({ webhookId: env.PAYPAL_WEBHOOK_ID }) : null, sandboxPlatformPayeeId: env.PAYPAL_SANDBOX_PAYEE_MERCHANT_ID || null, sandboxPlatformPayeeEmail: env.PAYPAL_SANDBOX_PAYEE_EMAIL || null, dbPath: env.DIAPORIA_DB_PATH ?? ".data/diaporia.sqlite",
  payments: (url) => provider === "paypal_sandbox"
    ? new PayPalSandboxProvider({ clientId: env.PAYPAL_CLIENT_ID ?? "", clientSecret: env.PAYPAL_CLIENT_SECRET ?? "", env: env.PAYPAL_ENV ?? "SANDBOX" })
    : new MockPayPalProvider(url),
});
app.server.listen(port, host, () => {
  console.log(`[diaporia] MCP endpoint ${baseUrl}/mcp  (auth=${authMode}, payments=${app.gateway.payments.name}, paymentExecution=${app.paymentExecutionEnabled ? "enabled-local" : "DISABLED"})`);
  // Restart recovery: re-read (GET only) every capture whose outcome is not final.
  app.gateway.reconcileAwaitingSettlement("STARTUP")
    .then((r) => { if (r.length) console.log(`[diaporia] startup reconciliation: ${r.map((x) => `${x.checkoutSessionId.slice(0, 11)}… ${x.outcome} → ${x.state}`).join("; ")}`); })
    .catch((e) => console.error("[diaporia] startup reconciliation failed:", e instanceof Error ? e.message : "unknown"));
});
const stop = () => app.server.close(() => {
  void (handoff?.shutdown() ?? Promise.resolve()).then(
    () => process.exit(0),
    () => { console.error("[diaporia] FATAL: browser cleanup was not verified during shutdown"); process.exit(1); },
  );
});
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
