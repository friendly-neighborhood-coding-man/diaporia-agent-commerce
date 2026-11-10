# Phase C — PayPal Sandbox in the KERNEL same-session merchant checkout

**Status:** PREPARATION ONLY; no Phase C PayPal or KERNEL call has been executed. This runbook does not grant authorization. A separate owner decision is required for each network/paid stage.

## What this proves (and does not)

- C1: a seller-controlled **test merchant** can render PayPal's *real Sandbox* button and its popup in a KERNEL Live View session.
- C2: a Sandbox **personal buyer** can sign in and consent from that popup; any mock Sandbox transaction remains separate from DIAPORIA's own Orders-v2 checkout.
- C3: DIAPORIA reports only an observed return or `ORDER_UNVERIFIED` unless a trusted seller-side confirmation interface is configured. A thank-you page alone must NEVER cause `ORDER_CONFIRMED`.
- A successful result does not imply every seller's PayPal checkout works, bypass production risk checks, or establish permission to automate arbitrary merchants.

## Prerequisites before ANY network call

1. Independent reviewer checks PR #5's full diff, particularly KERNEL process-based watchdog and URL/DNS/network policy. GitHub CI alone is not a security assessment.
2. Use a controlled seller Sandbox app and a **separate personal Sandbox buyer**; never enter actual bank/card details or personal PayPal credentials.
3. Deploy a test merchant under a publicly routable HTTPS host controlled by the operator. The offline loopback fixture is **not** remotely reachable by KERNEL. No open tunnels to a personal PC.
4. Configure the seller's *official* PayPal JavaScript SDK (v6 for new integrations) and seller-owned Orders API with unique sandbox order IDs. DIAPORIA must not call merchant create/capture endpoints or alter the seller's order state.
5. Review the full merchant recipe. `origin` must point to the operator-controlled HTTPS site. `paymentHosts` must name only the intended Sandbox payment hosts. Set `networkAllowedHosts` to a **nonempty, exact-host** list including the merchant domain, payment host and only verified CDN/SDK hosts required by this merchant. No wildcards, IP literals, private hosts or unrestricted egress. A missing allowlist is rejected in the integration branch.
6. Set a maximum approved amount in the owner's checkout page. The displayed cart, quantity, tax, shipping and currency must match the mandate.
7. Use the owner's existing local `KERNEL_API_KEY` through the approved private environment-loading method, not copied into git. Check KERNEL dashboard browser count and quota. No key or live-view URL in logs/evidence.
8. Do NOT enable the independent BYOK page inspector (keep `DIAPORIA_ENABLE_LIVE_KERNEL_INSPECTION` unset).
9. No production OAuth or publicly exposed development owner keys. Handoff server remains on loopback and the Live View is available only through the owner-authenticated page.
10. Have an independent account/browser cleanup monitor and a recovery operator. The watchdog's 10-minute ceiling is a best-effort browser lifetime control, **not** a contractually enforceable USD spending cap.

## Step gate — separate explicit approval for each

| Step | Action | External effect | Required evidence |
|---|---|---|---|
| C0 (free) | Offline test and read-only review of recipe/merchant app configuration | No provider calls | Security checklist, SDK version, domain allowlist, exact prices, account separation |
| C1 (billed KERNEL) | One non-GPU headful KERNEL browser for at most 10 minutes. Navigate the controlled test merchant's cart, hand off, **open the Sandbox popup but do not approve payment** | One billed cloud browser; Sandbox assets may load | Popup visibility, clickability, no personal login, redacted provider errors and timings, verified browser DELETE |
| C2 (separate approval) | Re-run with a new browser/order only if C1 passes. Buyer uses the **Sandbox** personal account and explicitly approves a fixed test order. If the merchant captures, capture is seller-controlled and Sandbox-only. | One additional paid KERNEL browser plus a simulated Sandbox payment | Merchant-controlled order/capture reference, Sandbox environment, exact amount and recipient, browser deletion |
| C3 (read-only) | Query order status via an authorized seller-side API if available | No payment mutation | Distinguish popup return, payment approval, capture state, merchant order state and fulfillment |

Every step has an independent approval; previous $0.50 Phase B authorization is fully used and does not apply to C1 or C2. There is **no authorization for KERNEL C1 or Sandbox C2 at the moment**.

## Acceptance criteria and failure modes

- PASS C1 only if the actual `www.sandbox.paypal.com` popup renders and the human can interact with it through KERNEL Live View, with no credential/checkout data leaked to MCP output, logs, audit or database.
- PASS C2 only if the Sandbox business account receives an accurately attributed simulated transaction from the dedicated Sandbox personal buyer; preserve `CAPTURE_PENDING` vs `COMPLETED` honestly.
- Any unexpected payee, different amount/currency, unexpected real PayPal domain, unexpected login request, CAPTCHA challenge, SDK failure, timing out, or unverified deletion -> HOLD; do not retry a mutation automatically.
- Read-only seller status still cannot prove delivery/fulfillment. If no seller source exists, `ORDER_UNVERIFIED` is the correct result even after a merchant thank-you page.
- Chrome popup success in Phase B was a synthetic `window.open` only and **does not** satisfy C1.
- Record only redacted references and evidence class. Never publish a Live View bearer URL, email/password, cookies, auth code, SDK tokens or Sandbox app secret.

## Official documentation

- Kernel browser listing/cleanup: https://www.kernel.sh/docs/api-reference/browsers/list-browser-sessions
- PayPal SDK v6 setup: https://developer.paypal.com/sdk/js/set-up/
- PayPal Sandbox accounts (personal buyer vs business seller): https://developer.paypal.com/sandbox-testing/accounts
- PayPal Sandbox guide: https://developer.paypal.com/sandbox-testing/overview/
- PayPal Checkout quick start (seller creates/captures its own order): https://developer.paypal.com/checkout/integrate
