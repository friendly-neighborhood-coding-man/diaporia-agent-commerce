import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buyer, call, callError, CA, createMandate, mcpClient, OWNER, researchAndCompare, SONY_BLACK, startHarness, TOKENS, type Harness } from "./helpers.js";

let h: Harness;
beforeEach(async () => { h = await startHarness(); });
afterEach(async () => { await h.close(); });

const mandate60 = (extra: Record<string, unknown> = {}) => createMandate(h.url, OWNER.alice, { productIdentity: SONY_BLACK, currency: "USD", maximumTotalMinor: 6000, ...extra });

describe("MCP protocol discovery and schemas", () => {
  it("lists the five host-neutral tools with schemas and accurate safety annotations", async () => {
    const client = await mcpClient(h.url, TOKENS.alice);
    expect(client.getServerVersion()?.name).toBe("diaporia-agent-commerce");
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(Object.keys(byName).sort()).toEqual(["compare_purchase_offers", "get_checkout_status", "get_purchase_receipt", "get_usage_summary", "prepare_checkout", "research_purchase"]);
    for (const t of tools) { expect(t.inputSchema.type).toBe("object"); expect(t.outputSchema?.type).toBe("object"); }
    expect(byName.research_purchase!.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(byName.get_checkout_status!.annotations?.readOnlyHint).toBe(true);
    expect(byName.get_purchase_receipt!.annotations?.readOnlyHint).toBe(true);
    expect(byName.prepare_checkout!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(byName.prepare_checkout!._meta).toMatchObject({ "diaporia/capturesFunds": false });
    expect(byName.prepare_checkout!.inputSchema.required).toEqual(expect.arrayContaining(["purchaseSessionId", "offerId", "maximumApprovedTotalMinor", "currency", "quantity"]));
    expect(tools.some((t) => /buy_now|capture|pay/i.test(t.name))).toBe(false);
    await client.close();
  });

  it("rejects missing/invalid tokens and hides prepare_checkout from tokens without the scope", async () => {
    const res = await fetch(`${h.url}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: "{}" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/Bearer/);
    await expect(mcpClient(h.url, "dct_not_a_real_token_000000000000")).rejects.toThrow();
    const ro = await mcpClient(h.url, TOKENS.aliceReadOnly);
    const names = (await ro.listTools()).tools.map((t) => t.name);
    expect(names.sort()).toEqual(["get_checkout_status", "get_purchase_receipt", "get_usage_summary"]);
    const denied = await ro.callTool({ name: "research_purchase", arguments: { request: "Find headphones" } }).catch((e) => ({ isError: true, thrown: String(e) }));
    expect(denied.isError).toBe(true);
    await ro.close();
  });

  it("rejects schema-invalid tool arguments (float money, bad ids)", async () => {
    const client = await mcpClient(h.url, TOKENS.alice);
    const bad = await client.callTool({ name: "prepare_checkout", arguments: { purchaseSessionId: "ps_x", offerId: "off_alpha", maximumApprovedTotalMinor: 59.99, currency: "USD", quantity: 1 } });
    expect(bad.isError).toBe(true);
    await client.close();
  });
});

describe("PRODUCT_DISCOVERY", () => {
  it("researches, classifies suitability and reports unknowns without payment effect", async () => {
    const client = await mcpClient(h.url, TOKENS.alice);
    const r = await call(client, "research_purchase", { request: "Find good wireless headphones under $100.", mustHave: ["active_noise_cancellation"] });
    expect(r.mode).toBe("PRODUCT_DISCOVERY");
    expect(r.paymentEffect).toBe("NONE");
    expect(r.dataSource.mockData).toBe(true);
    const by = Object.fromEntries(r.candidates.map((c: any) => [c.productId, c]));
    expect(by.prd_northwind_aero.suitability).toBe("SUITABLE");
    expect(by.prd_sony_whch720n_black.suitability).toBe("SUITABLE");
    expect(by.prd_lumen_q3.suitability).toBe("NEEDS_VERIFICATION"); // ANC is only a listing claim
    expect(by.prd_contoso_studio.suitability).toBe("NOT_SUITABLE"); // verified not wireless
    expect(r.candidates[r.candidates.length - 1].suitability).toBe("NOT_SUITABLE");
    expect(by.prd_contoso_studio.budgetFit).toBe("LISTING_OVER_BUDGET");
    expect(r.unknowns.some((u: string) => /Lumen/.test(u))).toBe(true);
    // Discovery can lock one candidate for comparison.
    const c = await call(client, "compare_purchase_offers", { researchSessionId: r.purchaseSessionId, productIdentity: by.prd_northwind_aero.identity, destination: CA });
    expect(c.lowestVerifiedEligibleOffer.offerId).toBe("off_nw_aero");
    await client.close();
  });
});

describe("EXACT_PRODUCT_PURCHASE", () => {
  it("locks identity, rejects substitution, and finds the lowest verified total", async () => {
    const client = await mcpClient(h.url, TOKENS.alice);
    const { research, compare } = await researchAndCompare(client);
    expect(research.mode).toBe("EXACT_PRODUCT_PURCHASE");
    expect(research.identity.status).toBe("LOCKED");
    expect(research.intent.budgetMinor).toBe(6000);
    expect(compare.state).toBe("OFFER_VERIFIED");
    expect(compare.lowestVerifiedEligibleOffer.offerId).toBe("off_alpha");
    expect(compare.lowestVerifiedEligibleOffer.cost.totalMinor).toBe(5939);
    expect(compare.ineligibleOffers.find((o: any) => o.offerId === "off_bravo").issues).toContain("TOTAL_UNKNOWN");
    const mismatch = await callError(client, "compare_purchase_offers", { researchSessionId: research.purchaseSessionId, productIdentity: { ...SONY_BLACK, variant: "White", sku: "WHCH720N/W" }, destination: CA });
    expect(mismatch.code).toBe("IDENTITY_MISMATCH");
    await client.close();
  });

  it("returns a truthful HOLD when the variant is ambiguous or no quote is verifiable", async () => {
    const client = await mcpClient(h.url, TOKENS.alice);
    const amb = await call(client, "research_purchase", { request: "Buy Sony WH-CH720N under $60" });
    expect(amb.state).toBe("HOLD");
    expect(amb.identity.status).toBe("AMBIGUOUS");
    const r = await call(client, "research_purchase", { request: "Buy Sony WH-CH720N Black, never exceed $60" });
    const noDest = await call(client, "compare_purchase_offers", { researchSessionId: r.purchaseSessionId, productIdentity: SONY_BLACK });
    expect(noDest.state).toBe("HOLD");
    expect(noDest.lowestVerifiedEligibleOffer).toBeNull();
    expect(noDest.holdReasons.join(" ")).toMatch(/destination/);
    const prep = await callError(client, "prepare_checkout", { purchaseSessionId: r.purchaseSessionId, offerId: "off_alpha", maximumApprovedTotalMinor: 6000, currency: "USD", quantity: 1 });
    expect(prep.code).toBe("INVALID_STATE");
    await client.close();
  });

  it("refuses stale or ineligible offers at prepare time", async () => {
    const client = await mcpClient(h.url, TOKENS.alice);
    const { research } = await researchAndCompare(client);
    const stale = await callError(client, "prepare_checkout", { purchaseSessionId: research.purchaseSessionId, offerId: "off_charlie", maximumApprovedTotalMinor: 6000, currency: "USD", quantity: 1 });
    expect(stale.code).toBe("OFFER_NOT_ELIGIBLE");
    expect(stale.details.issues).toContain("QUOTE_STALE");
    // The research session itself expires after 30 minutes.
    h.clock.offsetMs = 31 * 60_000;
    const expired = await callError(client, "prepare_checkout", { purchaseSessionId: research.purchaseSessionId, offerId: "off_alpha", maximumApprovedTotalMinor: 6000, currency: "USD", quantity: 1 });
    expect(expired.code).toBe("SESSION_EXPIRED");
    await client.close();
  });
});

describe("bounded purchase authorization", () => {
  it("rejects a $6,000 checkout against a $60 mandate before any payment provider call", async () => {
    const client = await mcpClient(h.url, TOKENS.alice);
    expect((await mandate60()).status).toBe(201);
    // The AI client (e.g. misled by injected text) claims a $10,000 budget; that does not grant authority.
    const { research, compare } = await researchAndCompare(client, "Buy Sony WH-CH720N Black", { budgetMinor: 1_000_000 });
    expect(research.intent.budgetSource).toBe("STRUCTURED_INPUT");
    expect(compare.eligibleOffers.map((o: any) => o.offerId)).toContain("off_india");
    const before = { ...h.mock.calls };
    const prep = await call(client, "prepare_checkout", { purchaseSessionId: research.purchaseSessionId, offerId: "off_india", maximumApprovedTotalMinor: 600000, currency: "USD", quantity: 1 });
    expect(prep.state).toBe("HOLD");
    expect(prep.policy).toMatchObject({ allowed: false, code: "AMOUNT_EXCEEDED" });
    expect(prep.approvalUrl).toBeNull();
    expect(prep.purchaseSummary.totalMinor).toBe(600000);
    expect(h.mock.calls).toEqual(before); // no createOrder, no capture
    const status = await call(client, "get_checkout_status", { checkoutSessionId: prep.checkoutSessionId });
    expect(status.state).toBe("HOLD");
    expect(status.capture.captureId).toBeNull();
    await client.close();
  });

  it("rejects client maximums below the verified total, and quantity/variant beyond the mandate", async () => {
    const client = await mcpClient(h.url, TOKENS.alice);
    await mandate60();
    const { research } = await researchAndCompare(client, "Buy Sony WH-CH720N Black", { budgetMinor: 20000 });
    const low = await callError(client, "prepare_checkout", { purchaseSessionId: research.purchaseSessionId, offerId: "off_alpha", maximumApprovedTotalMinor: 5000, currency: "USD", quantity: 1 });
    expect(low.code).toBe("CLIENT_LIMIT_EXCEEDED");
    const cur = await callError(client, "prepare_checkout", { purchaseSessionId: research.purchaseSessionId, offerId: "off_alpha", maximumApprovedTotalMinor: 6000, currency: "EUR", quantity: 1 });
    expect(cur.code).toBe("INVALID_INPUT");
    const q2 = await call(client, "prepare_checkout", { purchaseSessionId: research.purchaseSessionId, offerId: "off_alpha", maximumApprovedTotalMinor: 20000, currency: "USD", quantity: 2 });
    expect(q2.policy.code).toBe("QUANTITY_EXCEEDED");
    expect(h.mock.calls.createOrder).toBe(0);
    await client.close();
  });

  it("rejects expired and revoked mandates", async () => {
    const client = await mcpClient(h.url, TOKENS.alice);
    const m = await mandate60({ ttlSeconds: 60 });
    h.clock.offsetMs = 2 * 60_000;
    const a = await researchAndCompare(client);
    const exp = await call(client, "prepare_checkout", { purchaseSessionId: a.research.purchaseSessionId, offerId: "off_alpha", maximumApprovedTotalMinor: 6000, currency: "USD", quantity: 1 });
    // An expired mandate is rejected explicitly; no PayPal order exists.
    expect(exp.state).toBe("HOLD");
    expect(exp.policy.code).toBe("MANDATE_EXPIRED");
    expect(exp.approvalUrl).toBeNull();
    expect(h.mock.calls.createOrder).toBe(0);
    const direct = h.app.gateway.policy.evaluate(h.app.gateway.mandates.get(m.body.mandateId, "alice"), { userId: "alice", checkoutSessionId: "cs_x", productIdentity: SONY_BLACK, merchantId: "mer_alpha_audio", currency: "USD", quantity: 1, totalMinor: 5939 });
    expect(direct.code).toBe("MANDATE_EXPIRED");

    const m2 = await mandate60();
    const rv = await fetch(`${h.url}/owner/mandates/${m2.body.mandateId}/revoke`, { method: "POST", headers: { "X-Owner-Key": OWNER.alice } });
    expect(rv.status).toBe(200);
    const revoked = h.app.gateway.policy.evaluate(h.app.gateway.mandates.get(m2.body.mandateId, "alice"), { userId: "alice", checkoutSessionId: "cs_x", productIdentity: SONY_BLACK, merchantId: "mer_alpha_audio", currency: "USD", quantity: 1, totalMinor: 5939 });
    expect(revoked.code).toBe("MANDATE_REVOKED");
    // Bob cannot revoke Alice's mandate.
    const bobRevoke = await fetch(`${h.url}/owner/mandates/${m.body.mandateId}/revoke`, { method: "POST", headers: { "X-Owner-Key": OWNER.bob } });
    expect(bobRevoke.status).toBe(404);
    await client.close();
  });

  it("serializes concurrent reservations so the cumulative cap cannot be exceeded", async () => {
    const m = await createMandate(h.url, OWNER.alice, { productIdentity: SONY_BLACK, currency: "USD", maximumTotalMinor: 10000, maximumTransactions: 5 });
    const req = (i: number) => ({ userId: "alice", checkoutSessionId: `cs_${i}`, productIdentity: SONY_BLACK, merchantId: "mer_alpha_audio", currency: "USD" as const, quantity: 1, totalMinor: 5939 });
    const results = await Promise.all([1, 2, 3, 4].map(async (i) => h.app.gateway.policy.reserve(m.body.mandateId, req(i))));
    expect(results.filter((r) => r.allowed)).toHaveLength(1);
    expect(results.filter((r) => !r.allowed).every((r) => r.code === "CUMULATIVE_AMOUNT_EXCEEDED")).toBe(true);
    const after = h.app.gateway.mandates.get(m.body.mandateId, "alice")!;
    expect(after.reservedMinor).toBe(5939);
  });

  it("rejects malformed mandates with 400", async () => {
    const r = await createMandate(h.url, OWNER.alice, { productIdentity: { brand: "Sony" }, currency: "USD", maximumTotalMinor: 6000 });
    expect(r.status).toBe(400);
    const r2 = await createMandate(h.url, OWNER.alice, { productIdentity: SONY_BLACK, currency: "USD", maximumTotalMinor: 59.99 });
    expect(r2.status).toBe(400);
  });

  it("an AI client token cannot create a mandate", async () => {
    const r = await fetch(`${h.url}/owner/mandates`, { method: "POST", headers: { "Content-Type": "application/json", "X-Owner-Key": TOKENS.alice }, body: JSON.stringify({ productIdentity: SONY_BLACK, currency: "USD", maximumTotalMinor: 600000 }) });
    expect(r.status).toBe(401);
  });
});

describe("isolation between users", () => {
  it("another user's sessions are indistinguishable from missing ones", async () => {
    const alice = await mcpClient(h.url, TOKENS.alice);
    const bob = await mcpClient(h.url, TOKENS.bob);
    await mandate60();
    const { research } = await researchAndCompare(alice);
    const prep = await call(alice, "prepare_checkout", { purchaseSessionId: research.purchaseSessionId, offerId: "off_alpha", maximumApprovedTotalMinor: 6000, currency: "USD", quantity: 1 });
    expect((await callError(bob, "get_checkout_status", { checkoutSessionId: prep.checkoutSessionId })).code).toBe("NOT_FOUND");
    expect((await callError(bob, "get_purchase_receipt", { checkoutSessionId: prep.checkoutSessionId })).code).toBe("NOT_FOUND");
    expect((await callError(bob, "compare_purchase_offers", { researchSessionId: research.purchaseSessionId, productIdentity: SONY_BLACK, destination: CA })).code).toBe("NOT_FOUND");
    expect((await callError(bob, "prepare_checkout", { purchaseSessionId: research.purchaseSessionId, offerId: "off_alpha", maximumApprovedTotalMinor: 6000, currency: "USD", quantity: 1 })).code).toBe("NOT_FOUND");
    // Bob's mandate (if any) can never apply to Alice's checkout, and Bob's owner key cannot open it.
    const page = await fetch(`${h.url}/authorize/${prep.checkoutSessionId}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `action=review&ownerKey=${OWNER.bob}` });
    expect(page.status).toBe(404);
    await alice.close(); await bob.close();
  });
});

describe("mock end-to-end purchase", () => {
  it("research → compare → prepare (mandate) → buyer approval → verified capture → receipt", async () => {
    const client = await mcpClient(h.url, TOKENS.alice);
    await mandate60();
    const { research, compare } = await researchAndCompare(client);
    const prep = await call(client, "prepare_checkout", { purchaseSessionId: research.purchaseSessionId, offerId: compare.lowestPayPalCheckoutableOffer.offerId, maximumApprovedTotalMinor: 6000, currency: "USD", quantity: 1 });
    expect(prep.state).toBe("APPROVAL_REQUIRED");
    expect(prep.policy).toMatchObject({ allowed: true, code: "ALLOWED" });
    expect(prep.approvalUrl).toMatch(/\/mock-paypal\/checkout\/MOCK/);
    expect(prep.paymentEffect).toBe("NO_FUNDS_CAPTURED");
    expect(h.mock.calls.captureOrder).toBe(0);
    const pending = await call(client, "get_checkout_status", { checkoutSessionId: prep.checkoutSessionId });
    expect(pending.approval.buyerApprovalVerified).toBe(false);

    const b = await buyer(h, prep.approvalUrl);
    expect(b.returnHtml).toMatch(/COMPLETED/);
    const status = await call(client, "get_checkout_status", { checkoutSessionId: prep.checkoutSessionId });
    expect(status).toMatchObject({ state: "COMPLETED", stateIsServerVerified: true, amount: { totalMinor: 5939, currency: "USD" }, fulfillment: "NOT_VERIFIED" });
    expect(status.approval.buyerApprovalVerified).toBe(true);
    const receipt = await call(client, "get_purchase_receipt", { checkoutSessionId: prep.checkoutSessionId });
    expect(receipt.paymentResult).toMatchObject({ status: "COMPLETED", provider: "MOCK_PAYPAL", amount: { totalMinor: 5939 } });
    expect(receipt.merchantOrder.status).toBe("NOT_VERIFIED");
    expect(receipt).toMatchObject({ paymentEnvironment: "MOCK", liveMerchantCheckout: false });
    expect(receipt.auditTimeline.map((e: any) => e.type)).toEqual(expect.arrayContaining(["RESEARCHED", "OFFERS_COMPARED", "CHECKOUT_PREPARED", "MANDATE_RESERVED", "BUYER_APPROVAL_VERIFIED", "PAYMENT_COMPLETED_VERIFIED"]));
    const mandate = h.app.gateway.mandates.listActive("alice");
    expect(mandate).toHaveLength(0); // single-use mandate is now EXHAUSTED
    expect(h.app.gateway.audit.verifyChain()).toBeNull();
    await client.close();
  });

  it("owner authorization page creates a bound mandate when none exists, and blocks a too-low limit", async () => {
    const client = await mcpClient(h.url, TOKENS.alice);
    const { research } = await researchAndCompare(client);
    const prep = await call(client, "prepare_checkout", { purchaseSessionId: research.purchaseSessionId, offerId: "off_alpha", maximumApprovedTotalMinor: 6000, currency: "USD", quantity: 1 });
    expect(prep.authorizationRequirements).toEqual(["OWNER_MANDATE_REQUIRED", "PAYPAL_BUYER_APPROVAL_REQUIRED"]);
    expect(prep.userAuthorizationUrl).toMatch(/\/authorize\/cs_/);
    const review = await fetch(prep.userAuthorizationUrl, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `action=review&ownerKey=${OWNER.alice}` });
    const html = await review.text();
    expect(html).toMatch(/59\.39 USD/);
    const cookie = review.headers.get("set-cookie")!.split(";")[0]!;
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1]!;
    const tooLow = await fetch(prep.userAuthorizationUrl, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie }, body: `action=authorize&csrf=${csrf}&maximum=50.00` });
    expect(tooLow.status).toBe(403);
    expect(await tooLow.text()).toMatch(/AMOUNT_EXCEEDED/);
    expect(h.mock.calls.createOrder).toBe(0);
    // Second attempt with a fresh review and an adequate limit proceeds to the (mock) PayPal page.
    const review2 = await fetch(prep.userAuthorizationUrl, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `action=review&ownerKey=${OWNER.alice}` });
    const cookie2 = review2.headers.get("set-cookie")!.split(";")[0]!;
    const csrf2 = /name="csrf" value="([^"]+)"/.exec(await review2.text())![1]!;
    const ok = await fetch(prep.userAuthorizationUrl, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie2 }, body: `action=authorize&csrf=${csrf2}&maximum=60.00` });
    expect(ok.status).toBe(303);
    await buyer(h, ok.headers.get("location")!);
    expect((await call(client, "get_checkout_status", { checkoutSessionId: prep.checkoutSessionId })).state).toBe("COMPLETED");
    await client.close();
  });
});

describe("duplicates, cancellation, timeouts, pending", () => {
  async function prepared() {
    const client = await mcpClient(h.url, TOKENS.alice);
    await mandate60();
    const { research } = await researchAndCompare(client);
    const args = { purchaseSessionId: research.purchaseSessionId, offerId: "off_alpha", maximumApprovedTotalMinor: 6000, currency: "USD", quantity: 1 };
    const prep = await call(client, "prepare_checkout", args);
    return { client, prep, args };
  }

  it("deduplicates repeated prepare calls and never captures twice", async () => {
    const { client, prep, args } = await prepared();
    const again = await call(client, "prepare_checkout", args);
    expect(again.checkoutSessionId).toBe(prep.checkoutSessionId);
    expect(again.deduplicated).toBe(true);
    expect(h.mock.calls.createOrder).toBe(1);
    const b = await buyer(h, prep.approvalUrl);
    // Replay the return redirect three times, two concurrently.
    await Promise.all([fetch(b.returnUrl), fetch(b.returnUrl)]);
    await fetch(b.returnUrl);
    expect(h.mock.calls.captureOrder).toBe(1);
    const s = await call(client, "get_checkout_status", { checkoutSessionId: prep.checkoutSessionId });
    expect(s.state).toBe("COMPLETED");
    // A second checkout on the exhausted single-use mandate cannot reserve again.
    const { research } = await researchAndCompare(client);
    const second = await call(client, "prepare_checkout", { ...args, purchaseSessionId: research.purchaseSessionId });
    expect(second.authorizationRequirements).toContain("OWNER_MANDATE_REQUIRED");
    await client.close();
  });

  it("a redirect without buyer approval does not complete payment", async () => {
    const { client, prep } = await prepared();
    const orderId = new URL(prep.approvalUrl).pathname.split("/").pop();
    await fetch(`${h.url}/paypal/return?checkout=${prep.checkoutSessionId}&token=${orderId}`);
    const s = await call(client, "get_checkout_status", { checkoutSessionId: prep.checkoutSessionId });
    expect(s.state).toBe("APPROVAL_REQUIRED");
    expect(h.mock.calls.captureOrder).toBe(0);
    // A forged return for a different order id is rejected.
    const forged = await fetch(`${h.url}/paypal/return?checkout=${prep.checkoutSessionId}&token=MOCK0000000000000000`);
    expect(forged.status).toBe(404);
    await client.close();
  });

  it("handles buyer cancellation and releases the reservation", async () => {
    const { client, prep } = await prepared();
    await buyer(h, prep.approvalUrl, "cancel");
    const s = await call(client, "get_checkout_status", { checkoutSessionId: prep.checkoutSessionId });
    expect(s.state).toBe("CANCELLED");
    expect(h.mock.calls.captureOrder).toBe(0);
    const m = h.app.gateway.mandates.listActive("alice")[0]!;
    expect(m.reservedMinor).toBe(0);
    expect(m.transactionsUsed).toBe(0);
    await client.close();
  });

  it("network timeout during capture yields UNKNOWN, then reconciles without double capture", async () => {
    const { client, prep } = await prepared();
    h.mock.captureOutcomes = ["TIMEOUT_AFTER_CAPTURE"];
    await buyer(h, prep.approvalUrl);
    const unknown = await call(client, "get_checkout_status", { checkoutSessionId: prep.checkoutSessionId });
    expect(unknown.state).toBe("UNKNOWN");
    expect(unknown.uncertainty).toMatch(/not known/);
    const rr = await fetch(`${h.url}/owner/checkouts/${prep.checkoutSessionId}/reconcile`, { method: "POST", headers: { "X-Owner-Key": OWNER.alice } });
    expect((await rr.json()).state).toBe("COMPLETED");
    expect(h.mock.calls.captureOrder).toBe(1);
    await client.close();
  });

  it("timeout before capture reaches PayPal: UNKNOWN, reconcile retries with the same idempotency key", async () => {
    const { client, prep } = await prepared();
    h.mock.captureOutcomes = ["TIMEOUT_BEFORE_CAPTURE"];
    await buyer(h, prep.approvalUrl);
    expect((await call(client, "get_checkout_status", { checkoutSessionId: prep.checkoutSessionId })).state).toBe("UNKNOWN");
    const r = await h.app.gateway.reconcile("alice", prep.checkoutSessionId);
    expect(r.state).toBe("COMPLETED");
    expect(h.mock.describe(r.providerOrderId!)!.captures).toHaveLength(1);
    await client.close();
  });

  it("distinguishes PENDING from COMPLETED, and DECLINED becomes FAILED", async () => {
    const { client, prep } = await prepared();
    h.mock.captureOutcomes = ["PENDING"];
    await buyer(h, prep.approvalUrl);
    const s = await call(client, "get_checkout_status", { checkoutSessionId: prep.checkoutSessionId });
    expect(s.state).toBe("CAPTURE_PENDING");
    expect(s.capture.status).toBe("PENDING");
    const receipt = await call(client, "get_purchase_receipt", { checkoutSessionId: prep.checkoutSessionId });
    expect(receipt.paymentResult).toBeNull();
    h.mock.settleCapture(s.capture.captureId, "COMPLETED");
    expect((await h.app.gateway.reconcile("alice", prep.checkoutSessionId)).state).toBe("COMPLETED");

    const second = await mcpClient(h.url, TOKENS.bob);
    await createMandate(h.url, OWNER.bob, { productIdentity: SONY_BLACK, currency: "USD", maximumTotalMinor: 6000 });
    const { research } = await researchAndCompare(second);
    const p2 = await call(second, "prepare_checkout", { purchaseSessionId: research.purchaseSessionId, offerId: "off_alpha", maximumApprovedTotalMinor: 6000, currency: "USD", quantity: 1 });
    h.mock.captureOutcomes = ["DECLINED"];
    await buyer(h, p2.approvalUrl);
    const f = await call(second, "get_checkout_status", { checkoutSessionId: p2.checkoutSessionId });
    expect(f.state).toBe("FAILED");
    expect(f.failure.code).toBe("CAPTURE_DECLINED");
    await client.close(); await second.close();
  });

  it("an approved checkout is not captured if the mandate is revoked first", async () => {
    const { client, prep } = await prepared();
    const m = h.app.gateway.mandates.listActive("alice")[0]!;
    await fetch(`${h.url}/owner/mandates/${m.mandateId}/revoke`, { method: "POST", headers: { "X-Owner-Key": OWNER.alice } });
    await buyer(h, prep.approvalUrl);
    const s = await call(client, "get_checkout_status", { checkoutSessionId: prep.checkoutSessionId });
    expect(s.state).toBe("FAILED");
    expect(s.failure.code).toBe("MANDATE_NO_LONGER_VALID");
    expect(h.mock.calls.captureOrder).toBe(0);
    await client.close();
  });

  it("checkouts expire before approval", async () => {
    const { client, prep } = await prepared();
    h.clock.offsetMs = 16 * 60_000;
    const s = await call(client, "get_checkout_status", { checkoutSessionId: prep.checkoutSessionId });
    expect(s.state).toBe("EXPIRED");
    await client.close();
  });
});

describe("prompt injection through untrusted content", () => {
  it("injected review/listing text is surfaced as flagged data and changes nothing", async () => {
    const client = await mcpClient(h.url, TOKENS.alice);
    await mandate60();
    const { research, compare } = await researchAndCompare(client);
    const reviews = research.candidates[0].untrustedContent;
    expect(reviews.some((r: any) => r.flags.includes("PAYMENT_INSTRUCTION") && r.trusted === false)).toBe(true);
    const fox = compare.ineligibleOffers.find((o: any) => o.offerId === "off_foxtrot");
    expect(fox.issues).toContain("SUSPICIOUS_LISTING_CONTENT");
    // Following the injected instruction is refused: the offer is ineligible...
    const viaFox = await callError(client, "prepare_checkout", { purchaseSessionId: research.purchaseSessionId, offerId: "off_foxtrot", maximumApprovedTotalMinor: 600000, currency: "USD", quantity: 1 });
    expect(viaFox.code).toBe("OFFER_NOT_ELIGIBLE");
    // ...and the mandate remains the only spending authority.
    expect(h.app.gateway.mandates.listActive("alice")[0]!.maximumTotalMinor).toBe(6000);
    expect(h.mock.calls.createOrder).toBe(0);
    await client.close();
  });
});
