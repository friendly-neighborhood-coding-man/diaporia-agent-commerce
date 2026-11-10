import { afterAll, describe, expect, it, vi } from "vitest";
import { startHarness, mcpClient, call, TOKENS, OWNER, SONY_BLACK, CA } from "./helpers.js";
import { sharedBrowser, closeSharedBrowser } from "./handoff-helpers.js";

// Same budget as the other real-Chromium files: a cold browser launch under a parallel full-suite run can exceed the 20 s default.
vi.setConfig({ testTimeout: 60_000 });

/**
 * DF-3 (Scenario I, 2026-11-10): with `Referrer-Policy: no-referrer` a real browser sends `Origin: null` on a
 * same-origin form POST, so the owner page's Origin check answered 403 to every human. fetch()-based tests
 * never send Origin and could not see it. This test drives the human steps in a real Chromium.
 */
describe("owner authorization in a real browser (MOCK)", () => {
  afterAll(async () => { await closeSharedBrowser(); });

  it("review → $60 limit → authorize → MOCK PayPal approve → COMPLETED, with the browser's own Origin header accepted", async () => {
    const h = await startHarness();
    const browser = await sharedBrowser();
    const ctx = await browser.newContext();
    try {
      const c = await mcpClient(h.url, TOKENS.alice);
      const research = await call(c, "research_purchase", { request: "Buy Sony WH-CH720N Black", currency: "USD", budgetMinor: 6000 });
      const compare = await call(c, "compare_purchase_offers", { researchSessionId: research.purchaseSessionId, productIdentity: SONY_BLACK, destination: CA });
      const prep = await call(c, "prepare_checkout", { purchaseSessionId: research.purchaseSessionId, offerId: compare.lowestPayPalCheckoutableOffer.offerId, maximumApprovedTotalMinor: 6000, currency: "USD", quantity: 1 });

      const page = await ctx.newPage();
      const origins: Array<string | undefined> = [];
      page.on("request", (q) => { if (q.method() === "POST") origins.push(q.headers()["origin"]); });
      const first = await page.goto(prep.userAuthorizationUrl);
      expect(first?.headers()["referrer-policy"]).toBe("same-origin");
      await page.fill("input[name=ownerKey]", OWNER.alice);
      await page.click("button");
      expect(await page.textContent("body")).toContain("Review and set your spending limit");
      await page.fill("input[name=maximum]", "60.00");
      await page.click("form:has(input[name=action][value=preview]) button");       // WP-5: echo before commit
      expect(await page.textContent("[data-field=confirm-limit]")).toContain("You are authorizing up to USD 60.00 for this checkout");
      await page.click("form:has(input[name=action][value=authorize]) button");
      await page.waitForURL(/\/mock-paypal\/checkout\//);
      expect(await page.textContent("body")).toContain("MOCK PayPal");
      await page.fill("form[action$='/approve'] input[name=owner_key]", OWNER.alice);   // WP-1: MOCK buyer login
      await page.click("text=Approve (mock buyer)");
      await page.waitForURL(/\/paypal\/return/);
      expect(await page.textContent("body")).toContain("COMPLETED");

      expect(origins.length).toBe(4);                                                // review, preview, authorize, MOCK approve
      expect(origins.every((o) => o === new URL(h.url).origin)).toBe(true);
      const st = await call(c, "get_checkout_status", { checkoutSessionId: prep.checkoutSessionId });
      expect(st.state).toBe("COMPLETED");
      expect(h.mock.calls.captureOrder).toBe(1);
      await c.close();
    } finally { await ctx.close(); await h.close(); }
  });

  it("a POST whose Origin is another site (or the opaque null origin) is still refused", async () => {
    const h = await startHarness();
    try {
      for (const origin of ["null", "https://evil.example"]) {
        const r = await fetch(`${h.url}/authorize/cs_00000000-0000-4000-8000-000000000000`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/x-www-form-urlencoded" }, body: "action=review&ownerKey=x" });
        expect(r.status).toBe(403);
      }
    } finally { await h.close(); }
  });
});
