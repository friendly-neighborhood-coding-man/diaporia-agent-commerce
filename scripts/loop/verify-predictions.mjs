// Verifies immutable pre-repair prediction record. Read-only; no network or API keys.
import { execFileSync } from "node:child_process";
const repo = process.cwd();
const FREEZE = "639ca302793abff4cd9742cc1c371830d1ae94a6";
const FILE = "research/loop/PREDICTIONS.md";
const run = (...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8", stdio: ["ignore","pipe","pipe"] }).trim();
try {
  run("rev-parse","--verify",FREEZE+"^{commit}");
  run("merge-base","--is-ancestor",FREEZE,"HEAD");
  const diff = run("diff","--name-only",FREEZE,"HEAD","--",FILE);
  if (diff) throw new Error("Prediction register changed after its pre-repair freeze: "+diff);
  const worktree = run("status","--porcelain","--",FILE);
  if (worktree) throw new Error("Uncommitted change to prediction register: "+worktree);
  console.log("PASS: pre-repair predictions are byte-identical to commit "+FREEZE);
  console.log("Baseline engine: 4bc7dcca29c3fbeb1fea791866e561521d6f8264");
  console.log("No IW-21 data or result is verified by this tool.");
} catch(e) { console.error("FAIL:", e.stderr?.toString() || e.message); process.exit(1); }
