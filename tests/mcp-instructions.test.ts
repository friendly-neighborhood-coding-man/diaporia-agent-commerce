/** Server instructions mention only the tools the principal is offered (text only; no authorization change). */
import { describe, expect, it } from "vitest";
import { serverInstructions } from "../src/mcp/MCPCommerceAdapter.js";
import { ALL_CLIENT_SCOPES, SCOPES, type Principal } from "../src/auth/devAuth.js";

const principal = (scopes: string[]): Principal => ({ userId: "u", scopes: new Set(scopes), kind: "DEV_TOKEN", tokenFingerprint: "x" });

describe("serverInstructions", () => {
  it("full-scope token with payment tools exposed mentions prepare_checkout and get_checkout_status", () => {
    const t = serverInstructions(principal(ALL_CLIENT_SCOPES), { exposePaymentTools: true });
    expect(t).toContain("prepare_checkout");
    expect(t).toContain("get_checkout_status");
  });
  it("research+read token never mentions prepare_checkout (observed with Claude Code in the four-host run)", () => {
    const t = serverInstructions(principal([SCOPES.RESEARCH, SCOPES.READ]), { exposePaymentTools: true });
    expect(t).not.toContain("prepare_checkout");
    expect(t).toContain("cannot create checkouts");
    expect(t).toContain("research_purchase");
  });
  it("payment tools hidden (public research-only mode) never mentions prepare_checkout even with the scope", () => {
    expect(serverInstructions(principal(ALL_CLIENT_SCOPES), { exposePaymentTools: false })).not.toContain("prepare_checkout");
  });
  it("research-only token does not mention get_checkout_status", () => {
    expect(serverInstructions(principal([SCOPES.RESEARCH]), { exposePaymentTools: true })).not.toContain("get_checkout_status");
  });
});

describe("payment completion vs merchant order vs fulfillment", () => {
  it("instructions say COMPLETED is payment capture only, never a merchant purchase or shipment", () => {
    const t = serverInstructions(principal(ALL_CLIENT_SCOPES), { exposePaymentTools: true });
    expect(t).toMatch(/COMPLETED means only that the payment was captured/);
    expect(t).toMatch(/not a merchant order confirmation and not fulfillment/);
  });
});
