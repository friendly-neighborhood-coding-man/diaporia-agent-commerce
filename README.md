# DIAPORIA Agent Commerce

**Don't switch AI assistants to shop. Bring secure purchasing to the AI you already use.**

A cross-platform AI purchasing engine with evidence-based product research, bounded checkout authorization, and PayPal Sandbox integration. Built for MCP-enabled assistants.

> **MVP integration status (2026-11-10):** see [docs/MVP_IMPLEMENTATION_STATUS.md](docs/MVP_IMPLEMENTATION_STATUS.md) for what is implemented, MOCK-verified, live-verified and blocked, and run `npm run dogfood` for the end-to-end scenarios. Mission and invariants: [docs/MISSION.md](docs/MISSION.md).

## Free judge evaluation (no paid API keys)

**Judges can run DIAPORIA Buy's core purchasing demonstration for free.** No personal API keys, paid subscriptions, PayPal account, or external service credentials are required for this offline MOCK evaluation.

Requirements: **Node.js 22.13+** and npm. The initial `npm ci` installs dependencies and may require internet access; the demo itself makes no live provider calls.

```bash
git clone https://github.com/friendly-neighborhood-coding-man/diaporia-agent-commerce.git
cd diaporia-agent-commerce
npm ci
npm run demo:full
```

The demo exercises the actual MCP purchasing workflow against fictional product catalogs, merchant quotes and registries, scripted DEMO-ONLY owner/buyer steps, and **MOCK payments (no PayPal API calls or real money)**. It writes auditable traces under `demo-output/` and fails if its checks do not pass. The demo does **not** establish a real merchant order or fulfillment.

**Optional integrations, not required for judging:**
- **PayPal Sandbox:** The separate Orders v2 adapter and recorded Sandbox test evidence are documented in [TEST_REPORT.md](docs/TEST_REPORT.md). Reproducing live Sandbox calls requires the tester's own free PayPal developer Sandbox credentials; the offline demo does not.
- **Channel3 and Tavily:** Optional BYOK search/evidence adapters, disabled by default. No paid provider account is necessary for the offline demo.
- **Browser panel:** See [BUY_PANEL.md](docs/BUY_PANEL.md) for local browser UI setup and its separate MOCK session.

For the scope of proven capabilities and limitations, see [Submission Notes](docs/SUBMISSION.md) and [Hackathon Demo Guide](docs/HACKATHON_DEMO.md). **MOCK success is not claimed as a completed PayPal Sandbox transaction or merchant purchase.**

## In 30 seconds

Any MCP client (Claude, ChatGPT, Grok, others) calls five tools on this server:

```
research_purchase → compare_purchase_offers → prepare_checkout → (user approves on PayPal) → get_checkout_status / get_purchase_receipt
```

- The **server** owns product identity, merchant totals, spending limits, payment state and idempotency. The AI only passes requests along.
- **No AI tool can move money.** A purchase needs a spending **mandate** created by the human (with an owner key the AI never holds) **and** the buyer's own approval on PayPal's hosted page.
- A `$6,000` checkout against a `$60` mandate is rejected **before** any PayPal call (see `npm run demo:e2e`, step 4).
- Unknown shipping or tax stays **unknown**; such offers are never ranked as "cheapest". Variant or condition substitutions are refused.
- Merchant and review text is treated as untrusted data; listings that try to instruct the agent are excluded.

## See it work in one command

```bash
npm ci && npm run demo:full
```

An AI host connects over MCP and runs three scenarios end to end, offline, in about a second (no keys, no network, no money):

1. **Discovery to receipt.** "wireless headphones under $150 with multipoint and a lanyard loop" becomes structured requirements. Research verifies each MUST requirement from the manufacturer's own page, rejects the cheaper model whose maker says it has no lanyard loop, excludes the bundle, and flags a listing that tries to instruct the AI. It then locks the exact product and verifies merchant identity, rejecting a look-alike domain. It compares verified checkout totals, not search prices. The AI prepares a checkout it cannot pay for; the owner sets a limit on the owner page; the buyer approves on the MOCK PayPal page. The result is a server-verified status and a receipt with the full audit trail.
2. **A requirement nobody can verify.** "it must fold flat into a slim case" stays an open MUST requirement (INVESTIGATE, never RECOMMEND). The AI can only propose an attestation. The owner confirms it with a passkey, and the ledger records `OWNER_ATTESTED`, never `VERIFIED`.
3. **Unsafe purchases blocked.** The A9 is requested but only the A9 Pro exists, so it is never substituted. A misled AI's $10,000 budget is ignored in favour of the user's $150. A forged "the owner already approved" statement changes nothing.

Each run writes `demo-output/<run>/trace.json`, `transcript.md` and a SHA-256 of the trace, and exits non-zero if any step misbehaves. The human steps are played by a scripted demo owner with DEMO-ONLY credentials generated for that run. This is a development simulation of a person, not real consent, and the trace says so. Payments are MOCK. Submission notes: [docs/SUBMISSION.md](docs/SUBMISSION.md).

## Status (what is real, what is not)

| Capability | Status |
|---|---|
| MCP server (`/mcp`, Streamable HTTP, stateless, official TypeScript SDK 1.32.2) with 5 tools, JSON-schema inputs/outputs, safety annotations | Implemented and tested (automated, real MCP client over HTTP) |
| PRODUCT_DISCOVERY and EXACT_PRODUCT_PURCHASE routing, identity locking, variant/condition mismatch rejection | Implemented and tested on fixtures |
| Merchant offer verification: stock, fresh quotes, total cost with unknowns, budget, eligibility | Implemented and tested on fixtures |
| PurchaseMandate: amount/currency/quantity/product/merchant binding, expiry, revocation, atomic cumulative reservation (SQLite `BEGIN IMMEDIATE` + CHECK constraints) | Implemented and tested |
| Checkout state machine with server-side transition guards, duplicate-capture prevention, UNKNOWN + reconciliation | Implemented and tested with the mock provider |
| Mock PayPal provider (offline, every id prefixed `MOCK`) | Implemented and tested |
| Live PayPal Sandbox checkout | **Run 2 (2026-11-09): one order, one capture, recipient verified from PayPal data; capture still `PENDING / PENDING_REVIEW`** (re-read 12:58 UTC). A Sandbox capture reaching `COMPLETED` has not been observed |
| Capture reconciliation (Payments v2 GET, restart recovery, bounded read retries, monotonic states incl. REFUNDED) | Implemented; transitions **mock-tested**; live use limited to read-only GETs of the run-2 capture |
| PayPal webhooks (`PAYMENT.CAPTURE.PENDING/COMPLETED/DENIED/REFUNDED/REVERSED`), signature verification, dedupe | Implemented; **simulated only** (locally signed fixtures). No webhook registered, no public listener, no real delivery tested |
| MCP payment status contract (`paymentStatus`, pending details, next action, new-attempt prohibition, merchant order vs payment) | Implemented and tested (mock) |
| PayPal Sandbox Orders v2 adapter (CAPTURE intent, `PayPal-Request-Id`, Sandbox host only) | Implemented; unit-tested with a fake `fetch`; **live Sandbox use: 2 owner-approved runs** (see the Sandbox checkout row above and docs/TEST_REPORT.md) |
| Real MCP host: Claude Code CLI → localhost | **Tested** (discovery, research → compare → prepare → status, $6,000 refusal, cross-user and scope boundaries; mock payments). See docs/HOST_TEST_EVIDENCE.md |
| Local MCP hosts: Claude Code, OpenAI Codex CLI, xAI Grok Build, Nous Hermes Agent | **Tested, 4/4 PASS** on localhost with MOCK data (see docs/INTEROP.md) |
| Remote hosts: claude.ai connector, ChatGPT, Grok | **Not tested.** OAuth now exists (row below), but no public HTTPS endpoint is deployed. A public OAuth deployment offers research and read tools only |
| Remote MCP authentication (OAuth 2.1) | **Implemented, offline-verified** (`DIAPORIA_AUTH_MODE=oauth`): RFC 9728/8414 discovery, dynamic registration, PKCE S256, audience-bound tokens, refresh rotation, revocation. The official MCP SDK client completes the flow in tests. Owner-key login stands in for a real identity provider. Not deployed; no remote host connected. See [docs/REMOTE_MCP_AUTH.md](docs/REMOTE_MCP_AUTH.md) |
| Live product research (catalog search, independent evidence) | **BYOK adapters for Channel3 (catalog) and Tavily (independent evidence)**, off by default. Bounded live smoke only (see Live evidence status below). Listing prices are never treated as checkout quotes. Without keys, all research is MOCK |
| Merchant identity verification (registry + recipient attestation) | **MOCK providers only**: workflow implemented and mock-tested; no official registry or PayPal attestation integrated (see below) |
| Merchant order confirmation / fulfillment / shipping | Not provided and never claimed. A completed capture is reported as payment only (`purchaseOutcome.merchantPurchaseComplete: false`). Sandbox payments go to DIAPORIA's own Sandbox test account; the demo merchants are fictional |
| PayPal Agent Ready, Store Sync | Not integrated (see roadmap below) |

## Quick start (no keys, no network)

Requires Node.js 22.13+ (uses the built-in `node:sqlite`).

```bash
npm ci
npm test            # all automated mock and offline integration tests
npm run typecheck
npm run demo:full   # research → evidence → identity → verified total → owner approval → MOCK checkout → receipt, plus blocked unsafe purchases
npm run demo:e2e    # full MCP purchase path on the fixture catalog, all MOCK
npm run demo:identity  # valid merchant vs impersonator, all MOCK
npm run demo:quote     # discovery → Shopify cart estimate → external checkout handoff (fixtures)
npm run demo:service   # evidence routing + usage ledger, community vs simulated managed billing (all MOCK)
npm run demo:subscription  # managed subscription billing against a fake PayPal: subscribe once, allowance, replay, cancel (all MOCK)
```

Run the server:

```bash
npm run dev         # http://127.0.0.1:8790/mcp, mock payments, the AI-client token is written to .data/dev-credentials.json
```

Run this way (as your own account, the one your AI host also uses), the server offers research and comparison only: payment-facing operations stay disabled until DIAPORIA runs under its own OS account (docs/SETUP.md, "Service account"; V2.2). `.data/dev-credentials.json` holds the AI client's token only. Owner credentials (owner key and passkey) are never written there: the human owner enrolls them in a protected owner registry from a separate OS account (docs/SETUP.md, "Owner confirmation"). Until then every owner page refuses, and research holds cannot be confirmed.

Create a spending mandate as the human owner (in a second terminal, typing your owner key when asked):

```bash
npm run mandate:create -- --brand Sony --model WH-CH720N --variant Black --sku WHCH720N/B --max 60.00
```

Then point an MCP client at `http://127.0.0.1:8790/mcp` with header `Authorization: Bearer <clientToken from .data/dev-credentials.json>`. Without a mandate, `prepare_checkout` returns a `userAuthorizationUrl` where the owner can review the checkout and set a limit.

To use PayPal Sandbox instead of the mock, set `PAYMENT_PROVIDER=paypal_sandbox` and Sandbox REST credentials (see `.env.example`). Live credentials are refused by construction.

Every research, compare, prepare, status and receipt result carries `paymentEnvironment` (`MOCK` = no PayPal API at all, `PAYPAL_SANDBOX` = PayPal test environment) and `liveMerchantCheckout: false`. Live PayPal and live merchant checkout are not supported.

## Browser Checkout Handoff V0 (KERNEL)

This is a separate path for real merchants that DIAPORIA does not pay. It works in four steps:

1. An isolated browser prepares the cart on an authorized merchant's own website.
2. It captures the displayed total, shipping, tax and any unknowns, then stops before payment.
3. The human takes over the same browser through an owner-authenticated, short-lived page and uses the merchant's own PayPal button.
4. Only authenticated seller-side confirmation yields `ORDER_CONFIRMED`.

Phase A (offline fixture) and Phase B (**one owner-approved, live KERNEL session proving a synthetic same-browser popup**) are verified. Phase C, which requires the **actual PayPal Sandbox button and buyer login**, remains **NOT RUN** live; its controlled test merchant and offline (C0) tests exist ([docs/PHASE_C_TEST_MERCHANT.md](docs/PHASE_C_TEST_MERCHANT.md), [operator checklist](docs/PHASE_C_OPERATOR_CHECKLIST.md)). The integrated code now requires a reviewed exact-host KERNEL egress allowlist for real merchant recipes, plus explicit browser opt-in, and implements a best-effort independent 10-minute cleanup watchdog. Network/IP isolation and crash recovery remain unverified in the real KERNEL environment. See [docs/BROWSER_CHECKOUT_HANDOFF.md](docs/BROWSER_CHECKOUT_HANDOFF.md), [the security review](docs/HANDOFF_SECURITY_REVIEW.md) [the host matrix](docs/HANDOFF_HOST_MATRIX.md) and [the Phase C approval runbook](docs/PHASE_C_RUNBOOK.md).

## Architecture

```
AI client (Claude / ChatGPT / Grok / any MCP client)
  → /mcp (Streamable HTTP, per-request server bound to one authenticated user)
  → CommerceGateway
      PurchaseIntentRouter · ProductIdentityResolver · CommerceResearchAdapter (port)
      MerchantOfferVerifier · PurchasePolicyEngine + PurchaseMandate
      CheckoutSessionManager (durable state machine) · PurchaseAuditJournal (hash-chained)
  → PaymentProvider port: MockPayPalProvider | PayPalSandboxProvider (Orders v2)
  → buyer approves on PayPal → /paypal/return → server verifies with PayPal, captures once, re-reads capture
  → get_checkout_status / get_purchase_receipt return server-verified state
```

Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · [docs/MCP_TOOLS.md](docs/MCP_TOOLS.md) · [docs/PURCHASE_POLICY.md](docs/PURCHASE_POLICY.md) · [docs/PAYPAL_INTEGRATION.md](docs/PAYPAL_INTEGRATION.md) · [docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md) · [docs/TEST_REPORT.md](docs/TEST_REPORT.md)

## Security model

- AI-client tokens carry `purchase.research`, `purchase.read`, `purchase.prepare`. No scope can create a mandate or capture funds.
- Owner keys (held by the human) create and revoke mandates via `/owner/mandates` or the `/authorize/<checkout>` page (cookie + CSRF, SameSite=Strict).
- Every lookup is scoped by the authenticated user; another user's session returns `NOT_FOUND`.
- Payment execution is enabled only when auth mode is `dev` or `oauth`, the server binds to loopback, and the public base URL is loopback. Anything else returns `HOLD / PUBLIC_PAYMENT_DISABLED`.
- Host-header and Origin allowlists (DNS-rebinding protection), 64 KiB body limit, per-token rate limits, 30 s request timeout.
- PayPal credentials stay server-side; errors carry only HTTP status and PayPal debug id; audit records are redacted.
- Known gaps: OAuth is implemented but not deployed (owner-key login stands in for an identity provider), in-memory rate limiter and owner-page sessions (single process), no webhook listener (status comes from synchronous verification and explicit reconciliation).

Credentials needed for anything beyond the mock demo: PayPal Sandbox REST app (`PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`) for the Sandbox path, and a public HTTPS tunnel or host for remote AI clients.

## Live evidence status (2026-11-09)

| Integration | Live-tested | Result |
|---|---|---|
| Claude Code CLI as MCP host (localhost) | ✓ | Discovery, research, compare, prepare and status; $6,000 refusal; cross-user and scope boundaries |
| Four local MCP hosts: Claude Code, Codex CLI, Grok Build, Hermes Agent | ✓ | 2026-11-09: all four **PASS** `research_purchase`. 2026-11-10: all four **PASS** the two-step `research_purchase` → `compare_purchase_offers` workflow. Real host-originated calls over Streamable HTTP, identical results, per-host attribution, and a cross-host session probe refused. Host interop is live; the commerce data is MOCK fixtures and no payment tool was offered. See [docs/INTEROP.md](docs/INTEROP.md) |
| PayPal Sandbox order, buyer approval, recipient check, capture | ✓ (2 runs) | Run 1 failed closed before capture. Run 2: one capture, still `PENDING / PENDING_REVIEW` |
| Channel3 product discovery | ✓ (2 calls total) | First run wrongly locked a "w/ Pro Stand Kit" bundle as the exact product. After the fix, the corrective run marked it `BUNDLE`; no standalone listing named the colour Black, so identity was `NOT_FOUND`, giving HOLD. Listing prices are never checkout quotes |
| Tavily independent search | ✓ (2 calls total, 2026-11-09) | First run: a false contradiction from an over-broad negation rule. After the fix, a corrective run found Sony WH-CH720N ANC `SUFFICIENT_TRUE` from independent review sites; a comparative "isn't the very best" sentence was read correctly. A retailer page (amazon.com) was counted as independent, so retailer and marketplace domains are now excluded (fixed offline) |
| KERNEL page inspection | — | BYOK adapter implemented and fake-HTTP tested; **no live call made** (paid; needs owner approval) |
| Shopify Storefront Cart | — | Fixtures only |
| Production OAuth deployment, managed billing, merchant orders | — | OAuth implemented offline only; billing MOCK only; merchant orders not integrated |

Raw evidence (sanitized) is in `docs/evidence/`. Setup is in [docs/SETUP.md](docs/SETUP.md), and the judge walkthrough is in [docs/HACKATHON_DEMO.md](docs/HACKATHON_DEMO.md).

## Community and managed service foundation

DIAPORIA stays host-neutral: users work through their own AI assistant, and there is no new shopping UI. See [docs/SERVICE_PLANE.md](docs/SERVICE_PLANE.md).

| Capability | Implemented | Mock-tested | Live-tested | Planned / blocked |
|---|---|---|---|---|
| Evidence Router: explicit sufficiency rule; existing evidence → Tavily → KERNEL only when needed; caching; limits never skip verification | ✓ | ✓ | Tavily: bounded smoke (2 calls); KERNEL: — | KERNEL live smoke (paid, awaiting approval); retailer exclusion offline-tested only |
| Usage Ledger: micro-USD supplier cost, cents billable, dedupe/retries billed once, per-request and monthly caps, estimate vs reconciled cost | ✓ | ✓ | Recorded live BYOK calls with cost **unknown** (not 0) | Real price book |
| Community mode: BYOK (Channel3, Tavily, KERNEL) or MOCK providers, no DIAPORIA billing | ✓ | ✓ | Channel3 and Tavily bounded smoke | KERNEL live smoke |
| Managed mode: server-owned keys, deny paid ops without ACTIVE billing, fail closed | ✓ (loopback **simulation only**) | ✓ | — | **Production authentication** (blocker) |
| Service billing context: plans, authorization, period summary, signed webhook | ✓ (**mock** PayPal Subscriptions) | ✓ | — | Superseded for managed mode by the subscription billing row below (kept as `MANAGED_BILLING=legacy-mock`) |
| Managed subscription billing V1: PayPal Subscriptions adapter (Sandbox-only, endpoint allowlist), lifecycle state machine, paid-period grants, allowance/cap enforcement inside the ledger transaction, PayPal-verified webhooks, replay/concurrency protection | ✓ | ✓ (fake PayPal HTTP) | **No** Sandbox or live call yet | Owner-approved Sandbox run ([procedure](docs/SUBSCRIPTION_SANDBOX_PROCEDURE.md)); real prices (UNKNOWN); merchant country eligibility. See [docs/MANAGED_BILLING.md](docs/MANAGED_BILLING.md) |
| `get_usage_summary` MCP tool (read-only, per user) | ✓ | ✓ | — | — |

Fixture offers are labelled `offerEvidenceClass: FIXTURE_OFFER`; merchant estimates are `MERCHANT_API_ESTIMATE`; no merchant order is ever claimed (`NO_MERCHANT_ORDER`).

## Merchant Quotes — Shopify Storefront Cart (V0)

DIAPORIA can ask a Shopify merchant's Storefront Cart API (2026-10) to price the exact variant for a destination: availability, delivery options, the selected rate, the cart total and whether that total is estimated. It also obtains the merchant's own checkout URL for an **external** handoff. See [docs/MERCHANT_QUOTE.md](docs/MERCHANT_QUOTE.md).

| Quote capability | Implemented | Fixture-tested | Live-tested | Notes |
|---|---|---|---|---|
| Listing price (catalog) | ✓ | ✓ | — | Never treated as a checkout total |
| Shopify cart estimate: variant check, availability, delivery address and options, cost, checkout URL | ✓ | ✓ (synthetic fixtures, 14 tests) | **No.** No dev store configured; run `npm run smoke:shopify` | Always `CART_ESTIMATE`. Tax is not itemized, so DIAPORIA's verified total stays unknown |
| Final merchant-attested quote (`FINAL_QUOTE_VERIFIED`) | state defined | — | — | No provider produces it. The Storefront API gives no price guarantee |
| External checkout handoff (merchant-hosted) | ✓ | ✓ | — | DIAPORIA does not pay Shopify merchants and creates no order |
| Merchant order confirmation | — | — | — | Future: needs merchant-side integration |

## Merchant Identity Verification — Mocked Future Integration

DIAPORIA currently demonstrates the merchant identity verification workflow with **simulated** business-registry and payment-recipient attestation providers. Run it with `npm run demo:identity`. Details are in [docs/MERCHANT_IDENTITY.md](docs/MERCHANT_IDENTITY.md).

- **Official Korean and US registry integrations are not implemented.** The KR and US registries in this repo are mocks holding fictional entries.
- **PayPal-side merchant identity attestation is not implemented.** PayPal recipient identity attestation is a *proposed partner capability*, not an existing verified public API feature. DIAPORIA does not call or imitate any PayPal identity endpoint.
- DIAPORIA would welcome access to appropriate PayPal partner APIs if such capabilities become available.

The workflow keeps two layers apart: the **legal entity** (registration exists, is active, name and jurisdiction match) and the **payment relationship** (the receiving account is attested to that entity and authorized for this merchant id and domain).
- A registration number on its own never verifies anything. An impersonator quoting a real company's number still fails on the payment relationship.
- Results are strictly `MATCH`, `MISMATCH` or `UNKNOWN`, and `UNKNOWN` never becomes `MATCH`.
- The binding is written into the checkout summary. Before capture, the server compares the actual order recipient reported by the payment provider with the intended payee, and fails closed on any mismatch.

| Capability | Implemented code | Mock-tested | Real PayPal Sandbox-tested | Future integration |
|---|---|---|---|---|
| KR registration number normalization + check digit, US EIN format | ✓ | ✓ | n/a | — |
| Legal-entity check against a business registry | ✓ (port + mock KR/US registries) | ✓ | — | Official KR / US registries |
| Payment-recipient attestation (payee ↔ legal entity ↔ merchant/domain) | ✓ (port + mock provider) | ✓ | — | PayPal partner capability, if offered |
| Checkout binding of business, offer, intended payee and attestation | ✓ | ✓ | — | — |
| Actual order recipient check before capture | ✓ | ✓ (mock order payee) | **Live Sandbox (2 runs):** run 1 failed closed (PayPal returned no payee email); run 2 verified `payee.merchant_id` before capture. Needs `PAYPAL_SANDBOX_PAYEE_MERCHANT_ID` | — |
| Negative cases: stolen registration, payee substitution, inconsistent entity, altered merchant id, stale/revoked attestation | ✓ | ✓ (tests/merchant-identity.test.ts) | — | — |

In PayPal Sandbox mode the real recipient is DIAPORIA's own Sandbox account, not the fictional merchant. The summary labels this as `DIAPORIA_SANDBOX_PLATFORM_ACCOUNT`.

## PayPal Agentic Commerce — Integration Roadmap

DIAPORIA Agent Commerce is designed to complement PayPal's agentic commerce infrastructure.

Our current implementation uses PayPal Sandbox APIs for checkout demonstration and transaction verification.

PayPal Agent Ready and Store Sync are not integrated in this version because the project does not currently have the applicable onboarding or eligibility arrangements.

We would welcome the opportunity to integrate these services once the appropriate developer and merchant access becomes available.

Our goal is to make PayPal-compatible purchasing available through the AI assistant users already prefer, while preserving transaction authorization, merchant integrity, and evidence-based purchasing decisions.

Future ports are reserved in `src/roadmap/paypalAgenticCommerce.ts` (interfaces only; no mock implementations). This project has no official PayPal partnership or endorsement.

References: [Agent Ready](https://developer.paypal.com/agent-ready/overview/) · [Store Sync](https://developer.paypal.com/store-sync/overview) · [Agentic commerce services](https://developer.paypal.com/agentic-commerce-services/about/) · [Orders API](https://developer.paypal.com/api/rest/integration/orders-api) · [Model Context Protocol](https://modelcontextprotocol.io/)

## License

MIT. Copyright (c) 2026 Eric Lee Kim. See [LICENSE](LICENSE). Third-party dependencies keep their own licenses, listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md): 92 production packages, all MIT, ISC or BSD.
