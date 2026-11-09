/**
 * Phase A — offline fixture. A real local Chromium drives a synthetic merchant whose "PayPal" button opens a MOCK
 * payment popup. No PayPal, no KERNEL, no network beyond 127.0.0.1.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { callError } from "./helpers.js";
import { OWNER } from "./helpers.js";
import { AutomationPausedError } from "../src/handoff/drivers.js";
import { fixtureRecipe } from "../src/handoff/fixtureMerchant.js";
import { OwnerBrowser, TOKENS, call, closeSharedBrowser, humanPage, humanPaysInPopup, mcpClient, prepareBravo, startHandoffHarness, type HandoffHarness } from "./handoff-helpers.js";

let h: HandoffHarness | null = null;
afterEach(async () => { await h?.close(); h = null; });
afterAll(async () => { await closeSharedBrowser(); });

const EXPECTED_TOTAL = 4999 + 599 + 400; // item + shipping + 8% tax (rounded) as displayed by the fixture

describe("Phase A: cart preparation stops before payment", () => {
  it("prepares the exact product, captures the displayed cart and never touches a payment control", async () => {
    h = await startHandoffHarness();
    const { prepared } = await prepareBravo(h);
    expect(prepared.state).toBe("HUMAN_ACTION_REQUIRED");
    expect(prepared.checkoutPath).toBe("BROWSER_CHECKOUT_HANDOFF");
    expect(prepared.capturedCart).toMatchObject({ title: expect.stringContaining("WH-CH720N"), variant: "Black", condition: "New", quantity: 1,
      subtotalMinor: 4999, shippingMinor: 599, taxMinor: 400, totalMinor: EXPECTED_TOTAL, displayedCurrency: "USD", provenance: "MERCHANT_PAGE_AS_DISPLAYED" });
    expect(prepared.constraints.violations).toEqual([]);
    expect(prepared.humanAction).toMatchObject({ kind: "OPEN_HANDOFF_PAGE", authentication: "OWNER_KEY", url: `${h.url}/handoff/${prepared.handoffId}` });
    expect(prepared.paymentEffect).toBe("NONE_BY_DIAPORIA");
    expect(prepared.diaporiaCreatedPaymentOrder).toBe(false);
    expect(h.merchant.hits).toMatchObject({ addToCart: 1, paymentPopup: 0, paymentApprove: 0, placeOrder: 0 });
    // The direct PayPal path was not used: no DIAPORIA PayPal order exists.
    expect(h.mock.calls.createOrder).toBe(0);
  });

  it("is idempotent for the same offer and quantity", async () => {
    h = await startHandoffHarness();
    const { client, research, prepared } = await prepareBravo(h);
    const again = await call(client, "prepare_browser_checkout", { purchaseSessionId: research.purchaseSessionId, offerId: "off_bravo", quantity: 1, maximumApprovedTotalMinor: 8000, currency: "USD" });
    expect(again.handoffId).toBe(prepared.handoffId);
    expect(again.deduplicated).toBe(true);
    expect(h.merchant.hits.addToCart).toBe(1);
  });

  it("refuses non-external offers and offers from merchants without a recipe", async () => {
    h = await startHandoffHarness();
    const client = await mcpClient(h.url, TOKENS.alice);
    const research = await call(client, "research_purchase", { request: "Buy Sony WH-CH720N Black for the lowest total price, but never exceed $100.", currency: "USD" });
    await call(client, "compare_purchase_offers", { researchSessionId: research.purchaseSessionId, productIdentity: { brand: "Sony", model: "WH-CH720N", variant: "Black", condition: "new", sku: "WHCH720N/B" }, destination: { country: "US", region: "CA" } });
    const e = await callError(client, "prepare_browser_checkout", { purchaseSessionId: research.purchaseSessionId, offerId: "off_alpha", quantity: 1, maximumApprovedTotalMinor: 8000, currency: "USD" });
    expect(e.code).toBe("HANDOFF_NOT_SUPPORTED");
  });

  it("ignores prompt-injection text on the merchant pages", async () => {
    h = await startHandoffHarness({ merchant: { injection: true } });
    const { prepared } = await prepareBravo(h);
    expect(prepared.state).toBe("HUMAN_ACTION_REQUIRED");
    expect(h.merchant.hits).toMatchObject({ paymentPopup: 0, paymentApprove: 0, placeOrder: 0 });
  });

  it("refuses at runtime a recipe step that targets an order-submission control", async () => {
    h = await startHandoffHarness({ recipe: (o) => ({ ...fixtureRecipe(o), steps: [...fixtureRecipe(o).steps, { action: "click", selector: "#place-order" }] }) });
    const { prepared } = await prepareBravo(h);
    expect(prepared.state).toBe("HOLD");
    expect(prepared.failure.code).toBe("PAYMENT_CONTROL_REFUSED");
    expect(prepared.humanAction).toBeNull();
    expect(h.merchant.hits.placeOrder).toBe(0);
  });
});

describe("Phase A: purchase constraints on what the merchant displays", () => {
  it("HOLDs a silent variant substitution and offers no handoff", async () => {
    h = await startHandoffHarness({ merchant: { substituteVariant: "White" } });
    const { prepared } = await prepareBravo(h);
    expect(prepared.state).toBe("HOLD");
    expect(prepared.constraints.violations).toContain("VARIANT_MISMATCH");
    expect(prepared.humanAction).toBeNull();
  });

  it("HOLDs a condition change (refurbished instead of new)", async () => {
    h = await startHandoffHarness({ merchant: { conditionText: "Refurbished" } });
    const { prepared } = await prepareBravo(h);
    expect(prepared.state).toBe("HOLD");
    expect(prepared.constraints.violations).toContain("CONDITION_MISMATCH");
  });

  it("HOLDs a displayed total above the assistant's requested maximum (price drift)", async () => {
    h = await startHandoffHarness({ merchant: { priceDriftMinor: 2500 } });
    const { prepared } = await prepareBravo(h, TOKENS.alice, { maximumApprovedTotalMinor: 6000 });
    expect(prepared.state).toBe("HOLD");
    expect(prepared.constraints.violations).toEqual(["AMOUNT_EXCEEDED"]);
    expect(prepared.capturedCart.totalMinor).toBeGreaterThan(6000);
  });

  it("reports tax as an explicit unknown instead of guessing", async () => {
    h = await startHandoffHarness({ merchant: { hideTax: true } });
    const { prepared } = await prepareBravo(h);
    expect(prepared.capturedCart.taxMinor).toBeNull();
    expect(prepared.constraints.unknowns).toContain("tax");
  });

  it("the owner's maximum on the handoff page is binding; raising it re-evaluates", async () => {
    h = await startHandoffHarness();
    const { prepared } = await prepareBravo(h, TOKENS.alice, { maximumApprovedTotalMinor: 10_000 });
    const owner = new OwnerBrowser(h, prepared.handoffId);
    expect((await owner.review(OWNER.alice)).status).toBe(200);
    const low = await owner.maximum("50.00");
    expect(low.html).toContain("AMOUNT_EXCEEDED");
    expect(low.html).not.toContain("Take over the browser");
    expect((await owner.takeover()).status).toBe(409);
    const ok = await owner.maximum("70.00");
    expect(ok.html).toContain("Take over the browser");
  });
});

describe("Phase A: human handoff, popup, cancellation, confirmation honesty", () => {
  it("human approves in the merchant's popup → ORDER_CONFIRMED only via the signed seller channel", async () => {
    h = await startHandoffHarness();
    const { client, prepared } = await prepareBravo(h);
    const owner = new OwnerBrowser(h, prepared.handoffId);
    await owner.review(OWNER.alice);
    await owner.maximum("60.00");
    const t = await owner.takeover();
    expect(t.status).toBe(200);
    expect(t.html).toContain("automation is paused");
    // Automation is hard-disabled during takeover.
    await expect(h.app.handoff!.fixtureSession(prepared.handoffId)!.run("return 1")).rejects.toBeInstanceOf(AutomationPausedError);
    const mid = await call(client, "get_browser_checkout_status", { handoffId: prepared.handoffId });
    expect(mid.state).toBe("HANDOFF_OPENED");
    expect(mid.orderStatus).toBe("HUMAN_IN_CONTROL");

    await humanPaysInPopup(h, prepared.handoffId, "approve");
    expect(h.merchant.hits.paymentApprove).toBe(1);
    const done = await owner.finish();
    expect(done.html).toContain("ORDER_CONFIRMED");
    const st = await call(client, "get_browser_checkout_status", { handoffId: prepared.handoffId });
    expect(st.state).toBe("ORDER_CONFIRMED");
    expect(st.sellerConfirmation).toMatchObject({ status: "CONFIRMED", source: "FIXTURE_MERCHANT_SIGNED_ORDER_API", totalMinor: EXPECTED_TOTAL });
    expect(st.observation.pageClaimsConfirmation).toBe(true);
    expect(h.mock.calls.createOrder + h.mock.calls.captureOrder).toBe(0);
  });

  it("human cancels in the popup → seller reports no order → CANCELLED", async () => {
    h = await startHandoffHarness();
    const { client, prepared } = await prepareBravo(h);
    const owner = new OwnerBrowser(h, prepared.handoffId);
    await owner.review(OWNER.alice); await owner.maximum("60.00"); await owner.takeover();
    await humanPaysInPopup(h, prepared.handoffId, "cancel");
    await owner.finish();
    const st = await call(client, "get_browser_checkout_status", { handoffId: prepared.handoffId });
    expect(st.state).toBe("CANCELLED");
    expect(st.failure.code).toBe("SELLER_REPORTS_NO_ORDER");
    expect(h.merchant.hits.paymentApprove).toBe(0);
  });

  it("a confirmation page / redirect without payment is NOT proof", async () => {
    h = await startHandoffHarness();
    const { client, prepared } = await prepareBravo(h);
    const owner = new OwnerBrowser(h, prepared.handoffId);
    await owner.review(OWNER.alice); await owner.maximum("60.00"); await owner.takeover();
    const { page } = humanPage(h, prepared.handoffId);
    await page.goto(`${h.merchant.origin}/order/confirmation?o=ORD-FAKE`);
    await owner.finish();
    const st = await call(client, "get_browser_checkout_status", { handoffId: prepared.handoffId });
    expect(st.state).not.toBe("ORDER_CONFIRMED");
    expect(st.observation.pageClaimsConfirmation).toBe(true);
    expect(st.observation.discrepancies).toContain("PAGE_CLAIMS_CONFIRMATION_WITHOUT_SELLER_CONFIRMATION");
  });

  it("without an authenticated seller source the best outcome is ORDER_UNVERIFIED", async () => {
    h = await startHandoffHarness({ noSeller: true });
    const { client, prepared } = await prepareBravo(h);
    const owner = new OwnerBrowser(h, prepared.handoffId);
    await owner.review(OWNER.alice); await owner.maximum("60.00"); await owner.takeover();
    await humanPaysInPopup(h, prepared.handoffId, "approve");
    await owner.finish();
    const st = await call(client, "get_browser_checkout_status", { handoffId: prepared.handoffId });
    expect(st.state).toBe("ORDER_UNVERIFIED");
    expect(st.orderStatus).toBe("OUTCOME_UNVERIFIED");
  });

  it("owner can cancel before takeover; not after (outcome must be observed instead)", async () => {
    h = await startHandoffHarness();
    const a = await prepareBravo(h);
    const owner = new OwnerBrowser(h, a.prepared.handoffId);
    await owner.review(OWNER.alice);
    const c = await owner.cancel();
    expect(c.html).toContain("CANCELLED");
    expect((await call(a.client, "get_browser_checkout_status", { handoffId: a.prepared.handoffId })).state).toBe("CANCELLED");
  });

  it("refuses cancel after takeover", async () => {
    h = await startHandoffHarness();
    const { prepared } = await prepareBravo(h);
    const owner = new OwnerBrowser(h, prepared.handoffId);
    await owner.review(OWNER.alice); await owner.maximum("60.00"); await owner.takeover();
    const c = await owner.cancel();
    expect(c.status).toBe(409);
    expect(c.html).toContain("finish the handoff");
  });
});

describe("Phase A: timeouts", () => {
  it("expires an untouched prepared cart and closes the browser", async () => {
    h = await startHandoffHarness({ ttlMs: 60_000 });
    const { client, prepared } = await prepareBravo(h);
    h.clock.offsetMs = 61_000;
    const st = await call(client, "get_browser_checkout_status", { handoffId: prepared.handoffId });
    expect(st.state).toBe("EXPIRED");
    expect(st.humanAction).toBeNull();
    expect(h.app.handoff!.fixtureSession(prepared.handoffId)).toBeNull();
  });

  it("a takeover timeout never becomes EXPIRED: the outcome is observed (paid → confirmed)", async () => {
    h = await startHandoffHarness({ takeoverTtlMs: 60_000 });
    const { client, prepared } = await prepareBravo(h);
    const owner = new OwnerBrowser(h, prepared.handoffId);
    await owner.review(OWNER.alice); await owner.maximum("60.00"); await owner.takeover();
    await humanPaysInPopup(h, prepared.handoffId, "approve");
    h.clock.offsetMs = 61_000;
    const st = await call(client, "get_browser_checkout_status", { handoffId: prepared.handoffId });
    expect(st.state).toBe("ORDER_CONFIRMED");
    expect(st.observation.reason).toBe("TAKEOVER_TIMEOUT");
  });
});

describe("Phase A: isolation", () => {
  it("separate users get separate browser contexts, links and data", async () => {
    h = await startHandoffHarness();
    const a = await prepareBravo(h, TOKENS.alice);
    const b = await prepareBravo(h, TOKENS.bob);
    expect(a.prepared.capturedCart.cartRef).not.toBe(b.prepared.capturedCart.cartRef);
    // Bob cannot read Alice's handoff over MCP, nor open it with his owner key.
    expect((await callError(b.client, "get_browser_checkout_status", { handoffId: a.prepared.handoffId })).code).toBe("NOT_FOUND");
    expect((await new OwnerBrowser(h, a.prepared.handoffId).review(OWNER.bob)).status).toBe(404);
    // Alice's cookie for handoff A does not authorize actions on handoff B.
    const alice = new OwnerBrowser(h, a.prepared.handoffId);
    await alice.review(OWNER.alice);
    const cross = new OwnerBrowser(h, b.prepared.handoffId); cross.cookie = alice.cookie; cross.csrf = alice.csrf;
    expect((await cross.takeover()).status).toBe(401);
  });

  it("a read-only token cannot prepare; the link alone grants nothing", async () => {
    h = await startHandoffHarness();
    const { prepared } = await prepareBravo(h);
    const ro = await mcpClient(h.url, TOKENS.aliceReadOnly);
    const tools = (await ro.listTools()).tools.map((t) => t.name);
    expect(tools).toContain("get_browser_checkout_status");
    expect(tools).not.toContain("prepare_browser_checkout");
    const get = await fetch(prepared.humanAction.url);
    expect(await get.text()).toContain("Owner key");
    const noCookie = await fetch(prepared.humanAction.url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "action=takeover&csrf=x" });
    expect(noCookie.status).toBe(401);
  });
});
