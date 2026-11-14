# Research note: PayPal Vault and reference transactions (future capability, NOT enabled)

**Decision for V1:** DIAPORIA does **not** store PayPal payment methods and does **not** make merchant-initiated (unattended) charges. The only charge is the fixed subscription price, which PayPal bills after the buyer approved it on PayPal. The subscriptions adapter's endpoint allowlist blocks Vault, payment-token, billing-agreement and Orders endpoints, and a test asserts this.

This note records what a later usage-based or overage model would need. Facts were checked on 2026-11-09 against public PayPal developer documentation, and anything not verified is marked as such. Re-check before any design work, because PayPal changes these programs.

## What exists

| Mechanism | What it is | Source |
|---|---|---|
| **Vault v3 (payment method tokens)** | The buyer saves PayPal as a payment method. The merchant stores a `vault_id` server-side and later uses it in Orders v2 `payment_source`. Setup tokens expire after 3 days. With "save during purchase", the method is not vaulted if the purchase fails. If the status is APPROVED rather than VAULTED, the `vault_id` arrives via the `VAULT.PAYMENT-TOKEN.CREATED` webhook | [Save PayPal with the Payment Method Tokens API](https://developer.paypal.com/docs/multiparty/checkout/save-payment-methods/purchase-later/payment-tokens-api/paypal/), [Vault API integration](https://docs.paypal.ai/payments/save/api/vault-api-integration.md) |
| **Stored-credential fields** | Orders v2 `payment_source…stored_credential`: `payment_initiator` (`CUSTOMER`/`MERCHANT`), `payment_type` (`ONE_TIME`/`RECURRING`/`UNSCHEDULED`), `usage` (`FIRST`/`SUBSEQUENT`/`DERIVED`), `previous_transaction_reference` (MERCHANT only) | [Orders v2 payment_source](https://developer.paypal.com/api/orders/v2/definitions/payment_source) |
| **Risk data** | Customer-initiated transactions with PayPal/Venmo payment tokens need risk data collection, otherwise they are likely to be declined | [Vault API integration](https://docs.paypal.ai/payments/save/api/vault-api-integration.md) |
| **Availability** | PayPal states Vault v3 is available in the United States. Availability in other countries, and for a Korean merchant, is **unverified** | same |
| **Reference transactions / billing agreements (legacy)** | Older NVP/REST billing agreements for merchant-initiated charges. PayPal marks Billing Agreements as deprecated (see `docs/SERVICE_PLANE.md`). Historically they required PayPal account-manager approval for the merchant. **Unverified** for 2026 | — |
| **Subscription `/capture`** | Charges only an `OUTSTANDING_BALANCE` and cannot exceed it. It is not a usage-billing endpoint | PayPal Subscriptions v1 reference (checked earlier, see `docs/SERVICE_PLANE.md`) |

## What a usage or overage model would need before enabling anything

1. **Product decision.** Either keep overage DENIED (current V1), offer tiered fixed plans (no MIT needed), or bill overage via merchant-initiated charges.
2. **Merchant eligibility.** Vault and MIT availability for DIAPORIA's selling entity country (see the Korea note in `docs/MANAGED_BILLING.md`), and any PayPal approval for MIT or reference transactions.
3. **Buyer consent model.** An explicit, revocable consent per charge type, plus a per-period hard cap the buyer set. DIAPORIA would enforce the cap before any call, and the buyer would be notified before each charge.
4. **Engineering.** A separate bounded context (not the merchandise checkout and not this subscription module). Stored-credential fields set correctly (`MERCHANT`/`UNSCHEDULED`/`SUBSEQUENT` with the previous transaction reference). Idempotency per billing period. Reconciliation via the Payments v2 GET, the same pattern as merchandise captures.
5. **Compliance.** Tax and invoicing, refunds and disputes, and terms. None are covered today.

Until all five are decided and approved by the owner, the allowlist stays as it is and overage stays `DENY`.
