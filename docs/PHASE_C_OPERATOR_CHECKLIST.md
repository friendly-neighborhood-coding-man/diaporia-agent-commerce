# Phase C operator checklist (C0 → C3)

**Current position: C0 complete; PR #6 review items 1–3 and 5 implemented offline; C1 HELD by the owner's review (2026-11-10).** Before C1 the owner still requires an independent C0 security review, a controlled HTTPS domain/host listing, and a new explicit C1 authorization. Nothing below C0 has been run. Each gate needs a fresh, explicit owner approval that names its parameters. Earlier KERNEL Phase B approvals (the $0.50 synthetic-popup run) do **not** cover any Phase C step. Never reuse Sandbox order `9DL148415W2504835` or capture `92U85747JU359434A`.

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
- [x] SDK v6 core calls checked by the owner against https://developer.paypal.com/sdk/js/set-up/ (review of `07f80cc`): script URL, `createInstance`, `findEligibleMethods`, `createPayPalOneTimePaymentSession`, `start({presentationMode:"auto"}, createOrderPromise)`, async `{orderId}`.
- [ ] Independent C0 security review (not done; required by the owner before C1).
- [ ] Review `apps/phase-c-test-merchant/config/network-allowlist.json` (currently only `www.sandbox.paypal.com`).
- [ ] Confirm the Sandbox accounts: one **Business** seller with a Sandbox REST app, one separate **Personal** buyer. No real credentials anywhere.
- [ ] Choose the HTTPS origin (a domain you control; no tunnel to a personal PC), list the exact host that serves it, and the approval window.
- [ ] Set an **account-side** KERNEL spending limit and plan to supervise the run. Nothing in this repository is a monetary circuit breaker (see "Spending controls" below).

### Spending controls (what is enforced, and what is not)

| Control | Enforced by | Survives restart | Covers |
|---|---|---|---|
| 1 KERNEL browser per approval | `src/handoff/kernelLedger.ts`: exclusive `attempt-0` file under `~/.diaporia/kernel-browser-ledger/<digest>/`, created **before** `POST /browsers`, never deleted | yes | restarts and every DIAPORIA process **on this host**. Not a second host. |
| ≤ 10 min per browser | detached KERNEL watchdog (existing) | yes | wall time |
| `kernelUsdEstimateNotEnforced` | **nothing** | — | an estimate the owner accepts. Not a circuit breaker. Use KERNEL's account-side limit + supervision. |
| 1 merchant instance | `instance.lease` in `MERCHANT_DATA_DIR` (exclusive create; a stale lease is never taken over automatically) | yes | replicas sharing the data dir |
| data dir ↔ approval | `MERCHANT_DATA_DIR` is in the digest; `approval.json` binds the dir to one digest | yes | a second instance with another data dir (different digest → refused) |
| 1 Sandbox order / ≤ 1 capture / ≤ 1 capture retry | exclusive slot files `run-<digest>/{order,capture,capture-retry}-slot-0`, reserved before the PayPal call, never released | yes | restarts, a lost `merchant-state.json` |
| provider-side backstop | `PayPal-Request-Id: phc-create-run-<digest>` (per approval, not per cart) | — | a second host that slipped past the lease gets PayPal's original order back, whose `custom_id` then fails verification. Retention window of PayPal's idempotency not verified. |

Run **one** merchant process on **one** host per approval. Two hosts mounting different disks at the same path are not detected by the merchant.

## C1 — real PayPal Sandbox popup through KERNEL, NO capture (needs approval)

The owner's C1 approval must state: the exact merchant HTTPS origin and the host serving it, the Sandbox seller (its merchant id hash is in the statement), the reviewed allowlist (its SHA-256 is in the statement), the merchant data dir (in the statement), permission to create **one** new Sandbox order if the SDK needs it to open the popup, **one** KERNEL browser, the maximum minutes (≤ 10), a **non-enforceable** KERNEL USD estimate, and **no capture**. The owner approves the **digest** printed by step 1.

KERNEL `allowed_hosts` restricts the browser's egress as KERNEL implements it; it is not VM-level isolation and has not been independently verified. An expected `NETWORK_POLICY_BLOCKED` is acceptable C1 evidence.

1. Offline, produce the statement and digest for the owner (no network):
   ```bash
   npm run phase-c:approval -- --gate C1 --origin https://phase-c.<your-domain> --seller-merchant-id <SANDBOX_BUSINESS_MERCHANT_ID> --data-dir /var/lib/phase-c-merchant/c1-run-1 --expires <ISO-8601, ≤ 24 h ahead> --max-minutes 10 --kernel-usd-estimate 0.50
   npm run phase-c:recipe -- --origin https://phase-c.<your-domain> > .data/phase-c-recipes.json
   ```
2. **FIRST COMMAND THAT NEEDS OWNER APPROVAL** — start the Sandbox-mode merchant on the operator's public HTTPS host **[NETWORK: makes the merchant publicly reachable; enables up to 1 Sandbox order]**:
   ```bash
   MERCHANT_CHECKOUT_MODE=SANDBOX_POPUP_TEST \
   MERCHANT_PUBLIC_ORIGIN=https://phase-c.<your-domain> \
   MERCHANT_DATA_DIR=/var/lib/phase-c-merchant/c1-run-1 \
   PHASE_C_APPROVAL_EXPIRES_AT=<as printed> PHASE_C_MAX_MINUTES=10 PHASE_C_KERNEL_USD_ESTIMATE=0.50 \
   PHASE_C_APPROVED_DIGEST=<the digest the owner approved> \
   node --env-file=/etc/phase-c-merchant/sandbox.env dist-merchant/apps/phase-c-test-merchant/src/main.js
   ```
   `sandbox.env` (mode 0600, not in git) holds `MERCHANT_PAYPAL_CLIENT_ID`, `MERCHANT_PAYPAL_CLIENT_SECRET`, `MERCHANT_PAYPAL_SELLER_MERCHANT_ID`, `MERCHANT_STATUS_SECRET`, `MERCHANT_OPERATOR_KEY`. The process prints `MERCHANT_STARTED` with the digest prefix and refuses (`REFUSED …`, exit 2) on any mismatch, if another instance holds the lease (`INSTANCE_LEASE_HELD`), or if the data dir belongs to another approval.
3. Pre-flight **[NETWORK, read-only]**: `curl -sI https://phase-c.<your-domain>/p/off_lumen_q3` (200, CSP lists only allowlisted hosts) and `npm run phase-c:kernel-check -- --read-only-kernel-call` → `NO_KERNEL_BROWSER_RUNNING`.
4. Start DIAPORIA on loopback with the KERNEL driver **[BILLED once a browser is created]**:
   ```bash
   HANDOFF_DRIVER=kernel DIAPORIA_ALLOW_KERNEL_LIVE=1 HANDOFF_RECIPES_FILE=.data/phase-c-recipes.json \
   PHASE_C_APPROVED_DIGEST=<the same digest> \
   RESEARCH_PROVIDER=mock PAYMENT_PROVIDER=mock node --env-file=<path>/.env.local dist/src/main.js
   ```
5. From the AI host: `research_purchase` ("Buy Lumen Q3 Black wireless headphones, never exceed $150."), `compare_purchase_offers` (`{brand:"Lumen",model:"Q3",variant:"Black",condition:"new",sku:"LUM-Q3-B"}`, US-CA), `prepare_browser_checkout` (`off_lumen_q3`, quantity 1, maximum 12000). **This creates the one KERNEL browser** (the ledger slot is taken first; a restarted DIAPORIA refuses to start a second browser for this digest). Expect `HUMAN_ACTION_REQUIRED` with total 10760.
6. Owner opens the handoff link, enters the owner key, sets a maximum ≥ $107.60, takes over, presses the merchant's PayPal button. This creates the one Sandbox order. **Do not log in, do not approve.** Observe **which surface** PayPal used (`presentationMode: "auto"` may choose a popup, a modal/overlay or a redirect) and whether it renders and is clickable. Write down: separate window / overlay on the page / page navigated. Close it (Cancel), then "I'm done".
7. Record the C1 result (redacted: no Live View URL, no cookies, no tokens, no emails):
   - `C1_PASS` (popup): `/operator/diagnostics` `sdkEvents` shows `SURFACE_POPUP_OPENED` **and** the human saw PayPal Sandbox in a separate window, operable through Live View; no capture; DIAPORIA `CANCELLED` or `ORDER_UNVERIFIED`; browser deletion verified. Seeing only the PayPal button is **not** a pass.
   - `C1_PASS_OTHER_SURFACE`: the real Sandbox flow opened and was operable, but as a modal/overlay or redirect (`SURFACE_IFRAME_ADDED` / `SURFACE_PAGE_LEFT` without `SURFACE_POPUP_OPENED`). Report it as that surface, not as a popup pass.
   - `NETWORK_POLICY_BLOCKED`: something failed to load; name the host from `/operator/diagnostics` (`cspBlockedHosts`, `sdkEvents`) or the browser error. Do not widen the allowlist without a new digest.
   - `HOLD`: unexpected payee/amount/domain, login prompt for real PayPal, CAPTCHA/risk challenge, SDK error, timeout, or unverified deletion. Do not retry automatically.
8. Shut down: stop DIAPORIA (Ctrl+C), stop the merchant (Ctrl+C, or it stops at expiry), then `npm run phase-c:kernel-check -- --read-only-kernel-call` → `NO_KERNEL_BROWSER_RUNNING` and check the KERNEL dashboard.

## C2 — Sandbox buyer approval with seller-side capture (separate approval, only after C1 passes)

New approval with `--gate C2` (same seller id); new digest; `MERCHANT_CHECKOUT_MODE=SANDBOX_APPROVAL_TEST`; a **new** merchant data directory (so it is a new controlled order); a new KERNEL browser. Same steps 2–8, except in step 6 the human signs in with the **Sandbox personal** buyer and approves the fixed $107.60 order directly. The merchant server (never DIAPORIA) captures once with `PayPal-Request-Id: phc-capture-<orderId>`. Expected merchant state: `ORDER_CONFIRMED`, or `CAPTURE_PENDING` / `PAYMENT_DENIED` / `ORDER_UNKNOWN` reported as such. A lost capture is **never** retried by reconciliation. A retry is a separate C2 mutation: (1) `GET /operator/reconcile?cart=<cartRef>` must show `BUYER_APPROVED` (PayPal: APPROVED, no capture); (2) `npm run phase-c:approval -- --gate C2_CAPTURE_RETRY --c2-digest <C2 digest> --cart <cartRef> --order-ref <PHC-…>` prints a retry digest; (3) the owner approves that digest; (4) the operator sends it once to `POST /operator/c2/retry-capture` **[NETWORK, PAYMENT MUTATION]**. The merchant re-reads the order first, allows at most one retry per approval (durable slot) and reuses `PayPal-Request-Id: phc-capture-<orderId>`. Not available in C1.

## C3 — seller-side read-only verification (after C2)

```bash
curl -s -H "Authorization: Bearer $MERCHANT_OPERATOR_KEY" \
  "https://phase-c.<your-domain>/operator/reconcile?cart=<cartRef>" > merchant-status.json   # [NETWORK] GET only; one Sandbox GET; cannot capture
# save DIAPORIA's get_browser_checkout_status result as diaporia-status.json
npm run phase-c:c3-compare -- --merchant merchant-status.json --diaporia diaporia-status.json
```

`C3_CONSISTENT` only if both report the same cart and total, DIAPORIA's state equals the rule in `expectedDiaporiaOutcome` (merchant `ORDER_CONFIRMED` ↔ DIAPORIA `ORDER_CONFIRMED`; `CAPTURE_PENDING`, `BUYER_APPROVED`, `PAYMENT_DENIED`, `ORDER_UNKNOWN` ↔ `ORDER_UNVERIFIED`), fulfillment is `NOT_VERIFIED`, and DIAPORIA created no payment order. Never reinterpret `PENDING` or `UNKNOWN` as success. Cross-check the Sandbox business account's activity in the PayPal Sandbox dashboard by hand.
