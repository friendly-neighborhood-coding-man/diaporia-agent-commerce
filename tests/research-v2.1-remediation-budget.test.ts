/**
 * V21-01 (independent review of V2.1): an unrecognised budget expression must never silently become "no budget".
 * New builder-written phrases only; no IW-1.1 case is copied.
 */
import { afterEach, describe, expect, it } from "vitest";
import { parseResearchIntent } from "../src/intent/ResearchIntentV2.js";
import { buildWorldApp, loadRoot } from "../scripts/research-eval-v2/run.js";

const parse = (request: string, extra: Record<string, unknown> = {}) => parseResearchIntent({ request, ...extra } as any);
const L = await loadRoot(new URL("..", import.meta.url).pathname);

describe("V21-01 ambiguous limits are unresolved, never dropped", () => {
  it.each(["laptop stand, max 80", "monitor arm, maximum 120", "under 90 please, wireless mouse", "desk lamp budget 60", "a webcam, no more than 70",
    "earbuds 150 이하", "블루투스 스피커 예산 200", "키보드 최대 120", "마우스 50 미만", "충전기 40까지", "조명 30 이내"])("%s → no budget applied, budgetUnresolved set", (r) => {
    const i = parse(r);
    expect(i.budgetMinor).toBeNull();
    expect(i.budgetUnresolved).toBeTruthy();
  });
  it.each([["under $90 mouse", 9000, "USD"], ["마우스 90달러 이하", 9000, "USD"], ["헤드폰 20만원 이하", 200_000, "KRW"], ["lamp under 60 EUR", 6000, "EUR"], ["under 90 mouse", 9000, "USD"]])(
    "controls: %s keeps its budget", (r, minor, cur) => {
      const i = parse(r as string, r === "under 90 mouse" ? { currency: "USD" } : {});
      expect(i.budgetMinor).toBe(minor); expect(i.currency).toBe(cur); expect(i.budgetUnresolved).toBeNull();
    });
  it.each(["headphones with battery up to 30 hours", "router for max 2 devices", "Buy AirPods Max 2", "speaker delivered within 2 days", "Buy Contoso CX-500 Black", "30시간 이상 배터리 헤드폰",
    "Buy the Kestrel Pad 11", "3 pack of AA batteries"])("quantities and model numbers are not budgets: %s", (r) => {
    const i = parse(r);
    expect(i.budgetMinor).toBeNull(); expect(i.budgetUnresolved).toBeNull();
  });
  it("a structured budget wins and leaves nothing unresolved", () => {
    expect(parse("laptop stand, max 80", { budgetMinor: 8000, currency: "USD" })).toMatchObject({ budgetMinor: 8000, budgetUnresolved: null });
  });
});

describe("V21-01 end to end: an unresolved budget blocks payment preparation", () => {
  let w: ReturnType<typeof buildWorldApp> | null = null;
  afterEach(() => { w?.close(); w = null; });
  it("an exact request with 'max 100' holds; compare is read-only HOLD; prepare is refused", async () => {
    w = buildWorldApp(L);
    const gw: any = w.app.gateway;
    const out: any = await gw.researchPurchase("alice", { request: "Buy Contoso CX-500 Black, max 100" });
    expect(out.decision.state).toBe("HOLD");
    expect(out.state).toBe("HOLD");
    const cmp: any = await gw.compareOffers("alice", { researchSessionId: out.purchaseSessionId, productIdentity: out.identity.lockedIdentity, destination: { country: "US", region: "CA" } });
    expect(cmp.state).toBe("HOLD");
    expect(cmp.purchaseReadiness.open.join(" ")).toMatch(/Budget unresolved/);
    const offerId = (cmp.lowestVerifiedEligibleOffer ?? cmp.eligibleOffers[0] ?? cmp.ineligibleOffers[0]).offerId;
    await expect(gw.prepareCheckout("alice", { purchaseSessionId: out.purchaseSessionId, offerId, maximumApprovedTotalMinor: 100_000_000, currency: "USD", quantity: 1 })).rejects.toMatchObject({ code: "INVALID_STATE" });
  });
});
