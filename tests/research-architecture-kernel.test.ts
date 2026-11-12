/**
 * Architecture experiment: the obligation kernel (src/verification/ObligationKernel.ts). End-to-end probes run in
 * research/architecture/cx/; these unit tests pin the kernel's contract with builder-written fictional products
 * (Corvane, Ostlund, Quillby) that occur in no IW set.
 */
import { describe, expect, it } from "vitest";
import { parseResearchIntent } from "../src/intent/ResearchIntentV2.js";
import { extractIdentity } from "../src/identity/ProductIdentityExtractor.js";
import { applyObligationKernel } from "../src/verification/ObligationKernel.js";

const product = (id: string, title: string, brand: string, kind: "STANDALONE" | "ACCESSORY" | "BUNDLE" = "STANDALONE", category = "smokers"): any =>
  ({ productId: id, title, category, identity: { ...extractIdentity(title, brand), brand, variant: null, condition: "new", sku: null }, description: null, capabilities: [], offers: [], research: { kind, modelBasis: "NAMED_MODEL", attributes: {}, conflictingAxes: [], categoryTitle: null } });
const ranked = (p: any, extra: any = {}) => ({ productId: p.productId, title: p.title, rank: 1, eligible: true, disqualifiers: [], blockers: [], utility: 1, satisfied: [], price: {}, ...extra });
const decision = (rec: any, ranking: any[]): any => ({ engine: "t", weights: "t", state: "RECOMMEND", recommendation: { productId: rec.productId, title: rec.title }, topCandidate: null, holdReasons: [], ranking, disclaimer: "" });
const router = (hits: Array<{ url: string; title: string; snippet: string }>): any => ({
  requestHits: () => hits.map((h) => ({ ...h, publishedDate: null, score: null })),
  lookupProductPages: async () => null,
  registry: { classify: (url: string) => (url.includes("ostlund.example") || url.includes("quillby.example") ? "MANUFACTURER" : "UNKNOWN") },
});
const run = async (request: string, rec: any, products: any[], hits: any[], opts: any = {}) => {
  const d = decision(rec, opts.ranking ?? [ranked(rec)]);
  const log = await applyObligationKernel({ intent: parseResearchIntent({ request } as any) as any, requestText: request, products, offers: new Map(), decision: d, verdicts: opts.verdicts ?? new Map(), excluded: opts.excluded ?? [] }, { router: router(hits), ctx: { userId: "u", requestId: "r" } });
  return { d, log, failed: log.checks.filter((c) => !c.pass).map((c) => c.id) };
};

const e18 = product("e18", "Ostlund Embry 18 Offset Box Smoker", "Ostlund");
const e18p = product("e18p", "Ostlund Embry 18 Pro Smoker", "Ostlund");
const page18 = { url: "https://ostlund.example/embry-18", title: "Ostlund Embry 18 Offset Box Smoker specifications", snippet: "The Embry 18 has an 18 inch firebox. Wi-Fi: not available. 와이파이: 없음." };
const page18p = { url: "https://ostlund.example/embry-18-pro", title: "Ostlund Embry 18 Pro Smoker specifications", snippet: "The Embry 18 Pro is not recommended for beach use." };

describe("obligation kernel: demote-only checks", () => {
  it("a plain named request with nothing stated passes every check", async () => {
    const r = await run("Ostlund Embry 18", e18, [e18, e18p], [page18, page18p]);
    expect(r.failed).toEqual([]); expect(r.d.state).toBe("RECOMMEND");
  });
  it("K3: a Korean spec line with a negative value contradicts a stated phrase (and demotes; the gate is blocked)", async () => {
    const r = await run("와이파이 되는 Ostlund Embry 18", e18, [e18, e18p], [page18, page18p]);
    expect(r.failed).toContain("K3"); expect(r.d.state).toBe("INVESTIGATE"); expect(r.d.recommendation).toBeNull();
    expect(r.d.ranking[0].blockers.some((b: any) => b.code === "MUST_HAVE_CONTRADICTED")).toBe(true);
  });
  it("K3 binds pages by title: a sibling's negation never contradicts this product", async () => {
    const r = await run("Ostlund Embry 18 for beach use", e18, [e18, e18p], [page18, page18p]);
    expect(r.failed).not.toContain("K3");
  });
  it("K1a/K1b: a part request is never answered with the host", async () => {
    const r = await run("rain hood for the Ostlund Embry 18", e18, [e18, e18p, product("hood", "Ostlund Embry 18 Rain Hood", "Ostlund", "ACCESSORY")], [page18]);
    expect(r.failed.some((x) => x === "K1a" || x === "K1b")).toBe(true); expect(r.d.state).toBe("INVESTIGATE");
  });
  it("K1c: the lock is never less minimal than a same-type sibling the resolver excluded", async () => {
    const q32 = product("q32", "Quillby Tamsin 32 Rigid Heddle Loom", "Quillby", "STANDALONE", "looms"), q32f = product("q32f", "Quillby Tamsin 32 Floor Loom", "Quillby", "STANDALONE", "looms");
    const r = await run("Quillby Tamsin 32", q32f, [q32, q32f], [], { excluded: [{ productId: "q32", reason: "a different variant (the title adds \"Rigid Heddle\", which the request does not name)" }] });
    expect(r.failed).toContain("K1c");
  });
  it("K4: a number nothing interpreted blocks unless the title carries it; joined units match", async () => {
    const ok = await run("Ostlund Embry 18 Offset", e18, [e18], [page18]);
    expect(ok.failed).not.toContain("K4");
  });
  it("can be switched off for ablation", async () => {
    process.env.DIAPORIA_OBLIGATION_KERNEL = "off";
    try { const r = await run("와이파이 되는 Ostlund Embry 18", e18, [e18, e18p], [page18]); expect(r.log.applied).toBe(false); expect(r.d.state).toBe("RECOMMEND"); }
    finally { delete process.env.DIAPORIA_OBLIGATION_KERNEL; }
  });
});
