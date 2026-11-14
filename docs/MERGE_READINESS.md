# Merge-readiness report: `integration/mvp-full-layer`

Date 2026-11-10. **Verdict: NOT READY TO MERGE to main.** Pushed with the owner's approval and open as **draft** PR [#9](https://github.com/friendly-neighborhood-coding-man/diaporia-agent-commerce/pull/9) against `main`. Do not merge.

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

## Pre-push audit (2026-11-10, before the push of 6ed7f1d)

- `npm run scan:secrets`: 200 tracked files, no findings.
- Diff `221fda9..6ed7f1d`, evidence files included, searched for keys, tokens, private keys, personal email addresses, IPs and local paths. Results:
  - no secrets;
  - the only email is `p@a.example` in a test fixture;
  - the only IP is `127.0.0.1`;
  - infrastructure files are placeholder templates already public in #7 and #8.
- No tracked `.env`, key, pem, sqlite or `.data/` file. Generated runtime credentials (`.data/dev-credentials.json`, interop tokens) are gitignored and untracked.
- All branch commits use the owner's GitHub noreply address.
- No file deleted and no test removed relative to #6. #5, #6, #7 and #8 heads are ancestors of the branch.
- Clean `npm ci`, then typecheck, 347/347 tests, build, `demo:e2e`, `demo:phase-c` and secret scan: all pass.

## Checks run locally

| Check | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm test` | 347/347 pass (24 files) |
| `npm run build` | pass |
| `npm run scan:secrets` | no findings |
| `npm run dogfood` | A–H, J, K PASS; I NOT_RUN |
| `npm run eval:research` | 18/18, 0 critical |

## CI on GitHub (commit 6ed7f1d)

| Run | Event | Jobs | Result |
|---|---|---|---|
| [42793944772](https://github.com/friendly-neighborhood-coding-man/diaporia-agent-commerce/actions/runs/42793944772) | push | test (22), test (24), gitleaks | all **success** |
| [42793998683](https://github.com/friendly-neighborhood-coding-man/diaporia-agent-commerce/actions/runs/42793998683) | pull_request (merge of 6ed7f1d into main 280e869) | test (22), test (24), gitleaks | all **success** |

Each test job ran `npm ci`, typecheck, tests (347/347 on Node 22.23.4; Node 24 also passed), build, `demo:e2e`, `demo:phase-c` and secret scan. A runner was available for this repository. Later commits on this branch have their own checks on the PR.

## Contract compatibility

- The five original purchase tools keep their names, input and output schemas. `prepare_checkout` gained one behaviour: an identical repeat after COMPLETED returns the completed checkout with `deduplicated: true` (it used to create a new checkout).
- Browser-handoff tools unchanged.
- New HTTP routes: `POST /owner/checkouts/:id/cancel` (owner key), OAuth endpoints and `/.well-known/*` (only in `DIAPORIA_AUTH_MODE=oauth`). Existing routes are unchanged, except that human pages name the payment environment explicitly.
- `dev` and `public-readonly-demo` modes behave as before. In `public-readonly-demo` the payment-route 403 rule is unchanged.

## Blockers before merging to main

1. Owner review of this branch, plus the open reviews of #5 and #6 that it inherits. **The Phase C C0 independent security review is still outstanding.**
2. ~~CI must run on GitHub.~~ Done: green on Node 22 and 24, gitleaks clean (above). Keep it green for every later commit.
3. PR #4 decisions remain open (price, country eligibility, Sandbox steps). Merging keeps billing in MOCK, which is safe, but the owner may want #4 resolved first.
4. The squash relationship means #2, #3 and #4 cannot be merged on their own after this lands. Close them as superseded, or merge only this branch.

## Risks

- Startup recovery now makes provider **reads** for UNKNOWN checkouts without a capture id. In Sandbox that is extra GET traffic at startup; it never writes.
- OAuth adds a public attack surface when deployed. Rate limits are per-process. The owner key is the only human credential: a leaked owner key lets an attacker approve OAuth clients **and** create mandates, as before.
