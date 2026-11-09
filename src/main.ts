import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createApp, isLoopbackUrl } from "./http/server.js";
import { ALL_CLIENT_SCOPES, DevAuth, randomSecret } from "./auth/devAuth.js";
import { PayPalSandboxProvider } from "./payment/PayPalCheckoutAdapter.js";
import { MockPayPalProvider } from "./payment/MockPayPalProvider.js";
import { PayPalWebhookSignatureVerifier } from "./payment/PayPalWebhook.js";

const env = process.env;
const host = env.HOST ?? "127.0.0.1";
const port = Number(env.PORT ?? 8790);
const baseUrl = (env.PUBLIC_BASE_URL ?? `http://${host}:${port}`).replace(/\/$/, "");
const authMode = env.DIAPORIA_AUTH_MODE === "public-readonly-demo" ? "public-readonly-demo" : "dev";
const provider = (env.PAYMENT_PROVIDER ?? "mock").toLowerCase();

const auth = DevAuth.fromEnv(env);
if (authMode === "dev" && auth.empty) {
  // Local convenience: generate per-run dev credentials into .data/ (gitignored).
  const file = ".data/dev-credentials.json";
  let creds: { clientToken: string; ownerKey: string; userId: string };
  if (existsSync(file)) creds = JSON.parse(readFileSync(file, "utf8"));
  else {
    creds = { clientToken: randomSecret("dct"), ownerKey: randomSecret("dok"), userId: "demo-user" };
    mkdirSync(".data", { recursive: true });
    writeFileSync(file, JSON.stringify(creds, null, 2), { mode: 0o600 });
  }
  auth.addClientToken(creds.clientToken, creds.userId, ALL_CLIENT_SCOPES);
  auth.addOwnerKey(creds.ownerKey, creds.userId);
  console.log(`[diaporia] dev credentials for user "${creds.userId}" are in ${file} (local only; never share or commit).`);
}
if (authMode === "dev" && !isLoopbackUrl(baseUrl)) {
  console.warn("[diaporia] PUBLIC_BASE_URL is not loopback: dev-token auth is not production auth, so payment execution is DISABLED.");
}

const app = createApp({
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
const stop = () => app.server.close(() => process.exit(0));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
