/**
 * N-01 (IW-2 verification of 7d1fe4f): lossless hard-requirement extraction.
 *
 * Every requirement the user states is kept with its span in the request, whether or not the capability vocabulary
 * (research/capabilities.ts) knows it:
 *  - RECOGNIZED: maps to a capability id the evidence router can verify (e.g. "wireless").
 *  - UNRECOGNIZED: a requirement phrase the vocabulary does not cover ("a warm light", "HDMI 2.1", "온도 조절").
 *    It is never dropped: it becomes an open blocking item (gate key `must:unrecognized:<slug>`) that only evidence
 *    (a future vocabulary) or the human owner (V21-04 confirmation page) can settle.
 *  - EXCLUDED (negative): "without ads", "no ANC", "must not have a touchscreen", "광고 없는". Not verifiable by the
 *    current evidence engine, so also an open blocking item (`must:not:<slug>`), fail closed.
 * Optional preferences ("ideally", "if possible", "있으면 좋") are NICE and never block.
 *
 * The extraction is lexical and conservative: a phrase that only restates the category, a colour/size/storage
 * attribute (parsed separately), the brand/model, a price or a condition is not a requirement.
 */
import { parseAttributes } from "../identity/ProductIdentityExtractor.js";
import { requestCapabilities, requestCategory } from "../research/capabilities.js";

export type RequirementPolarity = "REQUIRED" | "EXCLUDED";
export type RequirementStrength = "MUST" | "NICE";
export interface StatedRequirement {
  /** Gate/requirement key without the "must:" prefix: a capability id, `unrecognized:<slug>` or `not:<slug>`. */
  key: string;
  /** The user's words for it, as written. */
  text: string;
  /** [start, end) in the original request. */
  span: [number, number];
  recognized: boolean;
  capability: string | null;
  polarity: RequirementPolarity;
  strength: RequirementStrength;
  source: "REQUEST_TEXT" | "STRUCTURED_INPUT";
}

const NICE = /\b(ideally|would be nice|nice to have|nice-to-have|preferably|prefer(?:red|ably)?|bonus|if possible|if available|optional(?:ly)?|a plus|would love|bonus points)\b|있으면 좋|선호|가능하면|되면 좋/i;
/** English triggers whose following words state a requirement. Group 1 = the requirement phrase. */
const EN_MUST = [
  /\b(?:must|has to|have to|needs? to|got to|should)\s+(?:have|has|support|include|come with|offer|feature|provide|be|use|work with|do)\s+(.+)/i,
  /\b(?:i\s+)?(?:need|require)s?\s+(?:it\s+to\s+(?:have|support|be)\s+)?(?!to\b)(.+)/i,
  /\b(?:only if it|as long as it)\s+(?:has|supports|includes|is|comes with)\s+(.+)/i,
  /\b(?:with|featuring|that has|that have|which has|that supports?|which supports?|that comes with|that includes)\s+(.+)/i,
  /\b(?:required|essential|mandatory|non-negotiable)\s*:\s*(.+)/i,
  /(.+?)\s+(?:is|are)\s+(?:a must|required|essential|mandatory|non-negotiable)\b/i,
  /^(?:\s*(?:and|also)\s+)?(.+?)\s+(?:would be nice|would be a plus|would be great|is a plus|is a bonus|is optional|is nice to have)\b/i,
];
const EN_NOT = [
  /\b(?:without|free of)\s+(?:an?\s+|any\s+)?(.+)/i,
  /\b(?:must|should|can)\s*(?:not|n't)\s+(?:have|include|use|come with|be)\s+(.+)/i,
  /\bno\s+(.+)/i,
  /\b([a-z][a-z0-9 -]{1,30})-free\b/i,
];
/** Korean: "<X> 있어야/돼야/필수/꼭", adjectival "<X> 되는/지원되는/가능한/있는/달린/탑재된", negative "<X> 없는/없어야/제외". */
const KO_MUST = [/([가-힣A-Za-z0-9.+\- ]{1,24}?)\s*(?:이|가)?\s*있으면\s*좋/, /([가-힣A-Za-z0-9.+\- ]{1,24}?)\s*(?:이|가|은|는)?\s*(?:꼭\s*)?(?:있어야|되어야|돼야|지원해야|필수|반드시)/, /([가-힣A-Za-z0-9.+\-]{1,16}(?:\s[가-힣A-Za-z0-9.+\-]{1,16})?)\s*(?:기능\s*)?(?:이|가)?\s*(?:되는|지원되는|지원하는|가능한|있는|달린|탑재된|탑재)\s/];
const KO_NOT = [/([가-힣A-Za-z0-9.+\-]{1,16}(?:\s[가-힣A-Za-z0-9.+\-]{1,16})?)\s*(?:이|가)?\s*(?:없는|없어야|없이)/, /([가-힣A-Za-z0-9.+\-]{1,16})\s*제외/];

/** Phrase ends: budget, price, conditions, the next requirement, punctuation. */
const CUT = /\s+(?:with(?:out)?|that|which|featuring|under|below|less than|at most|max(?:imum)?|up to \$|budget|for (?:less|under|about|around)|and (?:it |also |under|ideally|preferably)|but|so|please|if possible|ideally|preferably|in (?:black|white|any colou?r)|from|at|by|ships?|delivered|within)\b|\s+\$|[,;.!?()]|\s+\d[\d,.]*\s*(?:usd|eur|krw|dollars?|원|달러|만\s*원)\b/i;
const FILLER = /^(?:a|an|the|some|any|good|great|decent|real|proper|built-in|builtin|an? built-in|it|that|which|to have|to)\s+/i;
/** Phrases that are never a product requirement on their own. */
const NOT_REQUIREMENT = /^(?:it|this|that|them|me|my|you|one|ones|more than|more|less|budget|bundles?|bundle|kit|rush|preference|returns?|refurb(?:ished)?|used|new|warranty card|price|money|cost|tax|shipping cost|one of these|limit|cap|object|issues?|problems?|questions?|doubt|matter)$/i;
const NOT_REQUIREMENT_START = /^(?:no (?:bundles?|kits?|more than|budget|rush|preference)|more than|less than|later than|earlier than|longer than|budget|price|money|cost|i |me |my |you |we |us |our |to buy|to order|to get|to pay|to spend|to know|to check|it (?:by|before|for)|bundle|bundles|kit|kits|rush|preference)\b/i;
const NUMBERISH = /^[\d\s.,$€£₩%+-]*$/;

export const slugOf = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[^a-z0-9가-힣.+]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);

function clean(raw: string): string {
  let p = raw.split(CUT)[0] ?? "";
  for (let i = 0; i < 3; i++) p = p.trim().replace(FILLER, "").replace(/\s*(?:기능)?(?:이|가|은|는|을|를|도)?$/, "");
  return p.replace(/\s+/g, " ").trim().split(" ").slice(0, 7).join(" ");
}

/** True if the phrase only restates things parsed elsewhere (category noun, attributes, brand/model, numbers). */
function onlyRestates(phrase: string, targetWords: Set<string>): boolean {
  if (!phrase || NUMBERISH.test(phrase) || phrase.length < 2) return true;
  if (NOT_REQUIREMENT.test(phrase) || NOT_REQUIREMENT_START.test(phrase)) return true;
  let rest = phrase;
  const attrs = parseAttributes(phrase);
  if (Object.keys(attrs).length) rest = rest.replace(/\b\d+(?:\.\d+)?\s?(?:gb|tb|oz|ml|l|cups?|qt|inch(?:es)?|in|")\b|\b(?:20[0-3]\d)\b/gi, " ").replace(/\b(?:of\s+)?(?:ram|memory|ssd|storage|capacity|colou?r|size)\b/gi, " ");
  const cat = requestCategory(rest);
  if (cat) rest = rest.replace(cat.request, " ");
  rest = rest.split(/\s+/).filter((w) => w && !targetWords.has(w.toLowerCase()) && !/^(?:a|an|the|of|in|and|or|for|to|one|color|colour|version|model|edition|screen|display|storage|memory|ram|capacity|size|finish)$/i.test(w)).join(" ");
  if (Object.keys(attrs).length && attrs.color) rest = rest.replace(new RegExp(`\\b${attrs.color}\\b`, "i"), " ").trim();
  return !rest.trim() || NUMBERISH.test(rest);
}

/**
 * All requirements stated in `text`. `targetSpan` is the exact product phrase (its words are the product, not a
 * requirement). Structured must-haves from the caller are added as recognized MUST items (they can only add).
 */
export function extractRequirements(text: string, targetSpan: [number, number] | null, targetWords: string[] = [], structured: { mustHave?: string[]; niceToHave?: string[] } = {}): StatedRequirement[] {
  const out: StatedRequirement[] = [];
  const tw = new Set(targetWords.flatMap((w) => w.toLowerCase().split(/\s+/)).filter(Boolean));
  const inTarget = (abs: number) => !!targetSpan && abs >= targetSpan[0] && abs < targetSpan[1];
  const add = (r: StatedRequirement) => {
    const same = out.find((x) => x.key === r.key);
    if (!same) { out.push(r); return; }
    if (same.strength === "NICE" && r.strength === "MUST") Object.assign(same, r); // MUST wins over NICE for the same item
  };
  let offset = 0;
  for (const clause of text.split(/(?<=[,;.!?])\s*|\s+(?=but\b)|\s+and\s+(?=(?:a|an|the|it|ideally|preferably|must|should|with|without|no)\b)|\s+(?=(?:그리고|하지만)\s)/i)) {
    if (!clause.trim()) continue;
    const at = Math.max(0, text.indexOf(clause, offset)); offset = at + clause.length;
    const strength: RequirementStrength = NICE.test(clause) ? "NICE" : "MUST";
    // 1. Recognized capabilities, with negation governing them ("without noise cancelling", "no ANC", "노캔 없는").
    const recognizedSpans: Array<[number, number]> = [];
    for (const c of requestCapabilities(clause)) {
      const abs = at + c.index;
      recognizedSpans.push([c.index, c.end]);
      if (inTarget(abs)) continue;
      const before = clause.slice(Math.max(0, c.index - 30), c.index);
      const after = clause.slice(c.end, c.end + 8);
      const negated = /\b(?:without|no|not|never|free of|must not have|mustn't have|doesn't need|don't need|do not need)\s+(?:an?\s+|any\s+)?(?:\w+\s+){0,1}$/i.test(before) || /^\s*(?:이|가)?\s*(?:없는|없어야|없이|제외)/.test(after);
      const words = clause.slice(c.index, c.end);
      if (negated) add({ key: `not:${c.id}`, text: words, span: [abs, at + c.end], recognized: true, capability: c.id, polarity: "EXCLUDED", strength, source: "REQUEST_TEXT" });
      else add({ key: c.id, text: words, span: [abs, at + c.end], recognized: true, capability: c.id, polarity: "REQUIRED", strength, source: "REQUEST_TEXT" });
    }
    // 2. Requirement phrases the vocabulary does not cover.
    const tryPhrase = (m: RegExpExecArray | null, polarity: RequirementPolarity) => {
      if (!m || m[1] === undefined) return;
      const rawStart = m.index + Math.max(0, m[0].indexOf(m[1]));
      const phrase = clean(m[1]);
      if (!phrase) return;
      const pIdx = clause.indexOf(phrase, Math.max(0, rawStart - 1));
      const relStart = pIdx >= 0 ? pIdx : rawStart;
      const abs = at + relStart;
      if (inTarget(abs)) return;
      // Covered by a recognized capability inside the phrase → already handled above.
      if (recognizedSpans.some(([s, e]) => s < relStart + phrase.length && e > relStart)) return;
      if (requestCapabilities(phrase).length) return;
      if (onlyRestates(phrase, tw)) return;
      const key = `${polarity === "EXCLUDED" ? "not" : "unrecognized"}:${slugOf(phrase)}`;
      add({ key, text: phrase, span: [abs, abs + phrase.length], recognized: false, capability: null, polarity, strength, source: "REQUEST_TEXT" });
    };
    for (const re of EN_NOT) tryPhrase(re.exec(clause), "EXCLUDED");
    for (const re of EN_MUST) tryPhrase(re.exec(clause), "REQUIRED");
    for (const re of KO_NOT) tryPhrase(re.exec(clause + " "), "EXCLUDED");
    for (const re of KO_MUST) tryPhrase(re.exec(clause + " "), "REQUIRED");
  }
  // Structured input can ADD requirements; it can never remove or soften one stated in the text.
  for (const id of structured.mustHave ?? []) add({ key: id, text: id, span: [0, 0], recognized: true, capability: id, polarity: "REQUIRED", strength: "MUST", source: "STRUCTURED_INPUT" });
  for (const id of structured.niceToHave ?? []) if (!out.some((x) => x.key === id)) out.push({ key: id, text: id, span: [0, 0], recognized: true, capability: id, polarity: "REQUIRED", strength: "NICE", source: "STRUCTURED_INPUT" });
  // An excluded item supersedes the same capability as required ("no ANC" never asks for ANC).
  for (const x of out.filter((r) => r.polarity === "EXCLUDED" && r.capability)) {
    const i = out.findIndex((r) => r.key === x.capability && r.source === "REQUEST_TEXT");
    if (i >= 0) out.splice(i, 1);
  }
  return out;
}
