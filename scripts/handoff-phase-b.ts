/**
 * Phase B — KERNEL Live View popup check. LIVE and BILLED (one headful KERNEL browser, hard 10-minute timeout,
 * about $0.08 at the published headful rate). NOT run by CI or tests. Needs explicit owner approval.
 *
 *   KERNEL_API_KEY=... npx tsx scripts/handoff-phase-b.ts --confirm-live
 *
 * What it does (no payment page, no PayPal, no merchant order):
 *   1. Creates ONE headful KERNEL browser: telemetry disabled, no replay, not kiosk (tabs/windows visible).
 *   2. Opens a tiny test page (data: URL) with two buttons: one opens a POPUP WINDOW via window.open(…, "popup,width=…")
 *      — the same mechanism a merchant's PayPal button uses — to https://example.com; one opens a normal new tab.
 *   3. Serves a loopback-only page (127.0.0.1, random one-time path) that embeds the Live View, and records the
 *      KERNEL_CONNECTED / KERNEL_PLAYING / failure events the Live View posts to its parent.
 *   4. The human clicks both buttons INSIDE the Live View, types into the popup's address-free page if possible,
 *      then presses "Done". The script then runs a READ-ONLY observation (list of pages: host + path), deletes
 *      the browser and writes evidence without any URL secrets.
 *
 * Answers the go/no-go question: can a human see and operate a window.open popup in the same KERNEL browser via Live View?
 */
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { KernelDriver } from "../src/handoff/drivers.js";

if (!process.argv.includes("--confirm-live")) { console.error("Refusing: pass --confirm-live (billed KERNEL browser)."); process.exit(2); }
const key = process.env.KERNEL_API_KEY;
if (!key) { console.error("KERNEL_API_KEY is not set."); process.exit(2); }

const TEST_PAGE = "data:text/html," + encodeURIComponent(`<!doctype html><title>DIAPORIA Phase B popup test</title>
<h1>DIAPORIA Phase B popup test</h1><p>No payment. Click each button.</p>
<button id="popup" onclick="window.open('https://example.com/','phaseb_popup','popup,width=480,height=600')">Open POPUP window (like a PayPal button)</button>
<button id="tab" onclick="window.open('https://example.org/','_blank')">Open new TAB</button>`);

const driver = new KernelDriver(key, { allowLive: true, maxSessions: 1 });
const session = await driver.open({ label: "diaporia-phase-b", merchantHost: "example.com", allowedHosts: null, timeoutSeconds: 600 });
const events: Array<{ type: string; reason?: string; at: string }> = [];
let done!: () => void; const finished = new Promise<void>((r) => { done = r; });
const secretPath = `/${randomBytes(18).toString("base64url")}`;
const started = Date.now();
try {
  const nav = await session.run<{ url: string }>(`await page.goto(${JSON.stringify(TEST_PAGE)}); return { url: page.url().slice(0, 30) };`, { timeoutSec: 30 });
  console.log(`[phase-b] test page loaded (${nav.url}…)`);
  session.pauseForHuman();
  const view = session.humanView();
  const origin = view.frameOrigins[0] ?? "";
  const server = createServer(async (req, res) => {
    if (req.url === secretPath && req.method === "GET") {
      res.setHeader("Content-Type", "text/html; charset=utf-8"); res.setHeader("Cache-Control", "no-store"); res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("Content-Security-Policy", `default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-src ${origin}; form-action 'self'`);
      return res.end(`<!doctype html><title>Phase B</title><body style="font:15px system-ui;max-width:1200px;margin:1rem auto">
        <p>Inside the browser below: click <b>Open POPUP window</b>, then <b>Open new TAB</b>. Check the popup is visible and clickable. Then press Done.</p>
        <iframe id="lv" src="${view.secretUrl!.replace(/"/g, "&quot;")}" referrerpolicy="origin" style="width:100%;aspect-ratio:16/10;border:1px solid #ccc"></iframe>
        <form method="post" action="${secretPath}/done"><p><label><input type="checkbox" name="popupVisible" value="1"> I saw the popup window in the live view</label></p>
        <p><label><input type="checkbox" name="popupInteractive" value="1"> I could click/scroll inside the popup</label></p><button>Done</button></form>
        <script>addEventListener("message",(e)=>{ if(e.origin!==${JSON.stringify(origin)}) return; const t=e.data&&e.data.type; if(!t) return;
          fetch(${JSON.stringify(secretPath + "/event")},{method:"POST",body:JSON.stringify({type:t,reason:e.data.reason||null})}); });</script></body>`);
    }
    if (req.url === `${secretPath}/event` && req.method === "POST") { let b = ""; for await (const c of req) b += c; try { const j = JSON.parse(b); events.push({ type: String(j.type).slice(0, 40), ...(j.reason ? { reason: String(j.reason).slice(0, 40) } : {}), at: new Date().toISOString() }); } catch { /* ignore */ } res.statusCode = 204; return res.end(); }
    if (req.url === `${secretPath}/done` && req.method === "POST") {
      let b = ""; for await (const c of req) b += c; const f = new URLSearchParams(b);
      human.popupVisible = f.get("popupVisible") === "1"; human.popupInteractive = f.get("popupInteractive") === "1";
      res.end("Thanks. You can close this tab."); done(); return;
    }
    res.statusCode = 404; res.end();
  });
  const human = { popupVisible: false, popupInteractive: false };
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as import("node:net").AddressInfo).port;
  console.log(`[phase-b] Open this LOCAL link in your browser (loopback only, one-time path; do not share):\n  http://127.0.0.1:${port}${secretPath}`);
  await Promise.race([finished, new Promise((r) => setTimeout(r, 8 * 60_000))]);
  session.beginObservation();
  const obs = await session.run<{ pages: Array<{ host: string; path: string }> }>(`const out=[]; for (const p of context.pages()) { try { const u=new URL(p.url()); out.push({ host:u.host, path:u.pathname.slice(0,80) }); } catch {} } return { pages: out };`, { timeoutSec: 20 }).catch(() => ({ pages: [] }));
  server.close();
  const evidence = {
    phase: "B", kind: "KERNEL_LIVE_VIEW_POPUP_CHECK", at: new Date().toISOString(), browserSeconds: Math.ceil((Date.now() - started) / 1000),
    browser: { headless: false, kiosk: false, telemetry: "disabled", replays: "not started", stealth: false },
    liveViewEvents: events, human, observedPages: obs.pages,
    popupWindowOpened: obs.pages.some((p) => p.host === "example.com"), newTabOpened: obs.pages.some((p) => p.host === "example.org"),
    payment: "NONE (no payment page was opened)",
  };
  mkdirSync("docs/evidence", { recursive: true });
  const file = `docs/evidence/handoff-phase-b-${evidence.at.replace(/[:.]/g, "-")}.json`;
  writeFileSync(file, JSON.stringify(evidence, null, 2));
  console.log(`[phase-b] evidence → ${file}\n${JSON.stringify({ human, popupWindowOpened: evidence.popupWindowOpened, newTabOpened: evidence.newTabOpened, liveViewEvents: events.map((e) => e.type) })}`);
} finally {
  await session.close();
  console.log("[phase-b] KERNEL browser deleted.");
}
