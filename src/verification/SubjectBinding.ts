/**
 * E4.1 shared subject binding (architecture experiment, research/architecture/).
 *
 * One representation of "who a statement is about", used by the obligation kernel for BOTH positive evidence (K2) and
 * contradictions (K3), so the two can never disagree about a page:
 *
 *  - Page subject: the listing a page title names. A title names listing L when it holds L's model words, every word of
 *    L's product name that sets L apart from another listing the title also matches ("Stand" in "Kerfwright 10 Stand
 *    Table Saw"), and no product noun right after the model that L's own title lacks ("Veltra 20 Tablet Holder",
 *    "Tallis 60 Rain Cover" are about other products). When several listings qualify, the most specific one wins.
 *  - Claims: every sentence becomes one or more claims with a subject, an optional condition and a text.
 *      comparison lead  "Unlike the X, …" / "Compared with … of the X, …": the lead is dropped, the main clause keeps
 *                       its own subject;
 *      condition lead   "With the X fitted, …" / "When paired with X, …": the claim holds only under that condition;
 *      noun subject     a main clause that opens with a noun phrase naming a listing is about that listing; a pronoun or
 *                       an unnamed noun phrase ("It", "The fabric", "Its rack") is about the page subject;
 *      contrast         "A, not B" / "A rather than B" / "A (not B)" is a positive claim A and a negative claim "not B".
 *  - A claim credits or contradicts product R only when its subject is R and it carries no condition.
 *
 * Frozen lists only (comparison leads, condition leads, contrast connectors, page words, verbs); no case strings.
 */
import type { CatalogProduct } from "../domain/types.js";
import { clauseStatement } from "../research/capabilities.js";
import { GENERIC_WORDS } from "../identity/ProductIdentityExtractor.js";

export const BINDER_VERSION = "subject-binder-v0.1.0";
export type Subject = { kind: "LISTING"; productId: string; also?: string[] } | { kind: "OTHER"; why: string } | { kind: "UNKNOWN" };
export interface Claim { text: string; subject: Subject; condition: string | null; sentence: string }

const STOP = new Set(("a an the i me my we our us you your it its this that these those is am are was be been with without and or but of to in " +
  "on at for from by as so very really just also too only new").split(/\s+/));
/** Frozen words a page title may add to a product name without naming another product. */
export const PAGE_WORDS = new Set(["specifications", "specification", "specs", "spec", "sheet", "review", "reviews", "official", "manual",
  "product", "page", "overview", "details", "features", "support", "site", "store", "datasheet", "faq", "guide", "info", "information"]);
/** Frozen colour and finish words (a listing variant's colour is not another product). */
const COLOUR = new Set(["black", "white", "grey", "gray", "silver", "blue", "red", "green", "navy", "beige", "brown", "pink", "purple", "orange", "yellow", "gold", "graphite", "charcoal", "matte", "gloss"]);
/** Frozen part and accessory nouns (a phrase ending in one names a part, not the model it fits). */
const PART_NOUNS = new Set(["cover", "holder", "mat", "stand", "insert", "table", "case", "mount", "bundle", "kit", "sleeve", "adapter", "charger",
  "battery", "batterie", "pack", "bag", "strap", "filter", "blade", "remote", "nozzle", "guard", "attachment", "accessory", "accessorie", "part", "spare",
  "replacement", "lid", "pad", "dock", "cable", "extension", "tray", "rack", "shelf", "hood", "screen", "pump", "valve", "hose", "light", "lamp"]);
const headNounOf = (l: CatalogProduct) => words(l.title).filter((w) => !hasDigit(w)).pop() ?? "";
const COMPARE_LEAD = /^\s*(?:unlike|compared (?:with|to)|in contrast to|like|as with|versus|vs\.?)\b[^,]*,\s*/i;
const CONDITION_LEAD = /^\s*(?:with|when|once|if|after|using|paired with|fitted with|equipped with|combined with|in combination with)\b[^,]*,\s*/i;
/** Verbs that end a sentence's subject noun phrase. */
const VERB = /^(?:is|are|was|were|has|have|had|holds?|carries|carry|fits?|weighs?|runs?|rips?|accepts?|cools?|vents?|keeps?|comes?|includes?|offers?|supports?|does|do|can|will|uses?|takes?|packs?|plugs?|slides?|gives?|works?|features?|lets?|provides?|needs?|requires?|reaches?|rated|measures?|sits?|stands?|seats?|sleeps?|brews?|grows?|pours?|lifts?|folds?|gets?|charges?|lasts?|delivers?|makes?|stays?|reads?|handles?|cuts?)$/i;
const PRONOUN = /^(?:it|its|this|they|their|these|those|which|that|both|each|all|every)$/i;
const CONTRAST = /\s*[,—–]\s*(?:but\s+)?(?:not|rather than|instead of)\s+|\s+(?:rather than|instead of)\s+|\s*\((?:not|no)\s+/i;

const norm = (s: string) => s.normalize("NFKC").toLowerCase();
export const words = (s: string): string[] => norm(s).split(/[^a-z0-9가-힣.]+/).map((w) => w.replace(/^\.+|\.+$/g, "")).filter(Boolean)
  .map((w) => (w.length > 3 && /^[a-z]+s$/.test(w) && !w.endsWith("ss") ? w.slice(0, -1) : w));
const tokset = (s: string) => new Set(words(s));
const hasDigit = (w: string) => /\d/.test(w);
/** Words plus exact joins of 2-3 adjacent words ("Kerfwright 10" also yields "kerfwright10"); never substrings. */
function joined(s: string): Set<string> {
  const w = words(s).map((x) => x.replace(/\./g, "")); const out = new Set(words(s));
  for (let i = 0; i < w.length; i++) { if (i + 1 < w.length) out.add(w[i]! + w[i + 1]!); if (i + 2 < w.length) out.add(w[i]! + w[i + 1]! + w[i + 2]!); }
  return out;
}
const brandWords = (l: CatalogProduct) => tokset(l.identity.brand ?? "");
const modelWords = (l: CatalogProduct) => words(l.identity.model ?? "").filter((w) => !brandWords(l).has(w));
/** The product-name part of a listing title: up to the first separator (descriptors after a comma are not the name). */
const nameZone = (l: CatalogProduct) => words(l.title.split(/\s[|–—-]\s|,|\(/)[0] ?? l.title);

/** Listings whose model words all occur in the text (the candidates it could name). */
function modelMatches(text: string, listings: CatalogProduct[]): CatalogProduct[] {
  const t = joined(text); const tw = tokset(text);
  return listings.filter((l) => {
    const m = modelWords(l);
    if (m.length) return m.every((w) => t.has(w));
    const b = [...brandWords(l)]; const nz = nameZone(l).filter((w) => !STOP.has(w) && !GENERIC_WORDS.has(w) && !brandWords(l).has(w));
    return b.length > 0 && b.every((w) => tw.has(w)) && nz.length >= 2 && nz.filter((w) => tw.has(w)).length >= Math.min(3, nz.length);
  });
}
/** The text continues L's model with a word L's title does not have ("Veltra 20 Tablet Holder" for the Veltra 20). */
function continuesModel(text: string, l: CatalogProduct): boolean {
  const m = modelWords(l); if (!m.length) return false;
  // Only the name part of the text (before a separator) is read: "Veltra 20 – Black" is the Veltra 20 in black.
  const t = words(text.split(/\s[|–—-]\s|,|\(|:/)[0] ?? text); const last = m[m.length - 1]!; const lt = tokset(l.title);
  for (let i = t.indexOf(last); i >= 0; i = t.indexOf(last, i + 1)) {
    const next = t[i + 1];
    // Generic product words count here ("Tablet Holder" after the model is another product, even if "tablet" is generic).
    if (next && !lt.has(next) && !PAGE_WORDS.has(next) && !STOP.has(next) && !COLOUR.has(next) && !hasDigit(next)) return true;
  }
  return false;
}
/**
 * The listing a name (a page title or a sentence's subject noun phrase) is about, or OTHER when it names a listed model
 * but is about another product, or UNKNOWN when it names no listing. `requireAll` is false for a sentence subject
 * ("the Tallis 60" names the Tallis 60 without its category noun).
 */
export function nameSubject(text: string, listings: CatalogProduct[], phrase = false): Subject {
  const cands = modelMatches(text, listings);
  if (!cands.length) return { kind: "UNKNOWN" };
  const tw = joined(text);
  // In a sentence's subject phrase, words after the model are another product only when the phrase ends in a product
  // noun ("the Tallis 60 Rain Cover fits …"); otherwise they are the model's own attribute ("… ANC Pro battery life is …").
  const headWord = words(text).filter((w) => !hasDigit(w)).pop() ?? "";
  const productNoun = !phrase || PART_NOUNS.has(headWord) || listings.some((l) => headNounOf(l) === headWord);
  const passes = (l: CatalogProduct, ignoreDescriptors: boolean) => {
    if (productNoun && continuesModel(text, l)) return false;
    // Every word of L's product name that some other candidate's name lacks must be written ("Stand", "Fold", "Mesh"),
    // generic words included: among listings that share a model, a generic word is what makes one of them a variant.
    const nz = nameZone(l);
    const distinct = nz.filter((w) => !STOP.has(w) && !COLOUR.has(w) && !PAGE_WORDS.has(w) && cands.some((o) => o.productId !== l.productId && !tokset(o.title).has(w)));
    // Retailer titles of one model differ by descriptors ("Wireless Noise Cancelling Headphones"); a page naming just the
    // model is then about all of them.
    // A sentence's subject names a product without its product noun ("the Kegra 2 holds …"): there only the modifiers
    // that make a variant ("Nitro", "Stand") are required, never the listing's own head noun or category words.
    const own = phrase ? new Set([headNounOf(l), ...words(`${l.category ?? ""} ${l.research?.categoryTitle ?? ""}`)]) : new Set<string>();
    // A generic descriptor ("Wireless", "Noise Cancelling") is a retailer's description, not a variant name, unless it is
    // part of the listing's model ("Rattick 8 Mesh") or a part noun ("Stand", "Cover").
    const mw = new Set(modelWords(l));
    return distinct.filter((w) => !own.has(w)).filter((w) => !ignoreDescriptors || !GENERIC_WORDS.has(w) || PART_NOUNS.has(w) || mw.has(w)).every((w) => tw.has(w));
  };
  const ok = cands.filter((l) => passes(l, true));
  if (!ok.length) return { kind: "OTHER", why: `names ${cands.map((c) => c.identity.model ?? c.title).join(" / ")} with other product words` };
  // Most specific: the candidate whose written name words are the largest set.
  const score = (l: CatalogProduct) => nameZone(l).filter((w) => tw.has(w)).length;
  const best = Math.max(...ok.map(score));
  const top = ok.filter((l) => score(l) === best);
  // Several listings with the same written name (colour variants, relisted twins, retailer titles with descriptors): the
  // name is about the model they share, so a claim about it is about each of them.
  return { kind: "LISTING", productId: top[0]!.productId, ...(top.length > 1 ? { also: top.slice(1).map((l) => l.productId) } : {}) };
}
export const pageSubject = (title: string, listings: CatalogProduct[]): Subject => nameSubject(title, listings);

const sentencesOf = (text: string) => text.split(/(?<=[.!?。])\s+|;\s*|\n+/).map((x) => x.trim()).filter(Boolean);

/** The subject noun phrase of a main clause: its words before the first verb (at most eight words). */
function subjectPhrase(main: string): string | null {
  const ws = main.trim().split(/\s+/);
  const out: string[] = [];
  for (const w of ws.slice(0, 9)) { const bare = w.replace(/[^\p{L}\p{N}'-]/gu, "");
    // A capitalised word is part of a product name ("Kerfwright 10 Stand"), never the verb.
    if (VERB.test(bare) && bare === bare.toLowerCase()) return out.join(" "); out.push(w); }
  return null;
}
/** Split a clause at a contrast connector: "A, not B" → ["A", "not B"]. */
function contrastParts(clause: string): string[] {
  const m = CONTRAST.exec(clause);
  if (!m || m.index === 0) return [clause];
  const a = clause.slice(0, m.index).trim(); const b = clause.slice(m.index + m[0].length).replace(/\)\s*$/, "").trim();
  if (!a || !b) return [clause];
  return [a, `not ${b}`];
}

export function claimsOf(hit: { title: string; snippet: string }, listings: CatalogProduct[]): Claim[] {
  const page = pageSubject(hit.title, listings);
  const out: Claim[] = [];
  for (const sentence of sentencesOf(hit.snippet)) {
    let main = sentence; let condition: string | null = null;
    const cmp = COMPARE_LEAD.exec(main); if (cmp) main = main.slice(cmp[0].length);
    const cond = CONDITION_LEAD.exec(main); if (cond) { condition = cond[0].replace(/,\s*$/, "").trim(); main = main.slice(cond[0].length); }
    const np = subjectPhrase(main);
    let subject: Subject = page;
    if (np !== null) {
      const first = np.trim().split(/\s+/)[0] ?? "";
      const named = nameSubject(np, listings, true);
      if (named.kind !== "UNKNOWN") subject = named;
      else if (!np.trim() || PRONOUN.test(first) || /^(?:the|its|their)$/i.test(first)) subject = page;
    }
    for (const part of contrastParts(main)) out.push({ text: part, subject, condition, sentence });
  }
  return out;
}
const isSubject = (s: Subject, pid: string) => s.kind === "LISTING" && (s.productId === pid || !!s.also?.includes(pid));

/** What the claims say about R for one requirement key: the first denial wins over any affirmation. */
export function statementFor(claims: Claim[], productId: string, key: string, extraNegative?: (text: string) => boolean): { value: boolean | null; claim: Claim | null; conditional: Claim | null; about: number } {
  let pos: Claim | null = null; let conditional: Claim | null = null; let about = 0;
  for (const c of claims) {
    if (!isSubject(c.subject, productId)) continue;
    about++;
    let v: boolean | null = null;
    try { v = clauseStatement(c.text, key); } catch { v = null; }
    if (v === null && extraNegative?.(c.text)) v = false;
    if (v === null) continue;
    if (c.condition) { conditional ??= c; continue; }
    if (v === false) return { value: false, claim: c, conditional, about };
    pos ??= c;
  }
  return { value: pos ? true : null, claim: pos, conditional, about };
}
/** Number of claims about R (a page that says something about R has been read for R). */
export const claimsAbout = (claims: Claim[], productId: string) => claims.filter((c) => isSubject(c.subject, productId)).length;
export const describe = (s: Subject) => (s.kind === "LISTING" ? [s.productId, ...(s.also ?? [])].join("+") : s.kind === "OTHER" ? `OTHER(${s.why})` : "UNKNOWN");
