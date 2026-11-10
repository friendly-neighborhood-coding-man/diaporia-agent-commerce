# MCP tools

Endpoint: `POST /mcp` (Streamable HTTP, stateless, JSON responses). Server name `diaporia-agent-commerce`, protocol negotiated by the official SDK (latest `2025-11-25`, older versions accepted).
All money is **integer minor units** (cents for USD). Every tool returns `structuredContent` validated against its `outputSchema`, plus the same JSON as text. Errors return `isError: true` with `{ error: { code, message, details } }`.

| Tool | Effect | Annotations | Scope |
|---|---|---|---|
| `research_purchase` | Creates a research record; no payment effect | readOnlyHint ✓, destructiveHint ✗, openWorldHint ✓ | `purchase.research` |
| `compare_purchase_offers` | Updates the research record; no payment effect | readOnlyHint ✓, idempotentHint ✓ | `purchase.research` |
| `prepare_checkout` | **State-mutating, payment-related.** Creates a checkout; may reserve mandate budget and create a PayPal order. Never captures. | readOnlyHint ✗, destructiveHint ✗, idempotentHint ✓, `_meta["diaporia/capturesFunds"]=false` | `purchase.prepare` (hidden from tokens without it and in public mode) |
| `get_checkout_status` | Read-only | readOnlyHint ✓ | `purchase.read` |
| `get_purchase_receipt` | Read-only | readOnlyHint ✓ | `purchase.read` |

There is deliberately no `buy_now` / capture tool.

## research_purchase

Input: `request` (string), optional `budgetMinor`, `currency`, `mustHave[]`, `niceToHave[]`, `exactProduct {brand, model, variant, condition, sku}`.

Output: `purchaseSessionId` (`ps_<uuid>`), `state` (`RESEARCHED`|`HOLD`), `mode`, `intent` (budget + `budgetSource`), `identity` (`LOCKED`|`AMBIGUOUS`|`NOT_FOUND`|`NOT_APPLICABLE`), `candidates[]` with `suitability` (`SUITABLE`|`NEEDS_VERIFICATION`|`NOT_SUITABLE`), per-capability evidence status (`VERIFIED_TRUE`|`VERIFIED_FALSE`|`LISTING_CLAIM_ONLY`|`UNKNOWN`) with sources, `listingPrice` (not a total), `budgetFit`, `untrustedContent[]` (flagged third-party text), `unknowns[]`, `dataSource.mockData`, `paymentEffect: "NONE"`.

## compare_purchase_offers

Input: `researchSessionId`, `productIdentity`, optional `destination {country, region?, postalCode?}` (no street address is accepted).

Output: `state` (`OFFER_VERIFIED`|`HOLD`), `eligibleOffers[]`, `ineligibleOffers[]` each with `cost {itemMinor, shippingMinor, taxMinor, feesMinor, discountMinor, totalMinor, unknownComponents}`, `freshness`, `checkoutPath` (`PAYPAL_SANDBOX_DEMO_MERCHANT`|`EXTERNAL_MERCHANT_CHECKOUT`|`NONE`), `issues[]`; `lowestVerifiedEligibleOffer`, `lowestPayPalCheckoutableOffer`, `holdReasons[]`.

Issue codes: `IDENTITY_MISMATCH_{BRAND,MODEL,VARIANT,CONDITION,SKU}`, `OUT_OF_STOCK`, `AVAILABILITY_UNKNOWN`, `NO_MERCHANT_QUOTE`, `QUOTE_STALE`, `QUOTE_OFFER_MISMATCH`, `TOTAL_UNKNOWN`, `CURRENCY_MISMATCH`, `OVER_BUDGET`, `SUSPICIOUS_LISTING_CONTENT`, `NO_CHECKOUT_PATH`, `MERCHANT_IDENTITY_MISMATCH`, `MERCHANT_IDENTITY_UNKNOWN`. Each offer also carries `merchantIdentity { overall, legalEntity, paymentRelationship, identifierMasked, verifiedLegalName, checks[] }` (see MERCHANT_IDENTITY.md).

## prepare_checkout

Input: `purchaseSessionId`, `offerId`, `maximumApprovedTotalMinor`, `currency`, `quantity` (1–10).

Server steps: session must be `OFFER_VERIFIED`; offer must have been eligible; a **fresh** quote is fetched and re-verified; total must be ≤ `maximumApprovedTotalMinor`; repeated identical calls return the same checkout (`deduplicated: true`). Then:
- external merchant → `checkoutSessionId: null`, `checkoutPath: EXTERNAL_MERCHANT_CHECKOUT`, `externalCheckoutUrl`;
- payment disabled → `HOLD` / `PUBLIC_PAYMENT_DISABLED`;
- no mandate the owner allowed for automatic use (`autoUse: true`, default `false`) → `APPROVAL_REQUIRED` + `userAuthorizationUrl` (owner page), requirements `OWNER_MANDATE_REQUIRED`, `PAYPAL_BUYER_APPROVAL_REQUIRED`;
- mandate rejects → `HOLD` + `policy.code` (e.g. `AMOUNT_EXCEEDED`), no PayPal call;
- mandate allows → reservation + PayPal order → `APPROVAL_REQUIRED` + `approvalUrl` (PayPal hosted page). In MOCK the hosted page needs the checkout owner's key (stand-in for the buyer's PayPal login); the AI client cannot approve.

Output also includes the immutable `purchaseSummary`, its `summaryHash`, `expiresAt`, `paymentEffect: "NO_FUNDS_CAPTURED"`.

Error codes: `NOT_FOUND`, `INVALID_INPUT`, `INVALID_STATE`, `IDENTITY_MISMATCH`, `OFFER_NOT_ELIGIBLE`, `CLIENT_LIMIT_EXCEEDED`, `SESSION_EXPIRED`, `FORBIDDEN`, `MERCHANT_IDENTITY_MISMATCH`, `MERCHANT_IDENTITY_UNKNOWN`, `MERCHANT_RECIPIENT_UNKNOWN`. The `purchaseSummary.merchantIdentity` binding (masked identifier, legal name, attested and intended payee, payee relationship, attestation id/expiry, provenance) is covered by `summaryHash`.

## get_checkout_status

Output: `state`, `stateIsServerVerified: true`, `amount`, `approval {required, approvalUrl, buyerApprovalVerified}`, `capture {captureId, status}`, `failure`, `uncertainty`, `merchantIdentity`, `recipient { intendedPayeeId, actualRecipientId, verified, provenance }`, `paymentEnvironment`, `fulfillment: "NOT_VERIFIED"`. Identity failures before capture: `MERCHANT_IDENTITY_MISMATCH`, `MERCHANT_IDENTITY_UNKNOWN`, `MERCHANT_RECIPIENT_MISMATCH`, `MERCHANT_RECIPIENT_UNVERIFIED` (state `FAILED`, nothing captured).

## get_purchase_receipt

Output: `paymentResult` (only when `COMPLETED`), `paymentStatusNote` (MOCK vs Sandbox), `merchantOrder.status: "NOT_VERIFIED"`, `purchaseSummary`, `auditTimeline[]`, `purchaseOutcome`.

## purchaseOutcome (status and receipt)

Payment completion, merchant order confirmation and fulfillment are three separate layers. `state: COMPLETED` is only the first.

```json
{ "payment": "PAYMENT_COMPLETED", "merchantOrderConfirmation": "NOT_CONFIRMED", "fulfillment": "NOT_VERIFIED",
  "merchantPurchaseComplete": false,
  "statement": "Payment captured (PayPal Sandbox (no real money)). No merchant order confirmation was received and no fulfillment or shipment is verified, so this is not a completed merchant purchase." }
```

`merchantOrderConfirmation` is always `NOT_CONFIRMED` and `merchantPurchaseComplete` is always `false` in this release, because no merchant order integration exists. AI hosts should relay `statement` instead of saying "your purchase is complete".


## prepare_browser_checkout (browser handoff; only when `HANDOFF_DRIVER` is set)

Scope `purchase.prepare`, dev auth on loopback only. Input is `{ purchaseSessionId, offerId, quantity (1..5), maximumApprovedTotalMinor, currency }`, and the offer must be an EXTERNAL offer from a merchant that has a DIAPORIA recipe. It prepares the merchant cart in an isolated browser, captures what the merchant displays, applies constraints and stops before payment. It returns the handoff contract: `handoffId`, `state`, `capturedCart`, `constraints { violations, unknowns, effectiveMaximumMinor }`, `humanAction { kind: OPEN_HANDOFF_PAGE, url, authentication: OWNER_KEY, presentation }`, `orderStatus`, `paymentEffect: NONE_BY_DIAPORIA` and `diaporiaCreatedPaymentOrder: false`. See `docs/BROWSER_CHECKOUT_HANDOFF.md`.

## get_browser_checkout_status

Scope `purchase.read`, read-only. The same contract, plus `observation` (read-only, after takeover) and `sellerConfirmation`. `ORDER_CONFIRMED` requires authenticated seller-side confirmation.

## Payment status fields (lifecycle round)

`get_checkout_status` and `get_purchase_receipt` also return `paymentStatus`, `payment { paymentEnvironment, providerOrderId, captureId, providerCaptureStatus, pendingReason, lastAuthoritativeVerificationAt, recommendedNextAction, newPaymentAttemptProhibited }` and `merchantOrderStatus: "MERCHANT_ORDER_NOT_VERIFIED"`. The receipt adds `isFinalPaymentReceipt` and `refund`. A `CAPTURE_PENDING` payment is never a completed receipt. See PAYMENT_LIFECYCLE.md.

## Owner-only HTTP routes added in the MVP integration branch

- `POST /owner/checkouts/{cs_id}/cancel` (header `X-Owner-Key`): cancels a checkout only while no capture can exist (`PREPARED`, `HOLD`, or `APPROVAL_REQUIRED` when the provider still reports the order unapproved). Returns `200 {cancelled: true}` and releases the mandate reservation, or `409 {cancelled: false, reason}` with `BUYER_ALREADY_APPROVED_AT_PROVIDER`, `PROVIDER_STATE_UNKNOWN` or `NOT_CANCELLABLE_IN_<STATE>`. The owner review page has the same Cancel button.
- `prepare_checkout` repeated with identical arguments after the checkout reached `COMPLETED` returns that checkout with `deduplicated: true`; one purchase session buys at most once.
- This also holds for **concurrent** identical calls, in one process or in several processes on one database (WP-2, IR-02): the duplicate checks and the checkout insert run in one `BEGIN IMMEDIATE` transaction, backed by the partial UNIQUE index `checkouts_one_live_per_purchase_offer` on `(user_id, purchase_session_id, offer_id, quantity)` for every state except `CANCELLED`, `FAILED`, `EXPIRED` and `REFUNDED` (those allow a new attempt). The loser gets the winner's `checkoutSessionId` with `deduplicated: true`, reserves nothing and creates no provider order. A loser may see the winner before its payment order exists (`approvalUrl` still null); `get_checkout_status` shows the result.
- With `DIAPORIA_AUTH_MODE=oauth`, `/mcp` accepts OAuth access tokens only. See [REMOTE_MCP_AUTH.md](REMOTE_MCP_AUTH.md).
