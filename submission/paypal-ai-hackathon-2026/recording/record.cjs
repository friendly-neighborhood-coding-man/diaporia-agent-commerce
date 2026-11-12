// Recording driver: real MCP host (Claude Code TUI in xterm) + real DIAPORIA Buy panel in Chromium on Xvfb :99.
const { chromium } = require('playwright');
const { execSync, spawn } = require('child_process');
const fs = require('fs'), path = require('path');
const R = process.env.R, H = process.env.H, OWN = process.env.OWN, OUT = process.env.OUT;
const t0 = Date.now(); const events = [];
const ev = (name, extra) => { const t = (Date.now() - t0) / 1000; events.push({ t, name, ...(extra || {}) }); console.log(t.toFixed(1), name, extra ? JSON.stringify(extra) : ''); fs.writeFileSync(path.join(OUT, 'events.json'), JSON.stringify(events, null, 1)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmux = (args) => execSync(`tmux -L rec ${args}`);
async function typeTmux(text) { for (const ch of text) { execSync(`tmux -L rec send-keys -t host -l ${JSON.stringify(ch).replace(/\$/g, '\\$')}`); await sleep(22 + Math.random() * 22); } }
function findPanelUrl() {
  const base = path.join(H, '.claude', 'projects');
  if (!fs.existsSync(base)) return null;
  for (const d of fs.readdirSync(base)) for (const f of fs.readdirSync(path.join(base, d))) {
    if (!f.endsWith('.jsonl')) continue; const m = /http:\/\/127\.0\.0\.1:8790\/buy\/#run=br_[0-9a-f-]+&k=dpl_[A-Za-z0-9_-]+/.exec(fs.readFileSync(path.join(base, d, f), 'utf8'));
    if (m) return m[0];
  }
  return null;
}
(async () => {
  fs.mkdirSync(path.join(OUT, 'chrome-profile', 'Default'), { recursive: true });
  fs.writeFileSync(path.join(OUT, 'chrome-profile', 'Default', 'Preferences'), JSON.stringify({ credentials_enable_service: false, profile: { password_manager_enabled: false }, autofill: { profile_enabled: false } }));
  const ctx = await chromium.launchPersistentContext(path.join(OUT, 'chrome-profile'), { headless: false, viewport: null,
    args: ['--window-position=675,0', '--window-size=861,786', `--app=file://${R}/waiting.html`, '--force-device-scale-factor=1.25', '--disable-features=PasswordLeakDetection,AutofillServerCommunication', '--password-store=basic', '--disable-infobars', '--no-first-run', '--hide-scrollbars'],
    ignoreDefaultArgs: ['--enable-automation'] });
  let p = ctx.pages()[0] || await ctx.newPage();
  p.on('pageerror', (e) => ev('PAGEERROR', { m: e.message }));
  const ring = async (loc) => { try { const b = await loc.boundingBox(); if (!b) return; await p.evaluate(({ x, y }) => { const d = document.createElement('div'); d.style.cssText = `position:fixed;left:${x - 22}px;top:${y - 22}px;width:44px;height:44px;border-radius:50%;border:3px solid #f5a524;box-shadow:0 0 0 4px rgba(245,165,36,.25);z-index:99999;pointer-events:none`; document.body.appendChild(d); setTimeout(() => d.remove(), 900); }, { x: b.x + b.width / 2, y: b.y + b.height / 2 }); } catch {} };
  const click = async (loc, pause = 700) => { await loc.scrollIntoViewIfNeeded(); await ring(loc); await sleep(pause); await loc.click(); };
  const wheel = async (dy, steps = 12) => { for (let i = 0; i < steps; i++) { await p.mouse.wheel(0, dy / steps); await sleep(45); } };
  const slowType = async (sel, text) => { const l = p.locator(sel); await ring(l); await l.click(); await l.pressSequentially(text, { delay: 110 }); };
  await p.mouse.move(1000, 500);
  await sleep(2500);
  // Start the screen recording.
  const ff = spawn('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'x11grab', '-draw_mouse', '0', '-framerate', '30', '-video_size', '1920x1080', '-i', ':99', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-pix_fmt', 'yuv420p', path.join(OUT, 'raw.mp4')], { stdio: ['pipe', 'inherit', 'inherit'] });
  await sleep(1500); ev('REC_START');
  await sleep(1500);
  ev('TYPE_PROMPT');
  await typeTmux("I need wireless headphones under $150 with multipoint and a lanyard loop, lowest total price. Research it with DIAPORIA and open the shopping panel.");
  await sleep(600); tmux('send-keys -t host Enter'); ev('PROMPT_SENT');
  let url = null; for (let i = 0; i < 240 && !url; i++) { await sleep(500); url = findPanelUrl(); }
  if (!url) { ev('NO_PANEL_URL'); throw new Error('no panelUrl'); }
  ev('TOOL_RESULT_PANELURL', { run: /run=(br_[0-9a-f-]+)/.exec(url)[1] });
  await sleep(800);
  await p.goto(url); ev('PANEL_OPEN');
  await p.waitForSelector('button:has-text("Details")', { timeout: 180000 }); ev('RESULTS');
  await sleep(5500);
  // Rank #2: unverified candidate
  const details = p.locator('button:has-text("Details")');
  await wheel(380); await sleep(1500);
  await click(details.nth(1)); ev('DETAIL_Q3'); await sleep(2500); await click(p.locator('details.disc summary').first()); await sleep(4000);
  await click(p.locator('button:has-text("← Back")')); await sleep(1500);
  await click(details.nth(0)); ev('DETAIL_A8'); await sleep(2000); await click(p.locator('details.disc summary').first()); await sleep(2500); await click(p.locator('details.disc summary').nth(2)); await sleep(3000);
  await wheel(350); await sleep(2500);
  const sel = p.locator('button:has-text("Select this product")'); await click(sel); ev('SELECT_A8'); await sleep(2500);
  const cmp = p.locator('button:has-text("Compare offers")'); await cmp.scrollIntoViewIfNeeded(); await sleep(1500);
  await click(cmp); ev('COMPARE');
  await p.waitForSelector('button:has-text("Continue to checkout")', { timeout: 120000 }); ev('OFFERS'); await sleep(5000);
  await wheel(420); await sleep(5000); ev('REJECTED_SHOWN');
  await wheel(-420); await sleep(1500);
  await click(p.locator('button:has-text("Continue to checkout")').first()); ev('PREPARE');
  await p.waitForSelector('a:has-text("Open owner approval")', { timeout: 60000 }); ev('HANDOFF'); await sleep(5000);
  await click(p.locator('a:has-text("Open owner approval")')); await p.waitForLoadState(); ev('OWNER_PAGE'); const ownerUrl = p.url(); await sleep(2500);
  await ring(p.locator('input[name=ownerKey]')); await p.fill('input[name=ownerKey]', OWN); await sleep(900); await click(p.locator('button:has-text("Review checkout")')); await p.waitForLoadState(); ev('OWNER_REVIEW'); await sleep(4000);
  await wheel(250); await sleep(1000);
  await slowType('input[name=maximum]', '100.00'); ev('LIMIT_100'); await sleep(800);
  await click(p.locator('form:has(input[name=maximum]) button').first()); await p.waitForLoadState(); ev('CONFIRM_100'); await sleep(3500);
  await click(p.locator('form:has(input[value=authorize]) button')); await p.waitForLoadState(); ev('REFUSED_AMOUNT_EXCEEDED'); await sleep(5500);
  await p.goto(ownerUrl); await ring(p.locator('input[name=ownerKey]')); await p.fill('input[name=ownerKey]', OWN); await sleep(700); await click(p.locator('button:has-text("Review checkout")')); await p.waitForLoadState(); ev('OWNER_RETRY'); await sleep(1500);
  await wheel(250); await sleep(600);
  await slowType('input[name=maximum]', '140.00'); ev('LIMIT_140'); await sleep(700);
  await click(p.locator('form:has(input[name=maximum]) button').first()); await p.waitForLoadState(); ev('CONFIRM_140'); await sleep(2500);
  await click(p.locator('form:has(input[value=authorize]) button')); await p.waitForLoadState(); ev('MOCK_PAYPAL_PAGE'); await sleep(4000);
  const ok = p.locator('input[name=owner_key]').first(); await ring(ok); await ok.fill(OWN); await sleep(800);
  await click(p.locator('button:has-text("Approve (mock buyer)")')); await p.waitForLoadState(); ev('MOCK_BUYER_APPROVED', { url: p.url().replace(/token=[^&]+/, 'token=…') }); await sleep(3000);
  fs.writeFileSync(path.join(OUT, 'return-page.txt'), await p.innerText('body'));
  const back = p.locator('a[href*="/buy/"]');
  if (await back.count()) { await click(back.first()); } else { await p.goto('http://127.0.0.1:8790/buy/'); }
  ev('BACK_TO_PANEL');
  await p.waitForSelector('text=Payment completed', { timeout: 60000 }); ev('RECEIPT'); await sleep(1500); await typeTmux('The panel says it is paid. What exactly is complete?'); await sleep(300); tmux('send-keys -t host Enter'); ev('HOST_FOLLOWUP'); await sleep(2500);
  await wheel(300); await sleep(1000); await click(p.locator('summary:has-text("Audit timeline")')); await sleep(1200); await wheel(450); await sleep(4500);
  fs.writeFileSync(path.join(OUT, 'receipt.txt'), await p.innerText('body'));
  await p.goto(`file://${R}/sandbox-evidence.html`); ev('SANDBOX_EVIDENCE'); await sleep(8000);
  await wheel(320); await sleep(5000);
  ev('REC_END'); await sleep(1000);
  ff.stdin.write('q'); await new Promise((r) => ff.on('close', r));
  fs.writeFileSync(path.join(OUT, 'host-pane.txt'), execSync('tmux -L rec capture-pane -p -S -200 -t host').toString());
  await ctx.close(); ev('DONE');
})().catch((e) => { ev('FATAL', { m: String(e && e.stack || e) }); process.exit(1); });
