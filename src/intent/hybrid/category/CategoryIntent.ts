/**
 * RESEARCH (research/semantic-category-count-v1). Not wired into any default path.
 *
 * Zod schemas (one per arm, generated from one factory so only the category enum differs), the shared validator and
 * the deterministic projection of a category document into diaporia.semantic-intent.v1.1 (the typed adapter v0.2
 * input). The projection reads the atomic fields; the category label is checked against them and a unit whose label
 * disagrees with its own atomic fields is never executed (it is kept as an ambiguity: fail closed to the parser).
 */
import { z } from "zod";
import { ARMS, FACETS, FINE, OPERATORS, RESOLUTIONS, STATUSES, TARGETS, categoriesOf, fineOf, groupOf, type Arm, type Fine } from "./CategoryTaxonomy.js";

export const CATEGORY_SCHEMA_VERSION = "diaporia.semantic-category.v1.1.0" as const;
export const CATEGORY_PROJECTION_VERSION = "category-projection-1.0.0" as const;

const Span = z.string().min(1).max(300);
export function unitSchema(arm: Arm) {
  const cats = categoriesOf(arm) as [string, ...string[]];
  const base = {
    span: Span.describe("exact verbatim substring of the request"),
    category: z.enum(cats),
    facet: z.enum(FACETS),
    status: z.enum(STATUSES),
    attribute: z.string().max(80).nullable().describe("normalized English attribute or relationship name"),
    operator: z.enum(OPERATORS).nullable(),
    value: z.union([z.number(), z.string().max(120)]).nullable(),
    unit: z.string().max(30).nullable(),
    target: z.enum(TARGETS),
    component: z.string().max(80).nullable(),
    resolution: z.enum(RESOLUTIONS),
    en: z.string().min(1).max(200),
    brand_latin: z.string().max(40).nullable(),
    brand_latin_alternatives: z.array(z.string().max(40)).max(4),
  };
  return arm === "K3F" ? z.object({ ...base, subtype: z.enum(FINE).nullable() }) : z.object(base);
}
export function documentSchema(arm: Arm) {
  return z.object({
    taxonomy: z.literal(arm),
    language: z.enum(["en", "ko", "ja", "other"]),
    item_kind: z.enum(["STANDALONE", "ACCESSORY", "BUNDLE", "UNKNOWN"]),
    units: z.array(unitSchema(arm)).max(40),
    unresolved: z.array(z.object({ span: z.string().max(300).nullable(), issue: z.string().min(1).max(300) })).max(20),
  });
}
export const DOCUMENT_SCHEMAS = Object.fromEntries(ARMS.map((a) => [a, documentSchema(a)])) as Record<Arm, ReturnType<typeof documentSchema>>;
export type CategoryUnit = z.infer<ReturnType<typeof unitSchema>> & { subtype?: Fine | null };
export type CategoryDocument = Omit<z.infer<ReturnType<typeof documentSchema>>, "units"> & { units: CategoryUnit[] };

// ------------------------------------------------------------------------------------------------------------ validator
/** Filler words that carry no product meaning; every other token must be inside some unit or unresolved span. */
const FILLER = new Set(("a an the i i'm im me my we our you your want wants need needs would like to please buy get getting looking look find order purchase "
  + "some one is are be it that this which and or with of in on at please, can could should just also really").split(/\s+/).filter(Boolean));
const KO_FILLER = /^(?:사고|싶어요?|싶습니다|주세요|원해요|찾아요|찾고|있어요|구매(?:하고)?|사주세요|살래요|주문(?:해|해요|할게요|해주세요)?|부탁(?:드려요|해요|합니다)?|해주세요|좀|추천|안녕하세요|ください|お願いします)$/;
export function contentTokens(text: string): Array<{ t: string; at: [number, number] }> {
  const out: Array<{ t: string; at: [number, number] }> = [];
  for (const m of text.normalize("NFKC").matchAll(/[\p{L}\p{N}][\p{L}\p{N}.'’\-]*/gu)) {
    const t = m[0].replace(/[.'’\-]+$/, ""); const lo = t.toLowerCase();
    if (!t || FILLER.has(lo) || KO_FILLER.test(t)) continue;
    out.push({ t, at: [m.index!, m.index! + t.length] });
  }
  return out;
}

export interface Validation {
  schemaValid: boolean; schemaError: string | null;
  units: number; nonVerbatim: string[]; conflicts: Array<{ span: string; category: string; expected: string | null; why: string }>;
  duplicatesMandatory: number; uncovered: string[]; contentTokens: number; unresolved: number; ambiguousUnits: number;
}

export function validateDocument(arm: Arm, request: string, raw: unknown): { doc: CategoryDocument | null; v: Validation } {
  const v: Validation = { schemaValid: false, schemaError: null, units: 0, nonVerbatim: [], conflicts: [], duplicatesMandatory: 0, uncovered: [], contentTokens: 0, unresolved: 0, ambiguousUnits: 0 };
  const p = DOCUMENT_SCHEMAS[arm].safeParse(raw);
  const toks = contentTokens(request); v.contentTokens = toks.length;
  if (!p.success) { v.schemaError = p.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; "); v.uncovered = toks.map((x) => x.t); return { doc: null, v }; }
  v.schemaValid = true;
  const doc = p.data as CategoryDocument;
  const text = request.normalize("NFKC");
  v.units = doc.units.length; v.unresolved = doc.unresolved.length; v.ambiguousUnits = doc.units.filter((u) => u.resolution === "ambiguous").length;
  const covered: Array<[number, number]> = [];
  const cover = (s: string | null) => { if (!s) return; const n = s.normalize("NFKC"); let i = text.indexOf(n); if (i < 0) i = text.toLowerCase().indexOf(n.toLowerCase()); if (i >= 0) covered.push([i, i + n.length]); return i >= 0; };
  for (const u of doc.units) {
    if (!cover(u.span)) v.nonVerbatim.push(u.span);
    const c = classify(arm, u);
    if (!c.ok) v.conflicts.push({ span: u.span, category: u.category, expected: c.expected, why: c.why });
  }
  for (const r of doc.unresolved) cover(r.span);
  v.uncovered = toks.filter((x) => !covered.some((c) => x.at[0] >= c[0] && x.at[1] <= c[1])).map((x) => x.t);
  // Duplicated mandatory requirements: two executable mandatory units over overlapping spans with the same fine
  // category and attribute (a span may give context to a constraint; it must not create a second MUST).
  const mand = doc.units.filter((u) => u.status === "mandatory" && classify(arm, u).ok && fineOf(u.facet, u.status) !== "IDENTITY");
  const loc = (s: string) => { const i = text.indexOf(s.normalize("NFKC")); return i < 0 ? null : [i, i + s.length] as [number, number]; };
  for (let i = 0; i < mand.length; i++) for (let j = i + 1; j < mand.length; j++) {
    const a = mand[i]!, b = mand[j]!; const la = loc(a.span), lb = loc(b.span);
    if (la && lb && la[0] < lb[1] && lb[0] < la[1] && fineOf(a.facet, a.status) === fineOf(b.facet, b.status) && (a.attribute ?? "").toLowerCase() === (b.attribute ?? "").toLowerCase()) v.duplicatesMandatory++;
  }
  return { doc, v };
}

/** Is the unit's category label consistent with its atomic fields (and, in K3F, with its optional sub-type)? */
export function classify(arm: Arm, u: CategoryUnit): { ok: boolean; fine: Fine | null; expected: string | null; why: string } {
  const fine = fineOf(u.facet, u.status);
  if (!fine) return { ok: false, fine, expected: null, why: `facet ${u.facet} with status ${u.status} has no meaning` };
  const expected = groupOf(arm, fine);
  if (u.category !== expected) return { ok: false, fine, expected, why: `atomic fields imply ${fine} (${expected})` };
  if (arm === "K3F" && u.subtype && u.subtype !== fine) return { ok: false, fine, expected: fine, why: `sub-type ${u.subtype} disagrees with atomic fields (${fine})` };
  return { ok: true, fine, expected, why: "" };
}

// ----------------------------------------------------------------------------------------------------------- projection
const SUBJECT: Record<string, "product" | "component" | "user" | "load" | "host" | "other"> = { item: "product", component: "component", user: "user", load: "load", host: "host", purchase: "other", other: "other" };
const ROLE: Partial<Record<Fine, "mandatory" | "optional" | "exclusion" | "compatibility" | "context">> = { REQUIREMENT: "mandatory", EXCLUSION: "exclusion", RELATION: "compatibility", PREFERENCE: "optional", CONTEXT: "context" };
const NUMOP = new Set([">=", "<=", ">", "<", "="]);

export interface ProjectionTrace { arm: Arm; executed: number; withheld: Array<{ span: string; why: string }>; purchase: string[] }

/** The category document as a diaporia.semantic-intent.v1.1 document (v1 fields + optional brand_proposal). */
export function projectToV11(arm: Arm, request: string, doc: CategoryDocument): { v11: Record<string, unknown>; trace: ProjectionTrace } {
  const trace: ProjectionTrace = { arm, executed: 0, withheld: [], purchase: [] };
  const text = request.normalize("NFKC");
  const verbatim = (s: string | null | undefined) => !!s && text.includes(s.normalize("NFKC"));
  const ambiguities: Array<{ issue: string; span: string | null }> = doc.unresolved.map((r) => ({ issue: r.issue, span: r.span }));
  const item: Record<string, unknown> = { kind: doc.item_kind, product_type: null, brand: null, model: null, host: null };
  const constraints: Array<Record<string, unknown>> = [];
  let budget: { span: string } | null = null; let condition: { value: string; span: string } | null = null;
  let brandProposal: { span: string; brand_latin: string; brand_latin_alternatives: string[] } | null = null;
  const seen = new Set<string>();
  for (const u of doc.units) {
    const c = classify(arm, u);
    if (!verbatim(u.span)) { trace.withheld.push({ span: u.span, why: "span not verbatim" }); continue; }
    if (!c.ok) { trace.withheld.push({ span: u.span, why: `classification conflict: ${c.why}` }); ambiguities.push({ issue: `unit withheld (${c.why}): ${u.en}`, span: u.span }); continue; }
    if (u.resolution === "ambiguous") ambiguities.push({ issue: u.en, span: u.span });
    const fine = c.fine!;
    if (fine === "IDENTITY") {
      const named = { text: u.span, span: u.span };
      if (u.facet === "product_type" && !item.product_type) item.product_type = { text: u.span, span: u.span, en: u.attribute ?? u.en };
      else if (u.facet === "brand" && !item.brand) {
        item.brand = named;
        if (u.brand_latin && /[^\u0000-ɏḀ-ỿ]/.test(u.span)) brandProposal = { span: u.span, brand_latin: u.brand_latin, brand_latin_alternatives: u.brand_latin_alternatives ?? [] };
      } else if (u.facet === "model" && !item.model) item.model = named;
      else if (u.facet === "host" && !item.host) item.host = named;
      else if (u.facet !== "kind_marker") ambiguities.push({ issue: `second ${u.facet}: ${u.en}`, span: u.span });
      trace.executed++; continue;
    }
    if (fine === "PURCHASE") {
      trace.purchase.push(`${u.facet}:${u.span}`);
      if (u.facet === "budget" && u.status === "mandatory") { budget ??= { span: u.span }; trace.executed++; continue; }
      if (u.facet === "condition" && u.status === "mandatory" && typeof u.value === "string" && ["new", "used", "refurbished", "any"].includes(u.value.toLowerCase())) { condition ??= { value: u.value.toLowerCase(), span: u.span }; trace.executed++; continue; }
      // Other purchase terms (quantity, delivery, seller, a forbidden condition) have no field in v1: they go to the
      // adapter as an open mandatory/exclusion condition, so the parser's own reading still decides (no approximation).
    }
    const role = fine === "PURCHASE" ? (u.status === "forbidden" ? "exclusion" : "mandatory") : ROLE[fine]!;
    const numeric = u.operator && NUMOP.has(u.operator) && typeof u.value === "number" ? { op: u.operator, value: u.value, unit: u.unit } : null;
    const key = `${role}|${u.span}|${numeric ? `${numeric.op}${numeric.value}` : ""}`;
    if (seen.has(key)) { trace.withheld.push({ span: u.span, why: "duplicate of an earlier unit" }); continue; }
    seen.add(key);
    constraints.push({ role, span: u.span, en: u.en, numeric, subject: SUBJECT[u.target] ?? "other", component: u.component ?? null });
    trace.executed++;
  }
  const lang = doc.language === "ja" ? "other" : doc.language;
  const v11 = { language: lang, item, constraints: constraints.slice(0, 30), budget, condition, ambiguities: ambiguities.slice(0, 20), confidence: "medium", brand_proposal: brandProposal };
  return { v11, trace };
}
