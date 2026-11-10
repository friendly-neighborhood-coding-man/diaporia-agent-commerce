import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockPayPalProvider } from "../src/payment/MockPayPalProvider.js";
import { buyer, call, createMandate, mcpClient, OWNER, researchAndCompare, SONY_BLACK, startHarness, TOKENS, type Harness } from "./helpers.js";
import { runAll } from "../scripts/dogfood/harness.js";

const dirs: string[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close().catch(() => {});
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
async function start(opts: Parameters<typeof startHarness>[0] = {}) { const h = await startHarness(opts); harnesses.push(h); return h; }
const args = (ps: string) => ({ purchaseSessionId: ps, offerId: "off_alpha", maximumApprovedTotalMinor: 6000, currency: "USD", quantity: 1 });

describe("defects found by dogfooding (2026-11-10)", () => {
  it("DF-1: startup recovery settles an UNKNOWN checkout whose capture id was never recorded, using reads only", async () => {
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
    await buyer(h1, prep.approvalUrl);
    expect((await call(c1, "get_checkout_status", { checkoutSessionId: prep.checkoutSessionId })).capture.captureId).toBeNull();
    await c1.close(); await h1.close(); harnesses.splice(harnesses.indexOf(h1), 1);

    const h2 = await start({ dbPath, payments });
    const captures = paypal.shared!.calls.captureOrder;
    const rec = await h2.app.gateway.reconcileAwaitingSettlement("STARTUP");
    expect(rec).toEqual([{ checkoutSessionId: prep.checkoutSessionId, outcome: "SETTLED_COMPLETED", state: "COMPLETED" }]);
    expect(paypal.shared!.calls.captureOrder).toBe(captures); // reads only
  });

  it("DF-1b: startup recovery never captures when the provider shows an approved order without a capture", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dac-")); dirs.push(dir);
    const dbPath = join(dir, "state.sqlite");
    const paypal = { shared: null as MockPayPalProvider | null };
    const payments = (base: string) => (paypal.shared ??= new MockPayPalProvider(base));
    const h1 = await start({ dbPath, payments });
    const c1 = await mcpClient(h1.url, TOKENS.alice);
    await createMandate(h1.url, OWNER.alice, { productIdentity: SONY_BLACK, currency: "USD", maximumTotalMinor: 6000 });
    const { research } = await researchAndCompare(c1);
    const prep = await call(c1, "prepare_checkout", args(research.purchaseSessionId));
    paypal.shared!.captureOutcomes = ["TIMEOUT_BEFORE_CAPTURE"];
    await buyer(h1, prep.approvalUrl);
    await c1.close(); await h1.close(); harnesses.splice(harnesses.indexOf(h1), 1);
    const h2 = await start({ dbPath, payments });
    const captures = paypal.shared!.calls.captureOrder;
    const rec = await h2.app.gateway.reconcileAwaitingSettlement("STARTUP");
    expect(rec).toEqual([{ checkoutSessionId: prep.checkoutSessionId, outcome: "NO_CHANGE", state: "UNKNOWN" }]);
    expect(paypal.shared!.calls.captureOrder).toBe(captures);
    // The owner's explicit reconcile is still the only path that may retry the capture (same idempotency key).
    const r = await fetch(`${h2.url}/owner/checkouts/${prep.checkoutSessionId}/reconcile`, { method: "POST", headers: { "X-Owner-Key": OWNER.alice } });
    expect((await r.json() as any).state).toBe("COMPLETED");
    expect(paypal.shared!.describe((await h2.app.gateway.sessions.getCheckout(prep.checkoutSessionId, "alice")).providerOrderId!)!.captures).toHaveLength(1);
  });

  it("DF-2: repeating an identical prepare after the payment completed returns the completed checkout, not a new one", async () => {
    const h = await start();
    const c = await mcpClient(h.url, TOKENS.alice);
    await createMandate(h.url, OWNER.alice, { productIdentity: SONY_BLACK, currency: "USD", maximumTotalMinor: 12000, maximumTransactions: 2 });
    const { research } = await researchAndCompare(c);
    const prep = await call(c, "prepare_checkout", args(research.purchaseSessionId));
    await buyer(h, prep.approvalUrl);
    expect((await call(c, "get_checkout_status", { checkoutSessionId: prep.checkoutSessionId })).state).toBe("COMPLETED");
    const orders = h.mock.calls.createOrder;
    const again = await call(c, "prepare_checkout", args(research.purchaseSessionId));
    expect(again).toMatchObject({ checkoutSessionId: prep.checkoutSessionId, deduplicated: true, state: "COMPLETED" });
    expect(h.mock.calls.createOrder).toBe(orders);
    await c.close();
  });

  it("the dogfood harness scenarios A–H and K all pass (offline MOCK)", async () => {
    const results = await runAll();
    const failed = results.filter((r) => r.status !== "PASS").map((r) => ({ id: r.id, error: r.error, failed: r.checks.filter((c) => !c.pass) }));
    expect(failed).toEqual([]);
    expect(results.map((r) => r.id)).toEqual(["A", "B", "C", "D", "E", "F", "G", "H", "K"]);
  }, 60_000);
});
