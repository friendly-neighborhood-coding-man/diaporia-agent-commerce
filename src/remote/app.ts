import { createApp, type App } from "../http/server.js";
import { DevAuth, SCOPES } from "../auth/devAuth.js";
import { MockPayPalProvider } from "../payment/MockPayPalProvider.js";
import { Store } from "../store/Database.js";
import { UsageLedger, PLACEHOLDER_PRICING } from "../metering/UsageLedger.js";
import { EvidenceRouter } from "../evidence/EvidenceRouter.js";
import { MockKernelInspector, MockTavilySearch } from "../evidence/providers.js";
import type { RemoteReadonlyConfig } from "./readonlyConfig.js";

export const REMOTE_PROFILE = "remote-readonly";
export const REMOTE_SCOPES = [SCOPES.RESEARCH, SCOPES.READ] as const;

export class RemoteInvariantError extends Error {}

/**
 * Builds the research/read-only service. Every payment-adjacent option of createApp is fixed here:
 * OAuth only, MOCK payment provider object (never called: payment execution is off), no PayPal
 * webhook verifier, no browser handoff, no managed billing, MOCK catalog and MOCK evidence providers.
 * After construction the invariants are checked again on the live app; any deviation throws.
 */
export function createRemoteReadonlyApp(cfg: RemoteReadonlyConfig, opts: { now?: () => number } = {}): App {
  const auth = new DevAuth();
  for (const o of cfg.ownerKeys) auth.addOwnerKey(o.key, o.userId);
  const servicePath = cfg.dbPath.replace(/\.sqlite$/, "") + "-service.sqlite";
  const serviceStore = new Store(servicePath);
  const ledger = new UsageLedger(serviceStore, PLACEHOLDER_PRICING);
  const router = new EvidenceRouter(serviceStore, ledger, new MockTavilySearch(), new MockKernelInspector(), { billable: false });
  const app = createApp({
    host: cfg.host, port: cfg.port, baseUrl: cfg.baseUrl, authMode: "oauth", auth, dbPath: cfg.dbPath,
    payments: (url) => new MockPayPalProvider(url),
    webhookVerifier: null, handoff: null, sandboxPlatformPayeeId: null, sandboxPlatformPayeeEmail: null,
    service: { mode: "community", ledger, router, billing: null },
    oauth: { accessTokenTtlSec: cfg.accessTokenTtlSec, refreshTokenTtlSec: Math.min(cfg.refreshTokenTtlSec, cfg.grantMaxAgeSec), maxClients: cfg.maxClients,
      allowedRedirectUris: cfg.allowedRedirectUris, grantMaxAgeSec: cfg.grantMaxAgeSec, maxPending: cfg.maxPending,
      registration: "closed", preRegisteredClients: cfg.clients, bindGrantsToOwnerKey: true },
    strictHost: true, healthzLoopbackOnly: true, trustedProxies: cfg.trustedProxies,
    rateLimits: { mcpPerMinute: cfg.mcpPerMinute, webPerMinute: cfg.webPerMinute, registerPerHour: cfg.registerPerHour },
    ...(opts.now ? { now: opts.now } : {}),
  });
  assertReadonlyInvariants(app);
  return app;
}

/**
 * Startup housekeeping (fail closed): grants approved by an owner key that is no longer configured, grants of
 * removed users and grants of clients that are no longer registered are revoked persistently, so a key
 * rotation, a restored backup or a rollback cannot revive them. revokeAll additionally revokes everything.
 * Dead OAuth rows are pruned.
 */
export function remoteStartupHousekeeping(app: App, cfg: RemoteReadonlyConfig) {
  const oauth = app.oauth!;
  const stale = oauth.revokeStaleGrants();
  const removedUsers = oauth.revokeGrantsExceptUsers(cfg.ownerKeys.map((o) => o.userId));
  const all = cfg.revokeAllGrantsOnStart ? oauth.revokeAllGrants() : 0;
  return { revoked: stale + removedUsers + all, stale, removedUsers, all, pruned: oauth.prune() };
}

export function assertReadonlyInvariants(app: App): void {
  const fail = (m: string) => { app.server.close(); throw new RemoteInvariantError(`remote read-only invariant violated: ${m}`); };
  if (app.paymentExecutionEnabled) fail("payment execution is enabled");
  if (!app.oauth) fail("OAuth authority missing");
  const offered = [...(app.oauth!.offered ?? [])].sort().join(" ");
  if (offered !== [...REMOTE_SCOPES].sort().join(" ")) fail(`offered scopes are "${offered}"`);
  if (app.handoff) fail("browser handoff is configured");
  if (!app.mockPayPal) fail("a non-MOCK payment provider is configured");
  if (app.oauth!.registrationOpen) fail("dynamic client registration is open");
  if ("registration_endpoint" in app.oauth!.authorizationServerMetadata()) fail("registration endpoint is advertised");
  if (!app.oauth!.cfg.bindGrantsToOwnerKey) fail("grants are not bound to owner keys");
}
