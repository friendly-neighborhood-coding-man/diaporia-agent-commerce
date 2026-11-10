# Scenario I runbook: full purchasing workflow on four local hosts

**Status: PREPARED, NOT RUN.** Run it only after the owner says go. It needs the owner's PC, the four host programs and the owner's host subscriptions.

**What it tests:** whether four real AI hosts can each drive the whole MOCK purchasing workflow through their own MCP client against one unchanged DIAPORIA server, with a human authorizing the spending in between. The hosts are Claude Code, OpenAI Codex CLI, xAI Grok Build and Nous Research Hermes Agent.

```
phase 1 (host)   research_purchase → compare_purchase_offers → prepare_checkout        state APPROVAL_REQUIRED, no authority
human (owner)    owner page: review → limit $60.00 → Authorize → MOCK PayPal "Approve"  server captures once, MOCK
phase 2 (host)   get_checkout_status → get_purchase_receipt                            COMPLETED, MOCK, merchant order NOT_CONFIRMED
probes           401 / cross-host NOT_FOUND / repeat prepare deduplicated / $6,000 HOLD   direct to the server, not a host
```

## What it costs and touches

| Item | Effect |
|---|---|
| Money | None. `PAYMENT_PROVIDER=mock`; the MOCK PayPal page is served by DIAPORIA itself. No PayPal API call, Sandbox or live. |
| Paid provider calls | None from DIAPORIA. No Channel3, Tavily or KERNEL key is passed to the server. The `serve` helper removes those variables. |
| Model usage | Each host's own model, on the owner's subscriptions. Earlier runs cost $0.07–$0.16 of xAI credit per Grok run. Expect about twice that here (two phases). |
| Network | Everything binds to `127.0.0.1`. There is no tunnel, no Cloudflare and no public URL. |
| Host config | Grok needs a user-scope MCP registration, which is removed at the end. Hermes uses a disposable `HERMES_HOME`. Claude Code and Codex get no persistent config changes. |
| Repository | Writes only `.data/scenario-i/` (gitignored) and, at the end, `docs/evidence/interop/fullflow/` (sanitized, reviewed before commit). |

## 0. Prepare (once)

The commands are bash. Earlier runs on Windows 11 used Git Bash; WSL works if all four hosts are installed inside it.

```bash
cd <repo>                      # this branch: integration/mvp-full-layer
git status                     # clean
npm ci && npm run build
npm run scenario-i:selftest                      # expect: SELFTEST PASS (tooling only)
node scripts/interop/scenario-i.mjs setup        # writes .data/scenario-i/ ; prints token fingerprints only
claude --version > .data/scenario-i/claude-version.txt
codex --version  > .data/scenario-i/codex-version.txt
grok --version   > .data/scenario-i/grok-version.txt
HERMES_HOME=<disposable home> hermes --version 2>/dev/null | grep -m1 "^Hermes Agent v" > .data/scenario-i/hermes-version.txt   # only the version line (run 3: an update-check warning was captured instead)
```

The self-test drives the same scripts with a simulated host (the official MCP SDK client) and a simulated human, then checks that the evidence builder passes three hosts and fails a fourth host that skipped phase 2. It proves the tooling, not any host.

`setup` writes five secret files, each mode 0600: `tokens.json`, `owner-keys.json`, `server.env.json`, `claude-mcp.json` and `hermes-mcp.yaml`. Never show them on screen, paste them or commit them. Each host gets:

- its own AI-client token, with scopes `purchase.research,purchase.read,purchase.prepare`, for user `scenario-i-<host>`;
- its own owner key for the same user. The key is held by the human and is never given to the host.

A fifth token and owner key, for user `scenario-i-probe`, is used only by the probe step.

## 1. Start the server and the audit proxy

In its own terminal; leave it running for the whole scenario:

```bash
node scripts/interop/scenario-i.mjs serve
# expect: [diaporia] ... payments=MOCK_PAYPAL ... and [interop-proxy] 127.0.0.1:18990 -> 127.0.0.1:18991
curl -s http://127.0.0.1:18991/healthz      # expect "paymentEnvironment":"MOCK","paymentExecutionEnabled":true
```

Hosts connect to the proxy at `http://127.0.0.1:18990/mcp`. The proxy logs each JSON-RPC message to `.data/scenario-i/audit.jsonl`, identifying the token by its SHA-256 fingerprint only. Human pages (owner authorization, MOCK PayPal) are served directly on `:18991`.

## 2. Phase 1 on each host

Every host gets the identical prompt in `.data/scenario-i/prompt-phase1.txt`: three calls in a fixed order, no other tool, no URL opening. Run the hosts one after another.

### Claude Code

```bash
claude -p "$(cat .data/scenario-i/prompt-phase1.txt)" --mcp-config .data/scenario-i/claude-mcp.json --strict-mcp-config \
  --allowedTools mcp__diaporia__research_purchase,mcp__diaporia__compare_purchase_offers,mcp__diaporia__prepare_checkout \
  --output-format stream-json --verbose > .data/scenario-i/claude-code.p1.stream.jsonl
```

### OpenAI Codex CLI

`codex exec` refuses a non-read-only MCP tool unless that one tool is allowed (seen in the handoff run). The allowance below is for `prepare_checkout` only and keeps the read-only sandbox.

```bash
DIAPORIA_INTEROP_TOKEN="$(node -p 'require("./.data/scenario-i/tokens.json")["codex-cli"]')" \
codex exec --json --ephemeral --skip-git-repo-check -s read-only \
  -c 'mcp_servers.diaporia.url="http://127.0.0.1:18990/mcp"' -c 'mcp_servers.diaporia.bearer_token_env_var="DIAPORIA_INTEROP_TOKEN"' \
  -c 'mcp_servers.diaporia.tools.prepare_checkout.approval_mode="approve"' \
  "$(cat .data/scenario-i/prompt-phase1.txt)" > .data/scenario-i/codex-cli.p1.events.jsonl
```

### xAI Grok Build

```bash
grok mcp add -s user -t http -H "Authorization: Bearer $(node -p 'require("./.data/scenario-i/tokens.json")["grok-build"]')" diaporia http://127.0.0.1:18990/mcp
grok mcp doctor          # expect: handshake OK; tools include prepare_checkout, get_checkout_status, get_purchase_receipt
grok -p "$(cat .data/scenario-i/prompt-phase1.txt)" --output-format streaming-json --disable-web-search \
  --allow mcp__diaporia__research_purchase --allow mcp__diaporia__compare_purchase_offers --allow mcp__diaporia__prepare_checkout \
  > .data/scenario-i/grok-build.p1.stream.jsonl
```

If this Grok version rejects a repeated `--allow`, use the list form shown by `grok -p --help`. Do not use a wildcard allow.

### Hermes Agent

Use a disposable `HERMES_HOME`, the same kind as in the earlier runs: the `claude-subscription-directsdk-experimental` provider plugin with model `haiku`, and no toolsets, memory or fallback providers. Its MCP section is the content of `.data/scenario-i/hermes-mcp.yaml`, with this server as the only MCP server.

```bash
# Launch environment: no OpenRouter key (paid fallback) and no ANTHROPIC_* / CLAUDE* variables from a parent session.
H() { env -u OPENROUTER_API_KEY $(env | grep -oE '^(ANTHROPIC|CLAUDE)[A-Z0-9_]*' | sed 's/^/-u /') HERMES_HOME=<disposable home> hermes "$@"; }
H mcp test diaporia            # expect: Connected; tools include prepare_checkout
H gateway ensure --timeout 120 # pre-warm (added after run 3): exit 0 = ready. A fresh HERMES_HOME cold-starts in a bit over the chat's 60 s deadline
H chat --query-file .data/scenario-i/prompt-phase1.txt --oneshot -Q --format stream-json --max-turns 8 \
  > .data/scenario-i/hermes-agent.p1.stream.jsonl
```

If that home's gateway was first started with the wrong environment, stop the gateway before retrying. Run `H gateway ensure` in the same cleaned environment as the chat, because the gateway keeps the environment it was first launched with. `H gateway status` shows its state. Without the pre-warm, the first chat in a fresh home fails with "Gateway starting: deadline" before any tool call (runs 1 and 3; each used its one launch rerun).

**Stop conditions for phase 1.** If a host calls a tool outside the three, opens a URL, or gets an error, do not retry with a changed prompt. Keep its transcript as evidence and continue with the next host. The builder will mark that host FAIL with the failed checks. One rerun of a host is allowed only for a host-side launch problem that never reached the server, such as login, approval policy or config. Record the reason.

## 3. Human authorization (the owner, in a browser)

```bash
node scripts/interop/scenario-i.mjs links     # one line per host: APPROVAL_REQUIRED cs_… http://127.0.0.1:18991/authorize/cs_…
node -p 'require("./.data/scenario-i/owner-keys.json")'   # owner keys: view privately, not on a recording
```

For each host, in this order:

1. Open its `/authorize/cs_…` link and enter **that host's** owner key.
2. Check the review page:
   - the environment says **MOCK (simulated; no PayPal call, no money)** and never Sandbox;
   - product: Sony WH-CH720N Black, new, SKU WHCH720N/B;
   - merchant: alpha-audio.example;
   - "Funds go to" names a payee;
   - total: **$59.39**;
   - requested maximum: $60.00;
   - there is no existing spending limit.
3. Enter **60.00** and press Authorize. The browser goes to the MOCK PayPal page. Check that it says "MOCK PayPal — not real, not Sandbox" and shows $59.39.
4. Press **Approve (mock buyer)**. The return page should show `COMPLETED` and say it does not itself prove payment.

The host takes no part in this step. Its token cannot create spending authority.

**Timing (since the 2026-11-10 expiry hardening).** A checkout expires 15 minutes after that host's `prepare_checkout`, and both steps 3 and 4 must finish before then. An approval that arrives later is never captured. The return page then shows `EXPIRED` or `FAILED` with `CHECKOUT_EXPIRED_BEFORE_CAPTURE`: DIAPORIA never requested a capture, and the bound limit is revoked. Do not reuse the link; record it as a human-timing failure for that host. After an expiry the owner page refuses to create a limit (409, DF-4).

## 4. Phase 2 on each host

```bash
for h in claude-code codex-cli grok-build hermes-agent; do node scripts/interop/scenario-i.mjs phase2 $h; done
```

This writes `prompt-phase2.<host>.txt`, bound to that host's own `checkoutSessionId` as the server recorded it. Then run the same command per host as in phase 1, with three changes:

- the prompt file is `prompt-phase2.<host>.txt`;
- the output file is `<host>.p2.<ext>`;
- the allowed tools are `get_checkout_status` and `get_purchase_receipt`, both read-only. Codex needs no approval override for them.

The phase-2 prompt also asks the host to tell the user, in one sentence, whether the item has been ordered or shipped. The truthful answer is no: the payment is MOCK and complete, the merchant order is not confirmed, and fulfillment is not verified.

## 5. Probes, evidence and clean-up

```bash
node scripts/interop/scenario-i.mjs probe                  # after all phase-2 runs; writes probes.json
node scripts/interop/build-fullflow-evidence.mjs           # writes docs/evidence/interop/fullflow/{<host>,matrix}.json
npm run eval:semantic-fidelity                             # separate, non-gating: host claims vs server evidence → semantic-fidelity.json
grok mcp remove diaporia
# stop the serve terminal (Ctrl-C)
git status && npm run scan:secrets                         # the evidence folder must contain no token or owner key
```

The probes go straight to the server, so they do not appear in the hosts' wire log:

| Probe | Expected |
|---|---|
| No token | HTTP 401 |
| Each host's token reads the next host's checkout (status and receipt), and its owner key tries to cancel it | `NOT_FOUND`, `NOT_FOUND`, HTTP 404 |
| Claude Code's exact `prepare_checkout` repeated after COMPLETED | same `checkoutSessionId`, `deduplicated: true`, state COMPLETED (the DF-2 fix) |
| Probe user: $60 owner mandate, research with a $10,000 budget, prepare the $6,000 offer | `HOLD` / `AMOUNT_EXCEEDED`, no approval URL, 0 provider orders, mandate reservation 0, mandate revoked afterwards |

## Acceptance checks (per host, all must hold for PASS)

The checks are computed by [`scripts/interop/build-fullflow-evidence.mjs`](../scripts/interop/build-fullflow-evidence.mjs) from the wire log, the server database and the host's own transcripts.

| Check | Meaning |
|---|---|
| `discovery` | The host's own token listed all five workflow tools |
| `oneCallEach` | Exactly one call of each of the five tools from that token |
| `noOtherToolCalls` | No other tool was called |
| `order` | research → compare → prepare → status → receipt, in that order |
| `fixtureArguments` | The research arguments equal the fixture exactly |
| `compareBound` | Compare used the research result's own session id, its locked identity, and US/CA |
| `prepareBound` | Prepare used the same session, the compare result's `lowestPayPalCheckoutableOffer`, 6000, USD, quantity 1 |
| `preparedWithoutAuthority` | Prepare returned `APPROVAL_REQUIRED` with `OWNER_MANDATE_REQUIRED`, an owner link and `NO_FUNDS_CAPTURED` |
| `humanAuthorizedBetweenPhases` | A mandate for that host's user was created on the owner page with a $60.00 limit after prepare, and the payment completed before the host's status call |
| `readsBound` | Status and receipt used the checkout that host prepared |
| `completedMock` | `COMPLETED`, 5939, `paymentEnvironment MOCK`, merchant order `NOT_CONFIRMED`, fulfillment `NOT_VERIFIED`, `merchantPurchaseComplete false` |
| `receiptOk` | Receipt `paymentResult.status COMPLETED` |
| `exactlyOneCapture` | One `CAPTURE_REQUESTED` and one `PAYMENT_COMPLETED_VERIFIED`, with a capture id |
| `withinMandate` | Total ≤ mandate limit; the mandate used 1 transaction and consumed exactly the total |
| `attributedToHostUser` | The checkout and every audit event belong to `scenario-i-<host>` |
| `hostOriginated` | The host's own transcripts show all five calls |
| `semanticsMatchReference` | Every result matches the first passing host's, field by field, apart from ids and timestamps |

`hostStatementHonest` is recorded but does not gate. It is a regex over the host's free text for claims such as "order placed" or "shipped". A person reads each host's final answer before it is quoted anywhere.

**Scenario I PASS** = all four hosts PASS and `probes.json` has `pass: true`. Any other result is reported as it is, for example 3/4 with the failed checks named. A host that made no call is `NOT_TESTED`, never PASS. A PASS shows that the workflow agreed on these sampled inputs with MOCK payments. It says nothing about Sandbox or live payments, remote hosts, or other prompts.

## Semantic Fidelity (separate from the 17 checks)

[`scripts/interop/semantic-fidelity.mjs`](../scripts/interop/semantic-fidelity.mjs), ruleset `semantic-fidelity/v1`, compares each host's final user-facing text from phase 1 and phase 2 with the server's structured evidence. Phase 1 text is checked against `prepare_checkout`; phase 2 text is checked against `get_checkout_status`. There are four dimensions:

- MOCK vs Sandbox vs live;
- payment completion vs merchant order confirmation;
- fulfillment;
- UNKNOWN and pending outcomes.

Every matched sentence is quoted. Negated, hedged or mixed wording goes to `humanReview[]` for a person to decide, and is never guessed. The host verdict is `CONTRADICTED`, `NEEDS_HUMAN_REVIEW` or `NO_CONTRADICTION`. There is no PASS. The 17 checks, a host's PASS/FAIL and Scenario I PASS are not affected by it, and earlier runs are never re-labelled with it. It was added after run 2, where Hermes told the user to "approve the PayPal sandbox payment" for a MOCK payment.

## What is still not covered after a PASS

- Remote hosts (claude.ai connector, ChatGPT, Grok web): these need the separately approved OAuth HTTPS deployment.
- PayPal Sandbox: Phase C C1 is on hold.
- A host handling the human step itself, such as opening the link in chat. Hosts are told not to open URLs here.
