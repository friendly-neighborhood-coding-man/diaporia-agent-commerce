/**
 * V2.2 WP-1 (H-1): every stated amount is an explicit money constraint or an explicit ambiguity; never silently
 * dropped, never converted. Builder-written phrases and the fixture catalog only (nothing from IW-1.1, IW-2 or IW-3).
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { parseResearchIntent } from "../src/intent/ResearchIntentV2.js";
import { parseMoneyConstraints, amountToMinor } from "../src/intent/MoneyConstraints.js";
import { CA, SONY_BLACK, TOKENS, call, callError, mcpClient, startHarness, type Harness } from "./helpers.js";
import { closeSharedBrowser, startHandoffHarness } from "./handoff-helpers.js";

const parse = (request: string, extra: Record<string, unknown> = {}) => parseResearchIntent({ request, ...extra } as any);

describe("WP-1 money constraints: the required forms", () => {
  it.each([
    ["robot vacuum under US$120", "USD", 12_000, false, null],
    ["robot vacuum under US $120", "USD", 12_000, false, null],
    ["robot vacuum under USD 120", "USD", 12_000, false, null],
    ["robot vacuum, 120 USD max", "USD", 12_000, true, null],
    ["robot vacuum between $100 and $150", "USD", 15_000, true, 10_000],
    ["robot vacuum $100-$150", "USD", 15_000, true, 10_000],
    ["robot vacuum $100 – 150", "USD", 15_000, true, 10_000],
    ["robot vacuum 100-150 dollars", "USD", 15_000, true, 10_000],
    ["robot vacuum from $100 to $150", "USD", 15_000, true, 10_000],
    ["robot vacuum under 200,000 won", "KRW", 200_000, false, null],
    ["robot vacuum under 200k won", "KRW", 200_000, false, null],
    ["robot vacuum up to KRW 200,000", "KRW", 200_000, true, null],
    ["로봇청소기 20만원 이하", "KRW", 200_000, true, null],
    ["로봇청소기 20만원 미만", "KRW", 200_000, false, null],
    ["로봇청소기 10~20만원 사이", "KRW", 200_000, true, 100_000],
    ["로봇청소기 10만원에서 20만원 사이", "KRW", 200_000, true, 100_000],
    ["로봇청소기 20만원대", "KRW", 300_000, false, 200_000],
    ["robot vacuum at least $100 and under $150", "USD", 15_000, false, 10_000],
    ["robot vacuum under €90", "EUR", 9_000, false, null],
    ["laptop under $1.5k", "USD", 150_000, false, null],
  ] as const)("%s → %s upper %i (inclusive %s), lower %s", (r, cur, upper, inc, lower) => {
    const i = parse(r);
    expect(i).toMatchObject({ currency: cur, budgetMinor: upper, budgetUpperInclusive: inc, budgetLowerMinor: lower, budgetConflict: null, budgetUnresolved: null });
    expect(i.budgetMaxMinor).toBe(inc ? upper : upper - 1);
    const c = i.moneyConstraints[0]!;
    expect(r.normalize("NFKC").slice(c.span![0], c.span![1])).toContain(c.text.replace(/^(?:under|between|from|up to|at least)\s+/i, "").split(" ")[0]!.replace(/대$/, ""));
    expect(c.provenance).toBe("REQUEST_TEXT");
  });

  it("an exclusive bound is enforced as one minor unit below; an inclusive bound as stated", () => {
    expect(parse("speaker under $80").budgetMaxMinor).toBe(7_999);
    expect(parse("speaker, no more than $80").budgetMaxMinor).toBe(8_000);
    expect(parse("스피커 8만원 미만").budgetMaxMinor).toBe(79_999);
  });
});

describe("WP-1 never converted, never dropped: conflicts and ambiguities hold", () => {
  it.each([
    ["robot vacuum under 200,000 won", { currency: "USD" }, "budgetConflict"],
    ["로봇청소기 20만원 이하", { currency: "USD" }, "budgetConflict"],
    ["robot vacuum under $120 or 150,000원", {}, "budgetConflict"],
    ["robot vacuum under €100 or $110", {}, "budgetConflict"],
    ["robot vacuum over $300 but under $100", {}, "budgetConflict"],
    ["robot vacuum under C$150", {}, "budgetUnresolved"],
    ["robot vacuum under A$150", {}, "budgetUnresolved"],
    ["robot vacuum under ¥15000", {}, "budgetUnresolved"],
    ["robot vacuum around $150", {}, "budgetUnresolved"],
    ["robot vacuum, about 150 dollars", {}, "budgetUnresolved"],
    ["로봇청소기 20만원 정도", {}, "budgetUnresolved"],
    ["robot vacuum under 50 pounds", {}, "budgetUnresolved"],
    ["robot vacuum with a $10/month filter plan", {}, "budgetUnresolved"],
    ["robot vacuum between $100", {}, "budgetUnresolved"],
    ["robot vacuum, max 150", {}, "budgetUnresolved"],
  ] as const)("%s %j → %s, decision HOLD", (r, extra, field) => {
    const i = parse(r, extra);
    expect(i[field]).toBeTruthy();
    expect(i.moneyAmbiguities.length).toBeGreaterThan(0);
  });

  it("a GBP amount written with £ or GBP is a budget; bare 'pounds' is never guessed", () => {
    expect(parse("kettle under £50")).toMatchObject({ currency: "GBP", budgetMinor: 5_000 });
    expect(parse("kettle under 50 GBP")).toMatchObject({ currency: "GBP", budgetMinor: 5_000 });
    expect(parse("stroller under 20 pounds").moneyAmbiguities[0]).toMatchObject({ kind: "WEIGHT_OR_CURRENCY" });
  });

  it("a coupon or discount amount is recorded, never applied as the budget", () => {
    const i = parse("robot vacuum under $150, I have a $20 off coupon");
    expect(i).toMatchObject({ budgetMinor: 15_000, budgetUnresolved: null });
    expect(i.assumptions.join(" ")).toMatch(/\$20.*not applied/);
  });

  it("an amount with no limit word is applied as the maximum and disclosed", () => {
    const i = parse("a $90 desk lamp");
    expect(i).toMatchObject({ budgetMinor: 9_000, budgetMaxMinor: 9_000 });
    expect(i.moneyConstraints[0]).toMatchObject({ basis: "UNQUALIFIED_AMOUNT_AS_MAXIMUM" });
    expect(i.assumptions.join(" ")).toMatch(/applied as the maximum/);
  });

  it("quantities and model numbers stay out (no false budgets)", () => {
    for (const r of ["headphones with 40 hours battery", "Buy the Velo 360 bike", "4K monitor", "18V drill", "power bank 20000mAh", "router for up to 8 devices", "Buy AirPods Max 2"]) {
      const i = parse(r);
      expect(i.budgetMinor, r).toBeNull(); expect(i.moneyAmbiguities, r).toEqual([]);
    }
  });

  it("a structured budget can only tighten the text budget, never loosen it", () => {
    expect(parse("robot vacuum under US$120", { currency: "USD", budgetMinor: 1_000_000 })).toMatchObject({ budgetMinor: 12_000, budgetMaxMinor: 11_999, budgetSource: "PARSED_FROM_TEXT" });
    expect(parse("robot vacuum under US$120", { currency: "USD", budgetMinor: 9_000 })).toMatchObject({ budgetMinor: 9_000, budgetMaxMinor: 9_000, budgetSource: "STRUCTURED_INPUT" });
    expect(parse("robot vacuum under 200,000 won", { currency: "USD", budgetMinor: 1_000_000 }).budgetConflict).toBeTruthy();
  });

  it("money words never become product requirements", () => {
    const i = parse("robot vacuum between $100 and $150 with a HEPA filter");
    expect(i.requirements.map((r) => r.text).join("|")).not.toMatch(/\$|100|150/);
  });

  it("amounts convert to minor units exactly", () => {
    expect(amountToMinor("1.5", 10_000, "KRW")).toBe(15_000);
    expect(amountToMinor("1.2", 1000, "USD")).toBe(120_000);
    expect(amountToMinor("0.5", 1, "KRW")).toBeNull();
    expect(amountToMinor("99999999999", 1, "USD")).toBeNull();
    expect(parseMoneyConstraints("tv under $99999999999").ambiguities[0]).toMatchObject({ kind: "UNPARSEABLE_AMOUNT" });
  });
});

describe("WP-1 end to end: an over-budget purchase reaches neither checkout-preparation path", () => {
  let h: Harness | null = null;
  afterEach(async () => { await h?.close(); h = null; });
  afterAll(async () => { await closeSharedBrowser(); });
  const prepare = (client: any, ps: string, offerId: string) => callError(client, "prepare_checkout", { purchaseSessionId: ps, offerId, maximumApprovedTotalMinor: 10_000_000, currency: "USD", quantity: 1 });

  it.each([
    "Buy Sony WH-CH720N Black under US$40",
    "Buy Sony WH-CH720N Black, between $30 and $45",
    "Buy Sony WH-CH720N Black, $30-$45",
    "Buy Sony WH-CH720N Black for 40 dollars max",
  ])("%s: research HOLD (over budget), compare HOLD, prepare refused", async (request) => {
    h = await startHarness();
    const client = await mcpClient(h.url, TOKENS.alice);
    const r = await call(client, "research_purchase", { request, currency: "USD", budgetMinor: 10_000_000 });
    expect(r.decision.state).toBe("HOLD");
    expect(r.intent.budgetMinor).toBeLessThanOrEqual(4_500);
    const cmp = await call(client, "compare_purchase_offers", { researchSessionId: r.purchaseSessionId, productIdentity: SONY_BLACK, destination: CA });
    expect(cmp.state).not.toBe("OFFER_VERIFIED");
    const offerId = (cmp.lowestVerifiedEligibleOffer ?? cmp.eligibleOffers[0] ?? cmp.ineligibleOffers[0]).offerId;
    expect(["INVALID_STATE", "RESEARCH_REQUIREMENTS_UNRESOLVED", "OFFER_NOT_ELIGIBLE"]).toContain((await prepare(client, r.purchaseSessionId, offerId)).code);
    await client.close();
  });

  it("a won budget in a USD session holds and blocks prepare (no $60,000 reading)", async () => {
    h = await startHarness();
    const client = await mcpClient(h.url, TOKENS.alice);
    const r = await call(client, "research_purchase", { request: "Buy Sony WH-CH720N Black under 60,000 won", currency: "USD" });
    expect(r.intent.budgetMinor).toBeNull();
    expect(r.decision.state).toBe("HOLD");
    const cmp = await call(client, "compare_purchase_offers", { researchSessionId: r.purchaseSessionId, productIdentity: SONY_BLACK, destination: CA });
    expect(cmp.purchaseReadiness.open.join(" ")).toMatch(/Budget unresolved/);
    expect(["INVALID_STATE", "RESEARCH_REQUIREMENTS_UNRESOLVED"]).toContain((await prepare(client, r.purchaseSessionId, "off_bravo")).code);
    await client.close();
  });

  it("browser checkout: an over-budget request makes no handoff; a within-budget one caps the cart at the stated maximum", async () => {
    const hh = await startHandoffHarness(); h = hh;
    const client = await mcpClient(hh.url, TOKENS.alice);
    const over = await call(client, "research_purchase", { request: "Buy Sony WH-CH720N Black under US$40", currency: "USD" });
    await call(client, "compare_purchase_offers", { researchSessionId: over.purchaseSessionId, productIdentity: SONY_BLACK, destination: CA });
    const res = await client.callTool({ name: "prepare_browser_checkout", arguments: { purchaseSessionId: over.purchaseSessionId, offerId: "off_bravo", quantity: 1, maximumApprovedTotalMinor: 10_000_000, currency: "USD" } });
    expect(res.isError).toBe(true);
    expect(hh.app.store.db.prepare("SELECT COUNT(*) AS n FROM browser_handoffs").get()).toMatchObject({ n: 0 });
    const ok = await call(client, "research_purchase", { request: "Buy Sony WH-CH720N Black under US$100", currency: "USD" });
    await call(client, "compare_purchase_offers", { researchSessionId: ok.purchaseSessionId, productIdentity: SONY_BLACK, destination: CA });
    const prep = await call(client, "prepare_browser_checkout", { purchaseSessionId: ok.purchaseSessionId, offerId: "off_bravo", quantity: 1, maximumApprovedTotalMinor: 10_000_000, currency: "USD" });
    const row = hh.app.store.db.prepare("SELECT constraints_json FROM browser_handoffs WHERE id = ?").get(prep.handoffId) as { constraints_json: string };
    expect(JSON.parse(row.constraints_json).maximumSources).toContainEqual({ source: "RESEARCH_BUDGET", maximumMinor: 9_999 });
    await client.close();
  });
});
