// Verifies every example of ts-contract.v0.1.0.json against the real parser and the real evidence matcher. Invented names only.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const { parseResearchIntent } = await import(join(HERE, "../../src/intent/ResearchIntentV2.ts"));
const { clauseStatement, evidenceCapabilityOf } = await import(join(HERE, "../../src/research/capabilities.ts"));
const C = JSON.parse(readFileSync(join(HERE, "ts-contract.v0.1.0.json"), "utf8"));
let bad = 0;
for (const f of C.forms) {
  const out: string[] = [];
  if (f.textForm) {
    const iv = parseResearchIntent({ request: f.textForm });
    const keys = iv.requirements.map((r: any) => r.key);
    if (f.expectKey) { const ok = keys.includes(f.expectKey); out.push(`parse ${ok ? "OK" : "FAIL"} ${JSON.stringify(f.textForm)} -> ${keys.join(" ") || "-"}`); if (!ok) bad++; }
    if (f.expectTarget) { const t = iv.target ? `${iv.target.brand}/${iv.target.model}/${iv.target.kind}` : "-"; const ok = t === f.expectTarget; out.push(`identity ${ok ? "OK" : "FAIL"} ${t}`); if (!ok) bad++; }
    if (f.expectBudget) { const ok = iv.budgetLowerMinor === f.expectBudget[0] && iv.budgetMaxMinor === f.expectBudget[1]; out.push(`budget ${ok ? "OK" : "FAIL"} ${iv.budgetLowerMinor}..${iv.budgetMaxMinor}`); if (!ok) bad++; }
  }
  const key = f.expectKey ?? f.constructedKey;
  for (const p of f.probes ?? (f.probe ? [f.probe] : [])) { if (!key) break; const v = clauseStatement(p.sentence, evidenceCapabilityOf(key)); const ok = v === p.verdict; out.push(`evidence ${ok ? "OK" : "FAIL"} ${evidenceCapabilityOf(key)} on ${JSON.stringify(p.sentence)} -> ${v}`); if (!ok) bad++; }
  console.log(f.id.padEnd(22), out.join(" | "));
}
console.log(bad ? `${bad} FAILED` : "contract verified");
process.exit(bad ? 1 : 0);
