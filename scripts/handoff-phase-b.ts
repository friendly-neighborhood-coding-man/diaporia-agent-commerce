/**
 * Phase B — KERNEL Live View same-session popup check. LIVE and BILLED. Not run by CI or tests.
 *
 *   npx tsx scripts/handoff-phase-b.ts --preflight  --key-file <path/.env.local>   # free: auth check + no running browsers
 *   npx tsx scripts/handoff-phase-b.ts --confirm-live --key-file <path/.env.local> # one headful browser, hard 10 min
 *
 * Only the KERNEL_API_KEY line is read from the key file (no other secrets enter this process). The key is never
 * printed, logged or written.
 *
 * Billing controls (KERNEL's timeout_seconds is an IDLE timeout and spending caps do not stop running browsers, so
 * the hard limit is enforced here):
 *   1. exactly one browser (driver cap 1, refuses if any browser is already running on the account)
 *   2. hard wall-clock limit (default 10 min) → DELETE, also on error / Ctrl+C / SIGTERM
 *   3. a detached watchdog process DELETEs the same browser at limit + 30 s even if this process dies
 *   4. idle timeout 120 s, so a dropped viewer cannot keep it alive long after everything else failed
 *   5. after DELETE, GET verifies the browser is gone; the run fails loudly if not
 *
 * Test content is fully synthetic (no network target, no payment page): a data: page whose button opens a POPUP WINDOW
 * via window.open(…, "popup,width=…") — the mechanism merchant PayPal buttons use — and writes a small form into it.
 * Interaction in the popup is verified OBJECTIVELY by a read-only observation of the popup's DOM afterwards.
 * The Live View is shown on a 127.0.0.1-only page with a random path. No tunnel.
 */
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import type { AddressInfo } from "node:net";
import { KernelDriver, type KernelSession } from "../src/handoff/drivers.js";

const arg = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const preflightOnly = process.argv.includes("--preflight");
const live = process.argv.includes("--confirm-live");
const LIMIT_MS = Math.min(10, Number(arg("--minutes") ?? 10)) * 60_000;
if (!preflightOnly && !live) { console.error("Pass --preflight (free) or --confirm-live (billed)."); process.exit(2); }

function loadKey(): string {
  if (process.env.KERNEL_API_KEY) return process.env.KERNEL_API_KEY;
  const file = arg("--key-file");
  if (!file) throw new Error("No KERNEL_API_KEY in env and no --key-file");
  const line = readFileSync(file, "utf8").split(/\r?\n/).find((l) => /^\s*KERNEL_API_KEY\s*=/.test(l));
  const v = line?.replace(/^\s*KERNEL_API_KEY\s*=\s*/, "").trim().replace(/^(['"])(.*)\1$/, "$2") ?? "";
  if (!v) throw new Error("KERNEL_API_KEY not found in key file");
  return v;
}

const key = loadKey();
const driver = new KernelDriver(key, { allowLive: true, maxSessions: 1 });

// ---------------------------------------------------------------- preflight (free: no browser is created)
const list = await driver.api("GET", "/browsers", undefined, 15_000).catch((e: Error) => { console.error(`[preflight] FAIL: ${e.message}`); process.exit(3); });
const running = Array.isArray(list) ? list.filter((b: any) => !b?.deleted_at) : Array.isArray(list?.data) ? list.data.filter((b: any) => !b?.deleted_at) : null;
console.log(`[preflight] key loaded (length ${key.length}, not printed); KERNEL auth OK; running browsers on account: ${running === null ? "unknown shape" : running.length}`);
if (running === null || running.length > 0) { console.error("[preflight] FAIL: cannot confirm zero running browsers; refusing to start a billed session."); process.exit(3); }
console.log(`[preflight] PASS. Plan: 1 headful non-GPU browser, hard limit ${LIMIT_MS / 60_000} min (≈ $${((LIMIT_MS / 1000) * 0.0001333336).toFixed(3)} at the published headful rate), watchdog + idle timeout 120 s.`);
if (preflightOnly) process.exit(0);

// ---------------------------------------------------------------- live run
const POPUP_PAGE = "data:text/html," + encodeURIComponent(`<!doctype html><title>DIAPORIA Phase B popup test</title>
<h1>DIAPORIA Phase B — synthetic popup test</h1><p>No payment. Press the button.</p>
<button id="open" onclick="var w=window.open('', 'phaseb_popup', 'popup,width=480,height=560'); if(!w){document.getElementById('s').textContent='POPUP BLOCKED';return;}
w.document.write('<title>Synthetic popup</title><h2>Synthetic popup (like a PayPal window)</h2><p>Click the button and type anything.</p><button id=b onclick=&quot;this.textContent=\\'CLICKED\\';document.body.style.background=\\'#cfc\\'&quot;>Click me</button><p><input id=t placeholder=type-here></p>'); w.document.close(); document.getElementById('s').textContent='popup opened';">Open popup window</button>
<p id="s"></p>`);

let session: KernelSession | null = null;
let sessionId: string | null = null;
let cleaned = false;
const evidence: Record<string, unknown> = { phase: "B", kind: "KERNEL_LIVE_VIEW_SAME_SESSION_POPUP", startedAt: new Date().toISOString() };
const started = Date.now();

async function cleanup(reason: string) {
  if (cleaned) return; cleaned = true;
  if (session) await session.close();
  let gone: boolean | null = null;
  if (sessionId) {
    const r = await driver.api("GET", `/browsers/${encodeURIComponent(sessionId)}`, undefined, 15_000).then((b: any) => !!b?.deleted_at, (e: Error) => /HTTP 404|HTTP 410/.test(e.message) ? true : null);
    gone = r;
  }
  evidence.cleanup = { reason, deleteSent: !!session, verifiedGone: gone, browserSeconds: Math.ceil((Date.now() - started) / 1000) };
  console.log(`[phase-b] cleanup (${reason}): DELETE sent=${!!session}, verified gone=${gone}`);
}
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { void cleanup(sig).finally(() => process.exit(130)); });

try {
  session = await driver.open({ label: "diaporia-phase-b", merchantHost: "phase-b.invalid", allowedHosts: null, timeoutSeconds: 120 });
  sessionId = session.sessionIdForCleanupOnly();
  // Detached watchdog: deletes the same browser at limit + 30 s even if this process is killed. Key passed via env only.
  const wd = spawn(process.execPath, ["-e", `setTimeout(async()=>{try{await fetch("https://api.onkernel.com/browsers/"+encodeURIComponent(process.env.WD_ID),{method:"DELETE",headers:{Authorization:"Bearer "+process.env.WD_KEY}})}catch{}process.exit(0)},${LIMIT_MS + 30_000})`],
    { detached: true, stdio: "ignore", env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", WD_ID: sessionId, WD_KEY: key } });
  wd.unref();
  const hardStop = setTimeout(() => { console.log("[phase-b] hard time limit reached"); void cleanup("HARD_LIMIT").finally(() => process.exit(4)); }, LIMIT_MS);
  hardStop.unref();

  await session.run(`await page.goto(${JSON.stringify(POPUP_PAGE)}); return true;`, { timeoutSec: 30 });
  session.pauseForHuman();
  const view = session.humanView();
  const origin = view.frameOrigins[0] ?? "";
  const events: Array<{ type: string; reason: string | null; at: string }> = [];
  const human = { popupVisible: false, popupInteractive: false };
  let done!: () => void; const finished = new Promise<void>((r) => { done = r; });
  const path = `/${randomBytes(18).toString("base64url")}`;
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store"); res.setHeader("Referrer-Policy", "no-referrer");
    if (req.url === path && req.method === "GET") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Content-Security-Policy", `default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-src ${origin}; form-action 'self'; frame-ancestors 'none'`);
      return res.end(`<!doctype html><title>Phase B</title><body style="font:15px system-ui;max-width:1280px;margin:1rem auto">
        <p><b>Inside the browser below:</b> press <i>Open popup window</i>. In the popup, press <i>Click me</i> and type a word. Then tick what you saw and press Done.
        Hard stop ${new Date(started + LIMIT_MS).toLocaleTimeString()}.</p>
        <iframe src="${view.secretUrl!.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}" referrerpolicy="origin" allow="clipboard-read; clipboard-write" style="width:100%;aspect-ratio:16/10;border:1px solid #ccc"></iframe>
        <form method="post" action="${path}/done"><label><input type="checkbox" name="v" value="1"> I saw the popup window in the live view</label><br>
        <label><input type="checkbox" name="i" value="1"> I could click and type inside the popup</label><p><button>Done</button></p></form>
        <script>addEventListener("message",function(e){if(e.origin!==${JSON.stringify(origin)})return;var t=e.data&&e.data.type;if(!t)return;
          fetch(${JSON.stringify(path + "/event")},{method:"POST",body:JSON.stringify({type:String(t),reason:e.data.reason||null})});});</script></body>`);
    }
    if (req.url === `${path}/event` && req.method === "POST") {
      let b = ""; for await (const c of req) b += c;
      try { const j = JSON.parse(b); events.push({ type: String(j.type).slice(0, 40), reason: j.reason ? String(j.reason).slice(0, 40) : null, at: new Date().toISOString() }); } catch { /* ignore */ }
      res.statusCode = 204; return res.end();
    }
    if (req.url === `${path}/done` && req.method === "POST") {
      let b = ""; for await (const c of req) b += c; const f = new URLSearchParams(b);
      human.popupVisible = f.get("v") === "1"; human.popupInteractive = f.get("i") === "1";
      res.end("Recorded. You can close this tab."); done(); return;
    }
    res.statusCode = 404; res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  console.log(`[phase-b] Open this LOCAL link (127.0.0.1 only, one-time path, do not share):\n  http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`);
  await Promise.race([finished, new Promise((r) => setTimeout(r, LIMIT_MS - 60_000))]);
  server.close();

  session.beginObservation();
  const obs = await session.run<{ pages: Array<{ kind: string; title: string; buttonText: string | null; typedChars: number | null }> }>(`const out = [];
for (const p of context.pages()) {
  let kind = "other"; try { const u = new URL(p.url()); kind = u.protocol === "data:" ? "test-page" : u.href === "about:blank" ? "about:blank" : u.protocol; } catch {}
  let title = "", buttonText = null, typedChars = null;
  try { title = (await p.title()).slice(0, 80); } catch {}
  try { const r = await p.evaluate(() => { const b = document.getElementById("b"); const t = document.getElementById("t"); return { b: b ? b.textContent : null, t: t ? t.value.length : null }; }); buttonText = r.b; typedChars = r.t; } catch {}
  out.push({ kind, title, buttonText, typedChars });
}
return { pages: out };`, { timeoutSec: 20 }).catch((e: Error) => ({ pages: [], error: e.message.slice(0, 120) } as any));
  const popup = obs.pages.find((p: { title: string; buttonText: string | null; typedChars: number | null }) => p.title === "Synthetic popup");
  Object.assign(evidence, {
    browser: { headless: false, gpu: false, kiosk: false, telemetry: "disabled", replays: "never started", stealth: false },
    liveViewEvents: events.map((e) => ({ type: e.type, reason: e.reason, at: e.at })), human,
    observedPages: obs.pages, popupWindowExistsInSameSession: !!popup,
    popupClickedByHuman: popup?.buttonText === "CLICKED", popupTypedByHuman: (popup?.typedChars ?? 0) > 0,
    payment: "NONE — synthetic page only; no PayPal, merchant, order or credential",
  });
} catch (e) {
  evidence.error = (e instanceof Error ? e.message : String(e)).replace(/jwt=[^\s&"']+/gi, "jwt=[REDACTED]").slice(0, 200);
  console.error(`[phase-b] error: ${evidence.error}`);
} finally {
  await cleanup("END");
  mkdirSync("docs/evidence", { recursive: true });
  const file = `docs/evidence/handoff-phase-b-${String(evidence.startedAt).replace(/[:.]/g, "-")}.json`;
  writeFileSync(file, JSON.stringify(evidence, null, 2));
  console.log(`[phase-b] evidence → ${file}`);
  console.log(JSON.stringify({ popupWindowExistsInSameSession: evidence.popupWindowExistsInSameSession, popupClickedByHuman: evidence.popupClickedByHuman,
    popupTypedByHuman: evidence.popupTypedByHuman, human: evidence.human, liveViewEvents: (evidence.liveViewEvents as any[] | undefined)?.map((x) => x.type), cleanup: evidence.cleanup }));
  process.exit(evidence.error ? 1 : 0);
}
