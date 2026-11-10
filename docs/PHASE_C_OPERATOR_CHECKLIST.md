# Phase C operator checklist (C0 → C3)

**Current position: C0 complete. STOP before C1.** Nothing below C0 has been run. Each gate needs a fresh, explicit owner approval that names its parameters. Earlier KERNEL Phase B approvals (the $0.50 synthetic-popup run) do **not** cover any Phase C step. Never reuse Sandbox order `9DL148415W2504835` or capture `92U85747JU359434A`.

Commands that touch the network are marked **[NETWORK]**; billed ones **[BILLED]**. Everything else is offline.

## C0 — offline (no approval needed) — DONE

```bash
npm ci
npm run typecheck
npm test                       # includes tests/phase-c-merchant.test.ts and tests/phase-c-handoff.test.ts
npm run build                  # DIAPORIA (dist/) and the test merchant (dist-merchant/)
npm run demo:e2e
npm run demo:phase-c           # MOCK: DIAPORIA → test merchant → simulated human approves → ORDER_CONFIRMED
npm run demo:phase-c -- --cancel   # → CANCELLED
npm run scan:secrets
```

C0 review items for the owner / an independent reviewer before approving C1:

- [ ] Read `apps/phase-c-test-merchant/` and `src/handoff/phaseCMerchant.ts` in full (implementer-written, not independently reviewed).
- [ ] Re-check the SDK v6 calls in `apps/phase-c-test-merchant/public/checkout.js` against https://developer.paypal.com/sdk/js/set-up/ (it was written from PayPal's `paypal-examples/v6-web-sdk-sample-integration` because the official pages were unreachable from the build environment).
- [ ] Review `apps/phase-c-test-merchant/config/network-allowlist.json` (currently only `www.sandbox.paypal.com`).
- [ ] Confirm the Sandbox accounts: one **Business** seller with a Sandbox REST app, one separate **Personal** buyer. No real credentials anywhere.
- [ ] Choose the HTTPS origin (a domain you control; no tunnel to a personal PC) and the approval window.

## C1 — real PayPal Sandbox popup through KERNEL, NO capture (needs approval)

The owner's C1 approval must state: the exact merchant HTTPS origin, the Sandbox seller (its merchant id hash is in the statement), the reviewed allowlist (its SHA-256 is in the statement), permission to create **one** new Sandbox order if the SDK needs it to open the popup, **one** KERNEL browser, the maximum minutes (≤ 10) and maximum KERNEL USD, and **no capture**. The owner approves the **digest** printed by step 1.

1. Offline, produce the statement and digest for the owner (no network):
   ```bash
   npm run phase-c:approval -- --gate C1 --origin https://phase-c.<your-domain> --seller-merchant-id <SANDBOX_BUSINESS_MERCHANT_ID> --expires <ISO-8601, ≤ 24 h ahead> --max-minutes 10 --max-kernel-usd 0.50
   npm run phase-c:recipe -- --origin https://phase-c.<your-domain> > .data/phase-c-recipes.json
   ```
2. **FIRST COMMAND THAT NEEDS OWNER APPROVAL** — start the Sandbox-mode merchant on the operator's public HTTPS host **[NETWORK: makes the merchant publicly reachable; enables up to 1 Sandbox order]**:
   ```bash
   MERCHANT_CHECKOUT_MODE=SANDBOX_POPUP_TEST \
   MERCHANT_PUBLIC_ORIGIN=https://phase-c.<your-domain> \
   MERCHANT_DATA_DIR=/var/lib/phase-c-merchant \
   PHASE_C_APPROVAL_EXPIRES_AT=<as printed> PHASE_C_MAX_MINUTES=10 PHASE_C_MAX_KERNEL_USD=0.50 \
   PHASE_C_APPROVED_DIGEST=<the digest the owner approved> \
   node --env-file=/etc/phase-c-merchant/sandbox.env dist-merchant/apps/phase-c-test-merchant/src/main.js
   ```
   `sandbox.env` (mode 0600, not in git) holds `MERCHANT_PAYPAL_CLIENT_ID`, `MERCHANT_PAYPAL_CLIENT_SECRET`, `MERCHANT_PAYPAL_SELLER_MERCHANT_ID`, `MERCHANT_STATUS_SECRET`, `MERCHANT_OPERATOR_KEY`. The process prints `MERCHANT_STARTED` with the digest prefix and refuses (`REFUSED …`, exit 2) on any mismatch.
3. Pre-flight **[NETWORK, read-only]**: `curl -sI https://phase-c.<your-domain>/p/off_lumen_q3` (200, CSP lists only allowlisted hosts) and `npm run phase-c:kernel-check -- --read-only-kernel-call` → `NO_KERNEL_BROWSER_RUNNING`.
4. Start DIAPORIA on loopback with the KERNEL driver **[BILLED once a browser is created]**:
   ```bash
   HANDOFF_DRIVER=kernel DIAPORIA_ALLOW_KERNEL_LIVE=1 HANDOFF_KERNEL_MAX_SESSIONS=1 HANDOFF_RECIPES_FILE=.data/phase-c-recipes.json \
   RESEARCH_PROVIDER=mock PAYMENT_PROVIDER=mock node --env-file=<path>/.env.local dist/src/main.js
   ```
5. From the AI host: `research_purchase` ("Buy Lumen Q3 Black wireless headphones, never exceed $150."), `compare_purchase_offers` (`{brand:"Lumen",model:"Q3",variant:"Black",condition:"new",sku:"LUM-Q3-B"}`, US-CA), `prepare_browser_checkout` (`off_lumen_q3`, quantity 1, maximum 12000). **This creates the one KERNEL browser.** Expect `HUMAN_ACTION_REQUIRED` with total 10760.
6. Owner opens the handoff link, enters the owner key, sets a maximum ≥ $107.60, takes over, presses the merchant's PayPal button. This creates the one Sandbox order. **Do not log in, do not approve.** Observe whether the `www.sandbox.paypal.com` popup renders and is clickable. Close it (Cancel), then "I'm done".
7. Record the C1 result (redacted: no Live View URL, no cookies, no tokens, no emails):
   - `C1_PASS`: real Sandbox popup visible and operable through Live View; no capture; DIAPORIA `CANCELLED` or `ORDER_UNVERIFIED`; browser deletion verified.
   - `NETWORK_POLICY_BLOCKED`: something failed to load; name the host from `/operator/diagnostics` (`cspBlockedHosts`, `sdkEvents`) or the browser error. Do not widen the allowlist without a new digest.
   - `HOLD`: unexpected payee/amount/domain, login prompt for real PayPal, CAPTCHA/risk challenge, SDK error, timeout, or unverified deletion. Do not retry automatically.
8. Shut down: stop DIAPORIA (Ctrl+C), stop the merchant (Ctrl+C, or it stops at expiry), then `npm run phase-c:kernel-check -- --read-only-kernel-call` → `NO_KERNEL_BROWSER_RUNNING` and check the KERNEL dashboard.

## C2 — Sandbox buyer approval with seller-side capture (separate approval, only after C1 passes)

New approval with `--gate C2` (same seller id); new digest; `MERCHANT_CHECKOUT_MODE=SANDBOX_APPROVAL_TEST`; a **new** merchant data directory (so it is a new controlled order); a new KERNEL browser. Same steps 2–8, except in step 6 the human signs in with the **Sandbox personal** buyer and approves the fixed $107.60 order directly. The merchant server (never DIAPORIA) captures once with `PayPal-Request-Id: phc-capture-<orderId>`. Expected merchant state: `ORDER_CONFIRMED`, or `CAPTURE_PENDING` / `PAYMENT_DENIED` / `ORDER_UNKNOWN` reported as such. No retry of a capture without `/operator/reconcile` first.

## C3 — seller-side read-only verification (after C2)

```bash
curl -s -H "Authorization: Bearer $MERCHANT_OPERATOR_KEY" -H 'Content-Type: application/json' \
  -d '{"cartRef":"<cartRef>"}' https://phase-c.<your-domain>/operator/reconcile > merchant-status.json   # [NETWORK] one Sandbox GET, no mutation
# save DIAPORIA's get_browser_checkout_status result as diaporia-status.json
npm run phase-c:c3-compare -- --merchant merchant-status.json --diaporia diaporia-status.json
```

`C3_CONSISTENT` only if both report the same cart and total, DIAPORIA's state equals the rule in `expectedDiaporiaOutcome` (merchant `ORDER_CONFIRMED` ↔ DIAPORIA `ORDER_CONFIRMED`; `CAPTURE_PENDING`, `BUYER_APPROVED`, `PAYMENT_DENIED`, `ORDER_UNKNOWN` ↔ `ORDER_UNVERIFIED`), fulfillment is `NOT_VERIFIED`, and DIAPORIA created no payment order. Never reinterpret `PENDING` or `UNKNOWN` as success. Cross-check the Sandbox business account's activity in the PayPal Sandbox dashboard by hand.
