# Devpost form: exact text to paste

**Project name**
DIAPORIA Buy — Secure AI Purchasing for Every Assistant

**Elevator pitch** (short tagline field)
Don't switch AI assistants to shop. DIAPORIA brings evidence-based product research, verified offers, and human-authorized PayPal checkout to the AI you already use.

**About the project / Project story**
Paste the whole of `devpost-description.md` from "## Inspiration and the problem" to the end. Devpost accepts Markdown.

**Built with** (one tag per entry)
typescript, node.js, sqlite, model-context-protocol, mcp-typescript-sdk, paypal, paypal-orders-v2, paypal-sandbox, zod, vitest, html5, css3, javascript, server-sent-events, webauthn, channel3, tavily, claude-code, playwright, ffmpeg

**"Try it out" links**
- https://github.com/friendly-neighborhood-coding-man/diaporia-agent-commerce
- https://github.com/friendly-neighborhood-coding-man/diaporia-agent-commerce/pull/15 (submission build `be03b52`, branch `feature/buy-browser-panel`)

**Video demo link**
`<YouTube URL after upload>` (upload `demo-final.mp4` as Public; see the YouTube text below)

**Code repository URL**
https://github.com/friendly-neighborhood-coding-man/diaporia-agent-commerce

**Testing instructions** (if the form asks; also usable as "How to run")
```
Requires Node.js 22.13 or newer. No accounts, keys or network access are needed; payments are MOCK.

git clone https://github.com/friendly-neighborhood-coding-man/diaporia-agent-commerce
cd diaporia-agent-commerce
git checkout feature/buy-browser-panel      # submission build (PR #15)
npm ci
npm test                 # 1045 automated tests, offline
npm run demo:full        # unattended MCP end-to-end demo, 18 checked steps, writes demo-output/<run>/trace.json
npm run dev:buy-panel    # Buy panel on http://127.0.0.1:8790: prints a panel link, a DEV-ONLY MCP token and a DEV-ONLY owner key
```
Open the printed panel link in a browser to walk the same flow as the video (results, details, compare, checkout, owner page, MOCK PayPal, receipt). To drive it from your own MCP host, point it at `http://127.0.0.1:8790/mcp` with the printed bearer token and call `start_shopping_panel`. The owner key is a DEV-ONLY stand-in for the human. PayPal Sandbox needs your own Sandbox app credentials and is not needed for the demo (see docs/PAYPAL_INTEGRATION.md and docs/TEST_REPORT.md).

**How was the project significantly updated during the Submission Period?** (if asked)
The repository was created on 2026-11-09, inside the Submission Period. All of it (MCP server, research engine, mandates, PayPal Sandbox adapter, Buy panel) was built between 2026-11-09 and 2026-11-12.

**Sponsor tools used** (if asked)
Channel3: a bring-your-own-key catalog adapter (`src/research/Channel3ResearchAdapter.ts`). It was exercised in bounded live smoke tests; the demo uses an offline world in Channel3's documented response shape. Do not claim more than that.

**Which PayPal products** (if asked)
PayPal Developer Platform: Orders v2 (create, buyer approval, capture) and Payments v2 capture reads, Sandbox environment.

---

## YouTube upload text

**Title**
DIAPORIA Buy — Secure AI Purchasing for Every Assistant (PayPal AI Hackathon demo)

**Description**
Don't switch assistants to shop. DIAPORIA Buy is an MCP purchasing service: the AI you already use calls it to research products with evidence, compare merchant-verified totals and prepare a checkout. Only the human can authorize spending.

This is one continuous recording of build be03b52: Claude Code calls DIAPORIA over MCP and the DIAPORIA Buy panel runs beside it. Payments are MOCK (no PayPal API call, no money). The catalog and merchants are an offline demo world, and the owner steps are performed by a scripted demo owner, which is a simulation and not real consent. The PayPal Sandbox segment shows earlier recorded Sandbox evidence (capture PENDING_REVIEW). Merchant fulfilment is not integrated.

Code (MIT): https://github.com/friendly-neighborhood-coding-man/diaporia-agent-commerce

**Settings:** Visibility Public. Not made for kids. No music.
