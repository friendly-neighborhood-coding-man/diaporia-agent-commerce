# Test report

Run date: 2026-11-09, Windows 11, Node.js 24.22.1, vitest 5.1.0, TypeScript 7.0.2, MCP TypeScript SDK 1.32.2.
**Evidence class: MOCK / fixture data, executed locally,** except for the two live items marked below (the Claude Code CLI host test and the Sandbox OAuth preflight). No PayPal order, approval or capture has been made, and no live catalog or research call has been made.

## Automated suite (this repo)

`npm test` → **5 files, 69 passed, 0 failed, 0 skipped** (merchant identity round, 2026-11-09). Before that round: 4 files, 51 passed (commit c12581f). `npm run typecheck` clean, `npm run build` clean, `npm run demo:e2e` completes, `npm run scan:secrets` no findings.

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

## LIVE PayPal Sandbox E2E — run 1 (2026-11-09), owner-authorized, ONE order

**Evidence class: LIVE PayPal Sandbox. No real money moved.** Build `bb60b58`; MCP host Claude Code CLI 2.1.310 talking to `http://127.0.0.1:8790/mcp`; payments `PAYPAL_SANDBOX`; merchant: the fictional demo merchant alpha-audio.example (this was not a retail purchase). The owner configured the expected recipient, their Sandbox business Merchant ID and email, locally; these values are not recorded here.

| Step | Time (UTC) | Observed |
|---|---|---|
| Preflight | 09:44 | READY_FOR_SANDBOX_E2E (9/9). Sandbox OAuth HTTP 200; $6,000 under a $60 mandate → HOLD / AMOUNT_EXCEEDED with 0 PayPal calls |
| research → compare → prepare (via Claude Code, no mandate) | 09:46 | `cs_3a394e37…` APPROVAL_REQUIRED; 5939 USD (5499 + 0 + 440); intended payee = configured Merchant ID (`DIAPORIA_SANDBOX_PLATFORM_ACCOUNT`); no PayPal order |
| Owner GO; owner page submitted with a $60.00 single-use limit | 09:51:04 | Mandate reserved 5939; **one** order created, `9DL148415W2504835`; approval link host `www.sandbox.paypal.com/checkoutnow` |
| Owner approved as the Sandbox Personal buyer; PayPal returned to `127.0.0.1:8790/paypal/return` | 09:55:53 | The localhost return URL was accepted. Server GET order → `APPROVED`, amount and `custom_id` match → APPROVED |
| Pre-capture recipient check | 09:55:54 | **FAILED, MERCHANT_RECIPIENT_UNVERIFIED**: PayPal did not report the payee email configured for verification. **0 captures**; reservation released (mandate reserved 0, transactions_used 0) |
| Read-only diagnosis (GET order only) | ~09:58 | HTTP 200, status APPROVED, intent CAPTURE, amount 59.39 USD, captures 0. `payee` keys: `merchant_id`, `display_data`. **merchant_id equals the configured Merchant ID**; no `email_address` field |
| Status + receipt via Claude Code | ~10:00 | FAILED / MERCHANT_RECIPIENT_UNVERIFIED; captureId null; paymentResult null; merchantOrder NOT_VERIFIED; audit chain ends BUYER_APPROVAL_VERIFIED → CHECKOUT_FAILED |

**Result: no payment completed.**
- The fail-closed path worked: buyer approval was verified but there was no capture, and no replacement order was created.
- Root cause: a design assumption that did not hold. When an order is created with `payee.merchant_id` only, PayPal's order GET returns `merchant_id` but **not** `email_address`. The email binding therefore could never be satisfied.
- The authoritative recipient check, the merchant id, was satisfied according to the real PayPal data.

Follow-up code changes (not yet live-tested):
- The merchant id stays mandatory.
- A configured email must match **if PayPal reports one**. If PayPal reports none, this is recorded as `RECIPIENT_EMAIL_NOT_REPORTED`.
- `buyerApprovalVerified` now stays true after a post-approval failure.

Order `9DL148415W2504835` remains APPROVED and uncaptured in Sandbox. DIAPORIA will not capture it, because its checkout is terminal (FAILED).

Idempotency observations:
- One `PayPal-Request-Id` was used for the create call, and exactly one order exists.
- No capture request was sent.
- The buyer return was processed once.

## LIVE PayPal Sandbox E2E — run 2 (2026-11-09), owner-authorized, ONE new order

**Evidence class: LIVE PayPal Sandbox. No real money moved.**
- Build `ca51567`. MCP host: Claude Code CLI talking to `http://127.0.0.1:8790/mcp`. Payments ran in `PAYPAL_SANDBOX` mode.
- Merchant: the fictional demo merchant alpha-audio.example. This was not a retail purchase.
- Run 1's order `9DL148415W2504835` was not captured or retried, and its unused run-1 mandate was revoked before run 2.

| Step | Time (UTC) | Observed |
|---|---|---|
| research → compare → prepare via Claude Code, no mandate | 10:08:50 | `cs_7d85cbb3…` APPROVAL_REQUIRED, 5939 USD. Intended payee = configured Merchant ID. No order yet |
| Owner page with a fresh $60.00 single-use limit | 10:09:21 | Mandate reserved 5939. **One** order created: `99X21669LS4807358` |
| Buyer approval (owner, Sandbox Personal account), then return to localhost | 10:10:27 | GET order returned APPROVED with matching amount, currency and `custom_id`, so the checkout moved to APPROVED |
| Pre-capture recipient check | 10:10:28 | Merchant identity re-check MATCH, using a fresh MOCK attestation bound to this checkout. PayPal reported `payee.merchant_id` = configured ID (**PAYMENT_PROVIDER** provenance). No email reported, so `RECIPIENT_EMAIL_NOT_REPORTED` was recorded |
| Capture (one request, one `PayPal-Request-Id`) | 10:10:28–29 | Capture `92U85747JU359434A`, status **PENDING**, reason **PENDING_REVIEW**. Checkout moved to CAPTURE_PENDING |
| Read-only PayPal GET of the order and the capture | ~10:12 | Order **COMPLETED** (PayPal's order status after capture), amount 59.39 USD, payee merchant id matches, **exactly 1 capture**. Capture: PENDING / PENDING_REVIEW, 59.39 USD, final_capture true |
| Server reconcile (provider reads only, no new capture) | ~10:13 | Still CAPTURE_PENDING. Recipient verified (PAYMENT_PROVIDER). Uncertainty: "Provider has not confirmed final settlement" |
| Status + receipt via Claude Code | ~10:14 | CAPTURE_PENDING, 5939 USD, capture `92U85747JU359434A` PENDING. `paymentResult` null. merchantOrder NOT_VERIFIED. The audit chain ends with CAPTURE_REQUESTED → CAPTURE_PENDING → RECONCILED → CAPTURE_PENDING |

**Result:**
- **Payment captured but not settled.** PayPal holds the Sandbox capture in `PENDING_REVIEW`. DIAPORIA correctly reports `CAPTURE_PENDING`, not COMPLETED, and the mandate reservation is held, not consumed, until PayPal settles.
- **Verified live:** amount and currency, order ownership (`custom_id`), buyer approval, the recipient merchant id (authoritative PayPal data), exactly one capture, no replacement order, and a pending capture distinguished from a completed one.
- **Not verified live:** a COMPLETED capture. Merchant fulfillment does not apply, because the merchant is a fictional demo merchant.

Notes:
- PayPal reports the order as `COMPLETED` once a capture exists, even while that capture is `PENDING`. DIAPORIA keys on the capture status.
- The pre-capture attestation id differs from the one bound at prepare by design: each re-check requests a fresh attestation bound to the same checkout, payee and legal entity.

## Merchant identity (MOCK providers only)

`tests/merchant-identity.test.ts` (14 tests) covers the following. All of it is MOCK evidence.
- KR check digit and US EIN normalization; a well-formed, registered number with no attestation stays UNKNOWN.
- Valid merchant: both layers MATCH, provenance MOCK, identifier masked.
- Stolen registration details: legal entity MATCH, payment relationship MISMATCH.
- Inconsistent legal entity: name, jurisdiction, bad check digit, closed registration, payee of another entity.
- Altered merchant id, at verification and at prepare.
- Stale attestation gives UNKNOWN; revoked gives MISMATCH; registry outage gives UNKNOWN.
- Re-check rejects an attestation bound to another payee or entity.
- Through MCP:
  - The cheaper impersonator is rejected at compare.
  - prepare binds the business, offer, payee and attestation into the summary.
  - Capture pays exactly the bound recipient.
  - A recipient substituted after approval fails closed with 0 captures and the reservation released.
  - An attestation that goes stale before capture fails closed.
  - Revocation between compare and prepare is rejected.
- Sandbox platform-payee mode, using a test double with no network: an unconfigured payee is rejected; a configured payee is bound as `DIAPORIA_SANDBOX_PLATFORM_ACCOUNT`.
- The mandate, budget and idempotency protections are unchanged.

`npm run demo:identity` runs a valid merchant against the impersonator, then a recipient substitution, then a clean capture. No official registry and no PayPal identity attestation was contacted.

**Sandbox payee binding (follow-up):** when the Sandbox provider is used, the order payee that PayPal reports (`payee.merchant_id`, plus `payee.email_address` if `PAYPAL_SANDBOX_PAYEE_EMAIL` is set) must equal the configured Sandbox business account. Otherwise the checkout fails closed before capture. Tests:
- Mock-provider double: another merchant id, another email, payee not reported, and email not reported each end in FAILED with no capture. The control case (same id, email differing only in case) captures exactly once.
- Real `PayPalSandboxProvider` over fake PayPal HTTP, where the order payee is `ATTACKERBIZ0001`: FAILED / MERCHANT_RECIPIENT_MISMATCH, with 0 capture calls.

**Sandbox preflight after this change:** `NOT_READY`, only because `PAYPAL_SANDBOX_PAYEE_MERCHANT_ID` (DIAPORIA's own Sandbox business account merchant id) is not configured. The other 7 checks pass. The Sandbox OAuth call returned HTTP 200 again; no order was created.

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

a live Sandbox capture reaching **COMPLETED** (run 2 captured once but PayPal holds it in PENDING_REVIEW; order creation, approval, return, recipient check and capture were observed live); remote AI hosts (claude.ai connector, ChatGPT, Grok); live catalog/evidence research through the private adapter; multi-process concurrency; webhooks.
