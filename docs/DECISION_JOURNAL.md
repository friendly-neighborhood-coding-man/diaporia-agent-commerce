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
