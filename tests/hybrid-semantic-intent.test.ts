import { describe, expect, it } from "vitest";
import { parseResearchIntent } from "../src/intent/ResearchIntentV2.js";
import { applySemanticIntent, escalationSignals, SemanticIntentV1 } from "../src/intent/hybrid/SemanticIntent.js";

type C = { role: string; span: string; en: string; numeric?: { op: string; value: number; unit: string | null } | null; subject?: string; component?: string | null };
const si = (item: Record<string, unknown>, constraints: C[] = [], extra: Record<string, unknown> = {}) => ({
  language: "en", item: { kind: "STANDALONE", product_type: null, brand: null, model: null, host: null, ...item },
  constraints: constraints.map((c) => ({ numeric: null, subject: "product", component: null, ...c })), budget: null, condition: null, ambiguities: [], confidence: "high", ...extra });
const run = (request: string, raw: unknown) => {
  const ts = parseResearchIntent({ request });
  const out = applySemanticIntent(ts, raw, { request }, "ALWAYS", (i) => parseResearchIntent(i), { escalate: true, signals: escalationSignals(ts, request) });
  return { ts, ...out };
};
const musts = (iv: { requirements: Array<{ key: string; strength: string; polarity: string }> }) => iv.requirements.filter((r) => r.strength === "MUST").map((r) => `${r.polarity === "EXCLUDED" ? "-" : "+"}${r.key}`);

describe("hybrid semantic intent adapter (experiment)", () => {
  it("schema: rejects malformed JSON and leaves the TypeScript intent untouched", () => {
    const r = run("Corvane Basin 30k for a family of 5 on well water", { item: "nope" });
    expect(r.trace.schemaValid).toBe(false);
    expect(r.intent).toBe(r.ts);
    expect(SemanticIntentV1.safeParse(si({ kind: "STANDALONE" })).success).toBe(true);
  });

  it("B: a MUST the parser read never disappears because the interpreter calls it context (family of 5)", () => {
    const request = "Corvane Basin 30k for a family of 5 on well water";
    const r = run(request, si({ brand: { text: "Corvane", span: "Corvane" }, model: { text: "Basin 30k", span: "Basin 30k" } },
      [{ role: "context", span: "for a family of 5", en: "household of five" }, { role: "compatibility", span: "on well water", en: "works with well water" }]));
    const before = musts(r.ts);
    for (const k of before) expect(musts(r.intent)).toContain(k);
    expect(r.trace.conflicts.some((c) => c.what === "kept-must")).toBe(true);
  });

  it("B: the interpreter can tighten a context reading into a MUST (for kids)", () => {
    const r = run("bike helmet for kids", si({ product_type: { text: "bike helmet", span: "bike helmet", en: "bike helmet" } },
      [{ role: "compatibility", span: "for kids", en: "sized for kids", subject: "user" }]));
    expect(r.ts.requirements.find((x) => x.text === "for kids")?.strength).toBe("NICE");
    expect(r.intent.requirements.some((x) => x.text === "for kids" && x.strength === "MUST")).toBe(true);
    expect(r.intent.unresolvedMust.length).toBeGreaterThan(0);
  });

  it("C: 'up to 70 lb total' keeps the user's words; the interpreter's direction is not used", () => {
    const r = run("dog trailer for two dogs up to 70 lb total", si({ product_type: { text: "dog trailer", span: "dog trailer", en: "dog trailer" } },
      [{ role: "mandatory", span: "up to 70 lb total", en: "at most 70 lb capacity", numeric: { op: "<=", value: 70, unit: "lb" }, subject: "load" },
       { role: "mandatory", span: "for two dogs", en: "carries two dogs", numeric: { op: ">=", value: 2, unit: "dogs" }, subject: "user" }]));
    const up = r.intent.requirements.find((x) => x.text.includes("70 lb"))!;
    expect(up.strength).toBe("MUST");
    expect(up.key).not.toMatch(/at-most/);
    expect(r.intent.requirements.some((x) => x.text === "for two dogs" && x.strength === "MUST")).toBe(true);
  });

  it("C: a direction the request contradicts becomes a blocking open requirement, never a dropped one", () => {
    const r = run("patio heater with at least 3 heat settings", si({ product_type: { text: "patio heater", span: "patio heater", en: "patio heater" } },
      [{ role: "mandatory", span: "at least 3 heat settings", en: "at most 3 heat settings", numeric: { op: "<=", value: 3, unit: "settings" } }]));
    // product-type words ("camping" in "patio heater") are identity, not requirements
    const nonIdentity = (ks: string[]) => ks.filter((k) => k !== "unrecognized:patio" && k !== "+unrecognized:patio");
    expect(r.intent.unresolvedMust).toEqual(expect.arrayContaining(nonIdentity(r.ts.unresolvedMust)));
    expect(r.intent.unresolvedMust).toContain("unresolved:at-least-3-heat-settings");
    expect(musts(r.intent)).toEqual(expect.arrayContaining(nonIdentity(musts(r.ts))));
  });

  it("C: a misattached weight ('a carrycot that weighs under 6 kg') is kept as written", () => {
    const r = run("stroller with a carrycot that weighs under 6 kg", si({ product_type: { text: "stroller", span: "stroller", en: "stroller" } },
      [{ role: "mandatory", span: "a carrycot that weighs under 6 kg", en: "carrycot weighs under 6 kg", numeric: { op: "<", value: 6, unit: "kg" }, subject: "component", component: "carrycot" }]));
    for (const k of musts(r.ts).filter((k) => k !== "+unrecognized:stroller")) expect(musts(r.intent)).toContain(k);
    expect(r.intent.requirements.some((x) => x.text === "a carrycot that weighs under 6 kg" || /6 kg/.test(x.text))).toBe(true);
  });

  it("C: a threshold is not an exact capacity attribute (at least 50 liters)", () => {
    const r = run("cooler with at least 50 liters", si({ product_type: { text: "cooler", span: "cooler", en: "cooler" } },
      [{ role: "mandatory", span: "at least 50 liters", en: "at least 50 liters capacity", numeric: { op: ">=", value: 50, unit: "L" } }]));
    expect(r.ts.attributes.capacity).toBe("50 L");
    expect(r.intent.attributes.capacity).toBeUndefined();
    expect(musts(r.intent)).toEqual(expect.arrayContaining(musts(r.ts)));
  });

  it("B: 'Wi-Fi only' becomes a MUST when the parser dropped it", () => {
    const request = "Tarrow Kiln 12, Wi-Fi only";
    const r = run(request, si({ brand: { text: "Tarrow", span: "Tarrow" }, model: { text: "Kiln 12", span: "Kiln 12" } },
      [{ role: "mandatory", span: "Wi-Fi only", en: "has Wi-Fi" }]));
    expect(r.intent.requirements.some((x) => x.text === "Wi-Fi only" && x.strength === "MUST")).toBe(true);
  });

  it("D: a part written after the host model is the part, not the host", () => {
    const r = run("Pennick Range 5-Ring griddle", si({ kind: "ACCESSORY", product_type: { text: "griddle", span: "griddle", en: "griddle" }, host: { text: "Pennick Range 5-Ring", span: "Pennick Range 5-Ring" } }));
    expect(r.ts.target?.kind).toBe("STANDALONE");
    expect(r.intent.target?.kind).toBe("ACCESSORY");
    expect(r.intent.target?.accessoryNoun).toBe("griddle");
  });

  it("D: a kind conflict the text cannot settle blocks instead of guessing", () => {
    const r = run("drip tray for the Pennick Range 4-Ring", si({ kind: "STANDALONE", product_type: { text: "stove", span: null, en: "stove" }, brand: { text: "Pennick", span: "Pennick" }, model: { text: "Range 4-Ring", span: "Range 4-Ring" } }));
    expect(r.intent.target?.kind).toBe("ACCESSORY");
    expect(r.intent.unresolvedMust).toContain("ambiguous:item-kind");
  });

  it("E: spans that are not in the request are rejected", () => {
    const r = run("rain jacket, but not the hooded one", si({ product_type: { text: "rain jacket", span: "rain jacket", en: "rain jacket" } }, [{ role: "exclusion", span: "no hood please", en: "no hood" }]));
    expect(r.trace.rejected.some((x) => x.detail.includes("no hood please"))).toBe(true);
    expect(musts(r.intent)).toEqual(musts(r.ts));
  });

  it("exclusion: 'not the hooded one' becomes a must-not", () => {
    const r = run("rain jacket, but not the hooded one", si({ product_type: { text: "rain jacket", span: "rain jacket", en: "rain jacket" } }, [{ role: "exclusion", span: "not the hooded one", en: "not hooded" }]));
    expect(musts(r.intent)).toContain("-not:hooded");
  });

  it("F: budget, currency and condition come only from the TypeScript parser", () => {
    const r = run("hedge trimmer under $150 with at least a 50 cm blade", si({ product_type: { text: "hedge trimmer", span: "hedge trimmer", en: "hedge trimmer" } },
      [{ role: "mandatory", span: "at least a 50 cm blade", en: "blade length at least 50 cm", numeric: { op: ">=", value: 50, unit: "cm" } }], { budget: { span: "under $150" }, condition: { value: "any", span: "hedge trimmer" } }));
    expect(r.intent.budgetMaxMinor).toBe(r.ts.budgetMaxMinor);
    expect(r.intent.currency).toBe(r.ts.currency);
    expect(r.intent.condition).toBe(r.ts.condition);
    expect(r.intent.requirements.some((x) => x.text === "at least a 50 cm blade" && x.strength === "MUST")).toBe(true);
  });

  it("Korean: a threshold the parser skips is recovered and the search is in English", () => {
    const r = run("4구 이상 인덕션", { ...si({ product_type: { text: "인덕션", span: "인덕션", en: "induction cooktop" } },
      [{ role: "mandatory", span: "4구 이상", en: "at least 4 burners", numeric: { op: ">=", value: 4, unit: "burners" } }]), language: "ko" });
    expect(r.ts.requirements.length).toBe(0);
    expect(r.intent.requirements.some((x) => x.strength === "MUST" && /4/.test(x.key))).toBe(true);
    expect(r.intent.queries.primary).toMatch(/induction/);
  });

  it("escalation fires on structural cues even when the parse looks clean", () => {
    const ts = parseResearchIntent({ request: "patio heater for a weekend trip" });
    expect(escalationSignals(ts, "patio heater for a weekend trip")).toContain("FOR_X_PRESENT");
    const plain = parseResearchIntent({ request: "Pennick Range 4-Ring" });
    expect(escalationSignals(plain, "Pennick Range 4-Ring")).toEqual([]);
  });

  it("regression: a type the parser reads with a feature keeps the feature (heat pump dryer)", () => {
    const r = run("히트펌프 의류건조기", { ...si({ product_type: { text: "히트펌프 의류건조기", span: "히트펌프 의류건조기", en: "heat pump dryer" } }), language: "ko" });
    expect(musts(r.intent)).toContain("+unrecognized:heat-pump");
  });

  it("regression: a partial parser MUST does not stand in for the whole constraint (15 lb pellet bin)", () => {
    const request = "Tarrow Kiln 18 with at least a 15 lb pellet bin";
    const r = run(request, si({ brand: { text: "Tarrow", span: "Tarrow" }, model: { text: "Kiln 18", span: "Kiln 18" } },
      [{ role: "mandatory", span: "at least a 15 lb pellet bin", en: "pellet bin of at least 15 lb", numeric: { op: ">=", value: 15, unit: "lb" }, subject: "component", component: "pellet bin" }]));
    expect(r.intent.requirements.some((x) => x.text === "at least a 15 lb pellet bin" && x.strength === "MUST")).toBe(true);
  });

  it("regression: an 'exclusion' without a negation word is a requirement, not a must-not (cooling only)", () => {
    const r = run("portable air conditioner for a room of at least 400 sq ft, cooling only", si({ product_type: { text: "portable air conditioner", span: "portable air conditioner", en: "portable air conditioner" } },
      [{ role: "exclusion", span: "cooling only", en: "no heating function" }]));
    expect(r.intent.requirements.some((x) => x.text === "cooling only" && x.polarity === "REQUIRED" && x.strength === "MUST")).toBe(true);
    expect(r.intent.requirements.some((x) => x.polarity === "EXCLUDED" && /cooling/.test(x.text))).toBe(false);
  });

  it("regression: identity words are not released when no identity is locked", () => {
    const request = "소담 RK-50 커버 주세요";
    const r = run(request, { ...si({ kind: "UNKNOWN", brand: { text: "소담", span: "소담" }, model: null }), language: "ko" });
    expect((r.intent.uninterpreted ?? []).map((u) => u.text)).toEqual(expect.arrayContaining((r.ts.uninterpreted ?? []).map((u) => u.text).filter((t) => t === "소담")));
  });

  it("regression: a parser lexicon that maps the interpreter's type elsewhere is not used (massage chair)", () => {
    const r = run("키 190cm도 쓸 수 있는 누리 안마의자", { ...si({ product_type: { text: "안마의자", span: "안마의자", en: "massage chair" }, brand: { text: "누리", span: "누리" } }), language: "ko" });
    expect(r.trace.identity).toBe("TS");
    expect(musts(r.intent)).toEqual(expect.arrayContaining(musts(r.ts).filter((k) => /누리|안마/.test(k))));
  });

  it("regression: a part written after a non-Latin host is never locked as the host itself", () => {
    const request = "누리 NV-30K 필터";
    const r = run(request, { ...si({ kind: "STANDALONE", product_type: { text: "필터", span: "필터", en: "filter" }, brand: { text: "누리", span: "누리" }, model: { text: "NV-30K", span: "NV-30K" } }), language: "ko" });
    const iv = r.intent;
    const lockedHostAsProduct = iv.target?.kind === "STANDALONE" && iv.target.model === "NV-30K" && !iv.targetNoun;
    expect(lockedHostAsProduct).toBe(false);
    if (iv.target?.kind === "STANDALONE") expect((iv.uninterpreted ?? []).map((u) => u.text)).toContain("필터");
  });
});
