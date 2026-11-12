# Post-submission DIAPORIA improvement loop

This branch is separated from the PayPal Hackathon submission build and the standalone GitHub Pages landing page.

## Frozen anchors

- Original research engine: `4bc7dcca29c3fbeb1fea791866e561521d6f8264`
- Submitted integrated UI/demo code: `be03b52c7587c8311a51f8d3748395260e9c4e6b`
- Starting post-submission branch ancestor: `d20aedc7e7637c1d32d22778dfa7991f07065335`
- **Prediction-register pre-repair commit:** `639ca302793abff4cd9742cc1c371830d1ae94a6`

The prediction file was committed **before** any changes to research, evidence, identity, purchase or payment code on this branch.

## Workflow

1. **Inspect:** Run the existing 1,045 tests and the pure-function mechanism probes (`npx tsx scripts/loop/probe-known.ts`). These are known/seen probes, not novel evaluation.
2. **Diagnose:** Use multiple plausible causes and differentiating counterexamples. Preserve evidence for rejected hypotheses.
3. **Pre-register:** Read `PREDICTIONS.md`. Do not alter it after the freeze. Validate using `node scripts/loop/verify-predictions.mjs`.
4. **Repair:** Implement small, localized changes, one mechanism family per commit. Add regression tests and keep the positive-control funnel visible. Avoid indiscriminate HOLD as a way to obtain zero unsafe results.
5. **Regression:** Rerun IW-19/20 as **seen**, measure both safety and usefulness (false HOLD and legitimate prepared checkout).
6. **Independent IW-21:** An evaluator who has not seen the candidate output creates and seals cases first. It should not use this prediction register to design cases. Allow exactly one first scored run, then mark the cases SEEN.
7. **Reflect:** Append the truth—including prediction failures and new regressions—to the change journal. Keep conclusions narrower than evidence; do not claim a learned model or improved ordinary-debugging baseline.

### Outcome schema

Every run should report: `engine_commit`, `case_set_sha256`, `prediction_commit`, `first_scored`, `provider_caps`, `correct/total`, `unsafe`, `payment_bypass/attempts`, `legitimate_prepared/positive_controls`, `fully_correct_prepared`, `false_investigate`, `false_hold`, `wrong_identity`, `cost`, `elapsed`, and `method_limitations`.

Avoid overclaiming: a targeted new failure-class set can provide evidence for mechanism transfer within that family, not global safety or cross-domain generalization. Equal-access/time/probe ordinary-debugging controls remain to be designed and run.

## The first resumed cycle

Target the still-open semantic mechanisms: F2 (activity/audience fitment), F3 (postposed part request), F4 (quantity threshold vs exact variant), F1/F5 (cross-product evidence and identity tail). The goal is not merely to eliminate unsafe recommendations, but to maintain or improve legitimate checkouts and reduce unexplained INVESTIGATE/HOLD decisions.

**Current implementation status (2026-11-12):** Cycles 1–3 (F5/F3, F4/F2, F3) are implemented with tests (1070 passing) and regression-measured on the seen sets only; see `CHANGE_JOURNAL.md` and `SEEN_RESULTS_C3.md`. Per-cycle predictions are in `PREDICTIONS_CYCLES.md`. IW-21 was scored independently once on the cycle-3 head 94e13ca (134/190, 4 unsafe, 5/209 bypass; now SEEN). IW-22 was scored independently once on c40edb1 (138/221, 8 unsafe, 7/249 bypass; now SEEN): cycle 4's seen safety gain did not generalize. Cycle 5 (b58d673) restates the repairs as five invariants: 0 unsafe and 0 bypass on all 22 seen sets (in-sample). IW-24 (independent, fresh) scored f17a8c5 identically to c40edb1: 187/267, 7 unsafe vs 5 for the frozen engine, legit 96 vs 82. Out of sample, the loop improves completion and slightly worsens safety; the candidate should not replace 4bc7dcc. Next fresh set: IW-26 or later.
