/**
 * Phase C, C0 offline: DIAPORIA's existing browser handoff drives the Phase C test merchant (MOCK mode) in a real
 * local Chromium. Same recipe, same seller channel and same contract that KERNEL mode would use; the only
 * difference is the loopback origin and MOCK PayPal. No PayPal, no KERNEL, no network beyond 127.0.0.1.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalFixtureDriver, type BrowserDriver, type LocalFixtureSession } from "../src/handoff/drivers.js";
import { MerchantRecipeRegistry } from "../src/handoff/recipes.js";
import { SellerSourceRegistry } from "../src/handoff/sellerConfirmation.js";
import { PHASE_C_MERCHANT_DOMAIN, PhaseCSellerStatusSource, expectedDiaporiaOutcome, phaseCBrowserHosts, phaseCRecipe } from "../src/handoff/phaseCMerchant.js";
import { configureHandoffFromEnv, phaseCSellerSourcesFromEnv } from "../src/handoff/config.js";
import { fixtureRecipe } from "../src/handoff/fixtureMerchant.js";
import type { MerchantServer, MerchantServerOptions } from "../apps/phase-c-test-merchant/src/server.js";
import { signStatusBody } from "../apps/phase-c-test-merchant/src/server.js";
import { OWNER, startHarness, mcpClient, call, TOKENS, CA, type Harness } from "./helpers.js";
import { OwnerBrowser, closeSharedBrowser, sharedBrowser, startHandoffHarness } from "./handoff-helpers.js";
import { STATUS_SECRET, allowlistText, startMockMerchant } from "./phase-c-helpers.js";

const LUMEN = { brand: "Lumen", model: "Q3", variant: "Black", condition: "new", sku: "LUM-Q3-B" };
const TOTAL = 10760;

interface PhaseCHarness extends Harness { merchant: MerchantServer }
let h: PhaseCHarness | null = null;
afterEach(async () => { await h?.close(); h = null; });
afterAll(async () => { await closeSharedBrowser(); });
vi.setConfig({ testTimeout: 60_000 });
beforeAll(async () => { await sharedBrowser(); }, 120_000);

async function startPhaseC(o: Omit<MerchantServerOptions, "config"> & { seller?: "ok" | "none" | "wrong-secret" | "no-mock"; driver?: (d: BrowserDriver) => BrowserDriver;
  ttlMs?: number; takeoverTtlMs?: number; merchantEnv?: Record<string, string> } = {}): Promise<PhaseCHarness> {
  const { seller = "ok", driver, ttlMs, takeoverTtlMs, merchantEnv, ...merchantOpts } = o;
  const merchant = await startMockMerchant({ ...merchantOpts, ...(merchantEnv ? { env: merchantEnv } : {}) });
  const base = new LocalFixtureDriver(sharedBrowser);
  // "no-mock" = KERNEL-mode seller settings (https, MOCK evidence refused); the fake transport maps the https origin to loopback.
  const viaHttps = ((u: string, init?: RequestInit) => fetch(String(u).replace("https://phase-c.operator-shop.com", merchant.localUrl), init)) as typeof fetch;
  const sources = seller === "none" ? [] : [new PhaseCSellerStatusSource(seller === "no-mock"
    ? { origin: "https://phase-c.operator-shop.com", secret: STATUS_SECRET, acceptMockEvidence: false, fetchImpl: viaHttps }
    : { origin: merchant.origin, secret: seller === "wrong-secret" ? "x".repeat(40) : STATUS_SECRET, acceptMockEvidence: true })];
  const hh = await startHarness({ handoff: { driver: driver ? driver(base) : base, recipes: new MerchantRecipeRegistry([phaseCRecipe(merchant.origin, null)], { allowLoopbackOrigin: true }),
    sellers: new SellerSourceRegistry(sources), ...(ttlMs ? { handoffTtlMs: ttlMs } : {}), ...(takeoverTtlMs ? { takeoverTtlMs } : {}) } });
  return { ...hh, merchant, close: async () => { await hh.close(); await merchant.close(); } };
}

async function prepareLumen(hh: PhaseCHarness, extra: { maximumApprovedTotalMinor?: number; quantity?: number } = {}) {
  const client = await mcpClient(hh.url, TOKENS.alice);
  const research = await call(client, "research_purchase", { request: "Buy Lumen Q3 Black wireless headphones, never exceed $150.", currency: "USD" });
  await call(client, "compare_purchase_offers", { researchSessionId: research.purchaseSessionId, productIdentity: LUMEN, destination: CA });
  const prepared = await call(client, "prepare_browser_checkout", { purchaseSessionId: research.purchaseSessionId, offerId: "off_lumen_q3",
    quantity: extra.quantity ?? 1, maximumApprovedTotalMinor: extra.maximumApprovedTotalMinor ?? 12_000, currency: "USD" });
  return { client, research, prepared };
}

async function takeOver(hh: PhaseCHarness, handoffId: string, max = "110.00") {
  const owner = new OwnerBrowser(hh as any, handoffId);
  expect((await owner.review(OWNER.alice)).status).toBe(200);
  await owner.maximum(max);
  const t = await owner.takeover();
  expect(t.status).toBe(200);
  return owner;
}

const human = (hh: PhaseCHarness, id: string) => (hh.app.handoff!.fixtureSession(id) as LocalFixtureSession).humanPage();

/** The human presses the merchant's own button and acts in the merchant-owned MOCK popup. */
async function humanUsesMerchantButton(hh: PhaseCHarness, id: string, action: "approve" | "cancel" | "open-only") {
  const { page, context } = human(hh, id);
  const [popup] = await Promise.all([context.waitForEvent("page"), page.click("#paypal-button")]);
  await popup.waitForURL(/\/mock-paypal\/checkout/, { timeout: 15_000 }).catch(() => undefined);
  if (action === "approve") await Promise.all([page.waitForURL(/\/order\/return/, { timeout: 15_000 }), popup.click("#approve")]);
  else if (action === "cancel") { await Promise.all([popup.waitForEvent("close"), popup.click("#cancel").catch((e: unknown) => { if (!popup.isClosed()) throw e; })]); await page.waitForFunction(() => /cancelled/i.test(document.getElementById("pay-status")?.textContent ?? "")); }
  return { page, popup };
}

describe("Phase C MOCK end to end through DIAPORIA's unchanged handoff", () => {
  it("prepares the locked cart, stops before payment, hands off, and confirms only via the signed seller status", async () => {
    h = await startPhaseC();
    const { client, prepared } = await prepareLumen(h);
    expect(prepared.state).toBe("HUMAN_ACTION_REQUIRED");
    expect(prepared.capturedCart).toMatchObject({ title: "Lumen Q3 Wireless Headphones", variant: "Black", condition: "New", quantity: 1,
      subtotalMinor: 9500, shippingMinor: 500, taxMinor: 760, totalMinor: TOTAL, displayedCurrency: "USD", cartRef: expect.stringMatching(/^cart_/) });
    expect(prepared.constraints).toMatchObject({ violations: [], unknowns: [] });
    expect(prepared.humanAction).toMatchObject({ kind: "OPEN_HANDOFF_PAGE", authentication: "OWNER_KEY", url: `${h.url}/handoff/${prepared.handoffId}` });
    // Automation created no merchant PayPal order and DIAPORIA's own PayPal path was never used.
    expect(h.merchant.mock!.calls).toEqual({ create: 0, get: 0, capture: 0 });
    expect(h.mock.calls.createOrder + h.mock.calls.captureOrder).toBe(0);
    expect(JSON.stringify(prepared)).not.toMatch(/csrf|phc_sid|jwt=|live/i);

    const owner = await takeOver(h, prepared.handoffId);
    await humanUsesMerchantButton(h, prepared.handoffId, "approve");
    expect(h.merchant.mock!.calls.create).toBe(1);
    expect(h.merchant.mock!.calls.capture).toBe(1);
    expect((await owner.finish()).html).toContain("ORDER_CONFIRMED");
    const st = await call(client, "get_browser_checkout_status", { handoffId: prepared.handoffId });
    expect(st).toMatchObject({ state: "ORDER_CONFIRMED", orderStatus: "SELLER_CONFIRMED", diaporiaCreatedPaymentOrder: false, paymentEffect: "NONE_BY_DIAPORIA",
      sellerConfirmation: { status: "CONFIRMED", source: "PHASE_C_MERCHANT_SIGNED_STATUS_MOCK_ALLOWED", totalMinor: TOTAL, problem: null } });
    expect(st.observation.pageClaimsConfirmation).toBe(true);
    expect(h.mock.calls.createOrder + h.mock.calls.captureOrder).toBe(0);
  });

  it("returns the same host-neutral contract shape as the existing fixture merchant", async () => {
    const shape = (v: unknown): unknown => Array.isArray(v) ? v.map(shape) : v && typeof v === "object"
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, shape(x)])) : typeof v;
    h = await startPhaseC();
    const phaseC = (await prepareLumen(h)).prepared;
    await h.close(); h = null;
    const fx = await startHandoffHarness();
    try {
      const client = await mcpClient(fx.url, TOKENS.alice);
      const research = await call(client, "research_purchase", { request: "Buy Sony WH-CH720N Black, never exceed $100", currency: "USD" });
      await call(client, "compare_purchase_offers", { researchSessionId: research.purchaseSessionId, productIdentity: { brand: "Sony", model: "WH-CH720N", variant: "Black", condition: "new", sku: "WHCH720N/B" }, destination: CA });
      const bravo = await call(client, "prepare_browser_checkout", { purchaseSessionId: research.purchaseSessionId, offerId: "off_bravo", quantity: 1, maximumApprovedTotalMinor: 8000, currency: "USD" });
      expect(JSON.stringify(shape(phaseC))).toBe(JSON.stringify(shape(bravo)));
    } finally { await fx.close(); }
  });
});

describe("Phase C MOCK: constraint failures HOLD with no handoff", () => {
  it("variant substitution → VARIANT_MISMATCH", async () => {
    h = await startPhaseC({ storeKnobs: { extraVariants: ["Silver"], substituteVariant: "Silver" } });
    const { prepared } = await prepareLumen(h);
    expect(prepared.state).toBe("HOLD");
    expect(prepared.constraints.violations).toContain("VARIANT_MISMATCH");
    expect(prepared.humanAction).toBeNull();
  });
  it("displayed quantity differs → QUANTITY_MISMATCH; a quantity the merchant does not sell → PREPARATION_FAILED", async () => {
    h = await startPhaseC({ storeKnobs: { displayQuantityOverride: 2 } });
    expect((await prepareLumen(h)).prepared.constraints.violations).toContain("QUANTITY_MISMATCH");
    await h.close();
    h = await startPhaseC();
    const two = (await prepareLumen(h, { quantity: 2 })).prepared;
    expect(two.state).toBe("HOLD");
    expect(two.failure.code).toBe("PREPARATION_FAILED");
  });
  it("amount above the owner's maximum → AMOUNT_EXCEEDED; the owner page cannot take over below the cart total", async () => {
    h = await startPhaseC();
    const { prepared } = await prepareLumen(h, { maximumApprovedTotalMinor: 10_000 });
    expect(prepared.state).toBe("HOLD");
    expect(prepared.constraints.violations).toEqual(["AMOUNT_EXCEEDED"]);
    const owner = new OwnerBrowser(h as any, prepared.handoffId);
    await owner.review(OWNER.alice);
    expect((await owner.maximum("107.59")).html).toContain("AMOUNT_EXCEEDED");
    expect((await owner.takeover()).status).toBe(409);
    expect(h.merchant.mock!.calls.create).toBe(0);
  });
  it("owner maximum is the binding limit even when the assistant asked for more", async () => {
    h = await startPhaseC();
    const { prepared } = await prepareLumen(h, { maximumApprovedTotalMinor: 12_000 });
    const owner = new OwnerBrowser(h as any, prepared.handoffId);
    await owner.review(OWNER.alice);
    expect((await owner.maximum("100.00")).html).toContain("AMOUNT_EXCEEDED");
  });
  it("unknown shipping and tax are reported as unknowns (V0 rule: only an unknown TOTAL holds)", async () => {
    h = await startPhaseC({ hideShipping: true, hideTax: true });
    const { prepared } = await prepareLumen(h);
    expect(prepared.capturedCart).toMatchObject({ shippingMinor: null, taxMinor: null, totalMinor: TOTAL });
    expect(prepared.constraints.unknowns).toEqual(expect.arrayContaining(["shipping", "tax"]));
    // Known limitation documented in docs/PHASE_C_TEST_MERCHANT.md: the handoff proceeds because the total is displayed.
    expect(prepared.state).toBe("HUMAN_ACTION_REQUIRED");
  });
  it("prompt-injection text in the product description has no effect", async () => {
    h = await startPhaseC({ injection: true });
    const { prepared } = await prepareLumen(h);
    expect(prepared.state).toBe("HUMAN_ACTION_REQUIRED");
    expect(prepared.quantity).toBe(1);
    expect(h.merchant.mock!.calls).toEqual({ create: 0, get: 0, capture: 0 });
  });
  it("a recipe step aimed at the merchant's PayPal button is refused before and during automation", async () => {
    const r = phaseCRecipe("http://127.0.0.1:1", null);
    expect(() => new MerchantRecipeRegistry([{ ...r, steps: [...r.steps, { action: "click", selector: "#paypal-button" }] }], { allowLoopbackOrigin: true })).toThrow(/RECIPE_TARGETS_PAYMENT_CONTROL/);
  });
});

describe("Phase C MOCK: honest outcomes after takeover", () => {
  it("browser return without payment → seller reports no order → CANCELLED (never confirmed)", async () => {
    h = await startPhaseC();
    const { client, prepared } = await prepareLumen(h);
    const owner = await takeOver(h, prepared.handoffId);
    const { page } = human(h, prepared.handoffId);
    await page.goto(`${h.merchant.origin}/order/return?cart=${prepared.capturedCart.cartRef}`);
    await owner.finish();
    const st = await call(client, "get_browser_checkout_status", { handoffId: prepared.handoffId });
    expect(st.state).toBe("CANCELLED");
    expect(st.failure.code).toBe("SELLER_REPORTS_NO_ORDER");
    expect(st.observation.pageClaimsConfirmation).toBe(false);
  });
  it("buyer cancels in the popup → ORDER_CANCELLED at the merchant → CANCELLED", async () => {
    h = await startPhaseC();
    const { client, prepared } = await prepareLumen(h);
    const owner = await takeOver(h, prepared.handoffId);
    await humanUsesMerchantButton(h, prepared.handoffId, "cancel");
    await owner.finish();
    expect((await call(client, "get_browser_checkout_status", { handoffId: prepared.handoffId })).state).toBe("CANCELLED");
    expect(h.merchant.checkout.publicStatus(prepared.capturedCart.cartRef).state).toBe("ORDER_CANCELLED");
  });
  it("payment approved but not captured → ORDER_UNVERIFIED (MERCHANT_STATE_BUYER_APPROVED)", async () => {
    h = await startPhaseC({ storeKnobs: { neverCapture: true } });
    const { client, prepared } = await prepareLumen(h);
    const owner = await takeOver(h, prepared.handoffId);
    await humanUsesMerchantButton(h, prepared.handoffId, "approve");
    await owner.finish();
    const st = await call(client, "get_browser_checkout_status", { handoffId: prepared.handoffId });
    expect(st).toMatchObject({ state: "ORDER_UNVERIFIED", failure: { code: "MERCHANT_STATE_BUYER_APPROVED" }, sellerConfirmation: { status: "UNKNOWN" } });
  });
  it.each([["PENDING", "MERCHANT_STATE_CAPTURE_PENDING"], ["DECLINED", "MERCHANT_STATE_PAYMENT_DENIED"], ["TIMEOUT", "MERCHANT_STATE_ORDER_UNKNOWN"]] as const)(
    "mock capture %s → ORDER_UNVERIFIED (%s)", async (outcome, code) => {
      h = await startPhaseC({ mockKnobs: { captureOutcome: outcome } });
      const { client, prepared } = await prepareLumen(h);
      const owner = await takeOver(h, prepared.handoffId);
      await humanUsesMerchantButton(h, prepared.handoffId, "approve");
      await owner.finish();
      const st = await call(client, "get_browser_checkout_status", { handoffId: prepared.handoffId });
      expect(st.state).toBe("ORDER_UNVERIFIED");
      expect(st.failure.code).toBe(code);
    });
  it("seller recipient mismatch → no payable order → ORDER_UNVERIFIED (MERCHANT_STATE_ORDER_UNKNOWN)", async () => {
    h = await startPhaseC({ mockKnobs: { payeeOverride: "SOMEONEELSE1" } });
    const { client, prepared } = await prepareLumen(h);
    const owner = await takeOver(h, prepared.handoffId);
    const { page } = human(h, prepared.handoffId);
    await page.click("#paypal-button");
    await page.waitForFunction(() => /PAYEE_MISMATCH/.test(document.getElementById("pay-status")?.textContent ?? ""));
    await owner.finish();
    const st = await call(client, "get_browser_checkout_status", { handoffId: prepared.handoffId });
    expect(st.state).toBe("ORDER_UNVERIFIED");
    expect(st.failure.code).toBe("MERCHANT_STATE_ORDER_UNKNOWN");
  });
  it("without a configured seller integration the best outcome is ORDER_UNVERIFIED, even after payment", async () => {
    h = await startPhaseC({ seller: "none" });
    const { client, prepared } = await prepareLumen(h);
    const owner = await takeOver(h, prepared.handoffId);
    await humanUsesMerchantButton(h, prepared.handoffId, "approve");
    await owner.finish();
    const st = await call(client, "get_browser_checkout_status", { handoffId: prepared.handoffId });
    expect(st.state).toBe("ORDER_UNVERIFIED");
    expect(st.observation.discrepancies).toEqual(expect.arrayContaining(["NO_AUTHORITATIVE_SELLER_SOURCE_FOR_MERCHANT", "PAGE_CLAIMS_CONFIRMATION_WITHOUT_SELLER_CONFIRMATION"]));
  });
  it("seller confirmation spoofing: wrong secret, unsigned status, or MOCK evidence where Sandbox is required → ORDER_UNVERIFIED", async () => {
    for (const [seller, env, problem] of [["wrong-secret", undefined, "SIGNATURE_INVALID"], ["ok", { MERCHANT_STATUS_SECRET: "" }, "SIGNATURE_MISSING"], ["no-mock", undefined, "MOCK_EVIDENCE_NOT_ACCEPTED"]] as const) {
      h = await startPhaseC({ seller, ...(env ? { merchantEnv: env } : {}) });
      const { client, prepared } = await prepareLumen(h);
      const owner = await takeOver(h, prepared.handoffId);
      await humanUsesMerchantButton(h, prepared.handoffId, "approve");
      await owner.finish();
      const st = await call(client, "get_browser_checkout_status", { handoffId: prepared.handoffId });
      expect(st.state, seller).toBe("ORDER_UNVERIFIED");
      expect(st.sellerConfirmation.problem, seller).toBe(problem);
      expect(h.merchant.checkout.publicStatus(prepared.capturedCart.cartRef).state).toBe("ORDER_CONFIRMED"); // merchant did confirm; DIAPORIA refuses unauthenticated proof
      await h.close(); h = null;
    }
  });
});

describe("Phase C MOCK: browser lifecycle failures", () => {
  it("browser expiry while the human is in the PayPal popup → observed, ORDER_UNVERIFIED, never EXPIRED", async () => {
    h = await startPhaseC({ takeoverTtlMs: 60_000 });
    const { client, prepared } = await prepareLumen(h);
    await takeOver(h, prepared.handoffId);
    await humanUsesMerchantButton(h, prepared.handoffId, "open-only");
    h.clock.offsetMs = 61_000;
    const st = await call(client, "get_browser_checkout_status", { handoffId: prepared.handoffId });
    expect(st.state).toBe("ORDER_UNVERIFIED");
    expect(st.observation.reason).toBe("TAKEOVER_TIMEOUT");
    expect(st.failure.code).toBe("MERCHANT_STATE_ORDER_CREATED");
  });
  it("browser deletion failure is never reported as cleanup: error + HANDOFF_CLEANUP_UNVERIFIED audit, state unchanged", async () => {
    let failClose = false;
    const opened: Array<() => Promise<void>> = [];
    h = await startPhaseC({ driver: (d) => ({ name: d.name, live: d.live, open: async (o) => { const s = await d.open(o); const close = s.close.bind(s); opened.push(close);
      (s as { close(): Promise<void> }).close = async () => { if (failClose) throw new Error("DELETE 502"); return close(); }; return s; } }) });
    const { client, prepared } = await prepareLumen(h);
    failClose = true;
    const owner = new OwnerBrowser(h as any, prepared.handoffId);
    await owner.review(OWNER.alice);
    const c = await owner.cancel();
    expect(c.status).toBe(409);
    expect(c.html).toContain("PROVIDER_ERROR");
    expect(c.html).not.toContain("nothing was paid");
    const st = await call(client, "get_browser_checkout_status", { handoffId: prepared.handoffId });
    expect(st.state).toBe("HUMAN_ACTION_REQUIRED");
    const audit = h.app.store.db.prepare("SELECT type FROM audit_events WHERE subject_id = ?").all(prepared.handoffId);
    expect(JSON.stringify(audit)).toContain("HANDOFF_CLEANUP_UNVERIFIED");
    // Operator recovery: once deletion works again the retry succeeds and only then is the handoff CANCELLED.
    failClose = false;
    expect((await owner.cancel()).html).toContain("CANCELLED");
    await Promise.all(opened.map((f) => f().catch(() => undefined)));
  });
});

describe("Phase C seller status source (unit, fake transport)", () => {
  const cartRef = `cart_${"a".repeat(24)}`;
  const signedFetch = (mutate: (j: any, nonce: string) => any, secret = STATUS_SECRET) => (async (u: string) => {
    const nonce = new URL(String(u)).searchParams.get("nonce")!;
    const body = JSON.stringify(mutate({ v: 1, merchantDomain: PHASE_C_MERCHANT_DOMAIN, nonce, issuedAt: new Date().toISOString(), sellerStatus: "CONFIRMED", cartRef,
      mode: "SANDBOX_APPROVAL_TEST", evidenceSource: "PAYPAL_SANDBOX_ORDERS_V2_SERVER_SIDE", fulfillment: "NOT_VERIFIED", sandboxOnly: true, state: "ORDER_CONFIRMED", known: true,
      orderRef: "PHC-1", sku: "LUM-Q3-B", quantity: 1, currency: "USD", totalMinor: TOTAL, payeeVerified: true }, nonce));
    return new Response(body, { headers: { "X-Merchant-Signature": signStatusBody(secret, body) } });
  }) as typeof fetch;
  const src = (f: typeof fetch) => new PhaseCSellerStatusSource({ origin: "https://phase-c.operator-shop.com", secret: STATUS_SECRET, acceptMockEvidence: false, fetchImpl: f });

  it("accepts a fresh, nonce-bound, signed Sandbox confirmation", async () => {
    expect(await src(signedFetch((j) => j)).lookup(cartRef)).toMatchObject({ status: "CONFIRMED", totalMinor: TOTAL, sku: "LUM-Q3-B", problem: null });
  });
  it.each([
    ["replayed response (old nonce)", (j: any) => ({ ...j, nonce: "replayed-old-nonce-000" }), "NONCE_MISMATCH"],
    ["stale response", (j: any) => ({ ...j, issuedAt: new Date(Date.now() - 5 * 60_000).toISOString() }), "STATUS_STALE"],
    ["other merchant", (j: any) => ({ ...j, merchantDomain: "alpha-audio.example" }), "MERCHANT_DOMAIN_MISMATCH"],
    ["other cart", (j: any) => ({ ...j, cartRef: `cart_${"b".repeat(24)}` }), "CART_REF_MISMATCH"],
    ["payee not verified", (j: any) => ({ ...j, payeeVerified: false }), "PAYEE_NOT_VERIFIED"],
    ["summary says CONFIRMED but state is PENDING", (j: any) => ({ ...j, state: "CAPTURE_PENDING" }), "MERCHANT_STATE_CAPTURE_PENDING"],
    ["MOCK evidence", (j: any) => ({ ...j, evidenceSource: "MOCK_PAYPAL_IN_PROCESS" }), "MOCK_EVIDENCE_NOT_ACCEPTED"],
    ["fulfillment claimed", (j: any) => ({ ...j, fulfillment: "SHIPPED" }), "STATUS_SHAPE_INVALID"],
  ])("rejects %s", async (_n, mutate, problem) => {
    expect(await src(signedFetch(mutate)).lookup(cartRef)).toMatchObject({ status: "UNKNOWN", problem });
  });
  it("rejects a forged signature and an unreachable seller", async () => {
    expect((await src(signedFetch((j) => j, "y".repeat(40))).lookup(cartRef)).problem).toBe("SIGNATURE_INVALID");
    expect((await src((async () => { throw new Error("down"); }) as typeof fetch).lookup(cartRef)).problem).toBe("SELLER_UNREACHABLE");
  });
  it("refuses http seller origins unless explicitly MOCK on loopback, and short secrets", () => {
    expect(() => new PhaseCSellerStatusSource({ origin: "http://phase-c.operator-shop.com", secret: STATUS_SECRET, acceptMockEvidence: false })).toThrow(/https/);
    expect(() => new PhaseCSellerStatusSource({ origin: "https://phase-c.operator-shop.com", secret: "short", acceptMockEvidence: false })).toThrow(/32/);
    expect(JSON.stringify(src(signedFetch((j) => j)))).not.toContain(STATUS_SECRET);
  });
});

describe("Phase C KERNEL recipe and network allowlist (offline validation only)", () => {
  const origin = "https://phase-c.operator-shop.com";
  it("the reviewed recipe validates for KERNEL with exactly merchant + Sandbox hosts", () => {
    const r = phaseCRecipe(origin, phaseCBrowserHosts(allowlistText()));
    expect(r.networkAllowedHosts).toEqual(["phase-c.operator-shop.com", "www.sandbox.paypal.com"]);
    expect(r.paymentHosts).toEqual(["www.sandbox.paypal.com"]);
    expect(() => new MerchantRecipeRegistry([r], { allowLoopbackOrigin: false })).not.toThrow();
  });
  it.each([
    ["missing allowlist", null, "RECIPE_EGRESS_ALLOWLIST_REQUIRED"],
    ["empty allowlist", [], "RECIPE_EGRESS_REQUIRED_HOST_MISSING"],
    ["wildcard", ["*.paypal.com"], "RECIPE_EGRESS_HOST_INVALID"],
    ["IP literal", ["198.51.100.7"], "RECIPE_EGRESS_HOST_INVALID"],
    ["PayPal host missing", ["www.paypalobjects.com"], "RECIPE_EGRESS_REQUIRED_HOST_MISSING"],
  ])("rejects %s", (_n, hosts, code) => {
    let r = phaseCRecipe(origin, hosts as string[] | null);
    if (Array.isArray(hosts) && hosts.length === 0) r = { ...r, networkAllowedHosts: [] };
    const expected = Array.isArray(hosts) && hosts.length === 0 ? /RECIPE_EGRESS_ALLOWLIST_REQUIRED|RECIPE_EGRESS_REQUIRED_HOST_MISSING/ : new RegExp(code);
    expect(() => new MerchantRecipeRegistry([r], { allowLoopbackOrigin: false })).toThrow(expected);
  });
  it("KERNEL mode refuses a Phase C recipe without an allowlist before any provider call", async () => {
    const dir = mkdtempSync(join(tmpdir(), "phc-recipe-"));
    const file = join(dir, "recipes.json");
    writeFileSync(file, JSON.stringify([phaseCRecipe(origin, null)]));
    const spy = vi.spyOn(globalThis, "fetch");
    await expect(configureHandoffFromEnv({ HANDOFF_DRIVER: "kernel", DIAPORIA_ALLOW_KERNEL_LIVE: "1", KERNEL_API_KEY: "test-not-a-key", HANDOFF_RECIPES_FILE: file })).rejects.toThrow(/RECIPE_EGRESS_ALLOWLIST_REQUIRED/);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
  it("KERNEL seller source must match the reviewed recipe origin and come with its secret", () => {
    const reg = new MerchantRecipeRegistry([phaseCRecipe(origin, phaseCBrowserHosts(allowlistText()))], { allowLoopbackOrigin: false });
    expect(phaseCSellerSourcesFromEnv({}, reg)).toEqual([]);
    expect(() => phaseCSellerSourcesFromEnv({ PHASE_C_SELLER_ORIGIN: origin }, reg)).toThrow(/together/);
    expect(() => phaseCSellerSourcesFromEnv({ PHASE_C_SELLER_ORIGIN: "https://other-shop.com", PHASE_C_SELLER_STATUS_SECRET: STATUS_SECRET }, reg)).toThrow(/recipe origin/);
    const [s] = phaseCSellerSourcesFromEnv({ PHASE_C_SELLER_ORIGIN: origin, PHASE_C_SELLER_STATUS_SECRET: STATUS_SECRET }, reg);
    expect(s!.name).toBe("PHASE_C_MERCHANT_SIGNED_STATUS"); // MOCK evidence never accepted in KERNEL mode
  });
  it("the offline fixture recipe is untouched", () => { expect(fixtureRecipe("http://127.0.0.1:1").recipeId).toBe("fixture-bravo-v0"); });
});

describe("C3 consistency rule", () => {
  it("never maps PENDING, APPROVED-not-captured, DENIED or UNKNOWN to success", () => {
    for (const s of ["ORDER_CREATED", "BUYER_APPROVED", "CAPTURE_PENDING", "PAYMENT_COMPLETED", "PAYMENT_DENIED", "ORDER_UNKNOWN"]) expect(expectedDiaporiaOutcome(s, true)).toBe("ORDER_UNVERIFIED");
    expect(expectedDiaporiaOutcome("ORDER_CONFIRMED", true)).toBe("ORDER_CONFIRMED");
    expect(expectedDiaporiaOutcome("ORDER_CANCELLED", true)).toBe("CANCELLED");
    expect(expectedDiaporiaOutcome("ORDER_CONFIRMED", false)).toBe("ORDER_UNVERIFIED");
  });
});
