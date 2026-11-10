/**
 * Entrypoint for the remote research/read-only MCP service (deploy/remote-mcp).
 * Refuses to start (exit 78) on any insecure or payment-widening configuration.
 */
import { createHash } from "node:crypto";
import { loadRemoteReadonlyConfig, RemoteConfigError, EXIT_CONFIG } from "./readonlyConfig.js";
import { createRemoteReadonlyApp, remoteStartupHousekeeping, RemoteInvariantError, REMOTE_PROFILE } from "./app.js";
import { attachAuditLog } from "./auditLog.js";

const log = (o: Record<string, unknown>) => process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), ...o }) + "\n");

let cfg;
try { cfg = loadRemoteReadonlyConfig(process.env); }
catch (e) {
  if (e instanceof RemoteConfigError) { log({ event: "startup_refused", profile: REMOTE_PROFILE, problems: e.problems }); process.exit(EXIT_CONFIG); }
  throw e;
}

let app;
try { app = createRemoteReadonlyApp(cfg); }
catch (e) {
  if (e instanceof RemoteInvariantError) { log({ event: "startup_refused", profile: REMOTE_PROFILE, problems: [e.message] }); process.exit(EXIT_CONFIG); }
  throw e;
}
const housekeeping = remoteStartupHousekeeping(app, cfg);
const pruneTimer = setInterval(() => { try { const p = app.oauth!.prune(); if (p.codes + p.tokens + p.clients) log({ event: "oauth_prune", ...p }); } catch { log({ event: "oauth_prune_failed" }); } }, 3_600_000);
pruneTimer.unref();
if (cfg.auditLog) attachAuditLog(app.server, new Set(cfg.trustedProxies));

// A fingerprint of the non-secret configuration, so an operator can match a running process to an approved manifest.
const manifest = { profile: REMOTE_PROFILE, baseUrl: cfg.baseUrl, resource: `${cfg.baseUrl}/mcp`, scopes: app.oauth!.offered, users: cfg.ownerKeys.map((o) => o.userId).sort(),
  trustedProxies: cfg.trustedProxies, accessTokenTtlSec: cfg.accessTokenTtlSec, refreshTokenTtlSec: cfg.refreshTokenTtlSec, maxClients: cfg.maxClients,
  rateLimits: { mcpPerMinute: cfg.mcpPerMinute, webPerMinute: cfg.webPerMinute, registerPerHour: cfg.registerPerHour },
  allowedRedirectUris: cfg.allowedRedirectUris, grantMaxAgeSec: cfg.grantMaxAgeSec, maxPending: cfg.maxPending,
  paymentExecutionEnabled: app.paymentExecutionEnabled, research: app.gateway.research.name, payments: app.gateway.payments.name };
const configDigest = createHash("sha256").update(JSON.stringify(manifest)).digest("hex").slice(0, 16);

app.server.requestTimeout = 30_000;
app.server.headersTimeout = 15_000;
app.server.listen(cfg.port, cfg.host, () => log({ event: "startup", ...manifest, configDigest, housekeeping, listen: `${cfg.host}:${cfg.port}` }));
const stop = (sig: string) => { log({ event: "shutdown", signal: sig }); app.server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); };
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
