# Payment lifecycle and reconciliation

DIAPORIA tracks four things separately and never infers one from another:

| Concept | Source | Field |
|---|---|---|
| Provider **order** status | `GET /v2/checkout/orders/{id}` | audit only; never decides payment state |
| Provider **capture** status | `GET /v2/payments/captures/{id}` (Payments v2) | `payment.providerCaptureStatus`, `paymentStatus` |
| Merchant **funds availability** | not exposed by the Capture API | `merchantFundsAvailability: "NOT_DETERMINED_BY_CAPTURE_API"` |
| Merchant **order** acceptance / fulfillment | no merchant integration | `merchantOrderStatus: "MERCHANT_ORDER_NOT_VERIFIED"`, `fulfillment: "NOT_VERIFIED"` |

Two observations from Sandbox run 2 shape this design:
- PayPal reports an order as `COMPLETED` as soon as a capture exists, even when that capture is `PENDING`.
- A seller-side "On hold" label in the PayPal UI is a funds-availability concept. It is not a capture status, and it is never an input to DIAPORIA's state.

## State machine (checkout)

Before this round:

```
PREPARED → APPROVAL_REQUIRED → APPROVED → CAPTURE_PENDING → COMPLETED (terminal)
          + HOLD, CANCELLED, FAILED, EXPIRED, UNKNOWN
```

After this round:

```
PREPARED → APPROVAL_REQUIRED → APPROVED → CAPTURE_PENDING → COMPLETED → REFUNDED
                                                    ↘ FAILED (DECLINED/FAILED, definitive)
          + HOLD, CANCELLED, EXPIRED, UNKNOWN (UNKNOWN → CAPTURE_PENDING / COMPLETED / FAILED / REFUNDED by authoritative read)
```

- Transitions out of `CAPTURE_PENDING` and `UNKNOWN` require an authoritative capture read.
- `COMPLETED` can only move to `REFUNDED`.
- A provider read that would regress a final state (PENDING after COMPLETED, DENIED after COMPLETED) is recorded as `RECONCILE_CONFLICT_IGNORED`. It never changes the state.

## Reconciliation (`CommerceGateway.reconcileCapture`)

1. It resolves the checkout by its stored capture id.
2. It reads `GET /v2/payments/captures/{id}`, with bounded retries for network/5xx-class failures only (default 3 attempts, exponential backoff).
3. It checks that the capture id and the amount and currency match the immutable summary. A mismatch sets `UNKNOWN`, and the reservation is held.
4. It maps the provider status:

| Provider | From CAPTURE_PENDING / UNKNOWN | Mandate |
|---|---|---|
| `PENDING` | stays `CAPTURE_PENDING` (verification time and reason recorded) | reservation held |
| `COMPLETED` | `COMPLETED` | reservation → consumed |
| `DECLINED` / `FAILED` | `FAILED` | reservation released (definitive: nothing paid) |
| `REFUNDED` / `PARTIALLY_REFUNDED` | `REFUNDED` | consumed; authority **not** restored |
| read failed | no change (`PROVIDER_UNAVAILABLE`) | reservation held |

Reconciliation is read-only toward PayPal. It never creates an order or capture, and never refunds or voids. It runs:
- on demand, through the owner route `POST /owner/checkouts/{id}/reconcile`;
- on every server start, for all checkouts in `CAPTURE_PENDING` or `UNKNOWN` that have a capture id;
- after an authenticated webhook.

## Webhooks (`POST /paypal/webhook`)

**Handled events:** `PAYMENT.CAPTURE.PENDING`, `.COMPLETED`, `.DENIED`, `.REFUNDED` (capture id taken from the refund's `up` link), and `.REVERSED`.

**Authentication** uses PayPal's documented self-verification:
- The signed message is `transmission_id|transmission_time|webhook_id|crc32(raw body)`.
- It is checked with RSA-SHA256 against the certificate at `paypal-cert-url`.
- That URL must be HTTPS on a PayPal API host under `/v1/notifications/certs/`.
- Only `SHA256withRSA` is accepted, and a transmission older than 3 days or in the future is rejected.

**Processing:**
- Every event id is stored, and a duplicate returns `DUPLICATE` without any processing.
- Events for unknown captures, or naming a different payee merchant id, are ignored.
- The event's claimed status is **never applied**. A verified event only triggers `reconcileCapture`, so a replayed, stale or out-of-order event cannot change state against the provider's answer.

**Availability:**
- The endpoint is off (503) unless `PAYPAL_WEBHOOK_ID` is configured.
- Like every payment route, it is closed (403) whenever payment execution is disabled, which includes all public deployments.

## MCP contract additions (backwards compatible)

- `get_checkout_status`: adds `paymentStatus` (`NOT_STARTED`, `NOT_AUTHORIZED`, `APPROVAL_REQUIRED`, `APPROVED_NOT_CAPTURED`, `CAPTURE_PENDING`, `PAYMENT_COMPLETED`, `PAYMENT_FAILED`, `PAYMENT_REFUNDED`, `PAYMENT_UNKNOWN`, `CANCELLED`, `EXPIRED`), `merchantOrderStatus`, `merchantFundsAvailability`, and `payment`:
  - `paymentEnvironment`, `providerOrderId`, `captureId`, `providerCaptureStatus`, `pendingReason`
  - `lastAuthoritativeVerificationAt`
  - `recommendedNextAction`, e.g. `WAIT_FOR_PROVIDER_SETTLEMENT_DO_NOT_RETRY`
  - `newPaymentAttemptProhibited`
- `get_purchase_receipt`: adds `paymentStatus`, `isFinalPaymentReceipt` (true only when `PAYMENT_COMPLETED`), `payment`, `refund` and `merchantOrderStatus`. `paymentResult` stays `null` unless the capture is verified `COMPLETED`.
- `prepare_checkout`: refuses a new checkout for a purchase session whose payment is `APPROVED`, `CAPTURE_PENDING`, `UNKNOWN` or `COMPLETED`. An identical repeat request still returns the existing checkout (`deduplicated: true`).

## Evidence classes

- **Verified live (Sandbox):** read-only GET of capture `92U85747JU359434A` and order `99X21669LS4807358`. Both were still `PENDING / PENDING_REVIEW` at 12:58 UTC.
- **Simulated:** every lifecycle transition (`PENDING→COMPLETED/DENIED/REFUNDED`), all webhook deliveries and signatures, restart and timeout handling. These use the mock provider and locally signed fixtures in `tests/payment-lifecycle.test.ts`.
- **Not tested:** a real PayPal webhook delivery (needs a registered webhook and a public HTTPS listener), a real Sandbox capture reaching `COMPLETED`, refunds, and production behavior.
