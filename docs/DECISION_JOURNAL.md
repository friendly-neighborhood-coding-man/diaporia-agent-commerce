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
