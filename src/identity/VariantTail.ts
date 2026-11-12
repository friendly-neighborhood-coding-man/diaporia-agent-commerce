/**
 * V2.9: variant words after a model code are compared by the whole name, never by an allow-list of suffixes.
 *
 * Every fresh set found a new suffix word that the model parse dropped ("EQ", "HD", "Dual", "4K", "XL", "Cordless"):
 * a closed list of model extensions cannot be complete. So identity is decided by comparing names around the model
 * CODE (the model up to its first token with a digit: "R9", "B-10", "BM 3"):
 *  - REQUEST SIDE: every name word the user wrote after the code (capitalized or with a digit; colours, units, product
 *    nouns and categories excepted) must appear in the listing title. "R9 Dual" never matches "Rovelo R9 Electric Scooter".
 *  - SIBLING SIDE: listings that parse to the same model are compared by the words after the code. A word one sibling
 *    has and the others lack is a variant word: a listing whose variant words the request did not write is a different
 *    product. The listing that covers most request words, with the fewest unrequested variant words, is the product;
 *    a tie between different variants fails closed (nothing is locked).
 *  - EVIDENCE: a page that names the code followed by a name word this product's title does not have ("A5 4K" for the
 *    A5) is about another variant and never counts.
 */
import { COLOR_WORDS, GENERIC_WORDS, PRODUCT_NOUN_PHRASES, UNIT_TOKEN, parseAttributes } from "./ProductIdentityExtractor.js";
import { requestCategory } from "../research/capabilities.js";

const STOP = /^(?:with|without|for|under|below|over|that|which|and|or|in|from|but|not|please|budget|max|to|at|on|by|less|no|than|is|are|was|it|so|as|only|if|i|the|a|an|my|his|her|our|their|your|this|these|those|me|you|we|he|she|they|thanks|thank|any|good|today|now)$/i;
const NOT_NAME = /^(?:hi|hello|hey|thanks|thank|please|i|i'?m|we|you|my|our|it|is|are|the|a|an|for|and|or|with|new|used|refurbished|renewed|original|genuine|official|replacement|spare)$/i;
export const canon = (w: string) => w.normalize("NFKC").toLowerCase().replace(/[^a-z0-9가-힣]/g, "");
const PAGE_WORDS = /^(?:review|reviews|reviewed|specifications?|specs?|manual|guide|vs|versus|comparison|compared|hands-on|test|tested|price|prices|deal|deals|support|faq|overview|features?|owners?|users?|setup|unboxing|update|firmware|announced|launch|launches|launched|release|released|deep|first|full|long-term|buying|buyers?|tips|problems?|issues?|explained|rating|ratings)$/i;
const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The model code: the model's words up to and including its first word with a digit ("R9 Dual" → "R9", "BM 3 HD" → "BM 3"). */
export function modelCode(model: string | null | undefined): string | null {
  if (!model) return null;
  const ws = model.split(/\s+/).filter(Boolean);
  const k = ws.findIndex((w) => /\d/.test(w));
  return k < 0 ? null : ws.slice(0, k + 1).join(" ");
}
function codeRe(code: string): RegExp {
  // V2.14: a unit model number matches spaced or joined ("40cm" / "40 cm").
  const body = code.split(/[\s-]+/).filter(Boolean).map((w) => esc(w).replace(/^(\d+(?:\\\.\d+)?)([A-Za-z]+)$/, "$1\\s*$2")).join("[-\\s]*");
  return new RegExp(`(?<![A-Za-z0-9])${body}(?![A-Za-z0-9])`, "gi");
}
/** Words after one mention of the code, up to punctuation, a connector or 5 words. */
function tailAt(text: string, end: number): string[] {
  const out: string[] = [];
  for (const raw of text.slice(end).split(/\s+/).filter(Boolean)) {
    if (/^[,;:()|/–—!?.&+]/.test(raw)) break;
    if (/^w\/|^\+$/i.test(raw)) break;
    const w = raw.replace(/[,;:()|!?.]+$/, "").replace(/^[("']+/, "");
    if (!w || STOP.test(w)) break;
    out.push(w);
    if (w !== raw || out.length >= 5) break;
  }
  return out;
}
/** Words after the first mention of the code (after the brand when it is named). */
export function tailAfter(text: string, brand: string | null, code: string): string[] | null {
  const t = text.normalize("NFKC");
  let from = 0;
  if (brand) { const b = new RegExp(`(?<![A-Za-z0-9])${esc(brand)}(?![A-Za-z0-9])`, "i").exec(t); if (b) from = b.index + b[0].length; }
  const re = codeRe(code); re.lastIndex = 0;
  for (const m of t.matchAll(re)) if (m.index! >= from) return tailAt(t, m.index! + m[0].length);
  return null;
}
/** Words that are never a variant name: colours, units and attribute values (they are attribute axes, checked elsewhere). */
function attributeWord(w: string): boolean {
  const lw = w.toLowerCase();
  return !!COLOR_WORDS[lw] || (UNIT_TOKEN.test(w) && !/^\d+[kKgG]$/.test(w)) || (Object.keys(parseAttributes(w)).length > 0 && !/^\d+[kKgG]$/.test(w));
}
/** A name word the request wrote after the code: capitalized or with a digit, and not a colour, unit, product noun or category. */
export function requestNameWord(w: string): boolean {
  if (!/^[A-Z0-9]/.test(w) || NOT_NAME.test(w) || attributeWord(w)) return false;
  const lw = w.toLowerCase();
  if (new RegExp(`^(?:${PRODUCT_NOUN_PHRASES.source})$`, "i").test(lw) || requestCategory(lw)) return false;
  return true;
}
/** Request name words after the code that the listing title does not contain. */
export function missingNameWords(title: string, reqWords: string[]): string[] {
  const have = new Set(title.normalize("NFKC").split(/[\s,;:()|/–—]+/).map(canon).filter(Boolean));
  const squashed = canon(title);
  return reqWords.filter(requestNameWord).filter((w) => !have.has(canon(w)) && !(canon(w).length >= 4 && squashed.includes(canon(w))));
}

/** A word that can name a variant: capitalized or with a digit, and not a colour, unit, generic descriptor, product noun,
 * category or page word ("Dual", "XL", "4K", "Max" are; "Wireless", "Headphones", "Review" are not). */
export function variantWord(w: string): boolean {
  const lw = w.toLowerCase();
  return /^[A-Z0-9]/.test(w) && !attributeWord(w) && !GENERIC_WORDS.has(lw) && !new RegExp(`^(?:${PRODUCT_NOUN_PHRASES.source})$`, "i").test(lw) && !requestCategory(lw) && !NOT_NAME.test(w) && !PAGE_WORDS.test(w);
}

/** A variant name follows the code directly: the tail up to its first descriptor (generic word, product noun or
 * category) or attribute (colour, size): "R9 Dual Electric Scooter" → Dual; "LX-27 27-inch 4K Monitor" → none. */
export function leadingRun(tail: string[]): string[] {
  const out: string[] = [];
  for (const w of tail) {
    const lw = w.toLowerCase();
    if (capsCode(w)) { out.push(w); continue; }
    if (attributeWord(w) || GENERIC_WORDS.has(lw) || new RegExp(`^(?:${PRODUCT_NOUN_PHRASES.source})$`, "i").test(lw) || requestCategory(lw)) break;
    if (variantWord(w)) out.push(w);
  }
  return out;
}
/** A short upper-case code ("HD", "XL", "SE", "4K", "LTE"): a name token even when it is also a descriptor elsewhere. */
export function capsCode(w: string): boolean {
  return /^[A-Z0-9]{2,4}$/.test(w) && /[A-Z]/.test(w) && !(attributeWord(w) && !/^\d+[kK]$/.test(w)) && !NOT_NAME.test(w);
}
/**
 * Variant runs of sibling titles. A descriptor word ("Cordless", "Wireless") is a variant word too when it is the one
 * word a title inserts right after the code relative to a sibling ("Floska F2 Cordless Water Flosser" vs
 * "Floska F2 Water Flosser"): then it is the only thing that tells the two products apart. The rest of the title must
 * match on at least two words, so "Noise-Cancelling Headphones" vs a bare "Headphones" accessory title is no insertion.
 */
export function variantRuns(titles: string[], brand: string | null, code: string): string[][] {
  const raw = titles.map((t) => (tailAfter(t, brand, code) ?? []).filter((w) => canon(w)));
  const key = (ws: string[]) => ws.filter((w) => !attributeWord(w)).map(canon).join(" ");
  const keys = new Set(raw.map(key));
  const runs = raw.map((ws) => {
    const run = leadingRun(ws);
    const w0 = ws[0];
    const noun = (w: string) => new RegExp(`^(?:${PRODUCT_NOUN_PHRASES.source})$`, "i").test(w.toLowerCase()) || !!requestCategory(w.toLowerCase());
    if (w0 && ws.length > 1 && run[0] !== w0 && /^[A-Z]/.test(w0) && !NOT_NAME.test(w0) && !PAGE_WORDS.test(w0) && (!noun(w0) || capitalizedProductWord(w0)) && !attributeWord(w0) && key(ws.slice(1)).split(" ").length >= 2 && keys.has(key(ws.slice(1)))) return [w0, ...leadingRun(ws.slice(1))];
    return run;
  });
  // V2.13 (IW-13 i24): a product noun inserted before a sibling's whole product phrase ("Mikra 30L Grill Microwave Oven"
  // vs "Mikra 30L Microwave Oven") tells the two apart too; it is never merged away as a descriptor.
  // Words every sibling has ("Action" in "A5 Action Camera" and "A5 4K Action Camera") name none of them apart.
  if (runs.length < 2) return runs;
  const common = runs.slice(1).reduce((acc, r) => new Set([...acc].filter((w) => r.map(canon).includes(w))), new Set(runs[0]!.map(canon)));
  return runs.map((r) => r.filter((w) => !common.has(canon(w))));
}
/** True if some mention of the code in `text` is followed by the variant run (always true for an empty run). */
export function namesVariantRun(text: string, code: string, run: string[]): boolean {
  if (!run.length) return true;
  const t = text.normalize("NFKC"); const want = run.map(canon);
  for (const m of t.matchAll(codeRe(code))) {
    const tl = tailAt(t, m.index! + m[0].length).map(canon).filter(Boolean);
    if (want.every((w, i) => tl[i] === w)) return true;
    if (want.join("") === (tl.join("")).slice(0, want.join("").length) && want.join("").length) return true;
  }
  return false;
}
/** The variant words a title carries right after its model code ("Kestra A5 4K Action Camera" → "4k"), canonical. */
export function titleVariant(title: string, brand: string | null, model: string | null | undefined): string {
  const code = modelCode(model);
  return code ? leadingRun(tailAfter(title, brand, code) ?? []).map(canon).join(" ") : "";
}

export interface VariantPick<T> { keep: T[]; drop: Array<{ item: T; reason: string; extra: string[] }> }
/**
 * Among listings that parse to the same model, keep the one(s) whose words after the code match the request best.
 * `requestWords` are all words the request wrote after the code (any case).
 */
export function pickVariant<T>(items: T[], titleOf: (x: T) => string, brand: string | null, code: string, requestWords: string[]): VariantPick<T> {
  if (items.length < 2) return { keep: items, drop: [] };
  const want = new Set(requestWords.map(canon));
  const tails = variantRuns(items.map(titleOf), brand, code);
  const common = tails.slice(1).reduce((acc, t) => new Set([...acc].filter((w) => t.map(canon).includes(w))), new Set(tails[0]!.map(canon)));
  const scored = items.map((x, i) => {
    const tl = tails[i]!;
    const covered = tl.filter((w) => want.has(canon(w))).length;
    const extra = tl.filter((w) => !want.has(canon(w)) && !common.has(canon(w)));
    return { x, covered, extra };
  });
  const bestCov = Math.max(...scored.map((s) => s.covered));
  const atCov = scored.filter((s) => s.covered === bestCov);
  const minExtra = Math.min(...atCov.map((s) => s.extra.length));
  const best = atCov.filter((s) => s.extra.length === minExtra);
  const drop: VariantPick<T>["drop"] = [];
  for (const s of scored) if (!best.includes(s)) drop.push({ item: s.x, extra: s.extra, reason: s.extra.length ? `a different variant (the title adds "${s.extra.join(" ")}", which the request does not name)` : "a different variant (another listing matches more of the requested name)" });
  // Different variants tied: the request does not say which one, so nothing is kept (fail closed).
  const variants = new Set(best.map((s) => s.extra.map(canon).sort().join(" ")));
  if (variants.size > 1) return { keep: [], drop: [...drop, ...best.map((s) => ({ item: s.x, extra: s.extra, reason: `the request does not say which variant (${best.map((b) => b.extra.join(" ") || "plain").join(" / ")})` }))] };
  return { keep: best.map((s) => s.x), drop };
}

/** True if some mention of the code in `text` is followed by a name word this product's title does not have. */
export function mentionsOtherVariant(text: string, title: string, code: string): boolean {
  const t = text.normalize("NFKC");
  const titleWords = new Set(title.normalize("NFKC").split(/[\s,;:()|/–—]+/).map(canon));
  for (const m of t.matchAll(codeRe(code))) {
    const next = tailAt(t, m.index! + m[0].length)[0];
    if (next && !titleWords.has(canon(next)) && (variantWord(next) || capsCode(next))) return true;
  }
  return false;
}
/** True if every mention of the code in `text` is followed by a name word this product's title does not have. */
export function namesOtherVariant(text: string, title: string, code: string): boolean {
  const t = text.normalize("NFKC");
  const titleWords = new Set(title.normalize("NFKC").split(/[\s,;:()|/–—]+/).map(canon));
  let mentions = 0, other = 0;
  for (const m of t.matchAll(codeRe(code))) {
    mentions++;
    const next = tailAt(t, m.index! + m[0].length)[0];
    if (!next || titleWords.has(canon(next))) continue;
    if (variantWord(next)) other++;
  }
  return mentions > 0 && other === mentions;
}

/** V2.13: a capitalized word that is a product noun or category ("Grill", "Oven"): written after a model code it is part of the name. */
export function capitalizedProductWord(w: string): boolean {
  return /^[A-Z][a-z]{2,}$/.test(w) && (new RegExp(`^(?:${PRODUCT_NOUN_PHRASES.source})$`, "i").test(w) || !!requestCategory(w.toLowerCase()));
}
