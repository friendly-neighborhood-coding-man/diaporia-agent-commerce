/**
 * npm run eval:research   # deterministic research-pipeline evaluation on the fictional eval world
 * Writes docs/evidence/research-eval/research-eval-<timestamp>.json. Exit 1 on any critical error.
 * No network, no provider or model calls.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { runResearchEval } from "./research-eval/run.js";

const r = await runResearchEval();
for (const c of r.cases) {
  console.log(`${c.pass ? "PASS" : "FAIL"} ${c.id} ${c.category.padEnd(16)} ${String(c.latencyMs).padStart(7)} ms  ${c.adapterCalls} adapter calls${c.error ? `  error: ${c.error}` : ""}`);
  for (const k of c.checks.filter((x) => !x.pass)) console.log(`     ✗ ${k.field}: expected ${JSON.stringify(k.expected)}, observed ${JSON.stringify(k.observed)}${k.critical ? "  [CRITICAL]" : ""}`);
}
let commit = "unknown"; try { commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim(); } catch { /* */ }
const out = { schema: "diaporia.research-eval.v1", evidenceClass: "OFFLINE_FIXTURE_EVAL", generatedAt: new Date().toISOString(), commit, ...r };
mkdirSync("docs/evidence/research-eval", { recursive: true });
const file = `docs/evidence/research-eval/research-eval-${out.generatedAt.replace(/[:.]/g, "-")}.json`;
writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
console.log(`\n${r.metrics.passed}/${r.metrics.cases} cases pass, ${r.metrics.criticalErrors} critical errors, p50 ${r.metrics.latencyMs.p50} ms → ${file}`);
console.log(JSON.stringify(r.metrics.byDimension));
process.exit(r.metrics.criticalErrors ? 1 : 0);
