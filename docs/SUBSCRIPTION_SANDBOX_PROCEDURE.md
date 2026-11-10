# Managed subscription billing: PayPal Sandbox test procedure

**Not yet run.** Every step below calls the PayPal **Sandbox**. Each one needs the owner's (Eric's) explicit approval of that step's digest. The script refuses to make any PayPal call without the digest. Nothing here can reach live PayPal, because the adapter only knows `https://api-m.sandbox.paypal.com` and refuses `PAYPAL_ENV` values other than `SANDBOX`.

Rules for whoever runs it:
- Use only Sandbox REST app credentials and Sandbox test accounts. Do not reuse any identifier from earlier Sandbox checkout runs (orders, captures).
- Run one step at a time. Each approval covers only its own step and its own digest.
- Record every resulting identifier in `docs/TEST_REPORT.md`. Never commit credentials (`npm run scan:secrets`).
- Stop on the first unexpected result and report it. Do not retry mutations to "make it pass".

## 0. Preview (no network)

```bash
npx tsx scripts/subscription-sandbox.ts plan --user sandbox-owner
```

This prints the Sandbox host, the plan terms (placeholder price, Sandbox money only), the terms digest, and for each step its exact PayPal calls, its effect, and its approval digest. **The owner approves a step by sending back its digest.**

## 1. `create-plan` (needs approval)

```bash
npx tsx scripts/subscription-sandbox.ts create-plan --approve <digest> --env-file .env.sandbox
```

- **Calls:** OAuth, `POST /v1/catalogs/products`, `POST /v1/billing/plans`.
- **Expected:** a `P-…` plan id. The plan is fixed monthly, `auto_bill_outstanding=false`, and has no setup fee.
- **Check in the Sandbox dashboard:** one product and one plan.
- **Idempotent:** a re-run reuses the local registry and the deterministic `PayPal-Request-Id`.

## 2. `subscribe` (needs approval)

```bash
npx tsx scripts/subscription-sandbox.ts subscribe --approve <digest> --env-file .env.sandbox
```

- **Calls:** OAuth, `POST /v1/billing/subscriptions`.
- **Expected:** local state `APPROVAL_PENDING`, plus an approval URL on `www.sandbox.paypal.com`.
- **Human step:** open the URL signed in as a Sandbox **personal** test account and approve. This is the only place where Sandbox money moves, and it moves because the buyer approved.

## 3. `status` (needs approval; read-only at PayPal)

```bash
npx tsx scripts/subscription-sandbox.ts status --approve <digest> --env-file .env.sandbox
```

1. Run it **before** approving in step 2. Expected: `APPROVAL_PENDING`, not entitled. This shows that the redirect alone activates nothing.
2. Run it **after** approving. Expected: `ACTIVE`, grant `REGULAR-1`, billed amount equal to the plan price. If PayPal has not yet reported `last_payment`, expect `AWAITING_PAYMENT_CONFIRMATION`. Re-run later; that is not a failure.
3. Run it twice. Expected: still exactly one grant.

## 4. `cancel` (needs approval)

```bash
npx tsx scripts/subscription-sandbox.ts cancel --approve <digest> --env-file .env.sandbox
```

- **Calls:** OAuth, `POST /v1/billing/subscriptions/{id}/cancel`, then `GET`.
- **Expected:** `CANCELLED`. The paid period stays usable until its end, and there are no further Sandbox cycles.

## 5. Webhooks (separate approval; needs a public HTTPS listener)

This step is not covered by the script. Prerequisites:
- a public HTTPS URL that forwards to `/billing/paypal/webhook`;
- a Sandbox webhook registered for the `BILLING.SUBSCRIPTION.*`, `PAYMENT.SALE.COMPLETED/REFUNDED/REVERSED` events;
- `PAYPAL_BILLING_WEBHOOK_ID` set.

Expected results:
- each delivery is verified through `POST /v1/notifications/verify-webhook-signature`;
- a replayed delivery returns `DUPLICATE`;
- a tampered body returns 401;
- state comes from the follow-up GET only.

Managed mode itself still runs only as the loopback simulation, so this step also needs a deployment decision.

## Never part of this procedure

- live credentials;
- subscription `/capture`, `/activate`, `/suspend` or `/revise`;
- Vault or reference transactions;
- Orders v2;
- any paid research provider (Channel3, Tavily, KERNEL).
