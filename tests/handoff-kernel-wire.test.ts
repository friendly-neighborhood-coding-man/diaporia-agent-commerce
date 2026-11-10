/**
 * KERNEL driver wire test — OFFLINE. A fake KERNEL REST backend (injected fetch) runs the exact snippets the
 * KernelDriver sends to /playwright/execute against a local Chromium + the fixture merchant. No KERNEL account,
 * no network, no cost. It proves the request shapes and that the live-view capability never leaks.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { KernelDriver, LocalFixtureDriver, type LocalFixtureSession } from "../src/handoff/drivers.js";
import { OWNER } from "./helpers.js";
import { OwnerBrowser, call, closeSharedBrowser, prepareBravo, sharedBrowser, startHandoffHarness, type HandoffHarness } from "./handoff-helpers.js";

const LIVE = "https://proxy.test-region.onkernel.com:8443/browser/live?jwt=LIVE_SECRET_abc123";
const CDP = "wss://proxy.test-region.onkernel.com:8443/browser/cdp?jwt=CDP_SECRET_xyz789";

function fakeKernel() {
  const local = new LocalFixtureDriver(sharedBrowser);
  const sessions = new Map<string, LocalFixtureSession>();
  const log: Array<{ method: string; path: string; body: any }> = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const u = new URL(String(input)); const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    log.push({ method, path: u.pathname, body });
    if ((init?.headers as Record<string, string>)?.Authorization !== "Bearer sk_test_kernel_key_000") return new Response("{}", { status: 401 });
    if (method === "POST" && u.pathname === "/browsers") {
      const id = `kb_${sessions.size + 1}`;
      sessions.set(id, await local.open());
      return Response.json({ session_id: id, browser_live_view_url: LIVE, cdp_ws_url: CDP, webdriver_ws_url: CDP, base_url: "https://proxy.test-region.onkernel.com:8443/browser/kernel", headless: false });
    }
    const exec = /^\/browsers\/([^/]+)\/playwright\/execute$/.exec(u.pathname);
    if (method === "POST" && exec) {
      try { return Response.json({ success: true, result: await sessions.get(exec[1]!)!.run(body.code, { timeoutSec: body.timeout_sec }) }); }
      catch (e) { return Response.json({ success: false, error: String(e) }); }
    }
    const del = /^\/browsers\/([^/]+)$/.exec(u.pathname);
    if (method === "DELETE" && del) { await sessions.get(del[1]!)?.close(); return new Response(null, { status: 204 }); }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, log, sessions };
}

let h: HandoffHarness | null = null;
afterEach(async () => { await h?.close(); h = null; });
afterAll(async () => { await closeSharedBrowser(); });
// Real Chromium: cold launch on shared CI runners can take tens of seconds, so warm it once and allow slower steps.
vi.setConfig({ testTimeout: 60_000 });
beforeAll(async () => { await sharedBrowser(); }, 120_000);

describe("KERNEL driver (offline wire test)", () => {
  it("refuses to construct without explicit live enablement", () => {
    expect(() => new KernelDriver("sk_test_kernel_key_000", { allowLive: false })).toThrow(/allowLive/);
  });

  it("headful + telemetry off + no replays; live view only on the authenticated takeover page; browser deleted", async () => {
    const k = fakeKernel();
    h = await startHandoffHarness({ driver: () => new KernelDriver("sk_test_kernel_key_000", { allowLive: true, fetchImpl: k.fetchImpl, baseUrl: "https://api.kernel.test" }) });
    const { client, prepared } = await prepareBravo(h);
    expect(prepared.state).toBe("HUMAN_ACTION_REQUIRED");
    expect(prepared.browserProvider).toBe("KERNEL");

    const create = k.log.find((l) => l.method === "POST" && l.path === "/browsers")!;
    expect(create.body).toMatchObject({ headless: false, stealth: false, kiosk_mode: false, telemetry: { enabled: false } });
    expect(k.log.some((l) => /replays/.test(l.path))).toBe(false);

    const owner = new OwnerBrowser(h, prepared.handoffId);
    const review = await owner.review(OWNER.alice);
    expect(review.html).not.toContain("LIVE_SECRET");
    await owner.maximum("60.00");
    const execBefore = k.log.filter((l) => l.path.endsWith("/execute")).length;
    const t = await owner.takeover();
    expect(t.html).toContain(`src="${LIVE}"`);
    expect(t.csp).toContain("frame-src https://proxy.test-region.onkernel.com:8443");

    // The human operates the same browser (here via the fake backend's local session); automation stays paused.
    const local = [...k.sessions.values()][0]!;
    local.pauseForHuman();
    const { page, context } = local.humanPage();
    const [popup] = await Promise.all([context.waitForEvent("page"), page.click("#paypal-button")]);
    await Promise.all([page.waitForURL(/order\/confirmation/), popup.click("#approve")]);
    expect(k.log.filter((l) => l.path.endsWith("/execute")).length).toBe(execBefore);
    local.beginObservation();

    await owner.finish();
    const st = await call(client, "get_browser_checkout_status", { handoffId: prepared.handoffId });
    expect(st.state).toBe("ORDER_CONFIRMED");
    expect(k.log.at(-1)).toMatchObject({ method: "DELETE" });

    // Secrets never reach MCP output, audit, or the review/finish pages.
    const everything = JSON.stringify([prepared, st]) + JSON.stringify(h.app.store.db.prepare("SELECT * FROM audit_events").all())
      + JSON.stringify(h.app.store.db.prepare("SELECT * FROM browser_handoffs").all());
    for (const secret of ["LIVE_SECRET", "CDP_SECRET", "jwt=", "sk_test_kernel_key"]) expect(everything).not.toContain(secret);
  });

  it("arms exactly one independent watchdog and clamps the wall-clock lifetime to ten minutes", async () => {
    const k = fakeKernel();
    const armed: Array<{ id: string; ms: number }> = [];
    const d = new KernelDriver("sk_test_kernel_key_000", { allowLive: true, fetchImpl: k.fetchImpl,
      maxWallMs: 999_999_999, watchdog: async (id, ms) => { armed.push({ id, ms }); } });
    const s = await d.open({ label: "bounded", merchantHost: "example.org", allowedHosts: ["example.org"], timeoutSeconds: 3600 });
    expect(armed).toEqual([{ id: "kb_1", ms: 600_000 }]);
    expect(s.phase).toBe("AUTOMATION");
    await s.close();
    expect(s.phase).toBe("CLOSED");
  });

  it("enforces a per-process browser cap", async () => {
    const k = fakeKernel();
    const d = new KernelDriver("sk_test_kernel_key_000", { allowLive: true, fetchImpl: k.fetchImpl, baseUrl: "https://api.kernel.test", maxSessions: 1 });
    const s = await d.open({ label: "x", merchantHost: "m", allowedHosts: null, timeoutSeconds: 60 });
    await expect(d.open({ label: "y", merchantHost: "m", allowedHosts: null, timeoutSeconds: 60 })).rejects.toThrow(/cap/);
    expect(JSON.stringify(s)).not.toContain("LIVE_SECRET");
    await s.close();
  });
});
