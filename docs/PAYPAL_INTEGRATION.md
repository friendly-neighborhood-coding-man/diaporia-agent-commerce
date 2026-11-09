# PayPal integration

## Flow (Orders v2, intent `CAPTURE`)

1. `prepare_checkout` validates the session and offer, re-quotes, and checks the mandate.
2. Server `POST /v2/checkout/orders` with `PayPal-Request-Id = create key`, amount from the server summary, `custom_id = checkoutSessionId`, `return_url` / `cancel_url` pointing at this server, `shipping_preference: NO_SHIPPING`, `user_action: PAY_NOW`.
3. The tool returns PayPal's `payer-action` link (must start with `https://www.sandbox.paypal.com/`).
4. The user approves on PayPal's hosted page (outside the AI chat).
5. `/paypal/return?checkout=…&token=<orderId>`: server `GET`s the order and requires `APPROVED`, exact amount/currency, and matching `custom_id`; then moves `APPROVED → CAPTURE_PENDING` atomically and `POST /v2/checkout/orders/{id}/capture` with `PayPal-Request-Id = capture key`.
6. Server `GET /v2/payments/captures/{id}`; only `COMPLETED` with the exact amount becomes `COMPLETED`. `PENDING` stays `CAPTURE_PENDING`; `DECLINED`/`FAILED` → `FAILED`; network/5xx → `UNKNOWN`.
7. The AI client reads `get_checkout_status` / `get_purchase_receipt`.

`/paypal/cancel` re-checks the order first (a cancel after approval in another tab is treated as a return) and otherwise marks `CANCELLED` and releases the reservation.

## Safeguards

- Base URL is the constant `https://api-m.sandbox.paypal.com`; `PAYPAL_ENV` other than `SANDBOX` is refused at construction.
- Credentials are read from the environment, never returned, never logged; errors include only HTTP status, PayPal issue name and debug id.
- No token passthrough: MCP client tokens are never forwarded to PayPal; PayPal access tokens never leave the server.
- Durable local deduplication (one active checkout per session/offer/quantity; unique order and capture ids) plus PayPal idempotency keys.
- The payee is DIAPORIA's own Sandbox business account representing a **fictional demo merchant**. Real retailers are `EXTERNAL_CHECKOUT_ONLY`; DIAPORIA never charges a third-party merchant's customers through its own account and never calls a Sandbox capture a retail purchase.

## Not implemented

- Webhooks (needs a public HTTPS listener). Status comes from synchronous verification plus explicit `reconcile`.
- Authorize-then-capture, refunds, voids, multi-currency beyond USD in practice.
- PayPal Agent Ready / Store Sync (see README roadmap).

## Running against Sandbox

```bash
PAYMENT_PROVIDER=paypal_sandbox PAYPAL_CLIENT_ID=<sandbox id> PAYPAL_CLIENT_SECRET=<sandbox secret> PAYPAL_ENV=SANDBOX npm run dev
```

Approve with a Sandbox **personal** buyer account. Record the result in `docs/TEST_REPORT.md` without credentials.
