# Architecture

## Principles

1. **Host-neutral.** All behaviour lives behind the MCP tools; nothing depends on which assistant calls them.
2. **The server owns money.** Amounts, currency, merchant, product identity and state come from server records and merchant quotes, never from tool arguments. Tool arguments can only *narrow* (e.g. `maximumApprovedTotalMinor` can reject, never authorize).
3. **Unknown stays unknown.** Missing shipping/tax/fees make a total `null`, which makes the offer ineligible.
4. **No substitution.** An exact purchase locks brand, model, variant, condition and SKU; any mismatch is a rejection.
5. **Suitability ≠ merchant eligibility ≠ payment readiness ≠ fulfillment.** Each is a separate field and state.

## Modules

| Module | File | Role |
|---|---|---|
| PurchaseIntentRouter | `src/intent/PurchaseIntentRouter.ts` | Deterministic (no LLM) routing to PRODUCT_DISCOVERY or EXACT_PRODUCT_PURCHASE; extracts budget, currency, identity hints, must-haves |
| ProductIdentityResolver | `src/identity/ProductIdentityResolver.ts` | Locks one exact identity or returns AMBIGUOUS / NOT_FOUND; strict identity comparison |
| CommerceResearchAdapter | `src/research/CommerceResearchAdapter.ts` | Port for catalog, offers and merchant quotes; `MockCommerceResearchAdapter` uses public fixtures |
| MerchantOfferVerifier | `src/merchant/MerchantOfferVerifier.ts` | Identity, stock, quote freshness, total cost, budget, manipulative content, checkout path |
| PurchasePolicyEngine | `src/policy/PurchasePolicyEngine.ts` | Pure evaluation + atomic reservation / release / consume |
| PurchaseMandate | `src/policy/PurchaseMandate.ts` | User-created spending bound (repository) |
| CheckoutSessionManager | `src/checkout/CheckoutSessionManager.ts` | Durable purchase and checkout sessions; compare-and-set transitions |
| State machine | `src/checkout/stateMachine.ts` | Allowed transitions |
| PayPalCheckoutAdapter | `src/payment/PayPalCheckoutAdapter.ts` | PayPal Orders v2, Sandbox host only |
| MockPayPalProvider | `src/payment/MockPayPalProvider.ts` | Offline provider with scripted capture outcomes |
| PurchaseAuditJournal | `src/audit/PurchaseAuditJournal.ts` | Append-only, hash-chained, redacted |
| MCPCommerceAdapter | `src/mcp/MCPCommerceAdapter.ts` | Tool registration, schemas, annotations, scope checks |
| CommerceGateway | `src/engine/CommerceGateway.ts` | Orchestrates all flows |
| HTTP server | `src/http/server.ts` | `/mcp`, owner API/page, PayPal return/cancel, mock PayPal page |
| ManagedSubscriptionBilling | `src/billing/subscriptions/` | Service billing (separate from purchases): PayPal Subscriptions adapter (Sandbox only), subscription state machine, paid-period grants, `EntitlementGuard` inside `UsageLedger.begin`. See [MANAGED_BILLING.md](MANAGED_BILLING.md) |

## State machine

```
purchase session:  CREATED → RESEARCHED → OFFER_VERIFIED        (HOLD when identity/offer cannot be verified)
checkout session:  PREPARED → APPROVAL_REQUIRED → APPROVED → CAPTURE_PENDING → COMPLETED
                   + HOLD (policy rejected / payment disabled), CANCELLED, FAILED, EXPIRED, UNKNOWN
```

- `APPROVAL_REQUIRED → APPROVED` only after `GET /v2/checkout/orders/{id}` returns `APPROVED` with matching amount, currency and `custom_id`. A redirect alone changes nothing.
- `APPROVED → CAPTURE_PENDING` is the capture lock: a compare-and-set on `(state, version)`, so concurrent or replayed returns cannot capture twice. The capture uses a per-checkout `PayPal-Request-Id`.
- `COMPLETED` only after the capture is re-read from the provider with status `COMPLETED` and the exact amount.
- Network errors and 5xx during capture → `UNKNOWN`; the reservation is kept (fail closed) until `reconcile` reads the provider's authoritative order.
- Terminal: `COMPLETED`, `CANCELLED`, `FAILED`, `EXPIRED`.

## Persistence

SQLite via Node's built-in `node:sqlite` (WAL). Mandate reservations run in `BEGIN IMMEDIATE` transactions with an extra conditional `UPDATE` and table `CHECK (reserved_minor + consumed_minor <= max_total_minor)`, so the cumulative cap holds even under concurrent requests. Single-node design; a multi-node deployment would need a shared transactional database.

## Public / private boundary

This repository contains only code written for the public release plus fictional fixtures. The private DIAPORIA Buy application (Next.js; Channel3 catalog, Tavily/Kernel evidence research, personalization, V7.2 UI) is **not** included. It connects through the same `CommerceResearchAdapter` port: a private adapter maps V7 listings and the V7 manufacturer capability registry into this port, returns no merchant quote (V7 has listing prices only), and marks real retailers `EXTERNAL_CHECKOUT_ONLY`.
