import type { CatalogProduct, MerchantOffer } from "../domain/types.js";
import type { Currency } from "../domain/money.js";
import { AXES, normalizeKey, type AttributeAxis } from "../identity/ProductIdentityExtractor.js";
import { factsOf } from "../identity/ProductResolverV2.js";
import type { ResearchIntentV2 } from "../intent/ResearchIntentV2.js";
import type { CapabilityVerdict } from "../evidence/EvidenceV2.js";
import { productCategory } from "../research/capabilities.js";
import { weightsFor, type RankingWeights } from "./weights.js";

/**
 * Research V2 decision engine. Two stages, in this order:
 *   1. HARD ELIGIBILITY. A known violation disqualifies (category, kind, stated attribute, condition, budget, stock,
 *      a must-have known FALSE, exact identity). An unresolved requirement is a BLOCKER (must-have unverified or
 *      contradicted, price not in the requested currency, listing within 10% of the budget while shipping/tax are
 *      unknown, availability or condition unknown). No score can compensate for either.
 *   2. UTILITY RANKING of eligible candidates with versioned weights (weights.ts), after the lexicographic order
 *      blockers ↑, verified nice-to-haves ↓.
 * States: RECOMMEND (an eligible candidate with no blocker), INVESTIGATE (eligible candidates, all with blockers),
 * HOLD (nothing eligible, or an exact identity could not be locked). These are RESEARCH decisions: none of them is a
 * payment authorization, and a listing price is never presented as a verified total.
 */
export const DECISION_ENGINE_VERSION = "decision-v2.0.0";
export const BUDGET_HEADROOM = 0.9;

export type DecisionState = "RECOMMEND" | "INVESTIGATE" | "HOLD";
export type Disqualifier = "CATEGORY_MISMATCH" | "NOT_STANDALONE" | "BUNDLE_EXCLUDED" | "ATTRIBUTE_MISMATCH" | "CONDITION_MISMATCH" | "OVER_BUDGET" | "UNAVAILABLE" | "MUST_HAVE_FALSE" | "NOT_LOCKED_IDENTITY";
export type Blocker = "MUST_HAVE_UNVERIFIED" | "MUST_HAVE_CONTRADICTED" | "VERIFICATION_LIMIT_REACHED" | "PRICE_NOT_IN_REQUESTED_CURRENCY" | "BUDGET_TIGHT" | "AVAILABILITY_UNKNOWN" | "CONDITION_UNCONFIRMED" | "ATTRIBUTE_UNKNOWN";

export interface CandidateInput {
  product: CatalogProduct;
  offers: MerchantOffer[];
  must: Record<string, CapabilityVerdict | undefined>;
  nice: Record<string, CapabilityVerdict | undefined>;
  /** Capabilities that were not checked because a limit or the planner stopped (never treated as satisfied). */
  notChecked: string[];
  limitReached: boolean;
  /** Must-haves the listing text itself claims (a weak prior for ordering unverified candidates; never evidence). */
  listingClaims?: number;
}
export interface RankedCandidate {
  productId: string; title: string; rank: number; eligible: boolean;
  disqualifiers: Array<{ code: Disqualifier; detail: string }>;
  blockers: Array<{ code: Blocker; detail: string }>;
  utility: number | null;
  utilityParts: Record<string, number> | null;
  niceVerified: number;
  price: { lowestListingMinor: number | null; currency: Currency; merchantDomain: string | null; offersConsidered: number; confidence: "LISTING_PRICE_ONLY" | "NO_PRICE_IN_CURRENCY" };
}
export interface Decision {
  engine: string; weights: string; state: DecisionState;
  recommendation: null | {
    productId: string; title: string;
    whySelected: string[];
    whyOthersRankedLower: Array<{ productId: string; title: string; reason: string }>;
    verifiedFacts: Array<{ capability: string; value: boolean; basis: string; sources: Array<{ url: string; sourceClass: string; quote: string; publishedDate: string | null }> }>;
    unknownOrDisputed: string[];
    priceEvidence: { lowestListingMinor: number | null; currency: Currency; merchantDomain: string | null; confidence: string; note: string };
    verifyBeforePurchase: string[];
  };
  /** INVESTIGATE: the best candidate and exactly what must be resolved. HOLD: why nothing qualifies. */
  topCandidate: null | { productId: string; title: string; open: string[] };
  holdReasons: string[];
  ranking: RankedCandidate[];
  disclaimer: string;
}

const DISCLAIMER = "Research decision only. It is not a payment authorization: spending requires a user-created purchase mandate and PayPal buyer approval. Listing prices are search-time prices, not verified totals.";
const eq = (a: string, b: string) => normalizeKey(a) === normalizeKey(b);

export function decide(intent: ResearchIntentV2, inputs: CandidateInput[], o: { exactLock?: { productId: string } | null; exactFailure?: string | null; weights?: RankingWeights | null; now: number }): Decision {
  const w = weightsFor(intent.objective, o.weights);
  const assessed = inputs.map((c) => assess(intent, c, o.exactLock ?? null));
  const eligible = assessed.filter((a) => a.r.eligible);
  const cheapest = Math.min(...eligible.map((a) => a.r.price.lowestListingMinor ?? Infinity));
  for (const a of eligible) {
    const p = a.r.price.lowestListingMinor;
    const mustN = intent.mustHave.length, niceN = intent.niceToHave.length;
    const mustT = intent.mustHave.filter((m) => a.c.must[m]?.status === "VERIFIED_TRUE").length;
    const ev = mustN ? intent.mustHave.reduce((s, m) => s + (a.c.must[m]?.basis === "MANUFACTURER" || a.c.must[m]?.basis === "TWO_EXPERT_GROUPS" ? 1 : 0), 0) / mustN : 1;
    const merchants = new Set(a.usable.map((x) => x.merchantDomain)).size;
    const fresh = a.usable.length ? Math.max(0, 1 - (o.now - Math.max(...a.usable.map((x) => Date.parse(x.observedAt) || 0))) / (7 * 86400_000)) : 0;
    const parts = { suitability: w.suitability * (mustN ? mustT / mustN : 1), niceToHave: w.niceToHave * (niceN ? a.r.niceVerified / niceN : 0), evidence: w.evidence * ev,
      value: w.value * (p && Number.isFinite(cheapest) ? cheapest / p : 0), costConfidence: w.costConfidence * (a.r.price.confidence === "LISTING_PRICE_ONLY" ? 1 : 0) * (a.r.blockers.some((b) => b.code === "CONDITION_UNCONFIRMED" || b.code === "AVAILABILITY_UNKNOWN") ? 0.5 : 1),
      merchant: w.merchant * Math.min(1, merchants / 3), freshness: w.freshness * fresh, uncertainty: -w.uncertaintyPenalty * a.r.blockers.length };
    a.r.utilityParts = Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, Math.round(v * 1000) / 1000]));
    a.r.utility = Math.round(Object.values(parts).reduce((s, v) => s + v, 0) * 1000) / 1000;
  }
  const order = [...assessed].sort((x, y) => Number(y.r.eligible) - Number(x.r.eligible) || x.r.blockers.length - y.r.blockers.length || y.r.niceVerified - x.r.niceVerified
    || (y.c.listingClaims ?? 0) - (x.c.listingClaims ?? 0) || (y.r.utility ?? -1) - (x.r.utility ?? -1) || (x.r.price.lowestListingMinor ?? Infinity) - (y.r.price.lowestListingMinor ?? Infinity) || x.r.disqualifiers.length - y.r.disqualifiers.length);
  order.forEach((a, i) => (a.r.rank = i + 1));
  const ranking = order.map((a) => a.r);
  const best = order[0];
  const holdReasons: string[] = [];
  let state: DecisionState;
  if (o.exactFailure) { state = "HOLD"; holdReasons.push(o.exactFailure); }
  else if (best && best.r.eligible && best.r.blockers.length === 0) state = "RECOMMEND";
  else if (best && best.r.eligible) state = "INVESTIGATE";
  else { state = "HOLD"; holdReasons.push(inputs.length ? "Every candidate has a known violation of the request." : "No candidate was found."); }
  if (state === "HOLD" && !o.exactFailure) for (const a of order.slice(0, 5)) holdReasons.push(`${a.r.title}: ${a.r.disqualifiers.map((d) => d.detail).join("; ")}`);

  const factsFor = (a: (typeof order)[number]) => [...intent.mustHave, ...intent.niceToHave].flatMap((cap) => {
    const v = a.c.must[cap] ?? a.c.nice[cap];
    if (!v || (v.status !== "VERIFIED_TRUE" && v.status !== "VERIFIED_FALSE")) return [];
    return [{ capability: cap, value: v.status === "VERIFIED_TRUE", basis: v.basis, sources: v.evidence.filter((e) => e.counts).map((e) => ({ url: e.url, sourceClass: e.sourceClass, quote: e.quote, publishedDate: e.publishedDate })) }];
  });
  const unknownsFor = (a: (typeof order)[number]) => [
    ...a.r.blockers.map((b) => b.detail),
    ...intent.niceToHave.filter((n) => a.c.nice[n]?.status !== "VERIFIED_TRUE" && a.c.nice[n]?.status !== "VERIFIED_FALSE").map((n) => `nice-to-have "${n}" is not verified`),
    ...intent.niceToHave.filter((n) => a.c.nice[n]?.status === "CONTRADICTED").map((n) => `nice-to-have "${n}" has contradicting sources`),
    ...a.c.notChecked.map((n) => `"${n}" was not checked (stopping rule or limit)`),
  ];
  let recommendation: Decision["recommendation"] = null; let topCandidate: Decision["topCandidate"] = null;
  if (state === "RECOMMEND") {
    const a = best!;
    const why: string[] = [];
    if (o.exactLock) why.push("It is the exact product requested (brand, model, variant, kind and condition all match).");
    if (intent.mustHave.length) why.push(`Every must-have is verified: ${intent.mustHave.join(", ")}.`);
    if (intent.niceToHave.length) why.push(`${a.r.niceVerified} of ${intent.niceToHave.length} nice-to-haves verified.`);
    if (a.r.price.lowestListingMinor !== null) why.push(`Lowest eligible listing ${fmt(a.r.price.lowestListingMinor, intent.currency)} at ${a.r.price.merchantDomain}${intent.budgetMinor !== null ? ` (budget ${fmt(intent.budgetMinor, intent.currency)})` : ""}.`);
    recommendation = { productId: a.r.productId, title: a.r.title, whySelected: why,
      whyOthersRankedLower: order.slice(1, 8).map((x) => ({ productId: x.r.productId, title: x.r.title, reason: x.r.disqualifiers[0]?.detail ?? x.r.blockers[0]?.detail ?? (x.r.niceVerified < a.r.niceVerified ? "fewer verified nice-to-haves" : "higher listing price or lower utility") })),
      verifiedFacts: factsFor(a), unknownOrDisputed: unknownsFor(a),
      priceEvidence: { lowestListingMinor: a.r.price.lowestListingMinor, currency: intent.currency, merchantDomain: a.r.price.merchantDomain, confidence: a.r.price.confidence,
        note: "Search-time listing price. Shipping, tax and fees are unknown until compare_purchase_offers obtains a merchant quote; never a verified total." },
      verifyBeforePurchase: [
        "Get a merchant quote with compare_purchase_offers (shipping, tax and fees) for a destination before any checkout.",
        ...(intent.conditionStated ? [] : ["Condition was assumed NEW: confirm the offer is new."]),
        ...(a.usable.some((x) => x.listedIdentity.condition === "unknown") ? ["Some offers do not state their condition."] : []),
        "Confirm the merchant identity and stock at checkout time (search data can be stale).",
        ...unknownsFor(a).filter((u) => /nice-to-have/.test(u)),
      ] };
  } else if (state === "INVESTIGATE") {
    topCandidate = { productId: best!.r.productId, title: best!.r.title, open: unknownsFor(best!) };
    holdReasons.push(...best!.r.blockers.map((b) => b.detail));
  }
  return { engine: DECISION_ENGINE_VERSION, weights: w.version, state, recommendation, topCandidate, holdReasons, ranking, disclaimer: DISCLAIMER };
}

function assess(intent: ResearchIntentV2, c: CandidateInput, lock: { productId: string } | null) {
  const p = c.product; const f = factsOf(p);
  const dq: RankedCandidate["disqualifiers"] = []; const bl: RankedCandidate["blockers"] = [];
  if (lock && p.productId !== lock.productId) dq.push({ code: "NOT_LOCKED_IDENTITY", detail: "not the locked exact product" });
  if (!lock) {
    const cat = productCategory(p);
    if (intent.category && cat && cat !== intent.category) dq.push({ code: "CATEGORY_MISMATCH", detail: `category ${cat}, requested ${intent.category}` });
    if (f.kind === "ACCESSORY") dq.push({ code: "NOT_STANDALONE", detail: `accessory${f.accessoryNoun ? ` (${f.accessoryNoun})` : ""}, not the product itself` });
    if (f.kind === "BUNDLE" && (intent.excludeBundles || intent.attributes.pack === undefined)) dq.push({ code: intent.excludeBundles ? "BUNDLE_EXCLUDED" : "NOT_STANDALONE", detail: "bundle / multi-pack, not the standalone product" });
    for (const a of AXES.filter((x) => intent.attributes[x] && x !== "pack") as AttributeAxis[]) {
      const v = f.attributes[a];
      if (!v || v === "CONFLICT") bl.push({ code: "ATTRIBUTE_UNKNOWN", detail: `${a} ${intent.attributes[a]} is not confirmed by the listing` });
      else if (!eq(v, intent.attributes[a]!)) dq.push({ code: "ATTRIBUTE_MISMATCH", detail: `${a} is ${v}, requested ${intent.attributes[a]}` });
    }
    if (f.titleCondition && f.titleCondition !== intent.condition) dq.push({ code: "CONDITION_MISMATCH", detail: `listing is ${f.titleCondition}, requested ${intent.condition}` });
  }
  // Offers usable for this request: requested condition (unknown allowed but flagged when NEW is requested), not out of stock.
  const own = c.offers.filter((o) => o.productId === p.productId);
  const condOk = own.filter((o) => o.listedIdentity.condition === intent.condition || (intent.condition === "new" && o.listedIdentity.condition === "unknown"));
  if (own.length && !condOk.length) dq.push({ code: "CONDITION_MISMATCH", detail: `no ${intent.condition} offer (offers are ${[...new Set(own.map((o) => o.listedIdentity.condition))].join(", ")})` });
  const live = condOk.filter((o) => o.availability !== "OUT_OF_STOCK");
  if (condOk.length && !live.length) dq.push({ code: "UNAVAILABLE", detail: "every offer is out of stock" });
  if (!own.length) bl.push({ code: "AVAILABILITY_UNKNOWN", detail: "no offer found for this listing" });
  const inCur = live.filter((o) => o.currency === intent.currency);
  const usable = inCur.length ? inCur : [];
  if (live.length && !inCur.length) bl.push({ code: "PRICE_NOT_IN_REQUESTED_CURRENCY", detail: `no listing priced in ${intent.currency}` });
  if (usable.length && !usable.some((o) => o.availability === "IN_STOCK")) bl.push({ code: "AVAILABILITY_UNKNOWN", detail: "stock is not stated by any offer" });
  if (usable.length && !usable.some((o) => o.listedIdentity.condition === intent.condition)) bl.push({ code: "CONDITION_UNCONFIRMED", detail: `no offer confirms condition ${intent.condition}` });
  const priceOffers = [...usable].sort((a, b) => a.itemPriceMinor - b.itemPriceMinor);
  const lowest = priceOffers[0] ?? null;
  if (lowest && intent.budgetMinor !== null) {
    if (lowest.itemPriceMinor > intent.budgetMinor) dq.push({ code: "OVER_BUDGET", detail: `lowest eligible listing ${fmt(lowest.itemPriceMinor, intent.currency)} is over the budget ${fmt(intent.budgetMinor, intent.currency)}` });
    else if (lowest.itemPriceMinor > intent.budgetMinor * BUDGET_HEADROOM) bl.push({ code: "BUDGET_TIGHT", detail: `listing ${fmt(lowest.itemPriceMinor, intent.currency)} is within 10% of the budget while shipping and tax are unknown` });
  }
  for (const m of intent.mustHave) {
    const v = c.must[m];
    if (v?.status === "VERIFIED_FALSE") dq.push({ code: "MUST_HAVE_FALSE", detail: `must-have "${m}" is false (${v.basis === "MANUFACTURER" ? "manufacturer" : "two expert sources"})` });
    else if (v?.status === "CONTRADICTED") bl.push({ code: "MUST_HAVE_CONTRADICTED", detail: `must-have "${m}": sources contradict each other` });
    else if (v?.status !== "VERIFIED_TRUE") bl.push({ code: c.limitReached && c.notChecked.includes(m) ? "VERIFICATION_LIMIT_REACHED" : "MUST_HAVE_UNVERIFIED",
      detail: `must-have "${m}" is not verified${c.notChecked.includes(m) ? " (not checked)" : v ? ` (${v.evidence.length ? v.evidence.filter((e) => !e.counts).map((e) => e.whyNotCounted).filter(Boolean).slice(0, 2).join("; ") || "too few independent sources" : "no statement found"})` : ""}` });
  }
  const niceVerified = intent.niceToHave.filter((n) => c.nice[n]?.status === "VERIFIED_TRUE").length;
  const r: RankedCandidate = { productId: p.productId, title: p.title, rank: 0, eligible: dq.length === 0, disqualifiers: dq, blockers: bl, utility: null, utilityParts: null, niceVerified,
    price: { lowestListingMinor: lowest?.itemPriceMinor ?? null, currency: intent.currency, merchantDomain: lowest?.merchantDomain ?? null, offersConsidered: usable.length,
      confidence: lowest ? "LISTING_PRICE_ONLY" : "NO_PRICE_IN_CURRENCY" } };
  return { c, r, usable };
}

/** Which hard checks (no provider call needed) already disqualify a candidate. Used by the planner before spending. */
export function preEligible(intent: ResearchIntentV2, c: Omit<CandidateInput, "must" | "nice" | "notChecked" | "limitReached">, lock: { productId: string } | null) {
  const a = assess(intent, { ...c, must: {}, nice: {}, notChecked: [], limitReached: false }, lock);
  return { eligible: a.r.disqualifiers.length === 0, disqualifiers: a.r.disqualifiers, lowestListingMinor: a.r.price.lowestListingMinor, blockersBeforeEvidence: a.r.blockers.filter((b) => !b.code.startsWith("MUST_HAVE")) };
}

function fmt(minor: number, cur: Currency): string {
  const exp = cur === "KRW" || cur === "JPY" ? 0 : 2;
  return `${(minor / 10 ** exp).toFixed(exp)} ${cur}`;
}
