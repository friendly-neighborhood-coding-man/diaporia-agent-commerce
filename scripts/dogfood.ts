/**
 * npm run dogfood                 # scenarios A–H, K in-process + J (offline Phase C MOCK, needs local Chromium)
 * npm run dogfood -- --no-browser # skip J
 * npm run dogfood -- --only A,B   # subset
 *
 * Writes docs/evidence/dogfood/dogfood-<timestamp>.json and prints a table. Exit code 1 if any scenario FAILs.
 * No network beyond 127.0.0.1, no PayPal, no KERNEL, no model calls.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { NOT_RUN, runAll, type ScenarioResult } from "./dogfood/harness.js";

const argv = process.argv.slice(2);
const only = argv.includes("--only") ? argv[argv.indexOf("--only") + 1]!.split(",") : undefined;
const browser = !argv.includes("--no-browser");

const results = await runAll(only ? { only } : {});

if (browser && (!only || only.includes("J"))) {
  const t0 = Date.now();
  const p = spawnSync(process.execPath, ["--import", "tsx", "scripts/demo-phase-c.ts"], { encoding: "utf8", timeout: 180_000 });
  const last = (p.stdout ?? "").trim().split("\n").reverse().find((l) => l.startsWith("{")) ?? "";
  let ev: Record<string, unknown> | null = null; try { ev = JSON.parse(last); } catch { /* none */ }
  const checks = ev ? [
    { check: "DIAPORIA handoff state", expected: "ORDER_CONFIRMED", observed: ev.diaporiaState, pass: ev.diaporiaState === "ORDER_CONFIRMED" },
    { check: "merchant state (seller-signed)", expected: "ORDER_CONFIRMED", observed: ev.merchantState, pass: ev.merchantState === "ORDER_CONFIRMED" },
    { check: "fulfillment not claimed", expected: "NOT_VERIFIED", observed: ev.fulfillment, pass: ev.fulfillment === "NOT_VERIFIED" },
    { check: "DIAPORIA created no payment order", expected: false, observed: ev.diaporiaCreatedPaymentOrder, pass: ev.diaporiaCreatedPaymentOrder === false },
    { check: "captured total", expected: 10760, observed: ev.capturedTotalMinor, pass: ev.capturedTotalMinor === 10760 },
    { check: "PayPal / KERNEL network calls", expected: [0, 0], observed: [ev.paypalNetworkCalls, ev.kernelCalls], pass: ev.paypalNetworkCalls === 0 && ev.kernelCalls === 0 },
  ] : [];
  results.push({ id: "J", title: "Phase C fictional merchant checkout via browser handoff (offline loopback MOCK; public HTTPS smoke NOT run)", durationMs: Date.now() - t0,
    status: ev && checks.every((c) => c.pass) ? "PASS" : "FAIL", checks,
    notes: ["Offline loopback reproduction of the public MOCK merchant (same code). The public https://phase-c.diaporia.com smoke test is not run by this harness: it needs explicit owner authorization.",
      ...(ev ? [] : [`demo exited ${p.status}; stderr tail: ${(p.stderr ?? "").slice(-400)}`])] });
} else {
  results.push({ id: "J", title: "Phase C fictional merchant checkout (browser)", status: "NOT_RUN", checks: [], durationMs: 0, notes: ["--no-browser"] });
}
results.push(...NOT_RUN);
results.sort((a, b) => a.id.localeCompare(b.id));

let commit = "unknown"; let dirty = false;
try { commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim(); dirty = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim().length > 0; } catch { /* not a git checkout */ }
const summary = { pass: results.filter((r) => r.status === "PASS").length, fail: results.filter((r) => r.status === "FAIL").length, notRun: results.filter((r) => r.status === "NOT_RUN").length };
const evidence = { schema: "diaporia.dogfood.v1", evidenceClass: "OFFLINE_MOCK_LOOPBACK", generatedAt: new Date().toISOString(), commit, workingTreeDirty: dirty, node: process.version,
  externalCalls: { paypal: 0, kernel: 0, channel3: 0, tavily: 0, model: 0 }, summary, scenarios: results };
mkdirSync("docs/evidence/dogfood", { recursive: true });
const file = `docs/evidence/dogfood/dogfood-${evidence.generatedAt.replace(/[:.]/g, "-")}.json`;
writeFileSync(file, JSON.stringify(evidence, null, 2) + "\n");

for (const r of results as ScenarioResult[]) {
  console.log(`${r.status.padEnd(7)} ${r.id}  ${r.title} (${r.durationMs} ms, ${r.checks.filter((c) => c.pass).length}/${r.checks.length} checks)`);
  for (const c of r.checks.filter((c) => !c.pass)) console.log(`          ✗ ${c.check}: expected ${JSON.stringify(c.expected)}, observed ${JSON.stringify(c.observed)}`);
  if (r.error) console.log(`          error: ${r.error}`);
}
console.log(`\n${summary.pass} PASS, ${summary.fail} FAIL, ${summary.notRun} NOT_RUN → ${file}`);
process.exit(summary.fail ? 1 : 0);
