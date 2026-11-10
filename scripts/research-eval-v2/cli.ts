/**
 * Run the research eval v2 suite against a checkout and write the result to docs/evidence/research-eval-v2/.
 *   npx tsx scripts/research-eval-v2/cli.ts <label> [root=.]
 * V1 baseline: check out c46a0f4 into a separate worktree and pass it as root (the harness and cases come from HERE).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runSuite } from "./run.js";

const label = process.argv[2]; if (!label) throw new Error("usage: cli.ts <label> [root]");
const root = resolve(process.argv[3] ?? ".");
const commit = execFileSync("git", ["-C", root, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
const out = await runSuite(root);
const dir = join("docs", "evidence", "research-eval-v2"); mkdirSync(dir, { recursive: true });
const file = join(dir, `${label}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(file, JSON.stringify({ schema: "diaporia.research-eval.v2", evidenceClass: "OFFLINE_AGENT_AUTHORED_FIXTURE_EVAL", label, root, commit,
  generatedAt: new Date().toISOString(), holdoutSha256: out.holdoutSha256, holdout2Sha256: out.holdout2Sha256, results: out.results, summary: out.summary }, null, 2) + "\n");
const s = (x: any) => `state ${x.decisionStateAccuracy ?? JSON.stringify(x.stateAccuracy)} recall ${x.recallAt10?.toFixed?.(3)} ndcg ${x.ndcgAt5?.toFixed?.(3)} unsafe ${JSON.stringify(x.unsafeRecommendationRate)}`;
for (const k of ["all", "dev", "holdout", "holdout2"] as const) console.log(k.padEnd(9), s((out.summary as any)[k]));
console.log("misses:", out.results.filter((r) => !r.stateOk || r.unsafeForbidden || r.unsafeShouldNotRecommend).map((r) => `${r.id}:${r.state}`).join(" "));
console.log(file);
