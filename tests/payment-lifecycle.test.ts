/**
 * Payment lifecycle after capture: authoritative reconciliation and webhooks.
 * ALL of this is SIMULATED (mock PayPal provider + locally signed webhook fixtures). It never touches
 * the real Sandbox transaction from run 2.
 */
import { afterEach, describe, expect, it } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import { crc32 } from "node:zlib";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PayPalWebhookSignatureVerifier } from "../src/payment/PayPalWebhook.js";
import { MockPayPalProvider } from "../src/payment/MockPayPalProvider.js";
import { buyer, call, callError, createMandate, mcpClient, OWNER, researchAndCompare, SONY_BLACK, startHarness, TOKENS, type Harness } from "./helpers.js";

const WEBHOOK_ID = "8PT597110X687430LKGECATA";
const CERT_URL = "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-test";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
let certFetches = 0;
const verifier = () => new PayPalWebhookSignatureVerifier({ webhookId: WEBHOOK_ID, fetchCertPem: async (u) => { certFetches++; if (u !== CERT_URL) throw new Error("unexpected"); return publicPem; } });

let seq = 0;
function webhook(eventType: string, captureId: string, opts: { status?: string; payee?: string; id?: string; forge?: boolean; certUrl?: string; time?: string; refund?: boolean } = {}) {
  const id = opts.id ?? `WH-${String(++seq).padStart(4, "0")}TESTEVENT0000000000`;
  const resource = opts.refund
    ? { id: "REFUND0000000001", status: "COMPLETED", links: [{ rel: "up", href: `https://api.sandbox.paypal.com/v2/payments/captures/${captureId}` }] }
    : { id: captureId, status: opts.status ?? eventType.split(".").pop(), ...(opts.payee ? { payee: { merchant_id: opts.payee } } : {}) };
  const body = JSON.stringify({ id, event_type: eventType, resource_type: opts.refund ? "refund" : "capture", resource });
  const time = opts.time ?? new Date().toISOString();
  const tid = `tid-${id}`;
  const msg = `${tid}|${time}|${WEBHOOK_ID}|${crc32(Buffer.from(body)) >>> 0}`;
  const sig = sign("sha256", Buffer.from(opts.forge ? msg + "x" : msg), privateKey).toString("base64");
  return { body, headers: { "Content-Type": "application/json", "paypal-transmission-id": tid, "paypal-transmission-time": time,
    "paypal-transmission-sig": sig, "paypal-cert-url": opts.certUrl ?? CERT_URL, "paypal-auth-algo": "SHA256withRSA" } };
}
async function deliver(h: Harness, w: ReturnType<typeof webhook>) {
  const r = await fetch(`${h.url}/paypal/webhook`, { method: "POST", headers: w.headers, body: w.body });
  return { status: r.status, outcome: ((await r.json()) as { outcome: string }).outcome };
}

const hs: Harness[] = []; const dirs: string[] = [];
afterEach(async () => { for (const h of hs.splice(0)) await h.close().catch(() => {}); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** Builds a checkout whose capture PayPal (mock) reports as PENDING / PENDING_REVIEW, like Sandbox run 2. */
async function pendingCheckout(over: Parameters<typeof startHarness>[0] = {}) {
  const h = await startHarness({ webhookVerifier: verifier(), readRetry: { attempts: 3, baseDelayMs: 1 }, ...over }); hs.push(h);
  const client = await mcpClient(h.url, TOKENS.alice);
  await createMandate(h.url, OWNER.alice, { productIdentity: SONY_BLACK, currency: "USD", maximumTotalMinor: 6000 });
  const { research } = await researchAndCompare(client);
  const prep = await call(client, "prepare_checkout", { purchaseSessionId: research.purchaseSessionId, offerId: "off_alpha", maximumApprovedTotalMinor: 6000, currency: "USD", quantity: 1 });
  h.mock.captureOutcomes = ["PENDING"];
  await buyer(h, prep.approvalUrl);
  const s = await call(client, "get_checkout_status", { checkoutSessionId: prep.checkoutSessionId });
  expect(s.state).toBe("CAPTURE_PENDING");
  return { h, client, prep, research, captureId: s.capture.captureId as string, cs: prep.checkoutSessionId as string };
}
const status = (c: any, cs: string) => call(c, "get_checkout_status", { checkoutSessionId: cs });
const mandate = (h: Harness) => h.app.store.db.prepare("SELECT status, reserved_minor, consumed_minor, transactions_used FROM mandates").get() as any;

describe("payment lifecycle (SIMULATED provider + signed fixtures)", () => {
  it("pending contract: CAPTURE_PENDING is clearly not a payment receipt", async () => {
    const { client, cs, captureId } = await pendingCheckout();
    const s = await status(client, cs);
    expect(s.paymentStatus).toBe("CAPTURE_PENDING");
    expect(s.payment).toMatchObject({ paymentEnvironment: "MOCK", captureId, providerCaptureStatus: "PENDING", pendingReason: "PENDING_REVIEW",
      recommendedNextAction: "WAIT_FOR_PROVIDER_SETTLEMENT_DO_NOT_RETRY", newPaymentAttemptProhibited: true });
    expect(s.merchantOrderStatus).toBe("MERCHANT_ORDER_NOT_VERIFIED");
    const r = await call(client, "get_purchase_receipt", { checkoutSessionId: cs });
    expect(r).toMatchObject({ paymentStatus: "CAPTURE_PENDING", isFinalPaymentReceipt: false, paymentResult: null, merchantOrderStatus: "MERCHANT_ORDER_NOT_VERIFIED" });
  });

  it("1. PENDING → COMPLETED via a signed webhook, confirmed by an authoritative capture read", async () => {
    const { h, client, cs, captureId } = await pendingCheckout();
    h.mock.settleCapture(captureId, "COMPLETED");
    const before = h.mock.calls.getCapture;
    expect(await deliver(h, webhook("PAYMENT.CAPTURE.COMPLETED", captureId))).toEqual({ status: 200, outcome: "RECONCILED_SETTLED_COMPLETED" });
    expect(h.mock.calls.getCapture).toBeGreaterThan(before);
    const s = await status(client, cs);
    expect(s).toMatchObject({ state: "COMPLETED", paymentStatus: "PAYMENT_COMPLETED", merchantOrderStatus: "MERCHANT_ORDER_NOT_VERIFIED", merchantFundsAvailability: "NOT_DETERMINED_BY_CAPTURE_API" });
    expect(s.payment.lastAuthoritativeVerificationAt).toBeTruthy();
    expect(mandate(h)).toMatchObject({ status: "EXHAUSTED", reserved_minor: 0, consumed_minor: 5939 });
    expect(h.mock.calls.captureOrder).toBe(1);
  });

  it("2. PENDING → DENIED: FAILED, reservation released, no new capture", async () => {
    const { h, client, cs, captureId } = await pendingCheckout();
    h.mock.settleCapture(captureId, "DECLINED");
    expect((await deliver(h, webhook("PAYMENT.CAPTURE.DENIED", captureId))).outcome).toBe("RECONCILED_SETTLED_FAILED");
    const s = await status(client, cs);
    expect(s).toMatchObject({ state: "FAILED", paymentStatus: "PAYMENT_FAILED" });
    expect(s.payment.recommendedNextAction).toBe("NEW_OWNER_AUTHORIZATION_REQUIRED_FOR_ANY_NEW_ATTEMPT");
    expect(mandate(h)).toMatchObject({ reserved_minor: 0, consumed_minor: 0, transactions_used: 0 });
    expect(h.mock.calls.captureOrder).toBe(1);
  });

  it("3. PENDING → PENDING: verification time is recorded, nothing else changes", async () => {
    const { h, client, cs, captureId } = await pendingCheckout();
    expect((await deliver(h, webhook("PAYMENT.CAPTURE.PENDING", captureId))).outcome).toBe("RECONCILED_STILL_PENDING");
    const s = await status(client, cs);
    expect(s).toMatchObject({ state: "CAPTURE_PENDING", payment: { pendingReason: "PENDING_REVIEW" } });
    expect(s.payment.lastAuthoritativeVerificationAt).toBeTruthy();
    expect(mandate(h)).toMatchObject({ reserved_minor: 5939, consumed_minor: 0 });
  });

  it("4. a simulated COMPLETED webhook never completes a capture the provider still reports PENDING; stale events after completion do not regress", async () => {
    const { h, client, cs, captureId } = await pendingCheckout();
    // Validly signed fixture claims COMPLETED, but the authoritative read says PENDING.
    expect((await deliver(h, webhook("PAYMENT.CAPTURE.COMPLETED", captureId, { status: "COMPLETED" }))).outcome).toBe("RECONCILED_STILL_PENDING");
    expect((await status(client, cs)).state).toBe("CAPTURE_PENDING");
    h.mock.settleCapture(captureId, "COMPLETED");
    await deliver(h, webhook("PAYMENT.CAPTURE.COMPLETED", captureId));
    // A late PENDING event and a late DENIED event arrive after completion.
    expect((await deliver(h, webhook("PAYMENT.CAPTURE.PENDING", captureId))).outcome).toBe("RECONCILED_NO_CHANGE");
    expect((await deliver(h, webhook("PAYMENT.CAPTURE.DENIED", captureId))).outcome).toBe("RECONCILED_NO_CHANGE");
    expect((await status(client, cs)).state).toBe("COMPLETED");
  });

  it("5. duplicate delivery is processed once", async () => {
    const { h, captureId } = await pendingCheckout();
    h.mock.settleCapture(captureId, "COMPLETED");
    const w = webhook("PAYMENT.CAPTURE.COMPLETED", captureId, { id: "WH-DUPLICATE0000000000000001" });
    expect((await deliver(h, w)).outcome).toBe("RECONCILED_SETTLED_COMPLETED");
    const reads = h.mock.calls.getCapture;
    expect(await deliver(h, w)).toEqual({ status: 200, outcome: "DUPLICATE" });
    expect(h.mock.calls.getCapture).toBe(reads);
  });

  it("6. forged, stale, foreign-cert and unauthenticated webhooks are rejected before any provider read", async () => {
    const { h, client, cs, captureId } = await pendingCheckout();
    h.mock.settleCapture(captureId, "COMPLETED");
    const reads = h.mock.calls.getCapture;
    expect((await deliver(h, webhook("PAYMENT.CAPTURE.COMPLETED", captureId, { forge: true }))).status).toBe(401);
    expect((await deliver(h, webhook("PAYMENT.CAPTURE.COMPLETED", captureId, { certUrl: "https://evil.example/v1/notifications/certs/x" }))).status).toBe(401);
    expect((await deliver(h, webhook("PAYMENT.CAPTURE.COMPLETED", captureId, { time: new Date(Date.now() - 4 * 86400_000).toISOString() }))).status).toBe(401);
    const bare = await fetch(`${h.url}/paypal/webhook`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: "WH-X", event_type: "PAYMENT.CAPTURE.COMPLETED" }) });
    expect(bare.status).toBe(401);
    expect(h.mock.calls.getCapture).toBe(reads);
    expect((await status(client, cs)).state).toBe("CAPTURE_PENDING");
    // Without a configured webhook id/verifier the endpoint is off.
    const off = await startHarness(); hs.push(off);
    expect((await fetch(`${off.url}/paypal/webhook`, { method: "POST", body: "{}" })).status).toBe(503);
  });

  it("7. wrong capture id or wrong merchant id in the event changes nothing", async () => {
    const { h, client, cs, captureId } = await pendingCheckout();
    h.mock.settleCapture(captureId, "COMPLETED");
    expect((await deliver(h, webhook("PAYMENT.CAPTURE.COMPLETED", "NOTOURCAPTURE0001"))).outcome).toBe("IGNORED_UNRELATED_CAPTURE");
    expect((await deliver(h, webhook("PAYMENT.CAPTURE.COMPLETED", captureId, { payee: "SOMEOTHERMERCHANT" }))).outcome).toBe("IGNORED_PAYEE_MISMATCH");
    expect((await deliver(h, webhook("CHECKOUT.ORDER.APPROVED", captureId))).outcome).toMatch(/^IGNORED: unhandled event type/);
    expect((await status(client, cs)).state).toBe("CAPTURE_PENDING");
  });

  it("8. conflicting provider/local state: amount mismatch → UNKNOWN (no completion); provider PENDING after local COMPLETED → ignored", async () => {
    const a = await pendingCheckout();
    a.h.mock.tamperCaptureAmount(a.captureId, 1);
    a.h.mock.settleCapture(a.captureId, "COMPLETED");
    expect((await deliver(a.h, webhook("PAYMENT.CAPTURE.COMPLETED", a.captureId))).outcome).toBe("RECONCILED_AMOUNT_MISMATCH");
    expect(await status(a.client, a.cs)).toMatchObject({ state: "UNKNOWN", paymentStatus: "PAYMENT_UNKNOWN", payment: { newPaymentAttemptProhibited: true } });
    expect(mandate(a.h).reserved_minor).toBe(5939); // never released on uncertainty

    const b = await pendingCheckout();
    b.h.mock.settleCapture(b.captureId, "COMPLETED");
    await b.h.app.gateway.reconcile("alice", b.cs);
    (b.h.mock as any).captures.get(b.captureId).status = "PENDING";
    expect((await b.h.app.gateway.reconcileCapture(b.h.app.gateway.sessions.getCheckout(b.cs, "alice"), "MANUAL")).outcome).toBe("CONFLICT_IGNORED");
    expect((await status(b.client, b.cs)).state).toBe("COMPLETED");
  });

  it("9. server restart while the capture is pending: startup reconciliation settles it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dac-life-")); dirs.push(dir);
    const shared = { p: null as MockPayPalProvider | null };
    const payments = (b: string) => (shared.p ??= new MockPayPalProvider(b));
    const first = await pendingCheckout({ dbPath: join(dir, "s.sqlite"), payments });
    await first.client.close(); await first.h.close(); hs.splice(hs.indexOf(first.h), 1);
    shared.p!.settleCapture(first.captureId, "COMPLETED");
    const h2 = await startHarness({ dbPath: join(dir, "s.sqlite"), payments }); hs.push(h2);
    const results = await h2.app.gateway.reconcileAwaitingSettlement("STARTUP");
    expect(results).toEqual([{ checkoutSessionId: first.cs, outcome: "SETTLED_COMPLETED", state: "COMPLETED" }]);
    expect(shared.p!.calls.captureOrder).toBe(1);
  });

  it("10. provider timeout during reconciliation: bounded retries, then no state change and no release", async () => {
    const { h, client, cs, captureId } = await pendingCheckout();
    h.mock.settleCapture(captureId, "COMPLETED");
    h.mock.getCaptureFailures = 5;
    const before = h.mock.calls.getCapture;
    const r = await h.app.gateway.reconcileCapture(h.app.gateway.sessions.getCheckout(cs, "alice"), "MANUAL");
    expect(r.outcome).toBe("PROVIDER_UNAVAILABLE");
    expect(h.mock.calls.getCapture - before).toBe(3); // bounded
    expect((await status(client, cs)).state).toBe("CAPTURE_PENDING");
    expect(mandate(h).reserved_minor).toBe(5939);
    h.mock.getCaptureFailures = 2; // transient: succeeds on the third attempt
    expect((await h.app.gateway.reconcileCapture(h.app.gateway.sessions.getCheckout(cs, "alice"), "MANUAL")).outcome).toBe("SETTLED_COMPLETED");
  });

  it("11. refund after completion: REFUNDED, mandate authority is not restored, no new attempt for this session", async () => {
    const { h, client, cs, captureId, research } = await pendingCheckout();
    h.mock.settleCapture(captureId, "COMPLETED");
    await deliver(h, webhook("PAYMENT.CAPTURE.COMPLETED", captureId));
    h.mock.refundCapture(captureId);
    expect((await deliver(h, webhook("PAYMENT.CAPTURE.REFUNDED", captureId, { refund: true }))).outcome).toBe("RECONCILED_REFUNDED");
    const s = await status(client, cs);
    expect(s).toMatchObject({ state: "REFUNDED", paymentStatus: "PAYMENT_REFUNDED" });
    const r = await call(client, "get_purchase_receipt", { checkoutSessionId: cs });
    expect(r).toMatchObject({ paymentStatus: "PAYMENT_REFUNDED", isFinalPaymentReceipt: false, paymentResult: null });
    expect(mandate(h)).toMatchObject({ status: "EXHAUSTED", consumed_minor: 5939 }); // refund does not re-grant spending authority
    const again = await call(client, "prepare_checkout", { purchaseSessionId: research.purchaseSessionId, offerId: "off_alpha", maximumApprovedTotalMinor: 6000, currency: "USD", quantity: 1 });
    expect(again.authorizationRequirements).toContain("OWNER_MANDATE_REQUIRED"); // a fresh owner authorization is required
    expect(h.mock.calls.captureOrder).toBe(1);
  });

  it("12. merchant UI 'On hold' is not an input: capture status alone drives payment state", async () => {
    const pending = await pendingCheckout();
    expect((await status(pending.client, pending.cs)).paymentStatus).toBe("CAPTURE_PENDING");
    pending.h.mock.settleCapture(pending.captureId, "COMPLETED");
    await deliver(pending.h, webhook("PAYMENT.CAPTURE.COMPLETED", pending.captureId));
    const s = await status(pending.client, pending.cs);
    // A seller-side funds hold is a separate concept: completion is reported, fund availability is not claimed.
    expect(s).toMatchObject({ paymentStatus: "PAYMENT_COMPLETED", merchantFundsAvailability: "NOT_DETERMINED_BY_CAPTURE_API", merchantOrderStatus: "MERCHANT_ORDER_NOT_VERIFIED", fulfillment: "NOT_VERIFIED" });
  });

  it("cross-cutting: no new payment attempt while pending, no cross-user access, no secret leakage", async () => {
    const { h, client, cs, research } = await pendingCheckout();
    const err = await callError(client, "prepare_checkout", { purchaseSessionId: research.purchaseSessionId, offerId: "off_golf", maximumApprovedTotalMinor: 9000, currency: "USD", quantity: 1 });
    expect(["INVALID_STATE", "OFFER_NOT_ELIGIBLE"]).toContain(err.code);
    const same = await call(client, "prepare_checkout", { purchaseSessionId: research.purchaseSessionId, offerId: "off_alpha", maximumApprovedTotalMinor: 6000, currency: "USD", quantity: 1 });
    expect(same).toMatchObject({ checkoutSessionId: cs, deduplicated: true });
    const bob = await mcpClient(h.url, TOKENS.bob);
    expect((await callError(bob, "get_checkout_status", { checkoutSessionId: cs })).code).toBe("NOT_FOUND");
    const w = await fetch(`${h.url}/paypal/webhook`, { method: "POST", headers: webhook("PAYMENT.CAPTURE.PENDING", "X").headers, body: "{}" });
    expect(JSON.stringify(await w.json())).not.toMatch(/Bearer|secret|dct_|dok_/i);
    const audit = JSON.stringify(h.app.store.db.prepare("SELECT data_json FROM audit_events").all());
    expect(audit).not.toMatch(/dct_|dok_|A21AA/);
    expect(h.mock.calls.captureOrder).toBe(1);
    await bob.close();
  });

  it("public deployments: the webhook route is closed with every other payment route", async () => {
    const h = await startHarness({ baseUrl: "https://demo.example.org", webhookVerifier: verifier() }); hs.push(h);
    const { request } = await import("node:http");
    const code = await new Promise<number>((resolve) => { const q = request({ host: "127.0.0.1", port: new URL(h.url).port, path: "/paypal/webhook", method: "POST", headers: { Host: "demo.example.org" } }, (r) => { r.resume(); resolve(r.statusCode!); }); q.end("{}"); });
    expect(code).toBe(403);
    expect(certFetches).toBeGreaterThan(0);
  });
});
