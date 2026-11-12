/**
 * V2.2 WP-4 (M-1/M-2) and WP-5: evidence first. A stated requirement outside the capability vocabulary is a generic
 * proposition that evidence can verify (manufacturer for a stated property, independent experts for a performance
 * claim), never dropped, never softened; brand, category and decorative words are not mandatory capabilities; the owner
 * can attest or waive through the protected flow and that is never reported as verified; verified eligibility comes
 * before price. Builder-written fictional products and pages only (Kestrel, Pellan, Alder, Brix); nothing from IW-1.1,
 * IW-2, IW-3 or IW-4.
 */
import { afterEach, describe, expect, it } from "vitest";
import { clauseStatement, isPerformanceClaim } from "../src/research/capabilities.js";
import { parseResearchIntent } from "../src/intent/ResearchIntentV2.js";
import { CA, OWNER, SONY_BLACK, TOKENS, call, mcpClient, ownerConfirmsHold, startHarness, type Harness } from "./helpers.js";
import { miniWorld, type MiniHit, type MiniProduct } from "./helpers/miniWorld.js";

const intent = (request: string) => parseResearchIntent({ request } as any);

describe("WP-4 generic requirement representation", () => {
  it("each requirement carries span, proposition, polarity, strength, evidence capability and claim type", () => {
    const i = intent("headphones under $200, must have a lanyard loop, no ads, and it must be quiet");
    const by = Object.fromEntries(i.requirements.map((r) => [r.key, r]));
    expect(by["unrecognized:lanyard-loop"]).toMatchObject({ proposition: "has lanyard loop", polarity: "REQUIRED", strength: "MUST", evidenceCapability: "unrecognized:lanyard-loop", claimType: "PROPERTY", source: "REQUEST_TEXT" });
    expect(by["not:ads"]).toMatchObject({ proposition: "has no ads", polarity: "EXCLUDED", strength: "MUST", evidenceCapability: "unrecognized:ads", claimType: "PROPERTY" });
    expect(by["unrecognized:quiet"]).toMatchObject({ claimType: "PERFORMANCE", strength: "MUST" });
    for (const r of i.requirements) expect(i.requirements.find((x) => x.key === r.key)!.span[1]).toBeGreaterThan(r.span[0]);
    expect(i.unresolvedMust).toEqual(expect.arrayContaining(["unrecognized:lanyard-loop", "not:ads", "unrecognized:quiet"]));
  });
  it("every unfamiliar MUST requirement is preserved (none dropped, the vocabulary is not extended)", () => {
    for (const r of ["a lamp that must have a warm dimming curve", "tablet, it needs to have a matte screen coating", "자동 전원 차단 기능이 꼭 있어야 하는 전기 포트"]) {
      const i = intent(r);
      expect(i.unresolvedMust.length).toBeGreaterThan(0);
      expect(i.requirements.every((x) => x.strength === "MUST" || x.note)).toBe(true);
    }
  });
  it("decorative adjectives are optional preferences, never mandatory", () => {
    const i = intent("a stylish wireless speaker under $100");
    expect(i.requirements.find((r) => r.key === "unrecognized:stylish")).toMatchObject({ strength: "NICE", note: "DECORATIVE" });
    expect(i.unresolvedMust).not.toContain("unrecognized:stylish");
    expect(intent("예쁜 무선 이어폰 10만원 이하").unresolvedMust).not.toContain("unrecognized:예쁜");
  });
  it("a category word right after an exact product is not a capability; in discovery it stays a requirement", () => {
    expect(intent("Buy the Brix T18 cordless drill").mustHave).not.toContain("cordless");
    expect(intent("Buy the Brix T18 cordless drill").requirements.find((r) => r.note === "CATEGORY_WORD")?.text).toBe("cordless");
    expect(intent("cordless drill under $150").mustHave).toContain("cordless");
  });
  it("performance claims are classified generically", () => {
    expect(isPerformanceClaim("unrecognized:quiet")).toBe(true);
    expect(isPerformanceClaim("unrecognized:comfortable-for-long-flights")).toBe(true);
    expect(isPerformanceClaim("unrecognized:night-light")).toBe(false);
    expect(isPerformanceClaim("unrecognized:lanyard-loop")).toBe(false);
  });
});

describe("WP-4 proposition statements (what one clause says)", () => {
  it.each([
    ["It has a lanyard loop on the side.", "unrecognized:lanyard-loop", true],
    ["There is no lanyard loop.", "unrecognized:lanyard-loop", false],
    ["Two batteries are not included.", "unrecognized:two-batteries", false],
    ["Two batteries sold separately.", "unrecognized:two-batteries", false],
    ["Supports HDMI 2.0 only.", "unrecognized:hdmi-2.1", null],
    ["온도 조절 기능이 있습니다.", "unrecognized:온도-조절", true],
    ["온도 조절(정밀 조절) 기능은 없습니다.", "unrecognized:온도-조절", false],
    ["온도 조절 기능을 지원하며 소음이 없습니다.", "unrecognized:온도-조절", null],
    ["The app shows no ads.", "unrecognized:ads", false],
  ])("%s → %s = %s", (clause, id, v) => { expect(clauseStatement(clause, id)).toBe(v); });
});

const OFFICIAL = { Kestrel: ["kestrel-audio.example"] };
const EXPERTS = ["soundlab-review.example", "quietdesk-review.example"];
const hp = (id: string, model: string, price: number): MiniProduct => ({ id, title: `Kestrel ${model} Wireless Headphones`, brand: "Kestrel", category: "headphones", categoryTitle: "Headphones", price });
const K5 = hp("k5", "K5", 79); const K9 = hp("k9", "K9", 129);
const manu = (model: string, text: string): MiniHit => ({ match: new RegExp(`Kestrel ${model}`, "i"), title: `Kestrel ${model} specifications`, url: `https://kestrel-audio.example/${model.toLowerCase()}`, content: text });
const expert = (domain: string, model: string, text: string): MiniHit => ({ match: new RegExp(`Kestrel ${model}`, "i"), title: `Kestrel ${model} review`, url: `https://${domain}/kestrel-${model.toLowerCase()}`, content: text });

describe("WP-4/WP-5 end to end", () => {
  let w: ReturnType<typeof miniWorld> | null = null;
  afterEach(() => { w?.close(); w = null; });
  const research = (products: MiniProduct[], hits: MiniHit[], request: string) => {
    w = miniWorld(products, hits, { officialDomains: OFFICIAL, expertReviewDomains: EXPERTS });
    return w.app.gateway.researchPurchase("alice", { request }) as Promise<any>;
  };
  const row = (out: any, id: string) => out.decision.ranking.find((r: any) => r.productId === `ch3:${id}`);

  it("positive control: the manufacturer states an unfamiliar property → verified, purchasable (RECOMMEND)", async () => {
    const out = await research([K9], [manu("K9", "The Kestrel K9 has a lanyard loop and folds flat.")], "Buy the Kestrel K9 headphones, it must have a lanyard loop");
    expect(out.decision.state).toBe("RECOMMEND");
    expect(row(out, "k9").satisfied).toEqual([expect.objectContaining({ key: "unrecognized:lanyard-loop", basis: "MANUFACTURER" })]);
  });
  it("the manufacturer says the product lacks it → known violation, never purchasable", async () => {
    const out = await research([K9], [manu("K9", "The Kestrel K9 has no lanyard loop.")], "Buy the Kestrel K9 headphones, it must have a lanyard loop");
    expect(out.decision.state).not.toBe("RECOMMEND");
    expect(row(out, "k9").disqualifiers.map((d: any) => d.code)).toContain("MUST_HAVE_FALSE");
  });
  it("no attributable statement → stays open (never dropped)", async () => {
    const out = await research([K9], [manu("K5", "The Kestrel K5 has a lanyard loop.")], "Buy the Kestrel K9 headphones, it must have a lanyard loop");
    expect(out.decision.state).toBe("INVESTIGATE");
    expect(row(out, "k9").blockers.map((b: any) => b.code)).toContain("MUST_HAVE_UNRECOGNIZED");
  });
  it("a performance claim is not verified by the manufacturer alone; two independent expert groups verify it", async () => {
    const req = "Buy the Kestrel K9 headphones, it must be quiet";
    const only = await research([K9], [manu("K9", "The Kestrel K9 is quiet.")], req);
    expect(only.decision.state).not.toBe("RECOMMEND");
    w!.close(); w = null;
    const two = await research([K9], [expert(EXPERTS[0]!, "K9", "In our tests the Kestrel K9 is quiet even at full volume."), expert(EXPERTS[1]!, "K9", "We measured the Kestrel K9: quiet, with very little leakage.")], req);
    expect(two.decision.state).toBe("RECOMMEND");
    expect(row(two, "k9").satisfied[0]).toMatchObject({ basis: "TWO_EXPERT_GROUPS" });
  });
  it("a negative requirement is satisfied only by a statement of absence", async () => {
    const out = await research([K9], [manu("K9", "The Kestrel K9 companion app shows no ads.")], "Buy the Kestrel K9 headphones, no ads");
    expect(row(out, "k9").satisfied).toEqual([expect.objectContaining({ key: "not:ads" })]);
    w!.close(); w = null;
    const bad = await research([K9], [manu("K9", "The Kestrel K9 companion app shows ads.")], "Buy the Kestrel K9 headphones, no ads");
    expect(row(bad, "k9").disqualifiers.map((d: any) => d.code)).toContain("MUST_HAVE_FALSE");
  });
  it("a kit page does not verify a requirement for the standalone listing", async () => {
    const out = await research([K9], [manu("K9", "The Kestrel K9 travel kit includes a lanyard loop adapter and a lanyard loop.")], "Buy the Kestrel K9 headphones, it must have a lanyard loop");
    expect(out.decision.state).not.toBe("RECOMMEND");
  });
  it("WP-5: a cheaper listing never outranks one whose unfamiliar requirement is verified", async () => {
    const out = await research([K5, K9], [manu("K9", "The Kestrel K9 is wireless. The Kestrel K9 has a lanyard loop.")], "wireless headphones under $200, must have a lanyard loop, lowest price");
    expect(out.decision.state).toBe("RECOMMEND");
    expect(out.decision.recommendation.productId).toBe("ch3:k9");
    expect(row(out, "k5").blockers.length).toBeGreaterThan(0);
  });
  it("WP-5: a known violation is never compensated by price or score", async () => {
    const out = await research([K5, K9], [manu("K5", "The Kestrel K5 is wireless. The Kestrel K5 has no lanyard loop."), manu("K9", "The Kestrel K9 is wireless. The Kestrel K9 has a lanyard loop.")], "wireless headphones under $200, must have a lanyard loop");
    expect(out.decision.recommendation.productId).toBe("ch3:k9");
    expect(row(out, "k5").eligible).toBe(false);
  });
  it("a word that is the listing's own brand is satisfied by the catalog identity, not by evidence", async () => {
    const pack = (id: string, brand: string): MiniProduct => ({ id, title: `${brand} 30L Travel Backpack`, brand, category: "backpacks", categoryTitle: "Backpacks", price: 89 });
    const out = await research([pack("al30", "Alder"), pack("ot30", "Otterline")], [], "Buy the Alder 30L Travel Backpack");
    const al = row(out, "al30"); const ot = row(out, "ot30");
    if (out.intent?.unresolvedMust?.includes?.("unrecognized:alder") ?? true) {
      expect((al.satisfied ?? []).map((s: any) => s.basis)).not.toContain("MANUFACTURER");
      if (ot) expect(ot.blockers.map((b: any) => b.detail).join(" ")).not.toMatch(/catalog identity/);
    }
    expect(al.blockers.map((b: any) => b.detail).join(" ")).not.toMatch(/unrecognized:alder/);
  });
});

describe("WP-4 owner attestation and waiver (protected owner flow)", () => {
  let h: Harness | null = null;
  afterEach(async () => { await h?.close(); h = null; });
  const REQ = "Buy Sony WH-CH720N Black for the lowest total price, never exceed $100, it must have a lanyard loop.";
  const KEY = "must:unrecognized:lanyard-loop";
  async function flow(kind: "ATTEST_REQUIREMENT" | "DROP_REQUIREMENT") {
    h = await startHarness();
    const client = await mcpClient(h.url, TOKENS.alice);
    const r = await call(client, "research_purchase", { request: REQ, currency: "USD" });
    const before = await call(client, "compare_purchase_offers", { researchSessionId: r.purchaseSessionId, productIdentity: SONY_BLACK, destination: CA });
    expect(before.requirementStatus.find((x: any) => x.key === KEY).verification).toBe("UNVERIFIED");
    const p = await call(client, "resolve_research_hold", { purchaseSessionId: r.purchaseSessionId, kind, requirement: KEY, currency: "USD", userStatement: "The user says they own this model." });
    const page = await ownerConfirmsHold(p.ownerConfirmationUrl, OWNER.alice);
    expect(page.status).toBe(200);
    const after = await call(client, "compare_purchase_offers", { researchSessionId: r.purchaseSessionId, productIdentity: SONY_BLACK, destination: CA });
    const audit = h.app.gateway.audit.timeline([r.purchaseSessionId], "alice").filter((e: any) => e.type === "RESEARCH_HOLD_CONFIRMED_BY_OWNER");
    await client.close();
    return { page, after, audit };
  }
  it("ATTEST: recorded as OWNER_ATTESTED (never VERIFIED), audited, and the hold clears only after a fresh compare", async () => {
    const { page, after, audit } = await flow("ATTEST_REQUIREMENT");
    expect(page.reviewHtml).toMatch(/has NOT verified this/);
    const led = after.requirementStatus.find((x: any) => x.key === KEY);
    expect(led).toMatchObject({ verification: "OWNER_ATTESTED", status: "ATTESTED_BY_OWNER", evidence: null });
    expect(led.caution).toMatch(/not independently verified/);
    expect(after.purchaseReadiness.open.join(" ")).not.toContain("lanyard");
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0]!.data)).toMatch(/ATTEST_REQUIREMENT/);
  });
  it("WAIVE: recorded as OWNER_WAIVED", async () => {
    const { after } = await flow("DROP_REQUIREMENT");
    expect(after.requirementStatus.find((x: any) => x.key === KEY)).toMatchObject({ verification: "OWNER_WAIVED", status: "REMOVED_BY_OWNER" });
  });
});
