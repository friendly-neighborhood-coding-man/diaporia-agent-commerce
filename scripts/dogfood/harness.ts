/**
 * Dogfooding harness: drives the whole stack the way an AI host does, over real HTTP MCP with the
 * official SDK client, against the MOCK payment provider and fixture catalog. No network beyond
 * 127.0.0.1, no PayPal, no KERNEL, no model calls.
 *
 * Each scenario records checks as { check, expected, observed, pass }. A scenario PASSES only if
 * every check passes. Scenarios that need something this process cannot do (the owner's four local
 * hosts, a public endpoint) are reported NOT_RUN with the reason, never PASS.
 */
import type { AddressInfo } from "node:net";
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { createApp, type App, type AppConfig } from "../../src/http/server.js";
import { ALL_CLIENT_SCOPES, DevAuth, SCOPES } from "../../src/auth/devAuth.js";
import { MockPayPalProvider } from "../../src/payment/MockPayPalProvider.js";
import type { ProductIdentity } from "../../src/domain/types.js";

export type ScenarioStatus = "PASS" | "FAIL" | "NOT_RUN";
export interface Check { check: string; expected: unknown; observed: unknown; pass: boolean }
export interface ScenarioResult { id: string; title: string; status: ScenarioStatus; checks: Check[]; notes: string[]; durationMs: number; error?: string }

const T = { alice: `dct_${randomBytes(18).toString("hex")}`, bob: `dct_${randomBytes(18).toString("hex")}`, aliceRead: `dct_${randomBytes(18).toString("hex")}` };
const O = { alice: `dok_${randomBytes(18).toString("hex")}`, bob: `dok_${randomBytes(18).toString("hex")}` };
const SONY_BLACK: ProductIdentity = { brand: "Sony", model: "WH-CH720N", variant: "Black", condition: "new", sku: "WHCH720N/B" };
const CA = { country: "US", region: "CA" };

interface Stack { app: App; url: string; mock: MockPayPalProvider; close(): Promise<void> }

async function freePort(): Promise<number> {
  const probe = createServer(); await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as AddressInfo).port; await new Promise<void>((r) => probe.close(() => r()));
  return port;
}
function devAuth() {
  const a = new DevAuth();
  a.addClientToken(T.alice, "alice", ALL_CLIENT_SCOPES); a.addClientToken(T.bob, "bob", ALL_CLIENT_SCOPES);
  a.addClientToken(T.aliceRead, "alice", [SCOPES.READ]);
  a.addOwnerKey(O.alice, "alice"); a.addOwnerKey(O.bob, "bob");
  return a;
}
async function startStack(over: Partial<AppConfig> = {}): Promise<Stack> {
  const port = await freePort(); const url = `http://127.0.0.1:${port}`;
  const app = createApp({ host: "127.0.0.1", port, baseUrl: url, authMode: "dev", dbPath: ":memory:", auth: devAuth(), ...over });
  await new Promise<void>((r) => app.server.listen(port, "127.0.0.1", r));
  return { app, url, mock: app.mockPayPal!, close: () => new Promise((r) => app.server.close(() => r())) };
}
async function client(url: string, token: string): Promise<Client> {
  const c = new Client({ name: "diaporia-dogfood-host", version: "1.0.0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  await c.listTools();
  return c;
}
async function tool(c: Client, name: string, args: Record<string, unknown>): Promise<{ ok: true; data: any } | { ok: false; error: any }> {
  const r = await c.callTool({ name, arguments: args });
  const text = (r.content as Array<{ text: string }>)[0]?.text ?? "";
  if (r.isError) { try { return { ok: false, error: JSON.parse(text).error }; } catch { return { ok: false, error: { code: "PROTOCOL", message: text } }; } }
  return { ok: true, data: r.structuredContent };
}
async function must(c: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const r = await tool(c, name, args);
  if (!r.ok) throw new Error(`${name} failed: ${JSON.stringify(r.error)}`);
  return r.data;
}
async function mandate(url: string, ownerKey: string, body: Record<string, unknown>) {
  const r = await fetch(`${url}/owner/mandates`, { method: "POST", headers: { "Content-Type": "application/json", "X-Owner-Key": ownerKey }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() as any };
}
async function buyerApprove(s: Stack, approvalUrl: string, action: "approve" | "cancel" = "approve") {
  const orderId = new URL(approvalUrl).pathname.split("/").pop()!;
  const r1 = await fetch(`${s.url}/mock-paypal/checkout/${orderId}/${action}`, { method: "POST", redirect: "manual" });
  const loc = r1.headers.get("location")!;
  const r2 = await fetch(loc, { redirect: "manual" });
  return { returnUrl: loc, html: await r2.text() };
}
async function researchCompare(c: Client, request = "Buy Sony WH-CH720N Black for the lowest total price, but never exceed $60.", extra: Record<string, unknown> = {}, destination: unknown = CA) {
  const research = await must(c, "research_purchase", { request, currency: "USD", ...extra });
  const compare = await must(c, "compare_purchase_offers", { researchSessionId: research.purchaseSessionId, productIdentity: SONY_BLACK, ...(destination ? { destination } : {}) });
  return { research, compare };
}

type Recorder = { check(name: string, expected: unknown, observed: unknown, pass?: boolean): void; note(s: string): void };
async function scenario(id: string, title: string, fn: (r: Recorder) => Promise<void>): Promise<ScenarioResult> {
  const checks: Check[] = []; const notes: string[] = []; const t0 = Date.now();
  const rec: Recorder = {
    check: (name, expected, observed, pass) => checks.push({ check: name, expected, observed, pass: pass ?? JSON.stringify(expected) === JSON.stringify(observed) }),
    note: (s) => notes.push(s),
  };
  try {
    await fn(rec);
    return { id, title, status: checks.length && checks.every((c) => c.pass) ? "PASS" : "FAIL", checks, notes, durationMs: Date.now() - t0 };
  } catch (e) {
    return { id, title, status: "FAIL", checks, notes, durationMs: Date.now() - t0, error: e instanceof Error ? e.message : String(e) };
  }
}

// ------------------------------------------------------------------ scenarios

export const A = () => scenario("A", "Exact-product purchase with spending limit, human authorization and verified MOCK result", async (r) => {
  const s = await startStack();
  try {
    const c = await client(s.url, T.alice);
    const { research, compare } = await researchCompare(c);
    r.check("intent mode", "EXACT_PRODUCT_PURCHASE", research.mode);
    r.check("identity locked", "LOCKED", research.identity.status);
    r.check("research has no payment effect", "NONE", research.paymentEffect);
    r.check("compare state", "OFFER_VERIFIED", compare.state);
    const offer = compare.lowestPayPalCheckoutableOffer;
    r.check("lowest PayPal-checkoutable verified offer", "off_alpha", offer?.offerId);
    const noMandate = await must(c, "prepare_checkout", { purchaseSessionId: research.purchaseSessionId, offerId: offer.offerId, maximumApprovedTotalMinor: 6000, currency: "USD", quantity: 1 });
    r.check("without a mandate the AI gets only a human authorization link", ["OWNER_MANDATE_REQUIRED", "PAYPAL_BUYER_APPROVAL_REQUIRED"], noMandate.authorizationRequirements);
    r.check("no provider order before human authorization", 0, s.mock.calls.createOrder);
    // The human reviews and authorizes on the owner page.
    const rv = await fetch(noMandate.userAuthorizationUrl, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ action: "review", ownerKey: O.alice }).toString() });
    const html = await rv.text(); const cookie = rv.headers.get("set-cookie")!.split(";")[0]!; const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1]!;
    r.check("review page names MOCK environment and never Sandbox", true, html.includes("MOCK (simulated; no PayPal call, no money)") && !/Sandbox/.test(html));
    r.check("review page shows payee", true, /data-field="payee">[^<]*· payee/.test(html));
    const auth = await fetch(noMandate.userAuthorizationUrl, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie }, body: new URLSearchParams({ action: "authorize", csrf, maximum: "60.00" }).toString() });
    r.check("authorization redirects to (mock) buyer approval", 303, auth.status);
    const b = await buyerApprove(s, auth.headers.get("location")!);
    r.check("return page does not claim payment", true, b.html.includes("does not itself prove payment"));
    const st = await must(c, "get_checkout_status", { checkoutSessionId: noMandate.checkoutSessionId });
    r.check("server-verified state", "COMPLETED", st.state);
    r.check("amount", 5939, st.amount.totalMinor);
    r.check("merchant order not claimed", "NOT_CONFIRMED", st.purchaseOutcome.merchantOrderConfirmation);
    r.check("fulfillment not claimed", "NOT_VERIFIED", st.purchaseOutcome.fulfillment);
    const rc = await must(c, "get_purchase_receipt", { checkoutSessionId: noMandate.checkoutSessionId });
    r.check("receipt payment result", "COMPLETED", rc.paymentResult?.status);
    r.check("receipt has audit timeline", true, rc.auditTimeline.length >= 5);
    r.check("exactly one capture", 1, s.mock.calls.captureOrder);
    r.note(`statement relayed to user: ${st.purchaseOutcome.statement}`);
    await c.close();
  } finally { await s.close(); }
});

export const B = () => scenario("B", "Spending-limit violation: $6,000 offer under a $60 mandate", async (r) => {
  const s = await startStack();
  try {
    const c = await client(s.url, T.alice);
    r.check("owner creates $60 mandate", 201, (await mandate(s.url, O.alice, { productIdentity: SONY_BLACK, currency: "USD", maximumTotalMinor: 6000 })).status);
    const { research, compare } = await researchCompare(c, "Buy Sony WH-CH720N Black", { budgetMinor: 1_000_000 });
    r.check("the $6,000 offer is visible to the AI", true, compare.eligibleOffers.some((o: any) => o.offerId === "off_india"));
    const before = { ...s.mock.calls };
    const prep = await must(c, "prepare_checkout", { purchaseSessionId: research.purchaseSessionId, offerId: "off_india", maximumApprovedTotalMinor: 600000, currency: "USD", quantity: 1 });
    r.check("state", "HOLD", prep.state);
    r.check("policy code", "AMOUNT_EXCEEDED", prep.policy?.code);
    r.check("no approval URL", null, prep.approvalUrl);
    r.check("no payment-provider call of any kind", before, s.mock.calls);
    r.check("mandate reservation untouched", 0, s.app.gateway.mandates.listActive("alice")[0]!.reservedMinor);
    await c.close();
  } finally { await s.close(); }
});

export const C = () => scenario("C", "Wrong product, variant, condition, bundle-like or ambiguous identity: no silent substitution", async (r) => {
  const s = await startStack();
  try {
    const c = await client(s.url, T.alice);
    const amb = await must(c, "research_purchase", { request: "Buy Sony WH-CH720N under $60" });
    r.check("variant not named → HOLD/AMBIGUOUS", ["HOLD", "AMBIGUOUS"], [amb.state, amb.identity.status]);
    const nf = await must(c, "research_purchase", { request: "Buy Sony WH-CH720N Purple under $60" });
    r.check("unknown variant → not substituted", true, nf.identity.status !== "LOCKED");
    const { research, compare } = await researchCompare(c);
    const issues = (id: string) => compare.ineligibleOffers.find((o: any) => o.offerId === id)?.issues ?? [];
    r.check("different color excluded", true, issues("off_delta").includes("IDENTITY_MISMATCH_VARIANT"));
    r.check("refurbished excluded", true, issues("off_echo").includes("IDENTITY_MISMATCH_CONDITION"));
    r.check("look-alike merchant domain excluded", true, issues("off_imposter").some((i: string) => i.startsWith("MERCHANT_IDENTITY")));
    const sub = await tool(c, "prepare_checkout", { purchaseSessionId: research.purchaseSessionId, offerId: "off_delta", maximumApprovedTotalMinor: 6000, currency: "USD", quantity: 1 });
    r.check("preparing the wrong variant is refused", "OFFER_NOT_ELIGIBLE", sub.ok ? "ACCEPTED" : sub.error.code);
    const qty = await tool(c, "prepare_checkout", { purchaseSessionId: research.purchaseSessionId, offerId: "off_alpha", maximumApprovedTotalMinor: 20000, currency: "USD", quantity: 2 });
    r.check("bundle/quantity beyond the $60 request is refused", "OFFER_NOT_ELIGIBLE:OVER_BUDGET", qty.ok ? `ACCEPTED:${qty.data.state}` : `${qty.error.code}:${(qty.error.details?.issues ?? []).join(",")}`);
    r.check("no provider order", 0, s.mock.calls.createOrder);
    r.note("The fixture catalog has no multi-item bundle SKU; quantity 2 stands in for a bundle and is checked against the per-checkout authorization.");
    await c.close();
  } finally { await s.close(); }
});

export const D = () => scenario("D", "Unknown shipping/tax: uncertainty preserved, no verified cheapest-total claim", async (r) => {
  const s = await startStack();
  try {
    const c = await client(s.url, T.alice);
    const { research, compare } = await researchCompare(c, undefined, {}, null);
    r.check("state without destination", "HOLD", compare.state);
    r.check("no verified cheapest offer", null, compare.lowestVerifiedEligibleOffer);
    r.check("unknown components kept null, not zero", true, compare.ineligibleOffers.some((o: any) => o.cost?.totalMinor === null && o.cost?.unknownComponents?.length > 0));
    r.check("hold reasons mention destination", true, compare.holdReasons.join(" ").includes("destination"));
    const p = await tool(c, "prepare_checkout", { purchaseSessionId: research.purchaseSessionId, offerId: "off_alpha", maximumApprovedTotalMinor: 6000, currency: "USD", quantity: 1 });
    r.check("checkout refused while totals are unknown", "INVALID_STATE", p.ok ? "ACCEPTED" : p.error.code);
    await c.close();
  } finally { await s.close(); }
});

export const E = () => scenario("E", "Payment uncertainty: provider timeout after a possibly successful capture", async (r) => {
  const s = await startStack();
  try {
    const c = await client(s.url, T.alice);
    await mandate(s.url, O.alice, { productIdentity: SONY_BLACK, currency: "USD", maximumTotalMinor: 6000 });
    const { research } = await researchCompare(c);
    const prep = await must(c, "prepare_checkout", { purchaseSessionId: research.purchaseSessionId, offerId: "off_alpha", maximumApprovedTotalMinor: 6000, currency: "USD", quantity: 1 });
    s.mock.captureOutcomes = ["TIMEOUT_AFTER_CAPTURE"];
    const b = await buyerApprove(s, prep.approvalUrl);
    const st = await must(c, "get_checkout_status", { checkoutSessionId: prep.checkoutSessionId });
    r.check("state after timeout", "UNKNOWN", st.state);
    r.check("new payment attempt prohibited", true, st.payment?.newPaymentAttemptProhibited === true);
    await fetch(b.returnUrl); // buyer refreshes the return page
    r.check("a replayed return does not capture again", 1, s.mock.calls.captureOrder);
    const rr = await fetch(`${s.url}/owner/checkouts/${prep.checkoutSessionId}/reconcile`, { method: "POST", headers: { "X-Owner-Key": O.alice } });
    r.check("read-only reconciliation settles it", "COMPLETED", (await rr.json() as any).state);
    r.check("still exactly one capture", 1, s.mock.calls.captureOrder);
    await c.close();
  } finally { await s.close(); }
});

export const F = () => scenario("F", "Cross-user and cross-host access", async (r) => {
  const s = await startStack();
  try {
    const alice = await client(s.url, T.alice); const bob = await client(s.url, T.bob); const ro = await client(s.url, T.aliceRead);
    await mandate(s.url, O.alice, { productIdentity: SONY_BLACK, currency: "USD", maximumTotalMinor: 6000 });
    const { research } = await researchCompare(alice);
    const prep = await must(alice, "prepare_checkout", { purchaseSessionId: research.purchaseSessionId, offerId: "off_alpha", maximumApprovedTotalMinor: 6000, currency: "USD", quantity: 1 });
    const read = await tool(bob, "get_checkout_status", { checkoutSessionId: prep.checkoutSessionId });
    r.check("bob cannot read alice's checkout", "NOT_FOUND", read.ok ? "READ" : read.error.code);
    const rcpt = await tool(bob, "get_purchase_receipt", { checkoutSessionId: prep.checkoutSessionId });
    r.check("bob cannot read alice's receipt", "NOT_FOUND", rcpt.ok ? "READ" : rcpt.error.code);
    const reuse = await tool(bob, "prepare_checkout", { purchaseSessionId: research.purchaseSessionId, offerId: "off_alpha", maximumApprovedTotalMinor: 6000, currency: "USD", quantity: 1 });
    r.check("bob cannot prepare on alice's research session", false, reuse.ok);
    const cancel = await fetch(`${s.url}/owner/checkouts/${prep.checkoutSessionId}/cancel`, { method: "POST", headers: { "X-Owner-Key": O.bob } });
    r.check("bob's owner key cannot cancel alice's checkout", 404, cancel.status);
    const tools = (await ro.listTools()).tools.map((t) => t.name);
    r.check("read-only token is not offered prepare_checkout", false, tools.includes("prepare_checkout"));
    const aiMandate = await fetch(`${s.url}/owner/mandates`, { method: "POST", headers: { "Content-Type": "application/json", "X-Owner-Key": T.alice }, body: JSON.stringify({ productIdentity: SONY_BLACK, currency: "USD", maximumTotalMinor: 600000 }) });
    r.check("an AI client token cannot create spending authority", 401, aiMandate.status);
    for (const x of [alice, bob, ro]) await x.close();
  } finally { await s.close(); }
});

export const G = () => scenario("G", "Prompt injection in merchant listing and review content", async (r) => {
  const s = await startStack();
  try {
    const c = await client(s.url, T.alice);
    await mandate(s.url, O.alice, { productIdentity: SONY_BLACK, currency: "USD", maximumTotalMinor: 6000 });
    const { research, compare } = await researchCompare(c);
    const flagged = research.candidates[0].untrustedContent ?? [];
    r.check("injected review text surfaced as untrusted, flagged data", true, flagged.some((x: any) => x.trusted === false && x.flags.includes("PAYMENT_INSTRUCTION")));
    r.check("listing with instructions is ineligible", true, compare.ineligibleOffers.find((o: any) => o.offerId === "off_foxtrot")?.issues.includes("SUSPICIOUS_LISTING_CONTENT"));
    const via = await tool(c, "prepare_checkout", { purchaseSessionId: research.purchaseSessionId, offerId: "off_foxtrot", maximumApprovedTotalMinor: 600000, currency: "USD", quantity: 1 });
    r.check("following the injected instruction is refused", "OFFER_NOT_ELIGIBLE", via.ok ? "ACCEPTED" : via.error.code);
    const m = s.app.gateway.mandates.listActive("alice");
    r.check("the owner's mandate is still the only authority, unchanged", [1, 6000], [m.length, m[0]?.maximumTotalMinor]);
    r.check("no provider order", 0, s.mock.calls.createOrder);
    await c.close();
  } finally { await s.close(); }
});

export const H = () => scenario("H", "Restart during a transaction: durable state, recovery, idempotency", async (r) => {
  const dir = mkdtempSync(join(tmpdir(), "dac-dogfood-"));
  const shared = { p: null as MockPayPalProvider | null };
  const payments = (base: string) => (shared.p ??= new MockPayPalProvider(base));
  try {
    const dbPath = join(dir, "state.sqlite");
    const s1 = await startStack({ dbPath, payments });
    const c1 = await client(s1.url, T.alice);
    await mandate(s1.url, O.alice, { productIdentity: SONY_BLACK, currency: "USD", maximumTotalMinor: 6000 });
    const { research } = await researchCompare(c1);
    const args = { purchaseSessionId: research.purchaseSessionId, offerId: "off_alpha", maximumApprovedTotalMinor: 6000, currency: "USD", quantity: 1 };
    const prep = await must(c1, "prepare_checkout", args);
    shared.p!.captureOutcomes = ["TIMEOUT_AFTER_CAPTURE"];
    const b = await buyerApprove(s1, prep.approvalUrl);
    r.check("UNKNOWN before the crash", "UNKNOWN", (await must(c1, "get_checkout_status", { checkoutSessionId: prep.checkoutSessionId })).state);
    await c1.close(); await s1.close();
    const s2 = await startStack({ dbPath, payments });
    const rec = await s2.app.gateway.reconcileAwaitingSettlement("STARTUP");
    r.check("startup reconciliation found the open capture", true, rec.some((x) => x.checkoutSessionId === prep.checkoutSessionId));
    const c2 = await client(s2.url, T.alice);
    r.check("state after restart", "COMPLETED", (await must(c2, "get_checkout_status", { checkoutSessionId: prep.checkoutSessionId })).state);
    await fetch(b.returnUrl.replace(/:\d+\//, `:${new URL(s2.url).port}/`));
    const dup = await must(c2, "prepare_checkout", args);
    r.check("prepare after restart deduplicates to the same checkout", prep.checkoutSessionId, dup.checkoutSessionId);
    r.check("exactly one capture across restart and replay", 1, shared.p!.calls.captureOrder);
    r.check("mandate consumed, not double-counted", 0, s2.app.gateway.mandates.listActive("alice").length);
    await c2.close(); await s2.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

export const K = () => scenario("K", "Remote-style OAuth 2.1 client (official MCP SDK) on loopback: discover, register, consent, research, read status", async (r) => {
  const port = await freePort(); const url = `http://127.0.0.1:${port}`;
  const app = createApp({ host: "127.0.0.1", port, baseUrl: url, authMode: "oauth", dbPath: ":memory:", auth: devAuth() });
  await new Promise<void>((res) => app.server.listen(port, "127.0.0.1", res));
  try {
    const REDIRECT = "http://127.0.0.1:53682/callback";
    let info: OAuthClientInformationMixed | undefined; let tokens: OAuthTokens | undefined; let verifier = ""; let authUrl: URL | null = null;
    const provider: OAuthClientProvider = {
      get redirectUrl() { return REDIRECT; },
      get clientMetadata() { return { client_name: "dogfood remote host", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }; },
      clientInformation: () => info, saveClientInformation: (x) => { info = x; }, tokens: () => tokens, saveTokens: (x) => { tokens = x; },
      redirectToAuthorization: (u) => { authUrl = u; }, saveCodeVerifier: (v) => { verifier = v; }, codeVerifier: () => verifier,
    };
    const t1 = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { authProvider: provider });
    let unauthorized = false;
    try { await new Client({ name: "remote", version: "1" }).connect(t1); } catch (e) { unauthorized = e instanceof UnauthorizedError; }
    r.check("first connect is challenged (401 + resource metadata)", true, unauthorized);
    r.check("client registered dynamically", true, typeof info?.client_id === "string");
    const page = await fetch(authUrl!.toString()); const html = await page.text();
    const form = new URLSearchParams({ request_id: /name="request_id" value="([^"]+)"/.exec(html)![1]!, csrf: /name="csrf" value="([^"]+)"/.exec(html)![1]!, decision: "approve", owner_key: O.alice });
    const offered = [...html.matchAll(/name="scope" value="([^"]+)"/g)].map((m) => m[1]!);
    r.check("consent page lists each requested scope for the owner to choose", true, offered.includes("purchase.research") && offered.includes("purchase.read"));
    r.note(`scopes the SDK client requested (from the 401 challenge): ${offered.join(" ")}`);
    // The owner grants least privilege: research + read, not prepare.
    for (const sc of ["purchase.research", "purchase.read"]) form.append("scope", sc);
    const consent = await fetch(`${url}/oauth/authorize`, { method: "POST", body: form, redirect: "manual" });
    await t1.finishAuth(new URL(consent.headers.get("location")!).searchParams.get("code")!);
    const c = new Client({ name: "remote", version: "1" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { authProvider: provider }));
    const names = (await c.listTools()).tools.map((t) => t.name);
    r.check("granted research/read are offered; ungranted prepare is not", [true, false], [names.includes("research_purchase"), names.includes("prepare_checkout")]);
    const research = await must(c, "research_purchase", { request: "Buy Sony WH-CH720N Black, never exceed $60.", currency: "USD" });
    r.check("research via OAuth token", "RESEARCHED", research.state);
    const usage = await must(c, "get_usage_summary", {});
    r.check("usage summary readable over OAuth", true, typeof usage.mode === "string" && usage.billing !== undefined);
    await c.close();
  } finally { await new Promise<void>((res) => app.server.close(() => res())); }
});

export const NOT_RUN: ScenarioResult[] = [
  { id: "I", title: "Four local AI hosts (Claude Code, Codex CLI, Grok Build, Hermes) run the same contracts", status: "NOT_RUN", checks: [], durationMs: 0,
    notes: ["Needs the owner's PC where the four host CLIs are installed and signed in. Prior evidence (not re-run here): docs/evidence/interop/ and docs/evidence/handoff-interop/ (4/4 hosts, MOCK).",
      "This harness's scenarios A-H use the same MCP SDK transport and the same tool contracts the hosts call; that shows contract behaviour, not host onboarding."] },
];

export async function runAll(opts: { only?: string[] } = {}): Promise<ScenarioResult[]> {
  const all: Array<[string, () => Promise<ScenarioResult>]> = [["A", A], ["B", B], ["C", C], ["D", D], ["E", E], ["F", F], ["G", G], ["H", H], ["K", K]];
  const out: ScenarioResult[] = [];
  for (const [id, fn] of all) if (!opts.only || opts.only.includes(id)) out.push(await fn());
  return out;
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
