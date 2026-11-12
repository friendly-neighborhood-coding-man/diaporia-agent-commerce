# Architecture generalization study: Change Journal

Append-only. Written 2026-11-12. Branch `research/architecture-obligation-kernel-v1`, from `f17a8c5`.
Never merge this branch. It is a research arm for the sealed IW-27 evaluation.

## 1. Why the direction changed

Five loop cycles (`c7bdb47` to `f17a8c5`) improved every seen set. Fresh sets did not follow:

| Fresh set | Loop candidate unsafe | Frozen 4bc7dcc unsafe |
|---|---|---|
| IW-21 | 4 | 3 |
| IW-22 | 8 | 7 |
| IW-24 | 7 | 5 |

Cycle 5 changed no fresh decision. That is the signal to stop adding surface rules.

The loop is paused at `eb9f66d` on PR #17. Cycle 6 is WIP and unvalidated. No Cycle 7 was started.

## 2. Diagnosis (summary)

We re-read all 19 fresh unsafe outcomes of the loop candidate. Each one passes through one of three permissive defaults in the verification path:

- **D1. Unread means unchecked.** A request span that the parser drops or files as context imposes no obligation. A lost fit relation also counts here.
- **D2. Any matching clause credits.** Sibling or accessory pages, conditional "With the X, …" clauses and negated spec lines can each verify a must-have.
- **D3. The best remaining neighbour is locked.** When the named product is filtered out, a sibling, host or bundle can take its place.

Caveat from the convergence review: "19 of 19" is close to tautological, because the categories were drawn after reading the cases. Only 4 of the 19 are loop-introduced. The other 15 also occur on frozen 4bc7dcc.

## 3. Hypotheses

| Id | Hypothesis | Status |
|---|---|---|
| H-A | Parser coverage is the limit | **Rejected as sole cause.** The IW-23 Haiku hybrid moved fresh accuracy +1.7pp with no safety change. |
| H-B | Representation loss: requirements cross the interface as untyped strings | **Retained.** It explains why parser gains do not reach the gate. |
| H-C | Evidence attribution: pages verify the wrong subject | **Retained** (D2). |
| H-D | Identity resolution is nearest-neighbour | **Retained** (D3). |
| H-E | Rule interactions cause regressions | **Partly supported.** IW-24 a18 and a30 came from one lost requirement. |
| H-F | Permissive defaults, not missing rules, drive the unsafe tail | **Leading.** It selected the experiment. |
| H-G | Fresh sets are built adversarially toward the last fix | **Not testable here.** Noted as a confound. |
| H-H | The "for X" boundary is not decidable from surface form | **Open.** The kernel only demotes, so it does not need to decide this. |

## 4. Intervention families compared

1. **More TypeScript repairs.** These fix each seen family. On fresh sets, safety stays flat or gets worse. Rejected as the next step.
2. **Contract-aware Haiku output.** On SEEN IW-23 data it raised legit purchases to 74/140 and exposed a new unsafe case (d25, "온도 조절: 없음" credited as positive).
3. **Typed semantic constraints** (adapter `a5848c6`, PR #19). On SEEN data it raised legit purchases to 82/140 with no new unsafe. Its rules were designed after reading those failures, so the gain is likely overfit.
4. **Selected: E4, a typed obligation kernel.**
   - It runs after `decide()` and can only demote, never promote.
   - It is deterministic and does not depend on which interpreter produced the intent, so it can sit behind families 1 to 3.
   - It targets the three defaults directly, not phrases.

## 5. Kernel checks

The kernel is in `src/verification/ObligationKernel.ts`. Each check logs per recommendation, so it can be ablated.

- **K1a kind:** the recommended kind must match the requested kind, unless the request names the product's head noun.
- **K1b identity words:** every word in the named identity window must be accounted for by the title.
- **K1c filter-then-substitute:** do not lock a variant that has extra title words when the resolver excluded the plain listing.
- **K2 subject and condition binding:** each verifying manufacturer clause must come from a page whose title binds to this product, must not be conditional, and must not be about a compared product.
- **K3 non-contradiction:** no bound manufacturer page may negate a required obligation. This uses the engine's `clauseStatement` and a frozen list of spec-line negative values.
  - At most one metered page lookup, and only for the recommendation, inside the planner's existing evidence budget.
  - When no page is readable, the check passes and is logged as UNCHECKED.
- **K4 stray numbers:** a digit in the request's first sentence must be covered by an obligation or the title.

`DIAPORIA_OBLIGATION_KERNEL=off` disables the kernel for ablation. `DIAPORIA_KERNEL_DEBUG=1` prints the per-check log.

## 6. Unexpected outcomes

- **Counterexample baseline.** CX1, CX3, CX7 and CX8 were predicted to fail on `f17a8c5`, but `f17a8c5` was already fail-closed on most direct routes. The only baseline unsafe was cx09, a Korean spec line credited as positive. Priors were revised in register v2 *before* any kernel code: P1 to 0.45, P7 to 0.35.
- **Seen IW-21 and IW-22.** `f17a8c5` already had 0 unsafe on both, so in-sample prediction S2 was ill-posed and cannot be scored as a success.
- **Demotion alone did not block prepare.** The PurchaseGate is per product and reads blockers and disqualifiers. The kernel therefore marks failing products ineligible and checks every gateable product, not only the recommendation.
- **K3 failing closed on unreadable pages** broke about 165 fixture tests. That showed fail-closed-on-unread would gut legit completion. The design was changed to UNCHECKED and logged.

## 7. In-sample tuning (disclosed)

The first full seen run lost 4 legit purchases on IW-21 and 5 on IW-22. The following general fixes were made after reading seen cases, so **every seen number below is in-sample**:

- **K1c:** now uses resolver exclusion reasons, not ranking filters.
- **K1b:** identity window ends at a boundary word or "."; attribute, unit, host-tail and joined-token words are accounted for.
- **K3 binding:** a page binds only when the model is not continued by other words and no more specific listing claims the page. Exact joined tokens replace substring matching.
- **Comparison-lead sentences** ("Unlike the X, …") no longer bind to the wrong subject.
- **K4:** reads the first sentence only.
- **Lookup budget:** tied to `maxEvidenceSearches`.

## 8. In-sample results (SEEN only, never generalization)

Service arm, same `f17a8c5` build, kernel off versus on:

| Set | Kernel off | Kernel on |
|---|---|---|
| IW-21 | 142/190, 0 unsafe, legit 87 | identical |
| IW-22 | 142/221, 0 unsafe, legit 73 | identical |
| IW-24 | 187/267, 7 unsafe, 4/299 bypass, legit 96 | 188/267, 0 unsafe, 0/299 bypass, legit 96 |
| CX probes | 14/18, 1 unsafe, 1/22 bypass, legit 7 | 15/18, 0 unsafe, 0/22 bypass, legit 7 |

The kernel-off IW-24 run reproduces the independent evaluator's `f17a8c5` numbers. Full suite: 1097 tests pass.

## 9. What decides the question

Only the sealed IW-27 evaluation can say whether this generalizes. It runs on arms A `4bc7dcc`, B `f17a8c5`, C kernel, D typed adapter, E typed adapter plus kernel. Predictions P1 to P14 were frozen before any kernel code was written, and will be scored once.

## 10. IW-27 result (independent, sealed, scored once; now SEEN)

Service arm, 279 cases:

| | A 4bc7dcc | B f17a8c5 | C B+kernel | D typed | E typed+kernel |
|---|---:|---:|---:|---:|---:|
| Correct | 164 | 177 | 173 | 172 | 172 |
| Unsafe | 10 | 5 | 3 | 11 | 3 |
| Must-refuse bypass /308 | 10 | 4 | 2 | 11 | 3 |
| Legit prepared /186 | 66 | 79 | 76 | 78 | 76 |

With the kernel off, C reproduces B and E reproduces D on every case. The pre-registered predictions scored 6 hits and 8 misses:
- **Hits:** P3, P4, P9, P11, P12, P13.
- **Misses:** P1, P2, P5, P6, P7, P8, P10, P14.

**Unexpected outcomes and rejected hypotheses:**
- **The exposure law is refuted for the TS loop on this set.** B is safer than the frozen engine. The law holds for the typed adapter, which exposes evidence-attribution weaknesses that the loop's rules had masked.
- **The kernel's effect does carry across interpreters.** It removed 8 of 11 unsafe outcomes on the typed adapter and 2 of 5 on the loop build. The safety thresholds (≤ 1 unsafe) were too optimistic.
- **Every residual unsafe outcome takes route D2, evidence attribution and negation.** Examples: an accessory-page conditional, "X, not Y" contrast, "not rated for Y". So the kernel's D2 checks are incomplete.
- **Every kernel false refusal is the same defect pointing the other way.** A sibling or accessory sentence was bound to the candidate. Subject binding is therefore the shared failing component.
- **"No readable page passes as UNCHECKED" let one forbidden product stay payable** in the typed+kernel arm. That design change was wrong for non-recommended products.
- **A requirement that crossed the interface as a key gave the kernel no obligation to check.** This is representation loss inside the kernel itself.

**Direction change:** the next step is a single subject-binding function used by both credit and contradiction (E4.1). It needs a fresh holdout and predictions frozen first. It should not be more kernel rules. Case-level scoring is kept outside this public repository.
