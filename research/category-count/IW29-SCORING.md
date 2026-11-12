# IW-29 scoring of the category-count preregistration (builder, after the evaluator's single scored run)

Source: /mnt/project-files/agent-commerce-research-v2/iw29-independent-eval/IW29-REPORT.md. IW-29 was sealed at 20:51:57Z, before any Haiku call. Each arm was scored once at a929a44, and IW-29 is now SEEN. The predictions (PREREGISTRATION-IW29.md §5) were scored once, against those results only.

## Results (132 fresh cases, service caps)

| | A0 | C2 | K3 | K3F | K7 |
|---|---|---|---|---|---|
| Fully correct | 82 | **86** | 81 | 83 | 78 |
| Unsafe | 2 | 1 | 1 | 1 | 1 |
| Payment-gate bypasses | 1/131 | 0 | 0 | 0 | 0 |
| Wrong product prepared | 0 | 0 | 0 | 0 | 0 |
| Legit prepared /102 | 43 | 50 | 46 | 48 | 42 |
| Δ vs C2 (McNemar p) | −3.0 (0.39) | — | −3.8 (0.18) | −2.3 (0.45) | −6.1 (**0.008**) |

## Section 4 decision (applied by the evaluator, confirmed here)

1. **Safety.** All three finalists are eligible. The one unsafe case, a02, is an engine-level part-type substitution that appears in every arm, A0 included.
2. **Recommended category count: K3.** K3F is best at 83. K3 is −1.5pp behind it (p = 0.63), which is within the margin, and K3 is smaller. K7 is not competitive.
3. **Category schema vs v1.1.** No finalist improves on C2. **Category count is not a lever, and the category schema adds no value over the existing typed adapter on fresh data.** K7 is significantly worse than C2.

## Predictions

| # | Prediction | Outcome | Verdict |
|---|---|---|---|
| P1 | Finalists within 3pp of each other; no pairwise p < 0.05 | K3F − K7 = 3.8pp (p = 0.06) | **MISS** (spread larger than predicted; the direction favours fewer categories) |
| P2 | No finalist ≥ +5pp over C2; each within −4…+2pp | none beats C2; K7 −6.1pp | **MISS** (K7 below the band) |
| P3 | Each finalist beats A0 by ≥ 4pp | K3 −0.8, K3F +0.8, K7 −3.0 | **MISS** |
| P4 | Unsafe ≤ C2 + 1; any extra from host-for-part | all 1 (= C2), no extra | **HIT** |
| P5 | Quantity/delivery wording → more INVESTIGATE/HOLD than C2 | 1 relevant case ("ship to California"): every arm RECOMMEND | **MISS** (n = 1, low power) |
| P6 | "for N people/pets" correct ≥ C2 | 1 relevant case, every arm INVESTIGATE | HIT (vacuous, n = 1) |
| P7 | Output tokens within 10% across finalists; latency 4–9 s | 1,344–1,405 tokens (4.6%); mean 6.2–6.4 s, p90 8.6–9.1 s | **HIT** |
| P8 | Withheld-conflict cases ≤ 2% of requests; K3F has the most | K3 2.3%, K7 3.8%, K3F 0% | **MISS** |

Tally: 3 hit, one of them vacuous, and 5 miss. The biggest miss is P3. The seen-set gain of the shared interpreter over TS-only (+6pp) did not carry over: on IW-29, A0 is within ±3pp of every interpreter arm, C2 included.

## What the fresh data adds

- **Fewer categories is no worse, and the largest taxonomy is the worst.** The order was K3F ≥ K3 > K7, with K7 vs C2 at p = 0.008. This is the opposite of "more categories preserve more meaning". It is a single set of 132 cases, though: K3 vs K7 has p = 0.38.
- **New dominant K-arm failure: requested bundles and tail products.** Cases i07, i12, i14, i16, i19 and i27 ("Glacio 10 Party Bundle", "Purl 22 Yarn Kit") show it. The category document puts the tail words outside both the model and the product type. The projected item kind then disagrees with the parser, so the adapter adds `ambiguous:item-kind` and the result is a false INVESTIGATE on the correct lock. C2 recommends all six. These are completion losses, not safety failures.
  - The cause is the shared identity fields and the shared projection, which are the same in every arm.
  - K3F's optional sub-type avoided it on 3 of the 6 cases, K7 on 1.
- **Cost.** One call per request costs about 5× C2's list cost: $0.0019 vs $0.00037, because C2 batches its calls. It also adds about 6 s of latency per request.

## Final recommendation

- If a category layer is used at all, use **K3 (IDENTITY / BINDING / NON_BINDING)**. Do not adopt K4–K7, and do not adopt the optional sub-type as a rule.
- **Do not replace the typed adapter v0.2 with the category schema.** The category schema showed no fresh gain, the same safety, a higher cost, and one significant regression (K7).
- The next lever is identity, not taxonomy: bundle and tail-product kind, host-for-part, and Hangul brands with no product noun. It also needs the adapter to stop turning checkable phrases into `unrecognized:` MUSTs, since highly constrained requests were 1–2 of 17 correct in every arm.
- IW-29 is SEEN. The next fresh set is IW-30.
