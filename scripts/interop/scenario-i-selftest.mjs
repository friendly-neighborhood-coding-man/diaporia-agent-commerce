#!/usr/bin/env node
/**
 * Offline self-test of the Scenario I TOOLING (not of any host). It runs setup → serve → a simulated host
 * (the official MCP SDK client, through the audit proxy) → a simulated human (owner page + MOCK buyer approval)
 * → probe → build-fullflow-evidence, in a temporary directory on spare loopback ports.
 * The transcripts it writes are synthetic copies of the wire calls in each host's transcript format, so a PASS
 * here proves only that the scripts and checks work. It says nothing about any real host.
 *
 *   npm run build && node scripts/interop/scenario-i-selftest.mjs
 *
 * Negative controls: one simulated host skips phase 2, and its evidence must not be PASS.
 */
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const dir = mkdtempSync(join(tmpdir(), "scenario-i-selftest-"));
const out = join(dir, "evidence");
const env = { ...process.env, SCENARIO_I_DIR: dir, SCENARIO_I_SERVER_PORT: "28991", SCENARIO_I_PROXY_PORT: "28990" };
const S = "http://127.0.0.1:28991", P = "http://127.0.0.1:28990";
const node = (args) => execFileSync(process.execPath, args, { env, encoding: "utf8" });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

node(["scripts/interop/scenario-i.mjs", "setup"]);
const tokens = JSON.parse(readFileSync(`${dir}/tokens.json`, "utf8")), owners = JSON.parse(readFileSync(`${dir}/owner-keys.json`, "utf8"));
const srv = spawn(process.execPath, ["scripts/interop/scenario-i.mjs", "serve"], { env, stdio: "ignore" });
let failed = false;
try {
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`${P}/healthz`)).ok) break; } catch {} await wait(200); }
  const health = await (await fetch(`${S}/healthz`)).json();
  if (health.paymentEnvironment !== "MOCK" || !health.paymentExecutionEnabled) throw new Error(`unexpected server mode ${JSON.stringify(health)}`);

  const connect = async (t) => { const c = new Client({ name: "scenario-i-simulated-host", version: "0.0.0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${P}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${t}` } } })); await c.listTools(); return c; };
  const call = async (c, name, args) => { const r = await c.callTool({ name, arguments: args }); if (r.isError) throw new Error(`${name}: ${r.content?.[0]?.text}`); return r.structuredContent; };
  const transcript = {
    "claude-code": (calls, text) => [{ type: "system", subtype: "init", claude_code_version: "SIMULATED", model: "none" },
      ...calls.map(([tool, input]) => ({ type: "assistant", message: { content: [{ type: "tool_use", name: `mcp__diaporia__${tool}`, input }] } })), { type: "result", result: text }],
    "codex-cli": (calls, text) => [...calls.map(([tool, args]) => ({ type: "item.completed", item: { type: "mcp_tool_call", server: "diaporia", tool, arguments: args, status: "completed" } })),
      { type: "item.completed", item: { type: "agent_message", text } }],
    "grok-build": (calls, text) => [...calls.map(([tool, input]) => ({ type: "tool_call", toolName: "use_tool", rawInput: { tool_name: `diaporia__${tool}`, tool_input: input } })), { type: "text", data: text }, { type: "end", total_cost_usd: 0 }],
    "hermes-agent": (calls, text) => [...calls.map(([tool, input]) => ({ type: "tool_use", name: `mcp__diaporia__${tool}`, input })), { type: "result", text }],
  };
  const save = (host, phase, calls, text) => writeFileSync(`${dir}/${host}.${phase}.${host === "codex-cli" ? "events" : "stream"}.jsonl`, transcript[host](calls, text).map((l) => JSON.stringify(l)).join("\n") + "\n");

  const skipPhase2 = "hermes-agent"; // negative control
  for (const host of ["claude-code", "codex-cli", "grok-build", "hermes-agent"]) {
    const c = await connect(tokens[host]); const calls = [];
    const rArgs = { request: "Buy Sony WH-CH720N Black", currency: "USD", budgetMinor: 6000, mustHave: ["active_noise_cancellation"] };
    const r = await call(c, "research_purchase", rArgs); calls.push(["research_purchase", rArgs]);
    const cArgs = { researchSessionId: r.purchaseSessionId, productIdentity: r.identity.lockedIdentity, destination: { country: "US", region: "CA" } };
    const cmp = await call(c, "compare_purchase_offers", cArgs); calls.push(["compare_purchase_offers", cArgs]);
    const pArgs = { purchaseSessionId: r.purchaseSessionId, offerId: cmp.lowestPayPalCheckoutableOffer.offerId, maximumApprovedTotalMinor: 6000, currency: "USD", quantity: 1 };
    const prep = await call(c, "prepare_checkout", pArgs); calls.push(["prepare_checkout", pArgs]);
    await c.close(); save(host, "p1", calls, `state ${prep.state}; the owner must authorize.`);
    if (host === skipPhase2) continue;

    // Simulated human: owner page review → $60.00 → MOCK PayPal approve → return.
    const rv = await fetch(prep.userAuthorizationUrl, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ action: "review", ownerKey: owners[host] }) });
    const html = await rv.text(); const cookie = rv.headers.get("set-cookie").split(";")[0]; const csrf = /name="csrf" value="([^"]+)"/.exec(html)[1];
    if (!html.includes("MOCK") || /Sandbox/.test(html)) throw new Error("review page environment label wrong");
    const a = await fetch(prep.userAuthorizationUrl, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie }, body: new URLSearchParams({ action: "authorize", csrf, maximum: "60.00" }) });
    const orderId = new URL(a.headers.get("location")).pathname.split("/").pop();
    const ap = await fetch(`${S}/mock-paypal/checkout/${orderId}/approve`, { method: "POST", redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: new URL(S).origin }, body: new URLSearchParams({ owner_key: owners[host] }) });
    await (await fetch(ap.headers.get("location"), { redirect: "manual" })).text();
    await wait(5); // the builder checks that the human step happened before phase 2

    node(["scripts/interop/scenario-i.mjs", "phase2", host]);
    const cs = /"checkoutSessionId":"(cs_[0-9a-f-]{36})"/.exec(readFileSync(`${dir}/prompt-phase2.${host}.txt`, "utf8"))[1];
    if (cs !== prep.checkoutSessionId) throw new Error("phase-2 prompt bound to the wrong checkout");
    const c2 = await connect(tokens[host]); const calls2 = [];
    await call(c2, "get_checkout_status", { checkoutSessionId: cs }); calls2.push(["get_checkout_status", { checkoutSessionId: cs }]);
    await call(c2, "get_purchase_receipt", { checkoutSessionId: cs }); calls2.push(["get_purchase_receipt", { checkoutSessionId: cs }]);
    await c2.close(); save(host, "p2", calls2, "Payment completed (MOCK). No merchant order is confirmed and nothing is shown as shipped.");
  }

  console.log(node(["scripts/interop/scenario-i.mjs", "probe"]));
  console.log(node(["scripts/interop/build-fullflow-evidence.mjs", "--dir", dir, "--out", out]));
  const m = JSON.parse(readFileSync(`${out}/matrix.json`, "utf8"));
  const expect = { "claude-code": "PASS", "codex-cli": "PASS", "grok-build": "PASS", "hermes-agent": "FAIL" };
  for (const [h, st] of Object.entries(expect)) if (m.hosts[h].status !== st) { failed = true; console.error(`SELFTEST: ${h} expected ${st}, got ${m.hosts[h].status} (${m.hosts[h].failed})`); }
  // Probe expectations: hermes has no completed checkout, so its owner's repeat-prepare is not used; all probes must pass.
  if (m.probes.pass !== true) { failed = true; console.error("SELFTEST: probes did not all pass"); }
  console.log(failed ? "SELFTEST FAIL" : `SELFTEST PASS (tooling only; ${dir})`);
} catch (e) { failed = true; console.error("SELFTEST ERROR", e); }
finally { srv.kill("SIGTERM"); }
process.exit(failed ? 1 : 0);
