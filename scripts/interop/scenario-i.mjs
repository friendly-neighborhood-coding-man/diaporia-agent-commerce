#!/usr/bin/env node
/**
 * Scenario I helper: the full purchasing workflow (research → compare → prepare → human authorization →
 * MOCK buyer approval → status → receipt) across four local AI hosts. Test tooling only; no commerce logic.
 * MOCK payments only: the server is started with PAYMENT_PROVIDER=mock and no research/evidence keys.
 *
 *   node scripts/interop/scenario-i.mjs setup [--force]     write tokens, owner keys, prompts and host configs (gitignored)
 *   node scripts/interop/scenario-i.mjs serve               start the server (18991) and the audit proxy (18990), loopback only
 *   node scripts/interop/scenario-i.mjs links               print each host's owner authorization link (after phase 1)
 *   node scripts/interop/scenario-i.mjs phase2 <host>       write that host's phase-2 prompt with its own checkoutSessionId
 *   node scripts/interop/scenario-i.mjs probe               direct-to-server authorization probes (not through a host)
 *
 * Every secret stays under .data/scenario-i/ (mode 0600). Nothing here prints a token or an owner key except
 * `setup`, which tells you which file holds them.
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DIR = process.env.SCENARIO_I_DIR ?? ".data/scenario-i";
export const HOSTS = ["claude-code", "codex-cli", "grok-build", "hermes-agent"];
export const SERVER_PORT = Number(process.env.SCENARIO_I_SERVER_PORT ?? 18991);
export const PROXY_PORT = Number(process.env.SCENARIO_I_PROXY_PORT ?? 18990);
export const SERVER = `http://127.0.0.1:${SERVER_PORT}`;
export const PROXY = `http://127.0.0.1:${PROXY_PORT}`;
export const userOf = (host) => `scenario-i-${host}`;
export const PROBE_USER = "scenario-i-probe";
export const SCOPES = "purchase.research,purchase.read,purchase.prepare";
export const RESEARCH_ARGS = { request: "Buy Sony WH-CH720N Black", currency: "USD", budgetMinor: 6000, mustHave: ["active_noise_cancellation"] };
export const DESTINATION = { country: "US", region: "CA" };
export const PREPARE_FIXED = { maximumApprovedTotalMinor: 6000, currency: "USD", quantity: 1 };

const fp = (t) => createHash("sha256").update(t).digest("hex").slice(0, 12);
const secret = (p) => `${p}_${randomBytes(24).toString("base64url")}`;
const writeSecret = (f, s) => { writeFileSync(`${DIR}/${f}`, s, { mode: 0o600 }); chmodSync(`${DIR}/${f}`, 0o600); };
const readJson = (f) => JSON.parse(readFileSync(`${DIR}/${f}`, "utf8"));
const jsonl = (s) => (s ?? "").split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

export const PHASE1_PROMPT = `Use the MCP server named diaporia. List its tools. Then make exactly three tool calls, in this order:
1. Call research_purchase exactly once with exactly these arguments: ${JSON.stringify(RESEARCH_ARGS)}
2. Call compare_purchase_offers exactly once with these arguments: researchSessionId = the purchaseSessionId returned by step 1; productIdentity = the identity.lockedIdentity object returned by step 1, copied exactly with all of its fields; destination = ${JSON.stringify(DESTINATION)}.
3. Call prepare_checkout exactly once with these arguments: purchaseSessionId = the purchaseSessionId returned by step 1; offerId = the lowestPayPalCheckoutableOffer.offerId returned by step 2; maximumApprovedTotalMinor = 6000; currency = "USD"; quantity = 1.
Do not call any other tool, do not open any URL, and do not use any other way to reach the server. Then report: the tool names you saw; from step 3 the state, checkoutSessionId, authorizationRequirements, userAuthorizationUrl and paymentEffect; and, in one sentence, what the human has to do next.
`;

export const phase2Prompt = (cs) => `Use the MCP server named diaporia. Make exactly two tool calls, in this order:
1. Call get_checkout_status exactly once with exactly these arguments: {"checkoutSessionId":"${cs}"}
2. Call get_purchase_receipt exactly once with exactly these arguments: {"checkoutSessionId":"${cs}"}
Do not call any other tool, do not open any URL, and do not use any other way to reach the server. Then report: state, amount.totalMinor, paymentEnvironment, and purchaseOutcome (payment, merchantOrderConfirmation, fulfillment, merchantPurchaseComplete) from step 1; paymentResult.status and the audit event types from step 2; and, in one sentence for the user, whether the item has been ordered from the merchant or shipped.
`;

/** The host's own prepare_checkout result, as the audit proxy recorded it. */
export function preparedCheckout(host, wire = jsonl(existsSync(`${DIR}/audit.jsonl`) ? readFileSync(`${DIR}/audit.jsonl`, "utf8") : "")) {
  const rec = wire.filter((r) => r.host === host && r.requests?.some((q) => q.method === "tools/call" && q.tool === "prepare_checkout")).at(-1);
  return rec?.responses?.find((x) => x.result)?.result?.structuredContent ?? null;
}

function setup(force) {
  mkdirSync(DIR, { recursive: true });
  if (existsSync(`${DIR}/tokens.json`) && !force) { console.error(`${DIR}/tokens.json exists; pass --force to replace all credentials`); process.exit(1); }
  const tokens = Object.fromEntries([...HOSTS, "probe"].map((h) => [h, secret("dct")]));
  const owners = Object.fromEntries([...HOSTS, "probe"].map((h) => [h, secret("dok")]));
  const uid = (h) => (h === "probe" ? PROBE_USER : userOf(h));
  writeSecret("tokens.json", JSON.stringify(tokens, null, 2) + "\n");
  writeSecret("owner-keys.json", JSON.stringify(owners, null, 2) + "\n");
  // The proxy only ever sees the four host tokens; probes go straight to the server.
  writeFileSync(`${DIR}/token-labels.json`, JSON.stringify(Object.fromEntries(HOSTS.map((h) => [fp(tokens[h]), h])), null, 2) + "\n");
  writeSecret("server.env.json", JSON.stringify({
    HOST: "127.0.0.1", PORT: String(SERVER_PORT), PAYMENT_PROVIDER: "mock", DIAPORIA_AUTH_MODE: "dev",
    DIAPORIA_DB_PATH: `${DIR}/diaporia.sqlite`,
    DIAPORIA_DEV_TOKENS: Object.entries(tokens).map(([h, t]) => `${t}=${uid(h)}:${SCOPES}`).join(";"),
    DIAPORIA_OWNER_KEYS: Object.entries(owners).map(([h, k]) => `${k}=${uid(h)}`).join(";"),
  }, null, 2) + "\n");
  writeFileSync(`${DIR}/prompt-phase1.txt`, PHASE1_PROMPT);
  writeSecret("claude-mcp.json", JSON.stringify({ mcpServers: { diaporia: { type: "http", url: `${PROXY}/mcp`, headers: { Authorization: `Bearer ${tokens["claude-code"]}` } } } }, null, 2) + "\n");
  mkdirSync(`${DIR}/hermes-home`, { recursive: true });
  writeSecret("hermes-mcp.yaml", `mcp_servers:\n  diaporia:\n    url: "${PROXY}/mcp"\n    headers:\n      Authorization: "Bearer ${tokens["hermes-agent"]}"\n`);
  console.log(`Wrote ${DIR}/ (tokens.json, owner-keys.json, server.env.json, claude-mcp.json, hermes-mcp.yaml are 0600 secrets; never share them).`);
  console.log(`Token fingerprints: ${HOSTS.map((h) => `${h}=${fp(tokens[h])}`).join(" ")}`);
}

function serve() {
  const env = { ...process.env, ...readJson("server.env.json") };
  for (const k of Object.keys(env)) if (/^(CHANNEL3|TAVILY|KERNEL|PAYPAL|OPENROUTER)_/.test(k) || k === "RESEARCH_PROVIDER" || k === "EVIDENCE_PROVIDERS" || k === "PUBLIC_BASE_URL") delete env[k];
  if (!existsSync("dist/src/main.js")) { console.error("Run npm run build first."); process.exit(1); }
  const server = spawn(process.execPath, ["dist/src/main.js"], { env, stdio: "inherit" });
  const proxy = spawn(process.execPath, ["scripts/interop/audit-proxy.mjs", "--listen", String(PROXY_PORT), "--target", String(SERVER_PORT),
    "--out", `${DIR}/audit.jsonl`, "--labels", `${DIR}/token-labels.json`], { stdio: "inherit" });
  const stop = () => { server.kill(); proxy.kill(); };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  server.on("exit", (c) => { console.log(`[scenario-i] server exited ${c}`); proxy.kill(); });
}

function links() {
  for (const h of HOSTS) {
    const p = preparedCheckout(h);
    console.log(`${h.padEnd(13)} ${p ? `${p.state} ${p.checkoutSessionId} ${p.userAuthorizationUrl ?? "(no authorization link)"}` : "no prepare_checkout seen yet"}`);
  }
}

function phase2(host) {
  if (!HOSTS.includes(host)) { console.error(`host must be one of ${HOSTS.join(", ")}`); process.exit(1); }
  const p = preparedCheckout(host);
  if (!p?.checkoutSessionId) { console.error(`${host}: no prepared checkout in ${DIR}/audit.jsonl; run phase 1 first`); process.exit(1); }
  writeFileSync(`${DIR}/prompt-phase2.${host}.txt`, phase2Prompt(p.checkoutSessionId));
  console.log(`${DIR}/prompt-phase2.${host}.txt → ${p.checkoutSessionId}`);
}

async function probe() {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const tokens = readJson("tokens.json"); const owners = readJson("owner-keys.json");
  const connect = async (token) => { const c = new Client({ name: "scenario-i-probe", version: "1.0.0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${SERVER}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } })); return c; };
  const call = async (c, name, args) => { const r = await c.callTool({ name, arguments: args });
    const text = r.content?.[0]?.text ?? ""; if (r.isError) { try { return { error: JSON.parse(text).error }; } catch { return { error: { code: "PROTOCOL", message: text } }; } } return { data: r.structuredContent }; };
  const out = { generatedAt: new Date().toISOString(), note: "Direct to the server on loopback, not through a host and not through the audit proxy.", probes: {} };

  // 1. No token → 401.
  const un = await fetch(`${SERVER}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  out.probes.unauthenticated = { expected: 401, observed: un.status, pass: un.status === 401 };

  // 2. Cross-host: each host's token asks for the NEXT host's checkout → NOT_FOUND, and cannot cancel it either.
  out.probes.crossHost = [];
  for (let i = 0; i < HOSTS.length; i++) {
    const asker = HOSTS[i], owner = HOSTS[(i + 1) % HOSTS.length]; const target = preparedCheckout(owner)?.checkoutSessionId;
    if (!target) { out.probes.crossHost.push({ asker, owner, skipped: "owner host has no prepared checkout" }); continue; }
    const c = await connect(tokens[asker]);
    const st = await call(c, "get_checkout_status", { checkoutSessionId: target }); const rc = await call(c, "get_purchase_receipt", { checkoutSessionId: target });
    await c.close();
    const cancel = await fetch(`${SERVER}/owner/checkouts/${target}/cancel`, { method: "POST", headers: { "X-Owner-Key": owners[asker] } });
    out.probes.crossHost.push({ asker, owner, status: st.error?.code ?? "RETURNED_DATA", receipt: rc.error?.code ?? "RETURNED_DATA", ownerCancelHttp: cancel.status,
      pass: st.error?.code === "NOT_FOUND" && rc.error?.code === "NOT_FOUND" && cancel.status === 404 });
  }

  // 3. Repeat prepare after COMPLETED (DF-2): same checkout, deduplicated, no new provider order.
  const cc = preparedCheckout("claude-code");
  if (cc?.checkoutSessionId) {
    const wire = jsonl(readFileSync(`${DIR}/audit.jsonl`, "utf8"));
    const args = wire.filter((r) => r.host === "claude-code").flatMap((r) => r.requests).find((q) => q.tool === "prepare_checkout")?.arguments;
    const c = await connect(tokens["claude-code"]); const again = await call(c, "prepare_checkout", args); await c.close();
    out.probes.repeatPrepareAfterCompleted = { checkoutSessionId: cc.checkoutSessionId, observed: { state: again.data?.state, checkoutSessionId: again.data?.checkoutSessionId, deduplicated: again.data?.deduplicated, error: again.error ?? null },
      pass: again.data?.checkoutSessionId === cc.checkoutSessionId && again.data?.deduplicated === true && again.data?.state === "COMPLETED" };
  } else out.probes.repeatPrepareAfterCompleted = { skipped: "claude-code has no prepared checkout" };

  // 4. Over the human's limit: a $60 owner mandate, then a $6,000 offer → HOLD AMOUNT_EXCEEDED, no provider order.
  const m = await fetch(`${SERVER}/owner/mandates`, { method: "POST", headers: { "Content-Type": "application/json", "X-Owner-Key": owners.probe },
    body: JSON.stringify({ productIdentity: { brand: "Sony", model: "WH-CH720N", variant: "Black", condition: "new", sku: "WHCH720N/B" }, currency: "USD", maximumTotalMinor: 6000, autoUse: true }) });
  const mandate = await m.json();
  const c = await connect(tokens.probe);
  const r = await call(c, "research_purchase", { ...RESEARCH_ARGS, budgetMinor: 1_000_000 });
  const cmp = await call(c, "compare_purchase_offers", { researchSessionId: r.data.purchaseSessionId, productIdentity: r.data.identity.lockedIdentity, destination: DESTINATION });
  const big = cmp.data.eligibleOffers.find((o) => o.cost?.totalMinor >= 600000);
  const prep = big ? await call(c, "prepare_checkout", { purchaseSessionId: r.data.purchaseSessionId, offerId: big.offerId, maximumApprovedTotalMinor: 600000, currency: "USD", quantity: 1 }) : { error: { code: "NO_LARGE_OFFER" } };
  await c.close();
  const db = new DatabaseSync(`${DIR}/diaporia.sqlite`, { readOnly: true });
  const providerOrders = prep.data?.checkoutSessionId ? db.prepare("select count(*) n from audit_events where subject_id = ? and type = 'PROVIDER_ORDER_CREATED'").get(prep.data.checkoutSessionId).n : null;
  const reserved = db.prepare("select reserved_minor from mandates where id = ?").get(mandate.mandateId)?.reserved_minor ?? null;
  db.close();
  await fetch(`${SERVER}/owner/mandates/${mandate.mandateId}/revoke`, { method: "POST", headers: { "X-Owner-Key": owners.probe } });
  out.probes.overMandate = { mandateHttp: m.status, offerId: big?.offerId ?? null, offerTotalMinor: big?.cost?.totalMinor ?? null,
    observed: { state: prep.data?.state, policyCode: prep.data?.policy?.code, approvalUrl: prep.data?.approvalUrl ?? null, providerOrdersCreated: providerOrders, mandateReservedMinor: reserved },
    pass: m.status === 201 && prep.data?.state === "HOLD" && prep.data?.policy?.code === "AMOUNT_EXCEEDED" && !prep.data?.approvalUrl && providerOrders === 0 && reserved === 0 };

  out.pass = [out.probes.unauthenticated, ...out.probes.crossHost, out.probes.repeatPrepareAfterCompleted, out.probes.overMandate].every((p) => p.pass === true);
  writeFileSync(`${DIR}/probes.json`, JSON.stringify(out, null, 2) + "\n");
  console.log(JSON.stringify({ pass: out.pass, unauthenticated: out.probes.unauthenticated.pass, crossHost: out.probes.crossHost.map((p) => p.pass ?? p.skipped),
    repeatPrepareAfterCompleted: out.probes.repeatPrepareAfterCompleted.pass ?? out.probes.repeatPrepareAfterCompleted.skipped, overMandate: out.probes.overMandate.pass }, null, 1));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [cmd, a1] = process.argv.slice(2);
  if (cmd === "setup") setup(process.argv.includes("--force"));
  else if (cmd === "serve") serve();
  else if (cmd === "links") links();
  else if (cmd === "phase2") phase2(a1);
  else if (cmd === "probe") await probe();
  else { console.error("usage: scenario-i.mjs setup [--force] | serve | links | phase2 <host> | probe"); process.exit(1); }
}
