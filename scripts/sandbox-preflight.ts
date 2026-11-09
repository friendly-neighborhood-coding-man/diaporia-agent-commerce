/**
 * PayPal Sandbox PREFLIGHT. Does NOT create an order, approval or capture.
 *   npx tsx scripts/sandbox-preflight.ts [--env-file <path>]
 * Checks: configuration shape (values never printed), Sandbox-only host, OAuth
 * client-credentials token against Sandbox, and that a $6,000 checkout under a $60
 * mandate is refused with the REAL Sandbox provider wired in, before any PayPal order call.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { createApp } from "../src/http/server.js";
import { ALL_CLIENT_SCOPES, DevAuth, randomSecret } from "../src/auth/devAuth.js";
import { PayPalSandboxProvider, PAYPAL_SANDBOX_API } from "../src/payment/PayPalCheckoutAdapter.js";

const { values } = parseArgs({ options: { "env-file": { type: "string" } } });
const env: Record<string, string | undefined> = { ...process.env };
if (values["env-file"]) {
  for (const line of readFileSync(values["env-file"], "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_ENV", "PAYPAL_SANDBOX_PAYEE_MERCHANT_ID"].includes(m[1]!)) env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}
const results: Array<[string, "PASS" | "FAIL", string]> = [];
const check = (name: string, ok: boolean, detail: string) => results.push([name, ok ? "PASS" : "FAIL", detail]);

const id = env.PAYPAL_CLIENT_ID ?? "", secret = env.PAYPAL_CLIENT_SECRET ?? "", ppEnv = env.PAYPAL_ENV ?? "SANDBOX";
check("credentials present", id.length > 20 && secret.length > 20, `client id length ${id.length}, secret length ${secret.length} (values not shown)`);
check("PAYPAL_ENV is SANDBOX", ppEnv.toUpperCase() === "SANDBOX", `PAYPAL_ENV=${ppEnv.toUpperCase() === "SANDBOX" ? "SANDBOX" : "(not SANDBOX)"}`);
const payee = env.PAYPAL_SANDBOX_PAYEE_MERCHANT_ID ?? "";
check("Sandbox platform payee configured", /^[A-Z0-9]{8,20}$/.test(payee), payee ? "PAYPAL_SANDBOX_PAYEE_MERCHANT_ID set (value not shown); the order recipient will be verified against it" : "PAYPAL_SANDBOX_PAYEE_MERCHANT_ID missing: merchant identity binding cannot verify the Sandbox order recipient, so checkouts HOLD");
check("API host is Sandbox", PAYPAL_SANDBOX_API === "https://api-m.sandbox.paypal.com", PAYPAL_SANDBOX_API);
let liveRefused = false;
try { new PayPalSandboxProvider({ clientId: "x".repeat(30), clientSecret: "y".repeat(30), env: "LIVE" }); } catch { liveRefused = true; }
check("LIVE env refused by adapter", liveRefused, "constructor throws for PAYPAL_ENV=LIVE");

// OAuth only: a token request, no order.
let oauthOk = false, oauthDetail = "skipped";
try {
  const r = await fetch(`${PAYPAL_SANDBOX_API}/v1/oauth2/token`, { method: "POST", signal: AbortSignal.timeout(20_000),
    headers: { Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" }, body: "grant_type=client_credentials" });
  const body = await r.json().catch(() => ({})) as Record<string, unknown>;
  oauthOk = r.status === 200 && typeof body.access_token === "string";
  const scopes = typeof body.scope === "string" ? body.scope.split(" ") : [];
  oauthDetail = `HTTP ${r.status}; token ${oauthOk ? "received (not shown)" : "missing"}; expires_in ${String(body.expires_in ?? "?")}s; ${scopes.length} scopes; checkout scope ${scopes.some((s) => /payments\/payment|checkout/i.test(s)) ? "present" : "not listed"}`;
} catch (e) { oauthDetail = `network error: ${e instanceof Error ? e.name : "unknown"}`; }
check("Sandbox OAuth client-credentials", oauthOk, oauthDetail);

// $6,000 vs $60 with the real Sandbox provider wired in. Count every PayPal HTTP call.
let paypalCalls = 0;
const counting: typeof fetch = async (u, init) => { paypalCalls++; return fetch(u, init); };
const token = randomSecret("dct"), owner = randomSecret("dok");
const auth = new DevAuth(); auth.addClientToken(token, "preflight-user", ALL_CLIENT_SCOPES); auth.addOwnerKey(owner, "preflight-user");
const app = createApp({ host: "127.0.0.1", port: 0, baseUrl: "http://127.0.0.1:8790", authMode: "dev", dbPath: ":memory:", auth,
  sandboxPlatformPayeeId: payee || "PREFLIGHTPLACEHOLDER",
  payments: () => new PayPalSandboxProvider({ clientId: id || "x".repeat(30), clientSecret: secret || "y".repeat(30), env: "SANDBOX", fetchImpl: counting }) });
const gw = app.gateway;
const sony = { brand: "Sony", model: "WH-CH720N", variant: "Black", condition: "new" as const, sku: "WHCH720N/B" };
gw.mandates.create({ userId: "preflight-user", productIdentity: sony, currency: "USD", maximumTotalMinor: 6000, createdVia: "OWNER_API" });
const r = await gw.researchPurchase("preflight-user", { request: "Buy Sony WH-CH720N Black", currency: "USD", budgetMinor: 1_000_000 });
await gw.compareOffers("preflight-user", { researchSessionId: r.purchaseSessionId, productIdentity: sony, destination: { country: "US", region: "CA" } });
const prep = await gw.prepareCheckout("preflight-user", { purchaseSessionId: r.purchaseSessionId, offerId: "off_india", maximumApprovedTotalMinor: 600000, currency: "USD", quantity: 1 });
check("$6,000 under $60 mandate refused before PayPal", prep.state === "HOLD" && prep.policy?.code === "AMOUNT_EXCEEDED" && paypalCalls === 0,
  `state ${prep.state}, policy ${prep.policy?.code}, server total ${prep.purchaseSummary?.totalMinor}, PayPal HTTP calls ${paypalCalls}`);
check("server-owned amount", prep.purchaseSummary?.totalMinor === 600000 && prep.paymentEffect === "NO_FUNDS_CAPTURED", "summary total comes from the merchant quote, not the client maximum");
app.store.close();

const width = Math.max(...results.map(([n]) => n.length));
for (const [n, s, d] of results) console.log(`${s}  ${n.padEnd(width)}  ${d}`);
const ready = results.every(([, s]) => s === "PASS");
console.log(`\n${ready ? "READY_FOR_SANDBOX_E2E" : "NOT_READY"}: no order, approval or capture was created.`);
process.exit(ready ? 0 : 1);
