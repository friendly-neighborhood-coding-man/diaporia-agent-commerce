import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OWNER, TOKENS, buyer, call, createMandate, mcpClient, researchAndCompare, SONY_BLACK, startHarness, type Harness } from "./helpers.js";

let h: Harness;
beforeEach(async () => { h = await startHarness(); });
afterEach(async () => { await h.close(); });

const form = (body: Record<string, string>, cookie?: string) => ({ method: "POST", redirect: "manual" as const,
  headers: { "Content-Type": "application/x-www-form-urlencoded", ...(cookie ? { Cookie: cookie } : {}) }, body: new URLSearchParams(body).toString() });

async function preparedWithoutMandate() {
  const client = await mcpClient(h.url, TOKENS.alice);
  const { research } = await researchAndCompare(client);
  const prep = await call(client, "prepare_checkout", { purchaseSessionId: research.purchaseSessionId, offerId: "off_alpha", maximumApprovedTotalMinor: 6000, currency: "USD", quantity: 1 });
  return { client, prep };
}
async function review(url: string, ownerKey = OWNER.alice) {
  const r = await fetch(url, form({ action: "review", ownerKey }));
  const html = await r.text();
  return { status: r.status, html, cookie: r.headers.get("set-cookie")?.split(";")[0] ?? "", csrf: /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? "" };
}

describe("owner approval and trust interface", () => {
  it("shows environment, product, merchant, payee, every cost component, unknown charges, limits and expiry; MOCK is never called Sandbox", async () => {
    const { client, prep } = await preparedWithoutMandate();
    const landing = await (await fetch(prep.userAuthorizationUrl)).text();
    expect(landing).toContain("MOCK environment");
    expect(landing).not.toMatch(/Sandbox/);
    const r = await review(prep.userAuthorizationUrl);
    expect(r.status).toBe(200);
    expect(r.html).toContain("MOCK (simulated; no PayPal call, no money)");
    expect(r.html).not.toMatch(/Sandbox/);
    expect(r.html).toContain("Sony WH-CH720N · Black · new · SKU WHCH720N/B");
    expect(r.html).toMatch(/Funds go to<\/td><td data-field="payee">[^<]+· payee <code>/);
    for (const label of ["Shipping", "Tax", "Fees", "Discount", "Unknown charges", "Total payable", "Your current spending limit", "Quote expires"]) expect(r.html).toContain(label);
    expect(r.html).toMatch(/data-field="unknown-charges">none/);
    expect(r.html).toMatch(/59\.39 USD/);
    expect(r.html).toContain("none yet: you set it below");
    expect(r.html).toContain("Cancel this checkout");
    expect(r.html).toContain("A browser redirect is never proof of payment");
    await client.close();
  });

  it("shows an existing mandate's limit, reservation and status", async () => {
    await createMandate(h.url, OWNER.alice, { productIdentity: SONY_BLACK, currency: "USD", maximumTotalMinor: 6000 });
    const client = await mcpClient(h.url, TOKENS.alice);
    const { research } = await researchAndCompare(client);
    const prep = await call(client, "prepare_checkout", { purchaseSessionId: research.purchaseSessionId, offerId: "off_alpha", maximumApprovedTotalMinor: 6000, currency: "USD", quantity: 1 });
    const r = await review(`${h.url}/authorize/${prep.checkoutSessionId}`);
    expect(r.html).toMatch(/data-field="spending-limit">60\.00 USD \(ACTIVE, expires [^;]+; reserved 59\.39 USD, used 0\.00 USD\)/);
    await client.close();
  });

  it("another user's owner key cannot review or cancel the checkout", async () => {
    const { client, prep } = await preparedWithoutMandate();
    expect((await review(prep.userAuthorizationUrl, OWNER.bob)).status).toBe(404);
    const api = await fetch(`${h.url}/owner/checkouts/${prep.checkoutSessionId}/cancel`, { method: "POST", headers: { "X-Owner-Key": OWNER.bob } });
    expect(api.status).toBe(404);
    expect((await call(client, "get_checkout_status", { checkoutSessionId: prep.checkoutSessionId })).state).not.toBe("CANCELLED");
    await client.close();
  });

  it("cancel from the review page: CANCELLED, nothing paid, the AI client sees it, the cancelled checkout cannot be authorized", async () => {
    const { client, prep } = await preparedWithoutMandate();
    const r = await review(prep.userAuthorizationUrl);
    const c = await fetch(prep.userAuthorizationUrl, form({ action: "cancel", csrf: r.csrf }, r.cookie));
    expect(c.status).toBe(200);
    expect(await c.text()).toContain("Nothing was paid");
    const st = await call(client, "get_checkout_status", { checkoutSessionId: prep.checkoutSessionId });
    expect(st).toMatchObject({ state: "CANCELLED", failure: { code: "OWNER_CANCELLED" } });
    const r2 = await review(prep.userAuthorizationUrl);
    const again = await fetch(prep.userAuthorizationUrl, form({ action: "authorize", csrf: r2.csrf, maximum: "60.00" }, r2.cookie));
    expect(again.status).not.toBe(303);
    expect(h.mock.calls.createOrder).toBe(0);
    // A forged cancel without the review session is refused.
    expect((await fetch(prep.userAuthorizationUrl, form({ action: "cancel", csrf: "x" }))).status).toBe(401);
    await client.close();
  });

  it("owner cancel API releases the mandate reservation before buyer approval, and refuses after the buyer approved at the provider", async () => {
    const m = (await createMandate(h.url, OWNER.alice, { productIdentity: SONY_BLACK, currency: "USD", maximumTotalMinor: 6000, maximumTransactions: 2 })).body;
    const client = await mcpClient(h.url, TOKENS.alice);
    const { research } = await researchAndCompare(client);
    const prep = await call(client, "prepare_checkout", { purchaseSessionId: research.purchaseSessionId, offerId: "off_alpha", maximumApprovedTotalMinor: 6000, currency: "USD", quantity: 1 });
    expect(h.app.gateway.mandates.get(m.mandateId, "alice")!.reservedMinor).toBe(5939);
    const ok = await fetch(`${h.url}/owner/checkouts/${prep.checkoutSessionId}/cancel`, { method: "POST", headers: { "X-Owner-Key": OWNER.alice } });
    expect(ok.status).toBe(200);
    expect((await ok.json() as any)).toMatchObject({ cancelled: true, status: { state: "CANCELLED" } });
    expect(h.app.gateway.mandates.get(m.mandateId, "alice")!.reservedMinor).toBe(0);
    // Second checkout: the buyer approves at the (mock) provider, then the owner tries to cancel.
    const { research: r2 } = await researchAndCompare(client);
    const prep2 = await call(client, "prepare_checkout", { purchaseSessionId: r2.purchaseSessionId, offerId: "off_alpha", maximumApprovedTotalMinor: 6000, currency: "USD", quantity: 1 });
    const orderId = new URL(prep2.approvalUrl).pathname.split("/").pop()!;
    h.mock.buyerApprove(orderId);
    const refused = await fetch(`${h.url}/owner/checkouts/${prep2.checkoutSessionId}/cancel`, { method: "POST", headers: { "X-Owner-Key": OWNER.alice } });
    expect(refused.status).toBe(409);
    expect((await refused.json() as any).reason).toBe("BUYER_ALREADY_APPROVED_AT_PROVIDER");
    // The checkout continues normally and completes exactly once.
    await buyer(h, prep2.approvalUrl);
    expect((await call(client, "get_checkout_status", { checkoutSessionId: prep2.checkoutSessionId })).state).toBe("COMPLETED");
    expect(h.mock.calls.captureOrder).toBe(1);
    const done = await fetch(`${h.url}/owner/checkouts/${prep2.checkoutSessionId}/cancel`, { method: "POST", headers: { "X-Owner-Key": OWNER.alice } });
    expect((await done.json() as any).reason).toBe("NOT_CANCELLABLE_IN_COMPLETED");
    await client.close();
  });

  it("the PayPal return page names the MOCK environment and does not claim payment", async () => {
    await createMandate(h.url, OWNER.alice, { productIdentity: SONY_BLACK, currency: "USD", maximumTotalMinor: 6000 });
    const client = await mcpClient(h.url, TOKENS.alice);
    const { research } = await researchAndCompare(client);
    const prep = await call(client, "prepare_checkout", { purchaseSessionId: research.purchaseSessionId, offerId: "off_alpha", maximumApprovedTotalMinor: 6000, currency: "USD", quantity: 1 });
    const b = await buyer(h, prep.approvalUrl);
    expect(b.returnHtml).toContain("MOCK environment");
    expect(b.returnHtml).not.toMatch(/Sandbox/);
    expect(b.returnHtml).toContain("This page does not itself prove payment");
    await client.close();
  });
  describe("DF-4: an owner submit never leaves spending authority behind (Scenario I run 2)", () => {
    const authorize = async (url: string, maximum = "60.00") => { const r = await review(url); return fetch(url, form({ action: "authorize", csrf: r.csrf, maximum }, r.cookie)); };

    it("authorizing an EXPIRED checkout is refused and creates no mandate; a later checkout still needs the owner", async () => {
      const { client, prep } = await preparedWithoutMandate();
      h.clock.offsetMs += 16 * 60_000; // past the 15-minute checkout expiry
      const r = await authorize(prep.userAuthorizationUrl);
      expect(r.status).toBe(409);
      expect(h.app.gateway.mandates.listActive("alice")).toHaveLength(0);
      const { prep: again } = await preparedWithoutMandate();
      expect(again.state).toBe("APPROVAL_REQUIRED");
      expect(again.authorizationRequirements).toContain("OWNER_MANDATE_REQUIRED");
      expect(h.mock.calls.createOrder).toBe(0);
      await client.close();
    });

    it("re-submitting the form after the checkout COMPLETED is refused and creates no second mandate", async () => {
      const { client, prep } = await preparedWithoutMandate();
      const first = await authorize(prep.userAuthorizationUrl);
      expect(first.status).toBe(303);
      await buyer(h, first.headers.get("location")!);
      expect((await call(client, "get_checkout_status", { checkoutSessionId: prep.checkoutSessionId })).state).toBe("COMPLETED");
      const second = await authorize(prep.userAuthorizationUrl);
      expect(second.status).toBe(409);
      expect(h.app.gateway.mandates.listActive("alice")).toHaveLength(0);
      await client.close();
    });

    it("a limit below the total HOLDs the checkout and the page's own mandate is revoked, not left active", async () => {
      const { client, prep } = await preparedWithoutMandate();
      const r = await authorize(prep.userAuthorizationUrl, "10.00");
      expect(r.status).toBe(403);
      expect(h.app.gateway.mandates.listActive("alice")).toHaveLength(0);
      await client.close();
    });
  });
});
