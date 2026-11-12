# Demo video: script, timing and screen sequence

`demo-final.mp4`, 2:52.7, 1920×1080. Build `be03b52` (PR #15 = frozen engine `4bc7dcc` + Buy panel). No narration; burned-in English captions. The live part is one continuous, uncut take.

Screen layout during the live part: left, Claude Code (an AI host) in a terminal; right, the DIAPORIA Buy panel in a browser window beside it; bottom, a caption band with a fixed tag "Live recording · build be03b52 · MOCK · no money".

| Time | Screen | Caption (verbatim) |
|---|---|---|
| 0:00–0:11 | Title card: DIAPORIA Buy, "Secure AI Purchasing for Every Assistant", "Don't switch assistants to shop.", and the five needs: exact product and variant, independently verified requirements, a trustworthy merchant, the full verified total, human spending authorization | (none) |
| 0:11–0:19 | The request is typed into Claude Code: "I need wireless headphones under $150 with multipoint and a lanyard loop, lowest total price. Research it with DIAPORIA and open the shopping panel." | Claude Code, a real AI host, gets a shopping request (typed by the recording script). |
| 0:19–0:29 | Claude Code calls DIAPORIA ("Called diaporia") | The host calls DIAPORIA's start_shopping_panel tool over MCP; research runs server-side. |
| 0:29–0:40 | Panel opens: Interpreting request ✓, Finding candidates ✓, Verifying requirements (live). Claude Code replies that research is running | The DIAPORIA Buy panel opens beside the assistant with live progress (offline demo catalog). |
| 0:40–0:48 | Results: Halden A8 (Recommended, Eligible, listing $121.00) and Orrin Q3 (Needs investigation, listing $115.00) | Card prices are search-time listings, not totals. Only the Halden A8 has every must-have verified. |
| 0:48–0:59 | Orrin Q3 details: wireless, multipoint and lanyard loop "not verified: no attributable source was found"; "Before this can be bought" list | Orrin Q3 is cheaper, but nothing attributable verifies its must-haves: not recommended. |
| 0:59–1:12 | Halden A8 details: each requirement expanded to its manufacturer source and quote; product identity (brand, model, condition) | Halden A8: each must-have is backed by a quoted manufacturer source; identity is locked. |
| 1:12–1:16 | Select this product → Compare offers (ship to US-CA) | Selecting the product asks every merchant for a fresh quote with shipping and tax. |
| 1:16–1:30 | Verified offers: bravo-electronics.example, item $129.00, shipping $0.00, tax $9.35, verified total $138.35; other verified offer $139.76; rejected merchant alpha-audi0.example `MERCHANT_IDENTITY_MISMATCH` | Verified total $138.35 vs. the $121 listing. Look-alike alpha-audi0.example is rejected. |
| 1:30–1:36 | Continue to checkout → "Approval required" timeline | The AI can prepare a checkout but cannot authorize spending. Approval moves to the owner page. |
| 1:36–1:47 | Owner page (MOCK banner): owner key entered as dots; review table with item, shipping, tax, total payable, payee | Owner page (MOCK). A scripted demo owner enters a DEMO-ONLY key: a simulation, not real consent. |
| 1:47–1:53 | Limit $100 typed; confirm page warns "This limit is below the total payable" | The simulated owner sets a $100 spending limit, below the $138.35 verified total... |
| 1:53–2:00 | "Checkout not authorized · AMOUNT_EXCEEDED · No payment was started." | ...and DIAPORIA refuses it: AMOUNT_EXCEEDED. No payment is started. |
| 2:00–2:09 | Owner page again; limit $140; confirm | The simulated owner sets a $140 limit and confirms. |
| 2:09–2:19 | MOCK PayPal checkout page ("not real, not Sandbox"); approve as MOCK buyer; return page "Server-verified state: COMPLETED" | MOCK PayPal approval: no PayPal call, no money. The owner key stands in for the buyer's login. |
| 2:19–2:23 | Panel receipt: Payment completed (MOCK), $138.35, Merchant order "Not verified" | The receipt appears only after the DIAPORIA backend verifies the MOCK capture. |
| 2:23–2:34 | The script asks Claude Code "The panel says it is paid. What exactly is complete?"; the host reads the panel state and answers: only a mock payment capture, no merchant order, nothing will ship. Panel audit timeline expanded (mandate rejected, revoked unused, created) | The host reads DIAPORIA's records: only a MOCK capture is complete. No order, no fulfilment. |
| 2:34–2:45 | Same browser: verbatim excerpt of `docs/TEST_REPORT.md`, PayPal Sandbox run 2 (2026-11-09, build 421693f): order `99X21669LS4807358`, capture `92U85747JU359434A` PENDING / PENDING_REVIEW. Tag: "Excerpt of docs/TEST_REPORT.md · not re-run" | Recorded PayPal Sandbox run, Nov 9: real test API calls; capture still PENDING_REVIEW. |
| 2:45–2:53 | Closing card: "DIAPORIA lets the AI you already use research products, verify offers, and prepare safer purchases, without giving the AI unrestricted spending authority." DIAPORIA Buy, tagline, GitHub URL, footnote on MOCK, Sandbox and fulfilment | (none) |

## Optional voice-over (if narration is added later, about 150 words per minute)

- 0:00 "AI assistants can find products. Buying one safely needs the exact product, verified requirements, a trustworthy merchant, the full total, and a human who authorizes the spend. DIAPORIA Buy adds that to the assistant you already use."
- 0:11 "Here Claude Code calls DIAPORIA over MCP. Research runs on DIAPORIA's server, and the Buy panel opens beside the chat."
- 0:40 "Two candidates. The cheaper one has no attributable evidence for the must-haves, so it is not recommended. The Halden A8 has a manufacturer quote for each one."
- 1:12 "Comparing asks each merchant for a fresh quote. The verified total is $138.35, not the $121 listing, and a look-alike merchant is rejected."
- 1:30 "The AI can prepare the checkout but cannot authorize it. Our scripted demo owner first sets $100, and DIAPORIA refuses. With $140 the MOCK PayPal step runs, and the receipt appears only after the backend verifies it."
- 2:23 "The assistant reports exactly what is complete: a mock payment, not a merchant order."
- 2:34 "Separately, our PayPal Sandbox runs made real Orders v2 calls; the capture is still pending review."
- 2:45 "DIAPORIA Buy: secure AI purchasing for every assistant."

## Reproduce the recording

See `recording/README.md`. In short: an Xvfb display, `recording/reset.sh` (fresh MOCK server, fresh DEV-ONLY credentials, fresh host), `recording/record.cjs` (drives and records), `recording/build.py` (title, captions, closing).
