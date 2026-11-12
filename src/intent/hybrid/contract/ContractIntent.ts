/**
 * DIAGNOSTIC PROTOTYPE (experiment/semantic-boundary-diagnosis). Not wired into any default path.
 *
 * Contract-aware arm: the interpreter restates the request ONLY in the expression forms of
 * research/semantic-boundary/ts-contract.v0.1.0.json (prompt PROMPT_CONTRACT_V1.txt). Every phrase is then checked
 * with the real TypeScript parser: the identity phrase must parse to the stated kind and keep the request's model
 * tokens; each condition phrase must parse to exactly one requirement of its form with the span's own numbers. A
 * phrase that fails, and every UNSUPPORTED_CAPABILITY, keeps the parser's own reading of that span (or a verbatim
 * MUST): fail closed. A parser requirement the interpreter did not cover is kept. The engine then receives the
 * parser's intent of the verified restatement. Spending limit, condition (new/used), evidence and payment come only
 * from the parser's reading of the ORIGINAL request.
 */
import type { PurchaseRequestInput } from "../../PurchaseIntentRouter.js";
import type { ResearchIntentV2 } from "../../ResearchIntentV2.js";
import { slugOf, type StatedRequirement } from "../../Requirements.js";

export const CONTRACT_ARM_VERSION = "contract-arm-proto-0.1.0";
export const CONTRACT_SCHEMA = "diaporia.contract-intent.v1";

type Kind = "DISCOVERY" | "STANDALONE" | "ACCESSORY" | "BUNDLE";
interface CCons { span: string; form: string; canonical?: string | null; note?: string | null }
interface CIntent { identity: { kind: Kind; spans: string[]; canonical: string; brand_transliterated?: boolean }; constraints: CCons[]; budget_span?: string | null; condition_span?: string | null }
export interface ContractTrace { adapter: string; usedInterpreter: boolean; identity: "CONTRACT" | "TS_FALLBACK"; composed: string | null;
  accepted: Array<{ form: string; span: string; canonical: string; key: string }>; failClosed: Array<{ form: string; span: string; why: string; kept: string[] }>; keptFromParser: string[]; rejected: string[] }

const FORM_KEY: Record<string, (r: StatedRequirement) => boolean> = {
  CAPABILITY: (r) => r.recognized && r.polarity === "REQUIRED",
  ABSENT: (r) => r.polarity === "EXCLUDED",
  PROPERTY: (r) => r.key.startsWith("unrecognized:") && !/\d/.test(r.key),
  AT_LEAST: (r) => /^unrecognized:at-least-\d/.test(r.key),
  AT_MOST: (r) => /^unrecognized:at-most-\d/.test(r.key),
  FOR_QUANTITY: (r) => /^unrecognized:for-(?:a-)?\d/.test(r.key),
  FAMILY_OF: (r) => /^unrecognized:for-a-family-of-\d+$/.test(r.key),
  PERSON_COUNT: (r) => /^unrecognized:\d+-person$/.test(r.key),
};
const NUMWORD: Record<string, string> = { one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10" };
const nums = (s: string) => [...(s.match(/\d+(?:\.\d+)?/g) ?? []), ...s.toLowerCase().split(/[^a-z]+/).filter((w) => NUMWORD[w]).map((w) => NUMWORD[w]!)].sort();
const locate = (text: string, span: string | null | undefined): [number, number] | null => { if (!span) return null; const i = text.indexOf(span); return i < 0 ? null : [i, i + span.length]; };
const overlaps = (a: [number, number], b: [number, number]) => a[0] < b[1] && b[0] < a[1];
const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[^a-z0-9가-힣]+/g, "");

function derive(iv: ResearchIntentV2) {
  const d = new Map<string, StatedRequirement>();
  for (const r of iv.requirements) { const p = d.get(r.key); if (!p || (p.strength === "NICE" && r.strength === "MUST")) d.set(r.key, r); }
  iv.requirements = [...d.values()];
  iv.mustHave = [...new Set(iv.requirements.filter((r) => r.recognized && r.polarity === "REQUIRED" && r.strength === "MUST").map((r) => r.capability!))];
  iv.niceToHave = [...new Set(iv.requirements.filter((r) => r.recognized && r.polarity === "REQUIRED" && r.strength === "NICE").map((r) => r.capability!).filter((c) => !iv.mustHave.includes(c)))];
  iv.unresolvedMust = iv.requirements.filter((x) => x.strength === "MUST" && (!x.recognized || x.polarity === "EXCLUDED")).map((r) => r.key);
}

export function applyContractIntent(orig: ResearchIntentV2, raw: unknown, input: PurchaseRequestInput, reparse: (i: PurchaseRequestInput) => ResearchIntentV2): { intent: ResearchIntentV2; trace: ContractTrace } {
  const trace: ContractTrace = { adapter: CONTRACT_ARM_VERSION, usedInterpreter: false, identity: "TS_FALLBACK", composed: null, accepted: [], failClosed: [], keptFromParser: [], rejected: [] };
  const ci = raw as CIntent | null;
  const text = input.request;
  if (!ci || typeof ci !== "object" || !ci.identity || !Array.isArray(ci.constraints) || typeof ci.identity.canonical !== "string") { trace.rejected.push("no or malformed interpretation"); return { intent: orig, trace }; }
  trace.usedInterpreter = true;

  // ---- identity: verbatim spans, kind confirmed by the parser, model tokens kept.
  const idSpans = (ci.identity.spans ?? []).map((s) => locate(text, s));
  if (idSpans.some((s) => !s)) { trace.rejected.push("identity span not verbatim"); return { intent: orig, trace }; }
  const idp = reparse({ ...input, request: ci.identity.canonical });
  const kindOk = ci.identity.kind === "DISCOVERY" ? !idp.target : !!idp.target && idp.target.kind === ci.identity.kind;
  const tokens = ci.identity.canonical.split(/\s+/).filter((w) => /\d/.test(w));
  const tokOk = tokens.every((w) => norm(text).includes(norm(w)));
  const brand = idp.target?.brand ?? null;
  const brandOk = !brand || norm(text).includes(norm(brand)) || (!!ci.identity.brand_transliterated && /[^\u0000-ɏ]/.test((ci.identity.spans ?? []).join(" ")));
  if (!kindOk || !tokOk || !brandOk || (idp.uninterpreted ?? []).length) {
    trace.rejected.push(`identity "${ci.identity.canonical}" not confirmed (kind ${kindOk}, model tokens ${tokOk}, brand ${brandOk}, uninterpreted ${(idp.uninterpreted ?? []).map((u) => u.text).join(",") || "-"})`);
    return { intent: orig, trace };
  }
  trace.identity = "CONTRACT";

  // ---- conditions: each canonical phrase must parse to exactly one requirement of its form.
  const included: string[] = []; const failSpans: Array<[number, number]> = []; const covered: Array<[number, number]> = idSpans as Array<[number, number]>;
  for (const c of ci.constraints) {
    const s = locate(text, c.span);
    if (!s) { trace.rejected.push(`constraint span "${c.span}" not verbatim`); continue; }
    covered.push(s);
    const fail = (why: string) => { failSpans.push(s); trace.failClosed.push({ form: c.form, span: c.span, why, kept: [] }); };
    if (c.form === "UNSUPPORTED_CAPABILITY" || !c.canonical) { fail(c.note ?? "unsupported"); continue; }
    const p = reparse({ ...input, request: `widget ${c.canonical}` });
    const rs = p.requirements.filter((r) => r.note !== "CATEGORY_WORD");
    if (c.form === "CONTEXT") {
      if (rs.length === 1 && rs[0]!.note === "CONTEXT" && !(p.uninterpreted ?? []).length) { included.push(c.canonical); trace.accepted.push({ form: c.form, span: c.span, canonical: c.canonical, key: rs[0]!.key }); }
      else fail(`context phrase parsed as ${rs.map((r) => r.key).join(",") || "nothing"}`);
      continue;
    }
    const check = FORM_KEY[c.form];
    if (!check) { fail(`unknown form ${c.form}`); continue; }
    const one = rs.length === 1 ? rs[0]! : null;
    const numOk = JSON.stringify(nums(c.canonical)) === JSON.stringify(nums(c.span));
    if (!one || !check(one) || one.strength !== "MUST" || (p.uninterpreted ?? []).length || !numOk) {
      fail(`"${c.canonical}" parsed as ${rs.map((r) => `${r.key}/${r.strength}`).join(",") || "nothing"}${(p.uninterpreted ?? []).length ? ` + uninterpreted ${(p.uninterpreted ?? []).map((u) => u.text).join(",")}` : ""}${numOk ? "" : " (numbers differ from the span)"}`);
      continue;
    }
    included.push(c.canonical); trace.accepted.push({ form: c.form, span: c.span, canonical: c.canonical, key: one.key });
  }
  for (const b of [ci.budget_span, ci.condition_span]) { const s = locate(text, b ?? null); if (s) covered.push(s); }

  // ---- the engine's intent: the parser's reading of the verified restatement.
  const composed = [ci.identity.canonical, ...included].join(", ");
  trace.composed = composed;
  const iv: ResearchIntentV2 = structuredClone(reparse({ ...input, request: composed }));
  // Money and condition only from the parser's reading of the original request.
  for (const k of Object.keys(orig) as Array<keyof ResearchIntentV2>) if (/^(?:budget|money|currency|condition)/.test(String(k))) (iv as any)[k] = structuredClone((orig as any)[k]);
  // Fail closed: an unsupported or unverified span keeps the parser's own reading, else a verbatim MUST.
  for (const s of failSpans) {
    const tsHere = orig.requirements.filter((r) => r.source === "REQUEST_TEXT" && overlaps(r.span, s));
    const un = (orig.uninterpreted ?? []).filter((u) => overlaps(u.span, s));
    const kept = tsHere.length || un.length ? tsHere : [{ key: `unrecognized:${slugOf(text.slice(s[0], s[1]))}`, text: text.slice(s[0], s[1]), span: s, recognized: false, capability: null, polarity: "REQUIRED", strength: "MUST", source: "REQUEST_TEXT" } as StatedRequirement];
    iv.requirements.push(...kept);
    if (un.length) iv.uninterpreted = [...(iv.uninterpreted ?? []), ...un];
    trace.failClosed.find((f) => f.span === text.slice(s[0], s[1]))?.kept.push(...kept.map((r) => r.key), ...un.map((u) => `uninterpreted:${u.text}`));
  }
  // A parser requirement or uninterpreted word outside every interpreter span is kept (never dropped silently).
  for (const r of orig.requirements) if (r.source === "REQUEST_TEXT" && r.strength === "MUST" && !covered.some((s) => overlaps(r.span, s))) { iv.requirements.push(r); trace.keptFromParser.push(r.key); }
  for (const u of orig.uninterpreted ?? []) if (!covered.some((s) => overlaps(u.span, s))) { iv.uninterpreted = [...(iv.uninterpreted ?? []), u]; trace.keptFromParser.push(`uninterpreted:${u.text}`); }
  iv.assumptions = [...iv.assumptions, `Contract-aware interpretation (${CONTRACT_ARM_VERSION}): restated as "${composed}"; ${trace.accepted.length} verified, ${trace.failClosed.length} kept fail-closed.`];
  derive(iv);
  return { intent: iv, trace };
}
