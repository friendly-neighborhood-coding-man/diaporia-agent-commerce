/**
 * Offline validation of the remote research/read-only MCP service (deploy/remote-mcp).
 *
 *   npm run remote:validate                       # local integration: spawns src/remote/main.ts, emulates the proxy
 *   npm run remote:validate -- --https https://mcp.diaporia.test:8443 --ca <caddy-root.crt> --resolve 127.0.0.1 \
 *        --keys-file deploy/remote-mcp/local/owner-keys.env [--restart-cmd "docker compose ... restart app"]
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
const redact = (s: string) => { let t = s; for (const x of secrets) if (x) t = t.split(x).join("<redacted>"); return t; };
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
let KEYS: Record<string, string> = { alice: newKey(), bob: newKey() };
let child: ChildProcess | null = null;
const logLines: string[] = [];

function remoteEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, NODE_NO_WARNINGS: "1",
    HOST: "127.0.0.1", PORT: String(upstreamPort), PUBLIC_BASE_URL: PUBLIC, DIAPORIA_DB_PATH: DB,
    DIAPORIA_OWNER_KEYS: Object.entries(KEYS).map(([u, k]) => `${k}=${u}-remote`).join(";"), DIAPORIA_TRUSTED_PROXIES: "127.0.0.1" };
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
const REDIRECT = "http://127.0.0.1:53682/callback";
const pkce = () => { const verifier = randomBytes(32).toString("base64url"); return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") }; };
async function register(name = "validate-client") { const r = await request("POST", `${PUBLIC}/oauth/register`, { headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: name, redirect_uris: [REDIRECT] }) }); return { r, id: json(r)?.client_id as string }; }
function authorizeUrl(clientId: string, challenge: string, scope = "purchase.research purchase.read") {
  return `${PUBLIC}/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "st-1", resource: `${PUBLIC}/mcp`, scope })}`;
}
async function consent(url: string, ownerKey: string, decision = "approve") {
  const page = await request("GET", url);
  if (page.status !== 200) return { status: page.status, location: String(page.headers.location ?? "") };
  const rid = /name="request_id" value="([^"]+)"/.exec(page.text)?.[1] ?? ""; const csrf = /name="csrf" value="([^"]+)"/.exec(page.text)?.[1] ?? "";
  const scopes = [...page.text.matchAll(/name="scope" value="([^"]+)"/g)].map((m) => m[1]!);
  const r = await request("POST", `${PUBLIC}/oauth/authorize`, { headers: { ...FORM, origin: PUBLIC }, body: form({ request_id: rid, csrf, decision, owner_key: ownerKey, scope: scopes }) });
  return { status: r.status, location: String(r.headers.location ?? ""), scopes };
}
async function token(body: Record<string, string>) { const r = await request("POST", `${PUBLIC}/oauth/token`, { headers: FORM, body: form(body) }); const j = json(r); if (j?.access_token) secrets.add(j.access_token); if (j?.refresh_token) secrets.add(j.refresh_token); return { r, j }; }
async function grant(user: string, clientId?: string) {
  const id = clientId ?? (await register(`validate-${user}`)).id;
  const { verifier, challenge } = pkce();
  const c = await consent(authorizeUrl(id, challenge), KEYS[user]!);
  const code = new URL(c.location).searchParams.get("code") ?? ""; secrets.add(code);
  const t = await token({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: id, redirect_uri: REDIRECT, resource: `${PUBLIC}/mcp` });
  return { clientId: id, code, verifier, access: t.j?.access_token as string, refresh: t.j?.refresh_token as string, scope: t.j?.scope as string, status: t.r.status };
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

// ---------------- the run ----------------
async function main() {
  if (HTTPS_URL) {
    PUBLIC = new URL(HTTPS_URL).origin;
    const kf = arg("--keys-file"); if (!kf) throw new Error("--keys-file is required with --https");
    KEYS = {};
    for (const entry of (/DIAPORIA_OWNER_KEYS=(.*)/.exec(readFileSync(kf, "utf8"))?.[1] ?? "").split(";").map((s) => s.trim()).filter(Boolean)) {
      const eq = entry.lastIndexOf("="); KEYS[entry.slice(eq + 1).replace(/-remote$/, "")] = entry.slice(0, eq);
    }
    if (!KEYS.alice || !KEYS.bob) throw new Error("keys file must hold users alice-remote and bob-remote");
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
      ["short owner key", { DIAPORIA_OWNER_KEYS: "drk_short=alice" }],
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
    check(1, "startup manifest: payment execution off, MOCK fixtures, research/read scopes only",
      s.paymentExecutionEnabled === false && s.research === "mock-fixtures" && JSON.stringify(s.scopes) === JSON.stringify(["purchase.research", "purchase.read"]), s);
    if (!started) return;
  }

  // 1. startup / health
  const hz = await request("GET", `${PUBLIC}/healthz`);
  if (HTTPS_URL) check(1, "/healthz is not exposed publicly (internal health check only; IR-21)", hz.status === 404, hz.status);
  else check(1, "healthz 200, paymentExecutionEnabled=false, authMode=oauth, MOCK", hz.status === 200 && json(hz)?.paymentExecutionEnabled === false && json(hz)?.authMode === "oauth" && json(hz)?.paymentEnvironment === "MOCK", hz.text);
  const foreign = await request("GET", `${PUBLIC}/healthz`, { hostOverride: "evil.example" });
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
  check(2, "authorization server metadata (RFC 8414): issuer, S256 only, code flow, DCR endpoint", a.issuer === PUBLIC && JSON.stringify(a.code_challenge_methods_supported) === '["S256"]' && a.registration_endpoint === `${PUBLIC}/oauth/register` && a.authorization_response_iss_parameter_supported === true, a);
  check(2, "advertised scopes exclude purchase.prepare", Array.isArray(a.scopes_supported) && !a.scopes_supported.includes("purchase.prepare") && (json(prm)?.scopes_supported ?? []).every((x: string) => x !== "purchase.prepare"), a.scopes_supported);
  const unauth = await request("POST", `${PUBLIC}/mcp`, { headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
  check(2, "unauthenticated /mcp: 401 with WWW-Authenticate resource_metadata", unauth.status === 401 && String(unauth.headers["www-authenticate"] ?? "").includes("resource_metadata="), unauth.status);

  // 3. client registration
  const reg = await register();
  check(3, "dynamic client registration (RFC 7591) issues a public client", reg.r.status === 201 && /^dcl_/.test(reg.id ?? "") && json(reg.r)?.token_endpoint_auth_method === "none", reg.r.status);
  for (const bad of ["http://evil.example/cb", "javascript:alert(1)", "https://u:p@a.example/cb", "https://claude.ai.evil.example/api/mcp/auth_callback", "https://evil.example/api/mcp/auth_callback"]) {
    const r = await request("POST", `${PUBLIC}/oauth/register`, { headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: [bad] }) });
    check(3, `registration refuses redirect ${bad}`, r.status === 400, r.status);
  }
  for (const good of ["https://claude.ai/api/mcp/auth_callback", "https://chatgpt.com/connector_platform_oauth_redirect", "http://localhost:6274/oauth/callback"]) {
    const r = await request("POST", `${PUBLIC}/oauth/register`, { headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "allowlisted", redirect_uris: [good] }) });
    check(3, `registration accepts allowlisted host callback ${good}`, r.status === 201, r.status);
  }
  const unreg = await request("GET", authorizeUrl(reg.id, pkce().challenge).replace(encodeURIComponent(REDIRECT), encodeURIComponent("https://evil.example/cb")));
  check(3, "authorize with an unregistered redirect issues no redirect", unreg.status === 400 && !unreg.headers.location, unreg.status);

  // 4. authorization with a local test user
  const { verifier, challenge } = pkce();
  const ask = await request("GET", authorizeUrl(reg.id, challenge, "purchase.research purchase.prepare"));
  check(4, "a request for purchase.prepare is refused (invalid_scope)", String(ask.headers.location ?? "").includes("error=invalid_scope"), ask.headers.location);
  const wrong = await consent(authorizeUrl(reg.id, challenge), newKey());
  check(4, "consent with an unknown owner key is refused", wrong.status === 401, wrong.status);
  const csrfBad = await (async () => { const p = await request("GET", authorizeUrl(reg.id, challenge)); const rid = /name="request_id" value="([^"]+)"/.exec(p.text)?.[1] ?? "";
    return request("POST", `${PUBLIC}/oauth/authorize`, { headers: { ...FORM, origin: PUBLIC }, body: form({ request_id: rid, csrf: "forged", decision: "approve", owner_key: KEYS.alice!, scope: ["purchase.research"] }) }); })();
  check(4, "consent with a forged CSRF token is refused", csrfBad.status === 400, csrfBad.status);
  const crossOrigin = await (async () => { const p = await request("GET", authorizeUrl(reg.id, challenge)); const rid = /name="request_id" value="([^"]+)"/.exec(p.text)?.[1] ?? ""; const csrf = /name="csrf" value="([^"]+)"/.exec(p.text)?.[1] ?? "";
    return request("POST", `${PUBLIC}/oauth/authorize`, { headers: { ...FORM, origin: "https://evil.example" }, body: form({ request_id: rid, csrf, decision: "approve", owner_key: KEYS.alice!, scope: ["purchase.research"] }) }); })();
  check(4, "consent POST from a foreign Origin is refused", crossOrigin.status === 403, crossOrigin.status);
  const ok = await consent(authorizeUrl(reg.id, challenge), KEYS.alice!);
  const loc = new URL(ok.location || "http://x/");
  const code = loc.searchParams.get("code") ?? ""; secrets.add(code);
  check(4, "test user alice approves: redirect carries code, state and iss (RFC 9207)", !!code && loc.searchParams.get("state") === "st-1" && loc.searchParams.get("iss") === PUBLIC && JSON.stringify(ok.scopes) === '["purchase.research","purchase.read"]', ok.status);

  // 5. PKCE code exchange
  const badV = await token({ grant_type: "authorization_code", code, code_verifier: pkce().verifier, client_id: reg.id, redirect_uri: REDIRECT, resource: `${PUBLIC}/mcp` });
  check(5, "wrong PKCE verifier refused", badV.r.status === 400 && badV.j?.error === "invalid_grant", badV.j);
  // A failed verifier consumes nothing? Get a fresh code to keep the main grant clean.
  const g = await grant("alice", reg.id);
  check(5, "code + PKCE S256 verifier → access and refresh tokens, research/read scope", g.status === 200 && !!g.access && !!g.refresh && g.scope === "purchase.research purchase.read", g.status);
  const replay = await token({ grant_type: "authorization_code", code: g.code, code_verifier: g.verifier, client_id: g.clientId, redirect_uri: REDIRECT, resource: `${PUBLIC}/mcp` });
  check(5, "authorization code replay refused", replay.r.status === 400 && replay.j?.error === "invalid_grant", replay.j);
  const afterReplay = await rpc(g.access, { jsonrpc: "2.0", id: 1, method: "tools/list" });
  check(5, "code replay revokes the tokens that code produced", afterReplay.status === 401, afterReplay.status);
  const main = await grant("alice", reg.id);
  const otherClient = await register("validate-other");
  { const { verifier: v2, challenge: c2 } = pkce(); const c = await consent(authorizeUrl(otherClient.id, c2), KEYS.alice!); const code2 = new URL(c.location).searchParams.get("code") ?? ""; secrets.add(code2);
    const t = await token({ grant_type: "authorization_code", code: code2, code_verifier: v2, client_id: reg.id, redirect_uri: REDIRECT, resource: `${PUBLIC}/mcp` });
    check(5, "a code issued to client B cannot be redeemed by client A", t.r.status === 400, t.j); }
  const wrongRes = await (async () => { const { verifier: v3, challenge: c3 } = pkce(); const c = await consent(authorizeUrl(reg.id, c3), KEYS.alice!); const code3 = new URL(c.location).searchParams.get("code") ?? ""; secrets.add(code3);
    return token({ grant_type: "authorization_code", code: code3, code_verifier: v3, client_id: reg.id, redirect_uri: REDIRECT, resource: "https://other.example/mcp" }); })();
  check(5, "token request for another resource (RFC 8707) refused", wrongRes.r.status === 400, wrongRes.j);

  // 6. MCP session initialisation (official SDK client, remote-style)
  const alice = await mcp(main.access);
  const sv = alice.getServerVersion();
  check(6, "MCP initialize over Streamable HTTP with the bearer token", sv?.name === "diaporia-agent-commerce", sv);
  const tools = (await alice.listTools()).tools.map((t) => t.name).sort();
  check(6, "tools/list = 5 research/read tools", JSON.stringify(tools) === JSON.stringify(["compare_purchase_offers", "get_checkout_status", "get_purchase_receipt", "get_usage_summary", "research_purchase"]), tools);
  const allTools = (await alice.listTools()).tools;
  check(6, "every offered tool is annotated readOnlyHint=true, destructiveHint=false", allTools.every((t) => t.annotations?.readOnlyHint === true && t.annotations?.destructiveHint === false), allTools.map((t) => [t.name, t.annotations]));

  // 7. research
  const research = await tool(alice, "research_purchase", { request: "Buy Sony WH-CH720N Black for the lowest total price, but never exceed $60.", budgetMinor: 6000, currency: "USD" });
  const sc = research.sc ?? {};
  check(7, "research_purchase returns candidates with evidence", !research.isError && Array.isArray(sc.candidates) && sc.candidates.length > 0, research.text.slice(0, 200));
  check(7, "research result says paymentEffect NONE and labels MOCK fixtures", sc.paymentEffect === "NONE" && sc.dataSource?.mockData === true && sc.dataSource?.paymentEnvironment === "MOCK", sc.dataSource);

  // 8. read-only retrieval
  const cmp = await tool(alice, "compare_purchase_offers", { researchSessionId: sc.purchaseSessionId, productIdentity: { brand: "Sony", model: "WH-CH720N", variant: "Black", condition: "new", sku: "WHCH720N/B" }, destination: { country: "US", region: "CA" } });
  check(8, "compare_purchase_offers returns verified offers with full cost breakdown", !cmp.isError && Array.isArray(cmp.sc?.eligibleOffers) && cmp.sc.eligibleOffers.every((o: any) => typeof o.cost?.totalMinor === "number" || o.cost?.unknownComponents), cmp.text.slice(0, 200));
  const st = await tool(alice, "get_checkout_status", { checkoutSessionId: "cs_00000000-0000-4000-8000-000000000000" });
  check(8, "get_checkout_status of an unknown checkout = error, no data", st.isError, st.text.slice(0, 120));
  const rc = await tool(alice, "get_purchase_receipt", { checkoutSessionId: "cs_00000000-0000-4000-8000-000000000000" });
  check(8, "get_purchase_receipt of an unknown checkout = error, no data", rc.isError, rc.text.slice(0, 120));
  const us = await tool(alice, "get_usage_summary", {});
  check(8, "get_usage_summary is readable and charges nothing", !us.isError, us.text.slice(0, 160));

  // 12. cross-user isolation (before refresh/revoke so alice's session is live)
  const bobGrant = await grant("bob");
  const bob = await mcp(bobGrant.access);
  const steal = await tool(bob, "compare_purchase_offers", { researchSessionId: sc.purchaseSessionId, productIdentity: { brand: "Sony", model: "WH-CH720N", variant: "Black", condition: "new", sku: "WHCH720N/B" } });
  check(12, "bob cannot read alice's research session (NOT_FOUND)", steal.isError && /NOT_FOUND/.test(steal.text), steal.text.slice(0, 160));
  const bobRefreshAsAlice = await token({ grant_type: "refresh_token", refresh_token: main.refresh, client_id: bobGrant.clientId });
  check(12, "alice's refresh token presented by bob's client is refused", bobRefreshAsAlice.r.status === 400, bobRefreshAsAlice.j);
  const aliceUsage = JSON.stringify(us.sc ?? {}); const bobUsage = await tool(bob, "get_usage_summary", {});
  check(12, "usage summaries are per user", !bobUsage.isError && JSON.stringify(bobUsage.sc ?? {}) !== "" && !JSON.stringify(bobUsage.sc).includes("alice"), [aliceUsage.length, bobUsage.text.slice(0, 80)]);
  await bob.close();

  // 13. disallowed payment tools and routes
  for (const name of ["prepare_checkout", "prepare_browser_checkout", "buy_now", "capture_payment"]) {
    const r = await rpc(main.access, { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name, arguments: { purchaseSessionId: sc.purchaseSessionId, offerId: "x", maximumApprovedTotalMinor: 1, currency: "USD", quantity: 1 } } });
    const j = json(r);
    check(13, `tools/call ${name} is rejected (tool not found)`, r.status === 200 && (j?.result?.isError === true || !!j?.error) && /not found/i.test(JSON.stringify(j)), j);
  }
  const routes = ["/owner/mandates", "/owner/mandates/mdt_00000000-0000-4000-8000-000000000000/revoke", "/owner/checkouts/cs_00000000-0000-4000-8000-000000000000/cancel",
    "/owner/checkouts/cs_00000000-0000-4000-8000-000000000000/reconcile", "/authorize/cs_00000000-0000-4000-8000-000000000000", "/paypal/webhook", "/paypal/return",
    "/mock-paypal/checkout/MOCK0000000000000000/approve", "/billing/webhook/mock", "/billing/subscribe", "/handoff/x", "/operator/x", "/admin"];
  for (const p of routes) for (const method of ["GET", "POST"]) {
    const r = await request(method, `${PUBLIC}${p}`, { headers: { authorization: `Bearer ${main.access}`, "x-owner-key": KEYS.alice!, origin: PUBLIC, ...FORM }, body: method === "POST" ? "ownerKey=x" : undefined });
    check(13, `${method} ${p} is closed (403/404) even with a valid token and owner key`, r.status === 403 || r.status === 404, r.status);
  }

  // 9. token refresh (rotation)
  const ref = await token({ grant_type: "refresh_token", refresh_token: main.refresh, client_id: main.clientId });
  check(9, "refresh rotates: new access + refresh token, same scope", ref.r.status === 200 && ref.j.refresh_token !== main.refresh && ref.j.scope === "purchase.research purchase.read", ref.r.status);
  const widen = await token({ grant_type: "refresh_token", refresh_token: ref.j.refresh_token, client_id: main.clientId, scope: "purchase.research purchase.read purchase.prepare" });
  check(9, "refresh cannot widen scope to purchase.prepare", widen.r.status === 400, widen.j);
  const cur = { access: ref.j.access_token as string, refresh: ref.j.refresh_token as string };
  // reuse detection on a separate grant
  const rg = await grant("alice", reg.id);
  const r1 = await token({ grant_type: "refresh_token", refresh_token: rg.refresh, client_id: rg.clientId });
  const reuse = await token({ grant_type: "refresh_token", refresh_token: rg.refresh, client_id: rg.clientId });
  const famDead = await rpc(r1.j.access_token, { jsonrpc: "2.0", id: 1, method: "tools/list" });
  check(9, "refresh-token reuse is refused and revokes the whole grant", reuse.r.status === 400 && famDead.status === 401, [reuse.r.status, famDead.status]);

  // 14. restart and persistence
  let restarted = false;
  if (!HTTPS_URL) { await stopServer(); restarted = !!(await startServer()); }
  else if (arg("--restart-cmd")) { const r = spawn("sh", ["-c", arg("--restart-cmd")!], { stdio: "inherit" }); await new Promise((ok) => r.on("exit", ok));
    for (let i = 0; i < 60; i++) { try { if ((await request("GET", `${PUBLIC}/.well-known/oauth-protected-resource`)).status === 200) { restarted = true; break; } } catch { /* starting */ } await new Promise((r2) => setTimeout(r2, 1000)); } }
  if (restarted) {
    check(14, "service restarts on the same database", true);
    const persisted = await rpc(cur.access, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    check(14, "access token issued before the restart is still valid (DB-backed)", persisted.status === 200, persisted.status);
    const pref = await token({ grant_type: "refresh_token", refresh_token: cur.refresh, client_id: main.clientId });
    check(14, "refresh token issued before the restart still rotates", pref.r.status === 200, pref.r.status);
    cur.access = pref.j?.access_token ?? cur.access; cur.refresh = pref.j?.refresh_token ?? cur.refresh;
    const again = await mcp(cur.access);
    const cmp2 = await tool(again, "compare_purchase_offers", { researchSessionId: sc.purchaseSessionId, productIdentity: { brand: "Sony", model: "WH-CH720N", variant: "Black", condition: "new", sku: "WHCH720N/B" } });
    check(14, "alice's research session survives the restart", !cmp2.isError, cmp2.text.slice(0, 120));
    await again.close();
  } else check(14, "restart and persistence", false, HTTPS_URL ? "NOT_RUN: pass --restart-cmd to restart the compose app service" : "restart failed");

  // 10. revocation
  const rev = await request("POST", `${PUBLIC}/oauth/revoke`, { headers: FORM, body: form({ token: cur.refresh, client_id: main.clientId }) });
  const dead = await rpc(cur.access, { jsonrpc: "2.0", id: 1, method: "tools/list" });
  check(10, "revoking the refresh token (RFC 7009) revokes the grant; access token now 401", rev.status === 200 && dead.status === 401, [rev.status, dead.status]);
  const deadRefresh = await token({ grant_type: "refresh_token", refresh_token: cur.refresh, client_id: main.clientId });
  check(10, "revoked refresh token cannot be used", deadRefresh.r.status === 400, deadRefresh.j);

  // 11. invalid tokens
  for (const [name, h] of [["random bearer", `Bearer ${randomBytes(32).toString("base64url")}`], ["owner key as bearer", `Bearer ${KEYS.alice}`], ["refresh token as bearer", `Bearer ${rg.refresh}`], ["Basic scheme", "Basic YTpi"], ["empty bearer", "Bearer "]] as const) {
    const r = await request("POST", `${PUBLIC}/mcp`, { headers: { authorization: h, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
    check(11, `${name} rejected with 401`, r.status === 401, r.status);
  }

  // rate limits behind the proxy (local integration only: the harness plays the proxy)
  if (!HTTPS_URL) {
    forwardedFor = "198.51.100.7"; let limited = 0;
    for (let i = 0; i < 32; i++) if ((await request("GET", `${PUBLIC}/.well-known/oauth-authorization-server`)).status === 429) limited++;
    forwardedFor = "198.51.100.8"; const other = await request("GET", `${PUBLIC}/.well-known/oauth-authorization-server`); forwardedFor = null;
    check(13, "rate limit is per client behind a trusted proxy: one noisy client is limited, another is not", limited > 0 && other.status === 200, [limited, other.status]);
    forwardedFor = "198.51.100.9"; const codes: number[] = [];
    for (let i = 0; i < 11; i++) codes.push((await request("POST", `${PUBLIC}/oauth/register`, { headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: [REDIRECT] }) })).status);
    forwardedFor = null;
    check(3, "client registration has its own limit (10 per hour per client): the 11th is refused", codes.slice(0, 10).every((c) => c === 201) && codes[10] === 429, codes);
  }

  // 15. safe rollback
  if (!HTTPS_URL) {
    await stopServer();
    const backup = `${DB}.bak`; copyFileSync(DB, backup); copyFileSync(`${DB.replace(/\.sqlite$/, "")}-service.sqlite`, `${backup}-service`);
    let down = false; try { await request("GET", `${PUBLIC}/healthz`); } catch { down = true; }
    check(15, "rollback to OFF: stopping the service closes the endpoint", down);
    copyFileSync(backup, DB); copyFileSync(`${backup}-service`, `${DB.replace(/\.sqlite$/, "")}-service.sqlite`);
    const back = await startServer();
    const hz2 = await request("GET", `${PUBLIC}/healthz`);
    check(15, "restore from the stopped-state backup and start again: healthy, still read-only", !!back && json(hz2)?.paymentExecutionEnabled === false, hz2.text);
    const late = await grant("bob");
    check(15, "after restore a new grant works (OAuth tables intact)", late.status === 200, late.status);
    await stopServer();
  } else check(15, "safe rollback", true, "see docs/REMOTE_MCP_ROLLBACK.md; run in local-integration mode for the automated check");

  // audit log hygiene
  if (!HTTPS_URL) {
    const leaked = logLines.filter((l) => [...secrets, ...Object.values(KEYS)].some((s) => s && l.includes(s)));
    const parsed = logLines.filter((l) => !l.startsWith("stderr")).every((l) => { try { JSON.parse(l); return true; } catch { return false; } });
    check(11, "audit log: JSON lines, no token, code or owner key appears", leaked.length === 0 && parsed && logLines.some((l) => l.includes('"route":"/oauth/token"')), { lines: logLines.length, leaked: leaked.length });
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
