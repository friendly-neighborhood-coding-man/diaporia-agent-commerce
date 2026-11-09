import { afterEach, describe, expect, it } from "vitest";
import { request } from "node:http";
import { PayPalSandboxProvider, PAYPAL_SANDBOX_API } from "../src/payment/PayPalCheckoutAdapter.js";
import { ProviderError, ProviderTimeoutError } from "../src/payment/PaymentProvider.js";
import { call, mcpClient, researchAndCompare, startHarness, TOKENS, type Harness } from "./helpers.js";

const fakeSecret = "test-client-secret-should-never-leak";
type Call = { url: string; init: RequestInit };

function fakeFetch(handler: (url: string, init: RequestInit) => { status: number; body?: unknown; throws?: Error }) {
  const calls: Call[] = [];
  const f = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const r = handler(String(url), init);
    if (r.throws) throw r.throws;
    return new Response(r.body === undefined ? "" : JSON.stringify(r.body), { status: r.status, headers: { "paypal-debug-id": "dbg123" } });
  }) as typeof fetch;
  return { f, calls };
}
const oauth = { status: 200, body: { access_token: "A21AAfake-access-token-value-0000000000", expires_in: 3600 } };

describe("PayPalSandboxProvider (offline, fake fetch)", () => {
  it("refuses any environment other than SANDBOX", () => {
    expect(() => new PayPalSandboxProvider({ clientId: "id", clientSecret: fakeSecret, env: "LIVE" })).toThrow(/SANDBOX/);
    expect(() => new PayPalSandboxProvider({ clientId: "", clientSecret: "", env: "SANDBOX" })).toThrow();
  });

  it("creates a CAPTURE order on the Sandbox host with an idempotency key and returns the sandbox approval link", async () => {
    const { f, calls } = fakeFetch((url) => url.endsWith("/v1/oauth2/token") ? oauth : {
      status: 201, body: { id: "5O190127TN364715T", status: "PAYER_ACTION_REQUIRED", links: [{ rel: "payer-action", href: "https://www.sandbox.paypal.com/checkoutnow?token=5O190127TN364715T" }] } });
    const p = new PayPalSandboxProvider({ clientId: "id", clientSecret: fakeSecret, env: "SANDBOX", fetchImpl: f });
    const out = await p.createOrder({ checkoutSessionId: "cs_1", amount: { currency: "USD", amountMinor: 5939 }, description: "demo", returnUrl: "http://127.0.0.1/r", cancelUrl: "http://127.0.0.1/c", idempotencyKey: "dac-create-1" });
    expect(out.approvalUrl).toMatch(/^https:\/\/www\.sandbox\.paypal\.com\//);
    expect(calls.every((c) => c.url.startsWith(PAYPAL_SANDBOX_API))).toBe(true);
    const create = calls[1]!;
    expect((create.init.headers as Record<string, string>)["PayPal-Request-Id"]).toBe("dac-create-1");
    const body = JSON.parse(String(create.init.body));
    expect(body.intent).toBe("CAPTURE");
    expect(body.purchase_units[0].amount).toEqual({ currency_code: "USD", value: "59.39" });
    expect(body.purchase_units[0].custom_id).toBe("cs_1");
  });

  it("maps network failures and 5xx to UNKNOWN-class errors, 4xx to definite errors, without leaking secrets", async () => {
    const timeout = fakeFetch((url) => url.endsWith("/token") ? oauth : { status: 0, throws: new DOMException("timed out", "TimeoutError") });
    const p1 = new PayPalSandboxProvider({ clientId: "id", clientSecret: fakeSecret, env: "SANDBOX", fetchImpl: timeout.f });
    await expect(p1.captureOrder("5O190127TN364715T", "k")).rejects.toBeInstanceOf(ProviderTimeoutError);

    const declined = fakeFetch((url) => url.endsWith("/token") ? oauth : { status: 422, body: { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "INSTRUMENT_DECLINED" }] } });
    const p2 = new PayPalSandboxProvider({ clientId: "id", clientSecret: fakeSecret, env: "SANDBOX", fetchImpl: declined.f });
    const err = await p2.captureOrder("5O190127TN364715T", "k").catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toMatch(/INSTRUMENT_DECLINED/);
    expect(err.message).not.toContain(fakeSecret);
    expect(err.message).not.toContain("A21AA");

    const server = fakeFetch((url) => url.endsWith("/token") ? oauth : { status: 503 });
    const p3 = new PayPalSandboxProvider({ clientId: "id", clientSecret: fakeSecret, env: "SANDBOX", fetchImpl: server.f });
    await expect(p3.getOrder("5O190127TN364715T")).rejects.toBeInstanceOf(ProviderTimeoutError);
  });

  it("parses PENDING captures and reads money as integer minor units", async () => {
    const { f } = fakeFetch((url) => url.endsWith("/token") ? oauth : { status: 201, body: { id: "5O190127TN364715T", status: "COMPLETED",
      purchase_units: [{ payments: { captures: [{ id: "3C679366HH908993F", status: "PENDING", status_details: { reason: "PENDING_REVIEW" }, amount: { currency_code: "USD", value: "59.39" } }] } }] } });
    const p = new PayPalSandboxProvider({ clientId: "id", clientSecret: fakeSecret, env: "SANDBOX", fetchImpl: f });
    const c = await p.captureOrder("5O190127TN364715T", "k");
    expect(c).toEqual({ captureId: "3C679366HH908993F", status: "PENDING", amount: { currency: "USD", amountMinor: 5939 }, reason: "PENDING_REVIEW" });
  });
});

describe("HTTP hardening", () => {
  let h: Harness;
  afterEach(async () => { await h?.close(); });

  it("rejects oversized bodies, foreign Host headers and foreign Origins", async () => {
    h = await startHarness();
    const big = await fetch(`${h.url}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${TOKENS.alice}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: "x".repeat(70 * 1024) });
    expect(big.status).toBe(413);
    const origin = await fetch(`${h.url}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${TOKENS.alice}`, Origin: "https://evil.example", "Content-Type": "application/json" }, body: "{}" });
    expect(origin.status).toBe(403);
    const port = new URL(h.url).port;
    const status = await new Promise<number>((resolve) => {
      const r = request({ host: "127.0.0.1", port, path: "/healthz", headers: { Host: "attacker.example" } }, (res) => { res.resume(); resolve(res.statusCode!); });
      r.end();
    });
    expect(status).toBe(421);
  });

  it("public deployments (non-loopback base URL) disable payment execution", async () => {
    h = await startHarness({ baseUrl: "https://demo.example.org" });
    expect(h.app.paymentExecutionEnabled).toBe(false);
    const gw = h.app.gateway;
    const r = await gw.researchPurchase("alice", { request: "Buy Sony WH-CH720N Black, never exceed $60", currency: "USD" });
    await gw.compareOffers("alice", { researchSessionId: r.purchaseSessionId, productIdentity: { brand: "Sony", model: "WH-CH720N", variant: "Black", condition: "new", sku: "WHCH720N/B" }, destination: { country: "US", region: "CA" } });
    const prep = await gw.prepareCheckout("alice", { purchaseSessionId: r.purchaseSessionId, offerId: "off_alpha", maximumApprovedTotalMinor: 6000, currency: "USD", quantity: 1 });
    expect(prep.state).toBe("HOLD");
    expect(prep.policy?.code).toBe("PUBLIC_PAYMENT_DISABLED");
    expect(h.mock.calls.createOrder).toBe(0);
    // Owner, authorization, return and mock-payment routes do not exist publicly.
    const local = h.url;
    const routes: Array<[string, string]> = [["POST", "/owner/mandates"], ["GET", `/authorize/${prep.checkoutSessionId}`], ["GET", "/paypal/return?checkout=x&token=y"], ["GET", "/mock-paypal/checkout/MOCK0000000000000000"]];
    for (const [method, path] of routes) {
      const r = await new Promise<number>((resolve) => { const q = request({ host: "127.0.0.1", port: new URL(local).port, path, method, headers: { Host: "demo.example.org" } }, (res) => { res.resume(); resolve(res.statusCode!); }); q.end(); });
      expect([method, path, r]).toEqual([method, path, 403]);
    }
  });

  it("public-readonly-demo mode exposes no payment tools and needs no token", async () => {
    h = await startHarness({ authMode: "public-readonly-demo" });
    const client = await mcpClient(h.url);
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["compare_purchase_offers", "get_checkout_status", "get_purchase_receipt", "research_purchase"]);
    const { compare } = await researchAndCompare(client);
    expect(compare.lowestVerifiedEligibleOffer.offerId).toBe("off_alpha");
    expect(h.app.paymentExecutionEnabled).toBe(false);
    await client.close();
  });

  it("MCP responses never contain configured secrets", async () => {
    h = await startHarness();
    const client = await mcpClient(h.url, TOKENS.alice);
    const r = await client.callTool({ name: "research_purchase", arguments: { request: "Buy Sony WH-CH720N Black" } });
    const text = JSON.stringify(r);
    expect(text).not.toContain(TOKENS.alice);
    expect(await call(client, "research_purchase", { request: "Find wireless headphones" })).toBeTruthy();
    await client.close();
  });
});
