/**
 * PREPARED, NOT RUN. Bounded live evaluation of Research V2 on real providers (Channel3 + Tavily only).
 * No checkout, no PayPal, no KERNEL. Runs ONLY with the owner-approved plan id in docs/research/LIVE_TEST_PLAN.md:
 *   node --env-file=<env with CHANNEL3_API_KEY TAVILY_API_KEY> --import tsx scripts/live-research-v2.ts --confirm-live --plan LTP-V2-01
 * Hard limits (also in the plan): 10 fixed requests; two arms: A = service caps 1/2, B = test allowance 3/6; run totals Channel3 ≤ 40,
 * Tavily ≤ 80 HTTP calls and credits. Tavily depth is always basic (1 credit). Every limit fails closed. Host, redirect, cap and stop rules: src/metering/LiveCallGuard.ts.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createApp } from "../src/http/server.js";
import { DevAuth } from "../src/auth/devAuth.js";
import { Store } from "../src/store/Database.js";
import { UsageLedger, LIVE_PRICES_UNKNOWN } from "../src/metering/UsageLedger.js";
import { EvidenceRouter } from "../src/evidence/EvidenceRouter.js";
import { TavilySearch } from "../src/evidence/providers.js";
import { Channel3ResearchAdapter } from "../src/research/Channel3ResearchAdapter.js";
import { LiveCallGuard, LiveStop, SERVICE_LIVE_CAPS, SERVICE_LIVE_RETRY } from "../src/metering/LiveCallGuard.js";

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
/**
 * LIVE-TEST ALLOWANCE for plan LTP-V2-01 only. This is NOT the service cap: the service keeps SERVICE_LIVE_CAPS
 * (Channel3 1, Tavily 2, KERNEL 1 per request, src/metering/LiveCallGuard.ts, used by main.ts) and this script never changes it.
 */
export const LTP_V2_01_PER_REQUEST_ALLOWANCE = Object.freeze({ CHANNEL3: 3, TAVILY: 6, KERNEL: 0 });
/** Run totals: HTTP calls (retries and refused redirects included) and credits (charged = max(reported, documented)). */
export const LTP_V2_01_RUN_LIMITS = Object.freeze({ calls: { CHANNEL3: 40, TAVILY: 80 }, credits: { CHANNEL3: 40, TAVILY: 80 } });
/**
 * Two arms over the same 10 requests (review R-05), each with its own empty store (no cache shared between arms):
 *   A "service-caps": exactly what main.ts runs (per request Channel3 1, Tavily 2; one HTTP attempt per call).
 *   B "ltp-allowance": the test allowance (3 / 6; one bounded retry), to see what larger caps would buy.
 * Arm A runs first. Worst case: A 10 + 20, B 30 + 60 → Channel3 40, Tavily 80 HTTP calls/credits.
 */
export const LTP_V2_01_ARMS = Object.freeze([
  { arm: "A-service-caps", perRequest: { CHANNEL3: SERVICE_LIVE_CAPS.CHANNEL3, TAVILY: SERVICE_LIVE_CAPS.TAVILY, KERNEL: 0 }, retry: { ...SERVICE_LIVE_RETRY } },
  { arm: "B-ltp-allowance", perRequest: { ...LTP_V2_01_PER_REQUEST_ALLOWANCE }, retry: { attempts: 2, baseDelayMs: 500, maxRetryAfterMs: 3000 } },
] as const);

if (!process.argv.includes("--confirm-live") || process.argv[process.argv.indexOf("--plan") + 1] !== PLAN_ID) {
  console.error(`Refusing: needs --confirm-live --plan ${PLAN_ID} (owner-approved plan, docs/research/LIVE_TEST_PLAN.md)`); process.exit(2);
}
const env = process.env;
if (!env.CHANNEL3_API_KEY || !env.TAVILY_API_KEY) { console.error("CHANNEL3_API_KEY and TAVILY_API_KEY are both required: stopping (no fixture substitution)."); process.exit(3); }

const guard = new LiveCallGuard({ calls: { ...LTP_V2_01_RUN_LIMITS.calls }, credits: { ...LTP_V2_01_RUN_LIMITS.credits } });
const liveFetch = guard.fetch;

const startedAt = new Date().toISOString();
const results: unknown[] = [];
for (const arm of LTP_V2_01_ARMS) {
  const store = new Store(":memory:");
  const ledger = new UsageLedger(store, LIVE_PRICES_UNKNOWN, { perRequestSupplierMicro: 0, monthlyBillableMinor: 0, perRequestCalls: { ...arm.perRequest } });
  const channel3 = new Channel3ResearchAdapter(env.CHANNEL3_API_KEY, { limit: 10, fetchImpl: liveFetch, retry: { ...arm.retry } });
  const tavily = new TavilySearch(env.TAVILY_API_KEY, "community", liveFetch, { ...arm.retry });
  const router = new EvidenceRouter(store, ledger, tavily, null, { billable: false, policy: "v2" });
  const app = createApp({ host: "127.0.0.1", port: 0, baseUrl: "http://127.0.0.1:0", authMode: "dev", dbPath: ":memory:", auth: new DevAuth(), research: channel3,
    service: { mode: "community", ledger, router, billing: null } });
  for (const r of LIVE_REQUESTS) {
    if (guard.stopped) { results.push({ arm: arm.arm, id: r.id, request: r.request, status: "NOT_RUN", reason: guard.stopped }); continue; }
    guard.label = `${arm.arm}/${r.id}`; const t0 = performance.now();
    try {
      const out: any = await app.gateway.researchPurchase("live-v2", { request: r.request });
      results.push({ arm: arm.arm, id: r.id, request: r.request, purpose: r.purpose, status: "RAN", ms: Math.round(performance.now() - t0),
        decision: out.decision, identity: out.identity, trace: out.researchTrace,
        candidates: (out.candidates ?? []).map((c: any) => ({ productId: c.productId, title: c.title, identity: c.identity, listingPrice: c.listingPrice, eligibility: c.eligibility,
          evidence: (c.evidence ?? []).map((e: any) => ({ capability: e.capability, status: e.status, basis: e.basis,
            items: (e.items ?? []).map((i: any) => ({ url: i.url, sourceClass: i.sourceClass, value: i.value, counts: i.counts, whyNotCounted: i.whyNotCounted, quote: String(i.quote ?? "").slice(0, 300), publishedDate: i.publishedDate })) })) })),
        unknowns: out.unknowns, usage: out.usage });
    } catch (e) {
      results.push({ arm: arm.arm, id: r.id, request: r.request, status: e instanceof LiveStop || guard.stopped ? "STOPPED" : "ERROR", error: String((e as Error).message).slice(0, 300) });
      guard.stopped ??= `unexpected error in ${arm.arm}/${r.id}`;
    }
  }
  app.store.close(); store.close();
}
const evidence = { kind: "LIVE_RESEARCH_V2", plan: PLAN_ID, startedAt, finishedAt: new Date().toISOString(),
  serviceCapsUnchanged: SERVICE_LIVE_CAPS, arms: LTP_V2_01_ARMS, runLimits: LTP_V2_01_RUN_LIMITS,
  httpCalls: guard.calls, creditsCharged: guard.credits, costUsdUpperBound: guard.costUsdUpperBound(),
  costNote: "Upper bound at documented prices if no free monthly credits remain; actual cost is $0 while free credits last.",
  stopped: guard.stopped, calls: guard.records, results };
mkdirSync("docs/evidence", { recursive: true });
const file = `docs/evidence/live-research-v2-${startedAt.slice(0, 19).replace(/[:T]/g, "-")}.json`;
writeFileSync(file, JSON.stringify(evidence, null, 2) + "\n");
console.log(JSON.stringify({ file, httpCalls: guard.calls, creditsCharged: guard.credits, costUsdUpperBound: evidence.costUsdUpperBound, stopped: guard.stopped }, null, 1));
