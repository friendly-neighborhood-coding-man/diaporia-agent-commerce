# Phase C test merchant: design, deployment guide and limitations

**Status (2026-11-10): C0 offline only.** Implemented and tested with a MOCK PayPal and a fake Sandbox REST backend. No PayPal Sandbox order, no KERNEL browser and no deployment has been made. Every live step needs its own owner approval; see [PHASE_C_OPERATOR_CHECKLIST.md](PHASE_C_OPERATOR_CHECKLIST.md).

The test merchant is a separate, minimal Node/TypeScript web app in `apps/phase-c-test-merchant/`. It plays the role of a seller that owns its PayPal checkout, so DIAPORIA's existing KERNEL Live View handoff can be tested against the **real PayPal Sandbox button** instead of the offline fixture's fake one. It never accepts real payments.

```
AI host ── MCP ──▶ DIAPORIA research/compare ──▶ prepare_browser_checkout (recipe: product → variant → qty → add to cart → read cart, STOP)
                                                    │
owner ──(owner key + own maximum)──▶ /handoff/<id> ─┴─▶ KERNEL Live View of the SAME browser
                                                          │
                                                          ▼
                                          merchant's own PayPal Sandbox button (SDK v6)
                                                          │ popup: Sandbox personal buyer approves
                                                          ▼
                     merchant server: Orders v2 create / GET / capture (Sandbox) ──▶ signed status ──▶ DIAPORIA ORDER_CONFIRMED | ORDER_UNVERIFIED | CANCELLED
```

## What it sells

One fictional product, aligned with DIAPORIA's existing research fixture `off_lumen_q3` (merchant domain `bravo-electronics.example`, external checkout only), so the unchanged research → compare → `prepare_browser_checkout` contract reaches it:

| Field | Value (immutable) |
|---|---|
| Product | Lumen Q3 Wireless Headphones (fictional brand) |
| SKU / variant / condition | `LUM-Q3-B` / Black / New |
| Quantity | exactly 1 (other quantities are refused with `QUANTITY_LOCKED`) |
| Price | $95.00 + $5.00 shipping + $7.60 tax (8%) = **$107.60 USD** |
| Fulfillment | none; status always reports `fulfillment: NOT_VERIFIED` |

## Checkout modes

| Mode | Default | PayPal | Order creation | Capture | Activation |
|---|---|---|---|---|---|
| `MOCK` | yes | in-process fake, no network | fake | fake | none; refuses Sandbox secrets and approval digests |
| `SANDBOX_POPUP_TEST` (C1) | no | JS SDK v6 Sandbox + Orders v2 Sandbox | at most 1 (persisted cap) | **disabled** | owner-approved C1 digest |
| `SANDBOX_APPROVAL_TEST` (C2) | no | same | at most 1 | at most 1, seller-side | separate owner-approved C2 digest |

The mode is read from the environment once at start. No HTTP route can change it. A Sandbox mode refuses to start unless **all** of these hold: https public origin on a public DNS name, the reviewed allowlist file, Sandbox app credentials of the seller, the Sandbox **business** merchant id, a data directory (so the order cap survives restarts), a status-signing secret, an approval window of at most 24 hours that has not ended, and `PHASE_C_APPROVED_DIGEST` equal to the SHA-256 of the approval statement rebuilt from that exact configuration. A C1 digest cannot start C2. Changing the origin, allowlist, seller id, time window or limits changes the digest. The process stops itself when the window ends.

Production PayPal is unreachable by construction: the server client only knows `https://api-m.sandbox.paypal.com` and refuses any URL that resolves elsewhere; the browser script only accepts `https://www.sandbox.paypal.com/web-sdk/v6/core`; endpoint override variables (`PAYPAL_API_BASE`, `MERCHANT_PAYPAL_SDK_URL`, …) and `MERCHANT_PAYPAL_ENV` other than `SANDBOX` abort startup; production hosts in the allowlist abort startup.

## Payment integrity (merchant server)

- **Server totals only.** Order bodies are built from the server-side cart. Browser requests may carry only `cartRef`, `csrf` and PayPal's `orderId`; any other field (for example `amount`) is rejected with `UNEXPECTED_FIELD`.
- **Binding.** Every order carries `custom_id = reference_id = cartRef`, a unique `invoice_id`, `payee.merchant_id` = the configured seller, the locked SKU/quantity, and the item/shipping/tax breakdown. The create, GET and capture responses are all checked against the cart (amount, currency, payee, custom_id). Any mismatch → `ORDER_UNKNOWN`, and the order is never shown to the buyer.
- **Price lock.** If the catalog price differs from the price shown when the cart was created → `PRICE_CHANGED`, no order.
- **One cart per browser session.** Once a PayPal order exists the cart is locked (`CART_LOCKED`), so the cart reference DIAPORIA captured is the one that gets paid.
- **Idempotency and concurrency.** Mutations for a cart are serialized. `PayPal-Request-Id` is `phc-create-<cartRef>` for create and `phc-capture-<orderId>` for capture. Repeated or concurrent create requests return the same order; replayed approval callbacks never capture twice.
- **Browser claims are not evidence.** `onApprove`/`onCancel` only ask the server to look: approval moves to `BUYER_APPROVED` only after a server GET shows `APPROVED`; cancellation is accepted only while PayPal still shows the order un-approved. A redirect or thank-you page changes nothing.
- **No blind retries.** A create or capture without a definite answer becomes `ORDER_UNKNOWN`. `GET /operator/reconcile?cart=` (operator key) is read-only: one PayPal GET, no capture is reachable from it (`POST` → 405). A capture retry is a separate C2 mutation, `POST /operator/c2/retry-capture`, that needs an owner-approved `C2_CAPTURE_RETRY` digest bound to the C2 approval and the cart, a fresh GET showing `APPROVED` with no capture, at most one per approval, same request id.
- **Durable, single-instance spending.** In Sandbox modes the merchant takes an exclusive `instance.lease` in `MERCHANT_DATA_DIR` (a replica is refused; a stale lease needs the operator), binds the data dir to the approval digest (`approval.json`; the dir is also in the digest), and reserves order/capture/retry slots as exclusive files that are never released (`spendLedger.ts`). The create request id is `phc-create-run-<digest>`.
- **States.** `NO_ORDER → ORDER_CREATED → BUYER_APPROVED → CAPTURE_PENDING | PAYMENT_COMPLETED → ORDER_CONFIRMED`, plus `PAYMENT_DENIED`, `ORDER_CANCELLED`, `ORDER_UNKNOWN`. `CAPTURE_PENDING` is never success.

## Order status contract (seller → DIAPORIA)

`GET /api/orders/status?cart=<ref>&nonce=<16–64 chars>` returns non-sensitive JSON (state, merchant order ref, last 4 characters of the PayPal id, SKU, quantity, currency, total, `payeeVerified`, evidence source, `fulfillment: NOT_VERIFIED`) with `X-Merchant-Signature: v1=<HMAC-SHA256(MERCHANT_STATUS_SECRET, body)>`.

DIAPORIA's `PhaseCSellerStatusSource` (`src/handoff/phaseCMerchant.ts`) accepts it only if the signature is valid, the body echoes **this request's** nonce, it was issued within 60 s, the domain and cart match, the evidence is Sandbox (MOCK evidence is refused in KERNEL mode), and the state itself is `ORDER_CONFIRMED` with a verified payee. Mapping:

| Merchant state | DIAPORIA seller status | DIAPORIA handoff outcome |
|---|---|---|
| `ORDER_CONFIRMED` (payee verified) | `CONFIRMED` | `ORDER_CONFIRMED` (if total, quantity, currency and SKU also match the prepared cart) |
| `NO_ORDER`, `ORDER_CANCELLED` | `NO_ORDER` | `CANCELLED` |
| `ORDER_CREATED`, `BUYER_APPROVED`, `CAPTURE_PENDING`, `PAYMENT_COMPLETED`, `PAYMENT_DENIED`, `ORDER_UNKNOWN` | `UNKNOWN` (`MERCHANT_STATE_<state>`) | `ORDER_UNVERIFIED` |
| seller source not configured, unsigned, forged, stale or replayed | `UNKNOWN` | `ORDER_UNVERIFIED` |

DIAPORIA's handoff state machine (`src/handoff/states.ts`), its purchase/checkout state machine (`src/checkout/stateMachine.ts`) and the MCP contract are unchanged. The only DIAPORIA-side additions are the recipe builder, this seller source, and optional env wiring in `src/handoff/config.ts`.

## DIAPORIA recipe

`phaseCRecipe(origin, browserHosts)` builds the `MerchantRecipeRegistry` recipe: open `/p/off_lumen_q3`, select the locked variant `#variant`, fill `#qty` with the authorized quantity, click `#add-to-cart`, wait for `#cart`, read title/variant/condition/quantity/subtotal/shipping/tax/total/currency and the `data-cart-ref`, then stop. The merchant's button (`#paypal-button`, `data-payment`) is never a step; a recipe that targets it is rejected. `npm run phase-c:recipe -- --origin https://<host>` writes the reviewed recipe file for `HANDOFF_RECIPES_FILE`. The owner handoff page still requires the owner key and the owner's own maximum; the raw Live View URL is still never returned through MCP.

## Network allowlist

Reviewed file: [`apps/phase-c-test-merchant/config/network-allowlist.json`](../apps/phase-c-test-merchant/config/network-allowlist.json). It is used three ways: the KERNEL egress list (`networkAllowedHosts` = merchant host + browser hosts), the merchant's Content-Security-Policy, and the approval digest (its SHA-256 is part of the statement).

| Host | Who connects | Why | Evidence |
|---|---|---|---|
| `<your merchant host>` | browser | the merchant itself | operator-controlled |
| `www.sandbox.paypal.com` | browser | SDK v6 core script and Sandbox checkout popup | PayPal's own `paypal-examples/v6-web-sdk-sample-integration` (commit `c4333b44`) loads `https://www.sandbox.paypal.com/web-sdk/v6/core` |
| `api-m.sandbox.paypal.com` | merchant **server** only | OAuth, Orders v2 | not in the KERNEL list; the browser never calls it |
| `www.paypalobjects.com` | — | **not added**; unverified candidate | add only after C1 shows `NETWORK_POLICY_BLOCKED` naming it, with a new digest |

No wildcards, IP literals, ports or private names are accepted anywhere. If the real checkout needs a host that is not listed, C1 must be recorded as `NETWORK_POLICY_BLOCKED` with the missing host. The merchant collects CSP violation reports (`/api/csp-report`) and shows the blocked hosts in `/operator/diagnostics`; hosts blocked by KERNEL's egress filter are **not** visible there and must be read from the Live View / browser error page.

## PayPal JavaScript SDK v6 integration

`apps/phase-c-test-merchant/public/checkout.js` follows the one-time-payment pattern of PayPal's v6 sample: load `https://www.sandbox.paypal.com/web-sdk/v6/core`, `window.paypal.createInstance({ clientId, components: ["paypal-payments"], pageType: "checkout" })`, `findEligibleMethods({ currencyCode: "USD" })`, `createPayPalOneTimePaymentSession({ onApprove, onCancel, onError })`, and on click `session.start({ presentationMode: "auto" }, createOrderPromise)` without awaiting first. The button is `<paypal-button id="paypal-button" type="pay">`. The cart page sends `Cross-Origin-Opener-Policy: same-origin-allow-popups`, as PayPal's sample server does, so the popup can return to the page. The client **id** is browser-safe; the client **secret** and access tokens never leave the server (tested). No SDK v5 API (`paypal.Buttons`, `sdk/js?client-id=`) is used (tested).

## Deployment guide (production-shaped Sandbox, not run)

Requirements: a host and DNS name **you control**, a TLS certificate for it (for example Caddy's automatic HTTPS), Node 22.13+. No tunnel to a personal computer. The merchant listens on loopback; the reverse proxy terminates TLS and must pass the `Origin` header unchanged.

```caddyfile
phase-c.<your-domain> {
  reverse_proxy 127.0.0.1:8791
}
```

Environment variables (set on the merchant host only, never in git, never printed):

| Variable | Mode | Meaning |
|---|---|---|
| `MERCHANT_CHECKOUT_MODE` | all | `MOCK` (default), `SANDBOX_POPUP_TEST`, `SANDBOX_APPROVAL_TEST` |
| `MERCHANT_LISTEN_HOST` / `MERCHANT_LISTEN_PORT` | all | default `127.0.0.1` / `8791` |
| `MERCHANT_PUBLIC_ORIGIN` | Sandbox | `https://phase-c.<your-domain>` (bare origin, no port) |
| `MERCHANT_PAYPAL_CLIENT_ID` / `MERCHANT_PAYPAL_CLIENT_SECRET` | Sandbox | REST app of the Sandbox **business** account (secret stays server-side) |
| `MERCHANT_PAYPAL_SELLER_MERCHANT_ID` | Sandbox | merchant id of the Sandbox business account; every order's payee |
| `MERCHANT_DATA_DIR` | Sandbox | absolute, new and empty per approval (it is in the digest); holds `merchant-state.json`, `approval.json`, `instance.lease` and the `run-<digest>/` slot files (mode 0600/0700; no secrets) |
| `MERCHANT_STATUS_SECRET` | Sandbox (optional in MOCK) | ≥ 32 chars; HMAC key shared with DIAPORIA's `PHASE_C_SELLER_STATUS_SECRET` |
| `MERCHANT_OPERATOR_KEY` | optional | ≥ 32 chars; enables `/operator/*` (diagnostics, history, `GET` reconcile, C2 retry-capture with its own digest) |
| `MERCHANT_ALLOWLIST_FILE` | optional | defaults to the reviewed file |
| `PHASE_C_APPROVAL_EXPIRES_AT`, `PHASE_C_MAX_MINUTES`, `PHASE_C_KERNEL_USD_ESTIMATE` (not enforced), `PHASE_C_APPROVED_DIGEST` | Sandbox | exactly as printed by `npm run phase-c:approval` and approved by the owner |

Expected Sandbox seller configuration: in the PayPal Developer Dashboard Sandbox, one **Business** account (seller) with a Sandbox REST app, and a **separate Personal** account (buyer). Never use real PayPal credentials, bank or card data. Copy the business account's merchant id from its Sandbox account details (verify the exact label on the dashboard; the official pages were not reachable from the build environment).

DIAPORIA side (owner's machine, loopback only): `HANDOFF_DRIVER=kernel`, `DIAPORIA_ALLOW_KERNEL_LIVE=1`, `KERNEL_API_KEY` from the existing private environment (for example `.env.local`, never copied), `HANDOFF_RECIPES_FILE` from `npm run phase-c:recipe`, `RESEARCH_PROVIDER=mock`, `PAYMENT_PROVIDER=mock`, and optionally `PHASE_C_SELLER_ORIGIN` + `PHASE_C_SELLER_STATUS_SECRET` (both or neither; the origin must equal the recipe origin). Without them the best possible outcome is `ORDER_UNVERIFIED`.

Run locally (MOCK, offline): `npm run merchant:start` → <http://127.0.0.1:8791/>. Full offline flow with DIAPORIA and local Chromium: `npm run demo:phase-c` (or `-- --cancel`, `-- --interactive`).

Shut down safely: `SIGTERM`/`Ctrl+C` the merchant (it also stops itself at `PHASE_C_APPROVAL_EXPIRES_AT`); stop DIAPORIA (`app.handoff.shutdown()` deletes browsers it still holds); then confirm `npm run phase-c:kernel-check -- --read-only-kernel-call` prints `NO_KERNEL_BROWSER_RUNNING` and the KERNEL dashboard shows 0 running browsers. Remove the Sandbox credentials from the merchant host after the test; rotate the Sandbox app secret if anything was unexpectedly exposed. Keep `merchant-state.json` as evidence.

## Known limitations and unresolved blockers

1. **Official PayPal pages were not reachable** from the build environment (developer.paypal.com and docs.paypal.ai are outside its network allowlist). The v6 code follows PayPal's own sample repository (`paypal-examples/v6-web-sdk-sample-integration`, commit `c4333b44`, 2026-10-29). Re-check script URL, `createInstance` options, callbacks and `presentationMode` against developer.paypal.com before C1. `PayPal-Request-Id` retention and the full status vocabulary were not verified against an official page either.
2. **Browser dependencies beyond `www.sandbox.paypal.com` are unknown.** The minimal allowlist may block the real popup; that is an expected, reportable C1 outcome (`NETWORK_POLICY_BLOCKED`), not a reason to widen to wildcards.
3. **Unknown shipping/tax does not HOLD** in DIAPORIA V0: only an unknown total does (unchanged existing rule; tested and documented). The merchant always shows both, and its PayPal amount always equals the displayed total.
4. **No PayPal webhooks.** Seller evidence is the merchant's own server-side Orders v2 responses and GETs. A capture that settles later is seen only through `GET /operator/reconcile`.
5. **Single host.** Carts and history are an in-memory map persisted to one JSON file. Caps are durable exclusive files and one instance per data dir is enforced by a lease, but two hosts that mount different disks at the same path are not detected (the approval-bound PayPal request id is the only backstop). Run one process on one host per approval.
8. **KERNEL spending is capped by creations and time, not money.** The digest's `kernelUsdEstimateNotEnforced` is an estimate. DIAPORIA's ledger allows one browser per approval digest on one host, the watchdog caps wall time; the owner's account-side limit and supervision are the only monetary controls.
9. **KERNEL `allowed_hosts` is a KERNEL-managed egress filter**, not a VM-level firewall or DNS-rebinding protection, and it has not been independently verified. C1 evidence records `networkIsolation: UNVERIFIED` unless the bounded negative test in the checklist was run.
11. **Approval integrity.** Approvals pin the source commit and both built artifacts' hashes and are signed by the owner's Ed25519 key; each side verifies its own artifact, host (and DIAPORIA's OS user) and the signature at startup. This rests on the operator running unmodified verification code on hosts they control: a hostile operator who edits the code can bypass any local check. The browser-side status text never claims "nothing was captured"; it says the payment status is unverified until the merchant server checks it.
10. **Payment surface.** `presentationMode: "auto"` may pick a popup, a modal or a redirect. `checkout.js` reports `SURFACE_POPUP_OPENED` / `SURFACE_POPUP_BLOCKED` / `SURFACE_IFRAME_ADDED` / `SURFACE_PAGE_LEFT` to `/operator/diagnostics`; these are browser-side heuristics (the SDK may also add hidden iframes), so a popup pass also needs the human's observation.
6. **KERNEL-specific behavior is untested:** whether PayPal's popup, login, risk checks or CAPTCHA work in a KERNEL datacenter browser, and whether `presentationMode: "auto"` picks a popup there. CAPTCHA/risk checks must not be bypassed; a challenge is a HOLD.
7. **Merchant domain mapping.** The recipe's `merchantDomain` is the fixture domain `bravo-electronics.example` while `origin` is the operator's host; DIAPORIA checks the browser's host against the recipe origin. This mapping is deliberate for the fixture research catalog and is not how a real merchant would be onboarded.
8. Existing residual risks in [HANDOFF_SECURITY_REVIEW.md](HANDOFF_SECURITY_REVIEW.md) still apply (Live View URL is a bearer capability, KERNEL egress filtering is not IP-level isolation, the watchdog is not a USD cap). The test merchant was written by the implementer and has **not** had an independent security review.
