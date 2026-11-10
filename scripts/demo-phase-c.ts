/**
 * OFFLINE Phase C demo (C0): DIAPORIA's browser handoff + the Phase C test merchant in MOCK mode.
 * No PayPal, no KERNEL, no network beyond 127.0.0.1. Writes a JSON evidence summary to stdout (last line).
 *
 *   npm run demo:phase-c                    # simulated human approves in the merchant's MOCK popup
 *   npm run demo:phase-c -- --cancel        # simulated human cancels instead
 *   npm run demo:phase-c -- --interactive   # YOU are the human (visible Chromium); the owner key is printed once
 */
import type { AddressInfo } from "node:net";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/http/server.js";
import { ALL_CLIENT_SCOPES, DevAuth, randomSecret } from "../src/auth/devAuth.js";
import { LocalFixtureDriver, launchLocalChromium, type LocalFixtureSession } from "../src/handoff/drivers.js";
import { MerchantRecipeRegistry } from "../src/handoff/recipes.js";
import { SellerSourceRegistry } from "../src/handoff/sellerConfirmation.js";
import { PhaseCSellerStatusSource, phaseCRecipe } from "../src/handoff/phaseCMerchant.js";
import { loadMerchantConfig } from "../apps/phase-c-test-merchant/src/config.js";
import { startMerchantServer } from "../apps/phase-c-test-merchant/src/server.js";

const interactive = process.argv.includes("--interactive");
const cancel = process.argv.includes("--cancel");
const say = (n: number, s: string) => console.log(`\n${n}. ${s}`);

const statusSecret = randomBytes(32).toString("hex");
const merchant = await startMerchantServer({ config: loadMerchantConfig({ MERCHANT_LISTEN_PORT: "0", MERCHANT_STATUS_SECRET: statusSecret }) });
const driver = new LocalFixtureDriver(() => launchLocalChromium({ headless: !interactive }));
const token = randomSecret("dct"), ownerKey = randomSecret("dok");
const auth = new DevAuth(); auth.addClientToken(token, "demo-user", ALL_CLIENT_SCOPES); auth.addOwnerKey(ownerKey, "demo-user");
const probe = createServer(); await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
const port = (probe.address() as AddressInfo).port; await new Promise<void>((r) => probe.close(() => r()));
const url = `http://127.0.0.1:${port}`;
const app = createApp({ host: "127.0.0.1", port, baseUrl: url, authMode: "dev", dbPath: ":memory:", auth,
  handoff: { driver, recipes: new MerchantRecipeRegistry([phaseCRecipe(merchant.origin, null)], { allowLoopbackOrigin: true }),
    sellers: new SellerSourceRegistry([new PhaseCSellerStatusSource({ origin: merchant.origin, secret: statusSecret, acceptMockEvidence: true })]) } });
await new Promise<void>((r) => app.server.listen(port, "127.0.0.1", r));
const client = new Client({ name: "diaporia-phase-c-demo", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
await client.listTools();
const call = async (name: string, args: Record<string, unknown>) => { const r = await client.callTool({ name, arguments: args }); if (r.isError) throw new Error(JSON.stringify(r.content)); return r.structuredContent as any; };

let exitCode = 0;
try {
  console.log(`Phase C test merchant (MOCK) at ${merchant.origin}; DIAPORIA at ${url}`);
  say(1, "research_purchase + compare_purchase_offers for the fictional Lumen Q3 (fixture catalog)");
  const research = await call("research_purchase", { request: "Buy Lumen Q3 Black wireless headphones, never exceed $150.", currency: "USD" });
  await call("compare_purchase_offers", { researchSessionId: research.purchaseSessionId, productIdentity: { brand: "Lumen", model: "Q3", variant: "Black", condition: "new", sku: "LUM-Q3-B" }, destination: { country: "US", region: "CA" } });
  say(2, "prepare_browser_checkout (off_lumen_q3) → recipe fills the merchant cart and stops before payment");
  const p = await call("prepare_browser_checkout", { purchaseSessionId: research.purchaseSessionId, offerId: "off_lumen_q3", quantity: 1, maximumApprovedTotalMinor: 12000, currency: "USD" });
  console.log(`   state=${p.state} subtotal=${p.capturedCart?.subtotalMinor} shipping=${p.capturedCart?.shippingMinor} tax=${p.capturedCart?.taxMinor} total=${p.capturedCart?.totalMinor} ${p.capturedCart?.displayedCurrency}`);
  console.log(`   merchant PayPal calls made by automation: ${JSON.stringify(merchant.mock!.calls)}`);
  say(3, `Human link (same for every host): ${p.humanAction.url}`);
  if (interactive) {
    console.log(`   Owner key for this demo run only: ${ownerKey}\n   Open the link, enter the key, set a maximum of at least $107.60, take over, press "PayPal (MOCK)", then "I'm done".`);
    for (;;) {
      await new Promise((r) => setTimeout(r, 2000));
      const st = await call("get_browser_checkout_status", { handoffId: p.handoffId });
      if (["ORDER_CONFIRMED", "ORDER_UNVERIFIED", "CANCELLED", "EXPIRED"].includes(st.state)) { console.log(`   final state ${st.state}`); break; }
    }
  } else {
    const post = async (form: Record<string, string>, cookie = "") => {
      const r = await fetch(p.humanAction.url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: url, ...(cookie ? { Cookie: cookie } : {}) }, body: new URLSearchParams(form).toString() });
      return { cookie: (r.headers.get("set-cookie") ?? "").split(";")[0] || cookie, html: await r.text() };
    };
    say(4, "Simulated human: owner key → maximum $110.00 → take over (automation paused)");
    const rv = await post({ action: "review", ownerKey });
    const csrf = /name="csrf" value="([^"]+)"/.exec(rv.html)![1]!;
    await post({ action: "maximum", maximum: "110.00", csrf }, rv.cookie);
    await post({ action: "takeover", csrf }, rv.cookie);
    say(5, `Simulated human presses the merchant's own button and ${cancel ? "cancels" : "approves"} in the merchant's MOCK popup (not PayPal)`);
    const { page, context } = (app.handoff!.fixtureSession(p.handoffId) as LocalFixtureSession).humanPage();
    const [popup] = await Promise.all([context.waitForEvent("page"), page.click("#paypal-button")]);
    await popup.waitForURL(/mock-paypal\/checkout/);
    if (cancel) { await Promise.all([popup.waitForEvent("close"), popup.click("#cancel").catch((e: unknown) => { if (!popup.isClosed()) throw e; })]); await page.waitForFunction(() => /cancelled/i.test(document.getElementById("pay-status")?.textContent ?? "")); }
    else await Promise.all([page.waitForURL(/order\/return/), popup.click("#approve")]);
    say(6, "Human clicks “I'm done” → read-only observation → HMAC-signed, nonce-bound seller status");
    await post({ action: "finish", csrf }, rv.cookie);
  }
  const st = await call("get_browser_checkout_status", { handoffId: p.handoffId });
  const merchantStatus = merchant.checkout.publicStatus(p.capturedCart.cartRef);
  const evidence = { evidenceClass: "C0_OFFLINE_MOCK", diaporiaState: st.state, sellerConfirmation: st.sellerConfirmation, merchantState: merchantStatus.state,
    merchantHistory: merchant.checkout.history(p.capturedCart.cartRef).map((x) => `${x.from}->${x.to}:${x.evidence}`), fulfillment: merchantStatus.fulfillment,
    capturedTotalMinor: p.capturedCart.totalMinor, merchantPayPalCalls: merchant.mock!.calls, diaporiaPayPalOrders: app.mockPayPal?.calls.createOrder ?? 0,
    diaporiaCreatedPaymentOrder: st.diaporiaCreatedPaymentOrder, paypalNetworkCalls: 0, kernelCalls: 0 };
  say(7, `Result: DIAPORIA=${st.state}, merchant=${merchantStatus.state}, fulfillment=${merchantStatus.fulfillment}`);
  console.log(JSON.stringify(evidence));
  const expected = cancel ? "CANCELLED" : "ORDER_CONFIRMED";
  if (!interactive && st.state !== expected) { console.error(`UNEXPECTED: wanted ${expected}`); exitCode = 1; }
} finally {
  await client.close();
  await new Promise<void>((r) => app.server.close(() => r()));
  await app.handoff?.shutdown().catch(() => undefined);
  await driver.shutdown(); await merchant.close();
}
process.exit(exitCode);
