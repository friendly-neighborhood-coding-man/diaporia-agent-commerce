# Merge-readiness report: `integration/mvp-full-layer`

Date 2026-11-10. **Verdict: NOT READY TO MERGE to main.** It is ready to be pushed as a draft PR for review once the owner allows a push.

## What it contains

| Source | Head | Included as |
|---|---|---|
| PR #2 BYOK Completion | 345d69c | via PR #5 squash (all files and test titles present) |
| PR #3 Browser Checkout Handoff | 8af6652 | via PR #5 squash (all files and test titles present) |
| PR #4 Managed Billing (MOCK) | 94bbc21 | via PR #5 squash (all files and test titles present) |
| PR #5 Integration candidate | a64f5c4 | ancestor |
| PR #6 Phase C merchant (C0) | 221fda9 | base |
| PR #7 Cloudflare/VPS prep (config only) | f6860d3 | merge |
| PR #8 local tunnel MOCK runbook | 8520cdb | merge |
| This branch | see `git log 221fda9..` | Phase C label fix, OAuth 2.1, approval UI + owner cancel, dogfood harness + DF-1/DF-2 fixes, research eval |

## Checks run locally

| Check | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm test` | 347/347 pass (24 files) |
| `npm run build` | pass |
| `npm run scan:secrets` | no findings |
| `npm run dogfood` | A–H, J, K PASS; I NOT_RUN |
| `npm run eval:research` | 18/18, 0 critical |
| gitleaks (CI job) | **not run** (branch not pushed) |
| CI matrix Node 22/24 | **not run** (branch not pushed); local run used Node 22.23.4 only |

## Contract compatibility

- The five original purchase tools keep their names, input and output schemas. `prepare_checkout` gained one behaviour: an identical repeat after COMPLETED returns the completed checkout with `deduplicated: true` (it used to create a new checkout).
- Browser-handoff tools unchanged.
- New HTTP routes: `POST /owner/checkouts/:id/cancel` (owner key), OAuth endpoints and `/.well-known/*` (only in `DIAPORIA_AUTH_MODE=oauth`). Existing routes are unchanged, except that human pages name the payment environment explicitly.
- `dev` and `public-readonly-demo` modes behave as before. In `public-readonly-demo` the payment-route 403 rule is unchanged.

## Blockers before merging to main

1. Owner review of this branch, plus the open reviews of #5 and #6 that it inherits. **The Phase C C0 independent security review is still outstanding.**
2. CI (typecheck, tests on Node 22 and 24, build, `demo:e2e`, `demo:phase-c`, secret scan, gitleaks) must run on GitHub. Earlier sessions saw no runner on the other repository from 2026-11-03; this repository's runner state is unverified.
3. PR #4 decisions remain open (price, country eligibility, Sandbox steps). Merging keeps billing in MOCK, which is safe, but the owner may want #4 resolved first.
4. The squash relationship means #2, #3 and #4 cannot be merged on their own after this lands. Close them as superseded, or merge only this branch.

## Risks

- Startup recovery now makes provider **reads** for UNKNOWN checkouts without a capture id. In Sandbox that is extra GET traffic at startup; it never writes.
- OAuth adds a public attack surface when deployed. Rate limits are per-process. The owner key is the only human credential: a leaked owner key lets an attacker approve OAuth clients **and** create mandates, as before.
