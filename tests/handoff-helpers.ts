import type { Browser } from "playwright-core";
import { startHarness, mcpClient, call, TOKENS, SONY_BLACK, CA, type Harness } from "./helpers.js";
import { LocalFixtureDriver, launchLocalChromium, type LocalFixtureSession, type BrowserDriver } from "../src/handoff/drivers.js";
import { MerchantRecipeRegistry, type MerchantCheckoutRecipe } from "../src/handoff/recipes.js";
import { HmacFixtureSellerSource, SellerSourceRegistry } from "../src/handoff/sellerConfirmation.js";
import { FIXTURE_MERCHANT_DOMAIN, fixtureRecipe, startFixtureMerchant, type FixtureMerchant, type FixtureMerchantOptions } from "../src/handoff/fixtureMerchant.js";

let shared: Promise<Browser> | null = null;
export function sharedBrowser(): Promise<Browser> { return (shared ??= launchLocalChromium({ headless: true })); }
export async function closeSharedBrowser() { if (shared) await (await shared).close().catch(() => undefined); shared = null; }

export interface HandoffHarness extends Harness { merchant: FixtureMerchant; driver: BrowserDriver }

export async function startHandoffHarness(opts: { merchant?: FixtureMerchantOptions; recipe?: (origin: string) => MerchantCheckoutRecipe; driver?: (m: FixtureMerchant) => BrowserDriver;
  ttlMs?: number; takeoverTtlMs?: number; noSeller?: boolean } = {}): Promise<HandoffHarness> {
  const merchant = await startFixtureMerchant(opts.merchant);
  const driver = opts.driver ? opts.driver(merchant) : new LocalFixtureDriver(sharedBrowser);
  const recipe = (opts.recipe ?? fixtureRecipe)(merchant.origin);
  const h = await startHarness({ handoff: {
    driver, recipes: new MerchantRecipeRegistry([recipe], { allowLoopbackOrigin: true }),
    sellers: new SellerSourceRegistry(opts.noSeller ? [] : [new HmacFixtureSellerSource(FIXTURE_MERCHANT_DOMAIN, merchant.origin, merchant.secret)]),
    ...(opts.ttlMs ? { handoffTtlMs: opts.ttlMs } : {}), ...(opts.takeoverTtlMs ? { takeoverTtlMs: opts.takeoverTtlMs } : {}),
  } });
  return { ...h, merchant, driver, close: async () => { await h.close(); await merchant.close(); } };
}

/** research → compare → prepare_browser_checkout on the external fixture offer (off_bravo). */
export async function prepareBravo(h: HandoffHarness, token = TOKENS.alice, extra: { maximumApprovedTotalMinor?: number; quantity?: number } = {}) {
  const client = await mcpClient(h.url, token);
  const research = await call(client, "research_purchase", { request: "Buy Sony WH-CH720N Black for the lowest total price, but never exceed $100.", currency: "USD" });
  await call(client, "compare_purchase_offers", { researchSessionId: research.purchaseSessionId, productIdentity: SONY_BLACK, destination: CA });
  const prepared = await call(client, "prepare_browser_checkout", { purchaseSessionId: research.purchaseSessionId, offerId: "off_bravo",
    quantity: extra.quantity ?? 1, maximumApprovedTotalMinor: extra.maximumApprovedTotalMinor ?? 8000, currency: "USD" });
  return { client, research, prepared };
}

/** Plays the human on the owner-authenticated handoff page (cookie + CSRF), like a browser would. */
export class OwnerBrowser {
  cookie = ""; csrf = "";
  constructor(private readonly h: HandoffHarness, readonly handoffId: string) {}
  private async post(form: Record<string, string>) {
    const r = await fetch(`${this.h.url}/handoff/${this.handoffId}`, { method: "POST", redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded", ...(this.cookie ? { Cookie: this.cookie } : {}), Origin: this.h.url },
      body: new URLSearchParams(form).toString() });
    const setCookie = r.headers.get("set-cookie");
    if (setCookie) this.cookie = setCookie.split(";")[0]!;
    const html = await r.text();
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
    if (csrf) this.csrf = csrf;
    return { status: r.status, html, csp: r.headers.get("content-security-policy") ?? "" };
  }
  review(ownerKey: string) { return this.post({ action: "review", ownerKey }); }
  maximum(amount: string) { return this.post({ action: "maximum", maximum: amount, csrf: this.csrf }); }
  takeover() { return this.post({ action: "takeover", csrf: this.csrf }); }
  finish() { return this.post({ action: "finish", csrf: this.csrf }); }
  cancel() { return this.post({ action: "cancel", csrf: this.csrf }); }
}

export function humanPage(h: HandoffHarness, handoffId: string) {
  return (h.app.handoff!.fixtureSession(handoffId) as LocalFixtureSession).humanPage();
}

/** The human presses the merchant's own PayPal button and approves (or cancels) in the popup. */
export async function humanPaysInPopup(h: HandoffHarness, handoffId: string, action: "approve" | "cancel") {
  const { page, context } = humanPage(h, handoffId);
  const [popup] = await Promise.all([context.waitForEvent("page"), page.click("#paypal-button")]);
  await popup.waitForLoadState("domcontentloaded");
  if (action === "approve") {
    await Promise.all([page.waitForURL(/\/order\/confirmation/), popup.click("#approve")]);
  } else {
    await Promise.all([popup.waitForEvent("close"), popup.click("#cancel")]);
  }
  return { page };
}

export { TOKENS, SONY_BLACK, CA, mcpClient, call };
