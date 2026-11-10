/**
 * Versioned utility weights for ranking ELIGIBLE candidates (research V2). Weights never apply before hard
 * eligibility: a disqualified candidate is never ranked above an eligible one, whatever its score. Changing any
 * number requires a new version id so recorded decisions stay reproducible.
 */
export interface RankingWeights {
  version: string;
  /** Share of must-haves verified true (always 1 for a blocker-free candidate). */
  suitability: number;
  /** Share of nice-to-haves verified true. Kept larger than `value` so a verified nice-to-have outranks a lower price. */
  niceToHave: number;
  /** Strength of the evidence behind the must-haves (manufacturer or two expert groups = 1). */
  evidence: number;
  /** Price relative to the cheapest eligible listing (cheapest = 1). */
  value: number;
  /** Price confidence: requested currency, in stock, condition confirmed. */
  costConfidence: number;
  /** Merchant signal: number of distinct merchants with a usable listing (capped). */
  merchant: number;
  /** Freshness of the listing observation. */
  freshness: number;
  /** Penalty per unresolved blocker (only relevant among INVESTIGATE candidates). */
  uncertaintyPenalty: number;
}

export const RANK_V2_BEST: RankingWeights = { version: "rank-v2.0.0/best-suitability", suitability: 0.30, niceToHave: 0.25, evidence: 0.10, value: 0.15,
  costConfidence: 0.10, merchant: 0.05, freshness: 0.05, uncertaintyPenalty: 0.05 };
/** Objective "cheapest": value counts more, nice-to-haves still break ties first among equally verified items. */
export const RANK_V2_CHEAPEST: RankingWeights = { version: "rank-v2.0.0/lowest-price", suitability: 0.30, niceToHave: 0.20, evidence: 0.05, value: 0.19,
  costConfidence: 0.10, merchant: 0.03, freshness: 0.03, uncertaintyPenalty: 0.10 };

export function weightsFor(objective: "LOWEST_VERIFIED_TOTAL" | "BEST_SUITABILITY", override?: RankingWeights | null): RankingWeights {
  return override ?? (objective === "LOWEST_VERIFIED_TOTAL" ? RANK_V2_CHEAPEST : RANK_V2_BEST);
}
