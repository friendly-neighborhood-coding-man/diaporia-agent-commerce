#!/usr/bin/env node
/**
 * Builds sanitized four-host evidence for the TWO-STEP scenario research_purchase → compare_purchase_offers.
 * Inputs (all under .data/interop-compare/, gitignored): audit.jsonl from the audit proxy, each host's own transcript,
 * the server databases, and authz-probe.json. Writes docs/evidence/interop/compare/<host>.json and matrix.json.
 *
 * A host is PASS only if ALL checks hold:
 *   discovery            the server saw tools/list from that host's token, listing both tools
 *   oneCallEach          exactly one research_purchase and exactly one compare_purchase_offers from that token
 *   order                compare happened after research
 *   noOtherToolCalls     no other tools/call from that token
 *   fixtureArguments     research arguments equal the fixture exactly
 *   compareBound         compare used the research result's own purchaseSessionId and lockedIdentity, destination US/CA
 *   hostOriginated       the host's own transcript shows both calls
 *   resultsOk            both calls returned structuredContent without isError
 *   semanticsMatchReference  both results match the first passing host's results field for field
 *   attributedToHostUser the stored purchase session belongs to that host's user id and reached OFFER_VERIFIED
 *   scopeLimitedDiscovery prepare_checkout was never listed
 *   noPaymentEffect      both results report paymentEffect NONE
 * Tokens are never written: only the fingerprint prefix the proxy records.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const DIR = ".data/interop-compare";
const OUT = "docs/evidence/interop/compare";
const HOSTS = ["claude-code", "codex-cli", "grok-build", "hermes-agent"];
const FIXTURE_ARGS = { request: "Buy Sony WH-CH720N Black", currency: "USD", budgetMinor: 6000, mustHave: ["active_noise_cancellation"] };
const read = (f) => (existsSync(`${DIR}/${f}`) ? readFileSync(`${DIR}/${f}`, "utf8") : null);
const jsonl = (s) => (s ?? "").split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const canon = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));

const researchSemantics = (sc) => sc && { state: sc.state, mode: sc.mode, identity: sc.identity, candidates: (sc.candidates ?? []).map((c) => ({ productId: c.productId, suitability: c.suitability })), paymentEffect: sc.paymentEffect };
const compareSemantics = (sc) => sc && {
  state: sc.state, productIdentity: sc.productIdentity,
  eligible: (sc.eligibleOffers ?? []).map((o) => o.offerId).sort(),
  ineligible: (sc.ineligibleOffers ?? []).map((o) => ({ offerId: o.offerId, issues: [...(o.issues ?? [])].sort() })).sort((a, b) => a.offerId.localeCompare(b.offerId)),
  lowestVerifiedEligibleOffer: sc.lowestVerifiedEligibleOffer ? { offerId: sc.lowestVerifiedEligibleOffer.offerId, totalMinor: sc.lowestVerifiedEligibleOffer.cost?.totalMinor ?? sc.lowestVerifiedEligibleOffer.totalMinor ?? null } : null,
  lowestPayPalCheckoutableOffer: sc.lowestPayPalCheckoutableOffer?.offerId ?? null, holdReasons: sc.holdReasons, paymentEffect: sc.paymentEffect,
};

const wire = jsonl(read("audit.jsonl"));
const sessions = new DatabaseSync(`${DIR}/diaporia.sqlite`, { readOnly: true });
const service = new DatabaseSync(`${DIR}/diaporia-service.sqlite`, { readOnly: true });

const transcripts = {
  "claude-code": () => {
    const L = jsonl(read("claude-code.stream.jsonl")); if (!L.length) return null;
    const init = L.find((m) => m.type === "system" && m.subtype === "init");
    const calls = L.filter((m) => m.type === "assistant").flatMap((m) => m.message.content).filter((c) => c.type === "tool_use" && c.name.startsWith("mcp__diaporia__"))
      .map((c) => ({ tool: c.name.replace("mcp__diaporia__", ""), arguments: c.input }));
    return { hostVersion: `Claude Code ${init?.claude_code_version}`, model: init?.model ?? null, toolCalls: calls, finalText: L.find((m) => m.type === "result")?.result ?? null };
  },
  "codex-cli": () => {
    const L = jsonl(read("codex-cli.events.jsonl")); if (!L.length) return null;
    const calls = L.filter((m) => m.type === "item.completed" && m.item?.type === "mcp_tool_call" && m.item.server === "diaporia").map((m) => ({ tool: m.item.tool, arguments: m.item.arguments }));
    return { hostVersion: "codex-cli 0.160.0 (codex exec --json)", toolCalls: calls, finalText: L.filter((m) => m.type === "item.completed" && m.item?.type === "agent_message").at(-1)?.item.text ?? null };
  },
  "grok-build": () => {
    const L = jsonl(read("grok-build.stream.jsonl")); if (!L.length) return null;
    const calls = L.filter((m) => m.type === "tool_call" && m.toolName === "use_tool" && m.rawInput?.tool_name?.startsWith("diaporia__"))
      .map((m) => ({ tool: m.rawInput.tool_name.replace("diaporia__", ""), arguments: m.rawInput.tool_input, via: "use_tool" }));
    const helpers = L.filter((m) => m.type === "tool_call" && m.toolName !== "use_tool").map((m) => m.toolName);
    return { hostVersion: read("grok-version.txt")?.trim() ?? null, toolCalls: calls, hostHelperTools: helpers,
      finalText: L.filter((m) => m.type === "text").map((m) => m.data).join(""), costUsd: L.find((m) => m.type === "end")?.total_cost_usd ?? null };
  },
  "hermes-agent": () => {
    const L = jsonl(read("hermes-agent.stream.jsonl")); if (!L.length) return null;
    const calls = L.filter((m) => m.type === "tool_use" && m.name?.startsWith("mcp__diaporia__")).map((m) => ({ tool: m.name.replace("mcp__diaporia__", ""), arguments: m.input }));
    return { hostVersion: read("hermes-version.txt")?.split(/\r?\n/)[0].trim() ?? null, toolCalls: calls, model: "claude-subscription-directsdk-experimental (haiku)",
      hostHelperTools: L.filter((m) => m.type === "tool_use" && !m.name?.startsWith("mcp__diaporia__")).map((m) => m.name), finalText: L.find((m) => m.type === "result")?.text ?? null };
  },
};

const refs = { research: null, compare: null };
const results = {};
for (const host of HOSTS) {
  const mine = wire.filter((r) => r.host === host);
  const listed = mine.filter((r) => r.requests.some((q) => q.method === "tools/list") && r.status === 200).at(-1)?.responses.find((x) => x.result?.tools)?.result.tools.map((t) => t.name) ?? [];
  const callRecs = mine.filter((r) => r.requests.some((q) => q.method === "tools/call"));
  const byTool = (tool) => callRecs.filter((r) => r.requests.some((q) => q.tool === tool));
  const [rp, cp] = [byTool("research_purchase"), byTool("compare_purchase_offers")];
  const sc = (rec) => rec?.responses.find((x) => x.result || x.error)?.result ?? null;
  const rRes = sc(rp[0]), cRes = sc(cp[0]);
  const rSc = rRes?.structuredContent ?? null, cSc = cRes?.structuredContent ?? null;
  const rArgs = rp[0]?.requests.find((q) => q.tool === "research_purchase").arguments ?? null;
  const cArgs = cp[0]?.requests.find((q) => q.tool === "compare_purchase_offers").arguments ?? null;
  const t = transcripts[host]?.() ?? null;
  const userId = `interop-${host}`;
  const stored = rSc ? sessions.prepare("select id,user_id,state,mode from purchase_sessions where id = ?").get(rSc.purchaseSessionId) : null;
  const auditRows = rSc ? sessions.prepare("select seq,type,user_id,hash from audit_events where subject_id = ? order by seq").all(rSc.purchaseSessionId) : [];
  const usage = service.prepare("select provider,operation,provenance,billable,billable_minor,final_supplier_micro from usage_records where user_id = ?").all(userId);
  const rSem = researchSemantics(rSc), cSem = compareSemantics(cSc);
  const ok = rSc && cSc && !rRes.isError && !cRes.isError;
  if (!refs.research && ok) { refs.research = rSem; refs.compare = cSem; }
  const checks = {
    discovery: listed.includes("research_purchase") && listed.includes("compare_purchase_offers"),
    oneCallEach: rp.length === 1 && cp.length === 1,
    order: !!rp[0] && !!cp[0] && rp[0].time <= cp[0].time,
    noOtherToolCalls: callRecs.length === rp.length + cp.length,
    fixtureArguments: canon(rArgs) === canon(FIXTURE_ARGS),
    compareBound: !!rSc && !!cArgs && cArgs.researchSessionId === rSc.purchaseSessionId && canon(cArgs.productIdentity) === canon(rSc.identity?.lockedIdentity)
      && canon(cArgs.destination) === canon({ country: "US", region: "CA" }),
    hostOriginated: !!t && ["research_purchase", "compare_purchase_offers"].every((tool) => t.toolCalls.some((c) => c.tool === tool)),
    resultsOk: !!ok,
    semanticsMatchReference: !!ok && canon(rSem) === canon(refs.research) && canon(cSem) === canon(refs.compare),
    attributedToHostUser: stored?.user_id === userId && stored?.state === "OFFER_VERIFIED",
    scopeLimitedDiscovery: listed.length > 0 && !listed.includes("prepare_checkout"),
    noPaymentEffect: rSc?.paymentEffect === "NONE" && cSc?.paymentEffect === "NONE",
  };
  const status = Object.values(checks).every(Boolean) ? "PASS" : !rp.length && !cp.length ? "NOT_TESTED" : "FAIL";
  results[host] = { status, checks, host: t?.hostVersion ?? null, userAgents: [...new Set(mine.map((r) => r.userAgent))], tokenFingerprint: mine[0]?.tokenFingerprint ?? null,
    discoveredTools: listed,
    toolCalls: [rp[0], cp[0]].filter(Boolean).map((r) => ({ time: r.time, tool: r.requests.find((q) => q.method === "tools/call").tool, arguments: r.requests.find((q) => q.method === "tools/call").arguments, httpStatus: r.status })),
    results: { research_purchase: rSc, compare_purchase_offers: cSc },
    server: { purchaseSession: stored ?? null, auditEvents: auditRows, usageRecords: usage },
    hostTranscript: t ? { toolCalls: t.toolCalls.map((c) => ({ tool: c.tool, arguments: c.arguments ?? null })), hostHelperTools: t.hostHelperTools, finalText: t.finalText, model: t.model ?? undefined, costUsd: t.costUsd ?? undefined } : null };
}

mkdirSync(OUT, { recursive: true });
for (const [h, r] of Object.entries(results)) writeFileSync(`${OUT}/${h}.json`, JSON.stringify(r, null, 2) + "\n");
const matrix = {
  scenario: "research_purchase → compare_purchase_offers", fixture: FIXTURE_ARGS, destination: { country: "US", region: "CA" }, generatedAt: new Date().toISOString(),
  unauthenticatedProbe: wire.filter((r) => r.host === "NO_TOKEN").map((r) => ({ time: r.time, userAgent: r.userAgent, method: r.requests.map((q) => q.method).join(","), status: r.status })),
  crossHostAuthorizationProbe: read("authz-probe.json") ? JSON.parse(read("authz-probe.json")) : null,
  hosts: Object.fromEntries(Object.entries(results).map(([h, r]) => [h, { status: r.status, host: r.host, userAgents: r.userAgents, checks: r.checks }])),
};
writeFileSync(`${OUT}/matrix.json`, JSON.stringify(matrix, null, 2) + "\n");
console.log(JSON.stringify(Object.fromEntries(Object.entries(results).map(([h, r]) => [h, { status: r.status, failed: Object.entries(r.checks).filter(([, v]) => !v).map(([k]) => k) }])), null, 1));
