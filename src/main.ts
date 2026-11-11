import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkServiceIsolation, parseAiHostUids } from "./security/ServiceIsolation.js";
import { OwnerConfirmationBoundary } from "./auth/OwnerConfirmation.js";
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
import { SERVICE_LIVE_CAPS, SERVICE_LIVE_RETRY } from "./metering/LiveCallGuard.js";

// V2.2 WP-2: every file this process creates (database, WAL/SHM, credentials) is private to the service account.
process.umask(0o077);
const env = process.env;
const host = env.HOST ?? "127.0.0.1";
const port = Number(env.PORT ?? 8790);
const baseUrl = (env.PUBLIC_BASE_URL ?? `http://${host}:${port}`).replace(/\/$/, "");
const authMode = env.DIAPORIA_AUTH_MODE === "public-readonly-demo" ? "public-readonly-demo" : env.DIAPORIA_AUTH_MODE === "oauth" ? "oauth" : "dev";
const provider = (env.PAYMENT_PROVIDER ?? "mock").toLowerCase();

const auth = DevAuth.fromEnv(env);
const dbPath = env.DIAPORIA_DB_PATH ?? ".data/diaporia.sqlite";
const dataDir = dbPath === ":memory:" ? resolve(".data") : dirname(resolve(dbPath));
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const servicePath = env.DIAPORIA_DB_PATH === ":memory:" ? ":memory:" : (env.DIAPORIA_DB_PATH ?? ".data/diaporia.sqlite").replace(/\.sqlite$/, "") + "-service.sqlite";
const uid = typeof process.getuid === "function" ? process.getuid() : null;
let passwdText = ""; try { passwdText = readFileSync("/etc/passwd", "utf8"); } catch { /* not a Unix host */ }
const aiHostUids = parseAiHostUids(env.DIAPORIA_AI_HOST_UIDS, () => passwdText).uids;
// R-A: the human-confirmation boundary. Owner credentials (owner-key hashes and passkey PUBLIC keys) come only from an
// owner registry file administered by a different OS principal than this server (and than the AI host); nothing the
// server or the AI host can read lets anyone confirm. Fails closed when the boundary cannot be checked.
const ownerConfirmation = OwnerConfirmationBoundary.fromRegistryFile(env.DIAPORIA_OWNER_REGISTRY, {
  cwd: process.cwd(), dataDir, rpId: new URL(baseUrl).hostname, origins: [new URL(baseUrl).origin], untrustedUids: aiHostUids });
// V2.2 WP-2 (H-2): payment-facing operations need the service to run under its own OS account, separate from the AI
// host, with its database, WAL/SHM, data directory, code and configuration out of the AI host's reach.
let codeRoot = dirname(fileURLToPath(import.meta.url));
while (!existsSync(join(codeRoot, "package.json")) && dirname(codeRoot) !== codeRoot) codeRoot = dirname(codeRoot);
const files = (p: string) => p === ":memory:" ? [] : [resolve(p), resolve(p) + "-wal", resolve(p) + "-shm", resolve(p) + "-journal"];
const isolationInput = () => ({ uid, aiHostUids: env.DIAPORIA_AI_HOST_UIDS, dataDir, dataFiles: [...files(dbPath), ...files(servicePath), resolve(".data/dev-credentials.json")],
  codeRoot, execPath: process.execPath, registryEstablished: ownerConfirmation.status.established, registryReason: ownerConfirmation.status.reason, passwd: () => passwdText });
const serviceIsolation = checkServiceIsolation(isolationInput());
// V2.3 (V22-08): the boundary is re-checked while running, not only at startup. If it is lost (for example a loosened
// data directory), payment-facing operations are disabled from then on until a restart re-establishes it.
const isolationState = { established: serviceIsolation.established, reason: serviceIsolation.reason };
if (serviceIsolation.established) {
  const recheck = setInterval(() => {
    const now = checkServiceIsolation(isolationInput());
    if (!now.established && isolationState.established) {
      isolationState.established = false; isolationState.reason = `lost while running: ${now.failures.join("; ") || now.reason}`;
      console.warn(`[diaporia] service isolation LOST while running; payment-facing operations are now DISABLED until restart. ${isolationState.reason}`);
      clearInterval(recheck);
    }
  }, Number(env.DIAPORIA_ISOLATION_RECHECK_MS ?? 60_000));
  recheck.unref();
}
if (serviceIsolation.established) console.log(`[diaporia] service isolation: established (${serviceIsolation.reason}; ${serviceIsolation.inspected} code entries checked)`);
else {
  console.warn("[diaporia] service isolation NOT established, so payment-facing operations (checkout preparation, browser handoff, owner pages) are DISABLED. Research and comparison still work. Reasons:");
  for (const f of serviceIsolation.failures) console.warn(`[diaporia]   - ${f}`);
  console.warn("[diaporia] Set up the dedicated service account: docs/SETUP.md, \"Service account (required for payment-facing operations)\".");
}
for (const w of serviceIsolation.warnings) console.warn(`[diaporia] isolation warning: ${w}`);
for (const v of ownerConfirmation.ownerKeyVerifiers()) auth.addOwnerKeyHash(v.sha256, v.userId);
console.log(ownerConfirmation.status.established
  ? `[diaporia] owner confirmation: protected owner registry (${ownerConfirmation.status.reason})`
  : `[diaporia] owner confirmation UNAVAILABLE: ${ownerConfirmation.status.reason}. Research holds cannot be confirmed until a protected owner registry is set up (docs/SETUP.md, "Owner confirmation").`);
if (ownerConfirmation.status.established && /^\d+\.\d+\.\d+\.\d+$|^\[/.test(new URL(baseUrl).hostname))
  console.warn("[diaporia] passkeys need a host name, not an IP address: use PUBLIC_BASE_URL=http://localhost:<port> for owner confirmation.");
if (env.DIAPORIA_OWNER_KEYS)
  console.warn("[diaporia] DIAPORIA_OWNER_KEYS is set: these owner keys are in this process's environment, readable by any process of the same OS user (including an AI host). Prefer ownerKeySha256 in the protected owner registry. Research-hold confirmation always needs a passkey.");
if (authMode === "dev" && auth.empty) {
  // Local convenience: the AI CLIENT token only, per run, in .data/ (gitignored). R-A: no owner credential is ever
  // generated or written here: this file is readable by the AI host, so an owner key in it would let the agent act as
  // the owner. Owner credentials come only from the protected owner registry (scripts/owner-enroll.ts).
  const file = ".data/dev-credentials.json";
  let creds: { clientToken: string; userId: string; ownerKey?: string } | null = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  if (creds?.ownerKey) {
    console.warn(`[diaporia] ${file} contained an owner key written by an earlier version. It is discarded and NOT accepted: an owner key readable by the AI host is not an owner credential.`);
    creds = { clientToken: creds.clientToken, userId: creds.userId };
    writeFileSync(file, JSON.stringify(creds, null, 2), { mode: 0o600 });
  }
  if (!creds) {
    creds = { clientToken: randomSecret("dct"), userId: "demo-user" };
    mkdirSync(".data", { recursive: true });
    writeFileSync(file, JSON.stringify(creds, null, 2), { mode: 0o600 });
  }
  auth.addClientToken(creds.clientToken, creds.userId, ALL_CLIENT_SCOPES);
  console.log(`[diaporia] dev AI-client token for user "${creds.userId}" is in ${file} (local only; never share or commit). It holds no owner credential.`);
}
if (!auth.hasOwnerKeys) console.log("[diaporia] no owner key is configured: owner pages (checkout authorization, mandates, research holds) refuse every request until the owner enrolls (docs/SETUP.md).");
if (authMode === "dev" && !isLoopbackUrl(baseUrl)) {
  console.warn("[diaporia] PUBLIC_BASE_URL is not loopback: dev-token auth is not production auth, so payment execution is DISABLED.");
}

// ---- Service plane: metering, evidence routing, deployment mode, billing ----
const deploymentMode = env.DIAPORIA_DEPLOYMENT_MODE === "managed" ? "managed" : "community";
const serviceStore = new Store(servicePath);
const byok = env.EVIDENCE_PROVIDERS === "byok" && env.TAVILY_API_KEY;
const liveCatalog = env.RESEARCH_PROVIDER === "channel3" && env.CHANNEL3_API_KEY ? new Channel3ResearchAdapter(env.CHANNEL3_API_KEY, { retry: { ...SERVICE_LIVE_RETRY } }) : null;
// Live providers: supplier prices are UNKNOWN (never assumed), so explicit per-request call caps bound spending. The live
// adapters make ONE HTTP attempt per metered call (no internal retry) and never follow redirects, so the ledger's count is the
// HTTP count (review R-08).
const ledger = byok || liveCatalog
  ? new UsageLedger(serviceStore, LIVE_PRICES_UNKNOWN, { perRequestSupplierMicro: 0, monthlyBillableMinor: 0, perRequestCalls: { ...SERVICE_LIVE_CAPS } })
  : new UsageLedger(serviceStore, PLACEHOLDER_PRICING);
// Independent explicit opt-in: merely keeping KERNEL_API_KEY in .env.local must NEVER trigger paid browsing.
// The remote egress controls are defense-in-depth, not an audited DNS rebinding / IP-layer firewall.
const kernelEnabled = !!byok && !!env.KERNEL_API_KEY && env.DIAPORIA_ENABLE_LIVE_KERNEL_INSPECTION === "1";
const kernel = kernelEnabled ? new KernelPageInspector(env.KERNEL_API_KEY!, deploymentMode, { maxSessions: Number(env.KERNEL_MAX_SESSIONS ?? 20) }) : null;
const evidenceRouter = new EvidenceRouter(serviceStore, ledger,
  byok ? new TavilySearch(env.TAVILY_API_KEY!, deploymentMode, fetch, { ...SERVICE_LIVE_RETRY }) : new MockTavilySearch(),
  byok ? kernel : new MockKernelInspector(),
  // Research V2 evidence policy (source classes + V2 sufficiency rule) unless explicitly pinned to the frozen V1 rule.
  { billable: deploymentMode === "managed", policy: env.DIAPORIA_RESEARCH_POLICY === "v1" ? "v1" : "v2" });
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
  webhookVerifier: env.PAYPAL_WEBHOOK_ID ? new PayPalWebhookSignatureVerifier({ webhookId: env.PAYPAL_WEBHOOK_ID }) : null, sandboxPlatformPayeeId: env.PAYPAL_SANDBOX_PAYEE_MERCHANT_ID || null, sandboxPlatformPayeeEmail: env.PAYPAL_SANDBOX_PAYEE_EMAIL || null, dbPath, ownerConfirmation, serviceIsolation: isolationState,
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
