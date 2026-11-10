import { describe, expect, it } from "vitest";
import { runResearchEval } from "../scripts/research-eval/run.js";
import { PurchaseIntentRouter } from "../src/intent/PurchaseIntentRouter.js";

describe("research evaluation suite (fictional eval world, offline)", () => {
  it("has no safety-critical errors and every case meets its expectation", async () => {
    const r = await runResearchEval();
    expect(r.metrics.criticalErrors).toBe(0);
    expect(r.cases.filter((c) => !c.pass).map((c) => ({ id: c.id, error: c.error, failed: c.checks.filter((x) => !x.pass) }))).toEqual([]);
    expect(r.metrics.cases).toBeGreaterThanOrEqual(18);
    expect(r.metrics.externalProviderCalls).toBe(0);
  });

  it("a stated color the catalog does not have is kept, so the resolver reports NOT_FOUND instead of offering other colors", () => {
    expect(new PurchaseIntentRouter().route({ request: "Buy Contoso CX-500 Purple" }).identityHints.variant).toBe("Purple");
  });
});
