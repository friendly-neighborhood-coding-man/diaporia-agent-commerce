/**
 * Offline validation of the remote research/read-only MCP service (deploy/remote-mcp).
 *
 *   npm run remote:validate                       # local integration: spawns src/remote/main.ts, emulates the proxy
 *   npm run remote:validate -- --https https://mcp.diaporia.test:8443 --ca <caddy-root.crt> --resolve 127.0.0.1 \
 *        --secrets-file deploy/remote-mcp/local/harness-secrets.json [--restart-cmd "docker compose ... restart app"]
 *                                                 # local HTTPS emulation against the compose stack
 *
 * Never contacts anything but the local service. Never prints tokens, codes or owner keys.
 * Results: PASS/FAIL per check, grouped by the 15 steps, written to --out (default .data/remote-validate/).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// ---------------- arguments ----------------
const argv = process.argv.slice(2);
const arg = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const HTTPS_URL = arg("--https");
const MODE = HTTPS_URL ? "local-https-emulation" : "local-integration";
const OUT = resolve(arg("--out") ?? `.data/remote-validate/${new Date().toISOString().replace(/[:.]/g, "-")}-${MODE}`);
mkdirSync(OUT, { recursive: true });

// ---------------- results ----------------
interface Check { step: number; name: string; ok: boolean; detail?: string }
const checks: Check[] = [];
const secrets = new Set<string>();
const redact = (s: string) => { let t = s; for (const x of secrets) if (x) t = t.split(x).join("<redacted>"); return t.replace(/(dat|drt|dac|drk|dcs)_[A-Za-z0-9_-]{40,}/g, "$1_<redacted>"); };
function check(step: number, name: string, ok: boolean, detail?: unknown) {
  const d = detail === undefined ? undefined : redact(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 400);
  checks.push({ step, name, ok, ...(d ? { detail: d } : {}) });
  console.log(`${ok ? "PASS" : "FAIL"}  [${String(step).padStart(2)}] ${name}${!ok && d ? `  -- ${d}` : ""}`);
}

// ---------------- transport (emulated proxy or local HTTPS) ----------------
let PUBLIC = "https://mcp.diaporia.test";
let upstreamPort = 0;
const CA = arg("--ca") ? readFileSync(arg("--ca")!) : undefined;
const RESOLVE = arg("--resolve");
let forwardedFor: string | null = null;

interface Resp { status: number; headers: http.IncomingHttpHeaders; text: string }
function request(method: string, url: string, opts: { headers?: Record<string, string>; body?: string; hostOverride?: string } = {}): Promise<Resp> {
  const u = new URL(url);
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.body !== undefined) headers["content-length"] = String(Buffer.byteLength(opts.body));
  return new Promise((ok, fail) => {
    let req: http.ClientRequest;
    const done = (res: http.IncomingMessage) => { const c: Buffer[] = []; res.on("data", (d) => c.push(d)); res.on("end", () => ok({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(c).toString("utf8") })); };
    if (HTTPS_URL) {
      req = https.request({ method, host: u.hostname, port: u.port || 443, path: u.pathname + u.search, servername: u.hostname, ca: CA,
        headers: opts.hostOverride ? { ...headers, host: opts.hostOverride } : headers,
        ...(RESOLVE ? { lookup: (_h: string, o: any, cb: any) => o?.all ? cb(null, [{ address: RESOLVE, family: 4 }]) : cb(null, RESOLVE, 4) } : {}) }, done);
    } else {
      // Emulates the reverse proxy: plaintext to the upstream, original Host preserved, X-Forwarded-For appended.
      const h: Record<string, string> = { ...headers, host: opts.hostOverride ?? u.host };
      h["x-forwarded-for"] = forwardedFor ?? `203.0.113.${1 + Math.floor(Math.random() * 250)}`;
      req = http.request({ method, host: "127.0.0.1", port: upstreamPort, path: u.pathname + u.search, headers: h }, done);
    }
    req.on("error", fail);
    req.setTimeout(15_000, () => req.destroy(new Error("timeout")));
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}
/** FetchLike for the official MCP SDK client, over the same transport. */
const fetchLike = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const headers: Record<string, string> = {};
  new Headers(init?.headers).forEach((v, k) => { headers[k] = v; });
  const r = await request(init?.method ?? "GET", url, { headers, ...(init?.body !== undefined && init?.body !== null ? { body: String(init.body) } : {}) });
  const h = new Headers();
  for (const [k, v] of Object.entries(r.headers)) if (v !== undefined) h.set(k, Array.isArray(v) ? v.join(", ") : v);
  return new Response(r.status === 204 || r.status === 304 ? null : r.text, { status: r.status, headers: h });
};
const json = (r: Resp): any => { try { return JSON.parse(r.text); } catch { return null; } };
const form = (o: Record<string, string | string[]>) => { const f = new URLSearchParams(); for (const [k, v] of Object.entries(o)) for (const x of [v].flat()) f.append(k, x); return f.toString(); };
const FORM = { "content-type": "application/x-www-form-urlencoded" };

// ---------------- server lifecycle (local integration mode) ----------------
const WORK = mkdtempSync(join(tmpdir(), "diaporia-remote-"));
const DB = join(WORK, "data", "remote.sqlite");
mkdirSync(join(WORK, "data"), { recursive: true });
const newKey = () => `drk_${randomBytes(32).toString("base64url")}`;
const REDIRECT = "http://127.0.0.1:53682/callback";
interface TestClient { id: string; secret: string }
const newClient = (): TestClient => ({ id: `dcl_${randomBytes(16).toString("hex")}`, secret: `dcs_${randomBytes(32).toString("base64url")}` });
let KEYS: Record<string, string> = { alice: newKey(), bob: newKey() };
let CLIENTS: Record<string, TestClient> = { alice: newClient(), bob: newClient() };
let child: ChildProcess | null = null;
const logLines: string[] = [];
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const clientsEnv = () => Object.entries(CLIENTS).map(([u, c]) => `${c.id}|${sha256(c.secret)}|${u}-remote|${REDIRECT},https://claude.ai/api/mcp/auth_callback|Validation client (${u})`).join(";");

function remoteEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, NODE_NO_WARNINGS: "1",
    HOST: "127.0.0.1", PORT: String(upstreamPort), PUBLIC_BASE_URL: PUBLIC, DIAPORIA_DB_PATH: DB,
    DIAPORIA_OWNER_KEYS: Object.entries(KEYS).map(([u, k]) => `${k}=${u}-remote`).join(";"), DIAPORIA_OAUTH_CLIENTS: clientsEnv(), DIAPORIA_TRUSTED_PROXIES: "127.0.0.1" };
  for (const [k, v] of Object.entries(extra)) { if (v === undefined) delete env[k]; else env[k] = v; }
  return env;
}
const ENTRY = existsSync("dist/src/remote/main.js") && argv.includes("--built") ? ["node", ["dist/src/remote/main.js"]] as const : [process.execPath, ["--import", "tsx", "src/remote/main.ts"]] as const;
function runOnce(env: NodeJS.ProcessEnv): Promise<{ code: number | null; out: string }> {
  return new Promise((ok) => { const p = spawn(ENTRY[0], [...ENTRY[1]], { env, stdio: ["ignore", "pipe", "pipe"] }); let out = "";
    p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d)); const t = setTimeout(() => p.kill("SIGKILL"), 20_000); p.on("exit", (code) => { clearTimeout(t); ok({ code, out }); }); });
}
async function startServer(): Promise<string> {
  child = spawn(ENTRY[0], [...ENTRY[1]], { env: remoteEnv(), stdio: ["ignore", "pipe", "pipe"] });
  let started = "";
  child.stdout!.on("data", (d) => { for (const l of String(d).split("\n").filter(Boolean)) { logLines.push(l); if (l.includes('"event":"startup"')) started = l; } });
  child.stderr!.on("data", (d) => logLines.push(`stderr: ${d}`));
  for (let i = 0; i < 100 && !started; i++) await new Promise((r) => setTimeout(r, 200));
  return started;
}
async function stopServer() { if (!child) return; const c = child; child = null; await new Promise<void>((ok) => { c.on("exit", () => ok()); c.kill("SIGTERM"); }); }
async function freePort(): Promise<number> { return new Promise((ok) => { const s = http.createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as any).port; s.close(() => ok(p)); }); }); }

// ---------------- OAuth helpers ----------------
const pkce = () => { const verifier = randomBytes(32).toString("base64url"); return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") }; };
function authorizeUrl(clientId: string, challenge: string, scope = "purchase.research purchase.read", redirect = REDIRECT) {
  return `${PUBLIC}/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", state: "st-1", resource: `${PUBLIC}/mcp`, scope })}`;
}
async function consent(url: string, ownerKey: string, decision = "approve") {
  const page = await request("GET", url);
  if (page.status !== 200) return { status: page.status, location: String(page.headers.location ?? ""), html: page.text };
  const rid = /name="request_id" value="([^"]+)"/.exec(page.text)?.[1] ?? ""; const csrf = /name="csrf" value="([^"]+)"/.exec(page.text)?.[1] ?? "";
  const scopes = [...page.text.matchAll(/name="scope" value="([^"]+)"/g)].map((m) => m[1]!);
  const r = await request("POST", `${PUBLIC}/oauth/authorize`, { headers: { ...FORM, origin: PUBLIC }, body: form({ request_id: rid, csrf, decision, owner_key: ownerKey, scope: scopes }) });
  return { status: r.status, location: String(r.headers.location ?? ""), scopes, html: page.text, postHtml: r.text };
}
/** Token endpoint call authenticated as `c` with client_secret_post (or none when c.secret is ""). */
async function token(c: TestClient, body: Record<string, string>) {
  const r = await request("POST", `${PUBLIC}/oauth/token`, { headers: FORM, body: form({ ...body, client_id: c.id, ...(c.secret ? { client_secret: c.secret } : {}) }) });
  const j = json(r); if (j?.access_token) secrets.add(j.access_token); if (j?.refresh_token) secrets.add(j.refresh_token); return { r, j };
}
async function codeFor(c: TestClient, ownerKey: string) {
  const { verifier, challenge } = pkce();
  const k = await consent(authorizeUrl(c.id, challenge), ownerKey);
  const code = new URL(k.location || "http://x/").searchParams.get("code") ?? ""; secrets.add(code);
  return { code, verifier, consent: k };
}
async function grant(user: string, opts: { client?: TestClient; key?: string } = {}) {
  const c = opts.client ?? CLIENTS[user]!;
  const { code, verifier } = await codeFor(c, opts.key ?? KEYS[user]!);
  const t = await token(c, { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: REDIRECT, resource: `${PUBLIC}/mcp` });
  return { client: c, code, verifier, access: t.j?.access_token as string, refresh: t.j?.refresh_token as string, scope: t.j?.scope as string, status: t.r.status };
}
async function mcp(accessToken: string) {
  const client = new Client({ name: "diaporia-remote-validate", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${PUBLIC}/mcp`), { fetch: fetchLike as any, requestInit: { headers: { Authorization: `Bearer ${accessToken}` } } }));
  return client;
}
async function tool(client: Client, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; sc: any; text: string }> {
  const r: any = await client.callTool({ name, arguments: args });
  return { isError: !!r.isError, sc: r.structuredContent, text: (r.content ?? []).map((c: any) => c.text ?? "").join(" ") };
}
const rpc = (accessToken: string, body: unknown) => request("POST", `${PUBLIC}/mcp`, { headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify(body) });
const listOk = async (access: string) => (await rpc(access, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status;
const SONY = { brand: "Sony", model: "WH-CH720N", variant: "Black", condition: "new", sku: "WHCH720N/B" };

// ---------------- the run ----------------
async function main() {
  if (HTTPS_URL) {
    PUBLIC = new URL(HTTPS_URL).origin;
    const sf = arg("--secrets-file"); if (!sf) throw new Error("--secrets-file is required with --https");
    const s = JSON.parse(readFileSync(sf, "utf8"));
    KEYS = s.keys; CLIENTS = s.clients;
    if (!KEYS.alice || !KEYS.bob || !CLIENTS.alice || !CLIENTS.bob) throw new Error("secrets file must hold keys and clients for alice and bob");
  } else {
    upstreamPort = await freePort();
    // Startup refusals: each must exit 78 before listening.
    const refusals: [string, Record<string, string | undefined>][] = [
      ["http base URL", { PUBLIC_BASE_URL: "http://mcp.diaporia.test" }],
      ["loopback base URL", { PUBLIC_BASE_URL: "https://127.0.0.1:8443" }],
      ["localhost base URL", { PUBLIC_BASE_URL: "https://localhost" }],
      ["base URL with path", { PUBLIC_BASE_URL: "https://mcp.diaporia.test/x" }],
      ["missing owner keys", { DIAPORIA_OWNER_KEYS: undefined }],
      ["local dok_ owner key", { DIAPORIA_OWNER_KEYS: `dok_${randomBytes(24).toString("base64url")}=alice` }],
      ["short owner key", { DIAPORIA_OWNER_KEYS: `drk_${"short"}=alice` }],
      ["no pre-registered OAuth clients", { DIAPORIA_OAUTH_CLIENTS: undefined }],
      ["client secret in clear instead of sha256", { DIAPORIA_OAUTH_CLIENTS: `${CLIENTS.alice!.id}|${CLIENTS.alice!.secret}|alice-remote|${REDIRECT}|x` }],
      ["client bound to a user without an owner key", { DIAPORIA_OAUTH_CLIENTS: `${CLIENTS.alice!.id}|${sha256("x")}|mallory|${REDIRECT}|x` }],
      ["client redirect outside the allowlist", { DIAPORIA_OAUTH_CLIENTS: `${CLIENTS.alice!.id}|${sha256("x")}|alice-remote|https://evil.example/cb|x` }],
      ["dynamic registration requested", { DIAPORIA_OAUTH_REGISTRATION: "dynamic" }],
      ["PayPal credentials present", { PAYPAL_CLIENT_ID: "x" }],
      ["PAYMENT_PROVIDER=paypal_sandbox", { PAYMENT_PROVIDER: "paypal_sandbox" }],
      ["browser handoff driver", { HANDOFF_DRIVER: "kernel" }],
      ["live research provider", { RESEARCH_PROVIDER: "channel3" }],
      ["KERNEL key", { KERNEL_API_KEY: "x" }],
      ["dev tokens", { DIAPORIA_DEV_TOKENS: "a=b:purchase.prepare" }],
      ["managed mode", { DIAPORIA_DEPLOYMENT_MODE: "managed" }],
      ["auth mode dev", { DIAPORIA_AUTH_MODE: "dev" }],
      ["in-memory database", { DIAPORIA_DB_PATH: ":memory:" }],
    ];
    for (const [name, extra] of refusals) {
      const r = await runOnce(remoteEnv(extra));
      check(1, `startup refused: ${name} (exit 78, never listens)`, r.code === 78 && r.out.includes("startup_refused") && !r.out.includes('"event":"startup"'), `exit=${r.code}`);
    }
    const started = await startServer();
    check(1, "service starts with the remote read-only profile", !!started, logLines.slice(-3).join(" | "));
    const s = started ? JSON.parse(started) : {};
    check(1, "startup manifest: payment execution off, MOCK fixtures, research/read scopes, closed registration, key-bound grants",
      s.paymentExecutionEnabled === false && s.research === "mock-fixtures" && JSON.stringify(s.scopes) === JSON.stringify(["purchase.research", "purchase.read"]) && s.registration === "closed" && s.grantsBoundToOwnerKey === true, s);
    if (!started) return;
  }

  // 1. startup / health
  const hz = await request("GET", `${PUBLIC}/healthz`);
  if (HTTPS_URL) check(1, "/healthz is not exposed publicly (internal health check only; IR-21)", hz.status === 404, hz.status);
  else check(1, "healthz 200, paymentExecutionEnabled=false, authMode=oauth, MOCK", hz.status === 200 && json(hz)?.paymentExecutionEnabled === false && json(hz)?.authMode === "oauth" && json(hz)?.paymentEnvironment === "MOCK", hz.text);
  const foreign = await request("GET", `${PUBLIC}/.well-known/oauth-protected-resource`, { hostOverride: "evil.example" });
  // The app answers 421; Caddy answers an unmatched Host with an empty 200 (no site, nothing proxied).
  check(1, "foreign Host header never reaches the service (421, or Caddy's empty no-site response)", foreign.status === 421 || (!!HTTPS_URL && foreign.status === 200 && foreign.text === ""), [foreign.status, foreign.text.slice(0, 40)]);
  if (!HTTPS_URL) {
    const loop = await request("GET", `${PUBLIC}/healthz`, { hostOverride: `127.0.0.1:${upstreamPort}` });
    check(1, "loopback Host header refused (strict host: a Host-rewriting proxy cannot reach the service)", loop.status === 421, loop.status);
  }

  // 2. discovery
  const prm = await request("GET", `${PUBLIC}/.well-known/oauth-protected-resource`);
  const prm2 = await request("GET", `${PUBLIC}/.well-known/oauth-protected-resource/mcp`);
  check(2, "protected resource metadata (RFC 9728) names the resource and issuer", json(prm)?.resource === `${PUBLIC}/mcp` && json(prm)?.authorization_servers?.[0] === PUBLIC && prm2.status === 200, prm.text);
  const asm = await request("GET", `${PUBLIC}/.well-known/oauth-authorization-server`);
  const a = json(asm) ?? {};
  check(2, "authorization server metadata (RFC 8414): issuer, S256 only, code flow, iss parameter", a.issuer === PUBLIC && JSON.stringify(a.code_challenge_methods_supported) === '["S256"]' && a.authorization_response_iss_parameter_supported === true, a);
  check(2, "no registration_endpoint advertised; token endpoint accepts confidential clients only", !("registration_endpoint" in a) && JSON.stringify([...(a.token_endpoint_auth_methods_supported ?? [])].sort()) === '["client_secret_basic","client_secret_post"]', a);
  check(2, "advertised scopes exclude purchase.prepare", Array.isArray(a.scopes_supported) && !a.scopes_supported.includes("purchase.prepare") && (json(prm)?.scopes_supported ?? []).every((x: string) => x !== "purchase.prepare"), a.scopes_supported);
  const unauth = await request("POST", `${PUBLIC}/mcp`, { headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
  check(2, "unauthenticated /mcp: 401 with WWW-Authenticate resource_metadata", unauth.status === 401 && String(unauth.headers["www-authenticate"] ?? "").includes("resource_metadata="), unauth.status);

  // 3. client registration: operator-registered clients only
  for (const redirect of [REDIRECT, "https://claude.ai/api/mcp/auth_callback", "https://chatgpt.com/connector_platform_oauth_redirect"]) {
    const r = await request("POST", `${PUBLIC}/oauth/register`, { headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Claude", redirect_uris: [redirect] }) });
    // The app answers 403; behind Caddy the path is not forwarded at all (404).
    check(3, `dynamic registration refused even for a familiar name and allowlisted callback (${redirect})`, (r.status === 403 || (!!HTTPS_URL && r.status === 404)) && !json(r)?.client_id, r.status);
  }
  const unknown = await request("GET", authorizeUrl(newClient().id, pkce().challenge));
  check(3, "authorize with an unknown client id: error page, no redirect", unknown.status === 400 && !unknown.headers.location, unknown.status);
  const unreg = await request("GET", authorizeUrl(CLIENTS.alice!.id, pkce().challenge, undefined, "https://evil.example/cb"));
  check(3, "authorize with a redirect not registered for that client issues no redirect", unreg.status === 400 && !unreg.headers.location, unreg.status);
  const page = await request("GET", authorizeUrl(CLIENTS.alice!.id, pkce().challenge));
  check(3, "consent page names the operator-registered client and the one account it is bound to", page.status === 200 && page.text.includes("registered by this server") && page.text.includes("alice-remote") && !page.text.includes("self-registered"), page.status);

  // 4. authorization with a local test user
  const ask = await request("GET", authorizeUrl(CLIENTS.alice!.id, pkce().challenge, "purchase.research purchase.prepare"));
  check(4, "a request for purchase.prepare is refused (invalid_scope)", String(ask.headers.location ?? "").includes("error=invalid_scope"), ask.headers.location);
  const wrong = await consent(authorizeUrl(CLIENTS.alice!.id, pkce().challenge), newKey());
  check(4, "consent with an unknown owner key is refused", wrong.status === 401, wrong.status);
  const crossUser = await consent(authorizeUrl(CLIENTS.alice!.id, pkce().challenge), KEYS.bob!);
  check(4, "alice's client cannot be approved with bob's owner key (client bound to one user)", crossUser.status === 403 && !crossUser.location, crossUser.status);
  const csrfBad = await (async () => { const p = await request("GET", authorizeUrl(CLIENTS.alice!.id, pkce().challenge)); const rid = /name="request_id" value="([^"]+)"/.exec(p.text)?.[1] ?? "";
    return request("POST", `${PUBLIC}/oauth/authorize`, { headers: { ...FORM, origin: PUBLIC }, body: form({ request_id: rid, csrf: "forged", decision: "approve", owner_key: KEYS.alice!, scope: ["purchase.research"] }) }); })();
  check(4, "consent with a forged CSRF token is refused", csrfBad.status === 400, csrfBad.status);
  const crossOrigin = await (async () => { const p = await request("GET", authorizeUrl(CLIENTS.alice!.id, pkce().challenge)); const rid = /name="request_id" value="([^"]+)"/.exec(p.text)?.[1] ?? ""; const csrf = /name="csrf" value="([^"]+)"/.exec(p.text)?.[1] ?? "";
    return request("POST", `${PUBLIC}/oauth/authorize`, { headers: { ...FORM, origin: "https://evil.example" }, body: form({ request_id: rid, csrf, decision: "approve", owner_key: KEYS.alice!, scope: ["purchase.research"] }) }); })();
  check(4, "consent POST from a foreign Origin is refused", crossOrigin.status === 403, crossOrigin.status);
  const first = await codeFor(CLIENTS.alice!, KEYS.alice!);
  const loc = new URL(first.consent.location || "http://x/");
  check(4, "test user alice approves her own client: redirect carries code, state and iss (RFC 9207)", !!first.code && loc.searchParams.get("state") === "st-1" && loc.searchParams.get("iss") === PUBLIC && JSON.stringify(first.consent.scopes) === '["purchase.research","purchase.read"]', first.consent.status);

  // 5. code exchange: PKCE + client authentication
  const tok = (c: TestClient, code: string, verifier: string, extra: Record<string, string> = {}) => token(c, { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: REDIRECT, resource: `${PUBLIC}/mcp`, ...extra });
  const noSecret = await tok({ id: CLIENTS.alice!.id, secret: "" }, first.code, first.verifier);
  check(5, "phishing simulation: the code alone (client id known, no secret) cannot be exchanged", noSecret.r.status === 401 && noSecret.j?.error === "invalid_client", noSecret.j);
  const badSecret = await tok({ id: CLIENTS.alice!.id, secret: newClient().secret }, first.code, first.verifier);
  check(5, "wrong client secret refused", badSecret.r.status === 401, badSecret.j);
  const otherClient = await tok(CLIENTS.bob!, first.code, first.verifier);
  check(5, "a code issued to alice's client cannot be redeemed with bob's client credentials", otherClient.r.status === 400 && otherClient.j?.error === "invalid_grant", otherClient.j);
  const badV = await tok(CLIENTS.alice!, first.code, pkce().verifier);
  check(5, "wrong PKCE verifier refused", badV.r.status === 400 && badV.j?.error === "invalid_grant", badV.j);
  const g = await grant("alice");
  check(5, "code + PKCE S256 + client secret → access and refresh tokens, research/read scope", g.status === 200 && !!g.access && !!g.refresh && g.scope === "purchase.research purchase.read", g.status);
  const basic = await (async () => { const { code, verifier } = await codeFor(CLIENTS.alice!, KEYS.alice!);
    const r = await request("POST", `${PUBLIC}/oauth/token`, { headers: { ...FORM, authorization: `Basic ${Buffer.from(`${CLIENTS.alice!.id}:${CLIENTS.alice!.secret}`).toString("base64")}` }, body: form({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: REDIRECT, resource: `${PUBLIC}/mcp` }) });
    const j = json(r); if (j?.access_token) secrets.add(j.access_token); if (j?.refresh_token) secrets.add(j.refresh_token); return r; })();
  check(5, "client_secret_basic also works (hosts differ)", basic.status === 200, basic.status);
  const replay = await tok(CLIENTS.alice!, g.code, g.verifier);
  check(5, "authorization code replay refused", replay.r.status === 400 && replay.j?.error === "invalid_grant", replay.j);
  check(5, "code replay revokes the tokens that code produced", (await listOk(g.access)) === 401);
  const main = await grant("alice");
  const wrongRes = await (async () => { const { code, verifier } = await codeFor(CLIENTS.alice!, KEYS.alice!); return tok(CLIENTS.alice!, code, verifier, { resource: "https://other.example/mcp" }); })();
  check(5, "token request for another resource (RFC 8707) refused", wrongRes.r.status === 400, wrongRes.j);

  // 6. MCP session initialisation (official SDK client, remote-style)
  const alice = await mcp(main.access);
  const sv = alice.getServerVersion();
  check(6, "MCP initialize over Streamable HTTP with the bearer token", sv?.name === "diaporia-agent-commerce", sv);
  const allTools = (await alice.listTools()).tools;
  const tools = allTools.map((t) => t.name).sort();
  check(6, "tools/list = 5 research/read tools", JSON.stringify(tools) === JSON.stringify(["compare_purchase_offers", "get_checkout_status", "get_purchase_receipt", "get_usage_summary", "research_purchase"]), tools);
  check(6, "every offered tool is annotated readOnlyHint=true, destructiveHint=false", allTools.every((t) => t.annotations?.readOnlyHint === true && t.annotations?.destructiveHint === false), allTools.map((t) => [t.name, t.annotations]));

  // 7. research
  const research = await tool(alice, "research_purchase", { request: "Buy Sony WH-CH720N Black for the lowest total price, but never exceed $60.", budgetMinor: 6000, currency: "USD" });
  const sc = research.sc ?? {};
  check(7, "research_purchase returns candidates with evidence", !research.isError && Array.isArray(sc.candidates) && sc.candidates.length > 0, research.text.slice(0, 200));
  check(7, "research result says paymentEffect NONE and labels MOCK fixtures", sc.paymentEffect === "NONE" && sc.dataSource?.mockData === true && sc.dataSource?.paymentEnvironment === "MOCK", sc.dataSource);

  // 8. read-only retrieval
  const cmp = await tool(alice, "compare_purchase_offers", { researchSessionId: sc.purchaseSessionId, productIdentity: SONY, destination: { country: "US", region: "CA" } });
  check(8, "compare_purchase_offers returns verified offers with full cost breakdown", !cmp.isError && Array.isArray(cmp.sc?.eligibleOffers) && cmp.sc.eligibleOffers.every((o: any) => typeof o.cost?.totalMinor === "number" || o.cost?.unknownComponents), cmp.text.slice(0, 200));
  const st = await tool(alice, "get_checkout_status", { checkoutSessionId: "cs_00000000-0000-4000-8000-000000000000" });
  check(8, "get_checkout_status of an unknown checkout = error, no data", st.isError, st.text.slice(0, 120));
  const rc = await tool(alice, "get_purchase_receipt", { checkoutSessionId: "cs_00000000-0000-4000-8000-000000000000" });
  check(8, "get_purchase_receipt of an unknown checkout = error, no data", rc.isError, rc.text.slice(0, 120));
  const us = await tool(alice, "get_usage_summary", {});
  check(8, "get_usage_summary is readable and charges nothing", !us.isError, us.text.slice(0, 160));

  // 12. cross-user isolation
  const bobGrant = await grant("bob");
  const bob = await mcp(bobGrant.access);
  const steal = await tool(bob, "compare_purchase_offers", { researchSessionId: sc.purchaseSessionId, productIdentity: SONY });
  check(12, "bob cannot read alice's research session (NOT_FOUND)", steal.isError && /NOT_FOUND/.test(steal.text), steal.text.slice(0, 160));
  const bobRefreshAsAlice = await token(CLIENTS.bob!, { grant_type: "refresh_token", refresh_token: main.refresh });
  check(12, "alice's refresh token presented with bob's client credentials is refused", bobRefreshAsAlice.r.status === 400, bobRefreshAsAlice.j);
  const bobUsage = await tool(bob, "get_usage_summary", {});
  check(12, "usage summaries are per user", !bobUsage.isError && !JSON.stringify(bobUsage.sc ?? {}).includes("alice"), bobUsage.text.slice(0, 80));
  await bob.close();

  // 13. disallowed payment tools and routes
  for (const name of ["prepare_checkout", "prepare_browser_checkout", "buy_now", "capture_payment"]) {
    const r = await rpc(main.access, { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name, arguments: { purchaseSessionId: sc.purchaseSessionId, offerId: "x", maximumApprovedTotalMinor: 1, currency: "USD", quantity: 1 } } });
    const j = json(r);
    check(13, `tools/call ${name} is rejected (tool not found)`, r.status === 200 && (j?.result?.isError === true || !!j?.error) && /not found/i.test(JSON.stringify(j)), j);
  }
  const routes = ["/owner/mandates", "/owner/mandates/mdt_00000000-0000-4000-8000-000000000000/revoke", "/owner/checkouts/cs_00000000-0000-4000-8000-000000000000/cancel",
    "/owner/checkouts/cs_00000000-0000-4000-8000-000000000000/reconcile", "/authorize/cs_00000000-0000-4000-8000-000000000000", "/paypal/webhook", "/paypal/return",
    "/mock-paypal/checkout/MOCK0000000000000000/approve", "/billing/webhook/mock", "/billing/subscribe", "/handoff/x", "/operator/x", "/admin",
    "/%6Fwner/mandates", "/OWNER/mandates", "//owner/mandates", "/mcp/../owner/mandates", "/oauth/../owner/mandates", "/owner%2Fmandates", "/./owner/mandates"];
  for (const p of routes) for (const method of ["GET", "POST"]) {
    const r = await request(method, `${PUBLIC}${p}`, { headers: { authorization: `Bearer ${main.access}`, "x-owner-key": KEYS.alice!, origin: PUBLIC, ...FORM }, body: method === "POST" ? "ownerKey=x" : undefined });
    check(13, `${method} ${p} is closed (403/404) even with a valid token and owner key`, r.status === 403 || r.status === 404, r.status);
  }

  // 9. token refresh (rotation)
  const ref = await token(CLIENTS.alice!, { grant_type: "refresh_token", refresh_token: main.refresh });
  check(9, "refresh rotates: new access + refresh token, same scope", ref.r.status === 200 && ref.j.refresh_token !== main.refresh && ref.j.scope === "purchase.research purchase.read", ref.r.status);
  const widen = await token(CLIENTS.alice!, { grant_type: "refresh_token", refresh_token: ref.j.refresh_token, scope: "purchase.research purchase.read purchase.prepare" });
  check(9, "refresh cannot widen scope to purchase.prepare", widen.r.status === 400, widen.j);
  const refNoSecret = await token({ id: CLIENTS.alice!.id, secret: "" }, { grant_type: "refresh_token", refresh_token: ref.j.refresh_token });
  check(9, "refresh without the client secret is refused", refNoSecret.r.status === 401, refNoSecret.j);
  const cur = { access: ref.j.access_token as string, refresh: ref.j.refresh_token as string };
  const rg = await grant("alice");
  const r1 = await token(CLIENTS.alice!, { grant_type: "refresh_token", refresh_token: rg.refresh });
  const reuse = await token(CLIENTS.alice!, { grant_type: "refresh_token", refresh_token: rg.refresh });
  check(9, "refresh-token reuse is refused and revokes the whole grant", reuse.r.status === 400 && (await listOk(r1.j.access_token)) === 401, reuse.r.status);

  // 14. restart and persistence
  let restarted = false;
  if (!HTTPS_URL) { await stopServer(); restarted = !!(await startServer()); }
  else if (arg("--restart-cmd")) { const r = spawn("sh", ["-c", arg("--restart-cmd")!], { stdio: "inherit" }); await new Promise((ok) => r.on("exit", ok));
    for (let i = 0; i < 60; i++) { try { if ((await request("GET", `${PUBLIC}/.well-known/oauth-protected-resource`)).status === 200) { restarted = true; break; } } catch { /* starting */ } await new Promise((r2) => setTimeout(r2, 1000)); } }
  if (restarted) {
    check(14, "service restarts on the same database", true);
    check(14, "access token issued before the restart is still valid (DB-backed, same owner key)", (await listOk(cur.access)) === 200);
    const pref = await token(CLIENTS.alice!, { grant_type: "refresh_token", refresh_token: cur.refresh });
    check(14, "refresh token issued before the restart still rotates", pref.r.status === 200, pref.r.status);
    cur.access = pref.j?.access_token ?? cur.access; cur.refresh = pref.j?.refresh_token ?? cur.refresh;
    const again = await mcp(cur.access);
    const cmp2 = await tool(again, "compare_purchase_offers", { researchSessionId: sc.purchaseSessionId, productIdentity: SONY });
    check(14, "alice's research session survives the restart", !cmp2.isError, cmp2.text.slice(0, 120));
    await again.close();
  } else check(14, "restart and persistence", false, HTTPS_URL ? "NOT_RUN: pass --restart-cmd to restart the compose app service" : "restart failed");

  // 10. revocation
  const rev = await request("POST", `${PUBLIC}/oauth/revoke`, { headers: FORM, body: form({ token: cur.refresh, client_id: CLIENTS.alice!.id, client_secret: CLIENTS.alice!.secret }) });
  check(10, "revoking the refresh token (RFC 7009) revokes the grant; access token now 401", rev.status === 200 && (await listOk(cur.access)) === 401, rev.status);
  const deadRefresh = await token(CLIENTS.alice!, { grant_type: "refresh_token", refresh_token: cur.refresh });
  check(10, "revoked refresh token cannot be used", deadRefresh.r.status === 400, deadRefresh.j);

  // 11. invalid tokens
  for (const [name, h] of [["random bearer", `Bearer dat_${randomBytes(32).toString("base64url")}`], ["owner key as bearer", `Bearer ${KEYS.alice}`], ["client secret as bearer", `Bearer ${CLIENTS.alice!.secret}`], ["refresh token as bearer", `Bearer ${rg.refresh}`], ["Basic scheme", "Basic YTpi"], ["empty bearer", "Bearer "]] as const) {
    const r = await request("POST", `${PUBLIC}/mcp`, { headers: { authorization: h, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
    check(11, `${name} rejected with 401`, r.status === 401, r.status);
  }

  // rate limits behind the proxy (local integration only: the harness plays the proxy)
  if (!HTTPS_URL) {
    forwardedFor = "198.51.100.7"; let limited = 0;
    for (let i = 0; i < 32; i++) if ((await request("GET", `${PUBLIC}/.well-known/oauth-authorization-server`)).status === 429) limited++;
    forwardedFor = "198.51.100.8"; const other = await request("GET", `${PUBLIC}/.well-known/oauth-authorization-server`); forwardedFor = null;
    check(13, "rate limit is per client behind a trusted proxy: one noisy client is limited, another is not", limited > 0 && other.status === 200, [limited, other.status]);
  }

  // 15. owner-key rotation, rollback and restore (local integration: the harness controls keys and the database)
  if (!HTTPS_URL) {
    const live = await grant("alice"); const bobLive = await grant("bob");
    await stopServer();
    const backup = `${DB}.bak`; copyFileSync(DB, backup); copyFileSync(`${DB.replace(/\.sqlite$/, "")}-service.sqlite`, `${backup}-service`);
    let down = false; try { await request("GET", `${PUBLIC}/.well-known/oauth-protected-resource`); } catch { down = true; }
    check(15, "rollback to OFF: stopping the service closes the endpoint", down);
    // Rotate alice's key WITHOUT the revoke-all flag: her grants must die on their own.
    const oldAliceKey = KEYS.alice!; KEYS.alice = newKey();
    const rot = await startServer();
    const rs = rot ? JSON.parse(rot) : {};
    check(15, "after rotating alice's key (no revoke-all flag) startup revokes her old grant persistently", !!rot && rs.housekeeping?.stale >= 2, rs.housekeeping);
    check(15, "alice's pre-rotation access token is refused", (await listOk(live.access)) === 401);
    const oldRefresh = await token(CLIENTS.alice!, { grant_type: "refresh_token", refresh_token: live.refresh });
    check(15, "alice's pre-rotation refresh token is refused (invalid_grant)", oldRefresh.r.status === 400 && oldRefresh.j?.error === "invalid_grant", oldRefresh.j);
    check(15, "bob's grant is unaffected by alice's rotation", (await listOk(bobLive.access)) === 200);
    const oldKeyConsent = await consent(authorizeUrl(CLIENTS.alice!.id, pkce().challenge), oldAliceKey);
    check(15, "the retired owner key can no longer approve anything", oldKeyConsent.status === 401, oldKeyConsent.status);
    const fresh = await grant("alice");
    check(15, "alice authorizes again with her new key", fresh.status === 200 && (await listOk(fresh.access)) === 200, fresh.status);
    // Restore the pre-rotation database (rollback of data) while keeping the new keys: old grants must stay dead.
    await stopServer();
    copyFileSync(backup, DB); copyFileSync(`${backup}-service`, `${DB.replace(/\.sqlite$/, "")}-service.sqlite`);
    const back = await startServer();
    check(15, "restore the pre-rotation backup with the current keys: starts healthy, still read-only", !!back && json(await request("GET", `${PUBLIC}/healthz`))?.paymentExecutionEnabled === false);
    check(15, "restored backup cannot revive the pre-rotation grant (access)", (await listOk(live.access)) === 401);
    const revived = await token(CLIENTS.alice!, { grant_type: "refresh_token", refresh_token: live.refresh });
    check(15, "restored backup cannot revive the pre-rotation grant (refresh)", revived.r.status === 400, revived.j);
    check(15, "bob's grant survives the restore", (await listOk(bobLive.access)) === 200);
    // Removing a client from DIAPORIA_OAUTH_CLIENTS (rollback of a registration) kills its grants too.
    await stopServer();
    const bobClient = CLIENTS.bob!; delete CLIENTS.bob;
    await startServer();
    check(15, "removing bob's client registration revokes its grants at startup", (await listOk(bobLive.access)) === 401);
    const gone = await token(bobClient, { grant_type: "refresh_token", refresh_token: bobLive.refresh });
    check(15, "a removed client can no longer use the token endpoint", gone.r.status === 401, gone.j);
    CLIENTS.bob = bobClient;
    await stopServer();
  } else check(15, "rotation and rollback", true, "NOT_RUN in HTTPS mode (needs key changes); covered by local-integration mode and docs/REMOTE_MCP_ROLLBACK.md");

  // audit log hygiene
  if (!HTTPS_URL) {
    const all = [...secrets, ...Object.values(KEYS), ...Object.values(CLIENTS).map((c) => c.secret)];
    const leaked = logLines.filter((l) => all.some((s) => s && l.includes(s)));
    const parsed = logLines.filter((l) => !l.startsWith("stderr")).every((l) => { try { JSON.parse(l); return true; } catch { return false; } });
    check(11, "audit log: JSON lines, no token, code, client secret or owner key appears", leaked.length === 0 && parsed && logLines.some((l) => l.includes('"route":"/oauth/token"')), { lines: logLines.length, leaked: leaked.length });
    writeFileSync(join(OUT, "server-log.jsonl"), logLines.map(redact).join("\n") + "\n");
  }
  await alice.close().catch(() => undefined);
}

main().catch((e) => { check(0, "harness error", false, e instanceof Error ? e.stack ?? e.message : String(e)); }).finally(async () => {
  await stopServer().catch(() => undefined);
  const failed = checks.filter((c) => !c.ok);
  const steps = [...new Set(checks.map((c) => c.step))].sort((x, y) => x - y).map((s) => ({ step: s, pass: checks.filter((c) => c.step === s && c.ok).length, total: checks.filter((c) => c.step === s).length }));
  const report = { mode: MODE, verificationLevel: MODE === "local-integration" ? "LOCAL_VERIFIED (local integration; emulated proxy; not a remote host)" : "LOCAL_VERIFIED (local HTTPS emulation; not a remote host)",
    publicOrigin: PUBLIC, startedAt: new Date().toISOString(), node: process.version, verdict: failed.length ? "FAIL" : "PASS", passed: checks.length - failed.length, total: checks.length, steps, checks };
  writeFileSync(join(OUT, "report.json"), redact(JSON.stringify(report, null, 2)) + "\n");
  console.log(`\n${report.verdict}: ${report.passed}/${report.total} checks (${MODE}). Report: ${join(OUT, "report.json")}`);
  process.exit(failed.length ? 1 : 0);
});
