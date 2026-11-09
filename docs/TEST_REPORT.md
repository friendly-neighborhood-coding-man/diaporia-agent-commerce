# Test report

Run date: 2026-11-09, Windows 11, Node.js 24.22.1, vitest 5.1.0, TypeScript 7.0.2, MCP TypeScript SDK 1.32.2.
**Evidence class: MOCK / fixture data, executed locally,** except for the two live items marked below (the Claude Code CLI host test and the Sandbox OAuth preflight). No PayPal order, approval or capture has been made, and no live catalog or research call has been made.

## Automated suite (this repo)

`npm test` → **5 files, 69 passed, 0 failed, 0 skipped** (merchant identity round, 2026-11-09). Before that round: 4 files, 51 passed (commit 0ee639b). `npm run typecheck` clean, `npm run build` clean, `npm run demo:e2e` completes, `npm run scan:secrets` no findings.

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

**Evidence class: LIVE PayPal Sandbox. No real money moved.** Build `7bab2e4`; MCP host Claude Code CLI 2.1.310 talking to `http://127.0.0.1:8790/mcp`; payments `PAYPAL_SANDBOX`; merchant: the fictional demo merchant alpha-audio.example (this was not a retail purchase). The owner configured the expected recipient, their Sandbox business Merchant ID and email, locally; these values are not recorded here.

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
- Build `421693f`. MCP host: Claude Code CLI talking to `http://127.0.0.1:8790/mcp`. Payments ran in `PAYPAL_SANDBOX` mode.
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

A `git clone` of 0ee639b into an empty temp directory, with the PayPal and catalog variables unset: `npm ci`, then 51/51 tests pass, typecheck and build succeed, and `demo:e2e` completes (the $6,000 attempt is HOLD / AMOUNT_EXCEEDED, the $59.39 checkout reaches COMPLETED on MOCK).

## Private V7 research adapter through the V8 engine

The V7 listing was fed through the V8 `ProductIdentityResolver` and `MerchantOfferVerifier`. It used the real product title and the V7 manufacturer registry, plus an unpriced placeholder listing (no Channel3 call was made). Results:
- Identity: LOCKED (Sony WH-CH720N, Black, new, SKU null).
- Capability: `multipoint` verified as MANUFACTURER.
- Merchant comparison: 0 eligible offers, issues `AVAILABILITY_UNKNOWN` and `NO_MERCHANT_QUOTE`, so the result is HOLD.

The missing integration is a merchant checkout-quote source (final total with shipping, tax and inventory). Channel3 supplies search-time listing prices only.

## Not verified

a live Sandbox capture reaching **COMPLETED** (run 2 captured once but PayPal holds it in PENDING_REVIEW; order creation, approval, return, recipient check and capture were observed live); remote AI hosts (claude.ai connector, ChatGPT, Grok); live catalog/evidence research through the private adapter; multi-process concurrency; webhooks.


## Payment lifecycle hardening round (2026-11-09, afternoon)

### Phase 0 — LIVE read-only Sandbox reconciliation (12:58 UTC)

Two calls were made, both read-only: `GET /v2/payments/captures/92U85747JU359434A` and `GET /v2/checkout/orders/99X21669LS4807358`. No mutation of any kind.

- **Capture `92U85747JU359434A`:** `PENDING`, `status_details.reason` `PENDING_REVIEW`, 59.39 USD, `final_capture` true, payee merchant id matches the configured account, related order matches. `create_time` and `update_time` are both 2026-11-09T10:10:28Z, so it is **unchanged since run 2**.
- **Order `99X21669LS4807358`:** `COMPLETED` (intent CAPTURE), 59.39 USD, payee matches, exactly one capture (the one above, PENDING).
- **DIAPORIA:** checkout `cs_7d85cbb3…` is `CAPTURE_PENDING` (PENDING / PENDING_REVIEW, 5939 USD). The mandate is ACTIVE with 5939 reserved and 0 consumed. This is consistent with PayPal.
- The "On hold" label in the Sandbox business UI was not used as evidence. A funds hold is not a capture status.

### Automated suite

`npm test` gives **6 files, 84 passed, 0 failed**, run twice. `tests/payment-lifecycle.test.ts` adds 15 **simulated** cases (mock provider and locally signed webhook fixtures):
- pending contract
- PENDING→COMPLETED
- PENDING→DENIED
- PENDING→PENDING
- simulated COMPLETED vs provider PENDING, and stale events after completion
- duplicate delivery
- forged, foreign-cert, stale and unauthenticated webhooks
- wrong capture id or merchant id
- provider/local conflicts
- restart while pending
- provider timeout with bounded retries
- refund after completion
- the "On hold" independence case
- no new attempt, cross-user and secret leakage checks
- public route closure

Typecheck, build, `demo:e2e`, `demo:identity` and the secret scan are clean. Compiled-server localhost smoke on :8795 with mock payments:
- `/healthz` reports `paymentEnvironment MOCK`.
- MCP `tools/list` returns the 5 tools.
- Unauthenticated `/mcp` returns 401.
- `/paypal/webhook` without a configured webhook id returns 503.

### Not verified live in this round

A real PayPal webhook delivery, a real Sandbox capture transitioning out of `PENDING_REVIEW`, and refunds. No Sandbox order, capture, refund or other mutation was made.


## Merchant Quote V0 round (2026-11-09, branch `feature/merchant-quote-v0`)

**Evidence class: SYNTHETIC FIXTURES only.** No Shopify store was contacted, because none is configured on this machine. No PayPal call and no order were made. Payment engine and historical Sandbox records are untouched.

- **Schema:** Storefront API version and schema were read from shopify.dev on 2026-11-09: api_version 2026-10, `cartCreate`, `cartDeliveryAddressesAdd`, `cartSelectedDeliveryOptionsUpdate`, `CartCost` (`subtotalAmount`, `subtotalAmountEstimated`, `totalAmount`, `totalAmountEstimated`; tax and duty fields deprecated), `CartDeliveryGroup` / `CartDeliveryOption`, `checkoutUrl`, `THROTTLED` as HTTP 200.
- **Suite:** `npm test` gives **7 files, 98 passed, 0 failed**. `tests/merchant-quote.test.ts` adds 14 tests:
  - request shape
  - variant match and mismatch
  - unavailable variant
  - destination missing
  - multiple rates
  - estimated or undetermined total
  - estimate vs verified, ineligible
  - currency mismatch
  - stale quote
  - total change between observations
  - GraphQL, user, HTTP and timeout errors
  - invalid checkout URL
  - fresh cart per quote with no cart secrets
  - an MCP flow with per-user carts and no PayPal order
- **Demos and smoke script:** `npm run demo:quote` (fixtures) shows discovery → `CART_ESTIMATE` $60.98 (estimated=false, tax not itemized) → external checkout handoff, while the lowest *verified* offer stays alpha-audio.example at $59.39. `npm run smoke:shopify` exits with setup instructions (not configured), so there is no live evidence.
- **Not verified:** any real Shopify response, including real field values, carrier-rate behavior, the checkout URL host for stores with custom domains, and throttling in practice.


## Integration & managed service foundation round (2026-11-10)

**Evidence class: MOCK only.** No Channel3, Tavily, KERNEL, Shopify or PayPal call was made. No PayPal billing object was created.

- **Merge.** `feature/merchant-quote-v0` (`ca8543d`) was reviewed against main: the only core changes are additive (quote evidence, availability from the merchant cart, and quoting of not-out-of-stock offers). It was fast-forwarded into local main, and 98/98 tests passed after the merge.
- **Suite.** `npm test` gives **8 files, 109 passed, 0 failed**. `tests/service-plane.test.ts` adds 11 tests:
  - router reuse and justified Tavily/KERNEL calls, with a second request making no new calls
  - the sufficiency rule
  - cost limit without skipping verification
  - provider timeout recorded as failed and not billed
  - dedupe and retries billed once
  - an estimate is not an invoice
  - per-request and monthly caps
  - restart retry under the same logical key
  - community without billing
  - managed denied without ACTIVE billing, before provider calls
  - forged billing webhook rejected; duplicate applied once
  - billing outage fails closed
  - cross-user usage isolation
  - billing vs purchase-mandate separation in both directions
  - managed mode refused without production auth or on a non-loopback URL
  - provider keys never in outputs, records or serialization
- **Demo.** `npm run demo:service` shows the same flow in both community and simulated managed mode.
  - Tavily is called twice (Lumen ANC listing claim, Contoso missing ANC evidence) and KERNEL once (Lumen page). Products with manufacturer evidence get no extra calls.
  - The managed simulation produces a `DRAFT_NOT_INVOICED` mock billing summary.

## Live evidence & submission gate round (2026-11-09/10)

### Phase A: bounded LIVE provider smoke (`scripts/live-smoke.ts --confirm-live`, started 2026-11-09T15:45:38Z)

**Budget, set before execution and enforced by the ledger's per-request call caps:**
- Channel3: at most 1 search
- Tavily: at most 2 searches
- KERNEL: at most 1 page
- Supplier prices recorded as UNKNOWN (NULL), never 0

**Credentials:** `CHANNEL3_API_KEY` came from the private V7 env file, and `TAVILY_API_KEY` was present in the machine environment. No public KERNEL adapter exists, so KERNEL was unavailable.

**Calls made: 1 Channel3 search and 1 Tavily search. Nothing else live.** No checkout and no PayPal call.

**Observations** (raw, sanitized: `docs/evidence/live-smoke-2026-11-09.json`):
- **Channel3** (query "Sony WH-CH720N", limit 10): the only candidate with an exact model token and the colour Black was "Sony WH-CH720N Wireless Noise Cancelling Headphone Black w/ Pro Stand Kit". **Defect:** a bundle was locked as the exact product.
- **Merchant listings:** 21 Channel3 listings (bestbuy.com, cdw.com, bhphotovideo.com, sweetwater.com, …) had no colour in the title, so `IDENTITY_MISMATCH_VARIANT` applied. Channel3 has no merchant quote (`NO_MERCHANT_QUOTE`), and the outcome was **HOLD**. Correct: listing prices are not checkout totals.
- **Tavily** (`"Sony WH-CH720N" noise cancelling review`): 10 results. The router concluded `CONTRADICTED`, which is **wrong**: the negation rule treated any "not/no" in a sentence (for example "not as strong as") as a denial. The candidate correctly stayed `NEEDS_VERIFICATION`; the defect never made a product purchase-ready.
- **Repeat of the same request:** 0 new Channel3 calls and 0 new Tavily calls. Stored evidence and the cached query were reused.
- **Ledger:** 2 records (`CHANNEL3:search`, `TAVILY:search`), both `BYOK_LIVE`, `unknownCostRecords: 2`, `supplierCostComplete: false`, 0 billable (community mode).

**Fixes after the live run, offline-tested in `tests/live-adapters.test.ts`, not re-run live:**
- Bundle and kit titles become `variant: "<colour> BUNDLE"` and are never the exact product.
- Negation must govern the capability phrase.
- `CONTRADICTED` results are labelled `CONTRADICTED_EVIDENCE_NEEDS_REVIEW`.
- Routing output now includes each claim's URL and statement.

### Phase B: ledger correctness

The ledger was moved to v2:
- supplier cost is kept when the service fails, and billing happens only on delivered service (`settleRequest` / `abandonRequest`);
- unknown prices are NULL, and unpriced providers require call caps;
- price-book versions are immutable;
- retries are billed once;
- caps are checked in IMMEDIATE transactions.

Evidence independence now counts subdomains of one site, and syndicated copies of one statement on other domains, as a single source.

### Suite

`npm test` gives **9 files, 114 passed, 0 failed**.


## Corrective live verification (2026-11-09 16:05 UTC, owner-approved budget: at most 1 Channel3 and 2 Tavily, no KERNEL, Shopify or PayPal, no retries)

**Live calls actually made: 1 Channel3 search and 1 Tavily search.** Hard total caps were enforced in the scripts.

- **Defect 1 (bundle as exact product): FIXED on real data.** `live-smoke-2026-11-09-16-05-08.json`
  - Channel3 returned 9 WH-CH720N listings; the "Black w/ Pro Stand Kit" listing became variant `Black BUNDLE`.
  - No standalone listing named the colour, so identity was `NOT_FOUND`, giving **HOLD**. Purchase safety rules are unchanged.
  - The repeated request made **0** new calls. Tavily was not called in this script because there was no locked candidate.
- **Defect 2 (comparative phrase read as absence): FIXED on real data.** `live-evidence-check-2026-11-09-16-05-42.json`
  - One Tavily search for the exact model's ANC claim returned 8 positive claims from 8 hosts: `SUFFICIENT_TRUE`.
  - soundguys.com's "The noise canceling isn't the very best, but it performs relatively well." was correctly read as **positive**.
  - The repeat used stored evidence: **0** new calls.
- **New finding:** amazon.com (a retailer) was among the counted sources. Retailer and marketplace domains are now excluded from independent evidence (tested offline, not re-run live). Without amazon.com the claim remains sufficient from editorial review sites. reddit.com is still counted; it is user-generated.
- **Ledger:** both runs recorded `BYOK_LIVE` usage with **unknown** supplier cost (not 0) and 0 billable.
- **Suite:** `npm test`: **9 files, 115 passed, 0 failed**.

## BYOK Completion V1 round (2026-11-10, branch `feature/byok-completion-v1` from `main` @ `280e869`)

**Evidence classes:** live MCP host calls (four local hosts) with MOCK commerce data; everything else MOCK or fake-HTTP. No PayPal order, capture or refund. No Channel3, Tavily, KERNEL or Shopify call.

- **KERNEL BYOK adapter** (`src/evidence/KernelPageInspector.ts`, `tests/kernel-inspector.test.ts`, 21 tests, fake HTTP only): create, execute and delete lifecycle; key sent only to the API host and never in errors or JSON; delete after execution failure and after the total deadline; per-process session cap; URL and DNS policy refused before any request; zero statements for off-model, redirected, HTTP 4xx, challenge, empty, navigation-failed, malformed or silent pages; explicit negation recorded as false. Router integration: a refused URL costs nothing, an inspection is metered as `KERNEL / browser_second` with measured quantity, `BYOK_LIVE` provenance and unknown (`NULL`) price; cached pages are reused without a new session; a per-request cap of 0 gives `BLOCKED_BY_LIMIT` with the capability left `INSUFFICIENT`; transient outcomes are not cached.
- **Payment vs merchant order vs fulfillment:** `purchaseOutcome` on `get_checkout_status` and `get_purchase_receipt`, asserted in `tests/mcp-e2e.test.ts` after a MOCK completed capture (`merchantOrderConfirmation: NOT_CONFIRMED`, `fulfillment: NOT_VERIFIED`, `merchantPurchaseComplete: false`); server instructions and the buyer return page say the same (`tests/mcp-instructions.test.ts`). Payment and mandate state machines unchanged.
- **Four-host two-step workflow (LIVE hosts, MOCK data):** Claude Code 2.1.310, Codex CLI 0.160.0, Grok Build 1.0.77 and Hermes Agent 0.22.7 each made exactly one `research_purchase` and one `compare_purchase_offers` call: **4/4 PASS**, identical results; unauthenticated request 401; cross-host session probe `NOT_FOUND`. Details in `docs/INTEROP.md`. Grok's xAI cost: $0.16.
- **Not tested in this round:** any live KERNEL call (paid; needs owner approval), `prepare_checkout` or status tools through the four hosts, remote hosts.
