import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approvalDigest, buildApprovalStatement, loadAllowlist, loadMerchantConfig, DEFAULT_ALLOWLIST_PATH, type MerchantConfig } from "../apps/phase-c-test-merchant/src/config.js";
import { startMerchantServer, type MerchantServer, type MerchantServerOptions } from "../apps/phase-c-test-merchant/src/server.js";
import { readFileSync } from "node:fs";

// Obviously fake test values, assembled at runtime so secret scanners do not see literal assignments.
export const STATUS_SECRET = ["phase-c", "status", "test", "value", "0".repeat(20)].join("-");
export const OPERATOR_KEY = ["phase-c", "operator", "test", "value", "0".repeat(20)].join("-");
export const FAKE_CLIENT_ID = "FAKE-SANDBOX-CLIENT-ID-not-a-real-id";
export const FAKE_CLIENT_SECRET = ["FAKE", "SANDBOX", "CLIENT", "SECRET", "MUST", "NEVER", "REACH", "BROWSER"].join("_");
export const SELLER_ID = "SANDBOXSELLER01";
export const ORIGIN = "https://phase-c.operator-shop.com";
export const allowlistText = () => readFileSync(DEFAULT_ALLOWLIST_PATH, "utf8");

export function mockConfig(extra: Record<string, string> = {}): MerchantConfig {
  return loadMerchantConfig({ MERCHANT_LISTEN_PORT: "0", MERCHANT_STATUS_SECRET: STATUS_SECRET, MERCHANT_OPERATOR_KEY: OPERATOR_KEY, ...extra });
}

/** Builds a Sandbox-mode environment whose digest matches, exactly as the operator would after owner approval. */
export function sandboxEnv(gate: "C1" | "C2", over: Record<string, string | undefined> = {}, now = Date.now()): Record<string, string> {
  const expiresAt = new Date(now + 3600_000).toISOString();
  const statement = buildApprovalStatement({ gate, merchantOrigin: ORIGIN, allowlist: loadAllowlist(allowlistText()), sellerMerchantId: SELLER_ID,
    maxMinutes: 10, maxKernelUsd: "0.50", expiresAt });
  const env: Record<string, string | undefined> = {
    MERCHANT_CHECKOUT_MODE: gate === "C1" ? "SANDBOX_POPUP_TEST" : "SANDBOX_APPROVAL_TEST", MERCHANT_PUBLIC_ORIGIN: ORIGIN, MERCHANT_LISTEN_PORT: "0",
    MERCHANT_PAYPAL_CLIENT_ID: FAKE_CLIENT_ID, MERCHANT_PAYPAL_CLIENT_SECRET: FAKE_CLIENT_SECRET, MERCHANT_PAYPAL_SELLER_MERCHANT_ID: SELLER_ID,
    MERCHANT_DATA_DIR: mkdtempSync(join(tmpdir(), "phc-")), MERCHANT_STATUS_SECRET: STATUS_SECRET, MERCHANT_OPERATOR_KEY: OPERATOR_KEY,
    PHASE_C_APPROVAL_EXPIRES_AT: expiresAt, PHASE_C_MAX_MINUTES: "10", PHASE_C_MAX_KERNEL_USD: "0.50", PHASE_C_APPROVED_DIGEST: approvalDigest(statement), ...over,
  };
  return Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined)) as Record<string, string>;
}

export async function startMockMerchant(o: Omit<MerchantServerOptions, "config"> & { env?: Record<string, string> } = {}): Promise<MerchantServer> {
  const { env, ...rest } = o;
  return startMerchantServer({ config: mockConfig(env), ...rest });
}

/** A tiny cookie-keeping buyer browser for HTTP-level merchant tests (no Chromium). */
export class Buyer {
  cookie = "";
  constructor(readonly m: { localUrl: string; origin: string }, readonly originHeader = m.origin) {}
  async addToCart(variant = "Black", qty = "1") {
    const r = await fetch(`${this.m.localUrl}/cart/add`, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: this.originHeader, ...(this.cookie ? { Cookie: this.cookie } : {}) },
      body: new URLSearchParams({ variant, qty }).toString() });
    const sc = r.headers.get("set-cookie");
    if (sc) this.cookie = sc.split(";")[0]!;
    return { status: r.status, text: await r.text() };
  }
  async cart() {
    const r = await fetch(`${this.m.localUrl}/cart`, { headers: this.cookie ? { Cookie: this.cookie } : {} });
    const html = await r.text();
    return { html, headers: r.headers, ref: /data-cart-ref="([^"]+)"/.exec(html)?.[1] ?? "", csrf: /data-csrf="([^"]+)"/.exec(html)?.[1] ?? "" };
  }
  async api(path: string, body: Record<string, unknown>, headers: Record<string, string> = {}) {
    const r = await fetch(`${this.m.localUrl}${path}`, { method: "POST", headers: { "Content-Type": "application/json", Origin: this.originHeader, ...(this.cookie ? { Cookie: this.cookie } : {}), ...headers }, body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
  }
}

/**
 * Fake PayPal Sandbox REST backend (offline). It answers only https://api-m.sandbox.paypal.com and records every request
 * so tests can assert hosts, idempotency headers and that capture never happens in the popup-test mode.
 */
export function fakeSandboxPayPal(opts: { captureStatus?: "COMPLETED" | "PENDING" } = {}) {
  const requests: Array<{ url: string; method: string; headers: Record<string, string>; body: string }> = [];
  const orders = new Map<string, any>();
  const byReq = new Map<string, string>();
  let seq = 0;
  const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "PayPal-Debug-Id": "fake-debug" } });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    requests.push({ url: url.href, method: init?.method ?? "GET", headers, body: String(init?.body ?? "") });
    if (url.origin !== "https://api-m.sandbox.paypal.com") throw new TypeError("fake: refused non-sandbox host");
    if (url.pathname === "/v1/oauth2/token") return res(200, { access_token: "FAKE_ACCESS_TOKEN_x", expires_in: 3200 });
    if (init?.method === "POST" && url.pathname === "/v2/checkout/orders") {
      const rid = headers["PayPal-Request-Id"]!;
      if (byReq.has(rid)) return res(200, orders.get(byReq.get(rid)!));
      const id = `5O${String(++seq).padStart(15, "0")}`;
      const b = JSON.parse(String(init.body));
      orders.set(id, { id, status: "CREATED", purchase_units: b.purchase_units });
      byReq.set(rid, id);
      return res(201, orders.get(id));
    }
    const m = /^\/v2\/checkout\/orders\/([A-Z0-9]+)(\/capture)?$/.exec(url.pathname);
    if (m && orders.has(m[1]!)) {
      const o = orders.get(m[1]!);
      if (!m[2]) return res(200, o);
      if (o.status !== "APPROVED") return res(422, { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "ORDER_NOT_APPROVED" }] });
      o.status = "COMPLETED";
      o.purchase_units[0].payments = { captures: [{ id: "3C000000000000001", status: opts.captureStatus ?? "COMPLETED", amount: o.purchase_units[0].amount }] };
      return res(201, o);
    }
    return res(404, { name: "RESOURCE_NOT_FOUND" });
  }) as typeof fetch;
  return { fetchImpl, requests, orders, buyerApproves: (id: string) => { orders.get(id).status = "APPROVED"; } };
}
