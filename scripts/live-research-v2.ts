/**
 * PREPARED, NOT RUN. Bounded live evaluation of Research V2 on real providers (Channel3 + Tavily only).
 * No checkout, no PayPal, no KERNEL. Runs ONLY with the owner-approved plan id in docs/research/LIVE_TEST_PLAN.md:
 *   node --env-file=<env with CHANNEL3_API_KEY TAVILY_API_KEY> --import tsx scripts/live-research-v2.ts --confirm-live --plan LTP-V2-01
 * Hard limits (also in the plan): 10 fixed requests; per request Channel3 ≤ 3 HTTP calls, Tavily ≤ 6; whole run Channel3 ≤ 30,
 * Tavily ≤ 60 HTTP calls. Tavily depth is always basic (1 credit). Every limit fails closed. Stopping conditions are in STOP below.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createApp } from "../src/http/server.js";
import { DevAuth } from "../src/auth/devAuth.js";
import { Store } from "../src/store/Database.js";
import { UsageLedger, LIVE_PRICES_UNKNOWN } from "../src/metering/UsageLedger.js";
import { EvidenceRouter } from "../src/evidence/EvidenceRouter.js";
import { TavilySearch } from "../src/evidence/providers.js";
import { Channel3ResearchAdapter } from "../src/research/Channel3ResearchAdapter.js";

export const PLAN_ID = "LTP-V2-01";
export const LIVE_REQUESTS: Array<{ id: string; request: string; purpose: string }> = [
  { id: "L01", request: "Buy Sony WH-CH720N Black", purpose: "replay of the 2026-11-09 smoke: no color-unknown or bundle lock" },
  { id: "L02", request: "Buy Sony WH-CH720N", purpose: "exact lock with unstated variant; ANC/multipoint evidence" },
  { id: "L03", request: "Noise cancelling headphones with multipoint under $150", purpose: "discovery, two must-haves, budget" },
  { id: "L04", request: "Buy Apple AirPods Pro 2 with USB-C case", purpose: "variant/generation trap (Lightning vs USB-C, Pro vs non-Pro)" },
  { id: "L05", request: "Buy a renewed Apple iPhone 13 128GB", purpose: "condition: never mix renewed and new" },
  { id: "L06", request: "Waterproof hiking boots size 10 under $200", purpose: "non-electronics, size attribute, waterproof evidence" },
  { id: "L07", request: "Cheapest programmable coffee maker with thermal carafe", purpose: "lowest-price objective; never 'verified cheapest'" },
  { id: "L08", request: "4K monitor with USB-C charging under $400", purpose: "monitors, two capabilities" },
  { id: "L09", request: "노이즈 캔슬링 헤드폰 30만원 이하", purpose: "Korean + KRW (Channel3 has no KRW: expect a currency blocker, not a guess)" },
  { id: "L10", request: "Cordless vacuum with HEPA filter under $300", purpose: "vacuums, accessory traps" },
];
const PER_REQUEST = { CHANNEL3: 3, TAVILY: 6, KERNEL: 0 };
const TOTAL = { CHANNEL3: 30, TAVILY: 60 };

if (!process.argv.includes("--confirm-live") || process.argv[process.argv.indexOf("--plan") + 1] !== PLAN_ID) {
  console.error(`Refusing: needs --confirm-live --plan ${PLAN_ID} (owner-approved plan, docs/research/LIVE_TEST_PLAN.md)`); process.exit(2);
}
const env = process.env;
if (!env.CHANNEL3_API_KEY || !env.TAVILY_API_KEY) { console.error("CHANNEL3_API_KEY and TAVILY_API_KEY are both required: stopping (no fixture substitution)."); process.exit(3); }

class Stop extends Error {}
const calls: Array<{ requestId: string; provider: string; path: string; status: number | null; credits: number | null; providerRequestId: string | null; ms: number }> = [];
let current = "-"; let stopped: string | null = null;
const count = { CHANNEL3: 0, TAVILY: 0 };
const liveFetch: typeof fetch = async (u, init) => {
  const url = new URL(String(u));
  const provider = url.host === "api.trychannel3.com" || url.host.endsWith("trychannel3.com") ? "CHANNEL3" : url.host === "api.tavily.com" ? "TAVILY" : null;
  if (!provider) { stopped = `unexpected host ${url.host}`; throw new Stop(stopped); }
  if (stopped) throw new Stop(stopped);
  if (count[provider] >= TOTAL[provider]) { stopped = `total ${provider} cap ${TOTAL[provider]} reached`; throw new Stop(stopped); }
  count[provider]++;
  const t0 = performance.now();
  const res = await fetch(u, init);
  let credits: number | null = null; let rid: string | null = null;
  try { const j = await res.clone().json() as any; credits = j?.usage?.credits ?? null; rid = j?.request_id ?? null; } catch { /* non-JSON */ }
  calls.push({ requestId: current, provider, path: url.pathname, status: res.status, credits, providerRequestId: rid, ms: Math.round(performance.now() - t0) });
  // STOP: auth failure, credit/plan exhaustion, or a 429 that survived the adapter's single bounded retry.
  if ([401, 403, 402, 432, 433].includes(res.status)) stopped = `${provider} HTTP ${res.status}`;
  return res;
};

const store = new Store(":memory:");
const ledger = new UsageLedger(store, LIVE_PRICES_UNKNOWN, { perRequestSupplierMicro: 0, monthlyBillableMinor: 0, perRequestCalls: PER_REQUEST });
const channel3 = new Channel3ResearchAdapter(env.CHANNEL3_API_KEY, { limit: 10, fetchImpl: liveFetch, retry: { attempts: 2, baseDelayMs: 500, maxRetryAfterMs: 3000 } });
const tavily = new TavilySearch(env.TAVILY_API_KEY, "community", liveFetch, { attempts: 2, baseDelayMs: 500, maxRetryAfterMs: 3000 });
const router = new EvidenceRouter(store, ledger, tavily, null, { billable: false, policy: "v2" });
const auth = new DevAuth();
const app = createApp({ host: "127.0.0.1", port: 0, baseUrl: "http://127.0.0.1:0", authMode: "dev", dbPath: ":memory:", auth, research: channel3,
  service: { mode: "community", ledger, router, billing: null } });

const startedAt = new Date().toISOString();
const results: unknown[] = [];
for (const r of LIVE_REQUESTS) {
  if (stopped) { results.push({ id: r.id, request: r.request, status: "NOT_RUN", reason: stopped }); continue; }
  current = r.id; const t0 = performance.now();
  try {
    const out: any = await app.gateway.researchPurchase("live-v2", { request: r.request });
    results.push({ id: r.id, request: r.request, purpose: r.purpose, status: "RAN", ms: Math.round(performance.now() - t0),
      decision: out.decision, identity: out.identity, trace: out.researchTrace,
      candidates: (out.candidates ?? []).map((c: any) => ({ productId: c.productId, title: c.title, identity: c.identity, listingPrice: c.listingPrice, eligibility: c.eligibility,
        evidence: (c.evidence ?? []).map((e: any) => ({ capability: e.capability, status: e.status, basis: e.basis,
          items: (e.items ?? []).map((i: any) => ({ url: i.url, sourceClass: i.sourceClass, value: i.value, counts: i.counts, whyNotCounted: i.whyNotCounted, quote: String(i.quote ?? "").slice(0, 300), publishedDate: i.publishedDate })) })) })),
      unknowns: out.unknowns, usage: out.usage });
  } catch (e) {
    results.push({ id: r.id, request: r.request, status: e instanceof Stop ? "STOPPED" : "ERROR", error: String((e as Error).message).slice(0, 300) });
    if (!(e instanceof Stop)) stopped = stopped ?? `unexpected error in ${r.id}`;
  }
}
const evidence = { kind: "LIVE_RESEARCH_V2", plan: PLAN_ID, startedAt, finishedAt: new Date().toISOString(), perRequestCaps: PER_REQUEST, totalCaps: TOTAL,
  httpCalls: count, creditsReported: calls.reduce((a, c) => a + (c.credits ?? 0), 0), stopped, calls, results };
mkdirSync("docs/evidence", { recursive: true });
const file = `docs/evidence/live-research-v2-${startedAt.slice(0, 19).replace(/[:T]/g, "-")}.json`;
writeFileSync(file, JSON.stringify(evidence, null, 2) + "\n");
console.log(JSON.stringify({ file, httpCalls: count, creditsReported: evidence.creditsReported, stopped }, null, 1));
