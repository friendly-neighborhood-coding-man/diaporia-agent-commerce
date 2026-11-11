/**
 * Hard outer guard for BOUNDED LIVE provider tests (not used by the service itself).
 *
 * Two different cap sets exist and must not be confused:
 *  - SERVICE_LIVE_CAPS: the per-request caps the running service uses with live keys (main.ts). Unchanged by Research V2.
 *  - A live-test ALLOWANCE (e.g. LTP-V2-01: Channel3 3, Tavily 6 per request): only for an owner-approved test run,
 *    passed explicitly by the test script. It never changes the service caps.
 *
 * The guard wraps fetch and enforces, before any byte leaves the process:
 *  - exact approved hostnames (no suffix match, https only, default port, no userinfo);
 *  - no redirects (redirect: "manual"; any 3xx stops the run and still counts as a call);
 *  - run-total call caps and run-total credit caps per provider (expected credits are checked BEFORE the call);
 *  - Tavily basic depth only, never auto_parameters (which may switch to 2-credit advanced);
 *  - stop on auth/credit/plan errors, and on a 429/5xx that survives one retry.
 * Logs contain provider, path, status, credits and provider request id only: never headers, keys or bodies.
 */
export const SERVICE_LIVE_CAPS = Object.freeze({ CHANNEL3: 1, TAVILY: 2, KERNEL: 1 });
/** Service adapters make exactly one HTTP attempt per metered call, so ledger counts equal HTTP counts (review R-08). */
export const SERVICE_LIVE_RETRY = Object.freeze({ attempts: 1, baseDelayMs: 0, maxRetryAfterMs: 0 });
export const APPROVED_PROVIDER_HOSTS = Object.freeze({ CHANNEL3: "api.trychannel3.com", TAVILY: "api.tavily.com" });
/** Documented prices after each provider's 1,000 free monthly credits (docs/research/PROVIDER_CONTRACTS.md). */
export const DOCUMENTED_USD_PER_CREDIT = Object.freeze({ CHANNEL3: 0.007, TAVILY: 0.008 });

export type LiveProvider = keyof typeof APPROVED_PROVIDER_HOSTS;
export interface LiveGuardLimits { calls: Record<LiveProvider, number>; credits: Record<LiveProvider, number> }
export interface LiveCallRecord {
  label: string; provider: LiveProvider; path: string; status: number | null; expectedCredits: number; reportedCredits: number | null;
  chargedCredits: number; providerRequestId: string | null; ms: number; note: string | null;
}
export class LiveStop extends Error {}

const STOP_STATUSES = new Set([401, 402, 403, 432, 433]);

function providerOf(raw: string): { provider: LiveProvider; url: URL } {
  let url: URL;
  try { url = new URL(raw); } catch { throw new LiveStop("unparseable URL"); }
  if (url.protocol !== "https:" || url.port !== "" || url.username || url.password) throw new LiveStop(`refused URL form for host ${url.hostname}`);
  for (const [p, h] of Object.entries(APPROVED_PROVIDER_HOSTS) as Array<[LiveProvider, string]>) if (url.hostname === h) return { provider: p, url };
  throw new LiveStop(`host not approved: ${url.hostname}`);
}

function bodyJson(init?: RequestInit): Record<string, unknown> | null {
  if (typeof init?.body !== "string") return null;
  try { const j = JSON.parse(init.body); return j && typeof j === "object" ? j : null; } catch { return null; }
}

/** Credits a call will cost per the documented contract; throws for a call the plan does not allow. */
export function expectedCredits(provider: LiveProvider, url: URL, init?: RequestInit): number {
  if (provider === "CHANNEL3") {
    if (url.pathname === "/v1/search" || url.pathname === "/v1/lookup") return 1;
    if (url.pathname.startsWith("/v1/products/")) return 0;
    throw new LiveStop(`Channel3 path not in plan: ${url.pathname}`);
  }
  if (url.pathname !== "/search") throw new LiveStop(`Tavily path not in plan: ${url.pathname}`);
  const b = bodyJson(init) ?? {};
  if (b.auto_parameters) throw new LiveStop("Tavily auto_parameters is not allowed");
  const depth = b.search_depth ?? "basic";
  if (depth !== "basic") throw new LiveStop(`Tavily search_depth ${String(depth)} is not allowed (basic only)`);
  return 1;
}

export class LiveCallGuard {
  readonly records: LiveCallRecord[] = [];
  readonly calls: Record<LiveProvider, number> = { CHANNEL3: 0, TAVILY: 0 };
  readonly credits: Record<LiveProvider, number> = { CHANNEL3: 0, TAVILY: 0 };
  stopped: string | null = null;
  label = "-";
  #failStreak: Record<LiveProvider, number> = { CHANNEL3: 0, TAVILY: 0 };

  constructor(readonly limits: LiveGuardLimits, private readonly fetchImpl: typeof fetch = fetch, private readonly clock: () => number = () => performance.now()) {}

  #stop(reason: string): never { this.stopped ??= reason; throw new LiveStop(reason); }

  readonly fetch: typeof fetch = async (input, init) => {
    if (this.stopped) throw new LiveStop(this.stopped);
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    let provider: LiveProvider; let url: URL; let expected: number;
    try { ({ provider, url } = providerOf(raw)); expected = expectedCredits(provider, url, init); }
    catch (e) { this.#stop((e as Error).message); }
    if (this.calls[provider] + 1 > this.limits.calls[provider]) this.#stop(`run ${provider} call cap ${this.limits.calls[provider]} reached`);
    if (this.credits[provider] + expected > this.limits.credits[provider]) this.#stop(`run ${provider} credit cap ${this.limits.credits[provider]} reached`);
    this.calls[provider]++;
    const t0 = this.clock();
    let res: Response;
    try { res = await this.fetchImpl(url.href, { ...init, redirect: "manual" }); }
    catch (e) {
      // A network failure may still have been billed: charge the expected credits.
      this.credits[provider] += expected;
      this.records.push({ label: this.label, provider, path: url.pathname, status: null, expectedCredits: expected, reportedCredits: null, chargedCredits: expected, providerRequestId: null, ms: Math.round(this.clock() - t0), note: "network error" });
      if (++this.#failStreak[provider] >= 2) this.#stop(`${provider} network error after retry`);
      throw e;
    }
    let reported: number | null = null; let rid: string | null = null;
    try { const j = await res.clone().json() as { usage?: { credits?: unknown }; request_id?: unknown }; if (typeof j?.usage?.credits === "number") reported = j.usage.credits; if (typeof j?.request_id === "string") rid = j.request_id; } catch { /* non-JSON */ }
    // Charge the larger of reported and expected for successful calls; failed calls are charged as expected (conservative).
    const charged = Math.max(reported ?? 0, expected);
    this.credits[provider] += charged;
    const redirect = res.status >= 300 && res.status < 400 || res.type === "opaqueredirect";
    this.records.push({ label: this.label, provider, path: url.pathname, status: res.status, expectedCredits: expected, reportedCredits: reported, chargedCredits: charged,
      providerRequestId: rid, ms: Math.round(this.clock() - t0), note: redirect ? "redirect refused" : null });
    if (redirect) this.#stop(`${provider} answered with a redirect (HTTP ${res.status}); redirects are not followed`);
    if (STOP_STATUSES.has(res.status)) this.stopped ??= `${provider} HTTP ${res.status}`;
    if (res.status === 429 || res.status >= 500) { if (++this.#failStreak[provider] >= 2) this.stopped ??= `${provider} HTTP ${res.status} after retry`; }
    else this.#failStreak[provider] = 0;
    return res;
  };

  /** Upper-bound cost if no free credits remain (documented prices). */
  costUsdUpperBound(): number {
    return Math.round((this.credits.CHANNEL3 * DOCUMENTED_USD_PER_CREDIT.CHANNEL3 + this.credits.TAVILY * DOCUMENTED_USD_PER_CREDIT.TAVILY) * 10000) / 10000;
  }
}
