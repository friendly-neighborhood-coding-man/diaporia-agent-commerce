/** V2.3 (V22-08): service isolation lost while running disables payment-facing routes and payment start immediately. */
import { afterEach, describe, expect, it } from "vitest";
import { OWNER, TOKENS, call, mcpClient, researchAndCompare, startHarness, type Harness } from "./helpers.js";

describe("isolation re-check", () => {
  let h: Harness | null = null;
  afterEach(async () => { await h?.close(); h = null; });
  it("owner pages and payment preparation are refused once the shared isolation state is lost", async () => {
    const iso = { established: true, reason: "test" };
    h = await startHarness({ serviceIsolation: iso });
    const client = await mcpClient(h.url, TOKENS.alice);
    const { research } = await researchAndCompare(client);
    const ok = await call(client, "prepare_checkout", { purchaseSessionId: research.purchaseSessionId, offerId: "off_alpha", maximumApprovedTotalMinor: 6000, currency: "USD", quantity: 1 });
    expect(ok.userAuthorizationUrl).toBeTruthy();
    iso.established = false; iso.reason = "lost while running: data directory writable by others";
    const page = await fetch(ok.userAuthorizationUrl, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: h.url }, body: new URLSearchParams({ action: "review", ownerKey: OWNER.alice }).toString() });
    expect(page.status).toBe(403);
    const r2 = await researchAndCompare(client);
    const refused = await client.callTool({ name: "prepare_checkout", arguments: { purchaseSessionId: r2.research.purchaseSessionId, offerId: "off_alpha", maximumApprovedTotalMinor: 6000, currency: "USD", quantity: 1 } });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toMatch(/PAYMENT_DISABLED/);
    expect(h.mock.calls.createOrder).toBe(0);
    await client.close();
  });
});
