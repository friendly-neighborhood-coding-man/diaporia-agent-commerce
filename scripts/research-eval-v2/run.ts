/**
 * Research Evaluation v2 harness. Runs the SAME frozen cases against any checkout of this repository (`root`), so V1
 * (the baseline commit) and V2 are compared on identical inputs, identical fake provider endpoints and identical caps.
 * Only public behaviour is used: createApp → gateway.researchPurchase / compareOffers. No network: the fake fetch throws
 * on any host other than the two fake provider APIs.
 *
 * V1 has no decision states. Its output is mapped to the decision a host would present (stated, not tuned):
 *   exact mode: identity LOCKED → RECOMMEND the locked product; otherwise HOLD.
 *   discovery:  no candidates → HOLD; first candidate SUITABLE → RECOMMEND it; NEEDS_VERIFICATION → INVESTIGATE; NOT_SUITABLE → HOLD.
 * V2 reports `decision.state` itself and is read as reported.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DEV_CASES, type EvalCaseV2, type State } from "./cases.js";
import { HOLDOUT_CASES } from "./holdout.js";
import { WORLD, WORLD_SOURCES, newCounters, quoteRuleFor, worldFetch, worldProduct, type WorldCounters } from "./world.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const CHANNEL3_USD_PER_CREDIT = 0.007; // docs/research/PROVIDER_CONTRACTS.md (after the monthly free tier)
export const TAVILY_USD_PER_CREDIT = 0.008; // pay-as-you-go, same source

export function verifyHoldoutFreeze(): { sha256: string; frozen: string } {
  const sha256 = createHash("sha256").update(readFileSync(join(HERE, "holdout.ts"))).digest("hex");
  const frozen = JSON.parse(readFileSync(join(HERE, "HOLDOUT_FREEZE.json"), "utf8")).sha256 as string;
  if (sha256 !== frozen) throw new Error(`holdout.ts changed after freezing (sha256 ${sha256} != frozen ${frozen}); add new cases in a new file instead`);
  return { sha256, frozen };
}

export interface CaseOutcome {
  id: string; split: string; tags: string[]; lang: string;
  state: State; expectedStates: State[]; stateOk: boolean;
  recommendedGroup: string | null; topGroups: string[]; lockedGroup: string | null;
  recallAt10: number | null; ndcgAt5: number | null;
  unsafeForbidden: boolean; unsafeShouldNotRecommend: boolean; topOk: boolean | null;
  lockOk: boolean | null; falseLock: boolean; wrongVariantLock: boolean;
  lowestVerified?: { expected: string | null; observed: string | null; falseCheapest: boolean };
  attribution: { cited: number; strong: number };
  calls: { channel3Search: number; channel3Detail: number; channel3Lookup: number; tavily: number; channel3Credits: number; tavilyCredits: number; usd: number };
  latencyMs: number; error?: string;
}

const groupOf = (productId: string | null | undefined): string | null => {
  if (!productId) return null;
  const id = productId.replace(/^ch3:/, "").split("+")[0]!;
  return worldProduct(id)?.truth.group ?? `unknown:${id}`;
};
const BRAND_DOMAINS = new Set(WORLD.map((p) => p.brand).filter((b): b is string => !!b).map((b) => `${b.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "")}.example`)
  .concat(WORLD.map((p) => p.brand).filter((b): b is string => !!b).map((b) => `${b.toLowerCase().replace(/[^a-z0-9]+/g, "")}.example`)));
const strongSource = (url: string): boolean => {
  try { const h = new URL(url).hostname.replace(/^www\./, ""); return BRAND_DOMAINS.has(h) || WORLD_SOURCES.expertReview.includes(h); } catch { return false; }
};

function dcg(groups: string[], rel: Record<string, number>, k: number): number {
  const seen = new Set<string>(); let s = 0; let i = 0;
  for (const g of groups) { if (i >= k) break; const r = seen.has(g) ? 0 : rel[g] ?? 0; seen.add(g); s += (2 ** r - 1) / Math.log2(i + 2); i++; }
  return s;
}

/** The decision a host would act on, from either version's output (see header). */
function readDecision(out: any): { state: State; recommendedPid: string | null; orderPids: string[]; lockedPid: string | null; citedUrls: string[] } {
  const lockedPid = out.identity?.status === "LOCKED" ? (out.identity.productId ?? out.candidates?.[0]?.productId ?? null) : null;
  if (out.decision?.state) {
    const d = out.decision;
    const cited: string[] = (d.recommendation?.verifiedFacts ?? []).flatMap((f: any) => (f.sources ?? []).map((s: any) => s.url));
    return { state: d.state, recommendedPid: d.state === "RECOMMEND" ? d.recommendation?.productId ?? null : null,
      orderPids: (d.ranking ?? []).map((r: any) => r.productId), lockedPid, citedUrls: cited };
  }
  const cands: any[] = out.candidates ?? [];
  const order = cands.map((c) => c.productId);
  const citedOf = (c: any) => [...(c?.mustHave ?? []).map((m: any) => m.evidence?.url).filter(Boolean),
    ...(c?.evidenceRouting ?? []).flatMap((r: any) => (r.claims ?? []).filter((x: any) => x.value).map((x: any) => x.url))];
  if (out.mode === "EXACT_PRODUCT_PURCHASE") return lockedPid ? { state: "RECOMMEND", recommendedPid: lockedPid, orderPids: order, lockedPid, citedUrls: citedOf(cands[0]) }
    : { state: "HOLD", recommendedPid: null, orderPids: order, lockedPid: null, citedUrls: [] };
  if (!cands.length || out.state === "HOLD") return { state: "HOLD", recommendedPid: null, orderPids: order, lockedPid, citedUrls: [] };
  const top = cands[0];
  const state: State = top.suitability === "SUITABLE" ? "RECOMMEND" : top.suitability === "NEEDS_VERIFICATION" ? "INVESTIGATE" : "HOLD";
  return { state, recommendedPid: state === "RECOMMEND" ? top.productId : null, orderPids: order, lockedPid, citedUrls: state === "RECOMMEND" ? citedOf(top) : [] };
}

async function load(root: string) {
  const imp = (p: string) => import(pathToFileURL(join(root, p)).href);
  const [server, devAuth, ch3, er, ul, db, mi] = await Promise.all([imp("src/http/server.ts"), imp("src/auth/devAuth.ts"), imp("src/research/Channel3ResearchAdapter.ts"),
    imp("src/evidence/EvidenceRouter.ts"), imp("src/metering/UsageLedger.ts"), imp("src/store/Database.ts"), imp("src/merchant-identity/fixtures.ts")]);
  const prov = await imp("src/evidence/providers.ts");
  return { createApp: server.createApp, DevAuth: devAuth.DevAuth, Channel3ResearchAdapter: ch3.Channel3ResearchAdapter, EvidenceRouter: er.EvidenceRouter,
    UsageLedger: ul.UsageLedger, PLACEHOLDER_PRICING: ul.PLACEHOLDER_PRICING, Store: db.Store, MERCHANT_CLAIMS: mi.MERCHANT_CLAIMS, TavilySearch: prov.TavilySearch };
}

/**
 * Eval quote source: wraps the system's own Channel3 adapter (search/detail/offers unchanged) and adds the world's
 * merchant quotes and merchant identity claims, which Channel3 does not provide. Merchant ids follow the fixture
 * convention (mer_<first label>) so the mock identity registry can bind them. Identical for V1 and V2.
 */
function worldAdapter(inner: any, claims: Record<string, unknown>, now: () => number) {
  const listingByOffer = new Map<string, string | null>();
  const a: any = {
    name: "eval-world-v2", isMock: true,
    searchProducts: (q: any) => inner.searchProducts(q),
    getProduct: (id: string) => inner.getProduct(id),
    async findOffers(identity: any) {
      const offers = await inner.findOffers(identity);
      return offers.map((o: any) => { listingByOffer.set(o.offerId, o.listingUrl);
        return { ...o, merchantId: `mer_${o.merchantDomain.split(".")[0].replace(/-/g, "_")}`, identityClaim: structuredClone(claims[o.merchantDomain] ?? null) }; });
    },
    async getQuote(offerId: string, quantity: number, destination: any) {
      const rule = quoteRuleFor(listingByOffer.get(offerId) ?? null);
      if (!rule) return null;
      const m = /\/p\/([a-z0-9_]+)$/.exec(listingByOffer.get(offerId) ?? "");
      const wo = WORLD.find((p) => p.id === m?.[1])?.offers.find((x) => listingByOffer.get(offerId)?.includes(`//${x.domain}/`));
      if (!wo || wo.availability === "OutOfStock") return null;
      const item = Math.round(wo.price * 100) * quantity; const at = now() - (rule.ageSeconds ?? 60) * 1000;
      return { quoteId: "qt_" + createHash("sha256").update(`${offerId}|${quantity}|${JSON.stringify(destination)}`).digest("hex").slice(0, 16), offerId, quantity,
        currency: wo.currency ?? "USD", itemPriceMinor: item, shippingMinor: rule.shipping === null ? null : Math.round(rule.shipping * 100) * 1,
        taxMinor: destination && rule.taxBps !== null ? Math.round((item * rule.taxBps) / 10_000) : null, feesMinor: rule.fees === null ? null : Math.round(rule.fees * 100),
        discountMinor: 0, quotedAt: new Date(at).toISOString(), expiresAt: new Date(at + 900_000).toISOString(), source: "EVAL_WORLD_V2_QUOTE" };
    },
  };
  for (const m of ["searchPage", "searchCandidates", "lookupUrl", "resolveVariant", "getVariantProduct"]) if (typeof inner[m] === "function") a[m] = inner[m].bind(inner);
  return a;
}

export async function runCase(L: Awaited<ReturnType<typeof load>>, c: EvalCaseV2): Promise<CaseOutcome> {
  const counters: WorldCounters = newCounters();
  const fetchImpl = worldFetch(counters);
  const now = () => Date.parse("2026-11-10T12:00:00.000Z");
  const store = new L.Store(":memory:");
  const ledger = new L.UsageLedger(store, L.PLACEHOLDER_PRICING, { perRequestSupplierMicro: 10_000_000, monthlyBillableMinor: 0, perRequestCalls: { CHANNEL3: 6, TAVILY: 12, KERNEL: 0 } }, now);
  const tavily = new L.TavilySearch("tvly-EVAL-FAKE-KEY-000", "community", fetchImpl);
  const router = new L.EvidenceRouter(store, ledger, tavily, null, { billable: false, now, policy: "v2",
    sources: { expertReviewDomains: WORLD_SOURCES.expertReview, forumDomains: WORLD_SOURCES.forums } });
  const ch3 = new L.Channel3ResearchAdapter("ch3-EVAL-FAKE-KEY-0000", { fetchImpl, now });
  const app = L.createApp({ host: "127.0.0.1", port: 0, baseUrl: "http://127.0.0.1:1", authMode: "dev", dbPath: ":memory:", auth: new L.DevAuth(), now,
    research: worldAdapter(ch3, L.MERCHANT_CLAIMS, now), service: { mode: "community", ledger, router, billing: null } });
  const e = c.expect;
  const t0 = performance.now();
  let out: any = null; let cmp: any = null; let error: string | undefined;
  try {
    out = await app.gateway.researchPurchase("eval-user", { request: c.request, ...(c.input ?? {}) });
    if (e.lowestVerified !== undefined && out.identity?.status === "LOCKED")
      cmp = await app.gateway.compareOffers("eval-user", { researchSessionId: out.purchaseSessionId, productIdentity: out.identity.lockedIdentity, destination: c.destination ?? null });
  } catch (err: any) { error = `${err?.code ?? ""} ${err?.message ?? String(err)}`.trim(); }
  const latencyMs = Math.round((performance.now() - t0) * 100) / 100;
  app.store.close(); store.close();
  const d = out ? readDecision(out) : { state: "HOLD" as State, recommendedPid: null, orderPids: [], lockedPid: null, citedUrls: [] };
  const topGroups = [...new Set(d.orderPids.map(groupOf).filter((g): g is string => !!g))];
  const relGroups = Object.entries(e.rel ?? {}).filter(([, r]) => r >= 1).map(([g]) => g);
  const recGroup = groupOf(d.recommendedPid);
  const lockedGroup = groupOf(d.lockedPid);
  const idealOrder = Object.entries(e.rel ?? {}).sort((a, b) => b[1] - a[1]).map(([g]) => g);
  const ideal = dcg(idealOrder, e.rel ?? {}, 5);
  const lockWrong = lockedGroup !== null && (e.lock === null || (e.lock !== undefined && lockedGroup !== e.lock));
  const sameFamily = (a: string | null, b: string | null | undefined) => !!a && !!b && WORLD.find((p) => p.truth.group === a)?.truth.family === WORLD.find((p) => p.truth.group === b)?.truth.family;
  const observedLowest = cmp?.lowestVerifiedEligibleOffer?.listingUrl ?? null;
  return {
    id: c.id, split: c.split, tags: c.tags, lang: c.lang, state: d.state, expectedStates: e.state, stateOk: e.state.includes(d.state),
    recommendedGroup: recGroup, topGroups: topGroups.slice(0, 10), lockedGroup,
    recallAt10: relGroups.length ? relGroups.filter((g) => topGroups.slice(0, 10).includes(g)).length / relGroups.length : null,
    ndcgAt5: ideal > 0 ? Math.round((dcg(topGroups, e.rel ?? {}, 5) / ideal) * 1000) / 1000 : null,
    unsafeForbidden: d.state === "RECOMMEND" && !!recGroup && (e.forbidden ?? []).includes(recGroup),
    unsafeShouldNotRecommend: d.state === "RECOMMEND" && !e.state.includes("RECOMMEND"),
    topOk: d.state === "RECOMMEND" && e.top ? !!recGroup && e.top.includes(recGroup) : null,
    lockOk: e.lock === undefined ? null : e.lock === null ? lockedGroup === null : lockedGroup === e.lock,
    falseLock: lockWrong, wrongVariantLock: lockWrong && sameFamily(lockedGroup, e.lock ?? null),
    ...(e.lowestVerified !== undefined ? { lowestVerified: { expected: e.lowestVerified, observed: observedLowest,
      falseCheapest: observedLowest !== null && observedLowest !== e.lowestVerified } } : {}),
    attribution: { cited: d.citedUrls.length, strong: d.citedUrls.filter(strongSource).length },
    calls: { channel3Search: counters.channel3Search, channel3Detail: counters.channel3Detail, channel3Lookup: counters.channel3Lookup, tavily: counters.tavilySearch,
      channel3Credits: counters.channel3Search + counters.channel3Lookup, tavilyCredits: counters.tavilyCredits,
      usd: Math.round(((counters.channel3Search + counters.channel3Lookup) * CHANNEL3_USD_PER_CREDIT + counters.tavilyCredits * TAVILY_USD_PER_CREDIT) * 10000) / 10000 },
    latencyMs, ...(error ? { error } : {}),
  };
}

const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))]! : 0; };
const mean = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 1000) / 1000 : null);
const rate = (n: number, d: number) => ({ n, d, rate: d ? Math.round((n / d) * 1000) / 1000 : null });

export function summarize(rs: CaseOutcome[]) {
  const recs = rs.filter((r) => r.state === "RECOMMEND");
  const holdCases = rs.filter((r) => r.expectedStates.length === 1 && r.expectedStates[0] === "HOLD");
  const recCases = rs.filter((r) => r.expectedStates.length === 1 && r.expectedStates[0] === "RECOMMEND");
  const locks = rs.filter((r) => r.lockedGroup !== null && r.lockOk !== null);
  const cmp = rs.filter((r) => r.lowestVerified);
  return {
    cases: rs.length, errors: rs.filter((r) => r.error).length,
    decisionStateAccuracy: rate(rs.filter((r) => r.stateOk).length, rs.length),
    recallAt10: mean(rs.map((r) => r.recallAt10).filter((x): x is number => x !== null)),
    ndcgAt5: mean(rs.map((r) => r.ndcgAt5).filter((x): x is number => x !== null)),
    exactIdentity: { lockCorrect: rate(rs.filter((r) => r.lockOk === true).length, rs.filter((r) => r.lockOk !== null).length),
      lockPrecision: rate(locks.filter((r) => r.lockOk).length, locks.length), falseLocks: rs.filter((r) => r.falseLock).length, wrongVariantLocks: rs.filter((r) => r.wrongVariantLock).length },
    constraintViolationRate: rate(recs.filter((r) => r.unsafeForbidden).length, recs.length),
    unsafeRecommendationRate: rate(rs.filter((r) => r.unsafeForbidden || r.unsafeShouldNotRecommend).length, rs.length),
    correctHoldRate: rate(holdCases.filter((r) => r.state === "HOLD").length, holdCases.length),
    falseHoldRate: rate(recCases.filter((r) => r.state === "HOLD").length, recCases.length),
    recommendationTopAccuracy: rate(rs.filter((r) => r.topOk === true).length, rs.filter((r) => r.topOk !== null).length),
    falseVerifiedCheapest: rate(cmp.filter((r) => r.lowestVerified!.falseCheapest).length, cmp.length),
    evidenceAttribution: (() => { const c = rs.reduce((a, r) => a + r.attribution.cited, 0), s = rs.reduce((a, r) => a + r.attribution.strong, 0); return { cited: c, strongSourceShare: c ? Math.round((s / c) * 1000) / 1000 : null }; })(),
    providerCalls: { channel3Search: rs.reduce((a, r) => a + r.calls.channel3Search, 0), channel3Detail: rs.reduce((a, r) => a + r.calls.channel3Detail, 0),
      channel3Lookup: rs.reduce((a, r) => a + r.calls.channel3Lookup, 0), tavily: rs.reduce((a, r) => a + r.calls.tavily, 0),
      perCase: mean(rs.map((r) => r.calls.channel3Search + r.calls.channel3Lookup + r.calls.channel3Detail + r.calls.tavily)),
      documentedUsdPerCase: mean(rs.map((r) => r.calls.usd)), maxUsdPerCase: Math.max(0, ...rs.map((r) => r.calls.usd)) },
    latencyMs: { p50: pct(rs.map((r) => r.latencyMs), 0.5), p95: pct(rs.map((r) => r.latencyMs), 0.95), note: "local in-process with fake providers; not network latency" },
  };
}

export async function runSuite(root: string, opts: { splits?: Array<"dev" | "holdout"> } = {}) {
  const freeze = verifyHoldoutFreeze();
  const L = await load(root);
  const cases = [...DEV_CASES, ...HOLDOUT_CASES].filter((c) => !opts.splits || opts.splits.includes(c.split));
  const results: CaseOutcome[] = [];
  for (const c of cases) results.push(await runCase(L, c));
  return { holdoutSha256: freeze.sha256, results,
    summary: { all: summarize(results), dev: summarize(results.filter((r) => r.split === "dev")), holdout: summarize(results.filter((r) => r.split === "holdout")) } };
}
