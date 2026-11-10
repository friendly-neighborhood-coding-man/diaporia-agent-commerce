import { afterEach, describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Socket } from "node:net";
import type { IncomingMessage } from "node:http";
import { loadRemoteReadonlyConfig, RemoteConfigError, DEFAULT_REDIRECT_ALLOWLIST } from "../src/remote/readonlyConfig.js";
import { createRemoteReadonlyApp, remoteStartupHousekeeping } from "../src/remote/app.js";
import { routeLabel } from "../src/remote/auditLog.js";
import { clientIp, type App } from "../src/http/server.js";
import { OAuthAuthority, redirectAllowed } from "../src/auth/oauth.js";
import { DevAuth, SCOPES } from "../src/auth/devAuth.js";
import { Store } from "../src/store/Database.js";

const key = () => `drk_${randomBytes(32).toString("base64url")}`;
const dir = () => mkdtempSync(join(tmpdir(), "remote-ro-"));
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const CLIENT_A = { id: `dcl_${"a".repeat(32)}`, secret: `dcs_${randomBytes(24).toString("base64url")}` };
const CLIENT_B = { id: `dcl_${"b".repeat(32)}`, secret: `dcs_${randomBytes(24).toString("base64url")}` };
const clientsEnv = () => [
  `${CLIENT_A.id}|${sha(CLIENT_A.secret)}|alice-remote|https://claude.ai/api/mcp/auth_callback|Claude (alice)`,
  `${CLIENT_B.id}|${sha(CLIENT_B.secret)}|bob-remote|http://127.0.0.1/callback|Claude Code (bob)`,
].join(";");
const good = (extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { PUBLIC_BASE_URL: "https://mcp.diaporia.test", DIAPORIA_OWNER_KEYS: `${key()}=alice-remote;${key()}=bob-remote`, DIAPORIA_DB_PATH: join(dir(), "r.sqlite"), PORT: "18999", DIAPORIA_OAUTH_CLIENTS: clientsEnv() };
  for (const [k, v] of Object.entries(extra)) { if (v === undefined) delete env[k]; else env[k] = v; }
  return env;
};
const problems = (env: NodeJS.ProcessEnv) => { try { loadRemoteReadonlyConfig(env); return []; } catch (e) { return e instanceof RemoteConfigError ? e.problems : ["THREW " + String(e)]; } };

describe("remote read-only startup configuration check", () => {
  it("accepts a minimal valid configuration with safe defaults", () => {
    const c = loadRemoteReadonlyConfig(good());
    expect(c.baseUrl).toBe("https://mcp.diaporia.test");
    expect(c.ownerKeys.map((o) => o.userId)).toEqual(["alice-remote", "bob-remote"]);
    expect(c.allowedRedirectUris).toEqual(DEFAULT_REDIRECT_ALLOWLIST);
    expect(c.accessTokenTtlSec).toBe(3600); expect(c.grantMaxAgeSec).toBe(86400); expect(c.registerPerHour).toBe(10);
  });

  it.each([
    ["http base URL", { PUBLIC_BASE_URL: "http://mcp.diaporia.test" }, /https/],
    ["loopback base URL", { PUBLIC_BASE_URL: "https://127.0.0.1" }, /loopback/],
    ["localhost base URL", { PUBLIC_BASE_URL: "https://localhost:8443" }, /loopback/],
    ["wildcard base URL", { PUBLIC_BASE_URL: "https://0.0.0.0" }, /loopback/],
    ["IP literal base URL", { PUBLIC_BASE_URL: "https://203.0.113.5" }, /IP literal/],
    ["base URL with path", { PUBLIC_BASE_URL: "https://mcp.diaporia.test/mcp" }, /origin only/],
    ["no base URL", { PUBLIC_BASE_URL: undefined }, /required/],
    ["no owner keys", { DIAPORIA_OWNER_KEYS: undefined }, /no generated or file-based fallback/],
    ["local dok_ owner key", { DIAPORIA_OWNER_KEYS: `dok_${"a".repeat(40)}=alice` }, /must start with drk_/],
    ["short owner key", { DIAPORIA_OWNER_KEYS: `drk_${"abc"}=alice` }, /too short/],
    ["owner key with non-base64url characters", { DIAPORIA_OWNER_KEYS: `drk_${"!".repeat(43)}=alice` }, /exactly 43 base64url/],
    ["owner key longer than generated", { DIAPORIA_OWNER_KEYS: `drk_${"A".repeat(44)}=alice` }, /exactly 43 base64url/],
    ["duplicate user", { DIAPORIA_OWNER_KEYS: `${key()}=a;${key()}=a` }, /twice/],
    ["relative DB path", { DIAPORIA_DB_PATH: "data/r.sqlite" }, /absolute/],
    ["in-memory DB", { DIAPORIA_DB_PATH: ":memory:" }, /absolute/],
    ["dev auth mode", { DIAPORIA_AUTH_MODE: "dev" }, /oauth/],
    ["public demo auth mode", { DIAPORIA_AUTH_MODE: "public-readonly-demo" }, /oauth/],
    ["PayPal provider", { PAYMENT_PROVIDER: "paypal_sandbox" }, /PAYMENT_PROVIDER/],
    ["PayPal secret", { PAYPAL_CLIENT_SECRET: "x" }, /PAYPAL_CLIENT_SECRET is set/],
    ["handoff driver", { HANDOFF_DRIVER: "fixture" }, /HANDOFF_DRIVER is set/],
    ["KERNEL key", { KERNEL_API_KEY: "x" }, /KERNEL_API_KEY is set/],
    ["live KERNEL opt-in", { DIAPORIA_ENABLE_LIVE_KERNEL_INSPECTION: "1" }, /is set/],
    ["Tavily key", { TAVILY_API_KEY: "x" }, /TAVILY_API_KEY is set/],
    ["Channel3", { RESEARCH_PROVIDER: "channel3" }, /RESEARCH_PROVIDER is set/],
    ["dev tokens", { DIAPORIA_DEV_TOKENS: "t=u:purchase.prepare" }, /DIAPORIA_DEV_TOKENS is set/],
    ["managed mode", { DIAPORIA_DEPLOYMENT_MODE: "managed" }, /is set/],
    ["managed billing", { MANAGED_BILLING: "paypal" }, /MANAGED_BILLING is set/],
    ["merchant operator key", { MERCHANT_OPERATOR_KEY: "x" }, /MERCHANT_OPERATOR_KEY is set/],
    ["bad trusted proxy", { DIAPORIA_TRUSTED_PROXIES: "caddy" }, /not an IP/],
    ["access TTL too long", { DIAPORIA_ACCESS_TOKEN_TTL_SEC: "86400" }, /ACCESS_TOKEN_TTL/],
    ["http redirect allowlist entry", { DIAPORIA_ALLOWED_REDIRECT_URIS: "http://evil.example/cb" }, /ALLOWED_REDIRECT_URIS/],
    ["host-only wildcard allowlist", { DIAPORIA_ALLOWED_REDIRECT_URIS: "https://*" }, /ALLOWED_REDIRECT_URIS/],
  ])("refuses: %s", (_name, extra, re) => {
    const p = problems(good(extra as Record<string, string | undefined>));
    expect(p.length).toBeGreaterThan(0);
    expect(p.join("\n")).toMatch(re);
  });

  it("lists every problem at once", () => {
    expect(problems({ PUBLIC_BASE_URL: "http://localhost", PAYPAL_CLIENT_ID: "x", HANDOFF_DRIVER: "k" }).length).toBeGreaterThanOrEqual(5);
  });
});

describe("remote read-only app invariants", () => {
  let app: App | null = null;
  afterEach(() => { app?.server.close(); app = null; });

  it("never enables payment execution and offers research/read scopes only", () => {
    app = createRemoteReadonlyApp(loadRemoteReadonlyConfig(good()));
    expect(app.paymentExecutionEnabled).toBe(false);
    expect(app.handoff).toBeNull();
    expect([...app.oauth!.offered].sort()).toEqual([SCOPES.READ, SCOPES.RESEARCH].sort());
    expect(app.oauth!.authorizationServerMetadata().scopes_supported).not.toContain(SCOPES.PREPARE);
  });

  it("startup housekeeping revokes stale grants, grants of removed users, and everything on request", () => {
    const cfg = loadRemoteReadonlyConfig(good());
    app = createRemoteReadonlyApp(cfg);
    const fp = app.auth.ownerKeyFingerprint(cfg.ownerKeys[0]!.key)!;
    const ins = app.store.db.prepare("INSERT INTO oauth_tokens(token_hash,kind,family_id,client_id,user_id,scope,resource,expires_at,created_at,owner_fp) VALUES (?,?,?,?,?,?,?,?,?,?)");
    const row = (fam: string, client: string, user: string, ownerFp: string | null) => ins.run(randomBytes(8).toString("hex"), "refresh", fam, client, user, "purchase.read", "r", Date.now() + 1e6, Date.now(), ownerFp);
    row("live", CLIENT_A.id, "alice-remote", fp);        // valid: kept
    row("nofp", CLIENT_A.id, "alice-remote", null);      // no recorded key: stale
    row("oldkey", CLIENT_A.id, "alice-remote", "0".repeat(64)); // rotated-away key: stale
    row("dcr", "dcl_x", "alice-remote", fp);            // not pre-registered: stale
    row("gone", CLIENT_A.id, "gone-user", fp);          // user removed
    const h = remoteStartupHousekeeping(app, cfg);
    expect(h.stale).toBe(3); expect(h.removedUsers).toBe(1); expect(h.all).toBe(0);
    expect(remoteStartupHousekeeping(app, { ...cfg, revokeAllGrantsOnStart: true }).all).toBe(1);
  });

  it("advertises no registration endpoint and refuses dynamic registration", () => {
    app = createRemoteReadonlyApp(loadRemoteReadonlyConfig(good()));
    const md = app.oauth!.authorizationServerMetadata();
    expect(md.registration_endpoint).toBeUndefined();
    expect(md.token_endpoint_auth_methods_supported).not.toContain("none");
    expect(app.oauth!.register({ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], client_name: "Claude" }).status).toBe(403);
  });
});

describe("proxy-aware client address and audit log labels", () => {
  const req = (peer: string, xff?: string) => { const s = new Socket(); Object.defineProperty(s, "remoteAddress", { value: peer }); return { socket: s, headers: xff ? { "x-forwarded-for": xff } : {} } as unknown as IncomingMessage; };
  it("ignores X-Forwarded-For from untrusted peers and takes the proxy-appended hop from trusted ones", () => {
    const trusted = new Set(["172.31.250.10"]);
    expect(clientIp(req("198.51.100.1", "1.2.3.4"), trusted)).toBe("198.51.100.1");
    expect(clientIp(req("172.31.250.10", "6.6.6.6, 198.51.100.2"), trusted)).toBe("198.51.100.2");
    expect(clientIp(req("::ffff:172.31.250.10", "198.51.100.3"), trusted)).toBe("198.51.100.3");
    expect(clientIp(req("172.31.250.10"), trusted)).toBe("172.31.250.10");
  });
  it("maps paths to fixed labels so ids and query strings never reach the log", () => {
    expect(routeLabel("/oauth/token")).toBe("/oauth/token");
    expect(routeLabel("/.well-known/oauth-protected-resource/mcp")).toBe("/.well-known/oauth-protected-resource");
    expect(routeLabel("/owner/checkouts/cs_1/cancel")).toBe("other");
    expect(routeLabel("/dat_secret")).toBe("other");
  });
});

describe("OAuth hardening options (opt-in; local defaults unchanged)", () => {
  it("redirect allowlist: exact, prefix and loopback entries", () => {
    const allow = DEFAULT_REDIRECT_ALLOWLIST;
    expect(redirectAllowed(allow, "https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(redirectAllowed(allow, "https://chatgpt.com/connector/oauth/abc123")).toBe(true);
    expect(redirectAllowed(allow, "http://127.0.0.1:5555/cb")).toBe(true);
    expect(redirectAllowed(allow, "http://localhost/cb")).toBe(true);
    expect(redirectAllowed(allow, "https://claude.ai/api/mcp/auth_callback/x")).toBe(false);
    expect(redirectAllowed(allow, "https://claude.ai.evil.example/api/mcp/auth_callback")).toBe(false);
    expect(redirectAllowed(allow, "https://127.0.0.1/cb")).toBe(false);
  });

  const authority = (cfg: Partial<ConstructorParameters<typeof OAuthAuthority>[2]>, now: () => number) => {
    const owners = new DevAuth(); const ownerKey = key(); owners.addOwnerKey(ownerKey, "alice");
    const a = new OAuthAuthority(new Store(":memory:"), owners, { issuer: "https://mcp.t", resource: "https://mcp.t/mcp", offeredScopes: [SCOPES.RESEARCH, SCOPES.READ], ...cfg }, now);
    return { a, ownerKey };
  };
  const pkce = () => { const v = randomBytes(32).toString("base64url"); return { v, c: createHash("sha256").update(v).digest("base64url") }; };
  function fullGrant(a: OAuthAuthority, ownerKey: string) {
    const reg = a.register({ redirect_uris: ["http://127.0.0.1:9/cb"] }); const id = String(reg.body.client_id);
    const { v, c } = pkce();
    const b = a.beginAuthorization(new URLSearchParams({ response_type: "code", client_id: id, redirect_uri: "http://127.0.0.1:9/cb", code_challenge: c, code_challenge_method: "S256" }));
    if (!b.ok) throw new Error("begin failed");
    const done = a.completeAuthorization(new URLSearchParams({ request_id: b.pending.id, csrf: b.pending.csrf, decision: "approve", owner_key: ownerKey, scope: "purchase.read" }));
    const code = new URL((done as { redirect: string }).redirect).searchParams.get("code")!;
    const t = a.token(new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: v, client_id: id, redirect_uri: "http://127.0.0.1:9/cb" }));
    return { id, refresh: String(t.body.refresh_token) };
  }

  it("registration outside the allowlist is refused", () => {
    const { a } = authority({ allowedRedirectUris: ["https://claude.ai/api/mcp/auth_callback"] }, Date.now);
    expect(a.register({ redirect_uris: ["https://evil.example/cb"] }).status).toBe(400);
    expect(a.register({ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] }).status).toBe(201);
  });

  it("refresh rotation never extends a grant past grantMaxAgeSec", () => {
    let t = Date.now(); const { a, ownerKey } = authority({ grantMaxAgeSec: 3600, refreshTokenTtlSec: 86400 }, () => t);
    const g = fullGrant(a, ownerKey);
    t += 1800_000;
    const r1 = a.token(new URLSearchParams({ grant_type: "refresh_token", refresh_token: g.refresh, client_id: g.id }));
    expect(r1.status).toBe(200);
    t += 1801_000;
    const r2 = a.token(new URLSearchParams({ grant_type: "refresh_token", refresh_token: String(r1.body.refresh_token), client_id: g.id }));
    expect(r2.status).toBe(400); expect(r2.body.error_description).toMatch(/maximum age/);
  });

  it("pending consent requests are evicted oldest first, never all at once", () => {
    const { a } = authority({ maxPending: 3 }, Date.now);
    const id = String(a.register({ redirect_uris: ["http://127.0.0.1:9/cb"] }).body.client_id);
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) { const b = a.beginAuthorization(new URLSearchParams({ response_type: "code", client_id: id, redirect_uri: "http://127.0.0.1:9/cb", code_challenge: pkce().c, code_challenge_method: "S256" })); if (b.ok) ids.push(b.pending.id); }
    // gc runs before each insert, so at most maxPending + 1 remain and the newest always survive.
    expect(a.getPending(ids[5])).not.toBeNull(); expect(a.getPending(ids[4])).not.toBeNull();
    expect(a.getPending(ids[0])).toBeNull();
  });

  describe("closed registration with operator-registered clients bound to one account", () => {
    const CB = "https://claude.ai/api/mcp/auth_callback";
    const setup = (now: () => number = Date.now) => {
      const owners = new DevAuth(); const aliceKey = key(); const bobKey = key();
      owners.addOwnerKey(aliceKey, "alice"); owners.addOwnerKey(bobKey, "bob");
      const store = new Store(":memory:");
      const cfg = { issuer: "https://mcp.t", resource: "https://mcp.t/mcp", offeredScopes: [SCOPES.RESEARCH, SCOPES.READ], registration: "closed" as const, bindGrantsToOwnerKey: true, allowedRedirectUris: [CB],
        preRegisteredClients: [{ clientId: CLIENT_A.id, secretSha256: sha(CLIENT_A.secret), userId: "alice", name: "Claude (alice)", redirectUris: [CB] }] };
      return { a: new OAuthAuthority(store, owners, cfg, now), owners, store, cfg, aliceKey, bobKey };
    };
    const begin = (a: OAuthAuthority, clientId = CLIENT_A.id) => { const { v, c } = pkce(); const b = a.beginAuthorization(new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: CB, code_challenge: c, code_challenge_method: "S256" })); return { b, v }; };
    const approve = (a: OAuthAuthority, id: string, csrf: string, ownerKey: string) => a.completeAuthorization(new URLSearchParams({ request_id: id, csrf, decision: "approve", owner_key: ownerKey, scope: "purchase.read" }));
    const exchange = (a: OAuthAuthority, code: string, v: string, secret: string | null = CLIENT_A.secret) => a.token(new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: v, client_id: CLIENT_A.id, redirect_uri: CB, ...(secret === null ? {} : { client_secret: secret }) }));
    const fullClosedGrant = (a: OAuthAuthority, ownerKey: string) => {
      const { b, v } = begin(a); if (!b.ok) throw new Error("begin failed");
      const done = approve(a, b.pending.id, b.pending.csrf, ownerKey) as { redirect: string };
      const code = new URL(done.redirect).searchParams.get("code")!;
      return exchange(a, code, v);
    };

    it("refuses dynamic registration and unknown client ids", () => {
      const { a } = setup();
      expect(a.registrationOpen).toBe(false);
      expect(a.register({ redirect_uris: [CB], client_name: "Claude" }).status).toBe(403);
      expect(begin(a, `dcl_${"c".repeat(32)}`).b.ok).toBe(false);
    });

    it("a phishing party that knows only the client id and the shared callback cannot redeem the code", () => {
      const { a, aliceKey } = setup();
      const { b, v } = begin(a); if (!b.ok) throw new Error("begin failed");
      expect(b.pending.boundUserId).toBe("alice");
      const code = new URL((approve(a, b.pending.id, b.pending.csrf, aliceKey) as { redirect: string }).redirect).searchParams.get("code")!;
      expect(exchange(a, code, v, null).status).toBe(401);
      expect(exchange(a, code, v, `dcs_${randomBytes(24).toString("base64url")}`).status).toBe(401);
    });

    it("only the bound account can approve a pre-registered client", () => {
      const { a, bobKey } = setup();
      const { b } = begin(a); if (!b.ok) throw new Error("begin failed");
      const r = approve(a, b.pending.id, b.pending.csrf, bobKey) as { error: { status: number; body(): Record<string, unknown> } };
      expect(r.error.status).toBe(403); expect(r.error.body().error).toBe("access_denied");
    });

    it("grants die when the approving owner key is rotated, even across a restart and a restored backup", () => {
      const s = setup();
      const t = fullClosedGrant(s.a, s.aliceKey);
      expect(t.status).toBe(200);
      const access = `Bearer ${t.body.access_token}`;
      expect(s.a.verifyAccessToken(access)?.userId).toBe("alice");
      // Restart with a rotated key for alice: access and refresh tokens fail closed with no flag set.
      const rotated = new DevAuth(); rotated.addOwnerKey(key(), "alice"); rotated.addOwnerKey(s.bobKey, "bob");
      const restarted = new OAuthAuthority(s.store, rotated, s.cfg);
      expect(restarted.verifyAccessToken(access)).toBeNull();
      expect(restarted.token(new URLSearchParams({ grant_type: "refresh_token", refresh_token: String(t.body.refresh_token), client_id: CLIENT_A.id, client_secret: CLIENT_A.secret })).status).toBe(400);
      expect(restarted.revokeStaleGrants()).toBe(0); // the failed refresh already revoked the family
      // Roll back to the old key: the revocation is persistent, so the grant does not come back.
      const rolledBack = new OAuthAuthority(s.store, s.owners, s.cfg);
      expect(rolledBack.verifyAccessToken(access)).toBeNull();
    });

    it("startup revocation is persistent: a grant revoked under the new key stays dead after rolling back to the old key", () => {
      const s = setup();
      const t = fullClosedGrant(s.a, s.aliceKey); const access = `Bearer ${t.body.access_token}`;
      const rotated = new DevAuth(); rotated.addOwnerKey(key(), "alice");
      expect(new OAuthAuthority(s.store, rotated, s.cfg).revokeStaleGrants()).toBe(2); // access + refresh
      expect(new OAuthAuthority(s.store, s.owners, s.cfg).verifyAccessToken(access)).toBeNull();
    });

    it("grants issued to a client whose registration was removed stop working", () => {
      const s = setup();
      const t = fullClosedGrant(s.a, s.aliceKey); const access = `Bearer ${t.body.access_token}`;
      const without = new OAuthAuthority(s.store, s.owners, { ...s.cfg, preRegisteredClients: [] });
      expect(without.verifyAccessToken(access)).toBeNull();
      expect(without.revokeStaleGrants()).toBe(2);
    });
  });

  it("prune removes unused clients and dead grants but keeps live ones", () => {
    let t = Date.now(); const { a, ownerKey } = authority({}, () => t);
    a.register({ redirect_uris: ["http://127.0.0.1:9/cb"] }); // never used
    const g = fullGrant(a, ownerKey);
    t += 2 * 3600_000;
    const p = a.prune(3600);
    expect(p.clients).toBe(1);
    expect(a.token(new URLSearchParams({ grant_type: "refresh_token", refresh_token: g.refresh, client_id: g.id })).status).toBe(200);
  });
});
