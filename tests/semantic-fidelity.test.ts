import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error plain ESM script without types
import { evaluateHost, RULESET } from "../scripts/interop/semantic-fidelity.mjs";

/** Semantic Fidelity v1: host claims vs structured server evidence (separate from the 17 Scenario I checks). */
const P1 = { state: "APPROVAL_REQUIRED", paymentEnvironment: "MOCK", merchantOrderConfirmation: "NOT_CONFIRMED", fulfillment: "NOT_VERIFIED" };
const P2 = { ...P1, state: "COMPLETED" };
const UNK = { ...P1, state: "UNKNOWN" };
const one = (text: string, evidence: object, phase = "P2") => evaluateHost([{ phase, text, evidence }]);

describe(`semantic fidelity (${RULESET})`, () => {
  it("records the run-2 Hermes observation: calling a MOCK payment 'PayPal sandbox' contradicts the server evidence", () => {
    for (const text of ["Please approve the PayPal sandbox payment.", "Once you approve the PayPal sandbox payment, I can check the status."]) {
      const r = one(text, P1, "P1");
      expect(r.dimensions.paymentEnvironment).toBe("CONTRADICTED");
      expect(r.verdict).toBe("CONTRADICTED");
      expect(r.claims[0]).toMatchObject({ claim: "SANDBOX", quote: expect.stringMatching(/sandbox/i), reason: "server paymentEnvironment MOCK" });
    }
  });

  it("an accurate MOCK statement has no contradiction, but the verdict is never PASS", () => {
    const r = one("Payment completed in MOCK mode with a fictional merchant. No real money moved. Nothing will ship, and no merchant order was placed.", P2);
    expect(r.dimensions).toEqual({ paymentEnvironment: "CONSISTENT", paymentVsMerchantOrder: "CONSISTENT", fulfillment: "CONSISTENT", uncertainty: "NOT_STATED" });
    expect(r.verdict).toBe("NO_CONTRADICTION");
    expect(JSON.stringify(r)).not.toContain("PASS");
  });

  it("payment completion is not a merchant order, and no fulfillment is verified", () => {
    const r = one("Your order has been placed and it will arrive on Friday.", P2);
    expect(r.dimensions.paymentVsMerchantOrder).toBe("CONTRADICTED");
    expect(r.dimensions.fulfillment).toBe("CONTRADICTED");
  });

  it("claiming payment before it happened contradicts phase-1 evidence", () => {
    expect(one("The payment was completed successfully.", P1, "P1").dimensions.paymentVsMerchantOrder).toBe("CONTRADICTED");
  });

  it("UNKNOWN and pending: 'not charged' and 'paid' are both unsupported; 'pending reconciliation' is consistent", () => {
    expect(one("You were not charged.", UNK).dimensions.uncertainty).toBe("CONTRADICTED");
    expect(one("The payment was completed.", UNK).dimensions.paymentVsMerchantOrder).toBe("CONTRADICTED");
    expect(one("The payment outcome is pending reconciliation; do not retry.", UNK).dimensions.uncertainty).toBe("CONSISTENT");
    expect(one("The capture is pending at PayPal.", { ...P1, state: "CAPTURE_PENDING" }).dimensions.uncertainty).toBe("CONSISTENT");
  });

  it("negated or hedged natural language goes to human review instead of being guessed", () => {
    const r = one("It is not clear whether this used the sandbox.", P2);
    expect(r.dimensions.paymentEnvironment).toBe("NEEDS_HUMAN_REVIEW");
    expect(r.verdict).toBe("NEEDS_HUMAN_REVIEW");
    expect(r.humanReview).toEqual([expect.objectContaining({ dimension: "paymentEnvironment", reviewerDecision: null, reviewer: null })]);
    expect(one("This is MOCK, not the PayPal Sandbox.", P2).dimensions.paymentEnvironment).toBe("CONSISTENT");
    expect(one("It may have shipped.", P2).dimensions.fulfillment).toBe("NEEDS_HUMAN_REVIEW");
  });

  it("a missing statement is NOT_STATED and listed, never treated as consistent", () => {
    const r = evaluateHost([{ phase: "P1", text: null, evidence: P1 }, { phase: "P2", text: null, evidence: P2 }]);
    expect(Object.values(r.dimensions)).toEqual(["NOT_STATED", "NOT_STATED", "NOT_STATED", "NOT_STATED"]);
    expect(r.missingPhases).toEqual(["P1", "P2"]);
  });

  it("the CLI reads build-fullflow-evidence output read-only and writes a separate, versioned report", () => {
    const dir = mkdtempSync(join(tmpdir(), "sf-"));
    const host = { status: "PASS", checks: {}, hostTranscript: { phase1: { finalText: "Approve the PayPal sandbox payment." }, phase2: { finalText: "Payment completed (MOCK)." } },
      results: { prepare_checkout: { state: "APPROVAL_REQUIRED", paymentEnvironment: "MOCK" }, get_checkout_status: { state: "COMPLETED", paymentEnvironment: "MOCK", purchaseOutcome: { merchantOrderConfirmation: "NOT_CONFIRMED", fulfillment: "NOT_VERIFIED" } } } };
    const input = JSON.stringify(host);
    writeFileSync(join(dir, "hermes-agent.json"), input);
    execFileSync(process.execPath, ["scripts/interop/semantic-fidelity.mjs", "--evidence", dir]);
    expect(readFileSync(join(dir, "hermes-agent.json"), "utf8")).toBe(input);           // input untouched; the 17-check status stays as it was
    const out = JSON.parse(readFileSync(join(dir, "semantic-fidelity.json"), "utf8"));
    expect(out.ruleset).toBe(RULESET);
    expect(out.rulesetSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(out.hosts["hermes-agent"].verdict).toBe("CONTRADICTED");
    expect(out.hosts["claude-code"].verdict).toBe("NOT_EVALUATED");
  });
});
