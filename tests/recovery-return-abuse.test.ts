import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockPayPalProvider } from "../src/payment/MockPayPalProvider.js";
import { buyer, call, createMandate, mcpClient, OWNER, researchAndCompare, SONY_BLACK, startHarness, TOKENS, type Harness } from "./helpers.js";

const dirs: string[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close().catch(() => {});
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
async function start(opts: Parameters<typeof startHarness>[0] = {}) { const h = await startHarness(opts); harnesses.push(h); return h; }
const args = (ps: string) => ({ purchaseSessionId: ps, offerId: "off_alpha", maximumApprovedTotalMinor: 6000, currency: "USD", quantity: 1 });

describe("state recovery across a server restart (durable SQLite)", () => {
  it("keeps checkout state and mandate reservations, and deduplicates prepare after restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dac-")); dirs.push(dir);
    const dbPath = join(dir, "state.sqlite");
    const paypal = { shared: null as MockPayPalProvider | null };
    const payments = (base: string) => (paypal.shared ??= new MockPayPalProvider(base));
    const h1 = await start({ dbPath, payments });
    const c1 = await mcpClient(h1.url, TOKENS.alice);
    await createMandate(h1.url, OWNER.alice, { productIdentity: SONY_BLACK, currency: "USD", maximumTotalMinor: 6000 });
    const { research } = await researchAndCompare(c1);
    const prep = await call(c1, "prepare_checkout", args(research.purchaseSessionId));
    await c1.close(); await h1.close(); harnesses.splice(harnesses.indexOf(h1), 1);

    const h2 = await start({ dbPath, payments });
    const c2 = await mcpClient(h2.url, TOKENS.alice);
    const status = await call(c2, "get_checkout_status", { checkoutSessionId: prep.checkoutSessionId });
    expect(status).toMatchObject({ state: "APPROVAL_REQUIRED", amount: { totalMinor: 5939, currency: "USD" } });
    expect(h2.app.gateway.mandates.listActive("alice")[0]!.reservedMinor).toBe(5939);
    const ordersBefore = paypal.shared!.calls.createOrder;
    const again = await call(c2, "prepare_checkout", args(research.purchaseSessionId));
    expect(again).toMatchObject({ checkoutSessionId: prep.checkoutSessionId, deduplicated: true });
    expect(paypal.shared!.calls.createOrder).toBe(ordersBefore);
    await c2.close();
  });

  it("an UNKNOWN capture survives restart and reconciles to COMPLETED without a second capture", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dac-")); dirs.push(dir);
    const dbPath = join(dir, "state.sqlite");
    const paypal = { shared: null as MockPayPalProvider | null };
    const payments = (base: string) => (paypal.shared ??= new MockPayPalProvider(base));
    const h1 = await start({ dbPath, payments });
    const c1 = await mcpClient(h1.url, TOKENS.alice);
    await createMandate(h1.url, OWNER.alice, { productIdentity: SONY_BLACK, currency: "USD", maximumTotalMinor: 6000 });
    const { research } = await researchAndCompare(c1);
    const prep = await call(c1, "prepare_checkout", args(research.purchaseSessionId));
    paypal.shared!.captureOutcomes = ["TIMEOUT_AFTER_CAPTURE"];
    const b = await buyer(h1, prep.approvalUrl);
    expect((await call(c1, "get_checkout_status", { checkoutSessionId: prep.checkoutSessionId })).state).toBe("UNKNOWN");
    await c1.close(); await h1.close(); harnesses.splice(harnesses.indexOf(h1), 1);

    const h2 = await start({ dbPath, payments });
    // The buyer's browser replays the return URL against the restarted server: reconcile, not re-capture.
    const port2 = new URL(h2.url).port;
    await fetch(b.returnUrl.replace(/:\d+\//, `:${port2}/`));
    const c2 = await mcpClient(h2.url, TOKENS.alice);
    const s = await call(c2, "get_checkout_status", { checkoutSessionId: prep.checkoutSessionId });
    expect(s.state).toBe("COMPLETED");
    expect(paypal.shared!.calls.captureOrder).toBe(1);
    expect(h2.app.gateway.mandates.listActive("alice")).toHaveLength(0); // consumed → EXHAUSTED
    await c2.close();
  });
});

describe("/paypal/return cannot trigger an unauthorized capture", () => {
  let h: Harness;
  it("rejects forged, cross-user, unapproved, tampered and replayed returns", async () => {
    h = await start();
    const alice = await mcpClient(h.url, TOKENS.alice);
    const bob = await mcpClient(h.url, TOKENS.bob);
    await createMandate(h.url, OWNER.alice, { productIdentity: SONY_BLACK, currency: "USD", maximumTotalMinor: 6000 });
    await createMandate(h.url, OWNER.bob, { productIdentity: SONY_BLACK, currency: "USD", maximumTotalMinor: 6000 });
    const a = await call(alice, "prepare_checkout", args((await researchAndCompare(alice)).research.purchaseSessionId));
    const bb = await call(bob, "prepare_checkout", args((await researchAndCompare(bob)).research.purchaseSessionId));
    const orderOf = (p: any) => new URL(p.approvalUrl).pathname.split("/").pop()!;
    const ret = (cs: string, order: string) => fetch(`${h.url}/paypal/return?checkout=${cs}&token=${order}`);

    expect((await ret(a.checkoutSessionId, "MOCK0000000000000000")).status).toBe(404);   // forged order id
    expect((await ret(a.checkoutSessionId, orderOf(bb))).status).toBe(404);              // another user's order
    expect((await ret(a.checkoutSessionId, "not-an-id")).status).toBe(400);              // malformed
    expect((await ret(a.checkoutSessionId, orderOf(a))).status).toBe(200);               // real ids, buyer has NOT approved
    expect((await call(alice, "get_checkout_status", { checkoutSessionId: a.checkoutSessionId })).state).toBe("APPROVAL_REQUIRED");
    expect(h.mock.calls.captureOrder).toBe(0);

    // Provider-side tampering: the PayPal order amount no longer matches the server summary.
    h.mock.buyerApprove(orderOf(bb));
    (h.mock as any).orders.get(orderOf(bb)).amount.amountMinor = 1;
    await ret(bb.checkoutSessionId, orderOf(bb));
    const bs = await call(bob, "get_checkout_status", { checkoutSessionId: bb.checkoutSessionId });
    expect(bs.state).toBe("FAILED");
    expect(bs.failure.code).toBe("PROVIDER_ORDER_MISMATCH");
    expect(h.mock.calls.captureOrder).toBe(0);

    // Approved by the buyer: exactly one capture, replays are no-ops.
    const done = await buyer(h, a.approvalUrl);
    for (let i = 0; i < 3; i++) await fetch(done.returnUrl);
    expect(h.mock.calls.captureOrder).toBe(1);
    const receipt = await call(alice, "get_purchase_receipt", { checkoutSessionId: a.checkoutSessionId });
    expect(receipt.paymentResult.status).toBe("COMPLETED");
    expect(receipt.merchantOrder.status).toBe("NOT_VERIFIED"); // payment success ≠ fulfillment

    // A checkout without a provider order (the single-use mandate is now spent) has nothing a return URL could capture.
    const big = await call(alice, "research_purchase", { request: "Buy Sony WH-CH720N Black", currency: "USD", budgetMinor: 1_000_000 });
    await call(alice, "compare_purchase_offers", { researchSessionId: big.purchaseSessionId, productIdentity: SONY_BLACK, destination: { country: "US", region: "CA" } });
    const hold = await call(alice, "prepare_checkout", { ...args(big.purchaseSessionId), offerId: "off_india", maximumApprovedTotalMinor: 600000 });
    expect(hold.state).toBe("APPROVAL_REQUIRED");
    expect(hold.authorizationRequirements).toContain("OWNER_MANDATE_REQUIRED");
    expect(hold.approvalUrl).toBeNull();
    expect((await ret(hold.checkoutSessionId, orderOf(a))).status).toBe(404);
    await alice.close(); await bob.close();
  });
});
