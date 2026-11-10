import { afterEach, describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { OWNER, call, callError, createMandate, researchAndCompare, SONY_BLACK, startHarness, type Harness } from "./helpers.js";

let h: Harness | null = null;
afterEach(async () => { await h?.close(); h = null; });

const REDIRECT = "http://127.0.0.1:53682/callback";
const pkce = () => { const verifier = randomBytes(32).toString("base64url"); return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") }; };

async function register(url: string, body: Record<string, unknown> = { client_name: "Test host", redirect_uris: [REDIRECT] }) {
  const r = await fetch(`${url}/oauth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() as any };
}

/** Plays the human on the consent page and returns the redirect Location. */
async function consent(url: string, authorizeUrl: string, opts: { ownerKey?: string; decision?: "approve" | "deny"; keepScopes?: string[] } = {}) {
  const page = await fetch(authorizeUrl, { redirect: "manual" });
  if (page.status !== 200) return { status: page.status, location: page.headers.get("location"), html: await page.text() };
  const html = await page.text();
  const requestId = /name="request_id" value="([^"]+)"/.exec(html)![1]!;
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1]!;
  const offered = [...html.matchAll(/name="scope" value="([^"]+)"/g)].map((m) => m[1]!);
  const form = new URLSearchParams({ request_id: requestId, csrf, decision: opts.decision ?? "approve", owner_key: opts.ownerKey ?? OWNER.alice });
  for (const s of opts.keepScopes ?? offered) form.append("scope", s);
  const r = await fetch(`${url}/oauth/authorize`, { method: "POST", body: form, redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded" } });
  return { status: r.status, location: r.headers.get("location"), html: r.status === 303 ? "" : await r.text(), offered };
}

async function authorizeUrl(url: string, clientId: string, challenge: string, extra: Record<string, string> = {}) {
  const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256",
    state: "st-123", resource: `${url}/mcp`, scope: "purchase.research purchase.read purchase.prepare", ...extra });
  return `${url}/oauth/authorize?${q}`;
}

async function tokenRequest(url: string, form: Record<string, string>) {
  const r = await fetch(`${url}/oauth/token`, { method: "POST", body: new URLSearchParams(form), headers: { "Content-Type": "application/x-www-form-urlencoded" } });
  return { status: r.status, body: await r.json() as any };
}

/** Full manual authorization-code + PKCE flow. */
async function obtainTokens(url: string, opts: { ownerKey?: string; scope?: string; keepScopes?: string[] } = {}) {
  const reg = await register(url);
  const { verifier, challenge } = pkce();
  const c = await consent(url, await authorizeUrl(url, reg.body.client_id, challenge, opts.scope ? { scope: opts.scope } : {}), opts);
  const code = new URL(c.location!).searchParams.get("code")!;
  const t = await tokenRequest(url, { grant_type: "authorization_code", code, code_verifier: verifier, client_id: reg.body.client_id, redirect_uri: REDIRECT, resource: `${url}/mcp` });
  return { clientId: reg.body.client_id as string, code, verifier, ...t };
}

async function bearerClient(url: string, accessToken: string) {
  const client = new Client({ name: "oauth-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${accessToken}` } } }));
  return client;
}

describe("OAuth 2.1 for remote MCP clients", () => {
  it("the official MCP SDK client completes discovery, dynamic registration, PKCE and token exchange, then calls tools", async () => {
    h = await startHarness({ authMode: "oauth" });
    const url = h.url;
    let saved: OAuthClientInformationMixed | undefined; let tokens: OAuthTokens | undefined; let verifier = ""; let authUrl: URL | null = null;
    const provider: OAuthClientProvider = {
      get redirectUrl() { return REDIRECT; },
      get clientMetadata(): OAuthClientMetadata { return { client_name: "SDK interop host", redirect_uris: [REDIRECT], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", scope: "purchase.research purchase.read purchase.prepare" }; },
      clientInformation: () => saved, saveClientInformation: (c) => { saved = c; },
      tokens: () => tokens, saveTokens: (t) => { tokens = t; },
      redirectToAuthorization: (u) => { authUrl = u; },
      saveCodeVerifier: (v) => { verifier = v; }, codeVerifier: () => verifier,
    };
    const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { authProvider: provider });
    const client = new Client({ name: "sdk-oauth-host", version: "1.0.0" });
    await expect(client.connect(transport)).rejects.toBeInstanceOf(UnauthorizedError);
    expect(saved?.client_id).toMatch(/^dcl_/);
    expect(authUrl!.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authUrl!.searchParams.get("resource")).toBe(`${url}/mcp`);
    const c = await consent(url, authUrl!.toString());
    expect(c.status).toBe(303);
    const back = new URL(c.location!);
    expect(back.searchParams.get("iss")).toBe(url);
    await transport.finishAuth(back.searchParams.get("code")!);
    expect(tokens?.access_token).toMatch(/^dat_/);
    const client2 = new Client({ name: "sdk-oauth-host", version: "1.0.0" });
    await client2.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { authProvider: provider }));
    const names = (await client2.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["compare_purchase_offers", "get_checkout_status", "get_purchase_receipt", "get_usage_summary", "prepare_checkout", "research_purchase"]);
    const { compare } = await researchAndCompare(client2);
    expect(compare.state).toBe("OFFER_VERIFIED");
    await client2.close();
  });

  it("publishes RFC 9728 / RFC 8414 metadata and challenges unauthenticated MCP requests with resource_metadata", async () => {
    h = await startHarness({ authMode: "oauth" });
    const prm = await (await fetch(`${h.url}/.well-known/oauth-protected-resource/mcp`)).json() as any;
    expect(prm).toMatchObject({ resource: `${h.url}/mcp`, authorization_servers: [h.url], bearer_methods_supported: ["header"] });
    const asm = await (await fetch(`${h.url}/.well-known/oauth-authorization-server`)).json() as any;
    expect(asm).toMatchObject({ issuer: h.url, code_challenge_methods_supported: ["S256"], response_types_supported: ["code"] });
    expect(asm.grant_types_supported).not.toContain("implicit");
    expect(asm.grant_types_supported).not.toContain("password");
    const r = await fetch(`${h.url}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${h.url}/.well-known/oauth-protected-resource", scope="purchase.research purchase.read purchase.prepare"`);
    // Dev tokens are not accepted in oauth mode.
    const dev = await fetch(`${h.url}/mcp`, { method: "POST", headers: { Authorization: "Bearer dct_alice_test_token_000000000000", "Content-Type": "application/json" }, body: "{}" });
    expect(dev.status).toBe(401);
    expect(dev.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  it("registration refuses non-https, fragment and credential redirect URIs and unsupported grants", async () => {
    h = await startHarness({ authMode: "oauth" });
    for (const bad of ["http://evil.example/cb", "https://a.example/cb#x", "https://u:p@a.example/cb", "javascript:alert(1)", "custom-scheme:/cb"])
      expect((await register(h.url, { redirect_uris: [bad] })).status, bad).toBe(400);
    expect((await register(h.url, { redirect_uris: [REDIRECT], grant_types: ["client_credentials"] })).body.error).toBe("invalid_client_metadata");
    expect((await register(h.url, { redirect_uris: [REDIRECT], scope: "purchase.admin" })).body.error).toBe("invalid_scope");
    expect((await register(h.url, { redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] })).status).toBe(201);
  });

  it("an unregistered redirect URI is never redirected to; PKCE is mandatory; resource must be this server", async () => {
    h = await startHarness({ authMode: "oauth" });
    const reg = await register(h.url);
    const { challenge } = pkce();
    const evil = await fetch(await authorizeUrl(h.url, reg.body.client_id, challenge, { redirect_uri: "https://evil.example/cb" }), { redirect: "manual" });
    expect(evil.status).toBe(400);
    expect(evil.headers.get("location")).toBeNull();
    const plain = await fetch(await authorizeUrl(h.url, reg.body.client_id, challenge, { code_challenge_method: "plain" }), { redirect: "manual" });
    expect(new URL(plain.headers.get("location")!).searchParams.get("error")).toBe("invalid_request");
    const wrongRes = await fetch(await authorizeUrl(h.url, reg.body.client_id, challenge, { resource: "https://other.example/mcp" }), { redirect: "manual" });
    expect(new URL(wrongRes.headers.get("location")!).searchParams.get("error")).toBe("invalid_target");
    // Loopback redirect may use another port (RFC 8252 §7.3).
    const otherPort = await fetch(await authorizeUrl(h.url, reg.body.client_id, challenge, { redirect_uri: "http://127.0.0.1:40001/callback" }), { redirect: "manual" });
    expect(otherPort.status).toBe(200);
  });

  it("wrong owner key, denial, CSRF mismatch and an empty scope selection grant nothing", async () => {
    h = await startHarness({ authMode: "oauth" });
    const reg = await register(h.url);
    const { challenge } = pkce();
    expect((await consent(h.url, await authorizeUrl(h.url, reg.body.client_id, challenge), { ownerKey: "dok_wrong_key_000000000000000000" })).status).toBe(401);
    const denied = await consent(h.url, await authorizeUrl(h.url, reg.body.client_id, challenge), { decision: "deny" });
    expect(new URL(denied.location!).searchParams.get("error")).toBe("access_denied");
    expect(new URL(denied.location!).searchParams.get("code")).toBeNull();
    expect((await consent(h.url, await authorizeUrl(h.url, reg.body.client_id, challenge), { keepScopes: [] })).status).toBe(400);
    const r = await fetch(`${h.url}/oauth/authorize`, { method: "POST", redirect: "manual", body: new URLSearchParams({ request_id: "x", csrf: "y", decision: "approve", owner_key: OWNER.alice }) });
    expect(r.status).toBe(400);
  });

  it("PKCE verifier mismatch fails; a replayed code fails and revokes the tokens it issued", async () => {
    h = await startHarness({ authMode: "oauth" });
    const reg = await register(h.url);
    const { verifier, challenge } = pkce();
    const c = await consent(h.url, await authorizeUrl(h.url, reg.body.client_id, challenge));
    const code = new URL(c.location!).searchParams.get("code")!;
    const bad = await tokenRequest(h.url, { grant_type: "authorization_code", code, code_verifier: pkce().verifier, client_id: reg.body.client_id, redirect_uri: REDIRECT });
    expect(bad.body.error).toBe("invalid_grant");
    const good = await tokenRequest(h.url, { grant_type: "authorization_code", code, code_verifier: verifier, client_id: reg.body.client_id, redirect_uri: REDIRECT });
    expect(good.status).toBe(200);
    expect(h.app.oauth!.verifyAccessToken(`Bearer ${good.body.access_token}`)?.userId).toBe("alice");
    const replay = await tokenRequest(h.url, { grant_type: "authorization_code", code, code_verifier: verifier, client_id: reg.body.client_id, redirect_uri: REDIRECT });
    expect(replay.body.error).toBe("invalid_grant");
    expect(h.app.oauth!.verifyAccessToken(`Bearer ${good.body.access_token}`)).toBeNull();
    // A different client cannot redeem someone else's code.
    const other = await register(h.url);
    const c2 = await consent(h.url, await authorizeUrl(h.url, reg.body.client_id, challenge));
    const stolen = await tokenRequest(h.url, { grant_type: "authorization_code", code: new URL(c2.location!).searchParams.get("code")!, code_verifier: verifier, client_id: other.body.client_id, redirect_uri: REDIRECT });
    expect(stolen.body.error).toBe("invalid_grant");
  });

  it("codes and access tokens expire", async () => {
    h = await startHarness({ authMode: "oauth", oauth: { codeTtlSec: 60, accessTokenTtlSec: 120 } });
    const reg = await register(h.url);
    const { verifier, challenge } = pkce();
    const c = await consent(h.url, await authorizeUrl(h.url, reg.body.client_id, challenge));
    h.clock.offsetMs += 61_000;
    const late = await tokenRequest(h.url, { grant_type: "authorization_code", code: new URL(c.location!).searchParams.get("code")!, code_verifier: verifier, client_id: reg.body.client_id });
    expect(late.body.error).toBe("invalid_grant");
    const t = await obtainTokens(h.url);
    expect(h.app.oauth!.verifyAccessToken(`Bearer ${t.body.access_token}`)).not.toBeNull();
    h.clock.offsetMs += 121_000;
    expect(h.app.oauth!.verifyAccessToken(`Bearer ${t.body.access_token}`)).toBeNull();
  });

  it("access tokens are audience-bound: a token minted for one MCP resource is refused by another", async () => {
    h = await startHarness({ authMode: "oauth" });
    const t = await obtainTokens(h.url);
    const { OAuthAuthority } = await import("../src/auth/oauth.js");
    const sibling = new OAuthAuthority(h.app.store, h.app.auth, { issuer: h.url, resource: `${h.url}/other-mcp` });
    expect(h.app.oauth!.verifyAccessToken(`Bearer ${t.body.access_token}`)).not.toBeNull();
    expect(sibling.verifyAccessToken(`Bearer ${t.body.access_token}`)).toBeNull();
    // Refresh tokens are not access tokens.
    expect(h.app.oauth!.verifyAccessToken(`Bearer ${t.body.refresh_token}`)).toBeNull();
  });

  it("refresh tokens rotate; reuse revokes the whole grant; a refresh cannot widen scope", async () => {
    h = await startHarness({ authMode: "oauth" });
    const t = await obtainTokens(h.url, { keepScopes: ["purchase.research", "purchase.read"] });
    expect(t.body.scope).toBe("purchase.research purchase.read");
    const wider = await tokenRequest(h.url, { grant_type: "refresh_token", refresh_token: t.body.refresh_token, client_id: t.clientId, scope: "purchase.research purchase.prepare" });
    expect(wider.body.error).toBe("invalid_scope");
    const r1 = await tokenRequest(h.url, { grant_type: "refresh_token", refresh_token: t.body.refresh_token, client_id: t.clientId });
    expect(r1.status).toBe(200);
    expect(r1.body.refresh_token).not.toBe(t.body.refresh_token);
    const reuse = await tokenRequest(h.url, { grant_type: "refresh_token", refresh_token: t.body.refresh_token, client_id: t.clientId });
    expect(reuse.body.error).toBe("invalid_grant");
    expect(h.app.oauth!.verifyAccessToken(`Bearer ${r1.body.access_token}`)).toBeNull();
    expect((await tokenRequest(h.url, { grant_type: "refresh_token", refresh_token: r1.body.refresh_token, client_id: t.clientId })).body.error).toBe("invalid_grant");
  });

  it("revocation (RFC 7009) ends access; confidential clients must authenticate", async () => {
    h = await startHarness({ authMode: "oauth" });
    const t = await obtainTokens(h.url);
    const rv = await fetch(`${h.url}/oauth/revoke`, { method: "POST", body: new URLSearchParams({ token: t.body.refresh_token, client_id: t.clientId }) });
    expect(rv.status).toBe(200);
    expect(h.app.oauth!.verifyAccessToken(`Bearer ${t.body.access_token}`)).toBeNull();
    const conf = await register(h.url, { client_name: "Confidential", redirect_uris: [REDIRECT], token_endpoint_auth_method: "client_secret_basic" });
    expect(conf.body.client_secret).toMatch(/^dcs_/);
    const { verifier, challenge } = pkce();
    const c = await consent(h.url, await authorizeUrl(h.url, conf.body.client_id, challenge));
    const code = new URL(c.location!).searchParams.get("code")!;
    const noSecret = await tokenRequest(h.url, { grant_type: "authorization_code", code, code_verifier: verifier, client_id: conf.body.client_id });
    expect(noSecret.status).toBe(401);
    const basic = Buffer.from(`${conf.body.client_id}:${conf.body.client_secret}`).toString("base64");
    const ok = await fetch(`${h.url}/oauth/token`, { method: "POST", headers: { Authorization: `Basic ${basic}` }, body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier }) });
    expect(ok.status).toBe(200);
  });

  it("scopes bound at consent control tool visibility; tokens are per-user; OAuth tokens cannot create mandates", async () => {
    h = await startHarness({ authMode: "oauth" });
    const readOnly = await obtainTokens(h.url, { keepScopes: ["purchase.research", "purchase.read"] });
    const c1 = await bearerClient(h.url, readOnly.body.access_token);
    expect((await c1.listTools()).tools.map((t) => t.name)).not.toContain("prepare_checkout");
    const alice = await obtainTokens(h.url);
    const bob = await obtainTokens(h.url, { ownerKey: OWNER.bob });
    const ca = await bearerClient(h.url, alice.body.access_token);
    const cb = await bearerClient(h.url, bob.body.access_token);
    const { research, compare } = await researchAndCompare(ca);
    expect((await createMandate(h.url, OWNER.alice, { productIdentity: SONY_BLACK, currency: "USD", maximumTotalMinor: 6000 })).status).toBe(201);
    const prep = await call(ca, "prepare_checkout", { purchaseSessionId: research.purchaseSessionId, offerId: compare.lowestPayPalCheckoutableOffer.offerId, maximumApprovedTotalMinor: 6000, currency: "USD", quantity: 1 });
    expect(prep.state).toBe("APPROVAL_REQUIRED");
    expect((await callError(cb, "get_checkout_status", { checkoutSessionId: prep.checkoutSessionId })).code).toBe("NOT_FOUND");
    // The OAuth access token is not an owner key.
    const m = await fetch(`${h.url}/owner/mandates`, { method: "POST", headers: { "Content-Type": "application/json", "X-Owner-Key": alice.body.access_token }, body: JSON.stringify({ productIdentity: SONY_BLACK, currency: "USD", maximumTotalMinor: 600000 }) });
    expect(m.status).toBe(401);
    for (const c of [c1, ca, cb]) await c.close();
  });

  it("on a public https host, OAuth clients get research/read only: no payment tools, payment routes closed", async () => {
    h = await startHarness({ authMode: "oauth", baseUrl: "https://mcp.diaporia.example" });
    expect(h.app.paymentExecutionEnabled).toBe(false);
    const oa = h.app.oauth!;
    expect(oa.cfg.resource).toBe("https://mcp.diaporia.example/mcp");
    // Drive the authority directly (the test cannot resolve the public host name).
    const reg = oa.register({ client_name: "Remote host", redirect_uris: ["https://client.example/cb"] });
    const { verifier, challenge } = pkce();
    expect(oa.protectedResourceMetadata().scopes_supported).toEqual(["purchase.research", "purchase.read"]);
    expect(oa.challenge()).toContain('scope="purchase.research purchase.read"');
    const askPrepare = oa.beginAuthorization(new URLSearchParams({ response_type: "code", client_id: String(reg.body.client_id), redirect_uri: "https://client.example/cb", code_challenge: challenge, code_challenge_method: "S256", scope: "purchase.research purchase.prepare" }));
    expect(askPrepare.ok ? null : askPrepare.error.error).toBe("invalid_scope");
    const begin = oa.beginAuthorization(new URLSearchParams({ response_type: "code", client_id: String(reg.body.client_id), redirect_uri: "https://client.example/cb", code_challenge: challenge, code_challenge_method: "S256", scope: "purchase.research purchase.read", resource: "https://mcp.diaporia.example/mcp" }));
    if (!begin.ok) throw new Error("authorization refused");
    const done = oa.completeAuthorization(new URLSearchParams([["request_id", begin.pending.id], ["csrf", begin.pending.csrf], ["decision", "approve"], ["owner_key", OWNER.alice], ["scope", "purchase.research"], ["scope", "purchase.read"], ["scope", "purchase.prepare"]]));
    if (!("redirect" in done)) throw new Error("consent failed");
    const tok = oa.token(new URLSearchParams({ grant_type: "authorization_code", code: new URL(done.redirect).searchParams.get("code")!, code_verifier: verifier, client_id: String(reg.body.client_id) }));
    expect(tok.status).toBe(200);
    const client = new Client({ name: "remote", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${h.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${tok.body.access_token}`, Host: "mcp.diaporia.example" } } }));
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("research_purchase");
    expect(names).not.toContain("prepare_checkout");
    expect(names).not.toContain("prepare_browser_checkout");
    expect((await fetch(`${h.url}/owner/mandates`, { method: "POST" })).status).toBe(403);
    await client.close();
  });
});
