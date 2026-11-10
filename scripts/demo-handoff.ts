/**
 * OFFLINE demo of the browser checkout handoff (Phase A). No PayPal, no KERNEL, no network beyond 127.0.0.1.
 *
 *   npm run demo:handoff                 # simulated human, headless
 *   npm run demo:handoff -- --headed     # watch the merchant browser
 *   npm run demo:handoff -- --interactive  # YOU are the human: open the printed link, enter the printed owner key,
 *                                          set a maximum, take over, press the fixture's PayPal button, approve in
 *                                          the popup, then click "I'm done" on the handoff page
 */
import type { AddressInfo } from "node:net";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/http/server.js";
import { ALL_CLIENT_SCOPES, DevAuth, randomSecret } from "../src/auth/devAuth.js";
import { LocalFixtureDriver, launchLocalChromium, type LocalFixtureSession } from "../src/handoff/drivers.js";
import { MerchantRecipeRegistry } from "../src/handoff/recipes.js";
import { HmacFixtureSellerSource, SellerSourceRegistry } from "../src/handoff/sellerConfirmation.js";
import { FIXTURE_MERCHANT_DOMAIN, fixtureRecipe, startFixtureMerchant } from "../src/handoff/fixtureMerchant.js";

const interactive = process.argv.includes("--interactive");
const headed = interactive || process.argv.includes("--headed");
const say = (n: number, s: string) => console.log(`\n${n}. ${s}`);

const merchant = await startFixtureMerchant();
const driver = new LocalFixtureDriver(() => launchLocalChromium({ headless: !headed }));
const token = randomSecret("dct"), ownerKey = randomSecret("dok");
const auth = new DevAuth(); auth.addClientToken(token, "demo-user", ALL_CLIENT_SCOPES); auth.addOwnerKey(ownerKey, "demo-user");
const probe = createServer(); await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
const port = (probe.address() as AddressInfo).port; await new Promise<void>((r) => probe.close(() => r()));
const url = `http://127.0.0.1:${port}`;
const app = createApp({ host: "127.0.0.1", port, baseUrl: url, authMode: "dev", dbPath: ":memory:", auth,
  handoff: { driver, recipes: new MerchantRecipeRegistry([fixtureRecipe(merchant.origin)], { allowLoopbackOrigin: true }),
    sellers: new SellerSourceRegistry([new HmacFixtureSellerSource(FIXTURE_MERCHANT_DOMAIN, merchant.origin, merchant.secret)]) } });
await new Promise<void>((r) => app.server.listen(port, "127.0.0.1", r));

const client = new Client({ name: "diaporia-handoff-demo", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
await client.listTools();
const call = async (name: string, args: Record<string, unknown>) => { const r = await client.callTool({ name, arguments: args }); if (r.isError) throw new Error(JSON.stringify(r.content)); return r.structuredContent as any; };

try {
  say(1, "research_purchase + compare_purchase_offers (fixture catalog)");
  const research = await call("research_purchase", { request: "Buy Sony WH-CH720N Black, never exceed $80", currency: "USD" });
  await call("compare_purchase_offers", { researchSessionId: research.purchaseSessionId, productIdentity: { brand: "Sony", model: "WH-CH720N", variant: "Black", condition: "new", sku: "WHCH720N/B" }, destination: { country: "US", region: "CA" } });
  say(2, "prepare_browser_checkout on the EXTERNAL offer off_bravo → the browser fills the merchant cart and stops before payment");
  const p = await call("prepare_browser_checkout", { purchaseSessionId: research.purchaseSessionId, offerId: "off_bravo", quantity: 1, maximumApprovedTotalMinor: 8000, currency: "USD" });
  console.log(`   state=${p.state}  displayed total=${p.capturedCart.totalMinor}  unknowns=${p.constraints.unknowns.join(",") || "none"}  violations=${p.constraints.violations.join(",") || "none"}`);
  console.log(`   merchant payment endpoints touched by automation: popup=${merchant.hits.paymentPopup} approve=${merchant.hits.paymentApprove} placeOrder=${merchant.hits.placeOrder}`);
  say(3, `Human link (what every host shows): ${p.humanAction.url}`);

  if (interactive) {
    console.log(`   Owner key for this demo run only: ${ownerKey}\n   Waiting for you to finish (Ctrl+C to stop)…`);
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
    say(4, "Simulated human: owner key → set maximum $60.00 → take over");
    const rv = await post({ action: "review", ownerKey });
    const csrf = /name="csrf" value="([^"]+)"/.exec(rv.html)![1]!;
    await post({ action: "maximum", maximum: "60.00", csrf }, rv.cookie);
    await post({ action: "takeover", csrf }, rv.cookie);
    console.log(`   status: ${(await call("get_browser_checkout_status", { handoffId: p.handoffId })).state} (automation paused)`);
    say(5, "Simulated human presses the merchant's own PayPal button and approves in the MOCK popup");
    const { page, context } = (app.handoff!.fixtureSession(p.handoffId) as LocalFixtureSession).humanPage();
    const [popup] = await Promise.all([context.waitForEvent("page"), page.click("#paypal-button")]);
    await Promise.all([page.waitForURL(/order\/confirmation/), popup.click("#approve")]);
    say(6, "Human clicks “I'm done” → read-only observation → signed seller-side order check");
    await post({ action: "finish", csrf }, rv.cookie);
    const st = await call("get_browser_checkout_status", { handoffId: p.handoffId });
    console.log(`   state=${st.state}  seller=${st.sellerConfirmation?.status} ${st.sellerConfirmation?.orderRef ?? ""}  pageClaimsConfirmation=${st.observation.pageClaimsConfirmation}`);
    console.log(`   DIAPORIA PayPal orders created: ${app.mockPayPal?.calls.createOrder ?? 0}`);
  }
  console.log("\nDone. Offline fixture only: no PayPal, no KERNEL, no real merchant.");
} finally {
  await client.close();
  await new Promise<void>((r) => app.server.close(() => r()));
  await driver.shutdown(); await merchant.close();
}
