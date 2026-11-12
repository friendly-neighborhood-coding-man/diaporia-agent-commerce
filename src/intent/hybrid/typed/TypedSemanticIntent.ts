/**
 * DIAGNOSTIC PROTOTYPE (experiment/semantic-boundary-diagnosis). Not wired into any default path.
 *
 * Typed adapter: the frozen hybrid adapter (hybrid-adapter-v1.0.0) runs first; then each interpreter constraint whose
 * TYPED fields (numeric op/value/unit, subject, role, product_type span) map to a form the evidence engine already
 * evaluates (research/semantic-boundary/ts-contract.v0.1.0.json) replaces the requirement the v1 adapter produced for
 * that span. Every replacement is validated independently of the interpreter: the span is verbatim, the number is
 * written in the span, the words of the new key come from the span (or from a fixed subject->anchor table), and a
 * requirement is never dropped unless the exact lock already decides it. Anything that does not validate keeps the v1
 * result (fail closed). Spending limit, condition, evidence and payment are untouched.
 */
import type { PurchaseRequestInput } from "../../PurchaseIntentRouter.js";
import type { ResearchIntentV2 } from "../../ResearchIntentV2.js";
import { slugOf, type StatedRequirement } from "../../Requirements.js";
import { applySemanticIntent, escalationSignals, SemanticIntentV1, type HybridMode } from "../SemanticIntent.js";

export const TYPED_ADAPTER_VERSION = "typed-adapter-proto-0.1.0";

export interface TypedTrace { adapter: string; base: unknown; typed: Array<{ rule: string; span: string; from: string[]; to: string | null; why: string }>; skipped: Array<{ span: string; why: string }> }

const UNIT: Record<string, string> = { lb: "lb", lbs: "lb", pound: "lb", pounds: "lb", kg: "kg", kilogram: "kg", kilograms: "kg", people: "people", person: "people", persons: "people",
  in: "in", inch: "in", inches: "in", ft: "ft", feet: "ft", l: "l", liter: "l", liters: "l", gal: "gal", gallons: "gal" };
/** Dimensions the engine's WITHIN ("for <quantity>") reading understands (capabilities.ts UNIT_DIMENSIONS). */
const WITHIN_UNITS = new Set(["lb", "kg", "people", "in", "ft", "l", "gal"]);
const MASS = new Set(["lb", "kg"]);
const STOP = new Set("a an the of to for with and or in on at by it its be is are has have that which this my our your their me i can".split(" "));
const NUMWORD: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

const locate = (text: string, span: string | null | undefined): [number, number] | null => { if (!span) return null; const i = text.indexOf(span); return i < 0 ? null : [i, i + span.length]; };
const overlaps = (a: [number, number], b: [number, number]) => a[0] < b[1] && b[0] < a[1];
const inside = (a: [number, number], b: [number, number]) => a[0] >= b[0] && a[1] <= b[1];
const words = (s: string) => s.normalize("NFKC").toLowerCase().split(/[^a-z0-9가-힣]+/).filter(Boolean);

/** The number the span itself writes (digits, a count word, or a Korean counter "6개", "4인"). */
function spanNumber(span: string): number | null {
  const d = /(\d+(?:\.\d+)?)/.exec(span); if (d) return Number(d[1]);
  for (const w of words(span)) if (NUMWORD[w] !== undefined) return NUMWORD[w]!;
  return null;
}

function req(text: string, span: [number, number], key: string, strength: "MUST" | "NICE", polarity: "REQUIRED" | "EXCLUDED" = "REQUIRED"): StatedRequirement {
  return { key, text: text.slice(span[0], span[1]), span, recognized: false, capability: null, polarity, strength, source: "REQUEST_TEXT" } as StatedRequirement;
}

function derive(iv: ResearchIntentV2) {
  const d = new Map<string, StatedRequirement>();
  for (const r of iv.requirements) { const p = d.get(r.key); if (!p || (p.strength === "NICE" && r.strength === "MUST")) d.set(r.key, r); }
  iv.requirements = [...d.values()];
  iv.mustHave = [...new Set(iv.requirements.filter((r) => r.recognized && r.polarity === "REQUIRED" && r.strength === "MUST").map((r) => r.capability!))];
  iv.niceToHave = [...new Set(iv.requirements.filter((r) => r.recognized && r.polarity === "REQUIRED" && r.strength === "NICE").map((r) => r.capability!).filter((c) => !iv.mustHave.includes(c)))];
  iv.unresolvedMust = iv.requirements.filter((x) => x.strength === "MUST" && (!x.recognized || x.polarity === "EXCLUDED")).map((r) => r.key);
}

export function applyTypedSemanticIntent(orig: ResearchIntentV2, raw: unknown, input: PurchaseRequestInput, mode: HybridMode,
  reparse: (i: PurchaseRequestInput) => ResearchIntentV2): { intent: ResearchIntentV2; trace: TypedTrace } {
  const signals = escalationSignals(orig, input.request);
  const escalate = mode === "ALWAYS" || signals.length > 0;
  const base = applySemanticIntent(orig, escalate ? raw : null, input, mode, reparse, { escalate, signals });
  const trace: TypedTrace = { adapter: TYPED_ADAPTER_VERSION, base: base.trace, typed: [], skipped: [] };
  const parsed = escalate && raw ? SemanticIntentV1.safeParse(raw) : null;
  if (!parsed?.success || base.trace.identity === "TS_CONFLICT_BLOCKED") return { intent: base.intent, trace };
  const si = parsed.data;
  const text = input.request;
  const iv: ResearchIntentV2 = structuredClone(base.intent);
  const tsReqs = orig.requirements;
  const exactLock = !!orig.target && orig.target.modelBasis !== "NONE" && orig.mode === "EXACT_PRODUCT_PURCHASE";

  // T2: product-type words. Words the parser left uninterpreted that lie inside the interpreter's product-type span are
  // the product noun ("rack" of "bike rack"); the span must be verbatim and the item a standalone or bundle.
  const typeS = locate(text, si.item.product_type?.span ?? null);
  if (typeS && (si.item.kind === "STANDALONE" || si.item.kind === "BUNDLE")) {
    const before = iv.uninterpreted ?? [];
    iv.uninterpreted = before.filter((u) => !inside(u.span, typeS));
    const freed = before.filter((u) => !iv.uninterpreted!.includes(u));
    // A type-modifier proposition that is only a word of the product noun ("bike" of "bike rack") is the category.
    const typeWords = new Set(words(text.slice(typeS[0], typeS[1])));
    const drop = iv.requirements.filter((r) => r.note === "TYPE_MODIFIER" && inside(r.span, typeS) && r.key.startsWith("unrecognized:") && words(r.text).every((w) => typeWords.has(w)));
    iv.requirements = iv.requirements.filter((r) => !drop.includes(r));
    if (freed.length || drop.length) trace.typed.push({ rule: "T2-product-type", span: text.slice(typeS[0], typeS[1]), from: [...freed.map((u) => `uninterpreted:${u.text}`), ...drop.map((r) => r.key)], to: null, why: "words of the product noun" });
  }

  for (const c of si.constraints) {
    const s = locate(text, c.span);
    if (!s) { trace.skipped.push({ span: c.span, why: "span not verbatim" }); continue; }
    const here = iv.requirements.filter((r) => r.source === "REQUEST_TEXT" && overlaps(r.span, s));
    const strength: "MUST" | "NICE" = here.some((r) => r.strength === "MUST") || c.role === "mandatory" || c.role === "compatibility" ? "MUST" : "NICE";

    // T1: numeric thresholds, from the typed op/value/unit and subject.
    if (c.numeric && (c.role === "mandatory" || c.role === "compatibility")) {
      const n = spanNumber(c.span); const unitRaw = (c.numeric.unit ?? "").toLowerCase().trim();
      const unit = UNIT[unitRaw] ?? (/^[a-z]{3,}$/.test(unitRaw) ? unitRaw : null);
      if (n === null || n !== c.numeric.value) { trace.skipped.push({ span: c.span, why: "number not written in the span" }); continue; }
      if (!unit) { trace.skipped.push({ span: c.span, why: `unit "${unitRaw}" has no form` }); continue; }
      let key: string | null = null; let why = "";
      const op = c.numeric.op;
      // Anchor: a content word the span writes after the unit ("of gravel", "across"); never dropped.
      const tail = c.span.slice(c.span.search(/\d/)).replace(/^\d+(?:\.\d+)?\s*[a-z가-힣°]*\s*/i, "");
      const anchor = words(tail).find((w) => !STOP.has(w) && !/\d/.test(w) && /^[a-z]{3,}$/.test(w));
      if ((op === ">=" || op === ">") && (c.subject === "load" || c.subject === "user")) {
        if (WITHIN_UNITS.has(unit) && /^\s*for\b/i.test(c.span)) { key = `unrecognized:for-${n}-${unit}${anchor ? `-${anchor}` : ""}`; why = "capacity must accommodate the quantity (WITHIN)"; }
        else {
          key = `unrecognized:at-least-${n}-${unit}${anchor ? `-${anchor}` : ""}`; why = anchor ? `threshold anchored on "${anchor}"` : "threshold";
        }
      } else if ((op === "<=" || op === "<") && c.subject === "product" && MASS.has(unit)) { key = `unrecognized:at-most-${n}-${unit}-weighs`; why = "product's own weight (anchor from subject=product, mass)"; }
      else if ((op === ">=" || op === ">") && c.subject === "product") { key = `unrecognized:at-least-${n}-${unit}${anchor ? `-${anchor}` : ""}`; why = "product threshold"; }
      if (!key) { trace.skipped.push({ span: c.span, why: `op "${op}" / subject "${c.subject}" has no typed form (kept fail-closed)` }); continue; }
      const from = here.filter((r) => r.polarity === "REQUIRED" && (r.key.startsWith("unrecognized:") || r.key.startsWith("unresolved:")));
      iv.requirements = iv.requirements.filter((r) => !from.includes(r));
      iv.requirements.push(req(text, s, key, "MUST"));
      trace.typed.push({ rule: "T1-numeric", span: c.span, from: from.map((r) => r.key), to: key, why });
      continue;
    }

    // T4: excluding a sibling variant ("not the X", "the X version") is decided by the exact lock (oracle O1): drop the
    // evidence must-not only when the parser already locked an exact model that does not carry the excluded words.
    if (c.role === "exclusion" && exactLock && /\b(?:variant|version|model|kind|edition)\b/i.test(`${c.en} ${c.span}`)) {
      const model = (orig.target?.model ?? "").toLowerCase();
      const excl = words(c.span).filter((w) => !STOP.has(w) && !/^(?:not|no|without|version|variant|kind|model|one)$/.test(w));
      const nots = here.filter((r) => r.polarity === "EXCLUDED");
      if (excl.length && excl.every((w) => !model.includes(w)) && nots.length) {
        iv.requirements = iv.requirements.filter((r) => !nots.includes(r));
        trace.typed.push({ rule: "T4-sibling-exclusion", span: c.span, from: nots.map((r) => r.key), to: null, why: `exact lock "${orig.target?.model}" excludes it` });
        continue;
      }
    }

    // T5: words the parser consumed as the exact product's identity (no requirement and no uninterpreted word over
    // the span) are not re-added as a MUST ("VK-5D twin burner stove": "twin burner" is the listing title).
    if (exactLock && (c.role === "mandatory" || c.role === "compatibility") && !c.numeric
      && !tsReqs.some((r) => overlaps(r.span, s)) && !(orig.uninterpreted ?? []).some((u) => overlaps(u.span, s))) {
      const added = iv.requirements.filter((r) => r.strength === "MUST" && overlaps(r.span, s));
      if (added.length) {
        iv.requirements = iv.requirements.filter((r) => !added.includes(r));
        trace.typed.push({ rule: "T5-identity-consumed", span: c.span, from: added.map((r) => r.key), to: null, why: "the parser consumed these words as the exact product's identity" });
      }
      continue;
    }

    // T3: one proposition for one stated attribute. The parser split or widened the words ("easy" + "fold";
    // "rust-proof rack"); the interpreter's span is the attribute. New key words come only from the span; words
    // removed from a parser key must be words of the product noun.
    if ((c.role === "mandatory" || c.role === "optional" || c.role === "exclusion") && !c.numeric) {
      const neg = c.role === "exclusion";
      const tsHere = tsReqs.filter((r) => r.source === "REQUEST_TEXT" && overlaps(r.span, s) && (neg ? r.polarity === "EXCLUDED" || r.key.startsWith("unrecognized:") : r.key.startsWith("unrecognized:")));
      if (!tsHere.length) continue;
      const core = c.span.replace(neg ? /^\s*(?:with\s+)?(?:no|not|without|non-?)\s+(?:the\s+|a\s+|an\s+)?/i : /^\s*(?:that|which|with|is|are|has|have)\s+(?:is\s+|are\s+)?/i, "").trim();
      if (!/^[A-Za-z][A-Za-z0-9 '\-]*$/.test(core)) continue; // Latin attribute words only (the evidence is matched word by word)
      const key = `${neg ? "not" : "unrecognized"}:${slugOf(core)}`;
      const typeWords = new Set(typeS ? words(text.slice(typeS[0], typeS[1])) : []);
      const lost = tsHere.flatMap((r) => words(r.key.slice(r.key.indexOf(":") + 1).replace(/-/g, " "))).filter((w) => !words(core).includes(w) && !STOP.has(w) && !/^(?:no|not)$/.test(w));
      // Only a split (two or more parser keys on the span) or a widened key (it took in a product-noun word) is repaired;
      // a single parser key that the title or evidence already decides is left alone.
      const widened = tsHere.some((r) => words(r.key.slice(r.key.indexOf(":") + 1).replace(/-/g, " ")).some((w) => typeWords.has(w)));
      if (tsHere.length < 2 && !widened) continue;
      if (lost.some((w) => !typeWords.has(w))) { trace.skipped.push({ span: c.span, why: `parser words ${lost.join(",")} are not in the span or product noun` }); continue; }
      const cur = iv.requirements.filter((r) => r.source === "REQUEST_TEXT" && overlaps(r.span, s) && (r.key.startsWith("unrecognized:") || r.key.startsWith("not:")));
      if (cur.length === 1 && cur[0]!.key === key) continue;
      iv.requirements = iv.requirements.filter((r) => !cur.includes(r));
      iv.requirements.push(req(text, s, key, strength, neg ? "EXCLUDED" : "REQUIRED"));
      trace.typed.push({ rule: "T3-attribute", span: c.span, from: cur.map((r) => r.key), to: key, why: "the interpreter's span is one attribute" });
      continue;
    }

    // T7: a person or recipient the parser read as context ("for my nephew") stays context: the interpreter may not
    // tighten it on its own word (no number, subject = user).
    if (c.role === "compatibility" && !c.numeric && c.subject === "user") {
      const ctx = tsReqs.filter((r) => r.note === "CONTEXT" && overlaps(r.span, s));
      const added = iv.requirements.filter((r) => r.strength === "MUST" && overlaps(r.span, s) && !tsReqs.some((t) => t.key === r.key));
      if (ctx.length && added.length) {
        iv.requirements = [...iv.requirements.filter((r) => !added.includes(r)), ...ctx];
        trace.typed.push({ rule: "T7-no-tightening", span: c.span, from: added.map((r) => r.key), to: ctx.map((r) => r.key).join(","), why: "parser context kept; interpreter alone may not tighten a recipient" });
      }
    }
  }
  derive(iv);
  return { intent: iv, trace };
}
