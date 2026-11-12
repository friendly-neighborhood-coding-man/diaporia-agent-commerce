/**
 * V2.2 WP-2 (H-2) end-to-end with REAL OS principals. Run as root on a DISPOSABLE Linux machine or container only: it
 * creates an OS account and installs into /opt, /var/lib and /etc.
 *
 *   npx tsx scripts/service-isolation-e2e.ts <outFile> [--ai-user aihost]
 *
 * Principals:
 *   - the human owner = root (holds the passkey private key, writes the owner registry, runs the setup script);
 *   - the AI host = <ai-user>, an ordinary non-root account (as the person's own account would be);
 *   - Scenario A, the earlier documented setup: the server runs as the AI host's account from a checkout it owns;
 *   - Scenario B, the V2.2 setup: scripts/setup-service-account.sh installs the service under its own account.
 * In both scenarios the agent repeats the independent reviewer's attack (write an owner-confirmed resolution into the
 * SQLite database, or delete the open requirement) and every other route the task lists, then tries to prepare checkout.
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const out = resolve(process.argv[2] ?? "service-isolation-e2e.txt");
const AI_USER = process.argv.includes("--ai-user") ? process.argv[process.argv.indexOf("--ai-user") + 1]! : "aihost";
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lines: string[] = []; const log = (s: string) => { lines.push(s); writeFileSync(out, lines.join("\n") + "\n"); };
const red = (s: string) => s.replace(/(dct|dok)_[A-Za-z0-9_-]+/g, "$1_<redacted>");
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest();
if (process.getuid?.() !== 0) { console.error("run as root on a disposable machine"); process.exit(2); }

const sh = (cmd: string, args: string[], o: { input?: string } = {}) => { try { return execFileSync(cmd, args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], ...(o.input ? { input: o.input } : {}) }).trim(); } catch (e: any) { return `ERR ${e.status}: ${String(e.stderr ?? "").trim().split("\n").slice(-2).join(" | ")}`; } };
if (sh("id", ["-u", AI_USER]).startsWith("ERR")) sh("useradd", ["--create-home", "--shell", "/bin/bash", AI_USER]);
const AI_UID = Number(sh("id", ["-u", AI_USER])); const AI_GID = Number(sh("id", ["-g", AI_USER]));
const AI_HOME = sh("getent", ["passwd", AI_USER]).split(":")[5]!;
/** Runs a shell command as the AI host (its own uid and group, no supplementary groups). */
const asAgent = (cmd: string) => sh("setpriv", [`--reuid=${AI_UID}`, `--regid=${AI_GID}`, "--clear-groups", "--", "sh", "-c", cmd]);
const tsx = join(REPO, "node_modules/tsx/dist/esm/index.mjs");
/** A small Node program run as the agent: the reviewer's database forgery (and the simpler deletion of open items). */
const FORGE = String.raw`
const { DatabaseSync } = require("node:sqlite");
const [file, ps, mode] = process.argv.slice(2);
try {
  const db = new DatabaseSync(file);
  const row = db.prepare("SELECT research_json FROM purchase_sessions WHERE id = ?").get(ps);
  const research = JSON.parse(row.research_json); const gate = research.purchaseGate;
  const keys = [...new Set(Object.values(gate.products).flatMap((p) => p.requirements.map((q) => q.key)))];
  if (mode === "forge") for (const k of keys) gate.resolutions.push({ kind: "DROP_REQUIREMENT", requirement: k, budgetMinor: null, currency: "USD", actor: "OWNER_SESSION:forged", confirmation: "CONFIRMED_BY_OWNER",
    proposalId: "rhp_forged", proposalDigest: "", agentText: "", humanVerification: "WEBAUTHN_USER_VERIFIED", credentialFingerprint: "forged", at: new Date().toISOString() });
  else for (const p of Object.values(gate.products)) p.requirements = [];
  db.prepare("UPDATE purchase_sessions SET research_json = ? WHERE id = ?").run(JSON.stringify(research), ps); db.close();
  console.log("WROTE " + mode + " " + JSON.stringify(keys));
} catch (e) { console.log("REFUSED " + (e.code ?? "") + " " + String(e.message).split("\n")[0]); }`;

// ---------------------------------------------------------------- the human owner's passkey and registry (root)
const kp = generateKeyPairSync("ec", { namedCurve: "P-256" });
const credentialId = randomBytes(16).toString("base64url");
const ownerKey = `dok_${randomBytes(24).toString("base64url")}`;
const registry = (path: string) => { mkdirSync(dirname(path), { recursive: true, mode: 0o755 }); chmodSync(dirname(path), 0o755);
  writeFileSync(path, JSON.stringify({ schema: "diaporia.owner-registry.v1", owners: [{ userId: "demo-user", ownerKeySha256: [sha(ownerKey).toString("hex")],
    authenticators: [{ credentialId, publicKeySpki: kp.publicKey.export({ format: "der", type: "spki" }).toString("base64"), alg: -7 }] }] }), { mode: 0o644 }); };

async function startServer(cmd: string, args: string[], env: Record<string, string>, cwd: string) {
  const srv = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let text = ""; srv.stdout!.on("data", (d) => (text += d)); srv.stderr!.on("data", (d) => (text += d));
  for (let i = 0; i < 200 && !/MCP endpoint|Error|error:/.test(text); i++) await new Promise((r) => setTimeout(r, 200));
  return { srv, log: () => red(text).replace(/\(node:\d+\) ExperimentalWarning.*\n|\(Use `node --trace-warnings.*\n/g, "") };
}
async function agentClient(url: string, token: string) {
  const client = new Client({ name: "agent", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  const call = async (name: string, args: any) => { const r = await client.callTool({ name, arguments: args }); if (r.isError) { const t = (r.content as any)[0].text as string; let code = "ERROR"; try { code = JSON.parse(t).error.code; } catch { /* text */ } return { error: code, text: t.slice(0, 220) }; } return r.structuredContent as any; };
  return { client, call };
}
const LUMEN = { brand: "Sony", model: "WH-CH720N", variant: "Black", condition: "new", sku: "WHCH720N/B" };
const REQUEST = "Buy Sony WH-CH720N Black for the lowest total price, never exceed $100, it must have a lanyard loop.";
async function attack(label: string, url: string, token: string, dbFile: string) {
  const { client, call } = await agentClient(url, token);
  const r = await call("research_purchase", { request: REQUEST, currency: "USD" });
  const cmp = () => call("compare_purchase_offers", { researchSessionId: r.purchaseSessionId, productIdentity: LUMEN, destination: { country: "US", region: "CA" } });
  const prep = async () => { const c = await cmp(); const o = c.lowestVerifiedEligibleOffer ?? c.eligibleOffers?.[0] ?? c.ineligibleOffers?.[0];
    const p = await call("prepare_checkout", { purchaseSessionId: r.purchaseSessionId, offerId: o?.offerId ?? "none", maximumApprovedTotalMinor: 10_000_000, currency: "USD", quantity: 1 });
    return p.error ? `REFUSED ${p.error} (compare state ${c.state}; ${p.text.replace(/^.*"message":"([^"]*)".*$/s, "$1").slice(0, 120)})` : `PREPARED ${p.checkoutPath ?? p.state} (total ${o?.verifiedTotal?.totalMinor ?? o?.totalMinor ?? "?"})`; };
  log(`[${label}] agent: compare before: open ${JSON.stringify((await cmp()).purchaseReadiness?.open)}`);
  log(`[${label}] agent: prepare_checkout before: ${await prep()}`);
  writeFileSync("/tmp/diaporia-forge.cjs", FORGE); chmodSync("/tmp/diaporia-forge.cjs", 0o644);
  for (const mode of ["forge", "delete"]) {
    log(`[${label}] agent: ${mode === "forge" ? "append an owner-confirmed resolution (reviewer's attack)" : "delete the open requirements from the gate"} in ${dbFile}: ${red(asAgent(`${process.execPath} /tmp/diaporia-forge.cjs ${dbFile} ${r.purchaseSessionId} ${mode} 2>&1`))}`);
    const c = await cmp();
    log(`[${label}] agent: compare after: open ${JSON.stringify(c.purchaseReadiness?.open)} ready ${c.purchaseReadiness?.ready}`);
    log(`[${label}] agent: prepare_checkout after: ${await prep()}`);
  }
  return { client, call, ps: r.purchaseSessionId, cmp, prep };
}

const results: string[] = [];
try {
  // ================================================================ Scenario A: the earlier documented setup
  log(`# Scenario A: server and AI host share the OS account ${AI_USER} (uid ${AI_UID}), checkout owned by that account`);
  const A = join(AI_HOME, "diaporia-checkout"); rmSync(A, { recursive: true, force: true }); mkdirSync(A, { recursive: true });
  for (const f of ["src", "package.json", "tsconfig.json"]) cpSync(join(REPO, f), join(A, f), { recursive: true });
  symlinkSync(join(REPO, "node_modules"), join(A, "node_modules"));
  sh("chown", ["-R", `${AI_UID}:${AI_GID}`, A]);
  const regA = "/etc/diaporia-e2e-a/owners.json"; registry(regA);
  const portA = 18100 + Math.floor(Math.random() * 400); const urlA = `http://localhost:${portA}`; const tokenA = `dct_${randomBytes(24).toString("base64url")}`;
  const envA = { PATH: "/usr/bin:/bin", HOME: AI_HOME, HOST: "127.0.0.1", PORT: String(portA), PUBLIC_BASE_URL: urlA, DIAPORIA_DB_PATH: join(A, ".data/diaporia.sqlite"),
    DIAPORIA_OWNER_REGISTRY: regA, DIAPORIA_AI_HOST_UIDS: String(AI_UID), DIAPORIA_DEV_TOKENS: `${tokenA}=demo-user` };
  const sa = await startServer("setpriv", [`--reuid=${AI_UID}`, `--regid=${AI_GID}`, "--clear-groups", "--", process.execPath, "--import", `file://${tsx}`, join(A, "src/main.ts")], envA, A);
  log(`[A] server log:\n${sa.log()}`);
  const a = await attack("A", urlA, tokenA, join(A, ".data/diaporia.sqlite"));
  log(`[A] agent: edit the server code -> ${asAgent(`echo '// agent edit' >> ${A}/src/engine/PurchaseGate.ts && echo WROTE`)}`);
  results.push(`A: isolation ${/service isolation NOT established/.test(sa.log()) ? "NOT established (expected)" : "established (UNEXPECTED)"}; agent DB write ${lines.some((l) => l.startsWith("[A] agent: append") && /WROTE/.test(l)) ? "succeeded (same account)" : "refused"}; prepare after forgery/deletion: ${lines.filter((l) => l.startsWith("[A] agent: prepare_checkout after")).map((l) => /REFUSED (\w+)/.exec(l)?.[1] ?? "PREPARED").join(", ")}`);
  await a.client.close(); sa.srv.kill("SIGKILL"); sh("pkill", ["-9", "-u", String(AI_UID), "-f", "src/main.ts"]);
  rmSync("/etc/diaporia-e2e-a", { recursive: true, force: true });

  // ================================================================ Scenario B: the V2.2 setup
  log(`\n# Scenario B: scripts/setup-service-account.sh --ai-user ${AI_USER}; the service runs as its own account`);
  const portB = 18600 + Math.floor(Math.random() * 300); const urlB = `http://localhost:${portB}`;
  log(`[B] setup: ${red(sh("bash", [join(REPO, "scripts/setup-service-account.sh"), "--ai-user", AI_USER, "--port", String(portB)]))}`);
  registry("/etc/diaporia/owners.json");
  const sb = await startServer("/opt/diaporia/bin/diaporia-server", [], { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }, "/");
  log(`[B] server log:\n${sb.log()}`);
  const SVC_UID = Number(sh("id", ["-u", "diaporia"]));
  const pid = sh("pgrep", ["-u", String(SVC_UID), "-f", "src/main.ts"]).split("\n")[0]!;
  const token = asAgent(`cat ${AI_HOME}/.config/diaporia/client-token`);
  log(`[B] agent: reads its own client token from ~/.config/diaporia/client-token: ${/^dct_/.test(token) ? "yes" : token}`);
  const db = "/var/lib/diaporia/diaporia.sqlite";
  const b = await attack("B", urlB, token, db);
  log(`[B] agent: list the data directory -> ${asAgent("ls /var/lib/diaporia 2>&1 | head -3")}`);
  log(`[B] agent: read the database -> ${asAgent(`head -c 16 ${db} >/dev/null && echo READ`)}`);
  log(`[B] agent: replace the database -> ${asAgent(`cp /etc/hostname ${db}.new && mv ${db}.new ${db} && echo REPLACED`)}`);
  log(`[B] agent: replace the WAL file -> ${asAgent(`cp /etc/hostname ${db}-wal && echo REPLACED`)}`);
  log(`[B] agent: move the data directory away -> ${asAgent("mv /var/lib/diaporia /var/lib/diaporia.x && echo MOVED")}`);
  log(`[B] agent: edit the server code -> ${asAgent("echo '// agent edit' >> /opt/diaporia/app/src/engine/PurchaseGate.ts && echo WROTE")}`);
  log(`[B] agent: replace the code folder -> ${asAgent("mv /opt/diaporia/app /opt/diaporia/app.x && echo MOVED")}`);
  log(`[B] agent: edit node_modules -> ${asAgent("echo x >> /opt/diaporia/app/node_modules/tsx/package.json && echo WROTE")}`);
  log(`[B] agent: edit the launcher -> ${asAgent("echo x >> /opt/diaporia/bin/diaporia-server && echo WROTE")}`);
  log(`[B] agent: read the server configuration (/etc/diaporia/server.env) -> ${red(asAgent("cat /etc/diaporia/server.env | head -2"))}`);
  log(`[B] agent: edit the server configuration -> ${asAgent("echo DIAPORIA_AI_HOST_UIDS= >> /etc/diaporia/server.env && echo WROTE")}`);
  log(`[B] agent: write the owner registry -> ${asAgent("echo x >> /etc/diaporia/owners.json && echo WROTE")}`);
  const regText = asAgent("cat /etc/diaporia/owners.json");
  log(`[B] agent: reads the registry: ${regText.startsWith("{")}; contains the owner key: ${regText.includes(ownerKey)}; contains a private key: ${/PRIVATE/.test(regText)}`);
  log(`[B] agent: read the server's environment (/proc/${pid}/environ) -> ${red(asAgent(`tr '\\0' '\\n' < /proc/${pid}/environ | head -2`))}`);
  log(`[B] agent: signal the server process -> ${asAgent(`kill -STOP ${pid} && echo STOPPED`)}`);
  log(`[B] agent: attach a debugger to the server (/proc/${pid}/mem) -> ${asAgent(`head -c 1 /proc/${pid}/mem >/dev/null && echo READ`)}`);
  log(`[B] agent: owner key anywhere it can read under /var/lib, /opt/diaporia, /etc/diaporia, its home: ${(() => { const g = asAgent(`grep -rl ${ownerKey.slice(0, 20)} /var/lib/diaporia /opt/diaporia /etc/diaporia ${AI_HOME} 2>/dev/null; echo done`); return g === "done" ? "no" : red(g); })()}`);
  // Endpoints: the owner pages without the owner key and passkey.
  const pr = await b.call("resolve_research_hold", { purchaseSessionId: b.ps, kind: "DROP_REQUIREMENT", requirement: "must:unrecognized:lanyard-loop", currency: "USD", userStatement: "agent text: the user said drop it" });
  const post = (body: Record<string, string>, cookie = "") => fetch(pr.ownerConfirmationUrl, { method: "POST", redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: urlB, "Sec-Fetch-Site": "same-origin", ...(cookie ? { Cookie: cookie } : {}) }, body: new URLSearchParams(body).toString() });
  for (const [k, v] of [["no key", ""], ["its client token", token], ["registry text", regText.slice(0, 60)]] as const) log(`[B] agent: owner review with ${k} -> HTTP ${(await post({ action: "review", ownerKey: v })).status}`);
  log(`[B] agent: confirm without a review session -> HTTP ${(await post({ action: "confirm", acknowledge: "yes" })).status}`);
  log(`[B] agent: compare after its endpoint attempts: open ${JSON.stringify((await b.cmp()).purchaseReadiness?.open)}`);
  // Second layer: even a principal that COULD write the database (root here, standing in for a broken boundary) cannot
  // make a forged owner resolution count, because the gate re-verifies each stored passkey assertion.
  const rootForge = sh(process.execPath, ["/tmp/diaporia-forge.cjs", db, b.ps, "forge"]);
  log(`[B] root (simulating a principal with database access) appends the reviewer's forged resolution: ${rootForge}`);
  log(`[B] compare after the root-written forgery: open ${JSON.stringify((await b.cmp()).purchaseReadiness?.open)}`);
  log(`[B] prepare_checkout after the root-written forgery: ${await b.prep()}`);
  // The human owner (root, with the passkey) confirms on the owner page: the legitimate path still works.
  const rv = await post({ action: "review", ownerKey }); const html = await rv.text();
  const cookie = (rv.headers.get("set-cookie") ?? "").split(";")[0]!; const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
  const step = /data-challenge="([^"]+)" data-rpid="([^"]+)"/.exec(html);
  log(`[B] human: review -> HTTP ${rv.status}; passkey challenge ${step ? `for rpId ${step[2]}` : "missing"}`);
  if (step) {
    const cdj = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: step[1], origin: urlB }));
    const ad = Buffer.alloc(37); sha(step[2]!).copy(ad, 0); ad[32] = 0x05; ad.writeUInt32BE(1, 33);
    const sig = sign("sha256", Buffer.concat([ad, sha(cdj)]), kp.privateKey);
    const cf = await post({ action: "confirm", csrf, acknowledge: "yes", credentialId, clientDataJSON: cdj.toString("base64url"), authenticatorData: ad.toString("base64url"), signature: sig.toString("base64url") }, cookie);
    log(`[B] human: confirm with passkey (UV) -> HTTP ${cf.status}`);
    log(`[B] compare after the human confirmed: open ${JSON.stringify((await b.cmp()).purchaseReadiness?.open)}`);
    log(`[B] prepare_checkout after the human confirmed (positive control): ${await b.prep()}`);
  }
  const audit = sh(process.execPath, ["-e", `const {DatabaseSync}=require("node:sqlite");console.log(new DatabaseSync("${db}").prepare("SELECT type FROM audit_events WHERE subject_id = ? ORDER BY seq").all("${b.ps}").map(r=>r.type).join(","))`]);
  log(`[B] audit trail: ${audit}`);
  results.push(`B: isolation ${/service isolation: established/.test(sb.log()) ? "established" : "NOT established (UNEXPECTED)"}; agent DB/WAL/code/config writes ${lines.filter((l) => l.startsWith("[B] agent:") && /WROTE|REPLACED|MOVED|STOPPED/.test(l) && !/reads its own/.test(l)).length === 0 ? "all refused" : "SOME SUCCEEDED"}`);
  await b.client.close(); sb.srv.kill("SIGKILL"); sh("pkill", ["-9", "-u", String(SVC_UID), "-f", "src/main.ts"]);
} catch (e) { log(`error: ${e instanceof Error ? e.stack : e}`); }
log(`\n# Summary\n${results.join("\n")}`);
process.exit(0);
