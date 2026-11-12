/**
 * Staging candidate (IW-27 arm C engine, c9a4353) inside the DIAPORIA Buy panel product.
 *
 * Integration checks only (no research claims): the panel's research path runs the obligation kernel, the kernel does not
 * change the MOCK demo outcome, the kernel log stays server-side, and payment execution stays loopback + MOCK/Sandbox only.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createDemoWorldApp } from "../scripts/buy-panel/demo-app.js";
import type { App } from "../src/http/server.js";
import { KERNEL_VERSION } from "../src/verification/ObligationKernel.js";
import { PayPalSandboxProvider } from "../src/payment/PayPalCheckoutAdapter.js";

const CLIENT = "dct_staging_kernel_token_000000000";
const OWNER = "dok_staging_kernel_owner_000000000";
const REQUEST = "wireless headphones under $150 with multipoint and a lanyard loop, lowest total price";

const open: Array<{ app: App }> = [];
afterEach(async () => {
  delete process.env.DIAPORIA_OBLIGATION_KERNEL;
  while (open.length) { const { app } = open.pop()!; await new Promise<void>((r) => { app.server.close(() => r()); app.server.closeAllConnections(); }); }
});

async function freePort() {
  const p = createServer(); await new Promise<void>((r) => p.listen(0, "127.0.0.1", r));
  const n = (p.address() as AddressInfo).port; await new Promise<void>((r) => p.close(() => r())); return n;
}
async function start(host = "127.0.0.1", baseHost = "127.0.0.1") {
  const port = await freePort(); const url = `http://${baseHost}:${port}`;
  const { app } = createDemoWorldApp({ host, port, baseUrl: url, dbPath: ":memory:", userId: "alice", clientToken: CLIENT, ownerKey: OWNER });
  await new Promise<void>((r) => app.server.listen(port, "127.0.0.1", r));
  open.push({ app });
  return { app, url: `http://127.0.0.1:${port}` };
}
async function panelRun(h: { app: App; url: string }) {
  const c = new Client({ name: "staging-kernel-test", version: "1" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${h.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${CLIENT}` } } }));
  const r = await c.callTool({ name: "start_shopping_panel", arguments: { request: REQUEST, currency: "USD" } });
  const out = r.structuredContent as any;
  await h.app.panel!.settled(out.runId);
  await c.close();
  const p = new URLSearchParams(new URL(out.panelUrl).hash.slice(1));
  const res = await fetch(`${h.url}/buy/api/runs/${p.get("run")}`, { headers: { Authorization: `Bearer ${p.get("k")}` } });
  const view = await res.json() as any;
  const ps = (h.app.gateway as any).sessions.getPurchaseSession(view.session.purchaseSessionId, "alice");
  return { view, decision: ps.research.decision };
}

describe("staging candidate: obligation kernel inside the Buy panel", () => {
  it("the panel's research path runs the kernel and records its per-check log on the session", async () => {
    const { view, decision } = await panelRun(await start());
    expect(decision.state).toBe("RECOMMEND");
    expect(decision.kernel?.version).toBe(KERNEL_VERSION);
    expect(decision.kernel?.applied).toBe(true);
    expect(decision.kernel?.demoted).toBe(false);
    expect(decision.kernel?.checks.map((c: any) => c.id)).toEqual(expect.arrayContaining(["K1a", "K1b", "K2", "K3", "K4"]));
    expect(view.candidates[0].title).toMatch(/Halden A8/);
    // The kernel log is diagnostic and stays server-side: the browser view does not carry it.
    expect(JSON.stringify(view)).not.toMatch(/obligation-kernel|"K1a"/);
  }, 60_000);

  it("kernel on and kernel off give the same panel outcome on the MOCK demo request (no demo regression)", async () => {
    const on = await panelRun(await start());
    process.env.DIAPORIA_OBLIGATION_KERNEL = "off";
    const off = await panelRun(await start());
    expect(off.decision.kernel).toBeUndefined();
    const shape = (v: any) => v.candidates.map((x: any) => [x.productId, x.status]);
    expect(shape(on.view)).toEqual(shape(off.view));
    expect(on.decision.recommendation?.productId).toBe(off.decision.recommendation?.productId);
  }, 60_000);

  it("payment execution stays loopback-only: a non-loopback deployment of the panel cannot prepare a payment", async () => {
    const local = await start();
    expect(local.app.paymentExecutionEnabled).toBe(true);
    const external = await start("0.0.0.0", "diaporia.example");
    expect(external.app.paymentExecutionEnabled).toBe(false);
  });

  it("no real-money route: the only PayPal provider refuses any environment other than SANDBOX", () => {
    for (const env of ["LIVE", "PRODUCTION", "live"])
      expect(() => new PayPalSandboxProvider({ clientId: "x".repeat(30), clientSecret: "y".repeat(30), env })).toThrow(/SANDBOX/);
  });
});
