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
 *  - stop on auth/credit/plan errors, and on a 429/5xx that survives one retry;
 *  - (V2.1) uncertain or unexpected cost stops the run: a provider reporting MORE credits than the contract says, or a
 *    successful Tavily response without usage.credits (include_usage is always sent);
 *  - (V2.1) unsupported locale stops the run before the call: a Channel3 config.currency / config.country outside the
 *    documented sets (no KRW, no KR);
 *  - (V2.1) an unexpected successful response shape stops the run (Channel3 search without products[], Tavily without results[]);
 *  - (V2.1) accounting per arm: `label` is "<arm>/<request>", and byArm() reports calls and credits for each arm.
 * Logs contain provider, path, status, credits and provider request id only: never headers, keys or bodies.
 */
export const SERVICE_LIVE_CAPS = Object.freeze({ CHANNEL3: 1, TAVILY: 2, KERNEL: 1 });
/** Service adapters make exactly one HTTP attempt per metered call, so ledger counts equal HTTP counts (review R-08). */
export const SERVICE_LIVE_RETRY = Object.freeze({ attempts: 1, baseDelayMs: 0, maxRetryAfterMs: 0 });
export const APPROVED_PROVIDER_HOSTS = Object.freeze({ CHANNEL3: "api.trychannel3.com", TAVILY: "api.tavily.com" });
/** Documented prices after each provider's 1,000 free monthly credits (docs/research/PROVIDER_CONTRACTS.md). */
export const DOCUMENTED_USD_PER_CREDIT = Object.freeze({ CHANNEL3: 0.007, TAVILY: 0.008 });

/** Documented Channel3 locales (docs/research/PROVIDER_CONTRACTS.md, read 2026-11-10). */
export const CHANNEL3_DOCUMENTED = Object.freeze({
  currencies: ["USD", "CAD", "AUD", "GBP", "EUR", "SEK", "CZK", "RON", "CHF", "PLN"],
  countries: ["US", "GB", "EU", "AU", "CA", "IE", "DE", "AT", "FR", "BE", "IT", "ES", "NL", "SE", "FI", "PT", "CZ", "GR", "RO", "CH", "PL"],
});
/** Date the provider contracts were last read from the official docs. The live script refuses if this is older than 14 days. */
export const PROVIDER_CONTRACTS_READ_AT = "2026-11-10";
export const CONTRACTS_MAX_AGE_DAYS = 14;

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
    const cfg = (bodyJson(init)?.config ?? {}) as { currency?: unknown; country?: unknown };
    if (cfg.currency !== undefined && !CHANNEL3_DOCUMENTED.currencies.includes(String(cfg.currency))) throw new LiveStop(`Channel3 currency ${String(cfg.currency)} is not documented`);
    if (cfg.country !== undefined && !CHANNEL3_DOCUMENTED.countries.includes(String(cfg.country))) throw new LiveStop(`Channel3 country ${String(cfg.country)} is not documented`);
    const q = url.searchParams;
    if (q.has("currency") && !CHANNEL3_DOCUMENTED.currencies.includes(q.get("currency")!)) throw new LiveStop(`Channel3 currency ${q.get("currency")} is not documented`);
    if (q.has("country") && !CHANNEL3_DOCUMENTED.countries.includes(q.get("country")!)) throw new LiveStop(`Channel3 country ${q.get("country")} is not documented`);
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
    let reported: number | null = null; let rid: string | null = null; let json: any = undefined;
    try { json = await res.clone().json(); if (typeof json?.usage?.credits === "number") reported = json.usage.credits; if (typeof json?.request_id === "string") rid = json.request_id; } catch { /* non-JSON */ }
    // Charge the larger of reported and expected for successful calls; failed calls are charged as expected (conservative).
    const charged = Math.max(reported ?? 0, expected);
    this.credits[provider] += charged;
    const redirect = res.status >= 300 && res.status < 400 || res.type === "opaqueredirect";
    this.records.push({ label: this.label, provider, path: url.pathname, status: res.status, expectedCredits: expected, reportedCredits: reported, chargedCredits: charged,
      providerRequestId: rid, ms: Math.round(this.clock() - t0), note: redirect ? "redirect refused" : null });
    if (redirect) this.#stop(`${provider} answered with a redirect (HTTP ${res.status}); redirects are not followed`);
    if (reported !== null && reported > expected) this.#stop(`${provider} reported ${reported} credits for a call the contract prices at ${expected}: unexpected billing`);
    if (res.ok) {
      if (provider === "TAVILY" && reported === null) this.#stop("Tavily response has no usage.credits: cost uncertain");
      const shapeOk = provider === "TAVILY" ? Array.isArray(json?.results)
        : url.pathname === "/v1/search" ? Array.isArray(json?.products) : url.pathname === "/v1/lookup" ? !!json?.product && typeof json.product === "object" : !!json && typeof json === "object";
      if (!shapeOk) this.#stop(`${provider} ${url.pathname} returned an unexpected response shape`);
    }
    if (STOP_STATUSES.has(res.status)) this.stopped ??= `${provider} HTTP ${res.status}`;
    if (res.status === 429 || res.status >= 500) { if (++this.#failStreak[provider] >= 2) this.stopped ??= `${provider} HTTP ${res.status} after retry`; }
    else this.#failStreak[provider] = 0;
    return res;
  };

  /** Calls and charged credits per arm (label prefix before "/"), so arms are reported separately. */
  byArm(): Record<string, { calls: Record<LiveProvider, number>; credits: Record<LiveProvider, number> }> {
    const out: Record<string, { calls: Record<LiveProvider, number>; credits: Record<LiveProvider, number> }> = {};
    for (const r of this.records) {
      const arm = r.label.split("/")[0] ?? "-";
      const a = out[arm] ??= { calls: { CHANNEL3: 0, TAVILY: 0 }, credits: { CHANNEL3: 0, TAVILY: 0 } };
      a.calls[r.provider]++; a.credits[r.provider] += r.chargedCredits;
    }
    return out;
  }

  /** Upper-bound cost if no free credits remain (documented prices). */
  costUsdUpperBound(): number {
    return Math.round((this.credits.CHANNEL3 * DOCUMENTED_USD_PER_CREDIT.CHANNEL3 + this.credits.TAVILY * DOCUMENTED_USD_PER_CREDIT.TAVILY) * 10000) / 10000;
  }
}
