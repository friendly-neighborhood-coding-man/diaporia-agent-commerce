import type { CatalogProduct, MerchantOffer } from "../domain/types.js";
import type { Currency } from "../domain/money.js";
import { AXES, mentionsExactModel, normalizeKey, type AttributeAxis } from "../identity/ProductIdentityExtractor.js";
import { factsOf, productWordsLost, targetNounMatch } from "../identity/ProductResolverV2.js";
import { missingNameWords, modelCode } from "../identity/VariantTail.js";
import type { ResearchIntentV2 } from "../intent/ResearchIntentV2.js";
import type { CapabilityVerdict } from "../evidence/EvidenceV2.js";
import { evidenceCapabilityOf, productCategory, propositionWords, PROPOSITION_PREFIX } from "../research/capabilities.js";
import { weightsFor, type RankingWeights } from "./weights.js";
import { uninterpretedKey } from "../intent/Uninterpreted.js";

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
export type Disqualifier = "CATEGORY_MISMATCH" | "NOT_STANDALONE" | "BUNDLE_EXCLUDED" | "ATTRIBUTE_MISMATCH" | "CONDITION_MISMATCH" | "OVER_BUDGET" | "BELOW_STATED_RANGE" | "UNAVAILABLE" | "MUST_HAVE_FALSE" | "NOT_LOCKED_IDENTITY" | "NOT_REQUESTED_MODEL";
export type Blocker = "REQUEST_UNINTERPRETED" | "MUST_HAVE_UNRECOGNIZED" | "MUST_NOT_UNVERIFIABLE" | "MUST_HAVE_UNVERIFIED" | "MUST_HAVE_CONTRADICTED" | "VERIFICATION_LIMIT_REACHED" | "PRICE_NOT_IN_REQUESTED_CURRENCY" | "BUDGET_TIGHT" | "AVAILABILITY_UNKNOWN" | "CONDITION_UNCONFIRMED" | "ATTRIBUTE_UNKNOWN";

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
  /**
   * V2.12: what a merchant quote already shows each offer costs before tax (item + known shipping + known fees), by
   * offerId. Tax without a destination is unknown, so this is a lower bound of the total, never a verified total.
   */
  knownCostMinor?: Record<string, number>;
}
export interface RankedCandidate {
  productId: string; title: string; rank: number; eligible: boolean;
  disqualifiers: Array<{ code: Disqualifier; detail: string }>;
  blockers: Array<{ code: Blocker; detail: string }>;
  utility: number | null;
  utilityParts: Record<string, number> | null;
  niceVerified: number;
  /**
   * V2.2 WP-4: how each satisfied MUST requirement was established for THIS product (identity binding): by evidence
   * (MANUFACTURER or TWO_EXPERT_GROUPS, with the counted source URLs) or by the catalog identity (the requirement word is
   * the listing's own brand or model).
   */
  satisfied?: Array<{ key: string; basis: "MANUFACTURER" | "TWO_EXPERT_GROUPS" | "CATALOG_IDENTITY"; sources: string[] }>;
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

const REQUIREMENT_BLOCKERS = new Set<string>(["REQUEST_UNINTERPRETED", "MUST_HAVE_UNVERIFIED", "MUST_HAVE_UNRECOGNIZED", "MUST_NOT_UNVERIFIABLE", "VERIFICATION_LIMIT_REACHED", "MUST_HAVE_CONTRADICTED", "ATTRIBUTE_UNKNOWN"]);
const DISCLAIMER = "Research decision only. It is not a payment authorization: spending requires a user-created purchase mandate and PayPal buyer approval. Listing prices are search-time prices, not verified totals.";
const eq = (a: string, b: string) => normalizeKey(a) === normalizeKey(b);

export function decide(intent: ResearchIntentV2, inputs: CandidateInput[], o: { exactLock?: { productId: string } | null; exactFailure?: string | null; weights?: RankingWeights | null; now: number }): Decision {
  const w = weightsFor(intent.objective, o.weights);
  const assessed = inputs.map((c) => assess(intent, c, o.exactLock ?? null));
  const eligible = assessed.filter((a) => a.r.eligible);
  const cheapest = Math.min(...eligible.map((a) => a.r.price.lowestListingMinor ?? Infinity));
  for (const a of eligible) {
    const p = a.r.price.lowestListingMinor;
    // V2.2 WP-5: every MUST requirement counts, unfamiliar ones included (a proposition verified by evidence is as
    // good as a vocabulary capability verified by evidence).
    const mustN = intent.mustHave.length + (intent.unresolvedMust?.length ?? 0), niceN = intent.niceToHave.length;
    const mustT = a.r.satisfied?.length ?? 0;
    const ev = mustN ? (a.r.satisfied ?? []).length / mustN : 1;
    const merchants = new Set(a.usable.map((x) => x.merchantDomain)).size;
    const fresh = a.usable.length ? Math.max(0, 1 - (o.now - Math.max(...a.usable.map((x) => Date.parse(x.observedAt) || 0))) / (7 * 86400_000)) : 0;
    const parts = { suitability: w.suitability * (mustN ? mustT / mustN : 1), niceToHave: w.niceToHave * (niceN ? a.r.niceVerified / niceN : 0), evidence: w.evidence * ev,
      value: w.value * (p && Number.isFinite(cheapest) ? cheapest / p : 0), costConfidence: w.costConfidence * (a.r.price.confidence === "LISTING_PRICE_ONLY" ? 1 : 0) * (a.r.blockers.some((b) => b.code === "CONDITION_UNCONFIRMED" || b.code === "AVAILABILITY_UNKNOWN") ? 0.5 : 1),
      merchant: w.merchant * Math.min(1, merchants / 3), freshness: w.freshness * fresh, uncertainty: -w.uncertaintyPenalty * a.r.blockers.length };
    a.r.utilityParts = Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, Math.round(v * 1000) / 1000]));
    a.r.utility = Math.round(Object.values(parts).reduce((s, v) => s + v, 0) * 1000) / 1000;
  }
  // Order (review R-03): eligible → fewer blockers → then
  //   both recommendable (no unverified must-have): cheapest objective = price first; best objective = verified
  //     nice-to-haves, then utility (versioned weights), then price. Listing text is never used here.
  //   otherwise (INVESTIGATE candidates): verified nice-to-haves, then the listing-text prior (which unverified candidate
  //     is most likely to pass verification; ordering only, never evidence), then utility, then price.
  const unverifiedMust = (a: (typeof assessed)[number]) => a.r.blockers.some((b) => b.code === "REQUEST_UNINTERPRETED" || b.code === "MUST_HAVE_UNVERIFIED" || b.code === "MUST_HAVE_UNRECOGNIZED" || b.code === "MUST_NOT_UNVERIFIABLE" || b.code === "VERIFICATION_LIMIT_REACHED" || b.code === "MUST_HAVE_CONTRADICTED");
  const price = (a: (typeof assessed)[number]) => a.r.price.lowestListingMinor ?? Infinity;
  // V2.2 WP-5: eligibility first (no score compensates a known violation), then the number of MUST requirements still
  // open (verified eligibility before price: a cheaper listing never outranks one whose requirements are verified),
  // then the other blockers, then the objective.
  const openMust = (a: (typeof assessed)[number]) => a.r.blockers.filter((b) => REQUIREMENT_BLOCKERS.has(b.code)).length;
  const order = [...assessed].sort((x, y) => {
    const head = Number(y.r.eligible) - Number(x.r.eligible) || openMust(x) - openMust(y) || x.r.blockers.length - y.r.blockers.length;
    if (head) return head;
    const tail = (y.r.utility ?? -1) - (x.r.utility ?? -1) || price(x) - price(y) || x.r.disqualifiers.length - y.r.disqualifiers.length;
    if (!unverifiedMust(x) && !unverifiedMust(y))
      return intent.objective === "LOWEST_VERIFIED_TOTAL" ? price(x) - price(y) || y.r.niceVerified - x.r.niceVerified || tail : y.r.niceVerified - x.r.niceVerified || tail;
    return y.r.niceVerified - x.r.niceVerified || (y.c.listingClaims ?? 0) - (x.c.listingClaims ?? 0) || tail;
  });
  order.forEach((a, i) => (a.r.rank = i + 1));
  const ranking = order.map((a) => a.r);
  const best = order[0];
  const holdReasons: string[] = [];
  let state: DecisionState;
  if (intent.budgetConflict) { state = "HOLD"; holdReasons.push(`Budget currency conflict (${intent.budgetConflict}): confirm the budget in ${intent.currency} before research can rank by budget.`); }
  else if (intent.budgetUnresolved) { state = "HOLD"; holdReasons.push(`Budget unresolved (${intent.budgetUnresolved}): confirm the amount and currency before research can rank by budget.`); }
  else if (o.exactFailure) { state = "HOLD"; holdReasons.push(o.exactFailure); }
  else if (best && best.r.eligible && best.r.blockers.length === 0) state = "RECOMMEND";
  else if (best && best.r.eligible) state = "INVESTIGATE";
  else { state = "HOLD"; holdReasons.push(inputs.length ? "Every candidate has a known violation of the request." : "No candidate was found."); }
  if (state === "HOLD" && !o.exactFailure) for (const a of order.slice(0, 5)) holdReasons.push(`${a.r.title}: ${a.r.disqualifiers.map((d) => d.detail).join("; ")}`);

  const factsFor = (a: (typeof order)[number]) => [...new Set([...intent.mustHave, ...(intent.unresolvedMust ?? []).map(evidenceCapabilityOf), ...intent.niceToHave])].flatMap((cap) => {
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
    if (intent.mustHave.length || intent.unresolvedMust?.length) why.push(`Every must-have is verified: ${(a.r.satisfied ?? []).map((x) => `${x.key} (${x.basis === "CATALOG_IDENTITY" ? "catalog identity" : x.basis === "MANUFACTURER" ? "manufacturer" : "two expert sources"})`).join(", ")}.`);
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
        ...(o.exactLock && Object.keys(factsOf(a.c.product).attributes).length === 0 && !a.c.product.identity.variant
          ? ["The listing states no color or variant: confirm which variant ships before purchase."] : []),
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
  // V2.2 WP-3 (H-3): a listing of another model (AP-250 for an AP-400 request) is never eligible, locked or not.
  const wanted = intent.requestedModel;
  // V2.14 (IW-14 i17): the locked listing's model is the requested model plus the tail the request wrote ("Icebox -22"
  // + "Dual Zone"); the resolver already required every tail word, so the locked model is the requested one.
  const lockedTail = !!lock && p.productId === lock.productId && normalizeKey(p.identity.model ?? "").startsWith(normalizeKey(wanted ?? "")) && !!wanted
    && normalizeKey(p.identity.model ?? "") === normalizeKey([wanted, ...(intent.requestTail ?? [])].join(" ")).slice(0, normalizeKey(p.identity.model ?? "").length);
  if (wanted && !lockedTail && !(normalizeKey(p.identity.model ?? "") === normalizeKey(wanted) || mentionsExactModel(p.title, wanted, { generation: f.attributes.generation ?? null })))
    dq.push({ code: "NOT_REQUESTED_MODEL", detail: `not model ${wanted} (listing: ${p.identity.model || "model not stated"})` });
  // V2.4: the product type the request names outside the category vocabulary ("power station", "ear tips") must be
  // in the listing's title; otherwise the candidate is a different kind of product as far as research can tell.
  // V2.5: the named contents of a requested bundle ("pet tool kit") are checked the same way, locked or not.
  // V2.8: the product noun written after the model must be what this listing is ("MD-7 Headphones" is never a metal
  // detector), locked or not.
  // V2.9: every name word the request wrote after the model code ("R9 Dual", "A5 4K") must be in the title.
  const code = modelCode(intent.target?.model);
  if (code && intent.target?.model) {
    const miss = missingNameWords(p.title, [...intent.target.model.split(/\s+/).slice(code.split(/\s+/).length), ...(intent.requestTail ?? [])]);
    if (miss.length) dq.push({ code: "NOT_REQUESTED_MODEL", detail: `the title does not name "${miss.join(" ")}" from the requested model` });
  }
  // V2.13 (IW-13 token invariant): every product word the request wrote after the model of a standalone product is
  // accounted for on THIS listing: a name word is in the title (above), and a product noun ("Grill" in "Mikra 25L Grill
  // microwave") is in the title or is what the listing is (same noun, synonym or category). A product word the listing
  // does not account for is never dropped: the listing is another product.
  if (code && intent.target?.model && intent.target.kind === "STANDALONE") {
    const lost = productWordsLost(p, intent.requestTail ?? []);
    if (lost.length) dq.push({ code: "NOT_REQUESTED_MODEL", detail: `the listing does not account for "${lost.join(" ")}" from the requested product` });
  }
  const nounMatch = targetNounMatch(p, intent.targetNoun);
  if (nounMatch === "NO") dq.push({ code: "NOT_REQUESTED_MODEL", detail: `not a ${intent.targetNoun}: the listing is another kind of product` });
  else if (nounMatch === "UNKNOWN") bl.push({ code: "REQUEST_UNINTERPRETED", detail: `must-have "${uninterpretedKey(intent.targetNoun!)}" ("${intent.targetNoun}") is the product the request names, and the listing does not state it` });
  for (const w of intent.nounModifiers ?? []) {
    const stem = w.replace(/(?:es|s)$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!new RegExp(`(?<![a-z])${stem}e?s?(?![a-z])`, "i").test(p.title))
      bl.push({ code: "REQUEST_UNINTERPRETED", detail: `must-have "${uninterpretedKey(w)}" ("${w}") is part of the product the request names, and the listing title does not state it` });
  }
  if (!lock || intent.target?.kind === "BUNDLE") {
    for (const w of intent.productTypeWords ?? []) {
      const stem = w.toLowerCase().replace(/(?:es|s)$/, "");
      if (!new RegExp(`(?<![a-z])${stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:s|es)?(?![a-z])`, "i").test(p.title))
        bl.push({ code: "REQUEST_UNINTERPRETED", detail: `must-have "${uninterpretedKey(w)}" ("${w}") is the product type the request names, and the listing title does not state it` });
    }
  }
  if (!lock) {
    const cat = productCategory(p);
    if (intent.category && cat && cat !== intent.category) dq.push({ code: "CATEGORY_MISMATCH", detail: `category ${cat}, requested ${intent.category}` });
    if (f.kind === "ACCESSORY") dq.push({ code: "NOT_STANDALONE", detail: `accessory${f.accessoryNoun ? ` (${f.accessoryNoun})` : ""}, not the product itself` });
    if (f.kind === "BUNDLE" && (intent.excludeBundles || intent.attributes.pack === undefined)) dq.push({ code: intent.excludeBundles ? "BUNDLE_EXCLUDED" : "NOT_STANDALONE", detail: "bundle / multi-pack, not the standalone product" });
    // A requested multi-pack is never answered with a single item or a different pack size (holdout-2 q20 regression).
    if (intent.attributes.pack !== undefined && intent.attributes.pack !== "1" && (f.attributes.pack ?? "1") !== intent.attributes.pack)
      dq.push({ code: "ATTRIBUTE_MISMATCH", detail: `pack of ${f.attributes.pack ?? "1"}, requested pack of ${intent.attributes.pack}` });
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
  // V2.17 (IW-17 b08): only offers in the requested condition price the product (a refurbished listing never meets a
  // budget for a new purchase); with none, there is no price.
  const priceOffers = usable.filter((o) => o.listedIdentity.condition === intent.condition).sort((a, b) => a.itemPriceMinor - b.itemPriceMinor);
  const lowest = priceOffers[0] ?? null;
  // V2.2 WP-1: the enforceable inclusive maximum ("under $120" allows at most $119.99) and the lower end of a stated range.
  const maxMinor = intent.budgetMaxMinor !== undefined ? intent.budgetMaxMinor : intent.budgetMinor;
  if (lowest && maxMinor !== null) {
    // V2.12 (IW-12 b10): the budget is checked on what an offer is already known to cost (a quote's item price plus its
    // shipping and fees), not on the listing price alone; the 10% headroom then covers only the still-unknown tax.
    const floorOf = (o: MerchantOffer) => Math.max(o.itemPriceMinor, c.knownCostMinor?.[o.offerId] ?? 0);
    const cheapest = Math.min(...priceOffers.map(floorOf));
    const quoted = c.knownCostMinor && priceOffers.some((o) => c.knownCostMinor![o.offerId] !== undefined);
    if (lowest.itemPriceMinor > maxMinor) dq.push({ code: "OVER_BUDGET", detail: `lowest eligible listing ${fmt(lowest.itemPriceMinor, intent.currency)} is over the budget ${fmt(maxMinor, intent.currency)}` });
    else if (cheapest > maxMinor) dq.push({ code: "OVER_BUDGET", detail: `every offer already costs more than the budget ${fmt(maxMinor, intent.currency)} before tax (lowest ${fmt(cheapest, intent.currency)} with shipping and fees)` });
    else if (cheapest > maxMinor * BUDGET_HEADROOM) bl.push({ code: "BUDGET_TIGHT", detail: quoted
      ? `the lowest known cost ${fmt(cheapest, intent.currency)} (item, shipping and fees) is within 10% of the budget while tax is unknown`
      : `listing ${fmt(lowest.itemPriceMinor, intent.currency)} is within 10% of the budget while shipping and tax are unknown` });
  }
  if (lowest && intent.budgetLowerMinor != null && lowest.itemPriceMinor < intent.budgetLowerMinor)
    dq.push({ code: "BELOW_STATED_RANGE", detail: `lowest eligible listing ${fmt(lowest.itemPriceMinor, intent.currency)} is below the stated price range (from ${fmt(intent.budgetLowerMinor, intent.currency)})` });
  for (const m of intent.mustHave) {
    const v = c.must[m];
    if (v?.status === "VERIFIED_FALSE") dq.push({ code: "MUST_HAVE_FALSE", detail: `must-have "${m}" is false (${v.basis === "MANUFACTURER" ? "manufacturer" : "two expert sources"})` });
    else if (v?.status === "CONTRADICTED") bl.push({ code: "MUST_HAVE_CONTRADICTED", detail: `must-have "${m}": sources contradict each other` });
    else if (v?.status !== "VERIFIED_TRUE") bl.push({ code: c.limitReached && c.notChecked.includes(m) ? "VERIFICATION_LIMIT_REACHED" : "MUST_HAVE_UNVERIFIED",
      detail: `must-have "${m}" is not verified${c.notChecked.includes(m) ? " (not checked)" : v ? ` (${v.evidence.length ? v.evidence.filter((e) => !e.counts).map((e) => e.whyNotCounted).filter(Boolean).slice(0, 2).join("; ") || "too few independent sources" : "no statement found"})` : ""}` });
  }
  const satisfied: NonNullable<RankedCandidate["satisfied"]> = [];
  for (const m of intent.mustHave) { const v = c.must[m]; if (v?.status === "VERIFIED_TRUE") satisfied.push({ key: m, basis: v.basis === "MANUFACTURER" ? "MANUFACTURER" : "TWO_EXPERT_GROUPS", sources: v.evidence.filter((e) => e.counts).map((e) => e.url).slice(0, 4) }); }
  // N-01 / V2.2 WP-4: a stated must-have outside the capability vocabulary (or a negative one) is a generic proposition.
  // It is never dropped or softened: evidence about THIS product verifies it under the same sufficiency rule (a
  // performance claim only with independent evidence), a word that is the listing's own brand or model is satisfied by
  // the catalog identity, evidence that the product fails it is a known violation, and anything else stays open until
  // evidence or the owner (attest or waive) settles it.
  for (const key of intent.unresolvedMust ?? []) {
    const r = intent.requirements?.find((x) => x.key === key);
    const negative = key.startsWith("not:");
    const v = c.must[evidenceCapabilityOf(key)];
    // V2.18 (IW-18 i20): a number with a unit the request wrote ("2200w") is identity: only a listing whose title
    // carries that number and unit is the product; any other listing is a different model, never "unverified".
    const nu = /^unrecognized:(\d+(?:\.\d+)?)-?([a-z]{1,3})$/i.exec(key);
    if (!negative && nu) {
      const has = new RegExp(`(?<![\\d.])${nu[1]!.replace(".", "\\.")}\\s*-?\\s*${nu[2]!}(?![a-z])`, "i").test(p.title);
      if (has) { satisfied.push({ key, basis: "CATALOG_IDENTITY", sources: [] }); continue; }
      dq.push({ code: "NOT_REQUESTED_MODEL", detail: `the request names "${nu[1]}${nu[2]}", which the listing title does not carry` }); continue;
    }
    if (!negative && identityWord(key, p)) { satisfied.push({ key, basis: "CATALOG_IDENTITY", sources: [] }); continue; }
    // V2.14: a word that describes the product type ("folding" trekking poles) is stated by a listing title that names it.
    if (!negative && (r as { note?: string } | undefined)?.note === "TYPE_MODIFIER" && r && new RegExp(`(?<![A-Za-z])${r.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z])`, "i").test(p.title)) { satisfied.push({ key, basis: "CATALOG_IDENTITY", sources: [] }); continue; }
    const holds = negative ? v?.status === "VERIFIED_FALSE" : v?.status === "VERIFIED_TRUE";
    const fails = negative ? v?.status === "VERIFIED_TRUE" : v?.status === "VERIFIED_FALSE";
    if (holds) { satisfied.push({ key, basis: v!.basis === "MANUFACTURER" ? "MANUFACTURER" : "TWO_EXPERT_GROUPS", sources: v!.evidence.filter((e) => e.counts).map((e) => e.url).slice(0, 4) }); continue; }
    if (fails) { dq.push({ code: "MUST_HAVE_FALSE", detail: `must-have "${key}" is false (${negative ? `the product has "${r?.text ?? key.slice(4)}"` : `the product does not have "${r?.text ?? key}"`}; ${v!.basis === "MANUFACTURER" ? "manufacturer" : "two expert sources"})` }); continue; }
    if (v?.status === "CONTRADICTED") { bl.push({ code: "MUST_HAVE_CONTRADICTED", detail: `must-have "${key}": sources contradict each other` }); continue; }
    const why = v && v.evidence.length ? v.evidence.filter((e) => !e.counts).map((e) => e.whyNotCounted).filter(Boolean).slice(0, 2).join("; ") || "too few independent sources" : "no attributable statement found";
    bl.push(negative
      ? { code: "MUST_NOT_UNVERIFIABLE", detail: `must-have "${key}" (must NOT have "${r?.text ?? key.slice(4)}") is not verified for this product (${why})` }
      : { code: "MUST_HAVE_UNRECOGNIZED", detail: `must-have "${key}" ("${r?.text ?? key}") is not verified for this product (${why})` });
  }
  // V2.3 structural guard: a content word of the request that became neither identity, requirement, category nor money
  // is an open MUST item on every candidate (never RECOMMEND/prepare) until the owner attests or waives it.
  for (const u of intent.uninterpreted ?? []) bl.push({ code: "REQUEST_UNINTERPRETED", detail: `must-have "${uninterpretedKey(u.text)}" ("${u.text}") was not interpreted from the request; research could not check it` });
  const niceVerified = intent.niceToHave.filter((n) => c.nice[n]?.status === "VERIFIED_TRUE").length;
  const r: RankedCandidate = { productId: p.productId, title: p.title, rank: 0, eligible: dq.length === 0, disqualifiers: dq, blockers: bl, utility: null, utilityParts: null, niceVerified, satisfied,
    price: { lowestListingMinor: lowest?.itemPriceMinor ?? null, currency: intent.currency, merchantDomain: lowest?.merchantDomain ?? null, offersConsidered: usable.length,
      confidence: lowest ? "LISTING_PRICE_ONLY" : "NO_PRICE_IN_CURRENCY" } };
  return { c, r, usable };
}

/** V2.2 WP-4: the requirement is one word that IS the listing's own brand or a word of its model (catalog identity). */
function identityWord(key: string, p: CatalogProduct): boolean {
  if (!key.startsWith(PROPOSITION_PREFIX)) return false;
  const words = propositionWords(key);
  if (words.length !== 1) return false;
  const w = normalizeKey(words[0]!);
  return !!w && (normalizeKey(p.identity.brand ?? "") === w || (p.identity.model ?? "").split(/\s+/).some((x) => normalizeKey(x) === w));
}

/** Which hard checks (no provider call needed) already disqualify a candidate. Used by the planner before spending. */
export function preEligible(intent: ResearchIntentV2, c: Omit<CandidateInput, "must" | "nice" | "notChecked" | "limitReached">, lock: { productId: string } | null) {
  const a = assess(intent, { ...c, must: {}, nice: {}, notChecked: [], limitReached: false }, lock);
  return { eligible: a.r.disqualifiers.length === 0, disqualifiers: a.r.disqualifiers, lowestListingMinor: a.r.price.lowestListingMinor, blockersBeforeEvidence: a.r.blockers.filter((b) => !b.code.startsWith("MUST_HAVE") && b.code !== "MUST_NOT_UNVERIFIABLE") };
}

function fmt(minor: number, cur: Currency): string {
  const exp = cur === "KRW" || cur === "JPY" ? 0 : 2;
  return `${(minor / 10 ** exp).toFixed(exp)} ${cur}`;
}

