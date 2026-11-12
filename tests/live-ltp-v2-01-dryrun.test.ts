/**
 * V2.1 Phase 5: LTP-V2-01 readiness, exercised OFFLINE on the fake provider world (no network; the fake fetch throws on
 * any other host). Proves arm isolation, per-arm accounting, run-total limits and the fail-closed preflight. It does not
 * run, and cannot authorize, the live plan.
 */
import { describe, expect, it } from "vitest";
import { preflight, runLtpV2_01, LTP_V2_01_RUN_LIMITS } from "../scripts/live-research-v2.js";
import { LiveCallGuard, PROVIDER_CONTRACTS_READ_AT } from "../src/metering/LiveCallGuard.js";
import { newCounters, worldFetch } from "../scripts/research-eval-v2/world.js";

const NOW = Date.parse("2026-11-11T00:00:00Z");
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("LTP-V2-01 dry run on fake providers", () => {
  it("runs both arms with separate stores and reports calls and credits per arm within the run limits", async () => {
    const c = newCounters();
    const ev: any = await runLtpV2_01({ channel3Key: "ch3-DRYRUN-FAKE-0000", tavilyKey: "tvly-DRYRUN-FAKE-0000", fetchImpl: worldFetch(c), now: () => NOW });
    expect(ev.armIsolation).toEqual(["A-service-caps:evidence_items_at_start=0", "B-ltp-allowance:evidence_items_at_start=0"]);
    const arms = Object.keys(ev.perArm);
    expect(arms).toEqual(expect.arrayContaining(["A-service-caps", "B-ltp-allowance"]));
    const sum = (p: "CHANNEL3" | "TAVILY") => arms.reduce((a, k) => a + ev.perArm[k].calls[p], 0);
    expect(sum("CHANNEL3")).toBe(ev.httpCalls.CHANNEL3);
    expect(sum("TAVILY")).toBe(ev.httpCalls.TAVILY);
    // Every HTTP call the fake world saw went through the guard (nothing bypassed the accounting).
    expect(c.requests.length).toBe(ev.httpCalls.CHANNEL3 + ev.httpCalls.TAVILY);
    expect(ev.perArm["A-service-caps"].calls.CHANNEL3).toBeLessThanOrEqual(10);
    expect(ev.perArm["A-service-caps"].calls.TAVILY).toBeLessThanOrEqual(20);
    expect(ev.httpCalls.CHANNEL3).toBeLessThanOrEqual(LTP_V2_01_RUN_LIMITS.calls.CHANNEL3);
    expect(ev.httpCalls.TAVILY).toBeLessThanOrEqual(LTP_V2_01_RUN_LIMITS.calls.TAVILY);
    expect(ev.costUsdUpperBound).toBeLessThanOrEqual(0.92);
    // Korean + KRW: the request runs, but no KRW/KR locale is ever sent to Channel3.
    expect(c.requests.some((r: any) => /"(?:KRW|KR)"/.test(JSON.stringify(r.body ?? {})) || /currency=KRW|country=KR\b/.test(r.url))).toBe(false);
  }, 120_000);

  it("refuses before any call when the provider contracts are older than 14 days", async () => {
    expect(preflight(Date.parse(PROVIDER_CONTRACTS_READ_AT) + 86400_000)).toBeNull();
    const late = Date.parse(PROVIDER_CONTRACTS_READ_AT) + 15 * 86400_000;
    expect(preflight(late)).toMatch(/re-read the official docs/);
    const c = newCounters();
    await expect(runLtpV2_01({ channel3Key: "k", tavilyKey: "k", fetchImpl: worldFetch(c), now: () => late })).rejects.toThrow(/Refusing/);
    expect(c.requests).toEqual([]);
  });
});

describe("guard: uncertain cost, unexpected billing, unsupported locale, unexpected shape (V2.1)", () => {
  const LIMITS = { calls: { CHANNEL3: 5, TAVILY: 5 }, credits: { CHANNEL3: 5, TAVILY: 5 } };
  const tav = { method: "POST", body: JSON.stringify({ query: "q", search_depth: "basic" }) };
  it("a Tavily success without usage.credits stops the run (cost uncertain)", async () => {
    const g = new LiveCallGuard(LIMITS, (async () => json(200, { results: [] })) as typeof fetch);
    await expect(g.fetch("https://api.tavily.com/search", tav)).rejects.toThrow(/cost uncertain/);
    await expect(g.fetch("https://api.tavily.com/search", tav)).rejects.toThrow();
  });
  it("Channel3 KRW or KR is refused before sending", async () => {
    let sent = 0;
    const f = (async () => { sent++; return json(200, { products: [] }); }) as typeof fetch;
    for (const cfg of [{ currency: "KRW" }, { country: "KR" }]) {
      const g = new LiveCallGuard(LIMITS, f);
      await expect(g.fetch("https://api.trychannel3.com/v1/search", { method: "POST", body: JSON.stringify({ query: "x", config: cfg }) })).rejects.toThrow(/not documented/);
    }
    await expect(new LiveCallGuard(LIMITS, f).fetch("https://api.trychannel3.com/v1/products/p?currency=KRW")).rejects.toThrow(/not documented/);
    expect(sent).toBe(0);
  });
  it("an unexpected success shape stops the run", async () => {
    const g = new LiveCallGuard(LIMITS, (async () => json(200, { items: [] })) as typeof fetch);
    await expect(g.fetch("https://api.trychannel3.com/v1/search", { method: "POST", body: JSON.stringify({ query: "x" }) })).rejects.toThrow(/unexpected response shape/);
    expect(g.calls.CHANNEL3).toBe(1);
  });
});
