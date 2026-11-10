import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { LiveCallGuard, LiveStop, SERVICE_LIVE_CAPS } from "../src/metering/LiveCallGuard.js";

const LIMITS = { calls: { CHANNEL3: 3, TAVILY: 3 }, credits: { CHANNEL3: 2, TAVILY: 3 } };
const json = (status: number, body: unknown = {}, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const fake = (responder: (url: string, init?: RequestInit) => Response) => {
  const seen: Array<{ url: string; redirect: RequestRedirect | undefined }> = [];
  const f: typeof fetch = async (u, init) => { seen.push({ url: String(u), redirect: init?.redirect }); return responder(String(u), init); };
  return { f, seen };
};
const tavilyBody = (extra: object = {}) => ({ method: "POST", body: JSON.stringify({ query: "q", search_depth: "basic", ...extra }) });

describe("LiveCallGuard (bounded live tests only)", () => {
  it("admits only the exact approved hostnames over https on the default port", async () => {
    for (const bad of ["https://api.tavily.com.evil.example/search", "https://evilapi.tavily.com/search", "https://x.api.tavily.com/search", "http://api.tavily.com/search",
      "https://api.tavily.com:8443/search", "https://user:pw@api.tavily.com/search", "https://api.trychannel3.com.attacker.example/v1/search", "https://trychannel3.com/v1/search"]) {
      const { f, seen } = fake(() => json(200));
      const g = new LiveCallGuard(LIMITS, f);
      await expect(g.fetch(bad, tavilyBody())).rejects.toBeInstanceOf(LiveStop);
      expect(seen).toEqual([]); expect(g.stopped).toBeTruthy();
    }
    const { f, seen } = fake(() => json(200, { usage: { credits: 1 }, request_id: "r1" }));
    const g = new LiveCallGuard(LIMITS, f);
    await g.fetch("https://api.tavily.com/search", tavilyBody());
    expect(seen[0]).toEqual({ url: "https://api.tavily.com/search", redirect: "manual" });
    expect(g.records[0]).toMatchObject({ provider: "TAVILY", status: 200, reportedCredits: 1, chargedCredits: 1, providerRequestId: "r1" });
  });
  it("never follows a redirect, still counts the call, and stops the run", async () => {
    const { f, seen } = fake(() => new Response(null, { status: 302, headers: { location: "https://evil.example/collect" } }));
    const g = new LiveCallGuard(LIMITS, f);
    await expect(g.fetch("https://api.trychannel3.com/v1/search", { method: "POST", body: "{}" })).rejects.toBeInstanceOf(LiveStop);
    expect(seen.map((s) => s.url)).toEqual(["https://api.trychannel3.com/v1/search"]);
    expect(g.calls.CHANNEL3).toBe(1); expect(g.credits.CHANNEL3).toBe(1); expect(g.stopped).toMatch(/redirect/);
    await expect(g.fetch("https://api.tavily.com/search", tavilyBody())).rejects.toBeInstanceOf(LiveStop);
    expect(seen.length).toBe(1);
  });
  it("checks call and credit caps before sending; product detail is free but counted as a call", async () => {
    const { f, seen } = fake(() => json(200));
    const g = new LiveCallGuard(LIMITS, f);
    await g.fetch("https://api.trychannel3.com/v1/search", { method: "POST", body: "{}" });
    await g.fetch("https://api.trychannel3.com/v1/products/p1");
    expect(g.credits.CHANNEL3).toBe(1); expect(g.calls.CHANNEL3).toBe(2);
    await g.fetch("https://api.trychannel3.com/v1/search", { method: "POST", body: "{}" });
    await expect(g.fetch("https://api.trychannel3.com/v1/products/p2")).rejects.toThrow(/call cap 3/);
    expect(seen.length).toBe(3);
    const t = new LiveCallGuard({ calls: { CHANNEL3: 9, TAVILY: 9 }, credits: { CHANNEL3: 9, TAVILY: 1 } }, fake(() => json(200, { usage: { credits: 1 } })).f);
    await t.fetch("https://api.tavily.com/search", tavilyBody());
    await expect(t.fetch("https://api.tavily.com/search", tavilyBody())).rejects.toThrow(/credit cap 1/);
  });
  it("refuses advanced depth, auto_parameters and paths outside the plan; charges reported credits when higher", async () => {
    for (const body of [tavilyBody({ search_depth: "advanced" }), tavilyBody({ auto_parameters: true })]) {
      const g = new LiveCallGuard(LIMITS, fake(() => json(200)).f);
      await expect(g.fetch("https://api.tavily.com/search", body)).rejects.toBeInstanceOf(LiveStop);
    }
    await expect(new LiveCallGuard(LIMITS, fake(() => json(200)).f).fetch("https://api.tavily.com/extract", tavilyBody())).rejects.toThrow(/not in plan/);
    const g = new LiveCallGuard(LIMITS, fake(() => json(200, { usage: { credits: 2 } })).f);
    await g.fetch("https://api.tavily.com/search", tavilyBody());
    expect(g.credits.TAVILY).toBe(2); expect(g.costUsdUpperBound()).toBe(0.016);
  });
  it("stops on auth or credit errors, and on a 429 that survives one retry", async () => {
    for (const status of [401, 403, 402, 432, 433]) {
      const g = new LiveCallGuard(LIMITS, fake(() => json(status)).f);
      expect((await g.fetch("https://api.tavily.com/search", tavilyBody())).status).toBe(status);
      expect(g.stopped).toContain(String(status));
      await expect(g.fetch("https://api.tavily.com/search", tavilyBody())).rejects.toBeInstanceOf(LiveStop);
    }
    const g = new LiveCallGuard(LIMITS, fake(() => json(429)).f);
    await g.fetch("https://api.tavily.com/search", tavilyBody()); expect(g.stopped).toBeNull();
    await g.fetch("https://api.tavily.com/search", tavilyBody()); expect(g.stopped).toMatch(/429 after retry/);
  });
  it("the service per-request caps stay Channel3 1, Tavily 2, KERNEL 1 and main.ts uses them; the live-test allowance is separate", () => {
    expect(SERVICE_LIVE_CAPS).toEqual({ CHANNEL3: 1, TAVILY: 2, KERNEL: 1 });
    expect(readFileSync("src/main.ts", "utf8")).toMatch(/perRequestCalls: \{ \.\.\.SERVICE_LIVE_CAPS \}/);
    const script = readFileSync("scripts/live-research-v2.ts", "utf8");
    expect(script).toMatch(/LTP_V2_01_PER_REQUEST_ALLOWANCE = Object\.freeze\(\{ CHANNEL3: 3, TAVILY: 6, KERNEL: 0 \}\)/);
    expect(script).not.toMatch(/SERVICE_LIVE_CAPS\s*=/);
  });
});
