import type { CatalogProduct, EvidenceKind } from "../domain/types.js";
import { mentionsExactModel, normalizeKey, parseAttributes, type AttributeAxis } from "../identity/ProductIdentityExtractor.js";
import { factsOf } from "../identity/ProductResolverV2.js";
import { clauseStatement } from "../research/capabilities.js";
import { jaccard, registrableDomain, shingles, hostOf, type SourceClass, type SourceRegistry } from "./SourceRegistry.js";

/**
 * Evidence statements and the V2 sufficiency rule (research V2). Pure functions; the router does I/O and metering.
 *
 * STATEMENT RULE: a search result yields a statement about (product, capability) only when (see statementFrom for attribution)
 *   (a) its title+snippet names the exact model (separator-tolerant; a family extension such as "Pro" is a different model),
 *   (b) one clause of the snippet states the capability explicitly (negation must govern the phrase),
 *   (c) that clause does not name a different value of an attribute the product has ("the 8-cup model" ≠ 12-cup),
 *   (d) it is not a comparison-table row (pipe-separated cells cannot be attributed to one product).
 * SUFFICIENCY RULE (V2), per capability:
 *   VERIFIED  ← the manufacturer's own domain states it, or ≥ 2 independent expert groups agree; an expert group is a
 *               registrable domain, and near-identical text on several domains (syndication, Jaccard ≥ 0.6) is ONE group.
 *   CONTRADICTED ← counted sources disagree (manufacturer vs expert, or expert vs expert). Never resolved automatically.
 *   UNVERIFIED ← anything else. Retailer pages, forums, unknown sites, stale pages (> 4 years) and catalog key features
 *               are reported but never counted: a snippet never becomes verified except through this rule.
 */
export type EvidenceStatus = "VERIFIED_TRUE" | "VERIFIED_FALSE" | "CONTRADICTED" | "UNVERIFIED";
export interface EvidenceItem {
  url: string; domain: string; sourceClass: SourceClass; value: boolean; quote: string; publishedDate: string | null;
  provider: string; requestId: string | null; observedAt: string;
  counts: boolean; whyNotCounted: string | null;
}
export interface CapabilityVerdict {
  capability: string; status: EvidenceStatus;
  basis: "MANUFACTURER" | "TWO_EXPERT_GROUPS" | "CONFLICT" | "INSUFFICIENT";
  evidence: EvidenceItem[];
  independentGroups: number;
}
export const STALE_AFTER_DAYS = 4 * 365;

export const evidenceKindOf = (c: SourceClass): EvidenceKind =>
  c === "MANUFACTURER" ? "MANUFACTURER" : c === "EXPERT_REVIEW" ? "INDEPENDENT_REVIEW" : c === "RETAILER" ? "RETAILER_ASSERTION" : c === "USER_FORUM" ? "USER_FORUM" : "SEARCH_SNIPPET";

/**
 * Known product brands that are NOT the candidate's (attribution guard, review R-01). Starter data, not exhaustive: a
 * clause that names any of these, or another model code, is about another product and never counts for this one.
 */
export const OTHER_BRAND_WORDS = ["sony", "bose", "apple", "airpods", "beats", "sennheiser", "jbl", "anker", "soundcore", "jabra", "samsung", "google",
  "skullcandy", "audio-technica", "marshall", "shure", "philips", "panasonic", "lg", "dell", "lenovo", "asus", "acer", "microsoft", "macbook", "iphone", "ipad", "dyson", "irobot", "roomba", "breville", "cuisinart", "keurig", "nike", "adidas", "brooks", "hoka", "salomon", "merrell",
  "yeti", "garmin", "fitbit", "xiaomi", "huawei", "oneplus", "logitech", "razer", "corsair", "steelcase", "nespresso", "hydro flask",
  "herman miller", "bang & olufsen", "sonos", "edifier", "1more", "tozo", "jlab", "soundpeats"];
/** Titles of pages that discuss several products. Their statements never count unless the clause names only this model. */
const COMPARISON_TITLE = /\b(?:vs\.?|versus|compared?|comparison|alternatives?|best\b.*\b(?:of|for|under|20\d\d)|top \d+|round-?up|buying guide|which (?:is|should))\b/i;
/** Model-code tokens: letters and digits with a hyphen (WH-1000XM5), 2+ capitals then 2+ digits (QC45), or one capital + 2+ digits (Q20). */
const MODEL_CODE = /(?<![A-Za-z0-9])(?:[A-Z][A-Za-z]*-[A-Z0-9]*\d[A-Z0-9-]*|[A-Z]{2,}\d{2,}[A-Za-z0-9]*|[A-Z]\d{2,}[A-Za-z]?)(?![A-Za-z0-9])/g;
/** Standards and ratings that look like model codes (IP68, MIL-STD-810, USB-C, HDMI-2). */
const NOT_A_MODEL = /^(?:IP[X\d]\d.*|MIL-STD.*|USB.*|HDMI.*|WI-?FI.*|BT\d.*|IEEE.*|ISO.*|ANSI.*|DDR\d.*|PCIE.*|LPDDR.*|UHS.*|RTX\d.*|GTX\d.*)$/i;
const keyOf = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, "");

/** True if `text` names a product other than this one (another brand, another model code, or a family extension). */
export function namesOtherProduct(text: string, product: CatalogProduct): boolean {
  const lower = ` ${text.toLowerCase()} `;
  const own = new Set([product.identity.brand, product.identity.model, product.title].filter(Boolean).join(" ").toLowerCase().split(/[^a-z0-9&-]+/).filter(Boolean));
  const ownBrand = (product.identity.brand ?? "").toLowerCase();
  for (const b of OTHER_BRAND_WORDS) {
    if (b === ownBrand || own.has(b) || ownBrand.includes(b) || b.includes(ownBrand) && ownBrand.length > 2) continue;
    if (new RegExp(`(^|[^a-z0-9])${b.replace(/[.*+?^${}()|[\]\\&]/g, "\\$&")}(?=$|[^a-z0-9])`).test(lower)) return true;
  }
  const model = product.identity.model;
  const ownKey = model ? keyOf(model) : null;
  for (const m of text.matchAll(MODEL_CODE)) {
    const k = keyOf(m[0]);
    if (ownKey && (k === ownKey || ownKey.includes(k))) continue;
    if (own.has(m[0].toLowerCase()) || NOT_A_MODEL.test(m[0])) continue;
    return true;
  }
  // A family extension of this model ("Nova 9 Pro" for "Nova 9"): the loose name is present but the exact model is not.
  if (model && keyOf(text).includes(keyOf(model)) && !mentionsExactModel(text, model)) return true;
  return false;
}

/**
 * Statements one search hit makes about a capability (first attributable clause), or null.
 * ATTRIBUTION (review R-01): a clause counts only if (a) it names this exact model and no other product, or (b) it names
 * no product at all AND the whole hit (title + snippet) names no other product AND the page is not a comparison page
 * (a pronoun clause in a single-product review). Comparison and "best of" pages never count through rule (b).
 */
export function statementFrom(hit: { title: string; snippet: string }, product: CatalogProduct, capability: string): { value: boolean; quote: string } | null {
  const model = product.identity.model;
  const text = `${hit.title}. ${hit.snippet}`;
  if (model) { if (!mentionsExactModel(text, model)) return null; }
  else {
    // No model: the brand plus at least two title words must appear (weak attribution; still needs a counted source).
    const words = product.title.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
    if (!product.identity.brand || !text.toLowerCase().includes(product.identity.brand.toLowerCase()) || words.filter((w) => text.toLowerCase().includes(w)).length < 3) return null;
  }
  const comparisonPage = COMPARISON_TITLE.test(hit.title);
  const hitNamesOther = namesOtherProduct(text, product);
  const facts = factsOf(product);
  for (const clause of hit.snippet.split(/(?<=[.!?])\s+|;\s*|\s+—\s+|:\s+/)) {
    if (/\|/.test(clause) || /\?\s*$/.test(clause)) continue; // table rows and questions are not statements
    const clauseNamesThis = model ? mentionsExactModel(clause, model) : false;
    if (namesOtherProduct(clause, product)) continue;
    if (!clauseNamesThis && (comparisonPage || hitNamesOther)) continue;
    const said = parseAttributes(clause);
    const clash = (Object.keys(said) as AttributeAxis[]).some((a) => a !== "color" && facts.attributes[a] && normalizeKey(said[a]!) !== normalizeKey(facts.attributes[a]!));
    if (clash) continue;
    const v = clauseStatement(clause, capability);
    if (v !== null) return { value: v, quote: clause.trim().slice(0, 300) };
  }
  return null;
}

export function classifyItem(i: Omit<EvidenceItem, "counts" | "whyNotCounted">, now: number): EvidenceItem {
  let why: string | null = null;
  if (i.sourceClass === "RETAILER") why = "retailer/marketplace page (merchant-controlled)";
  else if (i.sourceClass === "USER_FORUM") why = "user forum (anecdotal)";
  else if (i.sourceClass === "UNKNOWN") why = "unregistered site (search snippet only)";
  else if (i.publishedDate && Number.isFinite(Date.parse(i.publishedDate)) && now - Date.parse(i.publishedDate) > STALE_AFTER_DAYS * 86400_000) why = "stale (published more than 4 years ago)";
  return { ...i, counts: why === null, whyNotCounted: why };
}

export function judgeV2(capability: string, items: EvidenceItem[]): CapabilityVerdict {
  const counted = items.filter((x) => x.counts);
  const manu = counted.filter((x) => x.sourceClass === "MANUFACTURER");
  const expert = counted.filter((x) => x.sourceClass === "EXPERT_REVIEW");
  // Expert groups: one per registrable domain; near-identical text across domains merges groups (syndication).
  const groups: Array<{ domains: Set<string>; prints: Array<Set<string>>; values: Set<boolean> }> = [];
  for (const e of expert) {
    const d = registrableDomain(e.domain); const sh = shingles(e.quote);
    const g = groups.find((x) => x.domains.has(d) || x.prints.some((p) => jaccard(p, sh) >= 0.6));
    if (g) { g.domains.add(d); g.prints.push(sh); g.values.add(e.value); } else groups.push({ domains: new Set([d]), prints: [sh], values: new Set([e.value]) });
  }
  const values = new Set([...manu.map((m) => m.value), ...groups.flatMap((g) => [...g.values])]);
  if (values.size > 1) return { capability, status: "CONTRADICTED", basis: "CONFLICT", evidence: items, independentGroups: groups.length };
  if (manu.length) return { capability, status: manu[0]!.value ? "VERIFIED_TRUE" : "VERIFIED_FALSE", basis: "MANUFACTURER", evidence: items, independentGroups: groups.length };
  if (groups.length >= 2) { const v = [...groups[0]!.values][0]!; return { capability, status: v ? "VERIFIED_TRUE" : "VERIFIED_FALSE", basis: "TWO_EXPERT_GROUPS", evidence: items, independentGroups: groups.length }; }
  return { capability, status: "UNVERIFIED", basis: "INSUFFICIENT", evidence: items, independentGroups: groups.length };
}

export { hostOf };
