# Purchase policy and mandates

## PurchaseMandate

| Field | Meaning |
|---|---|
| `mandateId` | `mdt_<uuid>` |
| `userId` | Owner; set from the authenticated owner key, never from input |
| `productIdentity` | Exact brand, model, variant, condition, SKU |
| `currency`, `maximumTotalMinor` | Integer minor units for the whole checkout total |
| `maximumQuantity`, `maximumTransactions` | 1–10 each (defaults 1) |
| `expiresAt` | 60 s – 7 days (default 1 h) |
| `merchantConstraints.allowedMerchantIds` | Optional allowlist |
| `authorizationStatus` | `ACTIVE`, `EXHAUSTED`, `REVOKED`, `EXPIRED` |
| `checkoutSessionId` | First checkout the mandate was bound to |
| `scope` | `REUSABLE` (owner API) or `CHECKOUT_BOUND` (owner approval page) |
| `boundCheckoutSessionId` | For `CHECKOUT_BOUND`: the one checkout it may ever pay; `null` for `REUSABLE` |
| `revokedAt` | Revocation time |
| `reservedMinor`, `consumedMinor`, `transactionsUsed` | Durable counters |

Only the owner creates mandates: `POST /owner/mandates` (header `X-Owner-Key`) or the `/authorize/<checkoutSessionId>` page. MCP tokens cannot. `POST /owner/mandates/<id>/revoke` revokes.

### Two kinds of mandate (DF-4)

- **REUSABLE**, created on purpose through `POST /owner/mandates`. Automatic mandate selection at `prepare_checkout` only ever considers these.
- **CHECKOUT_BOUND**, created by the `/authorize/<checkoutSessionId>` page. It may pay only that checkout (`BOUND_TO_OTHER_CHECKOUT` otherwise), is never selected for another checkout, and the database holds at most one non-revoked bound mandate per checkout (partial UNIQUE index). The page re-checks the checkout and creates the mandate in one `BEGIN IMMEDIATE` transaction. It creates nothing when the checkout has expired, completed, been cancelled or failed, already has a provider order, or already has a mandate (409). The page revokes the mandate if no payment starts, and `release` revokes a released bound mandate. A provider timeout keeps it reserved on the `UNKNOWN` checkout for reconciliation only. A legacy page mandate with no bound id is unusable.

## Evaluation order (`PurchasePolicyEngine.evaluate`)

1. mandate exists and belongs to the user
2. not revoked, not expired, not exhausted; a `CHECKOUT_BOUND` mandate only for its own checkout
3. total is a positive integer
4. exact product identity match
5. currency match
6. quantity ≤ maximum
7. merchant allowed
8. total ≤ `maximumTotalMinor`
9. single-use mandate not bound to another checkout
10. transactions remaining
11. `reserved + consumed + total ≤ maximumTotalMinor`

All inputs are server records (the stored checkout and the stored mandate). No client boolean or LLM text participates.

## Reservation lifecycle

- `reserve` (at prepare / owner authorization): `BEGIN IMMEDIATE` → re-read → evaluate → conditional `UPDATE` → commit. Database `CHECK` constraints are a second line of defence.
- `release` on buyer cancel, definite failure, or expiry before approval.
- `consume` on verified `COMPLETED` capture; mandate becomes `EXHAUSTED` when the amount or transaction count is used up.
- `UNKNOWN` keeps the reservation until reconciliation (fail closed).
- If the mandate is revoked or expires after buyer approval but before capture, the capture is not attempted and the checkout fails.

## What this does NOT do

A DIAPORIA mandate is application policy. It does **not** create a PayPal-enforced spending cap, prepaid wallet, virtual card, or reusable payment delegation. Each payment still requires explicit buyer approval in PayPal. The `$60 vs $6,000` test proves DIAPORIA refuses before contacting PayPal; it does not prove a provider-level hard cap.
