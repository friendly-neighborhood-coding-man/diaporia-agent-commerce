# Phase C operator checklist (C0 → C3)

**Current position: C0 complete; both PR #6 reviews (2026-11-10) addressed offline; C1 HELD.** Before C1 the owner still requires: the exact operator-controlled HTTPS origin and deployed host/account, a reviewed `network-allowlist.json`, an independent C0 security review, network isolation either tested (§C1 step 6a) or recorded `UNVERIFIED`, and a new explicit C1 authorization signed with the owner's key. Nothing below C0 has been run. Each gate needs a fresh, explicit owner approval that names its parameters. Earlier KERNEL Phase B approvals (the $0.50 synthetic-popup run) do **not** cover any Phase C step. Never reuse Sandbox order `9DL148415W2504835` or capture `92U85747JU359434A`.

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

| code pinning | `merchantArtifactSha256` / `diaporiaArtifactSha256` in the statement, recomputed by each side from the code it runs; `sourceCommit` for humans | — | a merchant or DIAPORIA built from other code refuses to start |
| owner authorization | Ed25519 signature by the owner's key over the digest (`npm run phase-c:sign`, on the owner's machine); both sides verify it; separately for each C2 capture retry | — | a digest alone is a checksum anyone can recompute; the signature is the approval |
| host / account | `merchantHost`, `diaporiaHost` (`os.hostname()`), `diaporiaServiceUser` (`os.userInfo()`) in the statement, checked at startup | — | accidental second host or another OS account. Hostnames can be set by whoever controls the machine, so this is not proof against a hostile operator. |

Run **one** merchant process on **one** host per approval, and DIAPORIA as **one** process under **one** dedicated service account with persistent storage for `~/.diaporia/kernel-browser-ledger`. The KERNEL ledger does not cap browsers started under another OS user, home dir or host: the owner's account-side KERNEL budget and live supervision are required. Two merchant hosts mounting different disks at the same path are not detected by the merchant.

## C1 — real PayPal Sandbox popup through KERNEL, NO capture (needs approval)

The owner's C1 approval must state: the exact merchant HTTPS origin and the host serving it, the Sandbox seller (its merchant id hash is in the statement), the reviewed allowlist (its SHA-256 is in the statement), the merchant data dir (in the statement), permission to create **one** new Sandbox order if the SDK needs it to open the popup, **one** KERNEL browser, the maximum minutes (≤ 10), a **non-enforceable** KERNEL USD estimate, and **no capture**. The owner approves the **digest** printed by step 1.

KERNEL `allowed_hosts` is a KERNEL-managed egress filter. It is **not** a VM-level firewall and not DNS-rebinding protection, and its behaviour (including KERNEL's proxy/allowlist version) has not been independently verified. Unless step 6a is performed and recorded, the C1 evidence must say `networkIsolation: UNVERIFIED`. An expected `NETWORK_POLICY_BLOCKED` is acceptable C1 evidence.

0. Owner, once, on the owner's own machine (offline): `npm run phase-c:sign -- --gen-key <private dir>` → keep `owner-ed25519.pem` private; give `owner-ed25519.pub.pem` to the operator.
1. Offline, from a **clean checkout of the approved commit** on the deployment hosts: `git checkout <commit> && rm -rf dist dist-merchant && npm ci && npm run build`. Then produce the statement and digest for the owner (no network):
   ```bash
   npm run phase-c:approval -- --gate C1 --origin https://phase-c.<your-domain> --seller-merchant-id <SANDBOX_BUSINESS_MERCHANT_ID> \
     --data-dir /var/lib/phase-c-merchant/c1-run-1 --expires <ISO-8601, ≤ 24 h ahead> --max-minutes 10 --kernel-usd-estimate 0.50 \
     --merchant-host <merchant hostname> --diaporia-host <DIAPORIA hostname> --diaporia-user <DIAPORIA service account> \
     --owner-public-key owner-ed25519.pub.pem > .data/phase-c-c1-statement.json
   npm run phase-c:recipe -- --origin https://phase-c.<your-domain> > .data/phase-c-recipes.json
   ```
   The statement pins `sourceCommit` and the built artifact hashes (the script refuses a dirty tree). If the merchant and DIAPORIA run on different machines, build the same commit on both and check that each side's hash matches the statement (each refuses to start otherwise).
   The owner reads the statement, then signs on the owner's machine: `npm run phase-c:sign -- --key owner-ed25519.pem --purpose approval --digest <digest>` → `PHASE_C_APPROVAL_SIGNATURE`.
2. **FIRST COMMAND THAT NEEDS OWNER APPROVAL** — start the Sandbox-mode merchant on the operator's public HTTPS host **[NETWORK: makes the merchant publicly reachable; enables up to 1 Sandbox order]**:
   ```bash
   MERCHANT_CHECKOUT_MODE=SANDBOX_POPUP_TEST \
   MERCHANT_PUBLIC_ORIGIN=https://phase-c.<your-domain> \
   MERCHANT_DATA_DIR=/var/lib/phase-c-merchant/c1-run-1 \
   PHASE_C_APPROVAL_EXPIRES_AT=<as printed> PHASE_C_MAX_MINUTES=10 PHASE_C_KERNEL_USD_ESTIMATE=0.50 \
   PHASE_C_SOURCE_COMMIT=<as printed> PHASE_C_DIAPORIA_ARTIFACT_SHA256=<as printed> \
   PHASE_C_DIAPORIA_HOST=<as printed> PHASE_C_DIAPORIA_SERVICE_USER=<as printed> \
   PHASE_C_OWNER_PUBLIC_KEY_FILE=/etc/phase-c-merchant/owner-ed25519.pub.pem \
   PHASE_C_APPROVED_DIGEST=<the digest the owner approved> PHASE_C_APPROVAL_SIGNATURE=<owner's signature> \
   node --env-file=/etc/phase-c-merchant/sandbox.env dist-merchant/apps/phase-c-test-merchant/src/main.js
   ```
   `sandbox.env` (mode 0600, not in git) holds `MERCHANT_PAYPAL_CLIENT_ID`, `MERCHANT_PAYPAL_CLIENT_SECRET`, `MERCHANT_PAYPAL_SELLER_MERCHANT_ID`, `MERCHANT_STATUS_SECRET`, `MERCHANT_OPERATOR_KEY`. The process prints `MERCHANT_STARTED` with the digest prefix and refuses (`REFUSED …`, exit 2) on any mismatch (including other code: `APPROVAL_DIGEST_MISMATCH` names the artifact hash prefix and host it computed), on a missing or wrong owner signature (`APPROVAL_SIGNATURE_INVALID`), if another instance holds the lease (`INSTANCE_LEASE_HELD`), or if the data dir belongs to another approval.
3. Pre-flight **[NETWORK, read-only]**: `curl -sI https://phase-c.<your-domain>/p/off_lumen_q3` (200, CSP lists only allowlisted hosts) and `npm run phase-c:kernel-check -- --read-only-kernel-call` → `NO_KERNEL_BROWSER_RUNNING`.
4. Start DIAPORIA on loopback with the KERNEL driver **[BILLED once a browser is created]**:
   ```bash
   HANDOFF_DRIVER=kernel DIAPORIA_ALLOW_KERNEL_LIVE=1 HANDOFF_RECIPES_FILE=.data/phase-c-recipes.json \
   PHASE_C_APPROVAL_STATEMENT_FILE=.data/phase-c-c1-statement.json PHASE_C_OWNER_PUBLIC_KEY_FILE=<owner-ed25519.pub.pem> \
   PHASE_C_APPROVED_DIGEST=<the same digest> PHASE_C_APPROVAL_SIGNATURE=<the same signature> \
   RESEARCH_PROVIDER=mock PAYMENT_PROVIDER=mock node --env-file=<path>/.env.local dist/src/main.js
   ```
5. From the AI host: `research_purchase` ("Buy Lumen Q3 Black wireless headphones, never exceed $150."), `compare_purchase_offers` (`{brand:"Lumen",model:"Q3",variant:"Black",condition:"new",sku:"LUM-Q3-B"}`, US-CA), `prepare_browser_checkout` (`off_lumen_q3`, quantity 1, maximum 12000). **This creates the one KERNEL browser** (the ledger slot is taken first; a restarted DIAPORIA refuses to start a second browser for this digest). Expect `HUMAN_ACTION_REQUIRED` with total 10760.
6. Owner opens the handoff link, enters the owner key, sets a maximum ≥ $107.60, takes over, presses the merchant's PayPal button. This creates the one Sandbox order. **Do not log in, do not approve.** Observe **which surface** PayPal used (`presentationMode: "auto"` may choose a popup, a modal/overlay or a redirect) and whether it renders and is clickable. Write down: separate window / overlay on the page / page navigated. Close it (Cancel), then "I'm done".
6a. Optional, bounded, read-only negative network test (only if the owner's C1 approval includes it): in the same Live View browser, before closing it, type `https://example.com/` into the address bar once. Expected: it does not load. Record `networkIsolation: NEGATIVE_TEST_BLOCKED` (one host tested, nothing more is proven) or `NEGATIVE_TEST_LOADED` (→ `HOLD`). Without this step record `networkIsolation: UNVERIFIED`.
7. Record the C1 result (redacted: no Live View URL, no cookies, no tokens, no emails):
   - `C1_PASS` (popup): `/operator/diagnostics` `sdkEvents` shows `SURFACE_POPUP_OPENED` **and** the human saw PayPal Sandbox in a separate window, operable through Live View; no capture; DIAPORIA `CANCELLED` or `ORDER_UNVERIFIED`; browser deletion verified. Seeing only the PayPal button is **not** a pass.
   - `C1_PASS_OTHER_SURFACE`: the real Sandbox flow opened and was operable, but as a modal/overlay or redirect (`SURFACE_IFRAME_ADDED` / `SURFACE_PAGE_LEFT` without `SURFACE_POPUP_OPENED`). Report it as that surface, not as a popup pass.
   - `NETWORK_POLICY_BLOCKED`: something failed to load; name the host from `/operator/diagnostics` (`cspBlockedHosts`, `sdkEvents`) or the browser error. Do not widen the allowlist without a new digest.
   - `HOLD`: unexpected payee/amount/domain, login prompt for real PayPal, CAPTCHA/risk challenge, SDK error, timeout, or unverified deletion. Do not retry automatically.
8. Shut down: stop DIAPORIA (Ctrl+C), stop the merchant (Ctrl+C, or it stops at expiry), then `npm run phase-c:kernel-check -- --read-only-kernel-call` → `NO_KERNEL_BROWSER_RUNNING` and check the KERNEL dashboard.

## C2 — Sandbox buyer approval with seller-side capture (separate approval, only after C1 passes)

New approval with `--gate C2` (same seller id); new digest; `MERCHANT_CHECKOUT_MODE=SANDBOX_APPROVAL_TEST`; a **new** merchant data directory (so it is a new controlled order); a new KERNEL browser. Same steps 2–8, except in step 6 the human signs in with the **Sandbox personal** buyer and approves the fixed $107.60 order directly. The merchant server (never DIAPORIA) captures once with `PayPal-Request-Id: phc-capture-<orderId>`. Expected merchant state: `ORDER_CONFIRMED`, or `CAPTURE_PENDING` / `PAYMENT_DENIED` / `ORDER_UNKNOWN` reported as such. A lost capture is **never** retried by reconciliation. A retry is a separate C2 mutation: (1) `GET /operator/reconcile?cart=<cartRef>` must show `BUYER_APPROVED` (PayPal: APPROVED, no capture); (2) `npm run phase-c:approval -- --gate C2_CAPTURE_RETRY --c2-digest <C2 digest> --cart <cartRef> --order-ref <PHC-…>` prints a retry digest; (3) the owner approves that digest; (4) the owner signs that digest on the owner's machine (`npm run phase-c:sign -- --purpose capture-retry`); (5) the operator sends digest + signature once to `POST /operator/c2/retry-capture` **[NETWORK, PAYMENT MUTATION]**. Without the owner's signature the merchant refuses (`RETRY_OWNER_SIGNATURE_INVALID`). The merchant re-reads the order first, allows at most one retry per approval (durable slot) and reuses `PayPal-Request-Id: phc-capture-<orderId>`. Not available in C1.

## C3 — seller-side read-only verification (after C2)

```bash
curl -s -H "Authorization: Bearer $MERCHANT_OPERATOR_KEY" \
  "https://phase-c.<your-domain>/operator/reconcile?cart=<cartRef>" > merchant-status.json   # [NETWORK] GET only; one Sandbox GET; cannot capture
# save DIAPORIA's get_browser_checkout_status result as diaporia-status.json
npm run phase-c:c3-compare -- --merchant merchant-status.json --diaporia diaporia-status.json
```

`C3_CONSISTENT` only if both report the same cart and total, DIAPORIA's state equals the rule in `expectedDiaporiaOutcome` (merchant `ORDER_CONFIRMED` ↔ DIAPORIA `ORDER_CONFIRMED`; `CAPTURE_PENDING`, `BUYER_APPROVED`, `PAYMENT_DENIED`, `ORDER_UNKNOWN` ↔ `ORDER_UNVERIFIED`), fulfillment is `NOT_VERIFIED`, and DIAPORIA created no payment order. Never reinterpret `PENDING` or `UNKNOWN` as success. Cross-check the Sandbox business account's activity in the PayPal Sandbox dashboard by hand.
