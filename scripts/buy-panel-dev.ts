/**
 * `npm run dev:buy-panel [-- --port 8790] [-- --request "..."] [-- --delay 600]`
 *
 * Local MOCK dev server for the DIAPORIA Buy panel: the offline demo world, MOCK PayPal, loopback only. Prints:
 *   - an MCP endpoint + DEV-ONLY client token, so Claude Code / Codex can be pointed at it (start_shopping_panel);
 *   - a ready panel link for a demo request (opened by this script through the same MCP tool an AI host would call);
 *   - a DEV-ONLY owner key for the MOCK owner page and the MOCK buyer step (a simulated human; never a real credential).
 * Nothing here contacts a provider or moves money.
 */
import { mkdirSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { randomSecret } from "../src/auth/devAuth.js";
import { createDemoWorldApp } from "./buy-panel/demo-app.js";

const arg = (n: string, d: string) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1]! : d; };
const port = Number(arg("port", process.env.PORT ?? "8790"));
const host = "127.0.0.1";
const baseUrl = `http://${host}:${port}`;
const request = arg("request", "wireless headphones under $150 with multipoint and a lanyard loop, lowest total price");
const token = process.env.DIAPORIA_PANEL_DEV_TOKEN ?? randomSecret("dct");
const ownerKey = process.env.DIAPORIA_PANEL_DEV_OWNER_KEY ?? randomSecret("dok");
const persist = process.argv.includes("--persist");
if (persist) mkdirSync(".data", { recursive: true });
const { app } = createDemoWorldApp({ host, port, baseUrl, dbPath: persist ? ".data/buy-panel-dev.sqlite" : ":memory:", userId: "demo-user", clientToken: token, ownerKey,
  researchDelayMs: Number(arg("delay", "600")) });
await new Promise<void>((r) => app.server.listen(port, host, r));

const client = new Client({ name: "buy-panel-dev", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
const r = await client.callTool({ name: "start_shopping_panel", arguments: { request, currency: "USD" } });
const out = r.structuredContent as { panelUrl: string; runId: string };
await client.close();

console.log(`
DIAPORIA Buy panel dev server (MOCK; no provider calls, no money)
  Panel link     : ${out.panelUrl}
  Fallback URL   : ${baseUrl}/buy/   (resumes the last panel opened in this browser tab)
  MCP endpoint   : ${baseUrl}/mcp   (DEV-ONLY bearer token: ${token})
  Owner key      : ${ownerKey}   (DEV-ONLY, MOCK owner page + MOCK buyer step; a simulated human)
Ctrl+C to stop.`);
