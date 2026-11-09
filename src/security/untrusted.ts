import type { UntrustedText } from "../domain/types.js";

export type UntrustedFlag = "INSTRUCTION_LIKE" | "PAYMENT_INSTRUCTION" | "AUTHORIZATION_CLAIM" | "ROLE_MARKUP";

const RULES: Array<[UntrustedFlag, RegExp]> = [
  ["INSTRUCTION_LIKE", /\b(ignore|disregard|override)\b.{0,30}\b(previous|prior|all|above|system)\b/i],
  ["INSTRUCTION_LIKE", /\b(ai|llm|assistant|agent)s?\b.{0,20}\b(must|should|call|execute|run)\b/i],
  ["PAYMENT_INSTRUCTION", /\b(approve|authori[sz]e|charge|capture|pay|transfer|prepare_checkout|checkout)\b.{0,60}(\$\s?\d|\d{3,}|minor)/i],
  ["AUTHORIZATION_CLAIM", /\b(pre-?approved|already approved|user (has )?(approved|authori[sz]ed|consented))\b/i],
  ["ROLE_MARKUP", /(<\/?(system|tool|assistant)>|^\s*(system|assistant)\s*:|system notice)/im],
];

export interface InspectedText {
  origin: string;
  /** Third-party text, truncated. Presented as data only. */
  text: string;
  trusted: false;
  flags: UntrustedFlag[];
}

/**
 * Classifies third-party text (listings, reviews, product pages). The engine never
 * executes or obeys this text; flags only make manipulation attempts visible and
 * let merchant-authored manipulation exclude an offer.
 */
export function inspectUntrusted(item: UntrustedText): InspectedText {
  const text = item.text.slice(0, 500);
  const flags = [...new Set(RULES.filter(([, re]) => re.test(item.text)).map(([f]) => f))];
  return { origin: item.origin, text, trusted: false, flags };
}

export function isManipulative(i: InspectedText): boolean {
  return i.flags.some((f) => f === "PAYMENT_INSTRUCTION" || f === "AUTHORIZATION_CLAIM" || f === "ROLE_MARKUP") ||
    i.flags.includes("INSTRUCTION_LIKE");
}
