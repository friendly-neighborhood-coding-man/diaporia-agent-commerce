import { describe, expect, it } from "vitest";
import { parseResearchIntent } from "../src/intent/ResearchIntentV2.js";
import { applyTypedSemanticIntent } from "../src/intent/hybrid/typed/TypedSemanticIntent.js";
import { applyContractIntent } from "../src/intent/hybrid/contract/ContractIntent.js";

// Diagnostic prototypes (experiment/semantic-boundary-diagnosis). Invented names only.
type C = { role: string; span: string; en: string; numeric?: { op: string; value: number; unit: string | null } | null; subject?: string };
const si = (item: Record<string, unknown>, constraints: C[] = []) => ({
  language: "en", item: { kind: "STANDALONE", product_type: null, brand: null, model: null, host: null, ...item },
  constraints: constraints.map((c) => ({ numeric: null, subject: "product", component: null, ...c })), budget: null, condition: null, ambiguities: [], confidence: "high" });
const typed = (request: string, raw: unknown) => applyTypedSemanticIntent(parseResearchIntent({ request }), raw, { request }, "ALWAYS", (i) => parseResearchIntent(i));
const keys = (iv: { requirements: Array<{ key: string; strength: string }> }) => iv.requirements.filter((r) => r.strength === "MUST").map((r) => r.key).sort();

describe("typed adapter prototype", () => {
  it("T1: a load count becomes an at-least threshold the evidence engine evaluates", () => {
    const r = typed("dog crate for 3 dogs", si({ product_type: { text: "dog crate", span: "dog crate", en: "dog crate" } },
      [{ role: "compatibility", span: "for 3 dogs", en: "holds at least 3 dogs", numeric: { op: ">=", value: 3, unit: "dogs" }, subject: "load" }]));
    expect(keys(r.intent)).toContain("unrecognized:at-least-3-dogs");
    expect(keys(r.intent)).not.toContain("unrecognized:for-3-dogs");
  });
  it("T1: the product's own weight is anchored, and the number must be written in the span", () => {
    const ok = typed("folding stroller under 7 kg", si({ product_type: { text: "folding stroller", span: "folding stroller", en: "stroller" } },
      [{ role: "mandatory", span: "under 7 kg", en: "weighs under 7 kg", numeric: { op: "<", value: 7, unit: "kg" }, subject: "product" }]));
    expect(keys(ok.intent)).toContain("unrecognized:at-most-7-kg-weighs");
    const wrong = typed("folding stroller under 7 kg", si({}, [{ role: "mandatory", span: "under 7 kg", en: "weighs under 8 kg", numeric: { op: "<", value: 8, unit: "kg" }, subject: "product" }]));
    expect(keys(wrong.intent)).not.toContain("unrecognized:at-most-8-kg-weighs");
    expect(wrong.trace.skipped.map((s) => s.why)).toContain("number not written in the span");
  });
  it("T1: '=' on a load has no typed form and stays fail-closed", () => {
    const r = typed("Acme Tilo 3 for about 300 lb", si({ brand: { text: "Acme", span: "Acme" }, model: { text: "Tilo 3", span: "Tilo 3" } },
      [{ role: "mandatory", span: "about 300 lb", en: "about 300 lb", numeric: { op: "=", value: 300, unit: "lb" }, subject: "load" }]));
    expect(r.trace.typed.some((t) => t.rule === "T1-numeric")).toBe(false);
  });
  it("T7: an interpreter alone may not tighten a recipient the parser read as context", () => {
    const r = typed("Acme Tilo 3 for my nephew", si({ brand: { text: "Acme", span: "Acme" }, model: { text: "Tilo 3", span: "Tilo 3" } },
      [{ role: "compatibility", span: "for my nephew", en: "suits a nephew", subject: "user" }]));
    expect(keys(r.intent).some((k) => k.includes("nephew"))).toBe(false);
  });
});

describe("contract-aware arm prototype", () => {
  const contract = (request: string, raw: unknown) => applyContractIntent(parseResearchIntent({ request }), raw, { request }, (i) => parseResearchIntent(i));
  it("verified forms reach the engine; an unsupported condition keeps the parser's reading", () => {
    const r = contract("Acme Tilo 3 for a family of four, rated down to -20 °C", { identity: { kind: "STANDALONE", spans: ["Acme", "Tilo 3"], canonical: "Acme Tilo 3" },
      constraints: [{ span: "for a family of four", form: "FAMILY_OF", canonical: "for a family of 4" }, { span: "rated down to -20 °C", form: "UNSUPPORTED_CAPABILITY", canonical: null, note: "minimum rating" }] });
    expect(r.trace.identity).toBe("CONTRACT");
    expect(r.intent.requirements.map((q) => q.key)).toContain("unrecognized:for-a-family-of-4");
    expect(r.trace.failClosed).toHaveLength(1);
  });
  it("a restated number that differs from the span is refused", () => {
    const r = contract("widget for a family of 4", { identity: { kind: "DISCOVERY", spans: ["widget"], canonical: "widget" },
      constraints: [{ span: "for a family of 4", form: "FAMILY_OF", canonical: "for a family of 5" }] });
    expect(r.intent.requirements.map((q) => q.key)).not.toContain("unrecognized:for-a-family-of-5");
  });
  it("an identity phrase the parser does not confirm falls back to the parser", () => {
    const r = contract("Acme Tilo 3", { identity: { kind: "ACCESSORY", spans: ["Acme", "Tilo 3"], canonical: "Acme Tilo 3" }, constraints: [] });
    expect(r.trace.identity).toBe("TS_FALLBACK");
  });
});
