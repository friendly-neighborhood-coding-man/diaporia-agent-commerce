/**
 * N-01 (IW-2 verification of 7d1fe4f): a stated mandatory requirement is never dropped silently, recognized or not.
 * Builder-written phrases and the fixture catalog only; nothing is copied from IW-1.1 or IW-2.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { parseResearchIntent } from "../src/intent/ResearchIntentV2.js";
import { extractRequirements } from "../src/intent/Requirements.js";
import { CA, OWNER, SONY_BLACK, TOKENS, call, callError, mcpClient, ownerConfirmsHold, startHarness, type Harness } from "./helpers.js";
import { closeSharedBrowser, startHandoffHarness } from "./handoff-helpers.js";

const parse = (request: string, extra: Record<string, unknown> = {}) => parseResearchIntent({ request, ...extra } as any);

describe("N-01 extraction: every stated requirement is kept, with its span", () => {
  it.each([
    ["reading tablet with an amber night mode under $150", "unrecognized:amber-night-mode"],
    ["Buy the Orbis Q9, it must have Dolby Vision", "unrecognized:dolby-vision"],
    ["a power bank that supports 65W PD output", "unrecognized:65w-pd-output"],
    ["a backpack that has a laptop sleeve", "unrecognized:laptop-sleeve"],
    ["desk fan, it needs to have a remote control", "unrecognized:remote-control"],
    ["앰버 조명 되는 전자책 단말기", "unrecognized:앰버-조명"],
    ["자동 전원 차단 기능이 꼭 있어야 하는 전기 포트", "unrecognized:자동-전원-차단"],
  ])("unrecognized MUST: %s → %s", (r, key) => {
    const i = parse(r);
    expect(i.unresolvedMust).toContain(key);
    const req = i.requirements.find((x) => x.key === key)!;
    expect(req).toMatchObject({ recognized: false, polarity: "REQUIRED", strength: "MUST", source: "REQUEST_TEXT" });
    expect(r.slice(req.span[0], req.span[1]).toLowerCase()).toBe(req.text.toLowerCase());
  });
  it.each([
    ["a speaker without a microphone", "not:microphone"],
    ["tablet, must not have a camera", "not:camera"],
    ["no ANC please, wired headphones", "not:active_noise_cancellation"],
    ["광고 없는 태블릿", "not:광고"],
  ])("negative requirement: %s → %s (blocking, never read as the positive)", (r, key) => {
    const i = parse(r);
    expect(i.unresolvedMust).toContain(key);
    expect(i.requirements.find((x) => x.key === key)!.polarity).toBe("EXCLUDED");
    expect(i.mustHave).not.toContain(key.slice(4));
  });
  it.each(["headphones, ideally with a carry pouch", "speaker, a carry strap would be nice", "tablet with a stylus if possible", "전자책 단말기, 앰버 조명 있으면 좋겠어요"])(
    "optional preference: %s → kept as NICE, never blocking", (r) => {
      const i = parse(r);
      expect(i.unresolvedMust).toEqual([]);
      expect(i.requirements.some((x) => x.strength === "NICE")).toBe(true);
    });
  it("a conditional 'only if it has X' is a requirement", () => {
    expect(parse("get the blender only if it has a glass jar").unresolvedMust).toContain("unrecognized:glass-jar");
  });
  it.each(["laptop with 16GB RAM", "a white monitor with 27 inch screen", "I need a laptop under $900", "monitor, no more than 120 dollars", "Buy Contoso CX-500 Black, max 100",
    "headphones with no bundles", "Over-ear headphones under $60", "Buy the Tailspin Studio ANC Pro", "coffee maker with a thermal carafe"])(
    "controls (attributes, budgets, model names, recognized capabilities): %s → nothing unrecognized", (r) => {
      expect(parse(r).unresolvedMust).toEqual([]);
    });
  it("recognized capabilities still go to mustHave", () => {
    expect(parse("Wireless headphones with noise cancelling under $200").mustHave.sort()).toEqual(["active_noise_cancellation", "wireless"]);
  });
  it("structured input can add requirements but never soften one stated in the text", () => {
    const i = parse("Wireless headphones that support a lanyard loop", { niceToHave: ["wireless", "unrecognized:lanyard-loop"] });
    expect(i.mustHave).toContain("wireless");
    expect(i.niceToHave).not.toContain("wireless");
    expect(i.unresolvedMust).toContain("unrecognized:lanyard-loop");
    expect(extractRequirements("headphones", null, [], { mustHave: ["multipoint"] })[0]).toMatchObject({ key: "multipoint", strength: "MUST", source: "STRUCTURED_INPUT" });
  });
});

const REQ = "Buy Sony WH-CH720N Black for the lowest total price, never exceed $100, it must have a lanyard loop.";
describe("N-01 end to end: an unrecognized must-have blocks both checkout paths until the owner removes it", () => {
  let h: Harness | null = null;
  afterEach(async () => { await h?.close(); h = null; });
  afterAll(async () => { await closeSharedBrowser(); });

  it("research is not RECOMMEND; compare holds with the open item; prepare_checkout is refused; the ledger shows it UNRECOGNIZED", async () => {
    h = await startHarness();
    const client = await mcpClient(h.url, TOKENS.alice);
    const r = await call(client, "research_purchase", { request: REQ, currency: "USD" });
    expect(r.decision.state).not.toBe("RECOMMEND");
    expect(r.intent.v2.unresolvedMust).toContain("unrecognized:lanyard-loop");
    const cmp = await call(client, "compare_purchase_offers", { researchSessionId: r.purchaseSessionId, productIdentity: SONY_BLACK, destination: CA });
    expect(cmp.state).toBe("HOLD");
    expect(cmp.purchaseReadiness.open.join(" ")).toContain("must:unrecognized:lanyard-loop");
    expect(cmp.requirementStatus.find((x: any) => x.key === "must:unrecognized:lanyard-loop")).toMatchObject({ status: "UNRECOGNIZED", recognized: false });
    const offerId = (cmp.lowestPayPalCheckoutableOffer ?? cmp.eligibleOffers[0]).offerId;
    const e = await callError(client, "prepare_checkout", { purchaseSessionId: r.purchaseSessionId, offerId, maximumApprovedTotalMinor: 10_000, currency: "USD", quantity: 1 });
    expect(["INVALID_STATE", "RESEARCH_REQUIREMENTS_UNRESOLVED"]).toContain(e.code);
    // The agent cannot reinterpret it as optional: its own proposal changes nothing.
    await call(client, "resolve_research_hold", { purchaseSessionId: r.purchaseSessionId, kind: "DROP_REQUIREMENT", requirement: "must:unrecognized:lanyard-loop", currency: "USD", userStatement: "the user said it is optional" });
    expect((await call(client, "compare_purchase_offers", { researchSessionId: r.purchaseSessionId, productIdentity: SONY_BLACK, destination: CA })).state).toBe("HOLD");
    await client.close();
  });

  it("the browser-checkout path is refused too (no cart, no handoff row)", async () => {
    const hh = await startHandoffHarness(); h = hh;
    const client = await mcpClient(hh.url, TOKENS.alice);
    const r = await call(client, "research_purchase", { request: REQ, currency: "USD" });
    await call(client, "compare_purchase_offers", { researchSessionId: r.purchaseSessionId, productIdentity: SONY_BLACK, destination: CA });
    const res = await client.callTool({ name: "prepare_browser_checkout", arguments: { purchaseSessionId: r.purchaseSessionId, offerId: "off_bravo", quantity: 1, maximumApprovedTotalMinor: 8000, currency: "USD" } });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/RESEARCH_REQUIREMENTS_UNRESOLVED|INVALID_STATE/);
    expect(hh.app.store.db.prepare("SELECT COUNT(*) AS n FROM browser_handoffs").get()).toMatchObject({ n: 0 });
    await client.close();
  });

  it("after the human owner removes it on the owner page, the ledger says REMOVED_BY_OWNER and the gate opens", async () => {
    h = await startHarness();
    const client = await mcpClient(h.url, TOKENS.alice);
    const r = await call(client, "research_purchase", { request: REQ, currency: "USD" });
    await call(client, "compare_purchase_offers", { researchSessionId: r.purchaseSessionId, productIdentity: SONY_BLACK, destination: CA });
    const p = await call(client, "resolve_research_hold", { purchaseSessionId: r.purchaseSessionId, kind: "DROP_REQUIREMENT", requirement: "must:unrecognized:lanyard-loop", currency: "USD", userStatement: "The user may accept this." });
    const page = await ownerConfirmsHold(p.ownerConfirmationUrl, OWNER.alice);
    expect(page.reviewHtml).toMatch(/cannot check this requirement automatically/);
    expect(page.status).toBe(200);
    const cmp = await call(client, "compare_purchase_offers", { researchSessionId: r.purchaseSessionId, productIdentity: SONY_BLACK, destination: CA });
    expect(cmp.requirementStatus.find((x: any) => x.key === "must:unrecognized:lanyard-loop").status).toBe("REMOVED_BY_OWNER");
    expect(cmp.purchaseReadiness.open.join(" ")).not.toContain("lanyard");
    await client.close();
  });
});
