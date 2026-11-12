/** Deterministic capability text rules shared by the Evidence Router (search snippets) and page inspection. */

export const CAPABILITY_PHRASE: Record<string, string> = { active_noise_cancellation: "noise cancelling", wireless: "wireless bluetooth", multipoint: "multipoint", over_ear: "over-ear" };

export const CAPABILITY_KEYWORDS: Record<string, RegExp> = {
  active_noise_cancellation: /\b(active )?noise[- ]?cancel(l)?ing\b|\banc\b/i, wireless: /\bwireless\b|\bbluetooth\b/i,
  multipoint: /\bmulti-?point\b|\btwo devices\b/i, over_ear: /\bover[- ]ear\b/i,
};

/** Negation must govern the capability phrase itself ("no ANC", "lacks noise cancelling"), not any "not" in the sentence. */
export const CAPABILITY_NEGATED: Record<string, RegExp> = {
  active_noise_cancellation: /\b(no|lacks?|without|doesn't (?:have|offer|support)|does not (?:have|offer|support))\s+(?:any\s+)?(?:active\s+)?(?:noise[- ]?cancel(?:l)?(?:ing|ation)|anc)\b/i,
  wireless: /\b(no|lacks?|without|doesn't (?:have|offer|support)|does not (?:have|offer|support))\s+(?:any\s+)?(?:wireless|bluetooth)\b|\bwired[- ]only\b/i,
  multipoint: /\b(no|lacks?|without|doesn't (?:have|offer|support)|does not (?:have|offer|support))\s+(?:any\s+)?multi-?point\b/i,
  over_ear: /\bon[- ]ear\b/i,
};

/** Exact model token, tolerant only of separator differences ("WH-CH720N" ≈ "WH CH720N" ≈ "WHCH720N"). */
export function modelPattern(modelToken: string): RegExp {
  const body = modelToken.replace(/[^A-Za-z0-9]/g, "").split("").map((ch) => ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[- ]?");
  return new RegExp(`(^|[^A-Za-z0-9])${body}($|[^A-Za-z0-9])`, "i");
}
