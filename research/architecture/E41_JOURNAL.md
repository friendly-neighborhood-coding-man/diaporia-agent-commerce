# E4.1 evidence subject binding: Change Journal (public summary)

Append-only. Branch `research/e41-evidence-binding`, from `c9a4353`. Never merge this branch.

The hypothesis and prediction register was frozen at 2026-11-12 18:49Z, before any code. Case-level diagnosis and the register are kept outside this public repository.

## What changed

### `src/verification/SubjectBinding.ts` (new)

The obligation kernel now reads every page through one subject binder. It uses the binder both for credit (K2) and for contradiction (K3).

- **Page subject.** A page title names the most specific listing whose model and variant words it contains. A title that adds a product noun right after the model, such as "<Model> Tablet Holder", is about another product.
- **Claims.** Each sentence becomes one or more claims. Each claim carries a subject, an optional condition and a text.
  - Comparison leads ("Unlike the X, …") are dropped.
  - A condition lead ("With the X fitted, …") makes the claim conditional.
  - A subject noun phrase that names a listing binds to that listing. A pronoun binds to the page subject.
  - "A, not B" becomes a positive claim A and a denial of B.
- **Credit and contradiction.** A claim credits or contradicts product R only when its subject is R and it carries no condition.

### `src/verification/ObligationKernel.ts` (v0.2.0-e41)

- **K2:** credit stands only if the binder confirms it from the counted page.
- **K3:** contradiction is read from claims about R. Context requirements and request segments that nothing interpreted are added as contradiction-only obligations.
- **Gate:** every gateable product is checked, not only the recommendation. A product other than the recommendation is not payable while a MUST is neither verified through the binder nor readable on a page about it. The exception is a MUST the engine already blocks; the existing owner-confirmation rule is unchanged.
- **Ablation switches:** `DIAPORIA_E41_BINDER=off`, `DIAPORIA_E41_OBLIGATIONS=off` and `DIAPORIA_E41_UNCHECKED=off`.

## Disclosed in-sample tuning

Six binder rules were adjusted after reading seen failures. Each was written as a general rule, never as a case string:
1. Capitalised words are never treated as verbs.
2. Continuation after a model is read inside the name part only, and colour words are exempt.
3. The kernel reads every snippet of a counted URL, plus the counted quote.
4. In a sentence subject, attribute words after a model belong to that model.
5. Variant words must be written, while retailer descriptors are ignored. A sentence subject needs no product noun.
6. The UNCHECKED rule never duplicates an engine block that the owner can confirm.

## Seen results (in-sample only, never generalization)

These are service-arm results for C (`c9a4353`) and F (this branch):

| Set | C | F |
|---|---|---|
| IW-21 | 142/190, 0 unsafe | identical |
| IW-22 | 142/221, 0 unsafe | identical |
| IW-24 | 188/267, 0 unsafe, legit 96 | identical |
| IW-27 | 173/279, 3 unsafe, bypass 2/308, legit 76 | 179/279, 0 unsafe, bypass 0/308, legit 79 |
| CX probes | 15/18, 0 unsafe | identical |

The full test suite has 1106 tests, and all of them pass. No existing assertion was relaxed. A fresh sealed IW-28 evaluation decides the question.

## IW-28 result (independent, sealed, scored once; now SEEN)

| Arm | Correct /185 | Unsafe | Bypass /165 | Legit prepared /112 |
|---|---:|---:|---:|---:|
| B f17a8c5 | 134 | 2 | 1 | 54 |
| C c9a4353 | 130 | 0 | 0 | 50 |
| F (this branch) | 128 | 0 | 0 | 48 |

Ablations:
- With the binder off, F equals C on every case.
- With the obligation switch or the UNCHECKED switch off, F is unchanged.

E4.1 had no measurable safety effect on this fresh set. It cost 2 legitimate purchases. In both, a sentence on a bundle's own page was attributed to another product: once through an included part, and once through an "it" that followed a component carrying a sibling's name.

Most of the set's binding cases never reached evidence, because the parser did not recognise the requirement phrase.

Decision: C, not F, remains the kernel candidate. Interpretation is the next lever.
