# Decision journal

Compact record: attempted → observed → cause (only where evidence supports it) → change → verification → remaining uncertainty. Newest last.

## 2026-11-10 · Integration branch

- **Attempted:** consolidate PRs #2–#8 without merging any draft PR.
- **Observed:** PR #5 (`integration/commerce-v1`) is a squash-integration of #2, #3 and #4 plus hardening. #6 sits on #5; #7 and #8 sit on #6 and add only docs and staged config. Direct `git merge` of #2/#3/#4 into #6 conflicts (squash history), but a script found every file and every `it(...)` title of #2, #3 and #4 present in #6.
- **Change:** local branch `integration/mvp-full-layer` = #6 tip `221fda9` + merge of #7 + merge of #8. Not pushed (owner rule).
- **Verification:** 322/322 tests, typecheck, build and secret scan before any edit.
- **Uncertainty:** a test title being present does not prove identical assertions; #5's own review is the authority for that.

## 2026-11-10 · Phase C MOCK return page said "(Sandbox)"

- **Observed:** `apps/phase-c-test-merchant/src/server.ts` return page appended `USD (Sandbox)` to every confirmed order, including MOCK mode.
- **Change:** label from the running mode (MOCK: "simulated, no PayPal call, no money").
- **Verification:** new test asserts the MOCK page contains no "Sandbox".
- **Consequence:** the merchant artifact tree hash pinned in the Phase C approval v3 statement changes. Any C1/C2 approval must be generated from this branch's commit.

## 2026-11-10 · Remote MCP authentication

- **Decision:** implement OAuth 2.1 in-process (no new dependency) instead of a login screen or a token minting page, because remote MCP clients discover auth via RFC 9728 and register via RFC 7591.
- **Human authentication:** the owner key (already the human-only credential). Owner-key login is a placeholder for a real IdP; the token, client and consent model do not depend on it.
- **Boundary kept:** OAuth tokens are AI-client credentials and cannot create mandates. On a public https base URL, payment tools are not offered and payment routes return 403, with no flag to change that.
- **Verification:** the official MCP TypeScript SDK client completes discovery → registration → PKCE → token → tool calls (tests/oauth.test.ts). Mutation check: disabling PKCE, code-replay revocation or audience binding each makes a test fail.
- **Uncertainty:** no real remote host has connected; each platform's connector onboarding must be checked separately.

## 2026-11-10 · Dogfood run 1 found two defects

Evidence: `docs/evidence/dogfood/dogfood-2026-11-10T09-23-55-200Z.json` (7 PASS, 3 FAIL).

- **DF-1 (real):** after `TIMEOUT_AFTER_CAPTURE` the checkout is UNKNOWN with no capture id. Startup recovery only listed rows with a capture id, so a restart left it UNKNOWN until a human acted. **Change:** startup recovery reads the order; it adopts a capture only if PayPal shows one and never calls capture. **Verification:** DF-1 and DF-1b tests fail on the old code and pass now; scenario H passes.
- **DF-2 (real):** an identical `prepare_checkout` after COMPLETED skipped dedup (dedup excluded terminal states) and created a new checkout and provider order. With a 2-transaction mandate that set up a second payment needing only buyer approval. **Change:** a repeat after COMPLETED returns the completed checkout. **Verification:** DF-2 test fails on old code, passes now.
- **OAuth scope default (design):** the SDK client requested every `scopes_supported` scope, including `purchase.prepare`, by default. **Change:** metadata and the 401 challenge advertise only scopes the deployment offers (public: research + read). The consent page still lets the owner untick scopes.
- **Harness bugs (not defects):** scenario C expected a quantity-2 prepare to return HOLD, but the server correctly refused it earlier with `OVER_BUDGET`; scenario K expected a usage mode that only exists when a service plane is configured. Fixed in the harness.

## 2026-11-10 · Research evaluation run 1

Evidence: `docs/evidence/research-eval/research-eval-2026-11-10T09-29-08-369Z.json` (13/18, 0 critical).

- **Eval-world mistakes (corrected, not system defects):** (1) a fee offer used `hotel-supply.example`, whose registry fixture is not ACTIVE, so identity verification correctly excluded it; moved to a clean merchant. (2) R06/R16 expected the White alpha offer, but a cheaper offer filed under the Black product lists exactly White CX500-W, and the system correctly matches on the listed identity.
- **Real gap:** "Buy Contoso CX-500 Purple" returned AMBIGUOUS (asked Black or White) because the router's closed color list dropped "Purple". **Change:** extended the list. A general unknown-variant detector is still missing.
- **Result:** 18/18, 0 critical. **Uncertainty:** expectations were adjusted after seeing outputs in two cases (reasons above), and the same author wrote the world and the system, so this is a regression suite, not an independent accuracy measure.

## 2026-11-10 · Push and draft PR #9 (owner-approved)

- **Attempted:** the owner approved a push and a draft PR, conditional on a final security and evidence audit.
- **Observed (audit):** no secrets, personal data, local environment files or tracked runtime credentials were found in the diff or the evidence. Nothing from #2–#8 was deleted. A clean install passed every check. Details are in MERGE_READINESS.md.
- **Change:** pushed `integration/mvp-full-layer` at 6ed7f1d and opened draft PR #9 against `main`. Not merged.
- **Verification:** GitHub Actions push run 42793944772 and pull_request run 42793998683 were both green: test (Node 22), test (Node 24) and gitleaks. The Node 22 job log shows 347/347 tests. This repository has a working runner, unlike the 2026-11-03 observation on the other repository.
- **Uncertainty:** none about CI on 6ed7f1d. Later commits need their own green run.

## 2026-11-10 · Scenario I work package (prepared, not run)

- **Decision:** split each host's run into two one-shot phases with the human step in between. A headless host run cannot wait for a person, and the host must never hold spending authority. The human authorizes on the existing owner page ($60.00) and approves on the MOCK PayPal page. Each host's phase-2 prompt is generated from the checkout id that the server recorded for that host, not from the host's own text.
- **Probes** go straight to the server, so they do not pollute the hosts' wire log. They are: 401, cross-host NOT_FOUND (and owner-cancel 404), repeat prepare after COMPLETED (DF-2), and $6,000 under a $60 mandate.
- **Known host behaviour folded in:** Codex `exec` needs a per-tool approval for the non-read-only `prepare_checkout` (seen in the handoff run). Grok needs user-scope registration. Hermes needs a disposable home and a cleaned environment.
- **Verification:** `npm run scenario-i:selftest` runs setup, serve, a simulated host (MCP SDK client through the proxy), a simulated human, the probes and the builder. Three simulated hosts PASS, and a negative control that skips phase 2 FAILS on ten checks. The compared fields were checked to be populated, not null.
- **Uncertainty:** the self-test transcripts are synthetic copies in each host's format, so it proves only that the tooling works. Real host transcripts may differ in format. If a parser misses a real host's calls, `hostOriginated` fails, and the fix belongs in the parser, not in the server.

## 2026-11-10 · Scenario I run 1 stopped at the human step (DF-3)

- **Observed:** all four hosts finished phase 1 (`APPROVAL_REQUIRED`) on commit 2009936. The owner then opened each authorization link in his browser, and every Review submit returned `{"error":"Forbidden"}`.
- **Cause (reproduced in headless Chromium):** every response set `Referrer-Policy: no-referrer`. Under the Fetch standard, a browser then sends `Origin: null` on a same-origin form POST, and the owner page's Origin check (`sameOrigin`) rejects `null`. The MOCK PayPal approve form and the browser-handoff owner page had the same defect. The fetch()-based tests never send an Origin header, so none of them could see it.
- **Change:** `Referrer-Policy: same-origin` on the server and on the handoff pages. A referrer still never leaves the origin, and same-origin POSTs now carry the real Origin. The Origin check is unchanged: `null` and foreign origins are still refused.
- **Verification:** tests/browser-owner-flow.test.ts drives review → $60 → authorize → MOCK approve → COMPLETED in a real Chromium and asserts that all three POSTs carried the page's origin. A second test checks that `null` and foreign origins still get 403. The test fails on the old header. 349/349 tests pass.
- **Uncertainty:** run 1 host phase-1 transcripts are kept as evidence of an aborted run. Its checkouts expired unauthorized. Any rerun is a new run on the new commit.

## 2026-11-10 · Scenario I run 2 FAILED_DF4 (owner page left transferable spending authority)

- **Run status:** run 2 (commit 31c5110, owner's PC) is preserved as a failed security dogfood run, `FAILED_DF4`. Claude Code (rerun checkout cs_6c32fa23), Codex (rerun checkout cs_54f841c4) and Hermes (original checkout cs_84dddde0) each completed individually. Scenario I is **not** a PASS. Run 3 needs a separate owner go on a new commit.
- **Observed:**
  - Grok's original checkout cs_80366711 expired at 12:41:52Z. At 12:43:21Z the owner submitted its authorization link. The audit shows `CHECKOUT_EXPIRED` and then, in the same second, `MANDATE_CREATED_BY_OWNER`: mandate mdt_117bf235, ACTIVE, $60, bound to no checkout.
  - At 12:50:03Z Grok's phase-1 rerun (owner-approved) prepared a new checkout, cs_3cda1b43. That call reserved mdt_117bf235 and created MOCK order MOCK26420B07124853FF. It returned only `PAYPAL_BUYER_APPROVAL_REQUIRED`, so the owner never reviewed cs_3cda1b43. There was no buyer approval and no capture.
  - At 12:42:41Z a submit after Claude Code's checkout had COMPLETED left a second unused ACTIVE mandate, mdt_4f1ffbd3.
  - Both mandates were recorded in the preserved evidence (`.data/scenario-i-run2-FAILED_DF4/` on the owner's PC, not committed). They were not revoked with owner keys. Both have a 30-minute TTL, so they expire about 13:13Z. That run's server is to be stopped before any new run.
- **Root cause:**
  - The owner checkout-approval page created a general-purpose mandate (any merchant-matching checkout up to the limit) before checking that its own checkout could still be paid. When `startPayment` refused the expired or completed checkout, the mandate stayed ACTIVE.
  - The policy engine's mandate selection (`findApplicable`) then let any later prepare from the same user pick that mandate up automatically. One-checkout approvals and standing owner mandates were the same kind of object.
- **Changed invariants:**
  1. **Binding.** A page-created mandate has `scope = CHECKOUT_BOUND` and `bound_checkout_session_id = <that checkout>`. `evaluate` denies it for any other checkout (`BOUND_TO_OTHER_CHECKOUT`). `findApplicable` only ever selects `REUSABLE` mandates, so a bound mandate never authorizes a new checkout. Its merchant, maximum, currency and single transaction are the existing mandate limits; product identity, amount and currency are fixed on the bound checkout itself.
  2. **Distinguishable.** `PurchaseMandate.scope` is `REUSABLE` (owner API `/owner/mandates`) or `CHECKOUT_BOUND` (owner page). `create` refuses a page mandate without a bound id and an API mandate with one. Legacy page mandates from before the migration have no bound id, so they read as `CHECKOUT_BOUND` bound to nothing and are unusable.
  3. **Eligibility.** The authorize handler creates nothing unless the checkout is PREPARED, APPROVAL_REQUIRED or HOLD, has not expired (expiry is applied first), has no provider order and has no mandate. A refused submit returns 409 ("No new spending limit was created") and writes `OWNER_AUTHORIZATION_REFUSED`.
  4. **Atomicity.** The eligibility re-read, the expiry, the mandate insert and its audit event run in one `BEGIN IMMEDIATE` transaction. A partial UNIQUE index (`mandates_one_live_per_bound_checkout`) allows at most one non-revoked mandate per bound checkout as a database backstop.
  5. **Failure and uncertainty.** If payment initiation throws or is denied, a bound mandate that is unreserved and unused is revoked (`MANDATE_REVOKED_UNUSED`). A provider error releases the reservation, and `release` now revokes a released bound mandate. A provider timeout after create keeps the checkout `UNKNOWN` with its reservation for reconciliation. The bound mandate cannot be moved to another checkout, and a new prepare needs the owner again with no new order. Buyer cancel revokes the bound mandate.
- **Not changed:** an owner's explicit reusable mandate still authorizes a matching later prepare, as designed.
- **Independent review (fresh reviewer, given the code, not this entry):** invariants 1–4 and the release paths (buyer and owner cancel, expiry, failure, declined capture, consume, legacy rows, HOLD retry) were verified to hold. Findings:
  - F1 (medium, reproduced): an UNKNOWN create timeout had no provider order id, so nothing could reconcile it and its reservation stayed forever. Now fixed. `reconcile` replays the same create request with the same idempotency key, which recovers the one order and never makes a second. It then follows the normal path: an APPROVED order is captured and consumes the mandate. An unapproved order past expiry closes as CANCELLED, which releases and revokes the bound mandate. A failed replay keeps UNKNOWN and the reservation. Startup recovery stays read-only and does not replay.
  - F2 (low, not reproduced): with two server processes on one database, a cancel landing between the claim and the reservation could strand a reservation on a dead checkout. It stays bound to that checkout and is not transferable. One process per database is the supported deployment.
  - F3 (low, pre-existing, outside DF-4): a buyer return after the checkout's expiry is still captured. That affects only that checkout.
  - Cosmetic: the 409 page now shows the state after the re-check.
  - Recheck of the F1 fix: the replay was confirmed safe (one order, no capture, nothing released on failure).
    - N1 (medium, reproduced): the new close-after-expiry released the reservation using a checkout read before an await, so a racing buyer approval could capture with the limit handed back. Fixed: it re-reads, compare-and-sets and only then releases, all in one transaction, and a moved checkout is left alone. The regression test fails on the earlier code.
    - Low, left open: startup recovery does not replay or close. An expired recovered checkout waits for an owner reconcile, still bound and non-transferable.
    - Not tested: PayPal honours a repeated PayPal-Request-Id only for a limited window. A replay after that window would create a second order. No one ever received the first order's link, so at most one order could be approved.
- **Verification:**
  - tests/df4-authorization-binding.test.ts (12 tests, real Chromium for the attack sequence) covers:
    - the exact run-2 sequence: expired A, owner submit, 409, no live mandate, then B still needs the owner with no createOrder;
    - a live bound mandate for A refused for B;
    - a legacy unbound page mandate unusable;
    - completed, cancelled and already-authorized checkouts refused;
    - 6 concurrent submits giving 1×303 and 5×409, one mandate and one order;
    - the UNIQUE backstop;
    - createOrder error giving FAILED with no live mandate;
    - timeout-after-create giving UNKNOWN with the mandate kept and bound, and no new order;
    - buyer cancel revoking the bound mandate;
    - UNKNOWN recovered by idempotent replay then COMPLETED (one order, one capture, mandate EXHAUSTED), and UNKNOWN past expiry closed with the mandate REVOKED (both fail without the fix);
    - the reconcile/buyer-approval race (N1): one capture, mandate EXHAUSTED, nothing handed back;
    - a reusable mandate still auto-authorizing.
  - The three tests in tests/approval-ui.test.ts stay.
  - 364/364 tests, build, secret scan, dogfood A–H, J, K and the Scenario I self-test pass.
- **Run 3 precondition:** a fresh data directory on the new commit, with run 2's server stopped and its two mandates expired or revoked. The original Scenario I prompts and acceptance criteria are unchanged.

## 2026-11-10 · Expiry hardening: an expired checkout never starts a capture

- **Request:** the owner accepted DF-4 for the verified MOCK scope and asked for one more hardening pass before run 3. Run 3 is not started.
- **Defect (pre-existing, found in the DF-4 review as F3):** `handleBuyerReturn` never checked expiry. A buyer approval that arrived after `expiresAt` was still captured.
- **Changed invariants:**
  1. **No new capture past expiry.** The buyer return checks expiry before it verifies the approval. In APPROVAL_REQUIRED no capture was ever requested, so the checkout closes EXPIRED and the bound limit is revoked. The provider's order state is recorded (`BUYER_APPROVAL_AFTER_EXPIRY`).
  2. **The capture decision is atomic and made last.** In `capture()`, one transaction re-reads the checkout and compare-and-sets it, after every await (merchant re-check, recipient read). It then either commits CAPTURE_PENDING, refuses (FAILED `CHECKOUT_EXPIRED_BEFORE_CAPTURE`, released), or holds UNKNOWN.
  3. **Requested vs new capture.** `capture_requested_at` is written in that same transaction, before the provider call. Rows from before the column fall back to the `CAPTURE_REQUESTED` audit event or `CAPTURE_OUTCOME_UNKNOWN`. Unknown history counts as requested.
  4. **Uncertain and expired: reads only.** Reconcile of an expired UNKNOWN never captures or replays. It adopts a capture the provider shows. It closes only when the provider reports the order VOIDED with no capture (`PROVIDER_ORDER_VOIDED`).
  5. **No release while a requested capture could land.** A replay's own failures (mandate re-check, recipient read, a 4xx on the replayed capture) keep UNKNOWN and the reservation. Only the first request's 4xx is a definite rejection. Every close and expiry compare-and-sets before it releases, in one transaction; `expireIfNeeded` used to release first.
  6. **Wording.** FAILED `CHECKOUT_EXPIRED_BEFORE_CAPTURE` is reported as `EXPIRED`: "DIAPORIA never requested one, so no payment was taken". UNKNOWN never claims "not paid".
  7. **No refunds.** No refund or void call was added.
- **Legitimate recovery preserved:** before expiry, an uncertain capture is replayed once with the same request id and completes exactly once. A capture requested before expiry whose answer arrives later is honoured.
- **Independent review** (fresh reviewer, given the code only). It found:
  - **blocker:** replay exits before the gate called `fail()`, releasing and claiming "nothing was captured";
  - **high:** a 4xx on a replay was treated as a rejection;
  - **medium:** CAPTURE_PENDING with no capture id was stuck forever;
  - **low:** concurrent reconciles threw StaleStateError;
  - **low:** "failed" wording for an expiry.
  
  All are fixed with tests. A stuck CAPTURE_PENDING is treated as uncertain only after 5 minutes, well beyond the 20 s provider timeout. A process or event-loop stall longer than that could still let reconcile replay a live capture with the same request id. The reviewer reproduced this with a faked stall: one capture, then COMPLETED. It is safe only through PayPal idempotency; see the risk register, R2.
- **Recheck by the same reviewer:** the five fixes hold. It found G1, a blocker: two concurrent returns, where the second return's recipient read failed and its `fail()` moved the first return's in-flight CAPTURE_PENDING to FAILED with the reservation released. This was also possible before this change. Fixed: every pre-gate refusal compare-and-sets on the exact APPROVED version it started from, and re-decides "replay" on that fresh row. `holdUnknown` now also requires the version the caller decided on. The G1 regression test fails on the previous code. The cosmetic next action for an expiry before capture is now NEW_CHECKOUT_REQUIRED. A final recheck confirmed that G1 no longer reproduces and found no new money-unsafe path, with no blocker or high finding left. Its last low note is now closed: a 4xx on the first capture request also fails only the exact CAPTURE_PENDING version that call committed.
- **Status:** 390/390 tests, typecheck, build, secret scan, dogfood (10 PASS, I not run) and the Scenario I self-test pass.
- **Verification:** tests/expiry-capture.test.ts has 18 tests.
  - Real Chromium: expiry before approval, and expiry before capture via a delayed provider read.
  - Deterministic:
    - a late provider answer;
    - an uncertain capture then expiry: no retry, then VOIDED;
    - a lost response then expiry: adopted;
    - the legacy row;
    - five concurrent late returns across expiry: one refusal, zero captures, one release;
    - concurrent in-time returns: one capture;
    - review F1–F5 and G1.
  - Fourteen fail on the code from before their fixes, one of them only because the old code never sets the new marker.
  - The DF-4 race test was rewritten: past expiry the correct result is now no capture.

## 2026-11-10 · Semantic Fidelity v1 and DF-5 (MOCK checkouts said "PayPal Sandbox")

- **Observation (run 2, kept unchanged on the owner's PC):** Hermes told the user to "approve the PayPal sandbox payment" for a MOCK checkout. Run 2 remains FAILED_DF4; nothing is re-labelled.
- **Cause found (DF-5):** the server said so itself in MOCK mode:
  - every checkout summary's `disclosure` read "PayPal Sandbox demonstration…";
  - the `prepare_checkout` tool description said "a PayPal Sandbox order is created";
  - the MOCK order description said "DIAPORIA Sandbox demo".
  
  The host repeated server text that contradicted the server's own `paymentEnvironment: MOCK`.
- **Change:** disclosure, tool description and order description now name the environment that runs. `checkoutPath: PAYPAL_SANDBOX_DEMO_MERCHANT` is an enum contract value and is unchanged; see the risk register, R5.
- **Evaluation:** `scripts/interop/semantic-fidelity.mjs` (`npm run eval:semantic-fidelity`), ruleset `semantic-fidelity/v1`.
  - **Separate from the 17 checks.** It never changes a host's PASS/FAIL or Scenario I PASS. The original prompts and checks are unchanged.
  - **Inputs.** Phase 1 and phase 2 host text, compared against `prepare_checkout` and `get_checkout_status` evidence.
  - **Dimensions.** MOCK/Sandbox/live, payment vs merchant order, fulfillment, UNKNOWN/pending.
  - **Ambiguity.** Quoted claims; negated, hedged or mixed wording goes to `humanReview[]`.
  - **Verdicts.** CONTRADICTED, NEEDS_HUMAN_REVIEW or NO_CONTRADICTION. There is no PASS.
  - **Tests.** tests/semantic-fidelity.test.ts has 8 tests, including the Hermes sentence (CONTRADICTED) and a check that the CLI leaves its inputs untouched.
- **Remaining risks:** docs/RISK_REGISTER.md. No open run 3 blocker. Phase C blocker: unverified PayPal idempotency retention (R2).

## 2026-11-10 · Scenario I run 3: 4/4 hosts PASS the 17 checks (MOCK, local)

- **Authorization:** the owner's GO at 14:48Z, for commit 0d4aa8b, local and MOCK only. Hosts ran one at a time (Claude Code → Codex → Hermes → Grok), each finishing its whole workflow before the next began. There was one checkout per host. The owner authorized $60.00 and approved each MOCK payment in his own browser.
- **Preflight:**
  - exact commit and a clean tree; build and self-test PASS;
  - a fresh `.data/scenario-i-run3` (new database, tokens and owner keys; 0 mandates or checkouts at start);
  - run 2's two leftover mandates confirmed past `expires_at`;
  - no earlier Scenario I server running;
  - the server on 127.0.0.1:19991 and the proxy on 19990. 18991 was held by an unrelated leftover KERNEL-handoff server, which was left untouched. LAN access was refused.
  - `PAYMENT_PROVIDER=mock`, with no research, evidence or PayPal credential names in the server's environment.
- **Result:**
  - All four hosts PASS, 17/17 each. They completed at 15:11:54Z, 15:14:00Z, 15:19:05Z and 15:29:31Z, each with one MOCK capture of 5939. No checkout expired; nothing was renewed, re-authorized or replaced.
  - Probes `pass: true`:
    - a request without a token returned 401;
    - cross-host reads and cancels were refused;
    - a repeated prepare after COMPLETED was deduplicated;
    - $6,000 against a $60 limit was refused.
- **Reruns:** Hermes used the one allowed launch rerun. Its first attempt hit "Gateway starting: deadline" on a cold, fresh HERMES_HOME, as in run 1. The server saw only initialize, initialized and tools/list, with no tool call. That attempt is kept as `hermes-agent.p1.attempt1.*`.
- **Semantic Fidelity v1 (separate, non-gating):** no claim was CONTRADICTED.
  - Hermes: NO_CONTRADICTION. It said MOCK and never Sandbox, which differs from run 2 and follows the DF-5 fix.
  - Claude Code (1), Codex (2) and Grok (2) are NEEDS_HUMAN_REVIEW. All five flagged sentences are accurate negations, for example "No: a mock payment was captured, but the merchant never confirmed an order…". They await the owner's reviewer decision.
  - No host claimed a merchant order, a shipment, or Sandbox.
- **Cost:**
  - Claude Code (claude-opus-5-5): $0.531.
  - Grok (grok-4.7-build): $0.226.
  - Codex (gpt-6.1-terra): 192,387 input / 1,173 output tokens, with no dollar figure reported.
  - Hermes (haiku plugin): 132,097 tokens, with no dollar figure reported.
- **Notes, no new defect in DIAPORIA:**
  1. The Hermes `host` field in the matrix shows Hermes's own update-check warning, because `hermes --version` prints that first. The real version is v0.22.7; the evidence is unedited.
  2. Hermes needs a gateway pre-warm in a fresh home; proposed as a runbook step.
  3. Claude and Grok first offer MCP protocol 2026-07-28, get a 400, and fall back to 2025-11-25.
  4. Grok's first phase-2 `use_tool` used an unqualified tool name and failed inside Grok before reaching the server. The server saw exactly one status call and one receipt call.
- **Evidence:** on the owner's PC in `.data/scenario-i-run3/evidence`: `matrix.json`, the four host files and `semantic-fidelity.json`. A grep for token or key prefixes, personal email and user paths found 0 matches. It is not committed. Run 1 and run 2 are preserved; their sha256 re-check was still running at the time of writing.
- **Acceptance:** run 3 meets the Scenario I PASS definition (4/4 hosts plus probes) for MOCK on loopback. Full acceptance is the owner's decision, after the five human-review items.
