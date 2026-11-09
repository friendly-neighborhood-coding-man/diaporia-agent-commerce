# Test report

Run date: 2026-11-09, Windows 11, Node.js 24.22.1, vitest 5.1.0, TypeScript 7.0.2, MCP TypeScript SDK 1.32.2.
**Evidence class: MOCK / fixture data, executed locally,** except for the two live items marked below (the Claude Code CLI host test and the Sandbox OAuth preflight). No PayPal order, approval or capture has been made, and no live catalog or research call has been made.

## Automated suite (this repo)

`npm test` → **4 files, 51 passed, 0 failed, 0 skipped** (as of commit c12581f). `npm run typecheck` clean, `npm run build` clean, `npm run demo:e2e` completes, `npm run scan:secrets` no findings.

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
| 9. Duplicate checkout / repeated capture | `mcp-e2e › deduplicates…`, concurrent reservation test, `recovery-return-abuse` (replays across a restart, forged, cross-user, unapproved and tampered returns) | pass |
| 10. Expired / revoked mandate | `mcp-e2e › rejects expired and revoked mandates`, `› not captured if the mandate is revoked first` | pass |
| 11. Cancellation & network timeout | `› handles buyer cancellation…`, `› network timeout during capture…`, `› timeout before capture…` | pass |
| 12. Pending / unknown vs completed | `› distinguishes PENDING from COMPLETED, and DECLINED becomes FAILED`, timeout tests | pass |
| 13. Prompt injection | `core › flags instruction-like…`, `core › excludes merchant listings…`, `mcp-e2e › prompt injection…` | pass |
| 14. Mock end-to-end purchase | `mcp-e2e › mock end-to-end purchase` (2 tests), `npm run demo:e2e` | pass |
| 15. Genuine PayPal Sandbox checkout | `npm run preflight:sandbox` (LIVE Sandbox OAuth only: HTTP 200; $6,000 refused with 0 PayPal calls) | **READY_FOR_SANDBOX_E2E**; checkout NOT RUN, waiting for the owner and the Sandbox buyer |
| 16. Real host-to-MCP integration | Claude Code CLI 2.1.310 → localhost (LIVE host, mock payments), see HOST_TEST_EVIDENCE.md | pass (localhost only; remote connectors untested) |

Additional: PayPal adapter against a fake `fetch` (Sandbox-only host, idempotency header, CAPTURE body, error mapping, no secret leakage), HTTP hardening (413 body limit, 421 foreign Host, 403 foreign Origin), public deployment disables payment, public read-only mode exposes no payment tool, malformed mandates → 400, AI token cannot create mandates.

## Compiled server smoke test

`npm run build && PORT=8791 node dist/src/main.js`: `/healthz` returned `paymentExecutionEnabled: true, paymentProvider: MOCK_PAYPAL`; MCP `initialize` with a dev bearer token returned server info and instructions; `/mcp` without a token returned 401.

## V7.2 regression (private DIAPORIA Buy repo)

- Frozen tag `demo-ui-freeze-v7.2` → `966d511`, untouched.
- Baseline at the tag: 25 files passed, 3 skipped; **203 passed, 3 skipped**.
- Branch `feature/v8-agent-commerce-adapter` (additive `lib/agent-commerce/*` + one test file, no existing file modified): **206 passed, 3 skipped**.

## Fresh-clone run

A `git clone` of c12581f into an empty temp directory, with the PayPal and catalog variables unset: `npm ci`, then 51/51 tests pass, typecheck and build succeed, and `demo:e2e` completes (the $6,000 attempt is HOLD / AMOUNT_EXCEEDED, the $59.39 checkout reaches COMPLETED on MOCK).

## Private V7 research adapter through the V8 engine

The V7 listing was fed through the V8 `ProductIdentityResolver` and `MerchantOfferVerifier`. It used the real product title and the V7 manufacturer registry, plus an unpriced placeholder listing (no Channel3 call was made). Results:
- Identity: LOCKED (Sony WH-CH720N, Black, new, SKU null).
- Capability: `multipoint` verified as MANUFACTURER.
- Merchant comparison: 0 eligible offers, issues `AVAILABILITY_UNKNOWN` and `NO_MERCHANT_QUOTE`, so the result is HOLD.

The missing integration is a merchant checkout-quote source (final total with shipping, tax and inventory). Channel3 supplies search-time listing prices only.

## Not verified

Live PayPal Sandbox order/approval/capture; remote AI hosts (claude.ai connector, ChatGPT, Grok); live catalog/evidence research through the private adapter; multi-process concurrency; webhooks.
