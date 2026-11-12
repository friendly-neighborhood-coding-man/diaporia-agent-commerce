/** Diagnostic ONLY: exercises existing IW-19/20 mechanism families without provider calls.
 * These are SEEN examples and are not an independent score. This script does not mutate source.
 * Run with: npx tsx scripts/loop/probe-known.ts
 */
import { parseResearchIntent } from "../../src/intent/ResearchIntentV2.js";
const probes = [
  { family: "F2 fitment vs occasion", request: "Corvan helmet for cycling too" },
  { family: "F2 measurable recipient", request: "Corvan trailer for my 45 lb son" },
  { family: "F2 background control", request: "Corvan helmet for a birthday gift" },
  { family: "F3 preposed part", request: "check valve for the Delve 1/3HP" },
  { family: "F3 postposed part", request: "Delve 1/3HP check valve" },
  { family: "F4 capacity minimum", request: "a tank that holds at least 400 liters" },
  { family: "F4 exact identity control", request: "Delve 400L tank, exact 400L model" },
] as const;
for (const probe of probes) {
  const p = parseResearchIntent({ request: probe.request } as any);
  const result = {
    family: probe.family,
    request: probe.request,
    target: p.target,
    requirements: p.requirements.filter(x=>x.strength === "MUST").map(x=>({ key:x.key, text:x.text, source:x.source })),
    unresolvedMust: p.unresolvedMust,
    budgetMinor: p.budgetMinor
  };
  console.log(JSON.stringify(result));
}
console.error("SEEN diagnostic only. No model call, merchant call, checkout, or fresh IW-21 scoring.");
