import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Store, Row } from "../store/Database.js";
import { ALL_CLIENT_SCOPES, SCOPES, type DevAuth, type Principal } from "./devAuth.js";

/**
 * OAuth 2.1 authorization server + resource-server token check for the remote MCP endpoint.
 *
 * Implements what the MCP authorization spec (2025-06-18 / 2025-11-25) asks of a server:
 *  - RFC 9728 protected resource metadata, advertised in the 401 WWW-Authenticate header
 *  - RFC 8414 authorization server metadata
 *  - RFC 7591 dynamic client registration (public clients with PKCE, or confidential clients with a secret)
 *  - Authorization code grant with mandatory PKCE S256 (OAuth 2.1), exact redirect URI match
 *    (loopback redirects may use any port, RFC 8252 §7.3)
 *  - RFC 8707 resource indicators: tokens are audience-bound to this server's /mcp resource
 *  - Refresh token rotation with reuse detection (the whole grant family is revoked)
 *  - RFC 7009 revocation, RFC 9207 `iss` in the authorization response
 *
 * Tokens are opaque random strings; only SHA-256 hashes are stored. The human who consents
 * authenticates with their owner key (the same human-held secret that creates purchase
 * mandates). An OAuth token is an AI-client credential: like a dev token it can never create
 * spending authority. Production would swap the owner-key login for a real identity provider;
 * the token, client and consent model stay the same.
 */

export interface OAuthConfig {
  /** Issuer = externally visible origin, e.g. https://mcp.example.com */
  issuer: string;
  /** Canonical resource URI of the MCP endpoint, e.g. https://mcp.example.com/mcp */
  resource: string;
  accessTokenTtlSec?: number;
  refreshTokenTtlSec?: number;
  codeTtlSec?: number;
  maxClients?: number;
  /**
   * Scopes this deployment actually offers (advertised in metadata and the 401 challenge, and the
   * only ones a client may request). A public deployment without payment tools omits purchase.prepare.
   */
  offeredScopes?: string[];
  /**
   * Remote deployments: redirect URIs a dynamically registered client may use. Entries are exact URIs,
   * prefixes ending in "*", or the word "loopback" (http on 127.0.0.1/localhost/[::1], any port).
   * Absent = any valid redirect (local default).
   */
  allowedRedirectUris?: string[];
  /** Absolute lifetime of a grant (refresh family) in seconds; refresh rotation never extends it. Absent = unlimited. */
  grantMaxAgeSec?: number;
  /** Maximum pending consent requests kept in memory; the oldest are evicted first. Default 5000. */
  maxPending?: number;
  /**
   * "dynamic" (default): RFC 7591 registration is open. "closed": only `preRegisteredClients` exist;
   * /oauth/register is refused and not advertised, and every other client id is unknown.
   */
  registration?: "dynamic" | "closed";
  /** Operator-registered confidential clients, each bound to one user (remote deployments). */
  preRegisteredClients?: PreRegisteredClient[];
  /**
   * Bind every code and token to the fingerprint of the owner key that approved it. A grant stops working
   * the moment that key is no longer configured (rotation or removal), with no flag to remember.
   */
  bindGrantsToOwnerKey?: boolean;
}

export interface PreRegisteredClient {
  clientId: string;
  /** sha256 hex of the client secret; the secret itself is never stored by the server. */
  secretSha256: string;
  /** The only user who may approve this client. */
  userId: string;
  name: string;
  redirectUris: string[];
}

export const SUPPORTED_SCOPES = [...ALL_CLIENT_SCOPES];
/** Scopes granted when a client asks for none: never the payment-preparation scope. */
export const DEFAULT_SCOPES = [SCOPES.RESEARCH, SCOPES.READ];

export class OAuthError extends Error {
  constructor(readonly error: string, readonly description: string, readonly status = 400) { super(description); }
  body() { return { error: this.error, error_description: this.description }; }
}

export interface PendingAuthorization {
  id: string; csrf: string; clientId: string; clientName: string; redirectUri: string; state: string | null;
  scopes: string[]; codeChallenge: string; resource: string; expiresAt: number;
  /** Set for operator-registered clients: the name is the operator's, and only this user may approve. */
  boundUserId?: string | null;
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const token = (prefix: string) => `${prefix}_${randomBytes(32).toString("base64url")}`;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const S256_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

function eqHex(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex"); const y = Buffer.from(b, "hex");
  return x.length === y.length && timingSafeEqual(x, y);
}

export function validateRedirectUri(raw: unknown): string {
  if (typeof raw !== "string" || raw.length > 500) throw new OAuthError("invalid_redirect_uri", "redirect_uri must be a string of at most 500 characters");
  let u: URL;
  try { u = new URL(raw); } catch { throw new OAuthError("invalid_redirect_uri", "redirect_uri is not an absolute URL"); }
  if (u.hash) throw new OAuthError("invalid_redirect_uri", "redirect_uri must not contain a fragment");
  if (u.username || u.password) throw new OAuthError("invalid_redirect_uri", "redirect_uri must not contain credentials");
  if (u.protocol === "https:") return u.toString();
  if (u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname)) return u.toString();
  throw new OAuthError("invalid_redirect_uri", "redirect_uri must be https, or http on a loopback address");
}

/** Exact match, except loopback http redirects may differ only in port (RFC 8252 §7.3). */
export function redirectAllowed(allow: readonly string[], uri: string): boolean {
  let u: URL; try { u = new URL(uri); } catch { return false; }
  return allow.some((a) => a === "loopback" ? (u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname))
    : a.endsWith("*") ? uri.startsWith(a.slice(0, -1)) : a === uri);
}

export function redirectMatches(registered: string, presented: string): boolean {
  if (registered === presented) return true;
  try {
    const r = new URL(registered); const p = new URL(presented);
    return r.protocol === "http:" && p.protocol === "http:" && LOOPBACK_HOSTS.has(r.hostname) && r.hostname === p.hostname &&
      r.pathname === p.pathname && r.search === p.search && !p.hash && !p.username && !p.password;
  } catch { return false; }
}

function parseScopes(raw: string | null | undefined, offered: readonly string[] = SUPPORTED_SCOPES): string[] {
  if (raw === null || raw === undefined || raw.trim() === "") return [...DEFAULT_SCOPES];
  const asked = [...new Set(raw.trim().split(/\s+/))];
  const unknown = asked.filter((s) => !offered.includes(s));
  if (unknown.length) throw new OAuthError("invalid_scope", `Unsupported scope(s): ${unknown.join(" ").slice(0, 200)}`);
  return asked;
}

export class OAuthAuthority {
  readonly accessTtl: number; readonly refreshTtl: number; readonly codeTtl: number; readonly maxClients: number; readonly offered: string[];
  private readonly pending = new Map<string, PendingAuthorization>();

  constructor(private readonly store: Store, private readonly owners: DevAuth, readonly cfg: OAuthConfig, private readonly now: () => number = Date.now) {
    this.accessTtl = cfg.accessTokenTtlSec ?? 3600;
    this.refreshTtl = cfg.refreshTokenTtlSec ?? 30 * 86400;
    this.codeTtl = cfg.codeTtlSec ?? 60;
    this.maxClients = cfg.maxClients ?? 1000;
    this.offered = (cfg.offeredScopes ?? SUPPORTED_SCOPES).filter((x) => SUPPORTED_SCOPES.includes(x as never));
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS oauth_clients (
        client_id TEXT PRIMARY KEY, client_name TEXT NOT NULL, redirect_uris_json TEXT NOT NULL,
        auth_method TEXT NOT NULL, secret_hash TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS oauth_codes (
        code_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, user_id TEXT NOT NULL, redirect_uri TEXT NOT NULL,
        scope TEXT NOT NULL, resource TEXT NOT NULL, challenge TEXT NOT NULL, expires_at INTEGER NOT NULL,
        used_at INTEGER, family_id TEXT);
      CREATE TABLE IF NOT EXISTS oauth_tokens (
        token_hash TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('access','refresh')), family_id TEXT NOT NULL,
        client_id TEXT NOT NULL, user_id TEXT NOT NULL, scope TEXT NOT NULL, resource TEXT NOT NULL,
        expires_at INTEGER NOT NULL, revoked_at INTEGER, used_at INTEGER, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS oauth_tokens_by_family ON oauth_tokens(family_id);`);
    // Additive migration: the owner-key fingerprint that approved a code / token (NULL on older rows).
    for (const t of ["oauth_codes", "oauth_tokens"]) {
      const cols = (store.db.prepare(`PRAGMA table_info(${t})`).all() as Row[]).map((c) => String(c.name));
      if (!cols.includes("owner_fp")) store.db.exec(`ALTER TABLE ${t} ADD COLUMN owner_fp TEXT`);
    }
    for (const c of cfg.preRegisteredClients ?? []) {
      if (!/^dcl_[0-9a-f]{32}$/.test(c.clientId) || !/^[0-9a-f]{64}$/.test(c.secretSha256)) throw new Error(`invalid pre-registered client ${c.clientId}`);
      const uris = c.redirectUris.map(validateRedirectUri);
      this.preRegistered.set(c.clientId, { ...c, redirectUris: uris });
      store.db.prepare(`INSERT INTO oauth_clients(client_id,client_name,redirect_uris_json,auth_method,secret_hash,created_at) VALUES (?,?,?,?,?,?)
        ON CONFLICT(client_id) DO UPDATE SET client_name=excluded.client_name, redirect_uris_json=excluded.redirect_uris_json, auth_method=excluded.auth_method, secret_hash=excluded.secret_hash`)
        .run(c.clientId, c.name.slice(0, 80), JSON.stringify(uris), "client_secret_basic", c.secretSha256, now());
    }
  }
  private readonly preRegistered = new Map<string, PreRegisteredClient>();
  get registrationOpen(): boolean { return (this.cfg.registration ?? "dynamic") === "dynamic"; }

  // ---------------- metadata ----------------
  protectedResourceMetadata() {
    return { resource: this.cfg.resource, authorization_servers: [this.cfg.issuer], scopes_supported: this.offered,
      bearer_methods_supported: ["header"], resource_name: "DIAPORIA Agent Commerce MCP" };
  }
  get resourceMetadataUrl(): string { return `${this.cfg.issuer}/.well-known/oauth-protected-resource`; }
  authorizationServerMetadata() {
    const i = this.cfg.issuer;
    return { issuer: i, authorization_endpoint: `${i}/oauth/authorize`, token_endpoint: `${i}/oauth/token`,
      ...(this.registrationOpen ? { registration_endpoint: `${i}/oauth/register` } : {}), revocation_endpoint: `${i}/oauth/revoke`,
      response_types_supported: ["code"], response_modes_supported: ["query"], grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: this.clientAuthMethods,
      revocation_endpoint_auth_methods_supported: this.clientAuthMethods,
      scopes_supported: this.offered, authorization_response_iss_parameter_supported: true };
  }
  /** Closed registration means only confidential, operator-registered clients exist. */
  private get clientAuthMethods(): string[] { return this.registrationOpen ? ["none", "client_secret_post", "client_secret_basic"] : ["client_secret_basic", "client_secret_post"]; }
  /** Value for `WWW-Authenticate` on a 401/403 from /mcp. */
  challenge(error?: "invalid_token" | "insufficient_scope", scope: string = this.offered.join(" ")): string {
    return `Bearer resource_metadata="${this.resourceMetadataUrl}"${error ? `, error="${error}"` : ""}${scope ? `, scope="${scope}"` : ""}`;
  }

  // ---------------- RFC 7591 registration ----------------
  register(body: unknown): { status: number; body: Record<string, unknown> } {
    try {
      if (!this.registrationOpen) throw new OAuthError("access_denied", "Dynamic client registration is disabled on this deployment; use the client id and secret the operator issued", 403);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new OAuthError("invalid_client_metadata", "Body must be a JSON object");
      const b = body as Record<string, unknown>;
      if (!Array.isArray(b.redirect_uris) || b.redirect_uris.length < 1 || b.redirect_uris.length > 5)
        throw new OAuthError("invalid_redirect_uri", "redirect_uris must list 1 to 5 URIs");
      const uris = b.redirect_uris.map(validateRedirectUri);
      if (this.cfg.allowedRedirectUris && !uris.every((u) => redirectAllowed(this.cfg.allowedRedirectUris!, u)))
        throw new OAuthError("invalid_redirect_uri", "redirect_uri is not on this deployment's allowlist of AI host callbacks");
      const method = b.token_endpoint_auth_method === undefined ? "none" : String(b.token_endpoint_auth_method);
      if (!["none", "client_secret_post", "client_secret_basic"].includes(method)) throw new OAuthError("invalid_client_metadata", "Unsupported token_endpoint_auth_method");
      const grants = Array.isArray(b.grant_types) ? b.grant_types.map(String) : ["authorization_code", "refresh_token"];
      if (grants.some((g) => !["authorization_code", "refresh_token"].includes(g))) throw new OAuthError("invalid_client_metadata", "Only authorization_code and refresh_token grants are supported");
      const responseTypes = Array.isArray(b.response_types) ? b.response_types.map(String) : ["code"];
      if (responseTypes.some((r) => r !== "code")) throw new OAuthError("invalid_client_metadata", "Only response_type code is supported");
      if (b.scope !== undefined) parseScopes(String(b.scope), this.offered);
      const name = typeof b.client_name === "string" && b.client_name.trim() ? b.client_name.trim().slice(0, 80) : "Unnamed MCP client";
      const count = Number((this.store.db.prepare("SELECT COUNT(*) AS n FROM oauth_clients").get() as Row).n);
      if (count >= this.maxClients) throw new OAuthError("temporarily_unavailable", "Client registration limit reached", 503);
      const clientId = `dcl_${randomBytes(16).toString("hex")}`;
      const secret = method === "none" ? null : token("dcs");
      const issuedAt = Math.floor(this.now() / 1000);
      this.store.db.prepare("INSERT INTO oauth_clients(client_id,client_name,redirect_uris_json,auth_method,secret_hash,created_at) VALUES (?,?,?,?,?,?)")
        .run(clientId, name, JSON.stringify(uris), method, secret ? sha(secret) : null, this.now());
      return { status: 201, body: { client_id: clientId, client_id_issued_at: issuedAt, ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
        client_name: name, redirect_uris: uris, token_endpoint_auth_method: method, grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] } };
    } catch (e) { return this.errorResponse(e); }
  }

  private client(clientId: string | null | undefined): { clientId: string; name: string; redirectUris: string[]; authMethod: string; secretHash: string | null } | null {
    if (!clientId || !/^dcl_[0-9a-f]{32}$/.test(clientId)) return null;
    if (!this.registrationOpen && !this.preRegistered.has(clientId)) return null;
    const r = this.store.db.prepare("SELECT * FROM oauth_clients WHERE client_id = ?").get(clientId) as Row | undefined;
    return r ? { clientId, name: String(r.client_name), redirectUris: JSON.parse(String(r.redirect_uris_json)), authMethod: String(r.auth_method),
      secretHash: r.secret_hash === null ? null : String(r.secret_hash) } : null;
  }

  // ---------------- authorization endpoint ----------------
  /**
   * Validates an authorization request. Errors before the client and redirect URI are verified
   * must be shown to the user, never redirected (RFC 6749 §4.1.2.1): `redirect` is null then.
   */
  beginAuthorization(q: URLSearchParams): { ok: true; pending: PendingAuthorization } | { ok: false; error: OAuthError; redirect: string | null } {
    const client = this.client(q.get("client_id"));
    if (!client) return { ok: false, error: new OAuthError("invalid_client", "Unknown client_id"), redirect: null };
    const ru = q.get("redirect_uri");
    const redirectUri = ru ?? (client.redirectUris.length === 1 ? client.redirectUris[0]! : null);
    if (!redirectUri || !client.redirectUris.some((r) => redirectMatches(r, redirectUri)))
      return { ok: false, error: new OAuthError("invalid_request", "redirect_uri is not registered for this client"), redirect: null };
    const state = q.get("state");
    const fail = (e: OAuthError) => ({ ok: false as const, error: e, redirect: this.errorRedirect(redirectUri, e, state) });
    if (q.get("response_type") !== "code") return fail(new OAuthError("unsupported_response_type", "response_type must be code"));
    const challenge = q.get("code_challenge") ?? "";
    if (q.get("code_challenge_method") !== "S256" || !S256_CHALLENGE.test(challenge)) return fail(new OAuthError("invalid_request", "PKCE with code_challenge_method=S256 is required"));
    const resource = q.get("resource") ?? this.cfg.resource;
    if (resource !== this.cfg.resource) return fail(new OAuthError("invalid_target", "resource must be this server's MCP endpoint"));
    let scopes: string[];
    try { scopes = parseScopes(q.get("scope"), this.offered); } catch (e) { return fail(e as OAuthError); }
    this.gc();
    const pending: PendingAuthorization = { id: randomBytes(18).toString("base64url"), csrf: randomBytes(18).toString("base64url"), clientId: client.clientId,
      clientName: client.name, redirectUri, state, scopes, codeChallenge: challenge, resource, expiresAt: this.now() + 10 * 60_000,
      boundUserId: this.preRegistered.get(client.clientId)?.userId ?? null };
    this.pending.set(pending.id, pending);
    return { ok: true, pending };
  }

  getPending(id: string | null | undefined): PendingAuthorization | null {
    const p = id ? this.pending.get(id) : undefined;
    return p && p.expiresAt > this.now() ? p : null;
  }

  /**
   * The human's decision on the consent page. Returns the URL to redirect the browser to, or
   * an error to display (no redirect) when the pending request or CSRF token is invalid.
   */
  completeAuthorization(form: URLSearchParams): { redirect: string } | { error: OAuthError } {
    const p = this.getPending(form.get("request_id"));
    if (!p || form.get("csrf") !== p.csrf) return { error: new OAuthError("invalid_request", "Authorization request expired or invalid; start again from your AI client", 400) };
    if (form.get("decision") !== "approve") {
      this.pending.delete(p.id);
      return { redirect: this.errorRedirect(p.redirectUri, new OAuthError("access_denied", "The user denied the request"), p.state) };
    }
    const userId = this.owners.verifyOwnerKey(form.get("owner_key") ?? undefined);
    if (!userId) return { error: new OAuthError("access_denied", "Owner key not recognized", 401) };
    if (p.boundUserId && p.boundUserId !== userId) return { error: new OAuthError("access_denied", "This client is registered for a different account; it cannot be approved with this owner key", 403) };
    const ownerFp = this.owners.ownerKeyFingerprint(form.get("owner_key") ?? undefined);
    const granted = p.scopes.filter((s) => form.getAll("scope").includes(s));
    if (!granted.length) return { error: new OAuthError("invalid_scope", "Select at least one permission, or deny the request", 400) };
    this.pending.delete(p.id);
    const code = token("dac");
    this.store.db.prepare("INSERT INTO oauth_codes(code_hash,client_id,user_id,redirect_uri,scope,resource,challenge,expires_at,owner_fp) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(sha(code), p.clientId, userId, p.redirectUri, granted.join(" "), p.resource, p.codeChallenge, this.now() + this.codeTtl * 1000, ownerFp);
    const u = new URL(p.redirectUri);
    u.searchParams.set("code", code);
    if (p.state !== null) u.searchParams.set("state", p.state);
    u.searchParams.set("iss", this.cfg.issuer);
    return { redirect: u.toString() };
  }

  private errorRedirect(redirectUri: string, e: OAuthError, state: string | null): string {
    const u = new URL(redirectUri);
    u.searchParams.set("error", e.error); u.searchParams.set("error_description", e.description);
    if (state !== null) u.searchParams.set("state", state);
    u.searchParams.set("iss", this.cfg.issuer);
    return u.toString();
  }

  // ---------------- token endpoint ----------------
  token(form: URLSearchParams, authorization?: string): { status: number; body: Record<string, unknown> } {
    try {
      const client = this.authenticateClient(form, authorization);
      const grant = form.get("grant_type");
      if (grant === "authorization_code") return { status: 200, body: this.exchangeCode(client, form) };
      if (grant === "refresh_token") return { status: 200, body: this.refresh(client, form) };
      throw new OAuthError("unsupported_grant_type", "grant_type must be authorization_code or refresh_token");
    } catch (e) { return this.errorResponse(e); }
  }

  private authenticateClient(form: URLSearchParams, authorization?: string) {
    let id = form.get("client_id"); let secret = form.get("client_secret");
    const basic = /^Basic ([A-Za-z0-9+/=]+)$/.exec(authorization ?? "");
    if (basic) {
      const [bi, ...rest] = Buffer.from(basic[1]!, "base64").toString("utf8").split(":");
      id = decodeURIComponent(bi ?? ""); secret = decodeURIComponent(rest.join(":"));
    }
    const client = this.client(id);
    if (!client) throw new OAuthError("invalid_client", "Unknown client", 401);
    if (client.authMethod !== "none") {
      if (!secret || !client.secretHash || !eqHex(sha(secret), client.secretHash)) throw new OAuthError("invalid_client", "Client authentication failed", 401);
    }
    return client;
  }

  private exchangeCode(client: { clientId: string }, form: URLSearchParams) {
    const code = form.get("code") ?? ""; const verifier = form.get("code_verifier") ?? "";
    const r = this.store.db.prepare("SELECT * FROM oauth_codes WHERE code_hash = ?").get(sha(code)) as Row | undefined;
    if (!r || r.client_id !== client.clientId) throw new OAuthError("invalid_grant", "Invalid authorization code");
    if (r.used_at !== null) {
      // Replay of a used code: revoke everything issued from it (OAuth 2.1 §4.1.3).
      if (r.family_id) this.revokeFamily(String(r.family_id));
      throw new OAuthError("invalid_grant", "Authorization code already used");
    }
    if (Number(r.expires_at) <= this.now()) throw new OAuthError("invalid_grant", "Authorization code expired");
    if (!this.ownerKeyStillValid(r.owner_fp)) throw new OAuthError("invalid_grant", "The owner key that approved this code is no longer valid");
    const ru = form.get("redirect_uri");
    if (ru !== null && ru !== r.redirect_uri) throw new OAuthError("invalid_grant", "redirect_uri does not match the authorization request");
    const resource = form.get("resource");
    if (resource !== null && resource !== r.resource) throw new OAuthError("invalid_target", "resource does not match the authorization request");
    if (!VERIFIER.test(verifier) || createHash("sha256").update(verifier).digest("base64url") !== r.challenge)
      throw new OAuthError("invalid_grant", "PKCE verification failed");
    const family = `fam_${randomBytes(12).toString("hex")}`;
    return this.store.transaction(() => {
      const upd = this.store.db.prepare("UPDATE oauth_codes SET used_at = ?, family_id = ? WHERE code_hash = ? AND used_at IS NULL").run(this.now(), family, sha(code));
      if (upd.changes !== 1) throw new OAuthError("invalid_grant", "Authorization code already used");
      return this.issue(family, client.clientId, String(r.user_id), String(r.scope), String(r.resource), r.owner_fp === null ? null : String(r.owner_fp));
    });
  }

  private refresh(client: { clientId: string }, form: URLSearchParams) {
    const rt = form.get("refresh_token") ?? "";
    const r = this.store.db.prepare("SELECT * FROM oauth_tokens WHERE token_hash = ? AND kind = 'refresh'").get(sha(rt)) as Row | undefined;
    if (!r || r.client_id !== client.clientId) throw new OAuthError("invalid_grant", "Invalid refresh token");
    if (r.revoked_at !== null) throw new OAuthError("invalid_grant", "Refresh token revoked");
    if (r.used_at !== null) { this.revokeFamily(String(r.family_id)); throw new OAuthError("invalid_grant", "Refresh token reuse detected; grant revoked"); }
    if (Number(r.expires_at) <= this.now()) throw new OAuthError("invalid_grant", "Refresh token expired");
    if (!this.ownerKeyStillValid(r.owner_fp)) { this.revokeFamily(String(r.family_id)); throw new OAuthError("invalid_grant", "The owner key that approved this grant is no longer valid; authorize again"); }
    if (this.cfg.grantMaxAgeSec !== undefined) {
      const first = this.store.db.prepare("SELECT MIN(created_at) AS t FROM oauth_tokens WHERE family_id = ?").get(String(r.family_id)) as Row;
      if (Number(first.t) + this.cfg.grantMaxAgeSec * 1000 <= this.now()) { this.revokeFamily(String(r.family_id)); throw new OAuthError("invalid_grant", "Grant reached its maximum age; authorize again"); }
    }
    const resource = form.get("resource");
    if (resource !== null && resource !== r.resource) throw new OAuthError("invalid_target", "resource does not match the grant");
    const had = String(r.scope).split(" ");
    const asked = form.get("scope");
    const scope = asked === null ? had : parseScopes(asked, this.offered);
    if (scope.some((s) => !had.includes(s))) throw new OAuthError("invalid_scope", "A refresh cannot widen the granted scope");
    return this.store.transaction(() => {
      const upd = this.store.db.prepare("UPDATE oauth_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND revoked_at IS NULL").run(this.now(), sha(rt));
      if (upd.changes !== 1) throw new OAuthError("invalid_grant", "Refresh token already used");
      return this.issue(String(r.family_id), client.clientId, String(r.user_id), scope.join(" "), String(r.resource), r.owner_fp === null ? null : String(r.owner_fp));
    });
  }

  /** With bindGrantsToOwnerKey, a grant is valid only while the owner key that approved it is still configured. */
  private ownerKeyStillValid(fp: unknown): boolean {
    if (!this.cfg.bindGrantsToOwnerKey) return true;
    return typeof fp === "string" && this.owners.ownerKeyFingerprints().includes(fp);
  }

  private issue(family: string, clientId: string, userId: string, scope: string, resource: string, ownerFp: string | null) {
    const access = token("dat"); const refresh = token("drt"); const t = this.now();
    const ins = this.store.db.prepare(`INSERT INTO oauth_tokens(token_hash,kind,family_id,client_id,user_id,scope,resource,expires_at,created_at,owner_fp) VALUES (?,?,?,?,?,?,?,?,?,?)`);
    ins.run(sha(access), "access", family, clientId, userId, scope, resource, t + this.accessTtl * 1000, t, ownerFp);
    ins.run(sha(refresh), "refresh", family, clientId, userId, scope, resource, t + this.refreshTtl * 1000, t, ownerFp);
    return { access_token: access, token_type: "Bearer", expires_in: this.accessTtl, refresh_token: refresh, scope };
  }

  revokeFamily(family: string): void {
    this.store.db.prepare("UPDATE oauth_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL").run(this.now(), family);
  }

  /** RFC 7009: always 200 for a well-formed request, whether or not the token existed. */
  revoke(form: URLSearchParams, authorization?: string): { status: number; body: Record<string, unknown> } {
    try {
      const client = this.authenticateClient(form, authorization);
      const r = this.store.db.prepare("SELECT family_id, client_id FROM oauth_tokens WHERE token_hash = ?").get(sha(form.get("token") ?? "")) as Row | undefined;
      if (r && r.client_id === client.clientId) this.revokeFamily(String(r.family_id));
      return { status: 200, body: {} };
    } catch (e) { return this.errorResponse(e); }
  }

  // ---------------- resource server ----------------
  /** Verifies `Authorization: Bearer <access token>` for THIS resource. */
  verifyAccessToken(header: string | undefined): (Principal & { clientId: string }) | null {
    const m = /^Bearer (dat_[A-Za-z0-9_-]{43})$/.exec(header ?? "");
    if (!m) return null;
    const h = sha(m[1]!);
    const r = this.store.db.prepare("SELECT * FROM oauth_tokens WHERE token_hash = ? AND kind = 'access'").get(h) as Row | undefined;
    if (!r || r.revoked_at !== null || Number(r.expires_at) <= this.now() || r.resource !== this.cfg.resource) return null;
    if (!this.ownerKeyStillValid(r.owner_fp)) return null;
    if (!this.registrationOpen && !this.preRegistered.has(String(r.client_id))) return null;
    return { userId: String(r.user_id), scopes: new Set(String(r.scope).split(" ")), kind: "OAUTH_ACCESS_TOKEN", tokenFingerprint: h.slice(0, 12), clientId: String(r.client_id) };
  }

  private gc() {
    const t = this.now();
    for (const [k, v] of this.pending) if (v.expiresAt <= t) this.pending.delete(k);
    // Map iteration order is insertion order, i.e. oldest first: evict by age, never wipe live requests.
    const max = this.cfg.maxPending ?? 5000;
    for (const k of this.pending.keys()) { if (this.pending.size <= max) break; this.pending.delete(k); }
  }

  /**
   * Housekeeping for long-running deployments: deletes expired codes, grants dead for over a day, and clients older than `unusedClientAgeSec` that never obtained a token. Returns row counts.
   */
  prune(unusedClientAgeSec = 3600): { codes: number; tokens: number; clients: number } {
    const t = this.now(); const day = 86_400_000;
    return this.store.transaction(() => {
      const codes = this.store.db.prepare("DELETE FROM oauth_codes WHERE expires_at <= ?").run(t).changes;
      // Whole grants only (a grant's first token dates it for grantMaxAgeSec): delete a family once none of its
      // tokens has been usable for a day.
      const tokens = this.store.db.prepare(`DELETE FROM oauth_tokens WHERE family_id IN (SELECT family_id FROM oauth_tokens GROUP BY family_id
        HAVING MAX(CASE WHEN revoked_at IS NULL AND expires_at > ? THEN 1 ELSE 0 END) = 0 AND MAX(COALESCE(revoked_at, expires_at)) <= ?)`).run(t - day, t - day).changes;
      const clients = this.store.db.prepare(`DELETE FROM oauth_clients WHERE created_at <= ?
        AND client_id NOT IN (SELECT client_id FROM oauth_tokens) AND client_id NOT IN (SELECT client_id FROM oauth_codes)`).run(t - unusedClientAgeSec * 1000).changes;
      return { codes: Number(codes), tokens: Number(tokens), clients: Number(clients) };
    });
  }

  /** Revokes every grant of users that no longer hold an owner key (run at startup after a key change). */
  revokeGrantsExceptUsers(userIds: string[]): number {
    const marks = userIds.map(() => "?").join(",");
    const sql = `UPDATE oauth_tokens SET revoked_at = ? WHERE revoked_at IS NULL${userIds.length ? ` AND user_id NOT IN (${marks})` : ""}`;
    return Number(this.store.db.prepare(sql).run(this.now(), ...userIds).changes);
  }

  /**
   * Persistently revokes grants that can no longer be valid: approved by an owner key that is no longer
   * configured (or by no recorded key), or issued to a client that is not pre-registered when registration
   * is closed. Run at startup so a restored backup or a rollback cannot revive them.
   */
  revokeStaleGrants(): number {
    const t = this.now(); let n = 0;
    if (this.cfg.bindGrantsToOwnerKey) {
      const fps = this.owners.ownerKeyFingerprints();
      const marks = fps.map(() => "?").join(",");
      n += Number(this.store.db.prepare(`UPDATE oauth_tokens SET revoked_at = ? WHERE revoked_at IS NULL AND (owner_fp IS NULL${fps.length ? ` OR owner_fp NOT IN (${marks})` : ""})`).run(t, ...fps).changes);
    }
    if (!this.registrationOpen) {
      const ids = [...this.preRegistered.keys()];
      const marks = ids.map(() => "?").join(",");
      n += Number(this.store.db.prepare(`UPDATE oauth_tokens SET revoked_at = ? WHERE revoked_at IS NULL${ids.length ? ` AND client_id NOT IN (${marks})` : ""}`).run(t, ...ids).changes);
      this.store.db.prepare(`DELETE FROM oauth_clients${ids.length ? ` WHERE client_id NOT IN (${marks})` : ""}`).run(...ids);
    }
    return n;
  }

  /** Revokes every grant (owner-key rotation). */
  revokeAllGrants(): number { return Number(this.store.db.prepare("UPDATE oauth_tokens SET revoked_at = ? WHERE revoked_at IS NULL").run(this.now()).changes); }

  private errorResponse(e: unknown): { status: number; body: Record<string, unknown> } {
    if (e instanceof OAuthError) return { status: e.status, body: e.body() };
    return { status: 500, body: { error: "server_error", error_description: "Internal error" } };
  }
}
