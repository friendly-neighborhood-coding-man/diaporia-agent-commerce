# Hackathon demo guide (judge-runnable)

**What DIAPORIA is:** a host-neutral MCP purchasing engine. The AI assistant you already use (Claude Code, Codex, Grok, Hermes and others) calls DIAPORIA's tools. DIAPORIA researches with evidence, compares merchant offers on verified total cost, refuses spending the human did not authorize, and only takes payment after the buyer approves on PayPal. It reports exactly what is verified and what is not.

The three-minute narrated version is [DEMO_SCRIPT.md](DEMO_SCRIPT.md).

## Run it locally (no credentials, no network)

```bash
git clone https://github.com/friendly-neighborhood-coding-man/diaporia-agent-commerce && cd diaporia-agent-commerce
npm ci && npm test
npm run demo:e2e        # research, compare, $6,000 refusal, prepare, buyer approval, capture (MOCK PayPal)
npm run demo:identity   # merchant identity and recipient binding (MOCK registries)
npm run demo:service    # Evidence Router (MOCK Tavily and KERNEL), usage ledger, managed-mode simulation
```

Node 22.13 or newer. Nothing in these commands reaches PayPal, Channel3, Tavily, KERNEL or Shopify.

## Four evidence classes (never mixed)

| Class | Meaning | Where |
|---|---|---|
| **Live MCP host calls** | A real installed AI host issued the `tools/call` itself, over Streamable HTTP, on 127.0.0.1 | `docs/INTEROP.md`, `docs/evidence/interop/` |
| **Live provider research** | A real paid API call to Channel3 or Tavily, under an explicit per-run budget | `docs/TEST_REPORT.md`, `docs/evidence/live-*.json` |
| **Simulated commerce** | Fixture catalog, fictional merchants (`*.example`), MOCK PayPal, MOCK merchant registries | every `npm run demo:*`, the test suite, and the commerce data inside the interop runs |
| **Recorded PayPal Sandbox evidence** | Two owner-approved Sandbox runs on 2026-11-09. Sandbox only, no real money | `docs/TEST_REPORT.md` (Sandbox runs 1 and 2) |

## What each step shows

| # | Step | Where to see it | Evidence class |
|---|---|---|---|
| 1 | Four different AI hosts drive the same server: `research_purchase` (2026-11-09), then the two-step `research_purchase` → `compare_purchase_offers` workflow (2026-11-10) | `docs/INTEROP.md`, `docs/evidence/interop/matrix.json`, `docs/evidence/interop/compare/matrix.json` | **Live MCP host calls**; MOCK commerce data |
| 2 | Per-host authorization | Each host has its own token and user id. Tools are listed by scope, so `prepare_checkout` was never offered. A request without a token gets 401. Host B's token cannot use host A's research session (`NOT_FOUND`) | **Live hosts** plus a direct server probe |
| 3 | Product research with evidence | `demo:service` (MOCK). Bounded live smoke over two runs: 2 Channel3 and 2 Tavily calls in total | MOCK plus **live provider research** |
| 4 | Original-page inspection (KERNEL) | BYOK adapter with call caps, a total deadline, URL and DNS policy, caching and browser-second cost records; `tests/kernel-inspector.test.ts` | **Fake-HTTP tests only.** No live KERNEL call has been made |
| 5 | Offer comparison on verified total cost | `demo:e2e`: the cheapest listing is rejected for unknown shipping; others for a stale quote, wrong colour, refurbished condition, a manipulative listing, over budget, out of stock or a look-alike domain. Lowest **verified** total: $59.39 | Simulated commerce |
| 6 | Refusal of a $6,000 transaction under a $60 mandate | `demo:e2e`: `HOLD / AMOUNT_EXCEEDED`, zero PayPal calls; also live host run 2 in `docs/HOST_TEST_EVIDENCE.md` | Simulated plus live host |
| 7 | Buyer approval, recipient verification, single capture | `docs/TEST_REPORT.md` Sandbox run 2: order `99X21669LS4807358`, payee merchant ID verified from PayPal data, one capture `92U85747JU359434A` | **Recorded PayPal Sandbox** (needs your own Sandbox app to repeat) |
| 8 | Honest pending reporting | That capture is `PENDING / PENDING_REVIEW`. DIAPORIA reports `CAPTURE_PENDING`, never completed | Recorded Sandbox (re-read 2026-11-09) |
| 9 | Payment, merchant order and fulfillment are separate | `get_checkout_status` and `get_purchase_receipt` return `purchaseOutcome`. Even after a completed capture: `merchantOrderConfirmation: NOT_CONFIRMED`, `fulfillment: NOT_VERIFIED`, `merchantPurchaseComplete: false` | Simulated (`demo:e2e`), enforced by tests |
| 10 | Purchase authority and DIAPORIA service billing are independent | `demo:service` (managed **simulation**), `tests/service-plane.test.ts` | Simulated |

## Truthfulness rules for anyone presenting this

- **No merchant purchase has ever been completed.** A completed PayPal capture means only that the payment was captured. There is no merchant order confirmation and no fulfillment, and DIAPORIA never claims either.
- The only live Sandbox capture is still **pending**. No real money moved.
- `alpha-audio.example` and every other merchant in the demos is **fictional**. Sandbox payments went to DIAPORIA's own Sandbox business account.
- The four-host runs prove host interoperability. The commerce data inside them is MOCK fixtures, and no payment tool was offered to the hosts.
- KERNEL is implemented but **not live-tested**. Shopify Storefront Cart is fixture-tested only; there is no live store.
- This release has no production OAuth, no managed billing and no used-goods risk control.

## The real remaining blocker for an externally fulfilled merchant order

DIAPORIA can capture a PayPal payment, but nobody on the other side turns that payment into an order. For an order that a real merchant confirms and ships, DIAPORIA needs **a merchant counterparty that is itself the PayPal payee and that accepts the order through an API and returns a confirmation DIAPORIA can verify.** Neither exists today:

- **Payee.** Sandbox payments go to DIAPORIA's own Sandbox account. Paying a third-party merchant directly needs that merchant onboarded as the payee (for example through PayPal's partner or multiparty onboarding, which needs PayPal's approval), or the merchant's own checkout.
- **Order channel.** The only merchant integration is the Shopify Storefront Cart quote. It prices a cart and returns the merchant's own checkout URL for an **external** handoff (`EXTERNAL_CHECKOUT_ONLY`). DIAPORIA cannot see whether the buyer finished that checkout, and it has no order-creation or order-status access.
- **Prerequisite for any real-money path.** Production user authentication (OAuth for MCP). Today payment execution is enabled only with dev tokens on loopback.

Until a merchant partner provides both payee onboarding and an order confirmation channel (for example a Shopify app with order read access, or a merchant order webhook), `merchantOrderConfirmation` stays `NOT_CONFIRMED`.
