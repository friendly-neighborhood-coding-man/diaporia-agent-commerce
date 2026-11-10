/**
 * Remote research/read-only deployment profile.
 *
 * The remote entrypoint (src/remote/main.ts) never reads payment, handoff, billing or live-provider
 * configuration. This module turns the process environment into a fixed, validated configuration and
 * REFUSES to start when anything would widen the public surface. There is deliberately no flag that
 * enables payment-capable routes or tools in this profile: the only way to get them is the local
 * entrypoint (src/main.ts) on a loopback host.
 */
import { isAbsolute } from "node:path";

export const REMOTE_OWNER_KEY_PREFIX = "drk_";
/**
 * Default redirect allowlist: the documented callbacks of the hosts in docs/REMOTE_HOST_COMPATIBILITY.md,
 * plus loopback for local clients (Claude Code, MCP Inspector, Gemini CLI). A code sent to these can only
 * reach that host or the user's own machine, which closes look-alike-client consent phishing (IR-03/IR-04).
 */
export const DEFAULT_REDIRECT_ALLOWLIST = [
  "https://claude.ai/api/mcp/auth_callback",
  "https://chatgpt.com/connector_platform_oauth_redirect",
  "https://chatgpt.com/connector/oauth/*",
  "loopback",
];
/** Exit code for a refused configuration (EX_CONFIG). */
export const EXIT_CONFIG = 78;

/** Variables that must be ABSENT. Their presence means someone expects a capability this profile never has. */
export const FORBIDDEN_ENV: readonly (string | RegExp)[] = [
  /^PAYPAL_/, /^HANDOFF_/, /^KERNEL_/, /^MERCHANT_/, /^MANAGED_/,
  "TAVILY_API_KEY", "CHANNEL3_API_KEY", "RESEARCH_PROVIDER", "EVIDENCE_PROVIDERS",
  "DIAPORIA_DEV_TOKENS", "DIAPORIA_DEPLOYMENT_MODE", "DIAPORIA_MANAGED_SIMULATION",
  "DIAPORIA_ENABLE_LIVE_KERNEL_INSPECTION", "DIAPORIA_FIXTURE_CHROMIUM",
];

export interface RemoteReadonlyConfig {
  host: string;
  port: number;
  baseUrl: string;
  dbPath: string;
  ownerKeys: { key: string; userId: string }[];
  trustedProxies: string[];
  accessTokenTtlSec: number;
  refreshTokenTtlSec: number;
  maxClients: number;
  auditLog: boolean;
  mcpPerMinute: number;
  webPerMinute: number;
  registerPerHour: number;
  allowedRedirectUris: string[];
  grantMaxAgeSec: number;
  maxPending: number;
  revokeAllGrantsOnStart: boolean;
}

export class RemoteConfigError extends Error {
  constructor(readonly problems: string[]) { super(`Refusing to start the remote read-only service:\n - ${problems.join("\n - ")}`); }
}

const LOOPBACK_HOST = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\]|0\.0\.0\.0|\[::\])$/i;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

function int(env: NodeJS.ProcessEnv, name: string, def: number, min: number, max: number, problems: string[]): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) { problems.push(`${name} must be an integer in [${min}, ${max}]`); return def; }
  return n;
}

/** Validate the environment for the remote read-only profile. Throws RemoteConfigError listing every problem. */
export function loadRemoteReadonlyConfig(env: NodeJS.ProcessEnv): RemoteReadonlyConfig {
  const problems: string[] = [];

  for (const name of Object.keys(env)) {
    if (FORBIDDEN_ENV.some((f) => (typeof f === "string" ? f === name : f.test(name)))) problems.push(`${name} is set; this profile never uses it (remove it from the environment)`);
  }
  if (env.DIAPORIA_AUTH_MODE !== undefined && env.DIAPORIA_AUTH_MODE !== "oauth") problems.push("DIAPORIA_AUTH_MODE must be unset or 'oauth'");
  if (env.PAYMENT_PROVIDER !== undefined && env.PAYMENT_PROVIDER.toLowerCase() !== "mock") problems.push("PAYMENT_PROVIDER must be unset or 'mock' (no payment provider is ever constructed)");

  // Public origin: https, a real hostname, no path, query, fragment or credentials.
  let baseUrl = "";
  const rawBase = env.PUBLIC_BASE_URL;
  if (!rawBase) problems.push("PUBLIC_BASE_URL is required (e.g. https://mcp.example.com)");
  else {
    try {
      const u = new URL(rawBase);
      if (u.protocol !== "https:") problems.push("PUBLIC_BASE_URL must use https");
      if (LOOPBACK_HOST.test(u.hostname)) problems.push("PUBLIC_BASE_URL must not be a loopback or wildcard host (a loopback base URL enables local payment flows)");
      if (IPV4.test(u.hostname) || u.hostname.startsWith("[")) problems.push("PUBLIC_BASE_URL must be a DNS hostname, not an IP literal");
      if (u.username || u.password) problems.push("PUBLIC_BASE_URL must not contain credentials");
      if ((u.pathname !== "/" && u.pathname !== "") || u.search || u.hash) problems.push("PUBLIC_BASE_URL must be an origin only (no path, query or fragment)");
      baseUrl = u.origin;
    } catch { problems.push("PUBLIC_BASE_URL is not a valid URL"); }
  }

  // Human credentials: required, explicit, remote-only, never the local purchasing key.
  const ownerKeys: { key: string; userId: string }[] = [];
  const rawKeys = env.DIAPORIA_OWNER_KEYS ?? "";
  if (!rawKeys.trim()) problems.push("DIAPORIA_OWNER_KEYS is required (no generated or file-based fallback in this profile)");
  for (const entry of rawKeys.split(";").map((s) => s.trim()).filter(Boolean)) {
    const eq = entry.lastIndexOf("=");
    const key = eq > 0 ? entry.slice(0, eq) : ""; const userId = eq > 0 ? entry.slice(eq + 1) : "";
    if (!key || !/^[a-z0-9][a-z0-9_-]{0,62}$/i.test(userId)) { problems.push("DIAPORIA_OWNER_KEYS entries must look like drk_<secret>=<userId>"); continue; }
    if (!key.startsWith(REMOTE_OWNER_KEY_PREFIX)) problems.push(`owner key for "${userId}" must start with ${REMOTE_OWNER_KEY_PREFIX} (generate with npm run remote:owner-key); local dok_ keys are refused`);
    else if (key.length < REMOTE_OWNER_KEY_PREFIX.length + 32) problems.push(`owner key for "${userId}" is too short (need at least 32 random characters)`);
    if (ownerKeys.some((o) => o.key === key)) problems.push("DIAPORIA_OWNER_KEYS contains the same key twice");
    if (ownerKeys.some((o) => o.userId === userId)) problems.push(`DIAPORIA_OWNER_KEYS contains user "${userId}" twice`);
    ownerKeys.push({ key, userId });
  }

  const dbPath = env.DIAPORIA_DB_PATH ?? "";
  if (!dbPath) problems.push("DIAPORIA_DB_PATH is required (absolute path on a persistent volume)");
  else if (dbPath === ":memory:" || !isAbsolute(dbPath)) problems.push("DIAPORIA_DB_PATH must be an absolute file path (not :memory:)");

  const host = env.HOST ?? "0.0.0.0";
  const port = int(env, "PORT", 8080, 1, 65535, problems);
  const trustedProxies = (env.DIAPORIA_TRUSTED_PROXIES ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  for (const p of trustedProxies) if (!IPV4.test(p) && !/^[0-9a-f:]+$/i.test(p)) problems.push(`DIAPORIA_TRUSTED_PROXIES entry "${p}" is not an IP address`);
  const accessTokenTtlSec = int(env, "DIAPORIA_ACCESS_TOKEN_TTL_SEC", 3600, 60, 3600, problems);
  const refreshTokenTtlSec = int(env, "DIAPORIA_REFRESH_TOKEN_TTL_SEC", 7 * 86400, 3600, 30 * 86400, problems);
  const maxClients = int(env, "DIAPORIA_MAX_OAUTH_CLIENTS", 200, 1, 1000, problems);
  const auditLog = env.DIAPORIA_AUDIT_LOG !== "0";
  const mcpPerMinute = int(env, "DIAPORIA_MCP_RATE_PER_MIN", 120, 1, 6000, problems);
  const webPerMinute = int(env, "DIAPORIA_WEB_RATE_PER_MIN", 30, 1, 6000, problems);
  const registerPerHour = int(env, "DIAPORIA_REGISTER_PER_HOUR", 10, 1, 1000, problems);
  const grantMaxAgeSec = int(env, "DIAPORIA_GRANT_MAX_AGE_SEC", 86400, 600, 30 * 86400, problems);
  const maxPending = int(env, "DIAPORIA_MAX_PENDING_AUTHORIZATIONS", 500, 10, 5000, problems);
  const revokeAllGrantsOnStart = env.DIAPORIA_REVOKE_ALL_GRANTS_ON_START === "1";
  const allowedRedirectUris = env.DIAPORIA_ALLOWED_REDIRECT_URIS === undefined ? [...DEFAULT_REDIRECT_ALLOWLIST]
    : env.DIAPORIA_ALLOWED_REDIRECT_URIS.split(",").map((s) => s.trim()).filter(Boolean);
  if (!allowedRedirectUris.length) problems.push("DIAPORIA_ALLOWED_REDIRECT_URIS must list at least one entry");
  for (const a of allowedRedirectUris) {
    if (a === "loopback") continue;
    let u: URL | null = null; try { u = new URL(a.endsWith("*") ? a.slice(0, -1) : a); } catch { /* reported below */ }
    if (!u || u.protocol !== "https:" || u.username || u.password || u.hash || (a.endsWith("*") && u.pathname.length < 2))
      problems.push(`DIAPORIA_ALLOWED_REDIRECT_URIS entry "${a}" must be an https URI, an https prefix with a path ending in *, or "loopback"`);
  }

  if (problems.length) throw new RemoteConfigError(problems);
  return { host, port, baseUrl, dbPath, ownerKeys, trustedProxies, accessTokenTtlSec, refreshTokenTtlSec, maxClients, auditLog, mcpPerMinute, webPerMinute,
    registerPerHour, allowedRedirectUris, grantMaxAgeSec, maxPending, revokeAllGrantsOnStart };
}
