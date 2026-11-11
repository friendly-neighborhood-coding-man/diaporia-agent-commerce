/**
 * V2.1 Phase 4: run an INDEPENDENTLY AUTHORED, FROZEN case file (docs/research/V2.1_EVAL_PROTOCOL.md).
 *
 *   npx tsx scripts/research-eval-v2/frozen.ts --manifest <manifest.json> [--root .] [--label name]
 *   npx tsx scripts/research-eval-v2/frozen.ts --validate --manifest <manifest.json>   (schema/world check only; prints no case content)
 *
 * The manifest pins the case file by SHA-256 and the fake world (world.ts) by SHA-256. The runner refuses to run when
 * either changed, runs BOTH arms (service caps 1/2 and expanded eval caps 6/12) with the workflow check, and appends
 * each run to docs/evidence/research-eval-v2/FROZEN_RUNS.json. The FIRST run of a (case file, arm) pair is the clean
 * number; any later run of the same pair is labelled SEEN and must never be reported as fresh evidence.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { EvalCaseV2 } from "./cases.js";
import { WORLD } from "./world.js";
import { EVAL_CAPS, SERVICE_ARM_CAPS, loadRoot, runCase, summarize, type CaseOutcome } from "./run.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export interface FrozenManifest {
  schema: "diaporia.research-eval.frozen-manifest.v1";
  /** Path relative to the manifest. JSON array of EvalCaseV2 (split may be any string label, e.g. "frozen-r1"). */
  caseFile: string;
  sha256: string;
  cases: number;
  author: string;
  frozenAt: string;
  /** sha256 of scripts/research-eval-v2/world.ts at freeze time: the cases are written against this world. */
  worldSha256: string;
  note?: string;
}
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
export const worldSha256 = () => sha(readFileSync(join(HERE, "world.ts")));
const GROUPS = new Set(WORLD.map((p) => p.truth.group));
const STATES = new Set(["RECOMMEND", "INVESTIGATE", "HOLD"]);

/** Structural validation; errors name case ids and fields only, never case content. */
export function validateCases(cases: unknown): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!Array.isArray(cases)) return { ok: false, errors: ["case file is not a JSON array"] };
  const ids = new Set<string>();
  cases.forEach((c: any, i) => {
    const id = typeof c?.id === "string" ? c.id : `#${i}`;
    if (typeof c?.id !== "string" || ids.has(c.id)) errors.push(`${id}: missing or duplicate id`); else ids.add(c.id);
    if (typeof c?.request !== "string" || c.request.length < 3) errors.push(`${id}: request`);
    if (!["en", "ko"].includes(c?.lang)) errors.push(`${id}: lang`);
    if (!Array.isArray(c?.expect?.state) || !c.expect.state.length || c.expect.state.some((s: string) => !STATES.has(s))) errors.push(`${id}: expect.state`);
    const groups = [...(c?.expect?.top ?? []), ...Object.keys(c?.expect?.rel ?? {}), ...(c?.expect?.forbidden ?? []), ...(c?.expect?.lock ? [c.expect.lock] : [])];
    for (const g of groups) if (!GROUPS.has(g)) errors.push(`${id}: unknown world group`);
  });
  return { ok: errors.length === 0, errors };
}

export function loadFrozen(manifestPath: string) {
  const m = JSON.parse(readFileSync(manifestPath, "utf8")) as FrozenManifest;
  if (m.schema !== "diaporia.research-eval.frozen-manifest.v1") throw new Error("unknown manifest schema");
  const file = resolve(dirname(manifestPath), m.caseFile);
  const bytes = readFileSync(file);
  const got = sha(bytes);
  if (got !== m.sha256) throw new Error(`case file changed after freezing (sha256 ${got} != manifest ${m.sha256}); a correction is a new file and a new manifest`);
  const w = worldSha256();
  if (w !== m.worldSha256) throw new Error(`world.ts changed since the cases were frozen (${w} != ${m.worldSha256}); the cases no longer describe this world`);
  const cases = JSON.parse(bytes.toString("utf8")) as EvalCaseV2[];
  if (cases.length !== m.cases) throw new Error(`manifest says ${m.cases} cases, file has ${cases.length}`);
  const v = validateCases(cases);
  if (!v.ok) throw new Error(`invalid case file: ${v.errors.slice(0, 20).join("; ")}`);
  return { manifest: m, cases, file };
}

interface RunLedgerEntry { caseSha256: string; arm: string; caps: { CHANNEL3: number; TAVILY: number }; commit: string; runAt: string; firstRun: boolean; resultFile: string }
const LEDGER = join("docs", "evidence", "research-eval-v2", "FROZEN_RUNS.json");
const readLedger = (): RunLedgerEntry[] => (existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, "utf8")) : []);

async function main() {
  const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
  const manifestPath = arg("--manifest"); if (!manifestPath) throw new Error("--manifest <file> is required");
  const { manifest, cases } = loadFrozen(resolve(manifestPath));
  if (process.argv.includes("--validate")) { console.log(`valid: ${cases.length} cases, sha256 ${manifest.sha256}, world ${manifest.worldSha256}`); return; }
  const root = resolve(arg("--root") ?? ".");
  const label = arg("--label") ?? "frozen";
  const commit = execFileSync("git", ["-C", root, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  const dirty = execFileSync("git", ["-C", root, "status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim() !== "";
  const L = await loadRoot(root);
  const ledger = readLedger();
  mkdirSync(join("docs", "evidence", "research-eval-v2"), { recursive: true });
  for (const [arm, caps] of [["service-caps", SERVICE_ARM_CAPS], ["eval-caps", EVAL_CAPS]] as const) {
    const firstRun = !ledger.some((e) => e.caseSha256 === manifest.sha256 && e.arm === arm);
    const results: CaseOutcome[] = [];
    for (const c of cases) results.push(await runCase(L, c, caps, { workflow: true }));
    const summary = summarize(results);
    const runAt = new Date().toISOString();
    const resultFile = join("docs", "evidence", "research-eval-v2", `${label}-${arm}-${runAt.replace(/[:.]/g, "-")}.json`);
    writeFileSync(resultFile, JSON.stringify({ schema: "diaporia.research-eval.v2", evidenceClass: "OFFLINE_INDEPENDENTLY_AUTHORED_FROZEN_CASES_ON_AGENT_AUTHORED_WORLD",
      cleanliness: firstRun && !dirty ? "FIRST_RUN" : firstRun ? "FIRST_RUN_DIRTY_TREE" : "SEEN", manifest, root, commit, dirty, arm, caps, runAt, results, summary }, null, 2) + "\n");
    ledger.push({ caseSha256: manifest.sha256, arm, caps: { ...caps }, commit: dirty ? `${commit}+dirty` : commit, runAt, firstRun, resultFile });
    writeFileSync(LEDGER, JSON.stringify(ledger, null, 2) + "\n");
    const s = summary as any;
    console.log(`${arm.padEnd(13)} ${firstRun ? "FIRST_RUN" : "SEEN     "} state ${JSON.stringify(s.decisionStateAccuracy)} unsafe ${JSON.stringify(s.unsafeRecommendationRate)} recall@10 ${s.recallAt10} ndcg@5 ${s.ndcgAt5}`
      + ` falseHold ${JSON.stringify(s.falseHoldRate)} usd/case ${s.providerCalls.documentedUsdPerCase} workflow ${JSON.stringify(s.workflow)}`);
    console.log(`  → ${resultFile}`);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
