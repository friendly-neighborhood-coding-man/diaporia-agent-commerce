# Research V2 checkpoint (resume here)

- **Branch:** `feature/research-decision-v2` on `fix/security-wp1-wp5` (c46a0f4). Local only, **not pushed**; push and PR
  need the owner's approval of a digest.
- **Worktrees used:** this branch; `rdv2-baseline` at 3742d16 (V1 source = c46a0f4, plus harness) for V1 runs.
- **State:** Stages A, B and C implemented; eval v2 (90 cases) and replay suite in place; docs in `docs/research/`.
- **Clean measurement used:** holdout 2 first run (`v2-final-168d1ea-…json`, `v1-baseline-c46a0f4-with-holdout2-…json`).
  Holdout 1 and, since J-08, holdout 2 are both seen. A new clean measurement needs new frozen cases (holdout 3) or
  independently written ones.

## Reproduce

```
npx tsc --noEmit
npx vitest run                                    # all tests
npx vitest run tests/research-v2*.test.ts         # V2 only
npx tsx scripts/research-eval-v2/cli.ts <label>   # V2 eval → docs/evidence/research-eval-v2/<label>-<ts>.json
npx tsx scripts/research-eval-v2/cli.ts <label> ../rdv2-baseline   # V1 on the same cases
npx tsx scripts/research-eval-v2/trace.ts <caseId> [steps]          # one case, with planner and evidence steps
```

The harness refuses to run if `holdout.ts` or `holdout2.ts` no longer match their freeze files. Never edit either file.

## Open items

1. Owner decision on the live plan `LTP-V2-01` (`LIVE_TEST_PLAN.md`).
2. Independent review of the cases and world (all agent-authored).
3. Known misses: q09 (possessive multi-word brand), d32/h25 (model-less products), h15 ordering.
4. Live per-request caps in `main.ts` stay Channel3 1 / Tavily 2 until the owner decides.
