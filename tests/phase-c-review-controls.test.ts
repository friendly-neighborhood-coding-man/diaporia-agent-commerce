/**
 * PR #6 review controls (offline): durable per-approval KERNEL browser ledger, single-instance merchant with durable
 * spend slots, read-only C3 reconciliation, and a separately approved C2 capture retry. No PayPal, no KERNEL, no network.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigRefusedError, approvalDigest, buildCaptureRetryStatement, loadMerchantConfig } from "../apps/phase-c-test-merchant/src/config.js";
import { startMerchantServer, type MerchantServer } from "../apps/phase-c-test-merchant/src/server.js";
import { LedgerRefusedError } from "../apps/phase-c-test-merchant/src/spendLedger.js";
import { KernelDriver } from "../src/handoff/drivers.js";
import { KernelCreationLedger, KernelLedgerExhausted } from "../src/handoff/kernelLedger.js";
import { configureHandoffFromEnv, phaseCKernelLedgerFromEnv } from "../src/handoff/config.js";
import { MerchantRecipeRegistry } from "../src/handoff/recipes.js";
import { phaseCBrowserHosts, phaseCRecipe } from "../src/handoff/phaseCMerchant.js";
import { fixtureRecipe } from "../src/handoff/fixtureMerchant.js";
import { Buyer, OPERATOR_KEY, ORIGIN, allowlistText, fakeSandboxPayPal, otherSign, ownerSign, sandboxEnv } from "./phase-c-helpers.js";

const servers: MerchantServer[] = [];
const start = async (...a: Parameters<typeof startMerchantServer>) => { const s = await startMerchantServer(...a); servers.push(s); return s; };
afterEach(async () => { for (const s of servers.splice(0)) await s.close(); });
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const DIGEST = "a".repeat(64);

// ---------------------------------------------------------------- 1. KERNEL creation ledger
function fakeKernelApi(opts: { failCreate?: boolean } = {}) {
  const log: string[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const u = new URL(String(input)); const method = init?.method ?? "GET";
    log.push(`${method} ${u.pathname}`);
    if (method === "POST" && u.pathname === "/browsers") {
      if (opts.failCreate) throw new TypeError("fake: connection reset");
      return Response.json({ session_id: `kb_${log.length}`, browser_live_view_url: "https://live.test/x?jwt=LIVE_SECRET" });
    }
    if (method === "GET" && u.pathname === "/browsers") return Response.json([]);
    if (method === "DELETE") return new Response(null, { status: 204 });
    return Response.json({ success: true, result: null });
  }) as typeof fetch;
  return { fetchImpl, creates: () => log.filter((l) => l === "POST /browsers").length };
}
const driverWith = (k: ReturnType<typeof fakeKernelApi>, ledger: KernelCreationLedger, maxSessions = 3) =>
  new KernelDriver("sk_test_kernel_key_000", { allowLive: true, fetchImpl: k.fetchImpl, baseUrl: "https://api.kernel.test", maxSessions, creationLedger: ledger });
const openArgs = { label: "phase-c-c1", merchantHost: "m", allowedHosts: null, timeoutSeconds: 60 };

describe("durable per-approval KERNEL browser-creation ledger", () => {
  it("one browser per approval survives a restart (the per-process cap alone would reset)", async () => {
    const dir = tmp("kled-");
    const k = fakeKernelApi();
    const first = driverWith(k, new KernelCreationLedger({ runId: DIGEST, maxBrowsers: 1, dir }));
    const s = await first.open(openArgs);
    await s.close();
    // "Restart": new process state, fresh per-process counter, same durable ledger.
    const restarted = driverWith(k, new KernelCreationLedger({ runId: DIGEST, maxBrowsers: 1, dir }));
    expect(restarted.sessionsCreated).toBe(0);
    await expect(restarted.open(openArgs)).rejects.toBeInstanceOf(KernelLedgerExhausted);
    expect(k.creates()).toBe(1);
    // A different approval (new digest) is a different run.
    const other = driverWith(k, new KernelCreationLedger({ runId: "b".repeat(64), maxBrowsers: 1, dir }));
    await (await other.open(openArgs)).close();
    expect(k.creates()).toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });

  it("a create whose outcome is unknown still consumes the slot", async () => {
    const dir = tmp("kled-");
    const failing = fakeKernelApi({ failCreate: true });
    await expect(driverWith(failing, new KernelCreationLedger({ runId: DIGEST, maxBrowsers: 1, dir })).open(openArgs)).rejects.toThrow(/reset/);
    const k = fakeKernelApi();
    await expect(driverWith(k, new KernelCreationLedger({ runId: DIGEST, maxBrowsers: 1, dir })).open(openArgs)).rejects.toBeInstanceOf(KernelLedgerExhausted);
    expect(k.creates()).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it("two drivers sharing the ledger (two processes on one host) cannot both create", async () => {
    const dir = tmp("kled-");
    const k = fakeKernelApi();
    const a = driverWith(k, new KernelCreationLedger({ runId: DIGEST, maxBrowsers: 1, dir }));
    const b = driverWith(k, new KernelCreationLedger({ runId: DIGEST, maxBrowsers: 1, dir }));
    const r = await Promise.allSettled([a.open(openArgs), b.open(openArgs)]);
    expect(r.filter((x) => x.status === "fulfilled").length).toBe(1);
    expect(r.filter((x) => x.status === "rejected" && x.reason instanceof KernelLedgerExhausted).length).toBe(1);
    expect(k.creates()).toBe(1);
    for (const x of r) if (x.status === "fulfilled") await x.value.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("a Phase C KERNEL configuration needs the approved digest; other recipes are unaffected", async () => {
    const reg = new MerchantRecipeRegistry([phaseCRecipe("https://phase-c.operator-shop.com", phaseCBrowserHosts(allowlistText()))], { allowLoopbackOrigin: false });
    expect(() => phaseCKernelLedgerFromEnv({}, reg)).toThrow(/PHASE_C_APPROVED_DIGEST/);
    expect(() => phaseCKernelLedgerFromEnv({ PHASE_C_APPROVED_DIGEST: "not-a-digest" }, reg)).toThrow(/PHASE_C_APPROVED_DIGEST/);
    expect(() => phaseCKernelLedgerFromEnv({ PHASE_C_APPROVED_DIGEST: DIGEST }, reg)).toThrow(/STATEMENT_FILE/);
    const dir = tmp("kled-");
    // Any KERNEL recipe for the fictional Phase C domain is Phase C (it is the only real merchant on that name); other merchants are unaffected.
    const otherShop = { ...phaseCRecipe("https://phase-c.operator-shop.com", phaseCBrowserHosts(allowlistText())), recipeId: "other-v1", merchantDomain: "other-shop.example" };
    expect(phaseCKernelLedgerFromEnv({}, new MerchantRecipeRegistry([otherShop], { allowLoopbackOrigin: false }))).toBeNull();
    expect(fixtureRecipe("http://127.0.0.1:1").recipeId).toBe("fixture-bravo-v0");
    // Refused before any provider call.
    const file = join(dir, "recipes.json");
    writeFileSync(file, JSON.stringify([phaseCRecipe("https://phase-c.operator-shop.com", phaseCBrowserHosts(allowlistText()))]));
    const spy = vi.spyOn(globalThis, "fetch");
    await expect(configureHandoffFromEnv({ HANDOFF_DRIVER: "kernel", DIAPORIA_ALLOW_KERNEL_LIVE: "1", KERNEL_API_KEY: "test-not-a-key", HANDOFF_RECIPES_FILE: file })).rejects.toThrow(/PHASE_C_APPROVED_DIGEST/);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------- 2. single instance + durable spend slots
describe("merchant: one instance per approval, durable order/capture slots", () => {
  it("a second instance on the same data dir is refused before it can spend", async () => {
    const pp = fakeSandboxPayPal();
    const env = sandboxEnv("C1");
    await start({ config: loadMerchantConfig(env), fetchImpl: pp.fetchImpl });
    await expect(startMerchantServer({ config: loadMerchantConfig(env), fetchImpl: pp.fetchImpl })).rejects.toMatchObject({ code: "INSTANCE_LEASE_HELD" });
    expect(pp.requests.length).toBe(0);
  });

  it("a crashed instance's lease is never taken over automatically", async () => {
    const env = sandboxEnv("C1");
    writeFileSync(join(env.MERCHANT_DATA_DIR!, "instance.lease"), JSON.stringify({ v: 1, token: "x", pid: 999999, host: "elsewhere", startedAt: "2026-11-10T00:00:00Z" }));
    await expect(startMerchantServer({ config: loadMerchantConfig(env), fetchImpl: fakeSandboxPayPal().fetchImpl })).rejects.toBeInstanceOf(LedgerRefusedError);
    unlinkSync(join(env.MERCHANT_DATA_DIR!, "instance.lease")); // the operator, after checking
    await start({ config: loadMerchantConfig(env), fetchImpl: fakeSandboxPayPal().fetchImpl });
  });

  it("the data dir is part of the approval: another dir cannot reuse the digest, and a used dir cannot take a new approval", async () => {
    const env = sandboxEnv("C1");
    expect(() => loadMerchantConfig({ ...env, MERCHANT_DATA_DIR: tmp("phc-other-") })).toThrow(ConfigRefusedError);
    expect(() => loadMerchantConfig({ ...env, MERCHANT_DATA_DIR: "relative/dir" })).toThrow(/absolute/);
    const m = await start({ config: loadMerchantConfig(env), fetchImpl: fakeSandboxPayPal().fetchImpl });
    await m.close(); servers.pop();
    const c2 = sandboxEnv("C2", { MERCHANT_DATA_DIR: env.MERCHANT_DATA_DIR });
    await expect(startMerchantServer({ config: loadMerchantConfig(c2), fetchImpl: fakeSandboxPayPal().fetchImpl })).rejects.toMatchObject({ code: "DATA_DIR_BOUND_TO_OTHER_APPROVAL" });
  });

  it("the order cap holds even if the JSON state file is lost (slots are separate, exclusive, never deleted)", async () => {
    const pp = fakeSandboxPayPal();
    const env = sandboxEnv("C1");
    let m = await start({ config: loadMerchantConfig(env), fetchImpl: pp.fetchImpl });
    const b1 = new Buyer(m, ORIGIN); await b1.addToCart(); const c1 = await b1.cart();
    expect((await b1.api("/api/checkout/orders", { cartRef: c1.ref, csrf: c1.csrf })).status).toBe(201);
    await m.close(); servers.pop();
    unlinkSync(join(env.MERCHANT_DATA_DIR!, "merchant-state.json"));
    m = await start({ config: loadMerchantConfig(env), fetchImpl: pp.fetchImpl });
    const b2 = new Buyer(m, ORIGIN); await b2.addToCart(); const c2 = await b2.cart();
    expect((await b2.api("/api/checkout/orders", { cartRef: c2.ref, csrf: c2.csrf })).body.error).toBe("ORDER_CAP_REACHED");
    expect(pp.requests.filter((r) => r.method === "POST" && r.url.endsWith("/v2/checkout/orders")).length).toBe(1);
    expect(readdirSync(join(env.MERCHANT_DATA_DIR!, `run-${env.PHASE_C_APPROVED_DIGEST}`))).toEqual(["order-slot-0"]);
    expect(m.checkout.counters()).toMatchObject({ ordersCreated: 1, durableLedger: true });
  });

  it("a clean stop releases the lease (restart works) but keeps every slot", async () => {
    const env = sandboxEnv("C1");
    const m = await start({ config: loadMerchantConfig(env), fetchImpl: fakeSandboxPayPal().fetchImpl });
    expect(existsSync(join(env.MERCHANT_DATA_DIR!, "instance.lease"))).toBe(true);
    await m.close(); servers.pop();
    expect(existsSync(join(env.MERCHANT_DATA_DIR!, "instance.lease"))).toBe(false);
    expect(existsSync(join(env.MERCHANT_DATA_DIR!, "approval.json"))).toBe(true);
  });
});

// ---------------------------------------------------------------- 3. read-only C3, separate C2 retry gate
/** Fake Sandbox where the FIRST capture request is lost before it reaches PayPal (connection reset). */
function lostFirstCapture() {
  const pp = fakeSandboxPayPal();
  let dropped = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).endsWith("/capture") && dropped === 0) { dropped++; throw new TypeError("fake: socket hang up"); }
    return pp.fetchImpl(input, init);
  }) as typeof fetch;
  return { ...pp, fetchImpl, captures: () => pp.requests.filter((r) => r.url.endsWith("/capture")) };
}
const op = (m: MerchantServer, path: string, init: RequestInit = {}) =>
  fetch(`${m.localUrl}${path}`, { ...init, headers: { Authorization: `Bearer ${OPERATOR_KEY}`, ...(init.body ? { "Content-Type": "application/json" } : {}), ...(init.headers ?? {}) } });

async function c2LostCapture() {
  const pp = lostFirstCapture();
  const env = sandboxEnv("C2");
  const m = await start({ config: loadMerchantConfig(env), fetchImpl: pp.fetchImpl });
  const b = new Buyer(m, ORIGIN); await b.addToCart(); const c = await b.cart();
  const created = await b.api("/api/checkout/orders", { cartRef: c.ref, csrf: c.csrf });
  pp.buyerApproves(created.body.orderId);
  expect((await b.api("/api/checkout/orders/approve", { cartRef: c.ref, csrf: c.csrf, orderId: created.body.orderId })).body.state).toBe("ORDER_UNKNOWN");
  const retryDigest = approvalDigest(buildCaptureRetryStatement({ c2ApprovalDigest: env.PHASE_C_APPROVED_DIGEST!, cartRef: c.ref, merchantOrderRef: m.checkout.get(c.ref)!.merchantOrderRef }));
  return { pp, env, m, c, orderId: created.body.orderId as string, retryDigest };
}

describe("C3 reconciliation is read-only; capture retry is a separate, owner-approved C2 mutation", () => {
  it("POST /operator/reconcile is refused (405), including the old retryCapture flag", async () => {
    const { m, c, pp } = await c2LostCapture();
    const r = await op(m, "/operator/reconcile", { method: "POST", body: JSON.stringify({ cartRef: c.ref, retryCapture: true }) });
    expect(r.status).toBe(405);
    expect((await r.json()).error).toBe("RECONCILE_IS_GET_ONLY");
    expect(pp.captures().length).toBe(0);
  });

  it("GET reconcile moves ORDER_UNKNOWN to BUYER_APPROVED from evidence and never captures", async () => {
    const { m, c, pp } = await c2LostCapture();
    for (let i = 0; i < 3; i++) expect((await (await op(m, `/operator/reconcile?cart=${c.ref}`)).json()).state).toBe("BUYER_APPROVED");
    expect(pp.captures().length).toBe(0);
    expect(pp.requests.filter((r) => r.method !== "GET" && !r.url.endsWith("/oauth2/token")).length).toBe(1); // only the original create
  });

  it("retry needs reconcile first, the exact owner-approved digest, and happens at most once with the same request id", async () => {
    const { m, c, pp, orderId, retryDigest } = await c2LostCapture();
    const retry = (d: string, sig = ownerSign("capture-retry", d)) => op(m, "/operator/c2/retry-capture", { method: "POST", body: JSON.stringify({ cartRef: c.ref, retryApprovalDigest: d, ownerSignature: sig }) });
    expect((await retry(retryDigest)).status).toBe(409); // RECONCILE_FIRST: still ORDER_UNKNOWN
    await op(m, `/operator/reconcile?cart=${c.ref}`);
    expect((await retry("0".repeat(64))).status).toBe(403);
    expect((await (await op(m, "/operator/c2/retry-capture", { method: "POST", body: JSON.stringify({ cartRef: c.ref }) })).json()).error).toBe("RETRY_APPROVAL_DIGEST_MISMATCH");
    // The digest is public knowledge; without the OWNER's signature it authorizes nothing.
    for (const sig of ["", otherSign("capture-retry", retryDigest), ownerSign("approval", retryDigest)])
      expect((await (await retry(retryDigest, sig)).json()).error).toBe("RETRY_OWNER_SIGNATURE_INVALID");
    expect(pp.captures().length).toBe(0);
    const ok = await retry(retryDigest);
    expect((await ok.json()).state).toBe("ORDER_CONFIRMED");
    expect(pp.captures().map((x) => x.headers["PayPal-Request-Id"])).toEqual([`phc-capture-${orderId}`]);
    expect((await retry(retryDigest)).status).toBe(409); // nothing left to retry
    expect(pp.captures().length).toBe(1);
    expect(m.checkout.counters()).toMatchObject({ capturesAttempted: 1, captureRetries: 1 });
  });

  it("the retry route cannot capture in C1 (popup test)", async () => {
    const pp = fakeSandboxPayPal();
    const env = sandboxEnv("C1");
    const m = await start({ config: loadMerchantConfig(env), fetchImpl: pp.fetchImpl });
    const b = new Buyer(m, ORIGIN); await b.addToCart(); const c = await b.cart();
    const created = await b.api("/api/checkout/orders", { cartRef: c.ref, csrf: c.csrf });
    pp.buyerApproves(created.body.orderId);
    await b.api("/api/checkout/orders/approve", { cartRef: c.ref, csrf: c.csrf, orderId: created.body.orderId });
    const d = approvalDigest(buildCaptureRetryStatement({ c2ApprovalDigest: env.PHASE_C_APPROVED_DIGEST!, cartRef: c.ref, merchantOrderRef: m.checkout.get(c.ref)!.merchantOrderRef }));
    const r = await op(m, "/operator/c2/retry-capture", { method: "POST", body: JSON.stringify({ cartRef: c.ref, retryApprovalDigest: d, ownerSignature: ownerSign("capture-retry", d) }) });
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe("CAPTURE_NOT_ALLOWED_IN_MODE");
    expect(pp.requests.some((x) => x.url.endsWith("/capture"))).toBe(false);
  });

  it("the reconcile code path has no capture call", async () => {
    const src = (await import("node:fs")).readFileSync("apps/phase-c-test-merchant/src/orders.ts", "utf8");
    const body = src.slice(src.indexOf("async reconcile("), src.indexOf("async retryCaptureApproved("));
    expect(body).not.toMatch(/capture\(|captureOrder|createOrder/);
  });
});

// ---------------------------------------------------------------- 5. payment-surface evidence
describe("payment-surface evidence for presentationMode auto", () => {
  it("the Sandbox checkout reports which surface opened, and the operator sees it in diagnostics", async () => {
    const src = (await import("node:fs")).readFileSync("apps/phase-c-test-merchant/public/checkout.js", "utf8");
    for (const code of ["SURFACE_POPUP_OPENED", "SURFACE_POPUP_BLOCKED", "SURFACE_IFRAME_ADDED", "SURFACE_PAGE_LEFT", "SESSION_START_CALLED"]) expect(src).toContain(code);
    expect(src.indexOf("window.open = function")).toBeGreaterThan(src.indexOf('if (mode === "MOCK")')); // MOCK path untouched
    const m = await start({ config: loadMerchantConfig(sandboxEnv("C1")), fetchImpl: fakeSandboxPayPal().fetchImpl });
    const b = new Buyer(m, ORIGIN); await b.addToCart(); const c = await b.cart();
    expect((await b.api("/api/checkout/sdk-event", { cartRef: c.ref, csrf: c.csrf, code: "SURFACE_POPUP_OPENED" })).status).toBe(204);
    expect((await (await op(m, "/operator/diagnostics")).json()).sdkEvents).toEqual({ SURFACE_POPUP_OPENED: 1 });
  });
});
