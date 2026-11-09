# Test report

Run date: 2026-11-09, Windows 11, Node.js 24.22.1, vitest 5.1.0, TypeScript 7.0.2, MCP TypeScript SDK 1.32.2.
**Evidence class for everything below: MOCK / fixture data, executed locally.** No PayPal API call, no host-AI connection, and no live research call was made.

## Automated suite (this repo)

`npm test` → **3 files, 48 passed, 0 failed, 0 skipped.** `npm run typecheck` clean, `npm run build` clean, `npm run demo:e2e` completes, `npm run scan:secrets` no findings.

MCP tests use the SDK's real `Client` + `StreamableHTTPClientTransport` against the real HTTP server; the client lists tools first, so every `structuredContent` is validated against the published `outputSchema`.

| Spec item | Covered by | Result |
|---|---|---|
| 1. V7.2 regression | Separate private repo (see below) | 206 passed, 3 opt-in skipped |
| 2. MCP discovery & schema validation | `mcp-e2e › MCP protocol discovery…` (3 tests) | pass |
| 3. PRODUCT_DISCOVERY | `core › PurchaseIntentRouter`, `mcp-e2e › PRODUCT_DISCOVERY` | pass |
| 4. EXACT_PRODUCT_PURCHASE | `core › ProductIdentityResolver`, `mcp-e2e › EXACT_PRODUCT_PURCHASE` | pass |
| 5. Variant mismatch rejection | `core › rejects variant and condition mismatches`, `mcp-e2e › locks identity, rejects substitution` | pass |
| 6. Missing / stale quote | `core › separates stale, missing and unknown-total offers`, `mcp-e2e › refuses stale or ineligible offers` | pass |
| 7. $60 vs $6,000 | `mcp-e2e › rejects a $6,000 checkout against a $60 mandate before any payment provider call` (asserts zero provider calls) | pass |
| 8. Wrong-user access | `mcp-e2e › isolation between users` | pass |
| 9. Duplicate checkout / repeated capture | `mcp-e2e › deduplicates repeated prepare calls and never captures twice` (concurrent replays) and concurrent reservation test | pass |
| 10. Expired / revoked mandate | `mcp-e2e › rejects expired and revoked mandates`, `› not captured if the mandate is revoked first` | pass |
| 11. Cancellation & network timeout | `› handles buyer cancellation…`, `› network timeout during capture…`, `› timeout before capture…` | pass |
| 12. Pending / unknown vs completed | `› distinguishes PENDING from COMPLETED, and DECLINED becomes FAILED`, timeout tests | pass |
| 13. Prompt injection | `core › flags instruction-like…`, `core › excludes merchant listings…`, `mcp-e2e › prompt injection…` | pass |
| 14. Mock end-to-end purchase | `mcp-e2e › mock end-to-end purchase` (2 tests), `npm run demo:e2e` | pass |
| 15. Genuine PayPal Sandbox checkout | — | **NOT RUN** (awaiting owner approval) |
| 16. Real host-to-MCP integration | — | **NOT RUN** (awaiting owner approval) |

Additional: PayPal adapter against a fake `fetch` (Sandbox-only host, idempotency header, CAPTURE body, error mapping, no secret leakage), HTTP hardening (413 body limit, 421 foreign Host, 403 foreign Origin), public deployment disables payment, public read-only mode exposes no payment tool, malformed mandates → 400, AI token cannot create mandates.

## Compiled server smoke test

`npm run build && PORT=8791 node dist/src/main.js`: `/healthz` returned `paymentExecutionEnabled: true, paymentProvider: MOCK_PAYPAL`; MCP `initialize` with a dev bearer token returned server info and instructions; `/mcp` without a token returned 401.

## V7.2 regression (private DIAPORIA Buy repo)

- Frozen tag `demo-ui-freeze-v7.2` → `966d511` in `diaporia-buy-v7-hackathon`, untouched.
- Baseline at the tag: 25 files passed, 3 skipped; **203 passed, 3 skipped**.
- Branch `feature/v8-agent-commerce-adapter` (additive `lib/agent-commerce/*` + one test file, no existing file modified): **206 passed, 3 skipped**.

## Not verified

Live PayPal Sandbox order/approval/capture; any real AI host (Claude, ChatGPT, Grok); live catalog/evidence research through the private adapter; multi-process concurrency; webhooks.
