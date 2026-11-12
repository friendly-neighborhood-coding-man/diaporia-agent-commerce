// Validates raw Haiku outputs (JSONL from the runner) with the shared Zod schemas, projects every valid document into
// diaporia.semantic-intent.v1.1 and writes (a) per-record validation rows and (b) one fixture per arm {request: v1.1 doc}.
// usage: tsx validate-runs.mts <trial.jsonl> <outdir>
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { validateDocument, projectToV11 } from "../../src/intent/hybrid/category/CategoryIntent.ts";
import type { Arm } from "../../src/intent/hybrid/category/CategoryTaxonomy.ts";
const [, , inp, out] = process.argv;
mkdirSync(out!, { recursive: true });
const rows: any[] = []; const fx: Record<string, Record<string, unknown>> = {};
for (const line of readFileSync(inp!, "utf8").split("\n")) {
  if (!line.trim()) continue;
  const d = JSON.parse(line); const arm = d.arm as Arm;
  let raw = d.doc;
  if (raw == null && d.result_text) { try { raw = JSON.parse(d.result_text.replace(/^```(?:json)?|```$/g, "")); } catch { raw = null; } }
  const { doc, v } = validateDocument(arm, d.request, raw);
  let proj: any = null;
  if (doc) { proj = projectToV11(arm, d.request, doc); (fx[arm] ??= {})[d.request.normalize("NFKC").trim()] = proj.v11; }
  rows.push({ arm, trial: d.trial, request: d.request, error: d.error ?? null, models: d.models, out_tokens: d.usage?.output_tokens ?? null, thinking: d.thinking_tokens, in_tokens: d.usage ? (d.usage.input_tokens ?? 0) + (d.usage.cache_creation_input_tokens ?? 0) + (d.usage.cache_read_input_tokens ?? 0) : null,
    ms: d.duration_ms ?? null, cost: d.cost_list_usd ?? null, ...v, withheld: proj?.trace.withheld ?? [], executed: proj?.trace.executed ?? 0, doc });
}
writeFileSync(`${out}/validation.json`, JSON.stringify(rows));
for (const [arm, f] of Object.entries(fx)) writeFileSync(`${out}/fixture-${arm}.json`, JSON.stringify(f));
const by: Record<string, any> = {};
for (const r of rows) { const b = (by[r.arm] ??= { n: 0, valid: 0, conflicts: 0, unitsWithConflict: 0, nonVerbatim: 0, uncoveredCases: 0, uncoveredTok: 0, tok: 0, dup: 0, unresolved: 0, out: 0, ms: 0, units: 0, models: new Set() });
  b.n++; if (r.schemaValid) b.valid++; b.conflicts += r.conflicts.length ? 1 : 0; b.unitsWithConflict += r.conflicts.length; b.nonVerbatim += r.nonVerbatim.length; b.uncoveredCases += r.uncovered.length ? 1 : 0; b.uncoveredTok += r.uncovered.length; b.tok += r.contentTokens;
  b.dup += r.duplicatesMandatory; b.unresolved += r.unresolved; b.out += r.out_tokens ?? 0; b.ms += r.ms ?? 0; b.units += r.units; for (const m of r.models ?? []) b.models.add(m); }
for (const [a, b] of Object.entries(by)) console.log(a, JSON.stringify({ ...b, models: [...b.models], meanOut: Math.round(b.out / b.n), meanMs: Math.round(b.ms / b.n) }));
