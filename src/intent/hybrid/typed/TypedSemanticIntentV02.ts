/**
 * EXPERIMENT (experiment/typed-semantic-v02). Not wired into any default path.
 *
 * Typed Semantic Adapter v0.2 = the typed adapter v0.1 (TypedSemanticIntent.ts, unchanged) plus verified non-Latin
 * brand normalization. Schema `diaporia.semantic-intent.v1.1` is v1 plus one optional top-level object
 * `brand_proposal: { span, brand_latin, brand_latin_alternatives }`: the interpreter's Latin spelling of a brand the
 * request writes in another script, and other plausible Latin spellings (research/typed-v02/PROMPT_BRAND_V1.txt).
 * Every v1 field is untouched, so a v1 document is a valid v1.1 document and the v1 / v0.1 readings are identical.
 *
 * The interpreter only PROPOSES a spelling. Identity is never established by transliteration:
 *  1. The original brand and its span are kept: the as-written reading (v0.1 on the original request) is always
 *     computed and is the fallback.
 *  2. The proposal is used only if its span is verbatim, written in a non-Latin script, and the spelling is Latin.
 *  3. The request with that span spelled in Latin is re-read by the TypeScript parser. That reading must keep the
 *     model (same text, verbatim in the request), the kind (accessory / bundle / standalone as the interpreter and the
 *     parser read them), every exclusion and every MUST outside the brand span, and add no uninterpreted word.
 *  4. The planner (ResearchPlannerV2, `brandProposal`) keeps that reading only when the request's own primary
 *     catalog query lists a brand equal to the spelling (normalized equality, no fuzzy match), lists none of the
 *     alternatives and not the original spelling. Otherwise the results are discarded and the as-written reading is
 *     researched: the original unresolved identity.
 * Anything that fails a check returns the as-written v0.1 result unchanged (fail closed). Money, currency and
 * condition always come from the parser's reading of the original request. Evidence, merchants, offers, checkout and
 * payment are untouched: this module has no field that can change them.
 */
import type { PurchaseRequestInput } from "../../PurchaseIntentRouter.js";
import type { ResearchIntentV2 } from "../../ResearchIntentV2.js";
import { escalationSignals, SemanticIntentV1, type HybridMode } from "../SemanticIntent.js";
import { applyTypedSemanticIntent, type TypedTrace } from "./TypedSemanticIntent.js";

export const TYPED_ADAPTER_V02_VERSION = "typed-adapter-0.2.0";
export const SEMANTIC_INTENT_SCHEMA_V11 = "diaporia.semantic-intent.v1.1";

export interface BrandTrace { proposed: string | null; original: string | null; outcome: "NONE" | "REJECTED" | "PROPOSED_TO_CATALOG"; why: string; rewritten: string | null }
export interface TypedTraceV02 { adapter: string; schema: string; asWritten: TypedTrace; brand: BrandTrace; proposalReading: TypedTrace | null }

const LATIN_BRAND = /^[A-Za-z][A-Za-z0-9 .&'\-]{0,39}$/;
const NON_LATIN = /[^\u0000-ɏḀ-ỿ]/; // any letter outside Latin blocks (Hangul, Kana, Han, Cyrillic, ...)
const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

function rawBrand(raw: unknown): { span: string; latin: string; alternatives: string[] } | null {
  const b = (raw as { brand_proposal?: { span?: unknown; brand_latin?: unknown; brand_latin_alternatives?: unknown } | null } | null)?.brand_proposal;
  if (!b || typeof b.span !== "string" || typeof b.brand_latin !== "string" || !b.brand_latin.trim()) return null;
  const alts = Array.isArray(b.brand_latin_alternatives) ? b.brand_latin_alternatives.filter((x): x is string => typeof x === "string" && !!x.trim()).slice(0, 8) : [];
  return { span: b.span, latin: b.brand_latin.trim(), alternatives: alts.map((a) => a.trim()) };
}

/** The interpreter document with the brand span spelled in Latin, so every other span stays verbatim in the rewritten request. */
function rewriteRaw(raw: unknown, from: string, to: string): unknown {
  const walk = (v: unknown): unknown => typeof v === "string" ? v.split(from).join(to) : Array.isArray(v) ? v.map(walk)
    : v && typeof v === "object" ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, k === "brand_proposal" ? x : walk(x)])) : v;
  return walk(raw);
}

export function applyTypedSemanticIntentV02(orig: ResearchIntentV2, raw: unknown, input: PurchaseRequestInput, mode: HybridMode,
  reparse: (i: PurchaseRequestInput) => ResearchIntentV2): { intent: ResearchIntentV2; trace: TypedTraceV02 } {
  const asWritten = applyTypedSemanticIntent(orig, raw, input, mode, reparse);
  const trace: TypedTraceV02 = { adapter: TYPED_ADAPTER_V02_VERSION, schema: SEMANTIC_INTENT_SCHEMA_V11, asWritten: asWritten.trace, brand: { proposed: null, original: null, outcome: "NONE", why: "no brand_latin proposed", rewritten: null }, proposalReading: null };
  const out = (why: string) => { trace.brand.outcome = "REJECTED"; trace.brand.why = why; return { intent: asWritten.intent, trace }; };
  const text = input.request;
  const signals = escalationSignals(orig, text);
  const escalate = mode === "ALWAYS" || signals.length > 0;
  const b = escalate ? rawBrand(raw) : null;
  if (!b) return { intent: asWritten.intent, trace };
  trace.brand.proposed = b.latin; trace.brand.original = b.span;
  const parsed = SemanticIntentV1.safeParse(raw);
  if (!parsed.success) return out("interpretation does not match the schema");
  const si = parsed.data;
  // ---- 2. the proposal itself
  const at = text.indexOf(b.span);
  if (at < 0) return out("brand span not verbatim");
  if (text.indexOf(b.span, at + 1) >= 0) return out("brand span occurs more than once");
  if (!NON_LATIN.test(b.span) || /[A-Za-z]/.test(b.span)) return out("brand span is not written in a non-Latin script");
  if (!LATIN_BRAND.test(b.latin)) return out("proposed spelling is not a Latin brand name");
  if (b.alternatives.some((a) => !LATIN_BRAND.test(a))) return out("an alternative spelling is not a Latin brand name");
  if (norm(text).includes(norm(b.latin))) return out("the request already writes the Latin spelling");
  // ---- conflicting identities: the parser (or the as-written reading) already holds an identity
  if (orig.brandGuess) return out("the parser already holds a brand guess");
  const host = si.item.host?.span ? text.indexOf(si.item.host.span) : -1;
  const modelSpan = si.item.model?.span ?? null;
  if (modelSpan && text.indexOf(modelSpan) < 0) return out("model span not verbatim");
  if (modelSpan && modelSpan.includes(b.span)) return out("brand span lies inside the model span");
  // ---- 3. the parser's reading of the request with the brand spelled in Latin
  const rewritten = text.slice(0, at) + b.latin + text.slice(at + b.span.length);
  trace.brand.rewritten = rewritten;
  const sub = reparse({ ...input, request: rewritten });
  if (sub.brandGuess) return out("the rewritten request reads as a brand guess");
  const subBrand = sub.target?.brand ?? null;
  if (sub.target && norm(subBrand ?? "") !== norm(b.latin)) return out(`the rewritten request names another brand (${subBrand ?? "none"})`);
  // An identity the parser already read is kept unless it is the same words split differently: the parser took the
  // first word of the model as the brand because the real brand is written in another script ("<brand> Tarn 40" read
  // as brand "Tarn", model "40"). Anything else is a conflicting identity.
  if (orig.target) {
    const same = !!sub.target && sub.target.kind === orig.target.kind && norm(`${orig.target.brand ?? ""}${orig.target.model}`) === norm(sub.target.model ?? "");
    if (!same) return out(`the parser already read another identity (${orig.target.brand ?? "-"} ${orig.target.model})`);
  }
  // 6. model, kind, accessory / bundle status
  if (modelSpan) {
    const m = si.item.model!.text;
    if (!sub.target || norm(sub.target.model ?? "") !== norm(m) || !norm(text).includes(norm(sub.target.model ?? ""))) return out(`model "${m}" not kept by the rewritten reading (${sub.target?.model ?? "none"})`);
  } else if (sub.target && !norm(text).includes(norm(sub.target.model ?? ""))) return out("the rewritten reading added a model the request does not write");
  const kind = si.item.kind;
  if (sub.target) {
    if (kind === "UNKNOWN") return out("interpreter kind UNKNOWN for an exact reading");
    if (sub.target.kind !== kind) return out(`kind changed: interpreter ${kind}, rewritten reading ${sub.target.kind}`);
    if (kind === "ACCESSORY" && host < 0) return out("accessory without a verbatim host");
  } else if (kind === "ACCESSORY" || kind === "BUNDLE") return out(`interpreter reads a ${kind.toLowerCase()} but the rewritten reading has no exact item`);
  // exclusions and MUSTs outside the brand span are kept; no new uninterpreted word
  const bs: [number, number] = [at, at + b.span.length];
  const outside = (r: { span: [number, number] }) => r.span[1] <= bs[0] || r.span[0] >= bs[1];
  const subKeys = new Set(sub.requirements.map((r) => `${r.key}|${r.polarity}`));
  const lostEx = orig.requirements.filter((r) => r.polarity === "EXCLUDED" && !subKeys.has(`${r.key}|${r.polarity}`));
  if (lostEx.length) return out(`exclusion lost: ${lostEx.map((r) => r.key).join(",")}`);
  const lostMust = orig.requirements.filter((r) => r.source === "REQUEST_TEXT" && r.strength === "MUST" && outside(r) && !subKeys.has(`${r.key}|${r.polarity}`));
  if (lostMust.length) return out(`requirement lost: ${lostMust.map((r) => r.key).join(",")}`);
  const origUn = new Set((orig.uninterpreted ?? []).map((u) => u.text));
  const newUn = (sub.uninterpreted ?? []).filter((u) => !origUn.has(u.text));
  if (newUn.length) return out(`new uninterpreted words: ${newUn.map((u) => u.text).join(",")}`);
  // ---- the typed v0.1 reading of the rewritten request (same escalation decision as the original)
  const r2 = applyTypedSemanticIntent(sub, rewriteRaw(raw, b.span, b.latin), { ...input, request: rewritten }, escalate ? "ALWAYS" : mode, reparse);
  trace.proposalReading = r2.trace;
  const iv: ResearchIntentV2 = structuredClone(r2.intent);
  for (const k of Object.keys(orig) as Array<keyof ResearchIntentV2>) if (/^(?:budget|money|currency|condition)/.test(String(k))) (iv as any)[k] = structuredClone((orig as any)[k]);
  if (asWritten.intent.mode === "EXACT_PRODUCT_PURCHASE" && iv.mode !== "EXACT_PRODUCT_PURCHASE") return out("the as-written reading is exact and the rewritten one is not");
  iv.assumptions = [...iv.assumptions, `"${b.span}" is read as the brand "${b.latin}" only if the catalog lists that brand (and no other spelling of it).`];
  iv.brandProposal = { brand: b.latin, original: b.span, alternatives: b.alternatives, fallback: asWritten.intent };
  trace.brand.outcome = "PROPOSED_TO_CATALOG"; trace.brand.why = "all identity checks passed; the catalog decides";
  return { intent: iv, trace };
}
