import type { CatalogProduct, MerchantOffer } from "../domain/types.js";
import type { CommerceResearchAdapter, ProductSearchQuery, SearchPage } from "./CommerceResearchAdapter.js";
import { CHANNEL3_CURRENCIES } from "./Channel3ResearchAdapter.js";
import type { ResearchIntentV2 } from "../intent/ResearchIntentV2.js";
import { resolveExactV2, type ResolutionV2 } from "../identity/ProductResolverV2.js";
import type { EvidenceRouter, RouterResult, RouterStep } from "../evidence/EvidenceRouter.js";
import { judgeV2, type CapabilityVerdict, type EvidenceItem } from "../evidence/EvidenceV2.js";
import { hostOf } from "../evidence/SourceRegistry.js";
import { clauseStatement, evidenceCapabilityOf } from "./capabilities.js";

/** True when any clause of a listing text claims the capability (planner prior only). */
function clauseStatementAny(text: string, cap: string): boolean | null {
  let seen: boolean | null = null;
  for (const c of text.split(/(?<=[.!?])\s+|\s+·\s+|;\s*|\s+—\s+/)) { const v = clauseStatement(c, cap); if (v === true) return true; if (v === false) seen = false; }
  return seen;
}
import { decide, preEligible, type CandidateInput, type Decision } from "../decision/DecisionEngine.js";
import type { RankingWeights } from "../decision/weights.js";

/**
 * Research V2 orchestration with explicit cost control. Every provider call goes through the caller's metered
 * functions (usage ledger: per-request caps, supplier-cost ceiling, fail closed). On top of the ledger caps the
 * planner applies its own, smaller, per-task limits and stopping rules:
 *   - catalog: primary query; a broader fallback only when fewer than 5 candidates pass the free hard checks;
 *     a second page only when the first was full and still too few passed; one free detail call to check a
 *     requested variant that search did not return. At most `maxCatalogCalls`.
 *   - evidence: only for candidates that pass every free hard check, ordered by fewest pre-evidence blockers, then
 *     (lowest-price objective) price, or (best objective) the listing-text prior and then price; at most
 *     `maxEvidenceCandidates`; must-haves and nice-to-haves share one combined query; a candidate is skipped
 *     when it can no longer change the decision (a cheaper, fully verified candidate with at least as many
 *     verified nice-to-haves exists); stop when a blocker-free candidate has every nice-to-have verified.
 *   - exhaustion of any limit stops spending and leaves the affected requirements UNVERIFIED (never optional).
 */
export interface PlannerLimits { maxCatalogCalls: number; maxPagesPerQuery: number; maxEvidenceCandidates: number; maxEvidenceSearchesPerCandidate: number; maxEvidenceSearches: number }
export const DEFAULT_PLANNER_LIMITS: PlannerLimits = { maxCatalogCalls: 3, maxPagesPerQuery: 2, maxEvidenceCandidates: 4, maxEvidenceSearchesPerCandidate: 2, maxEvidenceSearches: 6 };

export interface PlannerDeps {
  research: CommerceResearchAdapter;
  router: EvidenceRouter | null;
  /** Metered catalog page. Throws CommerceError USAGE_LIMIT when the ledger refuses. */
  searchPage: (q: ProductSearchQuery, pageToken: string | null, page: number) => Promise<SearchPage>;
  /** Metered variant detail (optional). */
  resolveVariant?: (productId: string, selection: Record<string, string>, currency: string | null) => Promise<CatalogProduct | null>;
  ctx: { userId: string; requestId: string };
  now: () => number;
  weights?: RankingWeights | null;
  limits?: Partial<PlannerLimits>;
}
export interface PlannerTrace {
  queries: Array<{ query: string; page: number; results: number; purpose: "PRIMARY" | "FALLBACK" | "NEXT_PAGE" | "VARIANT_DETAIL" }>;
  catalogCalls: number; evidenceSearches: number; evidenceSteps: RouterStep[];
  stops: string[];
  locale: { currencyRequested: string; currencySentToCatalog: string | null; supported: boolean };
}
export interface PlannerResult {
  products: CatalogProduct[];
  offers: Map<string, MerchantOffer[]>;
  resolution: ResolutionV2 | null;
  verdicts: Map<string, Record<string, CapabilityVerdict>>;
  /** Legacy (policy v1) router results per product, in the V1 output format. */
  legacyRouting: Map<string, RouterResult[]>;
  decision: Decision;
  trace: PlannerTrace;
  /** V2.4: a NAMED request whose variant was open was researched as discovery among the named model's listings. */
  namedFallback?: boolean;
}

export async function runResearchV2(intent: ResearchIntentV2, d: PlannerDeps): Promise<PlannerResult> {
  const L = { ...DEFAULT_PLANNER_LIMITS, ...(d.limits ?? {}) };
  const supported = CHANNEL3_CURRENCIES.has(intent.currency);
  const trace: PlannerTrace = { queries: [], catalogCalls: 0, evidenceSearches: 0, evidenceSteps: [], stops: [],
    locale: { currencyRequested: intent.currency, currencySentToCatalog: supported ? intent.currency : null, supported } };
  if (!supported) trace.stops.push(`Catalog cannot price in ${intent.currency}; listings come back in other currencies and cannot be compared with the budget.`);
  const products = new Map<string, CatalogProduct>();
  const offers = new Map<string, MerchantOffer[]>();
  const exact = intent.mode === "EXACT_PRODUCT_PURCHASE" && !!intent.target;

  const baseQuery = (query: string): ProductSearchQuery => ({ text: query, query, category: intent.category, brand: exact ? intent.target!.brand : null, model: exact ? intent.target!.model : null,
    currency: supported ? intent.currency : null, country: null,
    // Price filter in discovery only (an exact request must find the product to explain an over-budget price).
    maxPriceMinor: !exact && supported && (intent.budgetMaxMinor ?? intent.budgetMinor) !== null ? (intent.budgetMaxMinor ?? intent.budgetMinor) : null,
    conditions: intent.condition === "used" ? ["used"] : intent.condition === "new" ? ["new"] : undefined, limit: 20 });
  const fetchOffers = async (ps: CatalogProduct[]) => {
    for (const p of ps) if (!offers.has(p.productId)) offers.set(p.productId, (await d.research.findOffers(p.identity)).filter((o) => o.productId === p.productId));
  };
  const runQuery = async (query: string, purpose: "PRIMARY" | "FALLBACK"): Promise<void> => {
    let token: string | null = null;
    for (let page = 1; page <= L.maxPagesPerQuery; page++) {
      if (trace.catalogCalls >= L.maxCatalogCalls) { trace.stops.push("catalog call limit reached"); return; }
      let r: SearchPage;
      try { r = await d.searchPage(baseQuery(query), token, page); }
      catch (e) { if (page > 1 && (e as { code?: string }).code === "USAGE_LIMIT") { trace.stops.push("usage limit reached before the next page"); return; } throw e; }
      trace.catalogCalls++;
      trace.queries.push({ query, page, results: r.products.length, purpose: page === 1 ? purpose : "NEXT_PAGE" });
      for (const p of r.products) if (!products.has(p.productId)) products.set(p.productId, p);
      await fetchOffers(r.products);
      token = r.nextPageToken;
      if (!token) return;
      // Another page only when it can change the outcome: exact family not found yet, or too few eligible candidates.
      if (exact ? familyFound() : passing() >= 3) return;
    }
  };
  const familyFound = () => resolveExactV2(intent, [...products.values()], (id) => offers.get(id) ?? []).status !== "NOT_FOUND";
  const passing = () => [...products.values()].filter((p) => preEligible(intent, { product: p, offers: offers.get(p.productId) ?? [] }, null).eligible).length;

  // The primary query may fail closed (usage limit → the request fails, nothing was delivered). Any LATER catalog
  // call that hits a limit just stops spending: research continues with what was already found.
  const optional = async (fn: () => Promise<void>, what: string) => {
    try { await fn(); } catch (e) { if ((e as { code?: string }).code === "USAGE_LIMIT") trace.stops.push(`usage limit reached before ${what}; continuing with results already found`); else throw e; }
  };
  let first = true;
  const runQueryGuarded = async (query: string, purpose: "PRIMARY" | "FALLBACK") => {
    if (first) { first = false; await runQuery(query, purpose); } else await optional(() => runQuery(query, purpose), `the ${purpose.toLowerCase()} query`);
  };
  // N-07: no query could be formed in the provider's language: no catalog call (nothing to search for).
  if (!intent.queries.primary.trim()) trace.stops.push("no search query could be formed in the provider's language; the request must name the product");
  else await runQueryGuarded(intent.queries.primary, "PRIMARY");
  if (!exact && intent.queries.fallback && passing() < 5) await runQueryGuarded(intent.queries.fallback, "FALLBACK");

  let resolution: ResolutionV2 | null = null;
  if (exact) {
    resolution = resolveExactV2(intent, [...products.values()], (id) => offers.get(id) ?? []);
    if (resolution.status === "NOT_FOUND" && resolution.siblingToCheck && d.resolveVariant && trace.catalogCalls < L.maxCatalogCalls) {
      const s = resolution.siblingToCheck;
      let p: CatalogProduct | null = null;
      try { p = await d.resolveVariant(s.productId, { [s.axis]: s.label }, supported ? intent.currency : null); }
      catch (e) { if ((e as { code?: string }).code !== "USAGE_LIMIT") throw e; trace.stops.push("usage limit reached before the variant detail check"); }
      trace.catalogCalls++;
      trace.queries.push({ query: `detail ${s.productId} ${s.axis}=${s.label}`, page: 1, results: p ? 1 : 0, purpose: "VARIANT_DETAIL" });
      if (p) { products.set(p.productId, p); offers.delete(p.productId); await fetchOffers([p]); resolution = resolveExactV2(intent, [...products.values()], (id) => offers.get(id) ?? []); }
    }
  }

  // Candidates the decision will consider.
  let pool: CatalogProduct[];
  // V2.4: a request that only names the product (no buy verb) and leaves its variant open ("Fabrikam Aero 14 laptop"
  // when 16 GB and 32 GB exist) is researched as discovery among that model's listings; the model rule still excludes
  // every other model, bundle and accessory.
  const namedFallback = exact && resolution?.status === "AMBIGUOUS" && intent.lockBasis === "NAMED";
  if (exact && !namedFallback) pool = resolution?.status === "LOCKED" ? [products.get(resolution.productId)!] : [];
  else pool = [...products.values()];
  const lock = resolution?.status === "LOCKED" ? { productId: resolution.productId } : null;
  // Exact-lock duplicates carry their offers on the locked product (Channel3 adapter merges them already).
  if (lock && resolution?.status === "LOCKED") for (const dup of resolution.duplicates) offers.set(lock.productId, [...(offers.get(lock.productId) ?? []), ...(offers.get(dup) ?? []).map((o) => ({ ...o, productId: lock.productId }))]);

  const verdicts = new Map<string, Record<string, CapabilityVerdict>>();
  const notChecked = new Map<string, string[]>();
  // V2.2 WP-4: stated requirements outside the vocabulary are verified as generic propositions too (evidenceCapabilityOf).
  const propCaps = [...new Set((intent.unresolvedMust ?? []).map(evidenceCapabilityOf))].filter((x) => !intent.mustHave.includes(x));
  const mustCaps = [...intent.mustHave, ...propCaps];
  const caps = [...mustCaps, ...intent.niceToHave.filter((n) => !mustCaps.includes(n))];
  const propsHold = (vv: Record<string, CapabilityVerdict>) => (intent.unresolvedMust ?? []).every((k) => vv[evidenceCapabilityOf(k)]?.status === (k.startsWith("not:") ? "VERIFIED_FALSE" : "VERIFIED_TRUE"));
  const sellers = [...new Set([...offers.values()].flat().map((o) => o.merchantDomain).concat([...offers.values()].flat().map((o) => (o.listingUrl ? hostOf(o.listingUrl) : "")).filter(Boolean)))];
  let limitReached = false;
  const legacyRouting = new Map<string, RouterResult[]>();
  if (caps.length && pool.length && (!d.router || d.router.policy !== "v2")) {
    // LEGACY EVIDENCE MODE (no router, or a router with policy "v1"): the V1 routing and V1 sufficiency semantics,
    // unchanged, so existing deployments and their regressions behave exactly as before. V2 evidence requires policy "v2".
    for (const p of pool) {
      const out: Record<string, CapabilityVerdict> = {};
      for (const cap of intent.mustHave) {
        let routed: RouterResult | null = null;
        if (d.router && !["VERIFIED_TRUE", "VERIFIED_FALSE"].includes(v1Status(p, cap))) {
          routed = await d.router.verify(p, cap, d.ctx);
          (legacyRouting.get(p.productId) ?? legacyRouting.set(p.productId, []).get(p.productId)!).push(routed);
          trace.evidenceSteps.push(...routed.steps); trace.evidenceSearches += routed.steps.filter((x) => x.action === "CALLED" && x.provider === "TAVILY").length;
          if (routed.sufficiency === "SUFFICIENT_TRUE" || routed.sufficiency === "SUFFICIENT_FALSE")
            p.capabilities = [...p.capabilities.filter((c) => c.capability !== cap || c.source.kind === "MANUFACTURER"), ...routed.claims.filter((c) => c.source.kind !== "CATALOG_LISTING")];
          if (routed.reason === "VERIFICATION_REQUIRED_BUT_LIMIT_REACHED") { limitReached = true; notChecked.set(p.productId, [...(notChecked.get(p.productId) ?? []), cap]); }
        }
        out[cap] = v1Verdict(p, cap, routed);
      }
      for (const cap of intent.niceToHave) out[cap] = v1Verdict(p, cap, null);
      verdicts.set(p.productId, out);
    }
  } else if (caps.length && pool.length) {
    // Spending order (review R-09): free hard checks first; for the lowest-price objective, cheapest first (so a cheaper
    // eligible candidate is never left unchecked behind a pricier one); otherwise a catalog-text PRIOR (how many
    // must-haves the listing itself claims; used only to decide where to spend, never as evidence), then price.
    // V2.3: unfamiliar MUST propositions count toward the prior too ("Wi-Fi 7" in a router's title): ordering only.
    const prior = (p: CatalogProduct) => [...intent.mustHave, ...propCaps.filter((x) => !x.startsWith("not:"))].filter((m) => clauseStatementAny(`${p.title}. ${p.description?.text ?? ""}`, m) === true).length;
    const pre = pool.map((p) => ({ p, pe: preEligible(intent, { product: p, offers: offers.get(p.productId) ?? [] }, lock), prior: prior(p) }))
      .filter((x) => x.pe.eligible)
      .sort((a, b) => a.pe.blockersBeforeEvidence.length - b.pe.blockersBeforeEvidence.length
        || (intent.objective === "LOWEST_VERIFIED_TOTAL" ? (a.pe.lowestListingMinor ?? Infinity) - (b.pe.lowestListingMinor ?? Infinity) || b.prior - a.prior
          : b.prior - a.prior || (a.pe.lowestListingMinor ?? Infinity) - (b.pe.lowestListingMinor ?? Infinity)));
    let best: { price: number; nice: number } | null = null;
    const verifiedFamilies = new Set<string>();
    let checked = 0;
    for (const { p, pe } of pre) {
      // Same family as an already verified product: its evidence query is cached, so checking costs nothing.
      const fam = `${p.identity.brand}|${p.identity.model}`.toLowerCase();
      const free = verifiedFamilies.has(fam);
      if (!free && checked >= L.maxEvidenceCandidates) { notChecked.set(p.productId, caps); if (!trace.stops.includes(`evidence candidate limit (${L.maxEvidenceCandidates}) reached`)) trace.stops.push(`evidence candidate limit (${L.maxEvidenceCandidates}) reached`); continue; }
      if (!free && best && best.nice >= intent.niceToHave.length) { notChecked.set(p.productId, caps); continue; }
      if (!free && best && (pe.lowestListingMinor ?? Infinity) >= best.price && intent.niceToHave.length === 0) { notChecked.set(p.productId, caps); continue; }
      if (trace.evidenceSearches >= L.maxEvidenceSearches) { notChecked.set(p.productId, caps); limitReached = true; trace.stops.push("evidence search limit reached"); continue; }
      if (!free) checked++;
      verifiedFamilies.add(fam);
      const v = await verifyFor(d, p, caps, sellers, Math.min(L.maxEvidenceSearchesPerCandidate, L.maxEvidenceSearches - trace.evidenceSearches), trace);
      verdicts.set(p.productId, v.verdicts);
      if (v.blocked.length) { limitReached = true; notChecked.set(p.productId, v.blocked); trace.stops.push("usage limit reached during evidence; remaining requirements stay unverified"); }
      const allMust = intent.mustHave.every((m) => v.verdicts[m]?.status === "VERIFIED_TRUE") && propsHold(v.verdicts);
      if (allMust && pe.blockersBeforeEvidence.length === 0) {
        const nice = intent.niceToHave.filter((n) => v.verdicts[n]?.status === "VERIFIED_TRUE").length;
        const price = pe.lowestListingMinor ?? Infinity;
        if (!best || nice > best.nice || (nice === best.nice && price < best.price)) best = { price, nice };
      }
      if (limitReached) break;
    }
  }
  const inputs: CandidateInput[] = pool.map((p) => {
    const v = verdicts.get(p.productId) ?? (d.router?.policy === "v2" ? fixtureVerdicts(p, caps) : Object.fromEntries(caps.map((c) => [c, v1Verdict(p, c, null)])));
    return { product: p, offers: offers.get(p.productId) ?? [], must: pick(v, mustCaps), nice: pick(v, intent.niceToHave),
      listingClaims: [...intent.mustHave, ...propCaps.filter((x) => !x.startsWith("not:"))].filter((m) => clauseStatementAny(`${p.title}. ${p.description?.text ?? ""}`, m) === true).length, notChecked: notChecked.get(p.productId) ?? (verdicts.has(p.productId) ? [] : caps.filter((c) => !v[c] || v[c]!.status === "UNVERIFIED")), limitReached };
  });
  const exactFailure = namedFallback ? null : exact && resolution && resolution.status !== "LOCKED" ? (resolution.status === "AMBIGUOUS" ? resolution.question : resolution.reason) : exact && !resolution ? "No exact product could be resolved." : null;
  const decision = decide(intent, inputs, { exactLock: lock, exactFailure, weights: d.weights ?? null, now: d.now() });
  return { products: [...products.values()], offers, resolution, verdicts, legacyRouting, decision, trace, namedFallback };
}

/** V1 capability status (any non-listing claim decides; listing claims never do). */
function v1Status(p: CatalogProduct, cap: string): "VERIFIED_TRUE" | "VERIFIED_FALSE" | "LISTING_CLAIM_ONLY" | "UNKNOWN" {
  const claims = p.capabilities.filter((c) => c.capability === cap);
  const strong = claims.find((c) => c.source.kind !== "CATALOG_LISTING");
  return strong ? (strong.value ? "VERIFIED_TRUE" : "VERIFIED_FALSE") : claims.length ? "LISTING_CLAIM_ONLY" : "UNKNOWN";
}
function v1Verdict(p: CatalogProduct, cap: string, routed: RouterResult | null): CapabilityVerdict {
  const st = routed?.sufficiency === "CONTRADICTED" ? "CONTRADICTED" : v1Status(p, cap);
  const items: EvidenceItem[] = p.capabilities.filter((c) => c.capability === cap).map((c) => ({ url: c.source.url, domain: hostOf(c.source.url),
    sourceClass: c.source.kind === "MANUFACTURER" ? "MANUFACTURER" : c.source.kind === "INDEPENDENT_REVIEW" ? "EXPERT_REVIEW" : "RETAILER", value: c.value, quote: c.source.title, publishedDate: null,
    provider: "v1", requestId: null, observedAt: c.source.retrievedAt, counts: c.source.kind !== "CATALOG_LISTING", whyNotCounted: c.source.kind === "CATALOG_LISTING" ? "catalog listing claim" : null }));
  const strong = items.find((i) => i.counts);
  return { capability: cap, status: st === "CONTRADICTED" ? "CONTRADICTED" : st === "VERIFIED_TRUE" || st === "VERIFIED_FALSE" ? st : "UNVERIFIED",
    basis: st === "CONTRADICTED" ? "CONFLICT" : strong ? (strong.sourceClass === "MANUFACTURER" ? "MANUFACTURER" : "TWO_EXPERT_GROUPS") : "INSUFFICIENT", evidence: items, independentGroups: 0 };
}

const pick = (v: Record<string, CapabilityVerdict>, ids: string[]) => Object.fromEntries(ids.map((i) => [i, v[i]]));

/** Claims already attached to a catalog product (fixtures), judged with the V2 rule. Catalog listings never count. */
function fixtureVerdicts(p: CatalogProduct, caps: string[]): Record<string, CapabilityVerdict> {
  return Object.fromEntries(caps.map((cap) => {
    const items: EvidenceItem[] = p.capabilities.filter((c) => c.capability === cap).map((c) => ({ url: c.source.url, domain: hostOf(c.source.url),
      sourceClass: c.source.kind === "MANUFACTURER" ? "MANUFACTURER" : c.source.kind === "INDEPENDENT_REVIEW" ? "EXPERT_REVIEW" : c.source.kind === "CATALOG_LISTING" || c.source.kind === "RETAILER_ASSERTION" ? "RETAILER" : "UNKNOWN",
      value: c.value, quote: c.source.title, publishedDate: null, provider: "CATALOG", requestId: null, observedAt: c.source.retrievedAt,
      counts: c.source.kind === "MANUFACTURER" || c.source.kind === "INDEPENDENT_REVIEW", whyNotCounted: c.source.kind === "MANUFACTURER" || c.source.kind === "INDEPENDENT_REVIEW" ? null : "catalog/retailer claim" }));
    return [cap, judgeV2(cap, items)];
  }));
}

async function verifyFor(d: PlannerDeps, p: CatalogProduct, caps: string[], sellers: string[], maxSearches: number, trace: PlannerTrace) {
  if (!d.router) return { verdicts: fixtureVerdicts(p, caps), blocked: [] as string[] };
  if (d.router.policy === "v2") {
    const r = await d.router.verifyMany(p, caps, d.ctx, { sellers, maxSearches });
    trace.evidenceSearches += r.searchesSent; trace.evidenceSteps.push(...r.steps);
    return { verdicts: r.verdicts, blocked: r.blockedByLimit };
  }
  // Legacy router: one verify() per capability, translated into V2 verdicts (V1 sufficiency rule applies).
  const out: Record<string, CapabilityVerdict> = {}; const blocked: string[] = [];
  for (const cap of caps) {
    const r = await d.router.verify(p, cap, d.ctx);
    trace.evidenceSteps.push(...r.steps); trace.evidenceSearches += r.steps.filter((s) => s.action === "CALLED" && s.provider === "TAVILY").length;
    if (r.reason === "VERIFICATION_REQUIRED_BUT_LIMIT_REACHED") blocked.push(cap);
    const items: EvidenceItem[] = r.claims.map((c) => ({ url: c.source.url, domain: hostOf(c.source.url), sourceClass: c.source.kind === "MANUFACTURER" ? "MANUFACTURER" : c.source.kind === "INDEPENDENT_REVIEW" ? "EXPERT_REVIEW" : "RETAILER",
      value: c.value, quote: c.source.title, publishedDate: null, provider: "router-v1", requestId: null, observedAt: c.source.retrievedAt, counts: c.source.kind !== "CATALOG_LISTING", whyNotCounted: c.source.kind === "CATALOG_LISTING" ? "catalog listing" : null }));
    out[cap] = { capability: cap, status: r.sufficiency === "SUFFICIENT_TRUE" ? "VERIFIED_TRUE" : r.sufficiency === "SUFFICIENT_FALSE" ? "VERIFIED_FALSE" : r.sufficiency === "CONTRADICTED" ? "CONTRADICTED" : "UNVERIFIED",
      basis: r.sufficiency === "CONTRADICTED" ? "CONFLICT" : r.sufficiency === "INSUFFICIENT" ? "INSUFFICIENT" : items.some((i) => i.sourceClass === "MANUFACTURER") ? "MANUFACTURER" : "TWO_EXPERT_GROUPS", evidence: items, independentGroups: 0 };
  }
  return { verdicts: out, blocked };
}
