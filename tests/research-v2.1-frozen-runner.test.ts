/** V2.1 Phase 4: the frozen-case runner refuses changed case files, a changed world and malformed cases. */
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadFrozen, validateCases } from "../scripts/research-eval-v2/frozen.js";

const SAMPLE = new URL("./fixtures/frozen-sample/", import.meta.url).pathname;
const copy = () => { const d = mkdtempSync(join(tmpdir(), "frozen-")); for (const f of ["cases.json", "manifest.json"]) copyFileSync(join(SAMPLE, f), join(d, f)); return d; };

describe("frozen-case manifest", () => {
  it("the sample manifest loads and validates", () => {
    const { cases, manifest } = loadFrozen(join(SAMPLE, "manifest.json"));
    expect(cases).toHaveLength(manifest.cases);
  });
  it("a case file edited after freezing is refused", () => {
    const d = copy();
    writeFileSync(join(d, "cases.json"), readFileSync(join(d, "cases.json"), "utf8").replace("Black", "White"));
    expect(() => loadFrozen(join(d, "manifest.json"))).toThrow(/changed after freezing/);
  });
  it("a world that changed since freezing is refused", () => {
    const d = copy();
    const m = JSON.parse(readFileSync(join(d, "manifest.json"), "utf8"));
    writeFileSync(join(d, "manifest.json"), JSON.stringify({ ...m, worldSha256: "0".repeat(64) }));
    expect(() => loadFrozen(join(d, "manifest.json"))).toThrow(/world\.ts changed/);
  });
  it("validation names case ids only, and rejects unknown groups, states and duplicate ids", () => {
    const v = validateCases([{ id: "x", request: "Buy a secret thing", lang: "en", expect: { state: ["MAYBE"], top: ["no-such-group"] } }, { id: "x", request: "abc", lang: "fr", expect: { state: [] } }]);
    expect(v.ok).toBe(false);
    expect(v.errors.join(" ")).not.toContain("secret");
    expect(v.errors).toEqual(expect.arrayContaining(["x: expect.state", "x: unknown world group", "x: missing or duplicate id", "x: lang"]));
  });
});
