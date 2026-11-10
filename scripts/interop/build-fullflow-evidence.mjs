#!/usr/bin/env node
/**
 * Builds sanitized four-host evidence for Scenario I, the full purchasing workflow:
 *   phase 1 (host):  research_purchase → compare_purchase_offers → prepare_checkout
 *   human:           owner authorization page ($60 limit) → MOCK PayPal buyer approval
 *   phase 2 (host):  get_checkout_status → get_purchase_receipt
 * Inputs (gitignored, default .data/scenario-i/): audit.jsonl from the audit proxy, each host's own transcripts
 * (<host>.p1.<ext>, <host>.p2.<ext>), the server database, probes.json. Writes <out>/<host>.json and matrix.json.
 *
 *   node scripts/interop/build-fullflow-evidence.mjs [--dir .data/scenario-i] [--out docs/evidence/interop/fullflow]
 *
 * A host is PASS only if ALL gating checks hold (see CHECKS below). hostStatementHonest is recorded but does not gate:
 * it is a regex over free text, so a human reads the host's final answer before it is quoted anywhere.
 * Tokens and owner keys are never written: only the fingerprint prefix the proxy records.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const DIR = arg("dir", ".data/scenario-i");
const OUT = arg("out", "docs/evidence/interop/fullflow");
const HOSTS = ["claude-code", "codex-cli", "grok-build", "hermes-agent"];
const USER = (h) => `scenario-i-${h}`;
const RESEARCH_ARGS = { request: "Buy Sony WH-CH720N Black", currency: "USD", budgetMinor: 6000, mustHave: ["active_noise_cancellation"] };
const DESTINATION = { country: "US", region: "CA" };
const FLOW = ["research_purchase", "compare_purchase_offers", "prepare_checkout", "get_checkout_status", "get_purchase_receipt"];
const REQUIRED_TOOLS = FLOW;

const read = (f) => (existsSync(`${DIR}/${f}`) ? readFileSync(`${DIR}/${f}`, "utf8") : null);
const jsonl = (s) => (s ?? "").split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const canon = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));

// ---- host transcripts (same formats as the earlier four-host runs; see docs/INTEROP.md) ----
const parsers = {
  "claude-code": (f) => { const L = jsonl(read(f)); if (!L.length) return null;
    const init = L.find((m) => m.type === "system" && m.subtype === "init");
    return { hostVersion: init?.claude_code_version ? `Claude Code ${init.claude_code_version}` : null, model: init?.model ?? null,
      toolCalls: L.filter((m) => m.type === "assistant").flatMap((m) => m.message?.content ?? []).filter((c) => c.type === "tool_use" && c.name?.startsWith("mcp__diaporia__")).map((c) => ({ tool: c.name.replace("mcp__diaporia__", ""), arguments: c.input })),
      finalText: L.find((m) => m.type === "result")?.result ?? null }; },
  "codex-cli": (f) => { const L = jsonl(read(f)); if (!L.length) return null;
    return { hostVersion: read("codex-version.txt")?.trim() ?? null,
      toolCalls: L.filter((m) => m.type === "item.completed" && m.item?.type === "mcp_tool_call" && m.item.server === "diaporia").map((m) => ({ tool: m.item.tool, arguments: m.item.arguments, status: m.item.status ?? null })),
      finalText: L.filter((m) => m.type === "item.completed" && m.item?.type === "agent_message").at(-1)?.item.text ?? null }; },
  "grok-build": (f) => { const L = jsonl(read(f)); if (!L.length) return null;
    return { hostVersion: read("grok-version.txt")?.trim() ?? null,
      toolCalls: L.filter((m) => m.type === "tool_call" && m.toolName === "use_tool" && m.rawInput?.tool_name?.startsWith("diaporia__")).map((m) => ({ tool: m.rawInput.tool_name.replace("diaporia__", ""), arguments: m.rawInput.tool_input, via: "use_tool" })),
      hostHelperTools: L.filter((m) => m.type === "tool_call" && m.toolName !== "use_tool").map((m) => m.toolName),
      finalText: L.filter((m) => m.type === "text").map((m) => m.data).join(""), costUsd: L.find((m) => m.type === "end")?.total_cost_usd ?? null }; },
  "hermes-agent": (f) => { const L = jsonl(read(f)); if (!L.length) return null;
    return { hostVersion: read("hermes-version.txt")?.split(/\r?\n/)[0].trim() ?? null, model: "claude-subscription-directsdk-experimental (haiku)",
      toolCalls: L.filter((m) => m.type === "tool_use" && m.name?.startsWith("mcp__diaporia__")).map((m) => ({ tool: m.name.replace("mcp__diaporia__", ""), arguments: m.input })),
      hostHelperTools: L.filter((m) => m.type === "tool_use" && !m.name?.startsWith("mcp__diaporia__")).map((m) => m.name),
      finalText: L.find((m) => m.type === "result")?.text ?? null }; },
};
const EXT = { "claude-code": "stream.jsonl", "codex-cli": "events.jsonl", "grok-build": "stream.jsonl", "hermes-agent": "stream.jsonl" };

// ---- comparable semantics (ids and timestamps differ by design) ----
const sem = {
  research_purchase: (s) => s && { state: s.state, mode: s.mode, identity: s.identity, candidates: (s.candidates ?? []).map((c) => c.productId), paymentEffect: s.paymentEffect },
  compare_purchase_offers: (s) => s && { state: s.state, eligible: (s.eligibleOffers ?? []).map((o) => o.offerId).sort(), ineligible: (s.ineligibleOffers ?? []).map((o) => o.offerId).sort(),
    lowestVerifiedEligibleOffer: s.lowestVerifiedEligibleOffer?.offerId ?? null, lowestPayPalCheckoutableOffer: s.lowestPayPalCheckoutableOffer?.offerId ?? null, paymentEffect: s.paymentEffect },
  prepare_checkout: (s) => s && { state: s.state, offerId: s.offerId ?? s.purchaseSummary?.offerId ?? null, totalMinor: s.purchaseSummary?.cost?.totalMinor ?? s.amount?.totalMinor ?? null,
    authorizationRequirements: s.authorizationRequirements ?? null, paymentEffect: s.paymentEffect },
  get_checkout_status: (s) => s && { state: s.state, totalMinor: s.amount?.totalMinor, paymentEnvironment: s.paymentEnvironment, purchaseOutcome: s.purchaseOutcome && { payment: s.purchaseOutcome.payment,
    merchantOrderConfirmation: s.purchaseOutcome.merchantOrderConfirmation, fulfillment: s.purchaseOutcome.fulfillment, merchantPurchaseComplete: s.purchaseOutcome.merchantPurchaseComplete } },
  get_purchase_receipt: (s) => s && { paymentResult: s.paymentResult?.status ?? null, merchantOrder: s.merchantOrder?.status ?? null, auditTypes: (s.auditTimeline ?? []).map((e) => e.type ?? e.event ?? e) },
};

const wire = jsonl(read("audit.jsonl"));
const dbPath = `${DIR}/diaporia.sqlite`;
const db = existsSync(dbPath) ? new DatabaseSync(dbPath, { readOnly: true }) : null;
const probes = read("probes.json") ? JSON.parse(read("probes.json")) : null;
const OVERCLAIM = /\b(order (has been|was) placed|has been ordered|is on (its|the) way|has (been )?shipped|will (arrive|be delivered))\b/i;

const ref = {};
const results = {};
for (const host of HOSTS) {
  const mine = wire.filter((r) => r.host === host);
  const listed = mine.filter((r) => r.status === 200 && r.requests?.some((q) => q.method === "tools/list")).at(-1)?.responses?.find((x) => x.result?.tools)?.result.tools.map((t) => t.name) ?? [];
  const calls = mine.filter((r) => r.requests?.some((q) => q.method === "tools/call")).map((r) => {
    const q = r.requests.find((x) => x.method === "tools/call"); const res = r.responses?.find((x) => x.result || x.error) ?? null;
    return { time: r.time, tool: q.tool, arguments: q.arguments, httpStatus: r.status, isError: !!(res?.error || res?.result?.isError), sc: res?.result?.structuredContent ?? null };
  });
  const by = Object.fromEntries(FLOW.map((t) => [t, calls.filter((c) => c.tool === t)]));
  const [R, C, P, S, Rc] = FLOW.map((t) => by[t][0] ?? null);
  const cs = P?.sc?.checkoutSessionId ?? null;
  const t1 = parsers[host](`${host}.p1.${EXT[host]}`), t2 = parsers[host](`${host}.p2.${EXT[host]}`);
  const transcriptTools = [...(t1?.toolCalls ?? []), ...(t2?.toolCalls ?? [])].map((c) => c.tool);

  const checkout = db && cs ? db.prepare("select id,user_id,state,offer_id,total_minor,provider,mandate_id,provider_order_id,capture_id from checkout_sessions where id = ?").get(cs) : null;
  const mandate = db && checkout?.mandate_id ? db.prepare("select id,user_id,max_total_minor,max_transactions,transactions_used,consumed_minor,reserved_minor,created_via,status from mandates where id = ?").get(checkout.mandate_id) : null;
  const audit = db && cs ? db.prepare("select seq,type,user_id,at,hash from audit_events where subject_id = ? order by seq").all(cs) : [];
  const count = (type) => audit.filter((e) => e.type === type).length;
  const humanAt = audit.find((e) => e.type === "MANDATE_CREATED_BY_OWNER")?.at ?? null;
  const completedAt = audit.find((e) => e.type === "PAYMENT_COMPLETED_VERIFIED")?.at ?? null;

  const ok = FLOW.every((t) => by[t][0] && !by[t][0].isError && by[t][0].sc);
  const semantics = Object.fromEntries(FLOW.map((t) => [t, sem[t](by[t][0]?.sc ?? null)]));
  if (!ref.semantics && ok) ref.semantics = semantics;
  const lockedIdentity = R?.sc?.identity?.lockedIdentity;
  const finalText = [t1?.finalText, t2?.finalText].filter(Boolean).join("\n---\n");

  const checks = {
    discovery: REQUIRED_TOOLS.every((t) => listed.includes(t)),
    oneCallEach: FLOW.every((t) => by[t].length === 1),
    noOtherToolCalls: calls.length === FLOW.reduce((n, t) => n + by[t].length, 0),
    order: ok && FLOW.every((t, i) => i === 0 || by[FLOW[i - 1]][0].time <= by[t][0].time),
    fixtureArguments: canon(R?.arguments) === canon(RESEARCH_ARGS),
    compareBound: !!R?.sc && C?.arguments?.researchSessionId === R.sc.purchaseSessionId && canon(C?.arguments?.productIdentity) === canon(lockedIdentity) && canon(C?.arguments?.destination) === canon(DESTINATION),
    prepareBound: !!C?.sc && P?.arguments?.purchaseSessionId === R?.sc?.purchaseSessionId && P?.arguments?.offerId === C.sc.lowestPayPalCheckoutableOffer?.offerId
      && P?.arguments?.maximumApprovedTotalMinor === 6000 && P?.arguments?.currency === "USD" && P?.arguments?.quantity === 1,
    preparedWithoutAuthority: P?.sc?.state === "APPROVAL_REQUIRED" && (P?.sc?.authorizationRequirements ?? []).includes("OWNER_MANDATE_REQUIRED") && !!P?.sc?.userAuthorizationUrl && P?.sc?.paymentEffect === "NO_FUNDS_CAPTURED",
    humanAuthorizedBetweenPhases: !!mandate && mandate.user_id === USER(host) && mandate.created_via === "OWNER_APPROVAL_PAGE" && mandate.max_total_minor === 6000
      && humanAt !== null && Date.parse(P?.time ?? "") <= humanAt && (completedAt ?? Infinity) <= Date.parse(S?.time ?? ""),
    readsBound: S?.arguments?.checkoutSessionId === cs && Rc?.arguments?.checkoutSessionId === cs && !!cs,
    completedMock: S?.sc?.state === "COMPLETED" && S?.sc?.amount?.totalMinor === 5939 && S?.sc?.paymentEnvironment === "MOCK"
      && S?.sc?.purchaseOutcome?.merchantOrderConfirmation === "NOT_CONFIRMED" && S?.sc?.purchaseOutcome?.fulfillment === "NOT_VERIFIED" && S?.sc?.purchaseOutcome?.merchantPurchaseComplete === false,
    receiptOk: Rc?.sc?.paymentResult?.status === "COMPLETED",
    exactlyOneCapture: count("CAPTURE_REQUESTED") === 1 && count("PAYMENT_COMPLETED_VERIFIED") === 1 && !!checkout?.capture_id,
    withinMandate: !!checkout && !!mandate && checkout.total_minor <= mandate.max_total_minor && mandate.transactions_used === 1 && mandate.consumed_minor === checkout.total_minor,
    attributedToHostUser: checkout?.user_id === USER(host) && audit.length > 0 && audit.every((e) => e.user_id === USER(host)),
    hostOriginated: !!t1 && !!t2 && FLOW.every((t) => transcriptTools.includes(t)),
    semanticsMatchReference: ok && canon(semantics) === canon(ref.semantics),
  };
  const observations = { hostStatementHonest: finalText ? !OVERCLAIM.test(finalText) : null, note: "regex over the host's free text; not gating, read the text" };
  const status = !calls.length ? "NOT_TESTED" : Object.values(checks).every(Boolean) ? "PASS" : "FAIL";
  results[host] = {
    status, checks, observations, host: t1?.hostVersion ?? t2?.hostVersion ?? null, model: t1?.model ?? null,
    userAgents: [...new Set(mine.map((r) => r.userAgent))], tokenFingerprint: mine[0]?.tokenFingerprint ?? null, discoveredTools: listed,
    toolCalls: calls.map(({ sc, ...c }) => c), results: Object.fromEntries(FLOW.map((t) => [t, by[t][0]?.sc ?? null])),
    server: { checkout, mandate, auditEvents: audit },
    hostTranscript: { phase1: t1, phase2: t2 },
  };
}
db?.close();

mkdirSync(OUT, { recursive: true });
for (const [h, r] of Object.entries(results)) writeFileSync(`${OUT}/${h}.json`, JSON.stringify(r, null, 2) + "\n");
const matrix = {
  scenario: "Scenario I: research → compare → prepare → human authorization (owner page, $60) → MOCK buyer approval → status → receipt",
  paymentEnvironment: "MOCK (no PayPal API call, no money)", generatedAt: new Date().toISOString(),
  probes: probes ? { pass: probes.pass, ...probes.probes } : "NOT_RUN",
  hosts: Object.fromEntries(Object.entries(results).map(([h, r]) => [h, { status: r.status, host: r.host, userAgents: r.userAgents, failed: Object.entries(r.checks).filter(([, v]) => !v).map(([k]) => k), observations: r.observations }])),
};
writeFileSync(`${OUT}/matrix.json`, JSON.stringify(matrix, null, 2) + "\n");
console.log(JSON.stringify({ probes: probes ? probes.pass : "NOT_RUN", hosts: matrix.hosts }, (k, v) => (k === "userAgents" || k === "note" ? undefined : v), 1));
