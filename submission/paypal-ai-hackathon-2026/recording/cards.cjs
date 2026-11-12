const { chromium } = require('playwright');
(async () => { const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
  for (const n of ['title', 'close']) { await p.goto('file://' + process.argv[2] + '/' + n + '.html'); await p.waitForTimeout(400); await p.screenshot({ path: process.argv[2] + '/' + n + '.png' }); }
  await b.close(); })();
