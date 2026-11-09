#!/usr/bin/env node
/**
 * Builds sanitized four-host interoperability evidence from:
 *   - the audit proxy log (.data/interop/audit.jsonl)      — server-side wire evidence per host token
 *   - host-side transcripts (.data/interop/<host>.*)        — the host's own record of the tool call
 *   - the server databases (.data/interop/*.sqlite)         — purchase sessions, hash-chained audit events, usage
 * Writes docs/evidence/interop/<host>.json and docs/evidence/interop/matrix.json.
 *
 * A host is PASS only if ALL of these hold:
 *   1. the server saw tools/list from that host's token (discovery),
 *   2. the server saw exactly one tools/call research_purchase from that host's token, with the fixture arguments,
 *   3. the host's own transcript shows it issued that call (host-originated, not curl or a test client),
 *   4. the call returned structuredContent without isError, and its semantics match the reference fixture result,
 *   5. the server stored a purchase session for that host's own user id (authorization attribution).
 * Tokens are never written: only the 12-hex SHA-256 fingerprint prefix that the proxy already records.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const DIR = ".data/interop";
const OUT = "docs/evidence/interop";
const HOSTS = ["claude-code", "codex-cli", "grok-build", "hermes-agent"];
const FIXTURE_ARGS = { request: "Buy Sony WH-CH720N Black", currency: "USD", budgetMinor: 6000, mustHave: ["active_noise_cancellation"] };
const read = (f) => (existsSync(`${DIR}/${f}`) ? readFileSync(`${DIR}/${f}`, "utf8") : null);
const jsonl = (s) => (s ?? "").split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const canon = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));
const sameArgs = (a) => canon(a) === canon(FIXTURE_ARGS);

/** Fields that must be identical across hosts for the same fixture (session ids and usage ids differ by design). */
const semantics = (sc) => sc && {
  state: sc.state, mode: sc.mode, intent: sc.intent, identity: sc.identity,
  candidates: (sc.candidates ?? []).map((c) => ({ productId: c.productId, identity: c.identity, suitability: c.suitability,
    mustHave: c.mustHave?.map((m) => ({ capability: m.capability, status: m.status, evidenceKind: m.evidence?.kind })), listingPrice: c.listingPrice, budgetFit: c.budgetFit })),
  unknowns: sc.unknowns, dataSource: sc.dataSource, paymentEffect: sc.paymentEffect,
};

const wire = jsonl(read("audit.jsonl"));
const sessions = new DatabaseSync(`${DIR}/diaporia.sqlite`, { readOnly: true });
const service = new DatabaseSync(`${DIR}/diaporia-service.sqlite`, { readOnly: true });

/** Host-side transcript parsers: return { hostVersion, toolCalls: [{tool, arguments}], finalText } or null. */
const transcripts = {
  "claude-code": () => {
    const L = jsonl(read("claude-code.stream.jsonl")); if (!L.length) return null;
    const init = L.find((m) => m.type === "system" && m.subtype === "init");
    const calls = L.filter((m) => m.type === "assistant").flatMap((m) => m.message.content).filter((c) => c.type === "tool_use" && c.name.startsWith("mcp__diaporia__"))
      .map((c) => ({ tool: c.name.replace("mcp__diaporia__", ""), arguments: c.input }));
    return { hostVersion: `Claude Code ${init?.claude_code_version}`, model: init?.model ?? null, discoveredTools: init?.tools.filter((t) => t.startsWith("mcp__diaporia__")).map((t) => t.replace("mcp__diaporia__", "")),
      toolCalls: calls, finalText: L.find((m) => m.type === "result")?.result ?? null };
  },
  "codex-cli": () => {
    const L = jsonl(read("codex-cli.events.jsonl")); if (!L.length) return null;
    const calls = L.filter((m) => m.type === "item.completed" && m.item?.type === "mcp_tool_call" && m.item.server === "diaporia")
      .map((m) => ({ tool: m.item.tool, arguments: m.item.arguments, status: m.item.status, error: m.item.error }));
    const msgs = L.filter((m) => m.type === "item.completed" && m.item?.type === "agent_message");
    return { hostVersion: "codex-cli 0.160.0 (codex exec --json)", toolCalls: calls, finalText: msgs.at(-1)?.item.text ?? null };
  },
  "grok-build": () => {
    const L = jsonl(read("grok-build.stream.jsonl")); if (!L.length) return null;
    // Grok exposes MCP tools through its deferred-tool meta tool `use_tool` (tool_name "<server>__<tool>").
    const calls = L.filter((m) => m.type === "tool_call" && m.toolName === "use_tool" && m.rawInput?.tool_name?.startsWith("diaporia__"))
      .map((m) => ({ tool: m.rawInput.tool_name.replace("diaporia__", ""), arguments: m.rawInput.tool_input, via: "use_tool" }));
    const end = L.find((m) => m.type === "end");
    return { hostVersion: read("grok-version.txt")?.trim() ?? null, toolCalls: calls,
      finalText: L.filter((m) => m.type === "text").map((m) => m.data).join(""), costUsd: end?.total_cost_usd ?? null };
  },
  "hermes-agent": () => {
    const L = jsonl(read("hermes-agent.stream.jsonl")); if (!L.length) return null;
    // Hermes stream-json: {type:"tool_use", name:"mcp__diaporia__<tool>", input}. Hermes executes the tool itself;
    // the Claude subscription provider only proposes it (its native MCP is inert and denied execution).
    const calls = L.filter((m) => m.type === "tool_use" && m.name?.startsWith("mcp__diaporia__"))
      .map((m) => ({ tool: m.name.replace("mcp__diaporia__", ""), arguments: m.input }));
    const helpers = L.filter((m) => m.type === "tool_use" && !m.name?.startsWith("mcp__diaporia__")).map((m) => m.name);
    return { hostVersion: read("hermes-version.txt")?.split(/\r?\n/)[0].trim() ?? null, toolCalls: calls,
      finalText: L.find((m) => m.type === "result")?.text ?? null, model: "claude-subscription-directsdk-experimental (haiku)", hostHelperTools: helpers };
  },
};

let reference = null;
const results = {};
for (const host of HOSTS) {
  const mine = wire.filter((r) => r.host === host);
  const lists = mine.filter((r) => r.requests.some((q) => q.method === "tools/list") && r.status === 200);
  const listed = lists.at(-1)?.responses.find((x) => x.result?.tools)?.result.tools.map((t) => t.name) ?? [];
  const callRecs = mine.filter((r) => r.requests.some((q) => q.method === "tools/call"));
  const rpCalls = callRecs.filter((r) => r.requests.some((q) => q.tool === "research_purchase"));
  const call = rpCalls[0];
  const res = call?.responses.find((x) => x.result || x.error);
  const sc = res?.result?.structuredContent ?? null;
  const t = transcripts[host]?.() ?? null;
  const userId = `interop-${host}`;
  const stored = sc ? sessions.prepare("select id,user_id,state,mode from purchase_sessions where id = ?").get(sc.purchaseSessionId) : null;
  const auditRows = sc ? sessions.prepare("select seq,type,user_id,hash from audit_events where subject_id = ? order by seq").all(sc.purchaseSessionId) : [];
  const usage = service.prepare("select provider,operation,provenance,billable,billable_minor,final_supplier_micro from usage_records where user_id = ?").all(userId);
  const handshake = mine.filter((r) => r.requests.length).map((r) => ({ time: r.time, status: r.status, method: r.requests.map((q) => q.method).join(","),
    clientInfo: r.requests.find((q) => q.clientInfo)?.clientInfo ?? undefined, protocolVersion: r.requests.find((q) => q.protocolVersion)?.protocolVersion ?? r.mcpProtocolVersion ?? undefined }));
  const sem = semantics(sc);
  if (!reference && sem && !res?.result?.isError) reference = sem;
  const checks = {
    discovery: listed.includes("research_purchase"),
    exactlyOneResearchCall: rpCalls.length === 1,
    noOtherToolCalls: callRecs.length === rpCalls.length,
    fixtureArguments: !!call && sameArgs(call.requests.find((q) => q.tool === "research_purchase").arguments),
    hostOriginated: !!t && t.toolCalls.some((c) => c.tool === "research_purchase"),
    resultOk: !!sc && !res.result.isError,
    semanticsMatchReference: !!sem && canon(sem) === canon(reference),
    attributedToHostUser: stored?.user_id === userId,
    scopeLimitedDiscovery: listed.length > 0 && !listed.includes("prepare_checkout"),
  };
  const anyTraffic = mine.length > 0;
  const status = Object.values(checks).every(Boolean) ? "PASS" : !anyTraffic ? "NOT_TESTED" : !call ? "NOT_TESTED" : "FAIL";
  results[host] = { status, checks, host: t?.hostVersion ?? null, userAgents: [...new Set(mine.map((r) => r.userAgent))],
    tokenFingerprint: mine[0]?.tokenFingerprint ?? null, discoveredTools: listed, handshake,
    toolCall: call ? { time: call.time, arguments: call.requests.find((q) => q.tool === "research_purchase").arguments, httpStatus: call.status } : null,
    result: sc, server: { purchaseSession: stored ?? null, auditEvents: auditRows, usageRecords: usage },
    hostTranscript: t ? { toolCalls: t.toolCalls.map((c) => ({ tool: c.tool, arguments: c.arguments ?? null })), finalText: t.finalText, model: t.model ?? undefined } : null };
}

mkdirSync(OUT, { recursive: true });
for (const [h, r] of Object.entries(results)) writeFileSync(`${OUT}/${h}.json`, JSON.stringify(r, null, 2) + "\n");
const noToken = wire.filter((r) => r.host === "NO_TOKEN").map((r) => ({ time: r.time, userAgent: r.userAgent, method: r.requests.map((q) => q.method).join(","), status: r.status }));
const matrix = { fixture: FIXTURE_ARGS, generatedAt: new Date().toISOString(), unauthenticatedProbe: noToken,
  hosts: Object.fromEntries(Object.entries(results).map(([h, r]) => [h, { status: r.status, host: r.host, userAgents: r.userAgents, checks: r.checks }])) };
writeFileSync(`${OUT}/matrix.json`, JSON.stringify(matrix, null, 2) + "\n");
console.log(JSON.stringify(matrix.hosts, null, 1));
