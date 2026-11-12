/**
 * EXPERIMENT (branch experiment/haiku55-json-parser): hybrid natural-language interpretation.
 *
 * A semantic interpreter (Claude Haiku 5.5 in this experiment) reads the raw request and returns JSON in the versioned
 * schema `diaporia.semantic-intent.v1` (research/hybrid/PROMPT_V1.txt). This module validates that JSON and merges it
 * into the deterministic TypeScript intent (ResearchIntentV2). It never replaces the TypeScript parse:
 *
 *  A. The original request and the original TypeScript intent are kept (`hybrid.original`).
 *  B. Constraint conservation: a MUST the TypeScript parser read stays a MUST. The interpreter can add or tighten
 *     requirements, never remove one, except a word that the interpreter shows is part of the product's own name
 *     (brand, model, product type or host span) and that is not negated.
 *  C. Numbers: an interpreter number must appear in its own span, and its direction must agree with the span's own
 *     bound word ("at least", "under", "이상", ...). "up to" is never resolved by the interpreter: the user's words are
 *     kept. A disagreement is a blocking open requirement, never a dropped one.
 *  D. Identity: the requested item and its host are kept apart. A changed identity is accepted only when it is more
 *     specific than the TypeScript one, or when TypeScript found none. A conflict in kind (part vs standalone) or in
 *     model blocks the purchase (open requirement) and the TypeScript identity stays.
 *  E. Every accepted element must quote a verbatim span of the request. Anything else is rejected and recorded.
 *  F. Budget, currency, condition, evidence, merchants, offers, checkout and payment are untouched: the interpreter
 *     has no field that can change them.
 */
import { z } from "zod";
import type { PurchaseRequestInput } from "../PurchaseIntentRouter.js";
import type { ResearchIntentV2 } from "../ResearchIntentV2.js";
import { extractRequirements, slugOf, type StatedRequirement } from "../Requirements.js";
import { capabilityPhrase, evidenceCapabilityOf, isPerformanceClaim } from "../../research/capabilities.js";

export const SEMANTIC_INTENT_SCHEMA = "diaporia.semantic-intent.v1" as const;
export const HYBRID_ADAPTER_VERSION = "hybrid-adapter-v1.0.0" as const;

const Span = z.string().min(1).max(400);
const Named = z.object({ text: z.string().max(200), span: Span }).nullable();
export const SemanticIntentV1 = z.object({
  id: z.string().optional(),
  language: z.enum(["en", "ko", "other"]).catch("other"),
  item: z.object({
    kind: z.enum(["STANDALONE", "ACCESSORY", "BUNDLE", "UNKNOWN"]),
    product_type: z.object({ text: z.string().max(200), span: Span.nullable(), en: z.string().max(200) }).nullable(),
    brand: Named.optional().default(null),
    model: Named.optional().default(null),
    host: Named.optional().default(null),
  }),
  constraints: z.array(z.object({
    role: z.enum(["mandatory", "optional", "exclusion", "compatibility", "context"]),
    span: Span,
    en: z.string().min(1).max(300),
    numeric: z.object({ op: z.enum([">=", "<=", "<", ">", "="]), value: z.number().finite(), unit: z.string().max(40).nullable() }).nullable().optional().default(null),
    subject: z.enum(["product", "component", "user", "load", "host", "other"]).catch("other"),
    component: z.string().max(120).nullable().optional().default(null),
  })).max(30),
  budget: z.object({ span: Span }).nullable().optional().default(null),
  condition: z.object({ value: z.enum(["new", "used", "refurbished", "any"]), span: Span }).nullable().optional().default(null),
  ambiguities: z.array(z.object({ issue: z.string().max(400), span: z.string().max(400).nullable() })).max(20).optional().default([]),
  confidence: z.enum(["high", "medium", "low"]).catch("low"),
});
export type SemanticIntent = z.infer<typeof SemanticIntentV1>;

export type HybridMode = "TS_ONLY" | "ALWAYS" | "SELECTIVE";
export interface HybridDecisionLog { what: string; detail: string }
export interface HybridTrace {
  adapter: typeof HYBRID_ADAPTER_VERSION; schema: typeof SEMANTIC_INTENT_SCHEMA; mode: HybridMode;
  escalation: { escalate: boolean; signals: string[] };
  interpreterUsed: boolean; schemaValid: boolean | null;
  identity: "TS" | "INTERPRETER" | "TS_CONFLICT_BLOCKED";
  accepted: HybridDecisionLog[]; rejected: HybridDecisionLog[]; conflicts: HybridDecisionLog[];
  /** The request as written and the TypeScript intent before the merge (A: original request preservation). */
  original: { request: string; mode: string; target: ResearchIntentV2["target"]; requirementKeys: string[]; uninterpreted: string[] };
}

// ---------------------------------------------------------------------------------------------------------- escalation
const NEG = /\b(?:no|not|non|never|without|except|only|[a-z]+n['’]t)\b|없|말고|제외|빼고|만\b/i;
const BOUND = /\b(?:at least|at most|up to|under|below|over|more than|less than|minimum|maximum|max|min|or more|or less|no more than)\b|이상|이하|미만|초과|까지/i;
const UNIT_NUM = /\d[\d,.]*\s*-?\s*(?:lb|lbs|kg|g|cm|mm|m|in|inch|inches|ft|feet|foot|l|liters?|litres?|qt|quarts?|gal|gallons?|w|watts?|kw|v|a|amps?|ah|hp|btu|sq ft|people|persons?|kids|burners?|grains?|%|인용|구|인분)\b/i;
const FOR_X = /\bfor\b|용으로|위한|쓸 수 있는/i;

/**
 * Arm C: when the TypeScript parse may be wrong. Signals are structural and do not trust the TypeScript parser's own
 * silence: a clean parse with a "for X", a bound, a negation, a tail after the model or a part noun still escalates.
 */
export function escalationSignals(iv: ResearchIntentV2, request: string): string[] {
  const s: string[] = [];
  const text = request.normalize("NFKC");
  if (iv.language !== "en" || /[^\x00-\x7F₩€£¥°’‘“”–—×½¼¾]/.test(text.replace(/[가-힣]/g, "")) || /[가-힣]/.test(text)) s.push("LANGUAGE_NOT_ENGLISH");
  if ((iv.uninterpreted ?? []).length) s.push("UNINTERPRETED_WORDS");
  if (iv.requirements.some((r) => r.note === "CONTEXT")) s.push("FOR_X_CLASSIFIED_CONTEXT");
  if (FOR_X.test(text)) s.push("FOR_X_PRESENT");
  if (NEG.test(text)) s.push("NEGATION_OR_ONLY");
  if (BOUND.test(text) && UNIT_NUM.test(text)) s.push("NUMERIC_BOUND");
  else if (UNIT_NUM.test(text) && iv.mode === "PRODUCT_DISCOVERY") s.push("NUMERIC_IN_DISCOVERY");
  if (iv.target && ((iv.requestTail ?? []).length || iv.targetNoun)) s.push("WORDS_AFTER_MODEL");
  if (iv.target?.kind === "ACCESSORY" || iv.target?.kind === "BUNDLE") s.push("ACCESSORY_OR_BUNDLE_KIND");
  if (iv.mode === "PRODUCT_DISCOVERY" && !iv.category && !(iv.productTypeWords ?? []).length) s.push("NO_PRODUCT_TYPE");
  if (iv.requirements.some((r) => r.strength === "MUST" && r.note === "TYPE_MODIFIER" && /^[A-Z]/.test(r.text))) s.push("CAPITALIZED_TYPE_MODIFIER");
  if (!iv.target && /\b[A-Z][a-z]+\s+[A-Z][A-Za-z]+/.test(text)) s.push("CAPITALIZED_NAME_NO_TARGET");
  return s;
}

// ------------------------------------------------------------------------------------------------------------- helpers
const norm = (x: string) => x.normalize("NFKC");
function locate(text: string, span: string | null | undefined, lower = false): [number, number] | null {
  if (!span) return null;
  const sp = norm(span);
  let i = text.indexOf(sp);
  if (i < 0 && lower) i = text.toLowerCase().indexOf(sp.toLowerCase());
  return i < 0 ? null : [i, i + sp.length];
}
const overlaps = (a: [number, number], b: [number, number]) => a[0] < b[1] && b[0] < a[1];
const inside = (a: [number, number], b: [number, number]) => a[0] >= b[0] && a[1] <= b[1];
const NEGATED_AT = (text: string, at: number) => /\b(?:no|not|non|never|without|[a-z]+n['’]t)\s+(?:\S+\s+){0,2}$/i.test(text.slice(Math.max(0, at - 30), at)) || /없|말고|제외/.test(text.slice(at, at + 12));

const KO_DIGITS: Record<string, number> = { 한: 1, 두: 2, 세: 3, 네: 4, 다섯: 5 };
function numbersIn(span: string): number[] {
  const out = [...span.replace(/(\d),(\d{3})/g, "$1$2").matchAll(/\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
  const W: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12 };
  for (const [w, n] of Object.entries(W)) if (new RegExp(`\\b${w}\\b`, "i").test(span)) out.push(n);
  for (const [w, n] of Object.entries(KO_DIGITS)) if (span.includes(w)) out.push(n);
  return out;
}
/** The bound direction the user's own words state for a number, or "UP_TO" (never resolved here), or null. */
function lexicalBound(span: string): ">=" | "<=" | ">" | "<" | "UP_TO" | null {
  if (/\bup to\b|까지/i.test(span)) return "UP_TO";
  if (/\b(?:at least|minimum|min\.?|or more|or above|and up|plus)\b|이상|\+/i.test(span)) return ">=";
  if (/\b(?:more than|over|above)\b|초과/i.test(span)) return ">";
  if (/\b(?:at most|maximum|max\.?|no more than|or less|or under)\b|이하/i.test(span)) return "<=";
  if (/\b(?:under|below|less than|lighter than)\b|미만/i.test(span)) return "<";
  return null;
}
const sameDirection = (a: string, b: string) => (a === b) || ([">=", ">"].includes(a) && [">=", ">"].includes(b)) || (["<=", "<"].includes(a) && ["<=", "<"].includes(b));

function requirementFrom(text: string, span: [number, number], polarity: "REQUIRED" | "EXCLUDED", strength: "MUST" | "NICE", phrase: string): StatedRequirement {
  // The TypeScript extractor reads the phrase so the key/proposition shape is the one the evidence engine already knows.
  const rs = extractRequirements(`item with ${phrase}`, null, []).filter((r) => r.note !== "CATEGORY_WORD");
  let one = rs.length === 1 && rs[0]!.note !== "CONTEXT" ? rs[0]! : null;
  // The extractor's shape is used only when it keeps the phrase's numbers ("at least a 15 lb pellet bin" must not become "lb").
  const digits = phrase.match(/\d+(?:[.,]\d+)*/g) ?? [];
  if (one && digits.some((d) => !`${one!.key} ${one!.text}`.replace(/,/g, "").includes(d.replace(/,/g, "")))) one = null;
  let r: StatedRequirement;
  if (one && one.polarity === polarity) r = { ...one, text: text.slice(span[0], span[1]), span, strength, source: "REQUEST_TEXT" };
  else {
    // Negation words are removed only for an exclusion; a requirement keeps them ("no side rails" never becomes "side rails").
    const core = (polarity === "EXCLUDED" ? phrase.replace(/^(?:has|have|is|be|must be|must have|includes?|no|not|without|non-?)\s+/i, "") : phrase.replace(/^(?:has|have|is|be|must be|must have|includes?)\s+/i, "")).replace(/^(?:a|an|the)\s+/i, "");
    const key = `${polarity === "EXCLUDED" ? "not" : "unrecognized"}:${slugOf(core)}`;
    r = { key, text: text.slice(span[0], span[1]), span, recognized: false, capability: null, polarity, strength, source: "REQUEST_TEXT" };
  }
  const cap = r.recognized && r.polarity === "REQUIRED" ? r.capability! : evidenceCapabilityOf(r.key);
  r.evidenceCapability = cap; r.claimType = isPerformanceClaim(cap) ? "PERFORMANCE" : "PROPERTY";
  r.proposition = `${r.polarity === "EXCLUDED" ? "has no" : "has"} ${capabilityPhrase(cap)}`;
  return r;
}

export interface HybridInterpreter {
  mode: HybridMode;
  /** Precomputed or live interpretation of the request text; null when none is available. */
  interpret(request: string): unknown | null;
  log?: Array<{ request: string; trace: HybridTrace }>;
}

/**
 * Merge an interpretation into the TypeScript intent. `reparse` is the TypeScript parser itself (injected to avoid an
 * import cycle); it is used only to build the identity fields from verbatim spans.
 */
export function applySemanticIntent(orig: ResearchIntentV2, raw: unknown, input: PurchaseRequestInput, mode: HybridMode,
  reparse: (i: PurchaseRequestInput) => ResearchIntentV2, escalation: { escalate: boolean; signals: string[] }): { intent: ResearchIntentV2; trace: HybridTrace } {
  const text = norm(input.request.slice(0, 2000));
  const trace: HybridTrace = { adapter: HYBRID_ADAPTER_VERSION, schema: SEMANTIC_INTENT_SCHEMA, mode, escalation, interpreterUsed: raw != null, schemaValid: null,
    identity: "TS", accepted: [], rejected: [], conflicts: [],
    original: { request: input.request, mode: orig.mode, target: orig.target, requirementKeys: orig.requirements.map((r) => `${r.key}/${r.strength}`), uninterpreted: (orig.uninterpreted ?? []).map((u) => u.text) } };
  if (raw == null) return { intent: orig, trace };
  const parsed = SemanticIntentV1.safeParse(raw);
  trace.schemaValid = parsed.success;
  if (!parsed.success) { trace.rejected.push({ what: "schema", detail: parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }); return { intent: orig, trace }; }
  const si = parsed.data;
  const iv: ResearchIntentV2 = { ...orig, requirements: orig.requirements.map((r) => ({ ...r })), assumptions: [...orig.assumptions], uninterpreted: [...(orig.uninterpreted ?? [])], attributes: { ...orig.attributes } };
  const covered: Array<[number, number]> = [];
  const block = (key: string, why: string, span: [number, number] | null) => {
    if (iv.requirements.some((r) => r.key === key)) return;
    iv.requirements.push({ key, text: span ? text.slice(span[0], span[1]) : why, span: span ?? [0, 0], recognized: false, capability: null, polarity: "REQUIRED", strength: "MUST", source: "REQUEST_TEXT",
      evidenceCapability: null, claimType: "PROPERTY", proposition: `resolved: ${why}` });
    trace.conflicts.push({ what: key, detail: why });
  };

  // ------------------------------------------------------------------------------------------------ identity (D, E)
  const it = si.item;
  const brandS = it.brand ? locate(text, it.brand.span) : null, modelS = it.model ? locate(text, it.model.span) : null, hostS = it.host ? locate(text, it.host.span) : null;
  const typeS = it.product_type?.span ? locate(text, it.product_type.span, true) : null;
  for (const [n, v, s] of [["brand", it.brand, brandS], ["model", it.model, modelS], ["host", it.host, hostS]] as const) if (v && !s) trace.rejected.push({ what: `identity.${n}`, detail: `span "${v.span}" is not in the request` });
  const identitySpans = [brandS, modelS, hostS, typeS].filter((x): x is [number, number] => !!x);
  const typeEn = (it.product_type?.en ?? "").replace(/\s*\(.*?\)\s*/g, " ").replace(/[^\p{L}\p{N}\s-]/gu, " ").replace(/\s+/g, " ").trim();
  let phrase: string | null = null; let exactProduct: PurchaseRequestInput["exactProduct"] | undefined;
  const latin = (x: string) => /^[\x00-\x7F]+$/.test(x);
  if (it.kind === "ACCESSORY" && hostS && typeEn) {
    const host = text.slice(hostS[0], hostS[1]);
    phrase = `${typeEn} for the ${host}`;
    if (!latin(host) && brandS === null) { const w = host.split(/\s+/); if (w.length >= 2) exactProduct = { brand: w[0]!, model: w.slice(1).join(" ") }; }
  } else if ((it.kind === "STANDALONE" || it.kind === "BUNDLE" || (it.kind === "UNKNOWN" && brandS && (orig.uninterpreted ?? []).some((u) => modelS && overlaps(u.span, modelS)))) && modelS) {
    const b = brandS ? text.slice(brandS[0], brandS[1]) : "";
    let m = text.slice(modelS[0], modelS[1]);
    if (b && m.toLowerCase().startsWith(b.toLowerCase() + " ")) m = m.slice(b.length + 1);
    const bundleTail = it.kind === "BUNDLE" && typeEn && /\b(?:kit|bundle|set|combo)\b/i.test(typeEn) ? ` ${typeEn}` : "";
    // A type noun written after the model ("<brand> <model> griddle") stays in the phrase, as the parser reads it.
    const postType = !bundleTail && typeS && modelS && typeS[0] >= modelS[1] && typeEn ? ` ${typeEn}` : "";
    phrase = [b, m].filter(Boolean).join(" ") + bundleTail + postType;
    if (b && (!latin(b) || !/^[A-Z]/.test(b))) exactProduct = { brand: b, model: m };
  } else if (typeEn && !modelS && !hostS) {
    phrase = brandS ? `${text.slice(brandS[0], brandS[1])} ${typeEn}` : typeEn;
    if (brandS && !latin(text.slice(brandS[0], brandS[1]))) phrase = typeEn;
  }
  let identityFromInterpreter: ResearchIntentV2 | null = null;
  let reparsed: ResearchIntentV2 | null = null;
  if (phrase) {
    const words = (x: string | null | undefined) => new Set((x ?? "").toLowerCase().replace(/(\d)\s*-?\s*(?=[a-z])/g, "$1").split(/[\s-]+/).filter(Boolean));
    const rawWords = (x: string | null | undefined) => new Set((x ?? "").toLowerCase().split(/[\s-]+/).filter(Boolean));
    let can = reparse({ request: phrase, ...(exactProduct ? { exactProduct } : {}) });
    // The parser can cut a verbatim model span short again ("Range five-ring Stormshield" -> "Range"); then the span itself is
    // passed as the structured exact product, so the model the user wrote is kept whole.
    if (!exactProduct && modelS && brandS && (it.kind === "STANDALONE" || it.kind === "BUNDLE") && can.target && words(can.target.model).size < words(text.slice(modelS[0], modelS[1])).size) {
      const b = text.slice(brandS[0], brandS[1]); let m = text.slice(modelS[0], modelS[1]);
      if (m.toLowerCase().startsWith(b.toLowerCase() + " ")) m = m.slice(b.length + 1);
      can = reparse({ request: phrase, exactProduct: { brand: b, model: m } });
    }
    reparsed = can;
    const o = orig.target, c = can.target;
    // The parser's lexicon may map the interpreter's type to another one ("swing chair" -> "office chair"); such a
    // reparse is not the interpreter's reading and is not used.
    const allowed = new Set([...rawWords(typeEn), ...rawWords(text), ...rawWords(brandS ? text.slice(brandS[0], brandS[1]) : "")].map((w) => w.replace(/[^\p{L}\p{N}]/gu, "")));
    const keepsWords = (q: string | null | undefined) => [...rawWords(q)].map((w) => w.replace(/[^\p{L}\p{N}]/gu, "")).filter(Boolean).every((w) => allowed.has(w));
    const sup = (a: Set<string>, b: Set<string>) => [...b].every((w) => a.has(w));
    // Model superset under either word split ("10 amp" = "10amp", but "32,000 btu" keeps "32,000").
    const supM = (a: string | null | undefined, b: string | null | undefined) => sup(words(a), words(b)) || sup(rawWords(a), rawWords(b));
    if (!o && c) { identityFromInterpreter = can; trace.accepted.push({ what: "identity", detail: `TypeScript found no product; interpreter identity "${phrase}" (${c.kind})` }); }
    else if (!o && !c && orig.mode === "PRODUCT_DISCOVERY" && can.mode === "PRODUCT_DISCOVERY" && typeEn && keepsWords(can.queries.primary)) {
      if (!(orig.productTypeWords ?? []).length && !orig.category && ((can.productTypeWords ?? []).length || can.category)) { identityFromInterpreter = can; trace.accepted.push({ what: "product-type", detail: `TypeScript found no product type; "${typeEn}"` }); }
      else if (orig.language !== "en" && can.queries.primary && !/[가-힣]/.test(can.queries.primary)) { identityFromInterpreter = can; trace.accepted.push({ what: "product-type", detail: `non-English discovery: English type "${typeEn}"` }); }
    } else if (o && c) {
      const sameBrand = (o.brand ?? "").toLowerCase() === (c.brand ?? "").toLowerCase();
      if (o.kind === c.kind && sameBrand && supM(c.model, o.model) && words(c.model).size > words(o.model).size) { identityFromInterpreter = can; trace.accepted.push({ what: "identity", detail: `more specific model "${c.model}" (TypeScript: "${o.model}")` }); }
      else if (o.kind === "STANDALONE" && c.kind === "ACCESSORY" && sameBrand && supM(c.model, o.model) && typeS && !identitySpans.filter((s) => s !== typeS).some((s) => inside(typeS, s))) {
        identityFromInterpreter = can; trace.accepted.push({ what: "identity", detail: `part "${c.accessoryNoun}" for host "${c.brand} ${c.model}" (TypeScript locked the host)` });
      } else if (o.kind !== c.kind && !(o.kind === "BUNDLE" && c.kind === "ACCESSORY")) {
        trace.identity = "TS_CONFLICT_BLOCKED"; block("ambiguous:item-kind", `the request may name a ${c.kind.toLowerCase()} or a ${o.kind.toLowerCase()} (interpretations disagree); confirm what to buy`, null);
      } else if (!sameBrand || !(supM(c.model, o.model) || supM(o.model, c.model))) {
        trace.identity = "TS_CONFLICT_BLOCKED"; block("ambiguous:item-model", `the interpreter reads the model as "${c.brand} ${c.model}", the parser as "${o.brand} ${o.model}"; confirm the product`, null);
      }
    }
  }
  if (identityFromInterpreter) {
    const c = identityFromInterpreter;
    trace.identity = "INTERPRETER";
    Object.assign(iv, { mode: c.mode, target: c.target, requestedModel: c.requestedModel, targetNoun: c.targetNoun, nounModifiers: c.nounModifiers, requestTail: c.requestTail, lockBasis: c.lockBasis ?? orig.lockBasis,
      productTypeWords: c.productTypeWords, category: c.category, categoryNoun: c.categoryNoun, queries: c.queries, objective: orig.objective === "LOWEST_VERIFIED_TOTAL" || c.mode === "EXACT_PRODUCT_PURCHASE" ? "LOWEST_VERIFIED_TOTAL" : c.objective });
    for (const [k, v] of Object.entries(c.attributes)) if (v && !(iv.attributes as Record<string, unknown>)[k]) (iv.attributes as Record<string, unknown>)[k] = v;
    // A product noun of the new identity is not an open requirement any more ("home" of "home thermostat").
    iv.requirements = iv.requirements.filter((r) => !(r.note === "TYPE_MODIFIER" && c.target?.accessoryNoun && c.target.accessoryNoun.toLowerCase().includes(r.text.toLowerCase())));
    // The parser's own reading of the identity phrase keeps its requirements ("steam" of "steam iron").
    for (const r of c.requirements) {
      if (r.strength !== "MUST" || iv.requirements.some((x) => x.key === r.key)) continue;
      const at = orig.language === "en" ? locate(text, r.text) : null;
      const anchor = at ?? typeS ?? identitySpans[0] ?? null;
      if (!anchor) continue;
      iv.requirements.push({ ...r, span: anchor, source: "REQUEST_TEXT" });
      trace.accepted.push({ what: "identity-requirement", detail: `"${r.text}" from the parser's reading of "${c.queries.primary}"` });
    }
    // The type words are released only when the locked identity carries the type noun.
    const nouns = [c.target?.accessoryNoun, c.targetNoun, c.categoryNoun, ...(c.productTypeWords ?? [])].filter(Boolean).join(" ").toLowerCase();
    const typeCarried = !typeS || !typeEn || !c.target || typeEn.toLowerCase().split(/\s+/).some((w) => w.length > 2 && nouns.includes(w.replace(/s$/, "")));
    covered.push(...identitySpans.filter((sp) => sp !== typeS || typeCarried));
  } else if (trace.identity === "TS" && orig.target) covered.push(...identitySpans);
  // Without a locked identity, identity words are never released from "uninterpreted" (a brand and model the engine
  // does not search for must keep the request on HOLD).

  // The nouns the engine matches products by (not the free-text query, which is never enforced).
  const identityText = () => [iv.target?.brand, iv.target?.model, iv.target?.accessoryNoun, iv.targetNoun, iv.categoryNoun, ...(iv.productTypeWords ?? [])].filter(Boolean).join(" ").toLowerCase();
  // A brand named without a model in a discovery request stays a requirement when the identity does not carry it.
  if (brandS && !modelS && !hostS && trace.identity !== "TS_CONFLICT_BLOCKED") {
    const b = text.slice(brandS[0], brandS[1]);
    if (!identityText().includes(b.toLowerCase()) && !iv.requirements.some((r) => r.strength === "MUST" && overlaps(r.span, brandS))) {
      iv.requirements.push(requirementFrom(text, brandS, "REQUIRED", "MUST", b)); trace.accepted.push({ what: "brand-kept", detail: `brand "${b}" stays an open requirement` });
    }
  }

  // Identity words the parser made a MUST: dropped only when the span sits inside an identity span and is not negated.
  if (trace.identity !== "TS_CONFLICT_BLOCKED") iv.requirements = iv.requirements.filter((r) => {
    if (r.source !== "REQUEST_TEXT" || r.strength !== "MUST" || r.polarity !== "REQUIRED" || r.span[1] <= r.span[0]) return true;
    // Only the parser's own reading of the request is pruned, never a requirement taken from the identity reparse.
    if (!orig.requirements.some((x) => x.key === r.key)) return true;
    const inId = identitySpans.find((s) => inside(r.span, s));
    if (!inId || NEGATED_AT(text, r.span[0]) || /\d/.test(r.text)) return true;
    // Only when the identity the engine will search for still carries the word (never "high" of "high chair" while the
    // parser searches for an office chair).
    // A word the parser itself marks TYPE_MODIFIER that sits inside the interpreter's product-type span ("camping" of
    // "camping stove") is part of the type; any other word must be among the nouns the engine matches by.
    const typeModifier = r.note === "TYPE_MODIFIER" && typeS !== null && inside(r.span, typeS);
    if (!typeModifier && !identityText().includes(r.text.toLowerCase())) return true;
    trace.accepted.push({ what: `drop-identity-word:${r.key}`, detail: `"${r.text}" is part of "${text.slice(inId[0], inId[1])}"` });
    return false;
  });

  // ------------------------------------------------------------------------------------------- constraints (B, C, E)
  for (const c of si.constraints) {
    const span = locate(text, c.span);
    if (!span) { trace.rejected.push({ what: `${c.role}`, detail: `span "${c.span}" is not in the request` }); continue; }
    const english = iv.language === "en" && /^[\x00-\x7F’‘–—°]+$/.test(c.span);
    const tsHere = iv.requirements.filter((r) => r.source === "REQUEST_TEXT" && overlaps(r.span, span));
    const tsMust = tsHere.filter((r) => r.strength === "MUST");
    // An existing requirement stands in for the interpreter's only when it spans all of the content words.
    const content = [...c.span.matchAll(/[\p{L}\p{N}][\p{L}\p{N}'’.,-]*/gu)].filter((m) => !/^(?:with|that|which|and|but|a|an|the|of|for|to|is|are|at|least|most|up|under|over|than|more|less|only|it|must|should|come|comes|need|needs|has|have|ideally|preferably|please|include|includes|my|me|i)$/i.test(m[0]))
      .map((m) => [span[0] + (text.slice(span[0], span[1]).indexOf(m[0])), span[0] + (text.slice(span[0], span[1]).indexOf(m[0])) + m[0].length] as [number, number]);
    const wholly = (rs: StatedRequirement[]) => rs.length > 0 && content.every((w) => rs.some((r) => inside(w, r.span)));
    if (c.role === "context") {
      // Never removes a requirement (B). Released words: plain context only (no digit, no negation, no "only", no bound).
      if (tsMust.length) { trace.conflicts.push({ what: "kept-must", detail: `interpreter calls "${c.span}" context; the parser's MUST stays (${tsMust.map((r) => r.key).join(", ")})` }); continue; }
      if (/\d/.test(c.span) || NEG.test(c.span) || BOUND.test(c.span) || /\b(?:fits?|compatible|works? with|suitable|rated|safe)\b/i.test(c.span)) { trace.rejected.push({ what: "context", detail: `"${c.span}" looks like a condition; not released as context` }); continue; }
      covered.push(span); trace.accepted.push({ what: "context", detail: c.span });
      continue;
    }
    // Numbers (C).
    let phraseOut = english ? c.span.replace(/^(?:with|that|which|and|but|,)\s+/i, "") : c.en;
    if (c.numeric) {
      const lex = lexicalBound(c.span);
      const nums = numbersIn(c.span);
      if (!nums.some((n) => Math.abs(n - c.numeric!.value) < 1e-9 || Math.abs(n * 1000 - c.numeric!.value) < 1e-9 || Math.abs(n * 10000 - c.numeric!.value) < 1e-9)) {
        block(`unresolved:${slugOf(c.span)}`, `the number in "${c.span}" could not be confirmed`, span); covered.push(span); continue;
      }
      if (lex === "UP_TO" || c.subject !== "product") {
        // The interpreter's direction or attachment is not used: the user's own words are the requirement.
        phraseOut = english ? phraseOut : c.en;
        if (lex === "UP_TO") trace.accepted.push({ what: "numeric-kept-verbatim", detail: `"${c.span}" (up to: direction not taken from the interpreter)` });
        else trace.accepted.push({ what: "numeric-kept-verbatim", detail: `"${c.span}" applies to ${c.subject}${c.component ? ` (${c.component})` : ""}` });
      } else if (lex && c.numeric.op !== "=" && !sameDirection(lex, c.numeric.op)) {
        block(`unresolved:${slugOf(c.span)}`, `"${c.span}" states ${lex} but the interpreter read ${c.numeric.op}`, span); covered.push(span); continue;
      } else if (!lex && c.numeric.op !== "=" && english) {
        trace.conflicts.push({ what: "numeric-no-bound-word", detail: `"${c.span}": no bound word in the request; kept as written` });
      } else if (!english && lex && c.numeric.op !== "=" && !sameDirection(lex, c.numeric.op)) {
        block(`unresolved:${slugOf(c.span)}`, `"${c.span}" states ${lex} but the interpreter read ${c.numeric.op}`, span); covered.push(span); continue;
      }
      // A threshold is never an exact identity attribute (C).
      if (c.numeric.op !== "=") for (const [k, v] of Object.entries(iv.attributes)) if (typeof v === "string" && numbersIn(v).includes(c.numeric.value) && inside(span, span)) {
        const before = numbersIn(text.slice(Math.max(0, span[0] - 2), span[1]));
        if (before.includes(c.numeric.value) && (k === "capacity" || k === "size" || k === "pack")) { delete (iv.attributes as Record<string, unknown>)[k]; trace.accepted.push({ what: "threshold-not-attribute", detail: `${k}=${v} removed: "${c.span}" is a ${c.numeric.op} bound` }); }
      }
    }
    if (c.role === "exclusion" && !/\b(?:no|not|non|never|without|except|[a-z]+n['’]t)\b|없|않|말고|제외|빼고/i.test(c.span)) {
      // "cooling only": the words name what the user requires, so they are kept as a requirement as written.
      if (!tsMust.some((r) => r.span[0] <= span[0] && r.span[1] >= span[1])) iv.requirements.push(requirementFrom(text, span, "REQUIRED", "MUST", english ? phraseOut : c.en));
      covered.push(span); trace.conflicts.push({ what: "exclusion-without-negation", detail: `"${c.span}" kept as a stated requirement` });
      continue;
    }
    if (c.role === "exclusion") {
      if (tsHere.some((r) => r.polarity === "EXCLUDED")) { covered.push(span); continue; }
      const p = phraseOut.replace(/^(?:not the|not|no|without|but not the|but not)\s+/i, "").replace(/\s+(?:one|model|version|variant)$/i, "").replace(/^(?:a|an|the)\s+/i, "");
      iv.requirements.push(requirementFrom(text, span, "EXCLUDED", "MUST", english ? p : c.en.replace(/^(?:no|not|without)\s+/i, "")));
      covered.push(span); trace.accepted.push({ what: "exclusion", detail: c.span });
      continue;
    }
    if (c.role === "optional") {
      if (tsMust.length) { trace.conflicts.push({ what: "kept-must", detail: `interpreter calls "${c.span}" optional; the parser's MUST stays` }); if (wholly(tsMust)) covered.push(span); continue; }
      if (tsHere.length && wholly(tsHere)) { covered.push(span); continue; }
      iv.requirements.push(requirementFrom(text, span, "REQUIRED", "NICE", phraseOut)); covered.push(span); trace.accepted.push({ what: "optional", detail: c.span });
      continue;
    }
    // mandatory / compatibility: add, or tighten a CONTEXT/NICE reading of the same words.
    const tsCtx = tsHere.filter((r) => r.strength === "NICE");
    if (tsMust.length && !tsCtx.length && wholly(tsMust)) { covered.push(span); continue; }
    if (tsCtx.length) { iv.requirements = iv.requirements.filter((r) => !tsCtx.includes(r)); trace.accepted.push({ what: "tightened", detail: `"${c.span}": ${tsCtx.map((r) => r.key).join(", ")} -> MUST` }); }
    else trace.accepted.push({ what: c.role, detail: c.span });
    iv.requirements.push(requirementFrom(text, span, "REQUIRED", "MUST", phraseOut));
    covered.push(span);
  }

  // Uninterpreted words: released only when an accepted span covers them; never by the interpreter's say-so alone.
  const before = iv.uninterpreted ?? [];
  iv.uninterpreted = before.filter((u) => !covered.some((s) => inside(u.span, s)));
  if (before.length !== iv.uninterpreted.length) trace.accepted.push({ what: "uninterpreted-covered", detail: before.filter((u) => !iv.uninterpreted!.includes(u)).map((u) => u.text).join(", ") });

  // Derived fields, the TypeScript way.
  const dedup = new Map<string, StatedRequirement>();
  for (const r of iv.requirements) { const k = r.key; const prev = dedup.get(k); if (!prev || (prev.strength === "NICE" && r.strength === "MUST")) dedup.set(k, r); }
  iv.requirements = [...dedup.values()];
  iv.mustHave = [...new Set(iv.requirements.filter((r) => r.recognized && r.polarity === "REQUIRED" && r.strength === "MUST").map((r) => r.capability!))];
  iv.niceToHave = [...new Set(iv.requirements.filter((r) => r.recognized && r.polarity === "REQUIRED" && r.strength === "NICE").map((r) => r.capability!).filter((c) => !iv.mustHave.includes(c)))];
  const openReq = iv.requirements.filter((x) => x.strength === "MUST" && (!x.recognized || x.polarity === "EXCLUDED"));
  iv.unresolvedMust = openReq.map((r) => r.key);
  iv.assumptions.push(`Hybrid interpretation (${HYBRID_ADAPTER_VERSION}, ${mode}): identity ${trace.identity}; ${trace.accepted.length} accepted, ${trace.rejected.length} rejected, ${trace.conflicts.length} disagreements. Spending limit, condition, evidence and payment come only from the parser.`);
  return { intent: iv, trace };
}
