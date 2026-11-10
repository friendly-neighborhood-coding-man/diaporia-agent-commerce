/**
 * npm run eval:research:v2 [-- --root <checkout> --label <name>]
 * Runs the research eval v2 corpus (dev + frozen holdout) against a checkout (default: this one) and writes
 * docs/evidence/research-eval-v2/<label>-<timestamp>.json. Offline: fake provider endpoints only.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { runSuite } from "./research-eval-v2/run.js";

const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const root = resolve(arg("--root") ?? ".");
const label = arg("--label") ?? "current";
const r = await runSuite(root);
for (const c of r.results)
  console.log(`${c.stateOk ? "ok  " : "MISS"} ${c.id.padEnd(4)} ${c.state.padEnd(11)} exp ${c.expectedStates.join("|").padEnd(18)} rec=${c.recommendedGroup ?? "-"}${c.unsafeForbidden || c.unsafeShouldNotRecommend ? "  [UNSAFE]" : ""}${c.falseLock ? "  [FALSE LOCK]" : ""}${c.error ? "  error: " + c.error : ""}`);
let commit = "unknown"; try { commit = execFileSync("git", ["-C", root, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim(); } catch { /* */ }
const out = { schema: "diaporia.research-eval.v2", evidenceClass: "OFFLINE_AGENT_AUTHORED_FIXTURE_EVAL", label, root, commit, generatedAt: new Date().toISOString(), ...r };
mkdirSync("docs/evidence/research-eval-v2", { recursive: true });
const file = `docs/evidence/research-eval-v2/${label}-${out.generatedAt.replace(/[:.]/g, "-")}.json`;
writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify(r.summary, null, 1));
console.log(`→ ${file}`);
