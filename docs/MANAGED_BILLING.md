# DIAPORIA Managed billing (V1): PayPal Subscriptions with entitlement-bound usage

**Status.** This is implemented and tested against a **fake PayPal over HTTP**, labelled MOCK. **No PayPal Sandbox or live call has been made.** The Sandbox procedure in [SUBSCRIPTION_SANDBOX_PROCEDURE.md](SUBSCRIPTION_SANDBOX_PROCEDURE.md) has not been run, and each of its steps needs the owner's approval digest. Every price here is either a labelled placeholder or `UNKNOWN`.

## What the user gets

A managed user subscribes **once** to a fixed monthly plan. Inside the plan's limits, DIAPORIA then runs Channel3 discovery, Tavily search and KERNEL page inspection for them. They do not approve each API call. The plan terms are what they authorize:

| Term | Meaning |
|---|---|
| `monthlyPriceMinor` | Fixed price that PayPal bills each month after the buyer approves. `null` means UNKNOWN, and the plan can't be created or offered |
| `includedAllowanceMinor` | Service value (the sum of DIAPORIA's per-operation list prices) included per paid period |
| `operationCaps` | Optional per-period count caps, e.g. `TAVILY:search: 60` |
| `hardSpendLimitMinor` | The most DIAPORIA bills per period. In V1 it equals the fixed price, because overage is never billed |
| `overage` | Always `DENY` in V1. When the allowance or a cap runs out, paid operations are refused |

The owner accepts the terms by their SHA-256 digest (`termsDigest`). The subscription stores a snapshot of the terms, so a later plan change never silently changes what the user authorized. A new price means a new terms version and a new PayPal plan.

## What stays separate

| | Service subscription (this doc) | Merchandise purchase |
|---|---|---|
| Authority | Owner subscribes with the owner key and approves on PayPal | Owner purchase mandate plus buyer approval of each order on PayPal |
| Code | `src/billing/subscriptions/*` | `src/checkout/*`, `src/payment/*`, `src/policy/*` (**unchanged**) |
| PayPal API | Subscriptions v1 | Orders v2 |
| Webhook listener | `POST /billing/paypal/webhook` (own webhook id `PAYPAL_BILLING_WEBHOOK_ID`) | `POST /paypal/webhook` (`PAYPAL_WEBHOOK_ID`) |

- An entitled subscription **never** authorizes a purchase. A mandate **never** creates an entitlement. Both are tested.
- The user's **own AI host subscription** (Claude, ChatGPT, Grok and so on) is outside DIAPORIA billing. The entitlement guard refuses any billable `MODEL` operation with the reason `NOT_A_DIAPORIA_SERVICE`.
- **Community / BYOK** installs no entitlement guard and exposes no subscription routes (`/billing/*` returns 404). There is no DIAPORIA billing at all.

## Components

```
owner (owner key) ──POST /owner/billing/subscriptions {planKey, acceptTermsDigest}──▶ ManagedSubscriptionBilling.subscribe
                                                                                       │ PayPalSubscriptionsSandboxAdapter
buyer ◀── approval URL (PayPal hosted page) ◀──────────────────────────────────────────┘   POST /v1/billing/subscriptions
buyer ──redirect──▶ /billing/subscription/return  ──┐
PayPal ──webhook──▶ /billing/paypal/webhook ────────┼─▶ authoritative GET /v1/billing/subscriptions/{id}
owner ──▶ /owner/billing/subscriptions/{id}/refresh ┘        │
                                                             ▼
                                   guarded transition + idempotent paid-period grant
                                                             │
AI client ──MCP research──▶ UsageLedger.begin (BEGIN IMMEDIATE) ──▶ EntitlementGuard.check ──▶ allow / ENTITLEMENT_DENIED
```

| File | Role |
|---|---|
| `src/billing/subscriptions/PayPalSubscriptionsAdapter.ts` | Sandbox-only adapter: OAuth, products, plans, subscriptions (create/get/cancel), sale read, PayPal webhook verification API. Endpoint allowlist |
| `src/billing/subscriptions/ManagedSubscriptionBilling.ts` | Lifecycle state machine, grants, entitlement guard, webhook handling, statement. Implements `BillingProvider` |
| `src/billing/subscriptions/plans.ts` | Plan terms, validation, digest. `MANAGED_PLANS_PRICES_UNKNOWN` (production default) and `MANAGED_PLANS_PLACEHOLDER` |
| `src/billing/subscriptions/FakePayPalSubscriptions.ts` | In-process fake of the PayPal endpoints (tests and MOCK demo). Every id contains `MOCK` |
| `src/billing/subscriptions/http.ts` | Owner, return and webhook routes. `server.ts` only delegates |
| `src/billing/subscriptions/factory.ts` | `MANAGED_BILLING=subscriptions-mock` (default), `paypal-sandbox-subscriptions`, or `legacy-mock` |
| `src/metering/UsageLedger.ts` | New optional `EntitlementGuard` hook, run inside `begin()`'s IMMEDIATE transaction |

## Lifecycle state machine

```
DRAFT ──create ok──▶ APPROVAL_PENDING ──PayPal read ACTIVE──▶ ACTIVE ◀──▶ SUSPENDED
  │ create refused        │ owner abandons / approval TTL         │ owner cancel
  ▼                       ▼                                       ▼
FAILED                ABANDONED                          CANCEL_REQUESTED ──PayPal read──▶ CANCELLED
                                     any open state ──read unrecognized / binding mismatch──▶ UNKNOWN
                                     PayPal read EXPIRED ──▶ EXPIRED
```

- The full table is `SUBSCRIPTION_TRANSITIONS`. Terminal states (`CANCELLED`, `EXPIRED`, `ABANDONED`, `FAILED`) have no exits. Every write is versioned (`WHERE version=?`).
- **`ACTIVE` comes only from a server-to-PayPal read.** The browser return and webhooks only *trigger* that read, and their content is never used for state. PayPal `APPROVED` (approved but not yet active) stays `APPROVAL_PENDING`, with no entitlement.
- **Binding check on every read.** `id`, `custom_id` (our local id) and `plan_id` must match what we created. On a mismatch the state becomes `UNKNOWN` with hold `BINDING_MISMATCH`.
- **Cancel.** We cancel at PayPal, then read back. A timeout leaves `CANCEL_REQUESTED`, which is safe to retry with the same `PayPal-Request-Id`. Unapproved subscriptions are abandoned locally, because PayPal only cancels ACTIVE or SUSPENDED ones. If the buyer approves an abandoned link later, DIAPORIA puts a hold on it (`PROVIDER_ACTIVE_AFTER_LOCAL_TERMINAL`) for the owner. It neither activates nor auto-cancels it.
- **Paid period after cancel.** The period already paid stays usable until its end. Nothing new is billed.

## Entitlement (what allows a paid operation)

A billable reservation in `UsageLedger.begin` is allowed only if **all** of the following hold. The checks run inside the same IMMEDIATE transaction that writes the reservation:

1. A **grant** covers *now*. A grant is created from PayPal's reported completed `REGULAR` cycle `n` and `last_payment`, keyed `UNIQUE(subscription, "REGULAR-n")`. The window runs from `last_payment.time` to `next_billing_time`, capped at one calendar month. The payment amount and currency must equal the authorized plan price, otherwise hold `PAYMENT_AMOUNT_MISMATCH`.
2. The subscription is `ACTIVE`, `CANCEL_REQUESTED` or `CANCELLED`, with **no hold**.
3. The last successful PayPal read is at most 24 h old (`maxStatusAgeMs`), otherwise `STATUS_STALE`. `getAuthorization` re-reads PayPal when the last read is more than 15 min old, before MCP research runs.
4. The operation has a DIAPORIA list price. If it doesn't, the reason is `PRICE_UNKNOWN`.
5. Allowance consumed (billed plus reserved pending delivery, at list price) plus this operation's price is no more than the allowance (`ALLOWANCE_EXHAUSTED`), and the per-operation cap is not exceeded (`OPERATION_CAP`).

A failed provider call releases its reservation, so it is never billed. A retry of the same logical operation is charged at most once, because the ledger's existing logical-key rule applies.

Denials surface as `UsageLimitError("ENTITLEMENT_DENIED", …, reason)`. The gateway reports them as `USAGE_LIMIT`, and the evidence router reports them as `BLOCKED_BY_LIMIT`, saying that verification was not skipped. The existing `BILLING_AUTHORIZATION_REQUIRED` check still runs first: `getAuthorization` reports `ACTIVE` only when the user is entitled right now.

## Four money values, never mixed

`statement(userId)` (also in MCP `get_usage_summary` → `billing.subscriptionStatement`) reports the following:

| Value | Unit | Source |
|---|---|---|
| **Billed amount** | USD cents | PayPal `last_payment` for the period, read server-to-server |
| **DIAPORIA service price** | USD cents | Plan price, plus list prices of operations consumed against the allowance (never billed separately in V1) |
| **Estimated supplier cost** | micro-USD | `UsageLedger` estimates. `unknownCostRecords` > 0 means incomplete. Unknown stays `null`, never 0 |
| **Provider cost** | micro-USD | Only after `reconcileSupplierCost` with a real provider statement. Otherwise `null` |

## Idempotency and replay protection

| Threat | Protection |
|---|---|
| Duplicate subscription | Partial unique index: one open subscription per user. Concurrent `subscribe` calls return the same record. Create retries reuse the stored `PayPal-Request-Id` |
| Duplicate grant | `UNIQUE(subscription_id, period_key)` plus `INSERT OR IGNORE`. Replays, concurrent refreshes, ACTIVATED + SALE.COMPLETED for the same cycle: one grant (tested with 9 concurrent triggers) |
| Webhook replay | Event id claimed atomically (`subscription_webhook_events`). Replays return `DUPLICATE`, in-flight duplicates return `409` (PayPal retries), failed processing returns `503 FAILED_RETRYABLE` and can be re-claimed |
| Forged or tampered webhook | PayPal's verification API (`POST /v1/notifications/verify-webhook-signature`) with the **raw** event bytes, `verification_status === "SUCCESS"` only. Transmission time must be within 3 days. The mock HMAC is **not** accepted on this route |
| Concurrent overspend | Entitlement check and reservation in one `BEGIN IMMEDIATE` transaction. Tested across two SQLite connections on one file |
| Refund or reversal | `PAYMENT.SALE.REFUNDED/REVERSED` → sale re-read → if refunded or reversed: grants revoked and hold `PAYMENT_REFUNDED_OR_REVERSED` |

## No unrestricted debit

The adapter has an **endpoint allowlist** (`ALLOWED_ENDPOINTS`). Subscription `/capture` (outstanding-balance charge), `/activate`, `/suspend` and `/revise` cannot be called, and neither can Orders, Vault, payment tokens or billing agreements. A test checks that the fake never saw such a call. Plans use `auto_bill_outstanding: false`. The only money movement is PayPal billing the fixed price the buyer approved. Vault and reference transactions are researched for later in [VAULT_REFERENCE_TRANSACTIONS_RESEARCH.md](VAULT_REFERENCE_TRANSACTIONS_RESEARCH.md) and are **not enabled**.

## Fail-closed summary

Every one of these denies paid operations, and each is covered by a test:
- unknown plan price, so the plan cannot be created or subscribed;
- no subscription, approval pending, or ACTIVE without a confirmed payment;
- suspended, `UNKNOWN`, or a stale or failed status read;
- a hold for binding mismatch, amount mismatch, refund/reversal, or provider-active-after-local-terminal;
- an operation without a list price;
- an exhausted allowance or cap.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `MANAGED_BILLING` | `subscriptions-mock` | `subscriptions-mock` (fake PayPal in-process), `paypal-sandbox-subscriptions`, or `legacy-mock` (old HMAC mock) |
| `MANAGED_PLAN_PRICES` | unset | `placeholder` lets the Sandbox adapter use the placeholder catalog. Unset means prices are UNKNOWN and nothing can be subscribed |
| `PAYPAL_BILLING_WEBHOOK_ID` | unset | Webhook id of the billing listener. Unset means `/billing/paypal/webhook` returns 503 |

Managed mode still requires `DIAPORIA_MANAGED_SIMULATION=1` on loopback, because production authentication does not exist yet.

## Test evidence (2026-11-09, MOCK only)

**No PayPal Sandbox, live PayPal or paid research provider was contacted.** All PayPal behaviour comes from `FakePayPalSubscriptions`. The real adapter talks to it through its injected `fetch`.

- **New tests:** `tests/subscription-billing.test.ts`, 19 tests. They cover:
  - the adapter allowlist (no capture, activate, vault or orders), the LIVE refusal, unpriced plans, and request ids;
  - postback webhook verification with raw bytes, and HMAC/tampered/foreign webhook-id rejection;
  - the lifecycle: a redirect never activates, APPROVED is not entitled, binding and amount mismatch holds, one open subscription per user, create-timeout retry with the same idempotency key, and cancel including timeout and abandoned links;
  - entitlement: allowance, caps, PRICE_UNKNOWN, MODEL refusal, failed calls not billed, two SQLite connections on one file, stale status, suspension, and renewal;
  - webhook replay and concurrency: 9 concurrent triggers → 1 grant, retryable failures, refund/reversal holds;
  - the MCP path in managed simulation, purchase separation, community untouched, and the factory defaults.
- **Sensitivity check:** disabling the ledger guard fails 7 of the new tests. Removing grant idempotency (`INSERT OR IGNORE` → `INSERT`) fails 5.
- **Suite:** `npm test` gives **11 files, 138 passed, 0 failed**. `npm run typecheck` is clean, and `npm run scan:secrets` reports no findings.
- **Demo:** `npm run demo:subscription`.

## Before a production launch (not done)

1. **Decide real prices.** DIAPORIA's plan price, allowance and per-operation list prices, plus real supplier prices from contracts. Until then they stay UNKNOWN or placeholder.
2. **Check merchant country and eligibility.** PayPal states that Korea-registered accounts cannot send or receive domestic Korea-to-Korea payments, and that Korean sellers can only receive from buyers outside Korea ([PayPal Korea FAQ](https://www.paypal.com/kr/webapps/mpp/system-enhancement-faq), [account limitations](https://pep.paypal.com/kr/brc/topics/account-limitations-and-restrictions)). Confirm the selling entity's country, Subscriptions availability for that account, currency (V1 is USD only), and whether Korean residents can be served at all. Do **not** assume domestic Korean subscribers can pay a Korean merchant through PayPal.
3. Production OAuth for MCP and owner identity, plus a public HTTPS webhook listener registered for the billing events.
4. Tax and invoicing obligations, refund policy, and terms of service. None of these are covered here.
