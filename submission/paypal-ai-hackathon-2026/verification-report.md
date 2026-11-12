# Verification report: DIAPORIA Buy, PayPal AI Hackathon submission build

Prepared 2026-11-12 (UTC). Every result below was measured on the commits named here. Nothing is inferred.

## Source commits

| Role | Commit | Notes |
|---|---|---|
| Frozen research engine (PR #14, `feature/research-v2.1-reliability`) | `4bc7dcca29c3fbeb1fea791866e561521d6f8264` | Unchanged. Not rebased, not amended, not merged into `main` |
| Buy panel before integration (PR #15 previous head) | `1b713aeddaf2707c57ca32abff203e6f49e1e6c0` | Unchanged |
| **Submission build = PR #15 head after integration** | **`be03b52c7587c8311a51f8d3748395260e9c4e6b`** | `git merge --no-ff` of `4bc7dcc` into `feature/buy-browser-panel`. No conflicts. Tree `ee59c8d63b846ad3b1f64c405ad6b5d5c54301ed` |
| Submission docs (this folder, README and SUBMISSION.md updates) | the commit that adds this file, on top of `be03b52` | Documentation and recording tooling only. No `src/` or `tests/` change |

**Engine integrity check.** `git diff 4bc7dcc be03b52 --name-only` lists only the Buy panel slice: `src/panel/**`, `docs/BUY_PANEL.md`, `scripts/buy-panel*`, `tests/buy-panel.test.ts`, plus the four opt-in hook files the panel already had in PR #15 (`package.json`, `src/http/server.ts`, `src/main.ts`, `src/mcp/MCPCommerceAdapter.ts`). No research, decision, evidence, gate, mandate or payment file differs from the frozen commit. No integration fix was needed.

## Local validation on `be03b52`

Environment: Linux cloud container, Node.js v22.23.4, `npm ci` from the lockfile.

| Check | Command | Result |
|---|---|---|
| Typecheck | `npm run typecheck` | exit 0 |
| Build | `npm run build` | exit 0 |
| Secret scan | `npm run scan:secrets` | 330 tracked files, no findings |
| Automated tests | `npx vitest run` | **66 files, 1045 tests passed**, 0 failed (1036 engine tests from PR #14 + 9 Buy panel tests) |
| Buy panel integration tests | `tests/buy-panel.test.ts` (part of the run above) | pass |
| MCP session tests | `tests/mcp-*.test.ts` (part of the run above) | pass |
| MOCK end-to-end demo | `npm run demo:full` | `ALL_EXPECTATIONS_MET: 18/18 steps` in 666 ms; trace sha256 `19a5f39377add7aa88b6bb65cd40107e16a10765e839b4511bc97678095b0018` |
| Integrated UI journey | the recorded run below | every step of the 10-step journey passed (see "UI journey") |

## GitHub Actions CI on `be03b52`

Read from the public GitHub API (`/commits/be03b52…/check-runs`): `test (22)` success, `test (24)` success, `gitleaks` success, for both the push and the pull-request runs.

## Repository and license

- `friendly-neighborhood-coding-man/diaporia-agent-commerce` is **public** (GitHub API `private: false`).
- License: **MIT**, detected by GitHub (`license.spdx_id: MIT`), so it shows in the About section. File: `LICENSE`.
- Repository created 2026-11-09, inside the Submission Period (Oct 1 to Nov 12, 2026).

## UI journey on the integrated build (recorded run, 2026-11-12 ~10:57Z)

| # | Step | Observed in the recording |
|---|---|---|
| 1 | AI host issues a shopping request through MCP | Claude Code 2.1.322 (interactive) called `start_shopping_panel` on `http://127.0.0.1:8790/mcp` |
| 2 | DIAPORIA starts research | panel shows "Researching products", stages ticking |
| 3 | Panel shows real progress and candidates | two candidates: Halden A8 (Recommended, Eligible) and Orrin Q3 (Needs investigation) |
| 4 | Details show requirement evidence | A8: 3/3 must-haves verified, each with a quoted manufacturer sentence; Q3: 0/3 verified, "no attributable source" |
| 5 | Selection leads to verified offers | Item $129.00, shipping $0.00, tax $9.35, verified total $138.35 (listing was $121.00); `alpha-audi0.example` rejected `MERCHANT_IDENTITY_MISMATCH` |
| 6 | Server prepares a checkout | `APPROVAL_REQUIRED`, $138.35, merchant-verified total locked |
| 7 | Owner authorization runs | scripted owner set $100: `AMOUNT_EXCEEDED`, "No payment was started"; then $140: accepted |
| 8 | Simulated buyer approves the MOCK payment | MOCK PayPal page, "No PayPal API is called" |
| 9 | Backend verifies the payment state | return page: "Server-verified state: COMPLETED" (MOCK) |
| 10 | Receipt only when the backend permits it | panel receipt: COMPLETED, Environment MOCK, Merchant order "Not verified", audit timeline 19 entries including `mandate rejected` and `mandate revoked unused` |

The panel ran against the integrated tree: the recording server is `scripts/buy-panel/demo-app.ts` from `be03b52` (the repository's own offline demo world), which builds the real `createApp` with the frozen research adapter, evidence router, decision engine, gate and MOCK PayPal. There is no separate fixture UI.

## How the video was made

- One continuous screen recording, `ffmpeg -f x11grab` at 1920×1080, 30 fps, of an Xvfb display in the cloud container. Left: `xterm` running the interactive Claude Code CLI. Right: a Chromium window (Playwright's bundled browser, app mode) showing the DIAPORIA Buy panel.
- The Claude Code host ran with a clean `HOME` (no memory, no project context), its normal login, and the MCP server configured with a DEV-ONLY bearer token generated for the run. Its system prompt had one appended paragraph (in `recording/sysprompt.txt`): pass the user's words verbatim, do not print the panel link, answer status questions from `get_shopping_panel`. The host's replies are its own, unedited.
- The prompts were typed by the recording script (tmux `send-keys`). The panel clicks, the owner page and the MOCK buyer step were driven by a Playwright script with a DEV-ONLY owner key generated for the run. This is a **scripted simulated human**, labelled as such in the captions, not real consent.
- The demo world adds 2.5 s of simulated provider latency per catalog or evidence call (`researchDelayMs`, an existing option of `demo-app.ts`) so the live progress is visible. Nothing in research was sped up or changed.
- Edit: an 11 s title card, the live take with burned-in captions, an 8 s closing card. The live part is uncut (153.7 s).
- The PayPal Sandbox segment is a browser view of the verbatim run-2 section of `docs/TEST_REPORT.md` (recorded 2026-11-09 on build `421693f`), labelled "not re-run".
- Tooling and raw evidence: `recording/` in this folder (scripts, event log, the host's final terminal text, the receipt text, captions). No token or key is in any of these files.

## Video file

| Item | Value |
|---|---|
| Final cut | `demo-final.mp4`, 172.66 s (2:52.7), 1920×1080, H.264 High, 30 fps, silent AAC track |
| sha256 | `81b6f6056133d33b6038f7b9897fde5b5d617eb41bc547cc4583ea84c6088892` |
| Unedited take | `raw-take4-unedited.mp4`, sha256 `f695a8a9c940fce52c2c8e4a526a94ba922fe274bfaeb3aa3b408ed74d6eeb7d` |
| Decode check | `ffmpeg -v error -i demo-final.mp4 -f null -` reported no errors |
| Location | project files: `diaporia-buy-submission/` (not committed to git) |

**Secrets review.** Frames were inspected every 8 s. The owner key appears only as password dots. The MCP token and the panel capability link never appear (the host's tool call is collapsed as "Called diaporia"). Checkout, order and run ids on screen are from a throwaway in-memory MOCK server. The Sandbox ids shown are already public in `docs/TEST_REPORT.md`. No `.env`, account page, email address or personal browser tab is visible.

## What is real, simulated, or not integrated

| Part | Status in this submission |
|---|---|
| AI host ↔ DIAPORIA over MCP | **Real.** Claude Code in the video. Earlier localhost runs: Claude Code, Codex CLI, Grok Build, Hermes Agent, 4/4 PASS (`docs/INTEROP.md`) |
| Research engine, evidence ledger, decision engine, purchase gate, mandates | **Real code, frozen** at `4bc7dcc` |
| Catalog, web evidence, merchants, quotes | **Simulated:** offline fictional demo world |
| Payment in the video | **MOCK PayPal:** no PayPal API call, no money |
| PayPal Orders v2 Sandbox | **Real Sandbox API calls, earlier:** two owner-approved runs on 2026-11-09; capture `92U85747JU359434A` is `PENDING / PENDING_REVIEW`. `COMPLETED` was never observed |
| Merchant order and fulfilment | **Not integrated.** The receipt says so |
| Claude Desktop Browser pane | Verified on Eric's Windows PC on 2026-11-12 with the PR #15 panel before this integration (`docs/BUY_PANEL.md`, Validation record). **Not** re-verified on `be03b52` and **not** in the video |
| Codex Desktop, MCP Apps hosts, remote connectors | Not verified |
| PayPal Agent Ready, Store Sync | Not integrated |

## Known limitations (disclosed)

1. **Video host surface.** The video shows Claude Code CLI with the panel in a separate Chromium window, not Claude Desktop. The cloud recording environment has no Claude Desktop, and recording Eric's PC needs the Claude window in front, which could not be arranged unattended.
2. **R-A-1 / V22-05.** Payment routes accept the owner key without a passkey. A stolen owner key alone can complete a MOCK purchase. This is a documented deployment precondition.
3. **H2-R1 / V22-04.** The service-isolation self-check trusts declared uids. A root-owned uid pin is needed before deployment.
4. **Fresh-set behaviour.** Each new unseen set has found new wording that the parser or evidence matcher mishandled on first contact. The first IW-20 run (fresh, on `6989ba4`): 102/161 correct, 6 unsafe, 6/177 gate bypasses, legitimate checkouts 56/118. The frozen engine has **not** been measured on an unseen set. Its 0 unsafe and 0 bypasses on IW-1.1 to IW-20 are seen-set regression evidence only, not a guarantee.
5. **Duplicate requirement (observed while preparing the video).** When a host passes a requirement both in `mustHave` and in the request text, the panel can show it twice (one verified, one open), and the product goes to INVESTIGATE. The recorded host was told to pass the user's words only. Engine behaviour was not changed.
6. **Ranking by listing.** The decision engine can rank a product by a search-time listing from a merchant that comparison later rejects. The panel labels that number as an unverified listing.
7. The panel is opt-in (`DIAPORIA_BUY_PANEL=1` or `npm run dev:buy-panel`). Nothing is deployed.
