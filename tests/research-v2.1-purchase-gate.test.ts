/**
 * V2.1 Phase 1: the research decision binds the whole workflow research_purchase → compare_purchase_offers →
 * prepare_checkout, end to end on the fake research world (no network, fake fetch only).
 *
 * Root cause reproduced here (DECISION_JOURNAL J-13): before V2.1 a decision of HOLD or INVESTIGATE was advisory. The
 * session could stay RESEARCHED, compare reached OFFER_VERIFIED on any verified quote, and prepare_checkout trusted
 * that state. A budget written in another currency became "no budget", so the verifier applied no budget at all.
 */
import { afterEach, describe, expect, it } from "vitest";
import { buildWorldApp, loadRoot } from "../scripts/research-eval-v2/run.js";
import { gateReadiness, resolveGate, requirementKey, type PurchaseGate } from "../src/engine/PurchaseGate.js";

const L = await loadRoot(new URL("..", import.meta.url).pathname);
const CA = { country: "US", region: "CA" };
let w: ReturnType<typeof buildWorldApp> | null = null;
afterEach(() => { w?.close(); w = null; });

async function research(request: string, extra: Record<string, unknown> = {}) {
  w = buildWorldApp(L);
  const out: any = await w.app.gateway.researchPurchase("alice", { request, ...extra });
  return { gw: w.app.gateway, out };
}
const cand = (out: any, id: string) => out.candidates.find((c: any) => c.productId === id);
const compare = (gw: any, out: any, identity: unknown) => gw.compareOffers("alice", { researchSessionId: out.purchaseSessionId, productIdentity: identity, destination: CA });
const prepare = (gw: any, out: any, offerId: string, max = 10_000_000) =>
  gw.prepareCheckout("alice", { purchaseSessionId: out.purchaseSessionId, offerId, maximumApprovedTotalMinor: max, currency: "USD", quantity: 1 });
const events = (gw: any, out: any) => gw.audit.timeline([out.purchaseSessionId], "alice").map((e: any) => ({ type: e.type, data: e.data }));

describe("currency-conflicting budget never silently disappears", () => {
  const REQ = "노이즈 캔슬링 헤드폰 30만원 이하";

  it("decision HOLD puts the session in HOLD (was RESEARCHED) and the gate records the conflict", async () => {
    const { out } = await research(REQ, { currency: "USD" });
    expect(out.decision.state).toBe("HOLD");
    expect(out.state).toBe("HOLD");
    const ps = w!.app.gateway.sessions.getPurchaseSession(out.purchaseSessionId, "alice");
    expect((ps.research as any).purchaseGate.budgetConflict).toMatch(/KRW/);
  });

  it("compare still returns offers (read-only) but stays HOLD with the budget open; prepare is refused", async () => {
    const { gw, out } = await research(REQ, { currency: "USD" });
    const cmp: any = await compare(gw, out, cand(out, "ch3:h_cx500_b").identity);
    expect(cmp.paymentEffect).toBe("NONE");
    expect(cmp.eligibleOffers.length + cmp.ineligibleOffers.length).toBeGreaterThan(0);
    expect(cmp.state).toBe("HOLD");
    expect(cmp.purchaseReadiness.ready).toBe(false);
    expect(cmp.purchaseReadiness.open.join(" ")).toMatch(/Budget unresolved/);
    const offerId = cmp.lowestVerifiedEligibleOffer?.offerId ?? cmp.eligibleOffers[0]?.offerId ?? "x";
    await expect(prepare(gw, out, offerId)).rejects.toMatchObject({ code: "INVALID_STATE" });
  });

  it("the user's confirmed budget is audited, then enforced by the verifier on the next compare", async () => {
    const { gw, out } = await research(REQ, { currency: "USD" });
    const id = cand(out, "ch3:h_cx500_b").identity;
    const before: any = await compare(gw, out, id);
    const price = (before.lowestVerifiedEligibleOffer ?? before.eligibleOffers[0]).cost.totalMinor as number;
    expect(price).toBeGreaterThan(0);
    // Wrong currency, no amount, or nothing to resolve: refused.
    expect(() => gw.resolveResearchHold("alice", { purchaseSessionId: out.purchaseSessionId, kind: "CONFIRM_BUDGET", budgetMinor: 300_000, currency: "KRW", userStatement: "30만원" })).toThrow(/currency/);
    expect(() => gw.resolveResearchHold("alice", { purchaseSessionId: out.purchaseSessionId, kind: "CONFIRM_BUDGET", currency: "USD", userStatement: "about $200" })).toThrow(/budgetMinor/);
    expect(() => gw.resolveResearchHold("alice", { purchaseSessionId: out.purchaseSessionId, kind: "CONFIRM_BUDGET", budgetMinor: 20_000, currency: "USD", userStatement: "" })).toThrow(/userStatement/);
    // A budget below the verified total: the session is no longer blocked by the conflict, but no offer fits.
    const r: any = gw.resolveResearchHold("alice", { purchaseSessionId: out.purchaseSessionId, kind: "CONFIRM_BUDGET", budgetMinor: price - 1, currency: "USD", userStatement: "Keep it under that, in dollars." });
    expect(r.state).toBe("HOLD");
    expect(r.readiness.budgetSource).toBe("USER_CONFIRMED");
    const tight: any = await compare(gw, out, id);
    expect(tight.purchaseReadiness.open.join(" ")).not.toMatch(/Budget unresolved/);
    expect(tight.purchaseReadiness.budgetMinor).toBe(price - 1);
    expect(tight.lowestVerifiedEligibleOffer).toBeNull();
    expect(tight.state).toBe("HOLD");
    // A later confirmation supersedes; the earlier one stays in the gate and the audit log.
    gw.resolveResearchHold("alice", { purchaseSessionId: out.purchaseSessionId, kind: "CONFIRM_BUDGET", budgetMinor: price + 10_000, currency: "USD", userStatement: "OK, up to that much." });
    const ok: any = await compare(gw, out, id);
    expect(ok.state).toBe("OFFER_VERIFIED");
    const ps = gw.sessions.getPurchaseSession(out.purchaseSessionId, "alice");
    const gate = (ps.research as any).purchaseGate as PurchaseGate;
    expect(gate.budgetConflict).toMatch(/KRW/);
    expect(gate.resolutions.map((x) => x.budgetMinor)).toEqual([price - 1, price + 10_000]);
    const ev = events(gw, out).filter((e: any) => e.type === "RESEARCH_HOLD_RESOLVED");
    expect(ev).toHaveLength(2);
    expect(ev[0].data).toMatchObject({ kind: "CONFIRM_BUDGET", currency: "USD", userStatement: "Keep it under that, in dollars." });
    // The prepare path re-verifies the quote against the confirmed budget, not the (absent) session budget.
    const prep: any = await prepare(gw, out, ok.lowestVerifiedEligibleOffer.offerId);
    expect(prep.state).not.toBe("APPROVED");
  });
});

describe("an unverified must-have stays unresolved through the whole workflow", () => {
  const REQ = "Over-ear headphones under $60";

  it("decision INVESTIGATE: compare reaches a verified quote but holds; prepare cannot run", async () => {
    const { gw, out } = await research(REQ);
    expect(out.decision.state).toBe("INVESTIGATE");
    const cmp: any = await compare(gw, out, cand(out, "ch3:h_fab_lite").identity);
    expect(cmp.lowestVerifiedEligibleOffer).not.toBeNull();
    expect(cmp.state).toBe("HOLD");
    expect(cmp.purchaseReadiness.open.join(" ")).toContain("must:over_ear");
    await expect(prepare(gw, out, cmp.lowestVerifiedEligibleOffer.offerId)).rejects.toMatchObject({ code: "INVALID_STATE" });
  });

  it("only the user's explicit DROP_REQUIREMENT clears it; it is audited and the original item is kept", async () => {
    const { gw, out } = await research(REQ);
    const id = cand(out, "ch3:h_fab_lite").identity;
    await compare(gw, out, id);
    expect(() => gw.resolveResearchHold("alice", { purchaseSessionId: out.purchaseSessionId, kind: "DROP_REQUIREMENT", requirement: "must:wireless", currency: "USD", userStatement: "drop it" })).toThrow(/No open requirement/);
    gw.resolveResearchHold("alice", { purchaseSessionId: out.purchaseSessionId, kind: "DROP_REQUIREMENT", requirement: "must:over_ear", currency: "USD", userStatement: "On-ear is fine too." });
    // The resolution clears the old comparison: prepare needs a fresh compare.
    await expect(prepare(gw, out, "ch3:h_fab_lite:0")).rejects.toMatchObject({ code: "INVALID_STATE" });
    const cmp: any = await compare(gw, out, id);
    expect(cmp.state).toBe("OFFER_VERIFIED");
    expect(cmp.purchaseReadiness).toMatchObject({ ready: true, open: [] });
    const prep: any = await prepare(gw, out, cmp.lowestVerifiedEligibleOffer.offerId);
    expect(prep.paymentEffect ?? "NONE").not.toBe("CAPTURED");
    const gate = (gw.sessions.getPurchaseSession(out.purchaseSessionId, "alice").research as any).purchaseGate as PurchaseGate;
    expect(gate.products["ch3:h_fab_lite"]!.requirements.map((q) => q.key)).toContain("must:over_ear");
    expect(gate.resolutions).toMatchObject([{ kind: "DROP_REQUIREMENT", requirement: "must:over_ear", note: "On-ear is fine too." }]);
  });

  it("quoting never resolves a requirement: re-comparing many times stays HOLD", async () => {
    const { gw, out } = await research(REQ);
    const id = cand(out, "ch3:h_fab_lite").identity;
    for (let i = 0; i < 3; i++) expect((await compare(gw, out, id) as any).state).toBe("HOLD");
  });
});

describe("a hard-constraint violation never becomes purchase-eligible", () => {
  it("an accessory (CATEGORY_MISMATCH / NOT_STANDALONE) holds, and dropping its requirements does not unlock it", async () => {
    const { gw, out } = await research("Over-ear headphones under $60");
    const pads = out.decision.ranking.find((r: any) => r.productId === "ch3:h_cx500_pads");
    expect(pads.disqualifiers.map((d: any) => d.code)).toEqual(expect.arrayContaining(["CATEGORY_MISMATCH"]));
    const c = cand(out, "ch3:h_cx500_pads");
    expect(c).toBeDefined();
    const cmp: any = await compare(gw, out, c.identity);
    expect(cmp.state).toBe("HOLD");
    expect(cmp.purchaseReadiness.open.join(" ")).toMatch(/Known violation/);
    gw.resolveResearchHold("alice", { purchaseSessionId: out.purchaseSessionId, kind: "DROP_REQUIREMENT", requirement: "must:over_ear", currency: "USD", userStatement: "Whatever, buy it." });
    const again: any = await compare(gw, out, c.identity);
    expect(again.state).toBe("HOLD");
    expect(again.purchaseReadiness.open.join(" ")).toMatch(/Known violation/);
  });

  it("a must-have verified false (MUST_HAVE_FALSE) holds with a known violation", async () => {
    const { gw, out } = await research("Noise cancelling headphones under $100");
    const c = cand(out, "ch3:h_fab_lite");
    expect(c).toBeDefined();
    const cmp: any = await compare(gw, out, c.identity);
    expect(cmp.state).toBe("HOLD");
    expect(cmp.purchaseReadiness.open.join(" ")).toMatch(/Known violation/);
  });
});

describe("prepare_checkout re-checks the gate (defense in depth)", () => {
  async function verifiedSession() {
    const { gw, out } = await research("Over-ear headphones under $60");
    const id = cand(out, "ch3:h_fab_lite").identity;
    await compare(gw, out, id);
    gw.resolveResearchHold("alice", { purchaseSessionId: out.purchaseSessionId, kind: "DROP_REQUIREMENT", requirement: "must:over_ear", currency: "USD", userStatement: "On-ear is fine." });
    const cmp: any = await compare(gw, out, id);
    expect(cmp.state).toBe("OFFER_VERIFIED");
    return { gw, out, offerId: cmp.lowestVerifiedEligibleOffer.offerId as string };
  }
  const tamper = (gw: any, out: any, f: (g: PurchaseGate) => PurchaseGate | null) => {
    const ps = gw.sessions.getPurchaseSession(out.purchaseSessionId, "alice");
    // Same state; only the stored gate changes (simulates a write path that forgot the gate).
    gw.sessions.updatePurchaseSession(ps, "OFFER_VERIFIED", { research: { ...ps.research, purchaseGate: f(ps.research.purchaseGate) } });
  };

  it.each([
    ["gate missing", () => null],
    ["unknown gate version", (g: PurchaseGate) => ({ ...g, version: "purchase-gate-v0" as any })],
    ["product never assessed", (g: PurchaseGate) => ({ ...g, products: {} })],
    ["resolution removed", (g: PurchaseGate) => ({ ...g, resolutions: [] })],
  ])("OFFER_VERIFIED session with %s → RESEARCH_REQUIREMENTS_UNRESOLVED, audited, no checkout", async (_n, f) => {
    const { gw, out, offerId } = await verifiedSession();
    tamper(gw, out, f as any);
    await expect(prepare(gw, out, offerId)).rejects.toMatchObject({ code: "RESEARCH_REQUIREMENTS_UNRESOLVED" });
    const ev = events(gw, out);
    expect(ev.some((e: any) => e.type === "PURCHASE_GATE_BLOCKED" && e.data.path === "prepare_checkout")).toBe(true);
    expect(ev.some((e: any) => e.type === "CHECKOUT_PREPARED")).toBe(false);
  });
});

describe("PurchaseGate unit rules", () => {
  const gate: PurchaseGate = { version: "purchase-gate-v1", decisionState: "INVESTIGATE", budgetConflict: null, resolutions: [],
    products: { p: { hard: [], requirements: [{ key: "must:anc", code: "MUST_HAVE_UNVERIFIED", detail: 'must-have "anc" is not verified' }] },
      q: { hard: [{ key: "accessory", code: "ACCESSORY", detail: "accessory" }], requirements: [] } } };
  it("requirement keys are stable", () => {
    expect(requirementKey("MUST_HAVE_UNVERIFIED", 'must-have "multipoint" is not verified')).toBe("must:multipoint");
    expect(requirementKey("ATTRIBUTE_UNKNOWN", "color not confirmed by the listing")).toBe("attribute:color");
  });
  it("fails closed; V1 sessions keep V1 rules", () => {
    expect(gateReadiness(null, "p", 100, false).ready).toBe(false);
    expect(gateReadiness(gate, null, 100, false).ready).toBe(false);
    expect(gateReadiness(gate, "q", 100, false).ready).toBe(false);
    expect(gateReadiness(null, null, 100, true)).toMatchObject({ ready: true, effectiveBudgetMinor: 100, budgetSource: "SESSION" });
  });
  it("a resolution is appended, never replaces, and CONFIRM_BUDGET needs a conflict", () => {
    const r = resolveGate(gate, { kind: "DROP_REQUIREMENT", requirement: "must:anc", budgetMinor: null, currency: "USD", actor: "t", note: "fine" }, 0, "USD");
    expect(gate.resolutions).toHaveLength(0);
    expect(r.resolutions).toHaveLength(1);
    expect(r.products.p!.requirements).toHaveLength(1);
    expect(gateReadiness(r, "p", null, false).ready).toBe(true);
    expect(() => resolveGate(gate, { kind: "CONFIRM_BUDGET", requirement: null, budgetMinor: 5, currency: "USD", actor: "t", note: "x" }, 0, "USD")).toThrow(/no budget conflict/);
  });
});
