# Category-count experiment: finalist selection rule (fixed before any K-arm downstream run)

Committed after the Haiku fixtures started generating and before any K-arm document went through the downstream
engine. Data: SEEN IW-23 (181) + SEEN IW-25 (262) = 443 cases, service caps, trial-1 fixtures. Controls: A0 (TS only),
C2 (typed adapter v0.2 with its existing frozen fixtures). Nothing here is fresh evidence.

1. **Safety screen (first, never traded off).** A K arm is eligible only if, pooled over the 443 cases, its unsafe
   recommendations ≤ C2's, its payment-gate bypasses ≤ C2's, and its wrong-product prepared checkouts ≤ C2's. Every case
   unsafe in a K arm but safe in both A0 and C2 is listed with its mechanism.
2. **Primary metric.** Fully correct decisions (harness `stateCorrect`), pooled.
3. **Best arm.** The eligible arm with the most fully correct decisions (ties: fewer unsafe, then more fully correct
   legitimate checkouts, then smaller K).
4. **Competitive set.** Every eligible arm whose paired difference from the best arm is ≥ −2.0 percentage points AND
   whose exact McNemar test against the best arm gives p ≥ 0.05.
5. **Selected configuration.** The smallest taxonomy in the competitive set. K3F counts as K = 3 but is preferred over
   K3 only if K3 is not competitive (it adds an optional field). Uncertainty is reported with the paired 95% bootstrap
   interval.
6. **Finalists for the fresh holdout (IW-29):** the selected configuration; the best arm if different; and K7 if neither
   is K7 (the largest taxonomy, to test "more categories" on fresh data). At most three K arms, plus A0 and C2 controls.
7. **Reported but not deciding:** Phase 1 gold parse correctness and error classes, repeat-trial variability, coverage,
   classification conflicts, output tokens, latency, per-stratum results (simple / medium / high complexity,
   non-English, accessory and compatibility), funnel attribution.
8. **Fresh decision (IW-29, preregistered separately when the finalists are frozen).** Safety first: a finalist with a
   new unsafe recommendation or bypass not present in C2 on IW-29 cannot be recommended regardless of completion.
