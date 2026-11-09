/**
 * Phase D (offline part): the handoff contract is host-neutral. Four MCP clients announcing the clientInfo names
 * the real hosts used in the four-host interop run receive the SAME contract shape, both as structuredContent and
 * as the JSON text block that text-only CLI hosts read. This is protocol-level evidence, NOT a run of the real hosts.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { TOKENS, SONY_BLACK, CA } from "./helpers.js";
import { closeSharedBrowser, sharedBrowser, startHandoffHarness, type HandoffHarness } from "./handoff-helpers.js";

const HOSTS = ["claude-code", "codex-mcp-client", "grok-shell-diaporia", "hermes-agent"];
let h: HandoffHarness | null = null;
afterEach(async () => { await h?.close(); h = null; });
afterAll(async () => { await closeSharedBrowser(); });
// Real Chromium: cold launch on shared CI runners can take tens of seconds, so warm it once and allow slower steps.
vi.setConfig({ testTimeout: 60_000 });
beforeAll(async () => { await sharedBrowser(); }, 120_000);

const shape = (v: unknown): unknown => Array.isArray(v) ? v.map(shape) : v && typeof v === "object"
  ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, shape(x)])) : typeof v;

describe("Phase D offline: same handoff contract for every host client", () => {
  it("four host-named clients get identical contract shapes and an openable link", async () => {
    h = await startHandoffHarness();
    const shapes: string[] = [];
    for (const name of HOSTS) {
      const client = new Client({ name, version: "test" });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${h.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${TOKENS.alice}` } } }));
      const tools = (await client.listTools()).tools;
      const prep = tools.find((t) => t.name === "prepare_browser_checkout")!;
      expect(prep.annotations).toMatchObject({ destructiveHint: false });
      expect(prep._meta).toMatchObject({ "diaporia/capturesFunds": false, "diaporia/submitsOrders": false });
      const c = async (tool: string, args: Record<string, unknown>) => { const r = await client.callTool({ name: tool, arguments: args }); expect(r.isError).toBeFalsy(); return r; };
      const research = (await c("research_purchase", { request: "Buy Sony WH-CH720N Black, never exceed $100", currency: "USD" })).structuredContent as any;
      await c("compare_purchase_offers", { researchSessionId: research.purchaseSessionId, productIdentity: SONY_BLACK, destination: CA });
      const r = await c("prepare_browser_checkout", { purchaseSessionId: research.purchaseSessionId, offerId: "off_bravo", quantity: 1, maximumApprovedTotalMinor: 8000, currency: "USD" });
      const sc = r.structuredContent as any;
      const text = JSON.parse((r.content as Array<{ text: string }>)[0]!.text);
      expect(text).toEqual(sc); // text-only hosts see exactly the same contract
      expect(sc.humanAction.presentation).toEqual({ cliHosts: "OPEN_LINK_IN_DEFAULT_BROWSER", uiHosts: "OPEN_LINK_OR_EMBED_AUTHENTICATED_PAGE", inChatPaymentModal: "NOT_ASSUMED" });
      expect(JSON.stringify(sc)).not.toMatch(/jwt=|cdp|webdriver|cookie/i);
      shapes.push(JSON.stringify(shape(sc)));
      await client.close();
    }
    expect(new Set(shapes).size).toBe(1);
  });
});
