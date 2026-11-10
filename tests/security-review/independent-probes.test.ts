/**
 * INDEPENDENT SECURITY REVIEW PROBES (test-only, review branch; NOT part of the integration branch).
 * Target: integration/mvp-full-layer @ 759bd37b0ad254f414fd61b9a009631c026f97f5.
 * Every probe runs in-process against a disposable MOCK app (":memory:" or a fresh temp SQLite file).
 * No network beyond 127.0.0.1, no PayPal, no KERNEL, no Cloudflare.
 *
 * Convention: a probe named "ATTACK ..." asserts the CURRENT (vulnerable or weak) behaviour, so a later fix
 * makes it fail and forces the register to be updated. "CONTROL ..." asserts a defence that held.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash, generateKeyPairSync, randomBytes, sign as rsaSign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { OWNER, TOKENS, buyer, call, callError, createMandate, mcpClient, researchAndCompare, SONY_BLACK, startHarness, type Harness } from "../helpers.js";
import { PayPalWebhookSignatureVerifier } from "../../src/payment/PayPalWebhook.js";
import { redact } from "../../src/security/redact.js";
import { parseDecimalToMinor } from "../../src/domain/money.js";
import { randomSecret } from "../../src/auth/devAuth.js";
import { MockCommerceResearchAdapter } from "../../src/research/CommerceResearchAdapter.js";
import { request as httpRequest } from "node:http";

/** Raw HTTP so the Host header is exactly what a proxy would send (fetch() overrides Host). */
function raw(url: string, path: string, method: string, headers: Record<string, string>, body = ""): Promise<number> {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const r = httpRequest({ host: u.hostname, port: u.port, path, method, headers: { ...headers, "Content-Length": Buffer.byteLength(body) } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    r.on("error", reject); r.end(body);
  });
}
/** The MOCK catalog with realistic merchant-quote latency (live Shopify/Channel3 quotes take 100s of ms). */
class SlowQuotes extends MockCommerceResearchAdapter {
  override async getQuote(...a: Parameters<MockCommerceResearchAdapter["getQuote"]>) { await new Promise((r) => setTimeout(r, 150)); return super.getQuote(...a); }
}

vi.setConfig({ testTimeout: 60_000 });
const open: Harness[] = [];
const tmp: string[] = [];
afterEach(async () => { for (const h of open.splice(0)) await h.close().catch(() => {}); for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true }); });
async function harness(o: Parameters<typeof startHarness>[0] = {}) { const h = await startHarness(o); open.push(h); return h; }
function tempDb() { const d = mkdtempSync(join(tmpdir(), "diaporia-review-")); tmp.push(d); return join(d, "review.sqlite"); }
const form = (body: Record<string, string>, cookie?: string) => ({ method: "POST", redirect: "manual" as const,
  headers: { "Content-Type": "application/x-www-form-urlencoded", ...(cookie ? { Cookie: cookie } : {}) }, body: new URLSearchParams(body).toString() });
async function review(url: string, ownerKey = OWNER.alice) {
  const r = await fetch(url, form({ action: "review", ownerKey }));
  const html = await r.text();
  return { status: r.status, cookie: r.headers.get("set-cookie")?.split(";")[0] ?? "", csrf: /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? "" };
}
const pkce = () => { const verifier = randomBytes(32).toString("base64url"); return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") }; };
const prepareArgs = (ps: string) => ({ purchaseSessionId: ps, offerId: "off_alpha", maximumApprovedTotalMinor: 6000, currency: "USD", quantity: 1 });

describe("B. Spending authority", () => {
  it("ATTACK IR-01 (SR-01 re-verified): an AI token + an existing REUSABLE mandate completes a MOCK purchase with NO human step (unauthenticated mock approve)", async () => {
    const h = await harness();
    expect((await createMandate(h.url, OWNER.alice, { productIdentity: SONY_BLACK, currency: "USD", maximumTotalMinor: 6000 })).status).toBe(201);
    const ai = await mcpClient(h.url, TOKENS.alice);
    const { research } = await researchAndCompare(ai);
    const p = await call(ai, "prepare_checkout", prepareArgs(research.purchaseSessionId));
    expect(p.state).toBe("APPROVAL_REQUIRED");
    // The "buyer" step: a bare POST, no cookie, no owner key, no Origin header.
    const orderId = new URL(p.approvalUrl).pathname.split("/").pop()!;
    const r1 = await fetch(`${h.url}/mock-paypal/checkout/${orderId}/approve`, { method: "POST", redirect: "manual" });
    expect(r1.status).toBe(303);
    await fetch(r1.headers.get("location")!, { redirect: "manual" });
    expect((await call(ai, "get_checkout_status", { checkoutSessionId: p.checkoutSessionId })).state).toBe("COMPLETED");
    await ai.close();
  });

  it("ATTACK IR-02: two concurrent identical prepare_checkout calls create TWO checkouts and TWO provider orders for one purchase session; both complete", async () => {
    const h = await harness({ research: new SlowQuotes() });
    await createMandate(h.url, OWNER.alice, { productIdentity: SONY_BLACK, currency: "USD", maximumTotalMinor: 12000, maximumTransactions: 2 });
    const a = await mcpClient(h.url, TOKENS.alice); const b = await mcpClient(h.url, TOKENS.alice);
    const { research } = await researchAndCompare(a);
    const [p1, p2] = await Promise.all([call(a, "prepare_checkout", prepareArgs(research.purchaseSessionId)), call(b, "prepare_checkout", prepareArgs(research.purchaseSessionId))]);
    expect(p1.checkoutSessionId).not.toBe(p2.checkoutSessionId);          // dedup (findActiveDuplicate) raced
    expect(p1.deduplicated || p2.deduplicated).toBe(false);
    expect(h.mock.calls.createOrder).toBe(2);
    await buyer(h, p1.approvalUrl); await buyer(h, p2.approvalUrl);
    const s1 = await call(a, "get_checkout_status", { checkoutSessionId: p1.checkoutSessionId });
    const s2 = await call(a, "get_checkout_status", { checkoutSessionId: p2.checkoutSessionId });
    expect([s1.state, s2.state]).toEqual(["COMPLETED", "COMPLETED"]);     // "one purchase session buys at most once" violated
    const m = h.app.store.db.prepare("SELECT consumed_minor, max_total_minor FROM mandates WHERE user_id='alice'").get() as any;
    expect(m.consumed_minor).toBeLessThanOrEqual(m.max_total_minor);       // the mandate ceiling itself still held
    await a.close(); await b.close();
  });

  it("CONTROL: sequential identical prepare_checkout is deduplicated (the dedup only fails under concurrency)", async () => {
    const h = await harness();
    await createMandate(h.url, OWNER.alice, { productIdentity: SONY_BLACK, currency: "USD", maximumTotalMinor: 12000, maximumTransactions: 2 });
    const a = await mcpClient(h.url, TOKENS.alice);
    const { research } = await researchAndCompare(a);
    const p1 = await call(a, "prepare_checkout", prepareArgs(research.purchaseSessionId));
    const p2 = await call(a, "prepare_checkout", prepareArgs(research.purchaseSessionId));
    expect(p2.checkoutSessionId).toBe(p1.checkoutSessionId); expect(p2.deduplicated).toBe(true);
    await a.close();
  });

  it("CONTROL: two server processes on ONE SQLite file, concurrent owner authorizations of one checkout create exactly one authorization", async () => {
    const dbPath = tempDb();
    const h1 = await harness({ dbPath }); const h2 = await harness({ dbPath });
    const ai = await mcpClient(h1.url, TOKENS.alice);
    const { research } = await researchAndCompare(ai);
    const p = await call(ai, "prepare_checkout", prepareArgs(research.purchaseSessionId));
    const u1 = p.userAuthorizationUrl as string; const u2 = u1.replace(h1.url, h2.url);
    const [r1, r2] = await Promise.all([review(u1), review(u2)]);
    const [a1, a2] = await Promise.all([fetch(u1, form({ action: "authorize", csrf: r1.csrf, maximum: "60.00" }, r1.cookie)), fetch(u2, form({ action: "authorize", csrf: r2.csrf, maximum: "60.00" }, r2.cookie))]);
    expect([a1.status, a2.status].sort()).toEqual([303, 409]);
    expect((h1.app.store.db.prepare("SELECT count(*) n FROM mandates WHERE bound_checkout_session_id = ?").get(p.checkoutSessionId) as any).n).toBe(1);
    await ai.close();
  });

  it("CONTROL: cross-user. Bob's AI token and Bob's owner key cannot read or authorize Alice's checkout", async () => {
    const h = await harness();
    const ai = await mcpClient(h.url, TOKENS.alice); const bob = await mcpClient(h.url, TOKENS.bob);
    const { research } = await researchAndCompare(ai);
    const p = await call(ai, "prepare_checkout", prepareArgs(research.purchaseSessionId));
    expect((await callError(bob, "get_checkout_status", { checkoutSessionId: p.checkoutSessionId })).code).toBe("NOT_FOUND");
    expect((await callError(bob, "prepare_checkout", prepareArgs(research.purchaseSessionId))).code).toBe("NOT_FOUND");
    expect((await review(p.userAuthorizationUrl, OWNER.bob)).status).toBe(404);
    await ai.close(); await bob.close();
  });

  it("ATTACK IR-09 (SR-05 re-verified): the owner-page session cookie is not bound to the checkout it was opened for", async () => {
    const h = await harness();
    const ai = await mcpClient(h.url, TOKENS.alice);
    const r1 = await researchAndCompare(ai); const a = await call(ai, "prepare_checkout", prepareArgs(r1.research.purchaseSessionId));
    const r2 = await researchAndCompare(ai); const b = await call(ai, "prepare_checkout", prepareArgs(r2.research.purchaseSessionId));
    const s = await review(a.userAuthorizationUrl);                         // owner reviewed A only
    const res = await fetch(b.userAuthorizationUrl, form({ action: "authorize", csrf: s.csrf, maximum: "60.00" }, s.cookie));
    expect(res.status).toBe(303);                                           // B authorized with A's review session
    await ai.close();
  });

  it("ATTACK IR-10: owner-page amount parser silently turns a European decimal comma into a 100x larger limit", () => {
    expect(parseDecimalToMinor("60,00", "USD")).toBe(600_000);              // $6,000.00, not $60.00
    expect(parseDecimalToMinor("60.00", "USD")).toBe(6000);
  });

  it("CONTROL: an expired checkout's owner page creates no authority; revoking a reusable mandate before capture blocks the capture", async () => {
    const h = await harness();
    const ai = await mcpClient(h.url, TOKENS.alice);
    const { research } = await researchAndCompare(ai);
    const p = await call(ai, "prepare_checkout", prepareArgs(research.purchaseSessionId));
    h.clock.offsetMs += 16 * 60_000;
    const s = await review(p.userAuthorizationUrl);
    expect((await fetch(p.userAuthorizationUrl, form({ action: "authorize", csrf: s.csrf, maximum: "60.00" }, s.cookie))).status).toBe(409);
    h.clock.offsetMs = 0;
    const m = (await createMandate(h.url, OWNER.alice, { productIdentity: SONY_BLACK, currency: "USD", maximumTotalMinor: 6000 })).body;
    const { research: r2 } = await researchAndCompare(ai);
    const p2 = await call(ai, "prepare_checkout", prepareArgs(r2.purchaseSessionId));
    expect((await fetch(`${h.url}/owner/mandates/${m.mandateId}/revoke`, { method: "POST", headers: { "X-Owner-Key": OWNER.alice } })).status).toBe(200);
    await buyer(h, p2.approvalUrl);
    const st = await call(ai, "get_checkout_status", { checkoutSessionId: p2.checkoutSessionId });
    expect(st.state).toBe("FAILED"); expect(h.mock.calls.captureOrder).toBe(0);
    await ai.close();
  });
});

describe("C. Payment execution", () => {
  it("ATTACK IR-11 (SR-06 re-verified): owner reconcile of an UNKNOWN create-timeout checkout replays createOrder even after expiry", async () => {
    const h = await harness();
    await createMandate(h.url, OWNER.alice, { productIdentity: SONY_BLACK, currency: "USD", maximumTotalMinor: 6000 });
    const ai = await mcpClient(h.url, TOKENS.alice);
    const { research } = await researchAndCompare(ai);
    h.mock.createOutcomes.push("TIMEOUT_AFTER_CREATE");
    const p = await call(ai, "prepare_checkout", prepareArgs(research.purchaseSessionId));
    expect(p.state).toBe("UNKNOWN");
    h.clock.offsetMs += 7 * 3600_000;                                       // beyond PayPal's documented 6 h PayPal-Request-Id retention
    const before = h.mock.calls.createOrder;
    await fetch(`${h.url}/owner/checkouts/${p.checkoutSessionId}/reconcile`, { method: "POST", headers: { "X-Owner-Key": OWNER.alice } });
    expect(h.mock.calls.createOrder).toBe(before + 1);                      // a provider WRITE after expiry; real PayPal may create a 2nd order here
    await ai.close();
  });

  it("ATTACK IR-12: PayPal's signed message covers only CRC32(body); a captured webhook signature verifies a different, attacker-chosen body", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const v = new PayPalWebhookSignatureVerifier({ webhookId: "WHID-REVIEW", fetchCertPem: async () => publicKey.export({ type: "spki", format: "pem" }).toString() });
    const genuine = JSON.stringify({ id: "WH-GENUINE0001", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "CAPTUREAAAA1111", status: "COMPLETED" } });
    const tid = "tid-1", time = new Date().toISOString();
    const sig = rsaSign("sha256", Buffer.from(`${tid}|${time}|WHID-REVIEW|${crc32(Buffer.from(genuine)) >>> 0}`), privateKey).toString("base64");
    const headers = { transmissionId: tid, transmissionTime: time, transmissionSig: sig, certUrl: "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1", authAlgo: "SHA256withRSA" };
    expect(await v.verify(headers, genuine)).toEqual({ ok: true });
    const forged = forgeCrc(`{"id":"WH-FORGED00002","event_type":"PAYMENT.CAPTURE.DENIED","resource":{"id":"CAPTUREBBBB2222","status":"DENIED"},"pad":"`, `"}`, crc32(Buffer.from(genuine)) >>> 0);
    expect(JSON.parse(forged).id).toBe("WH-FORGED00002");
    expect(await v.verify(headers, forged)).toEqual({ ok: true });           // signature reused on a different event id / capture / type
  });
});

describe("A/E. OAuth and public surface", () => {
  it("ATTACK IR-03: open DCR + owner-key consent = consent phishing: an attacker client named like a real host, redirecting to its own https origin, gets a token for the victim", async () => {
    const h = await harness({ authMode: "oauth", baseUrl: "https://mcp.diaporia.example" });
    const oa = h.app.oauth!;
    const reg = oa.register({ client_name: "Claude", redirect_uris: ["https://claude-ai.attacker.example/api/mcp/auth_callback"] });
    expect(reg.status).toBe(201);
    const { verifier, challenge } = pkce();                                 // attacker owns the verifier
    const begin = oa.beginAuthorization(new URLSearchParams({ response_type: "code", client_id: String(reg.body.client_id), redirect_uri: "https://claude-ai.attacker.example/api/mcp/auth_callback", code_challenge: challenge, code_challenge_method: "S256", scope: "purchase.research purchase.read" }));
    if (!begin.ok) throw new Error("refused");
    expect(begin.pending.clientName).toBe("Claude");                        // displayed on consent (with a 'not verified' note)
    const done = oa.completeAuthorization(new URLSearchParams([["request_id", begin.pending.id], ["csrf", begin.pending.csrf], ["decision", "approve"], ["owner_key", OWNER.alice], ["scope", "purchase.read"]]));
    if (!("redirect" in done)) throw new Error("no redirect");
    const code = new URL(done.redirect).searchParams.get("code")!;          // delivered to the attacker origin
    const tok = oa.token(new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: String(reg.body.client_id) }));
    expect(tok.status).toBe(200);
    expect(oa.verifyAccessToken(`Bearer ${tok.body.access_token}`)?.userId).toBe("alice");
  });

  it("ATTACK IR-04 (F4/SR-04 re-verified): DCR is capped and never pruned: once full, every new client is refused permanently", async () => {
    const h = await harness({ authMode: "oauth", baseUrl: "https://mcp.diaporia.example", oauth: { maxClients: 5 } });
    const oa = h.app.oauth!;
    for (let i = 0; i < 5; i++) expect(oa.register({ redirect_uris: ["https://x.example/cb"] }).status).toBe(201);
    h.clock.offsetMs += 365 * 86400_000;
    expect(oa.register({ client_name: "Legit host", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] }).status).toBe(503);
  });

  it("ATTACK IR-05 (F1 re-verified): behind a proxy every visitor shares ONE 30/min web bucket; one client blocks OAuth discovery for all", async () => {
    const h = await harness({ authMode: "oauth" });
    const hit = (xff: string) => fetch(`${h.url}/.well-known/oauth-authorization-server`, { headers: { "X-Forwarded-For": xff } });
    for (let i = 0; i < 30; i++) await hit("198.51.100.7");                 // attacker
    expect((await hit("203.0.113.50")).status).toBe(429);                   // an unrelated user arriving through the same proxy socket
  });

  it("ATTACK IR-06: flooding /oauth/authorize past 5000 pending requests wipes every legitimate pending consent", async () => {
    const h = await harness({ authMode: "oauth", baseUrl: "https://mcp.diaporia.example" });
    const oa = h.app.oauth!;
    const reg = oa.register({ redirect_uris: ["https://x.example/cb"] });
    const q = () => new URLSearchParams({ response_type: "code", client_id: String(reg.body.client_id), code_challenge: pkce().challenge, code_challenge_method: "S256" });
    const victim = oa.beginAuthorization(q()); if (!victim.ok) throw new Error("refused");
    for (let i = 0; i < 5001; i++) oa.beginAuthorization(q());
    oa.beginAuthorization(q());
    expect(oa.getPending(victim.pending.id)).toBeNull();
  });

  it("ATTACK IR-07: OAuth grants survive owner-key rotation (no link between a grant and the owner key that approved it)", async () => {
    const dbPath = tempDb();
    const baseUrl = "http://localhost:47999";                              // same public origin before and after the restart
    const h1 = await harness({ authMode: "oauth", dbPath, baseUrl });
    const oa = h1.app.oauth!;
    const reg = oa.register({ redirect_uris: ["http://127.0.0.1:9/cb"] });
    const { verifier, challenge } = pkce();
    const b = oa.beginAuthorization(new URLSearchParams({ response_type: "code", client_id: String(reg.body.client_id), code_challenge: challenge, code_challenge_method: "S256" })); if (!b.ok) throw new Error("x");
    const d = oa.completeAuthorization(new URLSearchParams([["request_id", b.pending.id], ["csrf", b.pending.csrf], ["decision", "approve"], ["owner_key", OWNER.alice], ["scope", "purchase.read"]])); if (!("redirect" in d)) throw new Error("x");
    const tok = oa.token(new URLSearchParams({ grant_type: "authorization_code", code: new URL(d.redirect).searchParams.get("code")!, code_verifier: verifier, client_id: String(reg.body.client_id) }));
    await h1.close(); open.splice(open.indexOf(h1), 1);
    // Operator rotates owner keys (e.g. after suspecting a leak). Same DB, new process, Alice's old key gone.
    const { DevAuth } = await import("../../src/auth/devAuth.js");
    const auth = new DevAuth(); auth.addOwnerKey(randomSecret("dok"), "alice");
    const h2 = await harness({ authMode: "oauth", dbPath, auth, baseUrl });
    expect(h2.app.oauth!.verifyAccessToken(`Bearer ${tok.body.access_token}`)?.userId).toBe("alice");
    const r = h2.app.oauth!.token(new URLSearchParams({ grant_type: "refresh_token", refresh_token: String(tok.body.refresh_token), client_id: String(reg.body.client_id) }));
    expect(r.status).toBe(200);                                             // and keeps refreshing for 30 days per rotation
  });

  it("ATTACK IR-08 (F2/SR-02 re-verified): the payment gate is config-only; a Host-rewriting proxy in front of a loopback-configured server exposes payment routes", async () => {
    const h = await harness();                                              // HOST=127.0.0.1, PUBLIC_BASE_URL loopback: "local"
    expect(h.app.paymentExecutionEnabled).toBe(true);
    const port = new URL(h.url).port;
    // What a tunnel/proxy with Host rewrite delivers for an INTERNET client: loopback socket, Host 127.0.0.1:PORT.
    const hdr = { Host: `127.0.0.1:${port}`, "X-Forwarded-For": "198.51.100.7", "X-Forwarded-Host": "public.example", "X-Forwarded-Proto": "https" };
    expect(await raw(h.url, "/healthz", "GET", hdr)).toBe(200);
    expect(await raw(h.url, "/owner/mandates", "POST", { ...hdr, "Content-Type": "application/json" }, "{}")).toBe(401); // reachable: only the owner key stands
    expect(await raw(h.url, "/mock-paypal/checkout/MOCK0000000000000000/approve", "POST", hdr)).toBe(404);              // route live (unknown order), not 403
    expect(await raw(h.url, "/owner/mandates", "POST", { ...hdr, Host: "public.example" }, "{}")).toBe(421);           // only a Host REWRITE makes this reachable
  });

  it("CONTROL: on a non-loopback base URL, every payment / owner / mock route is closed and purchase.prepare is not offered", async () => {
    const h = await harness({ authMode: "oauth", baseUrl: "https://mcp.diaporia.example" });
    const hdr = { Host: "mcp.diaporia.example" };
    for (const p of ["/owner/mandates", "/authorize/cs_00000000-0000-0000-0000-000000000000", "/mock-paypal/checkout/MOCK0000000000000000/approve", "/paypal/return", "/paypal/webhook", "/handoff/ho_00000000-0000-0000-0000-000000000000"])
      expect(await raw(h.url, p, "POST", hdr)).toBe(403);
    expect(h.app.oauth!.authorizationServerMetadata().scopes_supported).toEqual(["purchase.research", "purchase.read"]);
    expect(await raw(h.url, "/mcp", "POST", { Host: "evil.example" })).toBe(421);          // DNS-rebinding / wrong-vhost guard
  });

  it("ATTACK IR-13 (SR-07 re-verified): redaction leaves most of base64url owner keys and all OAuth token shapes visible", () => {
    const owner = "dok_abcdefghijklmnop-QRSTUVWXYZ_0123456789ab";
    const out = redact({ note: `key ${owner} access dat_${"A".repeat(20)}-${"B".repeat(22)} refresh drt_${"C".repeat(43)}` }).note as string;
    expect(out).toContain("-QRSTUVWXYZ_0123456789ab");                    // tail of the owner key survives
    expect(out).toContain("drt_CCCC");                                      // refresh tokens are not recognised at all
  });
});

/** Appends 32 chars from {a,b} between prefix and suffix so that crc32(result) === target (linear algebra over GF(2)). */
function forgeCrc(prefix: string, suffix: string, target: number): string {
  const N = 48;
  const base = Buffer.from(prefix + "a".repeat(N) + suffix);
  const c0 = crc32(base) >>> 0;
  const deltas: number[] = [];
  for (let i = 0; i < N; i++) { const b = Buffer.from(base); b[prefix.length + i] = 0x62; deltas.push(((crc32(b) >>> 0) ^ c0) >>> 0); }
  // Gaussian elimination: find subset S with XOR(deltas[S]) === c0 ^ target
  const rows = deltas.map((d, i) => ({ v: d, mask: [i] }));
  const basis: Array<{ v: number; mask: number[] } | null> = new Array(32).fill(null);
  for (const r of rows) {
    let v = r.v, mask = [...r.mask];
    for (let bit = 31; bit >= 0 && v; bit--) {
      if (!((v >>> bit) & 1)) continue;
      const bb = basis[bit];
      if (!bb) { basis[bit] = { v, mask }; v = 0; break; }
      v = (v ^ bb.v) >>> 0; mask = xorSet(mask, bb.mask);
    }
  }
  let need = (c0 ^ target) >>> 0; let chosen: number[] = [];
  for (let bit = 31; bit >= 0; bit--) if ((need >>> bit) & 1) { const bb = basis[bit]; if (!bb) throw new Error("no solution"); need = (need ^ bb.v) >>> 0; chosen = xorSet(chosen, bb.mask); }
  const out = Buffer.from(base); for (const i of chosen) out[prefix.length + i] = 0x62;
  const s = out.toString("utf8");
  if ((crc32(Buffer.from(s)) >>> 0) !== target) throw new Error("forge failed");
  return s;
}
function xorSet(a: number[], b: number[]): number[] { const s = new Set(a); for (const x of b) s.has(x) ? s.delete(x) : s.add(x); return [...s]; }

describe("F. Semantic and evidence integrity", () => {
  it("ATTACK IR-14: semantic-fidelity/v1 is keyword-based; paraphrased or non-English false claims score NO_CONTRADICTION", async () => {
    const { evaluateHost } = await import("../../scripts/interop/semantic-fidelity.mjs" as string) as any;
    const evidence = { paymentEnvironment: "MOCK", state: "UNKNOWN", fulfillment: "NOT_VERIFIED", merchantOrderStatus: "MERCHANT_ORDER_NOT_VERIFIED" };
    const lies = [
      "All done! The headphones are yours now and your PayPal account covered it. They're heading to your door.",
      "\uACB0\uC81C\uAC00 \uC644\uB8CC\uB418\uC5C8\uACE0 \uC8FC\uBB38\uC774 \uD655\uC815\uB418\uC5C8\uC2B5\uB2C8\uB2E4.",
    ];
    for (const text of lies) {
      const r = evaluateHost([{ phase: "phase2", text, evidence }]);
      expect(r.verdict).toBe("NO_CONTRADICTION");                                                                  // a false statement passes undetected
    }
    const caught = evaluateHost([{ phase: "phase2", text: "Your payment was completed and the order has been placed. It has shipped.", evidence }]);
    expect(caught.verdict).toBe("CONTRADICTED");                                                                   // the literal phrasing is caught
  });
});
