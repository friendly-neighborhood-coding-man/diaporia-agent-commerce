import type { CatalogProduct, EvidenceKind } from "../domain/types.js";
import { mentionsExactModel, normalizeKey, parseAttributes, type AttributeAxis } from "../identity/ProductIdentityExtractor.js";
import { factsOf } from "../identity/ProductResolverV2.js";
import { clauseStatement } from "../research/capabilities.js";
import { jaccard, registrableDomain, shingles, hostOf, type SourceClass, type SourceRegistry } from "./SourceRegistry.js";

/**
 * Evidence statements and the V2 sufficiency rule (research V2). Pure functions; the router does I/O and metering.
 *
 * STATEMENT RULE: a search result yields a statement about (product, capability) only when
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

/** Statements one search hit makes about a capability (first explicit clause), or null. */
export function statementFrom(hit: { title: string; snippet: string }, product: CatalogProduct, capability: string): { value: boolean; quote: string } | null {
  const model = product.identity.model;
  const text = `${hit.title}. ${hit.snippet}`;
  if (model) { if (!mentionsExactModel(text, model)) return null; }
  else {
    // No model: the brand plus at least two title words must appear (weak attribution; still needs a counted source).
    const words = product.title.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
    if (!product.identity.brand || !text.toLowerCase().includes(product.identity.brand.toLowerCase()) || words.filter((w) => text.toLowerCase().includes(w)).length < 3) return null;
  }
  const facts = factsOf(product);
  for (const clause of hit.snippet.split(/(?<=[.!?])\s+|;\s*|\s+—\s+/)) {
    if (/\|/.test(clause)) continue;
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
