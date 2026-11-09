# Merchant identity verification (mock workflow)

Status: **implemented and tested against MOCK providers only.** No official business registry is called, and no PayPal merchant-identity attestation is called. Such an attestation API is a proposed partner capability; it is not a known public PayPal feature.

## Why two layers

A business registration number is public information. Anyone can copy it onto a look-alike website, so a valid, registered number proves nothing about who receives the money. DIAPORIA keeps two questions apart:

| Layer | Question | Evidence | Port |
|---|---|---|---|
| Legal entity | Does the claimed business exist, is it active, and do the legal name and jurisdiction match? | Business registry record | `BusinessRegistryProvider` |
| Payment relationship | Is the account that will receive the money attested to *that* legal entity and authorized for *this* merchant id and domain? | Recipient attestation | `PaymentRecipientAttestationProvider` |

Both layers must be `MATCH` before a checkout can bind to a merchant. Before capture, the server also compares the actual recipient that the payment provider reports for the order.

## Semantics

- Every check returns `MATCH`, `MISMATCH` or `UNKNOWN`. A layer is `MISMATCH` if any of its checks is a mismatch, `UNKNOWN` if any is unknown, and `MATCH` only if all checks match.
- `UNKNOWN` is never converted to `MATCH`. An offer with an `UNKNOWN` identity is ineligible (`MERCHANT_IDENTITY_UNKNOWN`), and a checkout fails closed before capture.
- An actual mismatch makes the offer ineligible (`MERCHANT_IDENTITY_MISMATCH`). It also rejects `prepare_checkout`, or fails the checkout before capture with nothing captured.
- What each problem yields:

| Problem | Result |
|---|---|
| Registry down | UNKNOWN |
| No claim published | UNKNOWN |
| Stale attestation | UNKNOWN |
| Number not registered | MISMATCH |
| Bad check digit | MISMATCH |
| Registration closed or suspended | MISMATCH |
| Name differs from the registry | MISMATCH |
| Jurisdiction differs from the registry | MISMATCH |
| Attestation revoked | MISMATCH |
| Payee belongs to another entity | MISMATCH |
| Payee not authorized for this merchant id or domain | MISMATCH |
| Attestation bound to another payee, merchant or checkout | MISMATCH |

## Checks

`CLAIM_PRESENT`, `IDENTIFIER_FORMAT` (KR business registration number check digit; US EIN length), `REGISTRY_RECORD`, `REGISTRY_STATUS`, `LEGAL_NAME`, `JURISDICTION`, `PAYEE_ATTESTATION`, `PAYEE_LEGAL_ENTITY`, `PAYEE_MERCHANT_AUTHORIZATION`, `ATTESTATION_BINDING`.

Each check carries a provenance label: `MOCK`, `OFFICIAL_REGISTRY` or `PAYMENT_PROVIDER`. With the current providers, every registry and attestation check is `MOCK`. The order-recipient check is `PAYMENT_PROVIDER` when the PayPal Sandbox provider supplies the data, from the documented Orders v2 `purchase_units[].payee.merchant_id` field, and `MOCK` with the mock provider.

## Checkout binding

1. `compare_purchase_offers` verifies every offer's identity and returns a public subset: overall result, both layers, the checks, the masked identifier and the registry legal name.
2. `prepare_checkout` takes these steps:
   - It rejects the request if the offer's merchant id or domain changed since comparison.
   - It re-verifies with an attestation bound to the new checkout id.
   - It writes the binding into the immutable, hashed purchase summary: masked identifier, verified legal name, attested payee, intended payee, payee relationship, attestation id and expiry, and provenance.
   - The checkout expires no later than the attestation does.
   - The PayPal order is created with `payee.merchant_id = intendedPayeeId`.
3. Before capture, after verified buyer approval:
   - The identity is re-verified with a fresh attestation bound to this checkout. It must match the payee and legal entity bound at preparation.
   - The order's actual recipient is read from the payment provider and must equal the intended payee.
   - Any failure moves the checkout to `FAILED`, with `MERCHANT_IDENTITY_MISMATCH`, `MERCHANT_IDENTITY_UNKNOWN`, `MERCHANT_RECIPIENT_MISMATCH` or `MERCHANT_RECIPIENT_UNVERIFIED`. Nothing is captured and the mandate reservation is released.
4. Status and receipt show `merchantIdentity` and `recipient { intendedPayeeId, actualRecipientId, verified, provenance }`. Payment success is still reported separately from merchant fulfillment (`NOT_VERIFIED`).

Budget, mandate, idempotency and approval protections run unchanged. Identity is an additional gate, not a replacement.

## Mock payments vs PayPal Sandbox

| | Mock payments | PayPal Sandbox |
|---|---|---|
| Intended payee | Merchant's attested payee (`MERCHANT_ATTESTED_PAYEE`) | DIAPORIA's own Sandbox business account (`DIAPORIA_SANDBOX_PLATFORM_ACCOUNT`), set via `PAYPAL_SANDBOX_PAYEE_MERCHANT_ID` |
| Merchant identity layers | MOCK registries and attestation | Same MOCK registries and attestation |
| Order recipient check | MOCK order data | PayPal order `payee.merchant_id` (PAYMENT_PROVIDER), compared with the configured account |
| What it proves | Workflow logic only | That the Sandbox order pays DIAPORIA's own test account. The fictional merchant is **not** paid and is not the recipient. |

If `PAYPAL_SANDBOX_PAYEE_MERCHANT_ID` is unset, Sandbox checkouts are rejected with `MERCHANT_RECIPIENT_UNKNOWN`.

## Personal data

- Identifiers are normalized server-side. Outputs show only a masked form (`101-81-*****`, `**-***0001`).
- Normalized digits are stored only in the checkout's server-side binding and are stripped from every tool output.
- No representative names, addresses or other personal data are collected.
- Payee account ids are business payment identifiers.

## Future integrations (not implemented)

- **KR:** the National Tax Service business status lookup (status by registration number). Name and entity matching would need an authorized source.
- **US:** there is no single public EIN registry. Candidates are state Secretary of State business entity registries, and IRS TIN matching for authorized payers.
- **PayPal:** a partner capability that attests "payment account X belongs to legal entity Y and may receive payments for merchant Z". DIAPORIA would welcome access to appropriate PayPal partner APIs if such capabilities become available. No such endpoint is called or simulated against PayPal hosts.

## Fixtures

All registry entries, attestations and claims in `src/merchant-identity/fixtures.ts` are fictional:
- Korean numbers carry valid check digits so the format validator accepts them.
- US EINs use the unassigned `00` prefix.

The impersonator `alpha-audi0.example` uses Alpha Audio's real-looking (fictional) registration number and legal name, with its own payee account attested to a different company.
