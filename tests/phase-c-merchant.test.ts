/**
 * Phase C test merchant, C0 offline. MOCK mode uses the in-process fake PayPal; Sandbox modes use a FAKE Sandbox REST
 * backend injected as fetch. Nothing here reaches PayPal, KERNEL or any paid provider.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { ConfigRefusedError, loadAllowlist, loadMerchantConfig } from "../apps/phase-c-test-merchant/src/config.js";
import { FIXED_TOTAL_MINOR, computeTotals } from "../apps/phase-c-test-merchant/src/catalog.js";
import { PayPalSandboxOrdersClient } from "../apps/phase-c-test-merchant/src/paypal.js";
import { MERCHANT_TRANSITIONS } from "../apps/phase-c-test-merchant/src/orders.js";
import { sellerStatusOf, startMerchantServer, type MerchantServer } from "../apps/phase-c-test-merchant/src/server.js";
import { Buyer, FAKE_CLIENT_SECRET, OPERATOR_KEY, ORIGIN, STATUS_SECRET, allowlistText, fakeSandboxPayPal, mockConfig, sandboxEnv, startMockMerchant } from "./phase-c-helpers.js";

let m: MerchantServer | null = null;
afterEach(async () => { await m?.close(); m = null; });

const refused = (env: Record<string, string>, code: string, text?: string) => {
  try { loadMerchantConfig(env, Date.now(), text); } catch (e) { expect(e).toBeInstanceOf(ConfigRefusedError); expect((e as ConfigRefusedError).code).toBe(code); return; }
  throw new Error(`expected ${code}`);
};

async function cartWithOrder(mm: MerchantServer) {
  const b = new Buyer(mm);
  expect((await b.addToCart()).status).toBe(303);
  const c = await b.cart();
  const created = await b.api("/api/checkout/orders", { cartRef: c.ref, csrf: c.csrf });
  return { b, c, created };
}

describe("fixed product and server-side totals", () => {
  it("one fictional product, fixed USD price, $95.00 + $5.00 + 8% tax = $107.60", () => {
    expect(computeTotals(9500, 1)).toEqual({ subtotalMinor: 9500, shippingMinor: 500, taxMinor: 760, totalMinor: 10760, currency: "USD" });
    expect(FIXED_TOTAL_MINOR).toBe(10760);
  });
  it("every merchant state has an explicit transition list; terminal states are final", () => {
    expect(MERCHANT_TRANSITIONS.ORDER_CONFIRMED).toEqual([]);
    expect(MERCHANT_TRANSITIONS.NO_ORDER).not.toContain("ORDER_CONFIRMED");
    expect(MERCHANT_TRANSITIONS.ORDER_CREATED).not.toContain("ORDER_CONFIRMED");
    expect(MERCHANT_TRANSITIONS.BUYER_APPROVED).not.toContain("ORDER_CONFIRMED");
  });
});

describe("execution gates: MOCK by default, Sandbox only with a matching owner approval digest", () => {
  it("defaults to MOCK and needs nothing", () => { expect(loadMerchantConfig({}).mode).toBe("MOCK"); });
  it("a correct C1 digest activates SANDBOX_POPUP_TEST with capture disabled and 1 order max", () => {
    const c = loadMerchantConfig(sandboxEnv("C1"));
    expect(c.mode).toBe("SANDBOX_POPUP_TEST");
    expect(c.approval!.statement).toMatchObject({ gate: "C1", capture: false, maxCaptures: 0, maxSandboxOrders: 1, kernelBrowsers: 1, kernelEgressHosts: ["phase-c.operator-shop.com", "www.sandbox.paypal.com"] });
  });
  it("refuses unauthorized attempts to activate Sandbox modes", () => {
    refused(sandboxEnv("C1", { PHASE_C_APPROVED_DIGEST: undefined }), "APPROVAL_REQUIRED");
    refused(sandboxEnv("C1", { PHASE_C_APPROVED_DIGEST: "0".repeat(64) }), "APPROVAL_DIGEST_MISMATCH");
    // A C1 approval never activates C2.
    refused({ ...sandboxEnv("C1"), MERCHANT_CHECKOUT_MODE: "SANDBOX_APPROVAL_TEST" }, "APPROVAL_DIGEST_MISMATCH");
    refused(sandboxEnv("C1", { PHASE_C_APPROVAL_EXPIRES_AT: new Date(Date.now() - 1000).toISOString() }), "APPROVAL_EXPIRED");
    refused(sandboxEnv("C1", { PHASE_C_APPROVAL_EXPIRES_AT: new Date(Date.now() + 30 * 3600_000).toISOString() }), "APPROVAL_WINDOW_TOO_LONG");
    // Changing any bound parameter invalidates the digest.
    refused(sandboxEnv("C1", { MERCHANT_PUBLIC_ORIGIN: "https://other-shop.com" }), "APPROVAL_DIGEST_MISMATCH");
    refused(sandboxEnv("C1", { PHASE_C_MAX_MINUTES: "9" }), "APPROVAL_DIGEST_MISMATCH");
    refused(sandboxEnv("C2", { MERCHANT_PAYPAL_SELLER_MERCHANT_ID: "OTHERSELLER9" }), "APPROVAL_DIGEST_MISMATCH");
    refused(sandboxEnv("C1", { MERCHANT_PAYPAL_SELLER_MERCHANT_ID: "OTHERSELLER9" }), "APPROVAL_DIGEST_MISMATCH");
    refused(sandboxEnv("C1", { MERCHANT_PUBLIC_ORIGIN: "http://phase-c.operator-shop.com" }), "ORIGIN_NOT_HTTPS");
    refused(sandboxEnv("C1", { MERCHANT_PUBLIC_ORIGIN: "https://127.0.0.1" }), "ORIGIN_NOT_PUBLIC");
    refused(sandboxEnv("C1", { MERCHANT_PAYPAL_CLIENT_SECRET: undefined }), "CREDENTIALS_MISSING");
    refused(sandboxEnv("C1", { MERCHANT_DATA_DIR: undefined }), "DATA_DIR_REQUIRED");
    refused(sandboxEnv("C1", { MERCHANT_STATUS_SECRET: undefined }), "STATUS_SECRET_REQUIRED");
    refused({ MERCHANT_CHECKOUT_MODE: "LIVE" }, "MODE_UNKNOWN");
  });
  it("production PayPal is unreachable: endpoint overrides, live env and live hosts are refused", async () => {
    refused({ PAYPAL_API_BASE: "https://api-m.paypal.com" }, "ENDPOINT_OVERRIDE_REFUSED");
    refused({ ...sandboxEnv("C1"), MERCHANT_PAYPAL_SDK_URL: "https://www.paypal.com/web-sdk/v6/core" }, "ENDPOINT_OVERRIDE_REFUSED");
    refused({ MERCHANT_PAYPAL_ENV: "LIVE" }, "LIVE_REFUSED");
    const seen: string[] = [];
    const client = new PayPalSandboxOrdersClient({ clientId: "x", clientSecret: "y", fetchImpl: (async (u: string) => { seen.push(String(u)); return new Response("{}"); }) as typeof fetch });
    await expect((client as any).send("https://api-m.paypal.com/v2/checkout/orders", { method: "GET" }, "probe")).rejects.toThrow(/non-Sandbox/);
    expect(seen).toEqual([]);
    expect(JSON.stringify(client)).not.toContain("y\"");
  });
  it("MOCK refuses Sandbox secrets and approval digests so they are not left in a demo process", () => {
    refused({ MERCHANT_PAYPAL_CLIENT_SECRET: "s" }, "CREDENTIALS_IN_MOCK");
    refused({ PHASE_C_APPROVED_DIGEST: "a".repeat(64) }, "APPROVAL_IN_MOCK");
  });
  it("test knobs (price drift, payee override...) are refused outside MOCK", async () => {
    const pp = fakeSandboxPayPal();
    await expect(startMerchantServer({ config: loadMerchantConfig(sandboxEnv("C1")), fetchImpl: pp.fetchImpl, mockKnobs: { payeeOverride: "X" } })).rejects.toThrow(/refused outside MOCK/);
  });
});

describe("network allowlist file", () => {
  it("the reviewed file has only exact hosts and contains www.sandbox.paypal.com", () => {
    const a = loadAllowlist(allowlistText());
    expect(a.browserHosts).toEqual(["www.sandbox.paypal.com"]);
    expect(a.sha256).toMatch(/^[a-f0-9]{64}$/);
  });
  it.each([
    ["wildcard", "*.paypal.com", "ALLOWLIST_HOST_INVALID"],
    ["ip literal", "203.0.113.7", "ALLOWLIST_HOST_INVALID"],
    ["port", "www.sandbox.paypal.com:443", "ALLOWLIST_HOST_INVALID"],
    ["private name", "merchant.internal", "ALLOWLIST_HOST_INVALID"],
    ["live PayPal", "www.paypal.com", "ALLOWLIST_LIVE_PAYPAL"],
  ])("refuses %s", (_n, host, code) => {
    const j = JSON.parse(allowlistText());
    j.browserHosts.push({ host });
    refused({}, code, JSON.stringify(j));
  });
  it("refuses an empty or missing allowlist", () => {
    refused({}, "ALLOWLIST_INVALID", JSON.stringify({ schema: "diaporia.phase-c.network-allowlist.v1", browserHosts: [] }));
    refused({}, "ALLOWLIST_INVALID", "not json");
  });
});

describe("MOCK checkout: cart binding, idempotency, replay and failure states", () => {
  it("locks SKU, variant and quantity: other quantities and unknown variants are refused", async () => {
    m = await startMockMerchant();
    const b = new Buyer(m);
    expect((await b.addToCart("Black", "2")).text).toContain("QUANTITY_LOCKED");
    expect((await b.addToCart("White", "1")).text).toContain("VARIANT_UNKNOWN");
    expect((await b.addToCart("Black", "1")).status).toBe(303);
    const c = await b.cart();
    expect(c.html).toContain('data-field="total">$107.60');
    expect(c.html).toContain('data-field="sku">LUM-Q3-B');
  });

  it("creates the order from server totals only; browser-submitted prices are rejected", async () => {
    m = await startMockMerchant();
    const b = new Buyer(m); await b.addToCart();
    const c = await b.cart();
    const evil = await b.api("/api/checkout/orders", { cartRef: c.ref, csrf: c.csrf, amount: "0.01" });
    expect(evil).toMatchObject({ status: 400, body: { error: "UNEXPECTED_FIELD" } });
    const ok = await b.api("/api/checkout/orders", { cartRef: c.ref, csrf: c.csrf });
    expect(ok.status).toBe(201);
    const v = await m.mock!.getOrder(ok.body.orderId);
    expect(v).toMatchObject({ amountMinor: 10760, currency: "USD", payeeMerchantId: "MOCKSELLER01", customId: c.ref, status: "CREATED" });
  });

  it("deduplicates repeated and concurrent create-order requests (one PayPal order, same request id)", async () => {
    m = await startMockMerchant();
    const b = new Buyer(m); await b.addToCart();
    const c = await b.cart();
    const all = await Promise.all(Array.from({ length: 6 }, () => b.api("/api/checkout/orders", { cartRef: c.ref, csrf: c.csrf })));
    expect(new Set(all.map((r) => r.body.orderId)).size).toBe(1);
    expect(m.mock!.calls.create).toBe(1);
    expect(all.filter((r) => r.body.deduplicated).length).toBe(5);
  });

  it("refuses cross-origin, wrong-CSRF and other-session requests", async () => {
    m = await startMockMerchant();
    const b = new Buyer(m); await b.addToCart();
    const c = await b.cart();
    expect((await new Buyer(m, "https://evil.example").api("/api/checkout/orders", { cartRef: c.ref, csrf: c.csrf }, { Cookie: b.cookie })).body.error).toBe("ORIGIN_REFUSED");
    expect((await b.api("/api/checkout/orders", { cartRef: c.ref, csrf: "nope" })).body.error).toBe("CSRF_INVALID");
    const other = new Buyer(m); await other.addToCart();
    expect((await other.api("/api/checkout/orders", { cartRef: c.ref, csrf: c.csrf })).body.error).toBe("CART_NOT_FOUND");
  });

  it("a browser 'approved' claim without PayPal-side approval changes nothing", async () => {
    m = await startMockMerchant();
    const { b, c, created } = await cartWithOrder(m);
    const r = await b.api("/api/checkout/orders/approve", { cartRef: c.ref, csrf: c.csrf, orderId: created.body.orderId });
    expect(r.body.state).toBe("ORDER_CREATED");
    expect(m.mock!.calls.capture).toBe(0);
  });

  it("approved → captured → ORDER_CONFIRMED; replayed callbacks never capture twice", async () => {
    m = await startMockMerchant();
    const { b, c, created } = await cartWithOrder(m);
    m.mock!.buyerApprove(created.body.orderId);
    const replays = await Promise.all(Array.from({ length: 4 }, () => b.api("/api/checkout/orders/approve", { cartRef: c.ref, csrf: c.csrf, orderId: created.body.orderId })));
    expect(replays.map((r) => r.body.state)).toEqual(Array(4).fill("ORDER_CONFIRMED"));
    expect(m.mock!.calls.capture).toBe(1);
    expect(m.checkout.history(c.ref).map((h) => h.to)).toEqual(["ORDER_CREATED", "BUYER_APPROVED", "PAYMENT_COMPLETED", "ORDER_CONFIRMED"]);
    // An approval for a different order id is refused.
    expect((await b.api("/api/checkout/orders/approve", { cartRef: c.ref, csrf: c.csrf, orderId: "MOCKORDER999999" })).body.error).toBe("ORDER_MISMATCH");
    // The cart can no longer change.
    expect((await b.addToCart()).text).toContain("CART_LOCKED");
  });

  it("price changed after the cart was shown → no order", async () => {
    m = await startMockMerchant({ storeKnobs: { unitPriceDriftAfterCartMinor: 100 } });
    const { created } = await cartWithOrder(m);
    expect(created).toMatchObject({ status: 409, body: { error: "PRICE_CHANGED" } });
    expect(m.mock!.calls.create).toBe(0);
  });

  it("seller recipient or amount mismatch in PayPal's order → ORDER_UNKNOWN, never shown to the buyer", async () => {
    m = await startMockMerchant({ mockKnobs: { payeeOverride: "SOMEONEELSE1" } });
    const a = await cartWithOrder(m);
    expect(a.created.body.error).toBe("PAYEE_MISMATCH");
    expect(m.checkout.publicStatus(a.c.ref)).toMatchObject({ state: "ORDER_UNKNOWN", problem: "PAYEE_MISMATCH", payeeVerified: false });
    await m.close();
    m = await startMockMerchant({ mockKnobs: { amountOverrideMinor: 1 } });
    expect((await cartWithOrder(m)).created.body.error).toBe("AMOUNT_MISMATCH");
  });

  it("capture PENDING stays CAPTURE_PENDING (not success) until reconciliation sees COMPLETED", async () => {
    m = await startMockMerchant({ mockKnobs: { captureOutcome: "PENDING" } });
    const { b, c, created } = await cartWithOrder(m);
    m.mock!.buyerApprove(created.body.orderId);
    expect((await b.api("/api/checkout/orders/approve", { cartRef: c.ref, csrf: c.csrf, orderId: created.body.orderId })).body.state).toBe("CAPTURE_PENDING");
    expect(sellerStatusOf("CAPTURE_PENDING", true, true)).toBe("UNKNOWN");
    m.mock!.settlePending(created.body.orderId, "COMPLETED");
    const op = await fetch(`${m.localUrl}/operator/reconcile?cart=${c.ref}`, { headers: { Authorization: `Bearer ${OPERATOR_KEY}` } });
    expect((await op.json()).state).toBe("ORDER_CONFIRMED");
    expect(m.mock!.calls.capture).toBe(1);
  });

  it("capture DECLINED → PAYMENT_DENIED", async () => {
    m = await startMockMerchant({ mockKnobs: { captureOutcome: "DECLINED" } });
    const { b, c, created } = await cartWithOrder(m);
    m.mock!.buyerApprove(created.body.orderId);
    expect((await b.api("/api/checkout/orders/approve", { cartRef: c.ref, csrf: c.csrf, orderId: created.body.orderId })).body.state).toBe("PAYMENT_DENIED");
  });

  it("capture timeout → ORDER_UNKNOWN; reconciliation reads PayPal first and does NOT re-capture", async () => {
    m = await startMockMerchant({ mockKnobs: { captureOutcome: "TIMEOUT" } });
    const { b, c, created } = await cartWithOrder(m);
    m.mock!.buyerApprove(created.body.orderId);
    expect((await b.api("/api/checkout/orders/approve", { cartRef: c.ref, csrf: c.csrf, orderId: created.body.orderId })).body.state).toBe("ORDER_UNKNOWN");
    const unauth = await fetch(`${m.localUrl}/operator/reconcile?cart=${c.ref}`);
    expect(unauth.status).toBe(401);
    const op = await fetch(`${m.localUrl}/operator/reconcile?cart=${c.ref}`, { headers: { Authorization: `Bearer ${OPERATOR_KEY}` } });
    expect((await op.json()).state).toBe("ORDER_CONFIRMED");
    expect(m.mock!.calls.capture).toBe(1); // the GET showed the capture had happened: no second capture
  });

  it("create-order timeout → ORDER_UNKNOWN and no automatic retry", async () => {
    m = await startMockMerchant({ mockKnobs: { createTimeout: true } });
    const { b, c, created } = await cartWithOrder(m);
    expect(created.body.error).toBe("ORDER_OUTCOME_UNKNOWN");
    expect((await b.api("/api/checkout/orders", { cartRef: c.ref, csrf: c.csrf })).body.error).toBe("ORDER_STATE_UNKNOWN");
    expect(m.mock!.calls.create).toBe(1);
  });

  it("buyer cancel is honored only while PayPal shows the order un-approved", async () => {
    m = await startMockMerchant({ storeKnobs: { neverCapture: true } });
    const a = await cartWithOrder(m);
    expect((await a.b.api("/api/checkout/orders/cancel", { cartRef: a.c.ref, csrf: a.c.csrf, orderId: a.created.body.orderId })).body.state).toBe("ORDER_CANCELLED");
    const b2 = await cartWithOrder(await (async () => { await m!.close(); m = await startMockMerchant({ storeKnobs: { neverCapture: true } }); return m; })());
    m!.mock!.buyerApprove(b2.created.body.orderId);
    await b2.b.api("/api/checkout/orders/approve", { cartRef: b2.c.ref, csrf: b2.c.csrf, orderId: b2.created.body.orderId });
    expect((await b2.b.api("/api/checkout/orders/cancel", { cartRef: b2.c.ref, csrf: b2.c.csrf, orderId: b2.created.body.orderId })).body.state).toBe("BUYER_APPROVED");
  });

  it("the return page distinguishes a browser return from a confirmed order", async () => {
    m = await startMockMerchant();
    const { b, c, created } = await cartWithOrder(m);
    const before = await (await fetch(`${m.localUrl}/order/return?cart=${c.ref}`)).text();
    expect(before).toContain("not</b> proof of payment");
    expect(before).not.toContain("data-order-confirmation");
    m.mock!.buyerApprove(created.body.orderId);
    await b.api("/api/checkout/orders/approve", { cartRef: c.ref, csrf: c.csrf, orderId: created.body.orderId });
    const after = await (await fetch(`${m.localUrl}/order/return?cart=${c.ref}`)).text();
    expect(after).toContain("data-order-confirmation");
    expect(after).toContain("Fulfillment: NOT_VERIFIED");
  });
});

describe("order status endpoint", () => {
  it("is non-sensitive, nonce-bound and HMAC-signed; maps states without inventing outcomes", async () => {
    m = await startMockMerchant();
    const { c } = await cartWithOrder(m);
    const r = await fetch(`${m.localUrl}/api/orders/status?cart=${c.ref}&nonce=abcdefghijklmnop1234`);
    const body = await r.text();
    expect(r.headers.get("x-merchant-signature")).toBe(`v1=${createHmac("sha256", STATUS_SECRET).update(body).digest("hex")}`);
    const j = JSON.parse(body);
    expect(j).toMatchObject({ nonce: "abcdefghijklmnop1234", state: "ORDER_CREATED", sellerStatus: "UNKNOWN", fulfillment: "NOT_VERIFIED", totalMinor: 10760, sku: "LUM-Q3-B" });
    expect(body).not.toMatch(/MOCKORDER\d{6}/); // only a 4-char suffix of the PayPal id
    expect(body).not.toContain(c.csrf);
    expect((await fetch(`${m.localUrl}/api/orders/status?cart=${c.ref}&nonce=short`)).status).toBe(400);
    expect(sellerStatusOf("ORDER_CONFIRMED", true, false)).toBe("UNKNOWN");
    expect(sellerStatusOf("ORDER_CONFIRMED", false, true)).toBe("UNKNOWN");
    expect(sellerStatusOf("ORDER_CANCELLED", true, false)).toBe("NO_ORDER");
    expect(sellerStatusOf("PAYMENT_DENIED", true, true)).toBe("UNKNOWN");
    expect(sellerStatusOf("BUYER_APPROVED", true, true)).toBe("UNKNOWN");
  });
  it("is unsigned when no status secret is configured", async () => {
    m = await startMerchantServer({ config: loadMerchantConfig({ MERCHANT_LISTEN_PORT: "0" }) });
    const r = await fetch(`${m.localUrl}/api/orders/status?cart=cart_${"0".repeat(24)}&nonce=abcdefghijklmnop1234`);
    expect(r.headers.get("x-merchant-signature")).toBeNull();
    expect((await r.json()).sellerStatus).toBe("UNKNOWN");
  });
});

describe("Sandbox modes against a FAKE Sandbox REST backend (offline)", () => {
  it("SANDBOX_POPUP_TEST: SDK v6 button, Sandbox-only hosts, PayPal-Request-Id, and NO capture", async () => {
    const pp = fakeSandboxPayPal();
    const env = sandboxEnv("C1");
    m = await startMerchantServer({ config: loadMerchantConfig(env), fetchImpl: pp.fetchImpl });
    const b = new Buyer(m, ORIGIN);
    await b.addToCart();
    const c = await b.cart();
    expect(c.html).toContain('<paypal-button id="paypal-button" type="pay" hidden');
    expect(c.html).toContain('data-sdk-url="https://www.sandbox.paypal.com/web-sdk/v6/core"');
    expect(c.headers.get("cross-origin-opener-policy")).toBe("same-origin-allow-popups");
    const csp = c.headers.get("content-security-policy")!;
    expect(csp).toContain("script-src 'self' https://www.sandbox.paypal.com;");
    expect(csp).not.toMatch(/\*|https:\/\/www\.paypal\.com|unsafe-eval/);
    const created = await b.api("/api/checkout/orders", { cartRef: c.ref, csrf: c.csrf });
    expect(created.status).toBe(201);
    pp.buyerApproves(created.body.orderId);
    const appr = await b.api("/api/checkout/orders/approve", { cartRef: c.ref, csrf: c.csrf, orderId: created.body.orderId });
    expect(appr.body.state).toBe("BUYER_APPROVED");
    expect(new Set(pp.requests.map((r) => new URL(r.url).origin))).toEqual(new Set(["https://api-m.sandbox.paypal.com"]));
    expect(pp.requests.some((r) => r.url.endsWith("/capture"))).toBe(false);
    const create = pp.requests.find((r) => r.method === "POST" && r.url.endsWith("/v2/checkout/orders"))!;
    // Bound to the approval run, not the cart: a second instance would get this same order back and fail custom_id.
    expect(create.headers["PayPal-Request-Id"]).toBe(`phc-create-run-${env.PHASE_C_APPROVED_DIGEST}`);
    expect(JSON.parse(create.body).purchase_units[0]).toMatchObject({ custom_id: c.ref, payee: { merchant_id: "SANDBOXSELLER01" }, amount: { currency_code: "USD", value: "107.60" } });
  });

  it("caps Sandbox orders at the approved number, across restarts", async () => {
    const pp = fakeSandboxPayPal();
    const env = sandboxEnv("C1");
    m = await startMerchantServer({ config: loadMerchantConfig(env), fetchImpl: pp.fetchImpl });
    const first = new Buyer(m, ORIGIN); await first.addToCart(); const c1 = await first.cart();
    expect((await first.api("/api/checkout/orders", { cartRef: c1.ref, csrf: c1.csrf })).status).toBe(201);
    await m.close();
    m = await startMerchantServer({ config: loadMerchantConfig(env), fetchImpl: pp.fetchImpl });
    const second = new Buyer(m, ORIGIN); await second.addToCart(); const c2 = await second.cart();
    expect((await second.api("/api/checkout/orders", { cartRef: c2.ref, csrf: c2.csrf })).body.error).toBe("ORDER_CAP_REACHED");
    expect(pp.requests.filter((r) => r.method === "POST" && r.url.endsWith("/v2/checkout/orders")).length).toBe(1);
  });

  it("refuses new orders once the approval window ends", async () => {
    const pp = fakeSandboxPayPal();
    let t = Date.now();
    m = await startMerchantServer({ config: loadMerchantConfig(sandboxEnv("C1", {}, t), t), fetchImpl: pp.fetchImpl, now: () => t });
    const b = new Buyer(m, ORIGIN); await b.addToCart(); const c = await b.cart();
    t += 2 * 3600_000;
    expect((await b.api("/api/checkout/orders", { cartRef: c.ref, csrf: c.csrf })).body.error).toMatch(/APPROVAL_EXPIRED|CART_EXPIRED/);
    expect(pp.requests.length).toBe(0);
  });

  it("SANDBOX_APPROVAL_TEST: one seller-side capture with a stable PayPal-Request-Id → ORDER_CONFIRMED", async () => {
    const pp = fakeSandboxPayPal();
    m = await startMerchantServer({ config: loadMerchantConfig(sandboxEnv("C2")), fetchImpl: pp.fetchImpl });
    const b = new Buyer(m, ORIGIN); await b.addToCart(); const c = await b.cart();
    const created = await b.api("/api/checkout/orders", { cartRef: c.ref, csrf: c.csrf });
    pp.buyerApproves(created.body.orderId);
    await Promise.all([1, 2, 3].map(() => b.api("/api/checkout/orders/approve", { cartRef: c.ref, csrf: c.csrf, orderId: created.body.orderId })));
    const caps = pp.requests.filter((r) => r.url.endsWith("/capture"));
    expect(caps.length).toBe(1);
    expect(caps[0]!.headers["PayPal-Request-Id"]).toBe(`phc-capture-${created.body.orderId}`);
    expect(m.checkout.publicStatus(c.ref)).toMatchObject({ state: "ORDER_CONFIRMED", payeeVerified: true, evidenceSource: "PAYPAL_SANDBOX_ORDERS_V2_SERVER_SIDE" });
  });

  it("SANDBOX_APPROVAL_TEST with a PENDING capture reports CAPTURE_PENDING, not success", async () => {
    const pp = fakeSandboxPayPal({ captureStatus: "PENDING" });
    m = await startMerchantServer({ config: loadMerchantConfig(sandboxEnv("C2")), fetchImpl: pp.fetchImpl });
    const b = new Buyer(m, ORIGIN); await b.addToCart(); const c = await b.cart();
    const created = await b.api("/api/checkout/orders", { cartRef: c.ref, csrf: c.csrf });
    pp.buyerApproves(created.body.orderId);
    expect((await b.api("/api/checkout/orders/approve", { cartRef: c.ref, csrf: c.csrf, orderId: created.body.orderId })).body.state).toBe("CAPTURE_PENDING");
  });

  it("never exposes the client secret or access token to the browser", async () => {
    const pp = fakeSandboxPayPal();
    m = await startMerchantServer({ config: loadMerchantConfig(sandboxEnv("C1")), fetchImpl: pp.fetchImpl });
    const b = new Buyer(m, ORIGIN); await b.addToCart(); const c = await b.cart();
    const created = await b.api("/api/checkout/orders", { cartRef: c.ref, csrf: c.csrf });
    const texts = [c.html, JSON.stringify(created.body),
      await (await fetch(`${m.localUrl}/api/checkout/config`)).text(),
      await (await fetch(`${m.localUrl}/static/checkout.js`)).text(),
      await (await fetch(`${m.localUrl}/p/off_lumen_q3`)).text(),
      await (await fetch(`${m.localUrl}/order/return?cart=${c.ref}`)).text(),
      await (await fetch(`${m.localUrl}/api/orders/status?cart=${c.ref}&nonce=abcdefghijklmnop1234`)).text()];
    for (const t of texts) {
      expect(t).not.toContain(FAKE_CLIENT_SECRET);
      expect(t).not.toContain("FAKE_ACCESS_TOKEN");
      expect(t).not.toContain(STATUS_SECRET);
      expect(t).not.toContain(OPERATOR_KEY);
    }
    expect(JSON.parse(texts[2]!)).toEqual({ mode: "SANDBOX_POPUP_TEST", provider: "PAYPAL_SANDBOX", sdkUrl: "https://www.sandbox.paypal.com/web-sdk/v6/core", clientId: "FAKE-SANDBOX-CLIENT-ID-not-a-real-id" });
    // The MOCK popup does not exist in Sandbox modes.
    expect((await fetch(`${m.localUrl}/mock-paypal/checkout?order=x`)).status).toBe(404);
    const source = readFileSync("apps/phase-c-test-merchant/public/checkout.js", "utf8");
    expect(source).not.toMatch(/secret|access_token|\/v1\/oauth2/i);
    expect(source).not.toMatch(/paypal\.Buttons|sdk\/js\?client-id/); // no SDK v5 API
  });

  it("records CSP-blocked hosts so a missing PayPal dependency can be named", async () => {
    const pp = fakeSandboxPayPal();
    m = await startMerchantServer({ config: loadMerchantConfig(sandboxEnv("C1")), fetchImpl: pp.fetchImpl });
    await fetch(`${m.localUrl}/api/csp-report`, { method: "POST", headers: { "Content-Type": "application/csp-report" }, body: JSON.stringify({ "csp-report": { "blocked-uri": "https://www.paypalobjects.com/x.js" } }) });
    const d = await (await fetch(`${m.localUrl}/operator/diagnostics`, { headers: { Authorization: `Bearer ${OPERATOR_KEY}` } })).json();
    expect(d.cspBlockedHosts).toEqual({ "www.paypalobjects.com": 1 });
    expect(d.counters).toMatchObject({ ordersCreated: 0, maxOrders: 1, maxCaptures: 0 });
    expect(JSON.stringify(d)).not.toContain(FAKE_CLIENT_SECRET);
  });
});

it("mockConfig has no Sandbox credentials", () => { expect(mockConfig().paypal).toBeNull(); });
