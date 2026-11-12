# Post-submission research loop — prospective hypothesis register

**Status:** FROZEN AS A GIT COMMIT BEFORE ANY POST-SUBMISSION ENGINE REPAIR. No IW-21 cases have been viewed or scored here.

**Parent build:** `d20aedc7e7637c1d32d22778dfa7991f07065335` (post-submission docs atop submitted implementation `be03b52c7587c8311a51f8d3748395260e9c4e6b`).
**Frozen research engine:** `4bc7dcca29c3fbeb1fea791866e561521d6f8264`.
**Evaluation assets:** IW-1 to IW-20 have been seen. IW-21 must be designed and sealed independently; no IW-21 score exists for this branch.

## Competing causal hypotheses and predictions

### P-F2 — semantic interpretation of 'for X'
- **Observed (IW-20, seen):** an activity such as cycling, or a recipient's weight, can be a compatibility requirement rather than background. A closed occasion/recipient list caused false recommendations.
- **Hypothesis A:** classifying the *semantic role* of X (compatibility constraint vs background occasion) will generalize better than checking articles or enumerating activities.
- **Alternative B:** retaining every 'for X' phrase as MUST will stop false recommendations but increase unjustified INVESTIGATE/HOLD decisions.
- **Before any repair:** preserve the user's phrase losslessly; when uncertain, expose it as unresolved rather than asserting it as verified.
- **Prospective prediction:** on unseen examples of measurable or cross-use compatibility, the repair should reduce incorrect recommendations; on unambiguous occasions, it should avoid converting incidental context into MUST. Record false HOLD separately. Improvement without an increase in false holds is not assumed.

### P-F3 — part requested after host model
- **Observed (IW-19 and IW-20, seen):** preceding part request can be handled, but a postposed part name can be read as part of host identity.
- **Hypothesis A:** separate *requested object kind* from *model string* before identity locking.
- **Alternative B:** adding more accessory words will overfit and misclassify legitimate model names.
- **Prospective prediction:** postposed part requests should not prepare the host, while correctly formed standalone product requests must not be mislabeled as accessories. A safe refusal is preferable to the wrong host purchase, but utility is measured independently.

### P-F4 — one number, one semantic interpretation
- **Observed (IW-19 and IW-20, seen):** "at least 400 liters" may be parsed simultaneously as an exact model attribute and a threshold, rejecting an otherwise eligible 450-liter product.
- **Hypothesis A:** threshold spans are excluded from exact product-identity extraction unless the user explicitly identifies that quantity as a model/variant.
- **Alternative B:** deleting quantity from identity globally will cause wrong-model locking and unsafe substitutions.
- **Prospective prediction:** a 450-liter qualifying offer should not be rejected *solely* because the request's threshold is 400 liters. An explicit exact 400-liter SKU must remain exact. Threshold direction and unit dimension must be preserved.

### P-F1/F5 — evidence attribution and identity tails
- **Observed:** negation handling improved on a targeted fresh IW-20 family, while numeric provenance, mixed-product attribution and variant-tail cases remain potential sources of error.
- **Prospective prediction:** a successful general repair should distinguish affirmative manufacturer evidence from comparisons and denials mentioning another product. Exact model-tail tokens must never disappear.
- **Negative control:** "not seeing a negation" is not affirmative product evidence.

## Precommitted measurement plan

Use identical cases on the old frozen build and the repaired build, hold provider caps constant, and report:
1. State-decision accuracy (numerator/denominator).
2. Unsafe recommendations (count, mechanism family).
3. Payment-gate bypasses (count/attempt denominator).
4. Legitimate checkout preparations (count/positive controls).
5. False INVESTIGATE and false HOLD (counts).
6. Wrong-model/variant locks and wrong total-price comparisons.
7. New regressions, source diffs, and tokens/calls/time if measurable.

Important controls:
- Record both a correctly prepared checkout and one that was prepared despite an earlier requirement/evidence error; never count those as equivalent.
- Run seen IW-19/20 only for diagnosis and regression. Do **not** label them fresh.
- Independent evaluator seals IW-21 *before* observing these hypotheses or the repaired output.
- Score each unseen IW-21 case at most once on the candidate build. Persist SHA256 of cases and predictions and do not rewrite history.
- No provider spend, live merchant action, or payment is authorized by this document.
- The structured-analysis-vs-ordinary-debugging claim remains **undetermined** without equal access, equal time, equal probe budget and a built baseline repair.

## Stop condition / outcome

Only claim generalization from a genuinely sealed, unused holdout and report the sample's targeted construction. In-domain gains do not establish cross-domain transfer or changes in model weights. Any failed prediction is entered into the change journal as a failure of the analysis method, not quietly reframed as a success.
