// Builds research/category-count/prompts/<ARM>.txt and schemas/<ARM>.json from ONE template, ONE example set
// (annotated once at the fine level) and the taxonomy table. Only the taxonomy block, the category labels of the same
// example units and (K3F) the optional sub-type line differ between arms. Writes MANIFEST.json with sha256 hashes.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ARMS, TAXONOMY, groupOf, type Arm, type Fine } from "../../src/intent/hybrid/category/CategoryTaxonomy.ts";
import { DOCUMENT_SCHEMAS, validateDocument, CATEGORY_SCHEMA_VERSION } from "../../src/intent/hybrid/category/CategoryIntent.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const tpl = readFileSync(join(HERE, "PROMPT_TEMPLATE.txt"), "utf8");
const ex: Array<{ request: string; doc: any }> = JSON.parse(readFileSync(join(HERE, "examples.k7.json"), "utf8"));
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const manifest: Record<string, unknown> = { schema: CATEGORY_SCHEMA_VERSION, template: sha(tpl), examples: sha(readFileSync(join(HERE, "examples.k7.json"), "utf8")), arms: {} };

for (const arm of ARMS) {
  const t = TAXONOMY[arm === "K3F" ? "K3" : arm];
  const tax = t.map((c, i) => `${i + 1}. ${c.name}: ${c.definition}.`).join("\n");
  const subtype = arm === "K3F" ? `\n- subtype: OPTIONAL finer type, one of "IDENTITY", "REQUIREMENT" (must have), "EXCLUSION" (must not have), "RELATION" (fit / capacity / contents), "PURCHASE", "PREFERENCE", "CONTEXT", or null when you do not want to refine.` : "";
  const exText = ex.map((e, i) => {
    const units = e.doc.units.map((u: any) => {
      const { fine, ...rest } = u; const category = groupOf(arm, fine as Fine);
      const out: Record<string, unknown> = { span: rest.span, category };
      if (arm === "K3F") out.subtype = category === "IDENTITY" ? null : fine;
      return { ...out, ...Object.fromEntries(Object.entries(rest).filter(([k]) => k !== "span")) };
    });
    const doc = { taxonomy: arm, language: e.doc.language, item_kind: e.doc.item_kind, units, unresolved: e.doc.unresolved };
    const val = validateDocument(arm, e.request, doc);
    if (!val.v.schemaValid || val.v.conflicts.length || val.v.nonVerbatim.length) throw new Error(`example ${i} invalid for ${arm}: ${JSON.stringify(val.v)}`);
    if (val.v.uncovered.length) console.error(`note: example ${i} (${arm}) uncovered tokens: ${val.v.uncovered.join(",")}`);
    return `Request: ${JSON.stringify(e.request)}\nOutput: ${JSON.stringify(doc)}`;
  }).join("\n\n");
  const prompt = tpl.replaceAll("{{ARM}}", arm).replace("{{TAXONOMY}}", tax).replace("{{SUBTYPE}}", subtype).replace("{{EXAMPLES}}", exText);
  const schema = z.toJSONSchema(DOCUMENT_SCHEMAS[arm], { target: "draft-7" });
  writeFileSync(join(HERE, "prompts", `${arm}.txt`), prompt);
  writeFileSync(join(HERE, "schemas", `${arm}.json`), JSON.stringify(schema));
  (manifest.arms as any)[arm] = { prompt: sha(prompt), promptChars: prompt.length, schema: sha(JSON.stringify(schema)), categories: t.map((c) => c.name) };
}
writeFileSync(join(HERE, "MANIFEST.json"), JSON.stringify(manifest, null, 1));
console.log(JSON.stringify(manifest, null, 1));
