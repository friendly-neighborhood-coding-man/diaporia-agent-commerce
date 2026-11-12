// Offline precomputed-parser experiment: the interpreter returns Haiku 5.5 JSON generated earlier by Claude Code subagents.
import { readFileSync, writeFileSync } from "node:fs";
const mode = process.env.HYBRID_MODE as "ALWAYS" | "SELECTIVE" | undefined;
if (mode) {
  const fx: Record<string, unknown> = JSON.parse(readFileSync(process.env.HYBRID_FIXTURE!, "utf8"));
  const key = (r: string) => r.normalize("NFKC").trim();
  const log: Array<{ request: string; trace: unknown }> = [];
  let calls = 0, misses = 0;
  (globalThis as any).__HYBRID = { mode, log, interpret(request: string) { calls++; const v = fx[key(request)]; if (v === undefined) { misses++; return null; } return v; } };
  process.on("exit", () => writeFileSync(process.env.HYBRID_LOG!, JSON.stringify({ mode, calls, misses, traces: log })));
}
