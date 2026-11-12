// Typed Semantic Adapter v0.2 experiment: one preload for every interpreter arm (A0 needs none).
// Offline precomputed-parser runs: the interpreter returns Haiku 5.5 JSON generated earlier (no live model call).
//   ARM=A1  hybrid v1 (b917bff behaviour): the gateway's own v1 merge, SELECTIVE, v1 fixture
//   ARM=C1  typed adapter v0.1 (PR #19 prototype), SELECTIVE, v1 fixture
//   ARM=C2  typed adapter v0.2, SELECTIVE, v1.1 fixture (= the v1 fixture + brand_proposal)
// Env: ARM, CANDIDATE_ROOT (this checkout), HYBRID_FIXTURE, HYBRID_LOG (optional trace output).
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const ARM = process.env.ARM;
const ROOT = process.env.CANDIDATE_ROOT!;
const fx: Record<string, unknown> = JSON.parse(readFileSync(process.env.HYBRID_FIXTURE!, "utf8"));
const key = (r: string) => r.normalize("NFKC").trim();
const log: Array<{ request: string; trace: unknown }> = [];
let calls = 0, misses = 0;
const get = (request: string) => { calls++; const v = fx[key(request)]; if (v === undefined) { misses++; return null; } return v; };
if (ARM === "A1") (globalThis as any).__HYBRID = { mode: "SELECTIVE", log, interpret: get };
else if (ARM === "C1" || ARM === "C2") {
  const t1 = await import(pathToFileURL(`${ROOT}/src/intent/hybrid/typed/TypedSemanticIntent.ts`).href);
  const t2 = await import(pathToFileURL(`${ROOT}/src/intent/hybrid/typed/TypedSemanticIntentV02.ts`).href);
  const apply = ARM === "C1" ? t1.applyTypedSemanticIntent : t2.applyTypedSemanticIntentV02;
  (globalThis as any).__HYBRID = { mode: "SELECTIVE", log, interpret: () => null,
    merge(ts: any, input: any, reparse: any) { const raw = get(input.request); const r = apply(ts, raw, input, "SELECTIVE", reparse); return { intent: r.intent, trace: r.trace }; } };
} else if (ARM !== "A0") throw new Error(`ARM must be A0, A1, C1 or C2 (got ${ARM})`);
process.on("exit", () => { if (process.env.HYBRID_LOG) writeFileSync(process.env.HYBRID_LOG, JSON.stringify({ arm: ARM, calls, misses, traces: log })); });
