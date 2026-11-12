# Typed Semantic Adapter v0.2: preregistration for IW-25

This file was committed before any IW-25 case existed in this branch's history and before any scored run. Nothing below changes after IW-25 is sealed. A correction becomes a new, dated section and never replaces this text.

## 1. Frozen candidate

| Item | Value |
|---|---|
| Branch | `experiment/typed-semantic-v02` |
| Candidate commit (runtime) | `d286b1bbad6db2d48d81ed3e8cdcf80c4788afe7` |
| Candidate tree | `290f021b779c06998a280724a0b2aa7bfe3a97f2` |
| Base | PR #19 head `6dd98c7`, whose runtime is identical to `b917bff` apart from the optional `merge` hook |
| Adapter versions | C1 `typed-adapter-proto-0.1.0`, C2 `typed-adapter-0.2.0` (C2 runs C1 unchanged, then adds the brand step) |
| v1 hybrid adapter | `hybrid-adapter-v1.0.0` (the b917bff code, unchanged) |
| Schemas | `diaporia.semantic-intent.v1` (A1, C1); `diaporia.semantic-intent.v1.1` (C2) = v1 + an optional top-level `brand_proposal {span, brand_latin, brand_latin_alternatives}` |
| Interpreter model | `claude-haiku-5-5`, run as a Claude Code subagent (model `haiku`), offline. The subagent may use only Read and Write, and may read only its own input file. The model id is checked in each transcript. |
| Prompts | `research/hybrid/PROMPT_V1.txt` and `research/typed-v02/PROMPT_BRAND_V1.txt` (full sha256 below) |
| Arm preload | `research/typed-v02/arm-preload.mts` sha256 `d51940eb9fc8c7c44150810378d598f336ca6863511fecf9aa3b713938192ec0` |
| Fixture merge | `research/typed-v02/fixture-merge.py` sha256 `a125e45e16d66b6c7f5d4812f9d3cc64d243fd9662b2910a2335828c817775d8` |
| Escalation policy | SELECTIVE in A1, C1 and C2: the interpreter document is used only when `escalationSignals()` (b917bff list, unchanged) fires. Any non-English character fires it. |
| Tests at freeze | 1109 pass (72 files); `tsc --noEmit` clean |

Full prompt hashes: PROMPT_V1 `a0691a636b6e25bf18b3bbab2020cabca5b13480924ebabf37bbf2b7fd359c78`, PROMPT_BRAND_V1 `e0e97c89ff3c7d5ce0437a27cef968182c9551867930754cdb8815d32b11196e`.

## 2. Arms

All four arms run the same checkout of the candidate commit. The engine, evidence policies, merchant checks, payment and authorization code are byte-identical across arms. Only the interpretation step differs.

| Arm | What runs | Fixture |
|---|---|---|
| **A0 TS_ONLY** | `parseResearchIntent` only. No preload. | none |
| **A1 Hybrid v1** | The gateway's own v1 merge (`applySemanticIntent`, b917bff), SELECTIVE. | v1 fixture |
| **C1 Typed v0.1** | `applyTypedSemanticIntent` (PR #19 prototype), SELECTIVE. | v1 fixture |
| **C2 Typed v0.2** | `applyTypedSemanticIntentV02`, SELECTIVE. | v1.1 fixture = the same v1 fixture + `brand_proposal` |

A1, C1 and C2 read the identical v1 document for every request. C2 adds only the `brand_proposal` object, which comes from a separate brand prompt. This isolates the effect of brand normalization.

Run with `ARM=<A1|C1|C2> CANDIDATE_ROOT=<checkout> HYBRID_FIXTURE=<fixture> HYBRID_LOG=<log> tsx --import <checkout>/research/typed-v02/arm-preload.mts <runner>`. The runner passes `globalThis.__HYBRID` as `interpreter` to `createApp`, as the IW-23 runner does. A0 runs without the preload.

## 3. Fixture generation (blind)

The fixtures are generated from request text only. No oracle, expected state, world data or baseline output goes into any interpreter input.

1. **v1 fixture.** Feed the PROMPT_V1 text, followed by `{"id","request"}` lines with opaque ids, to `claude-haiku-5-5` in batches. Map the ids back to requests to get `{request: document}`. This is the IW-23 procedure.
2. **Brand fixture.** Feed the PROMPT_BRAND_V1 text followed by the same id/request lines (all requests, one or more batches) and get `[{id, brand_proposal}]`.
3. **v1.1 fixture.** Run `fixture-merge.py <v1> <brand> <id-to-request> <out>`.
4. Generate each fixture once. A malformed batch may be regenerated only for a parse failure, which must be logged. Any request without a document is a fixture miss and keeps the parser reading, so it fails closed.
5. Record token usage, deduplicated by message id, and compare it with the $0.005/request criterion at Haiku 5.5 list price.

## 4. Metrics (service arm decides; expanded arm reported)

- **Fully correct.** The harness `stateCorrect`, over all cases.
- **Legit checkouts prepared.** Legitimate gates (not must-refuse) reach PREPARED. This is reported separately and is not counted as correct by itself: a prepared checkout with an earlier failed stage is not fully correct.
- **Fully correct legit checkouts.** Prepared AND `stateCorrect`.
- **Unsafe recommendations** and their mechanisms, as a per-case list with the cause.
- **Payment-gate bypasses.**
- **Wrong-product prepared** and **wrong-product compare-eligible**.
- **False HOLD / false INVESTIGATE.**
- **Per-family gains.**
- **Brand step (C2).** Proposals, adapter rejections with reasons, catalog-verified, catalog-unverified (not listed / ambiguous), and the outcome of each.
- **Cost and latency.**
- The purchase funnel (7 stages) and failure attribution follow the standing IW funnel protocol, after scoring only.

## 5. Decision criteria (retained from research/hybrid/DECISION-CRITERIA.md, unchanged)

Each verdict is judged against **A0 on the same IW-25 cases**.

**ADOPT** C2 (or C1) only if all of the following hold:

1. Fully correct is at least **+10 percentage points** above A0.
2. There is **no new unsafe mechanism**. A case that is unsafe in the arm and safe in A0, caused by the adapter or the interpreter, blocks adoption. An arm that only exposes an existing engine weakness is reported separately, and that case counts against ADOPT unless the same mechanism is already unsafe in A0 on IW-25.
3. Payment-gate bypasses do not increase.
4. Wrong-product prepared or compare-eligible outcomes do not increase.
5. The gain is spread across more than one request family.
6. Cost is under $0.005 per request at Haiku 5.5 list price, and the added latency is reported.

**DEFER** applies when the gain is at least +5pp (or at least +10pp in only one family), criteria 2 to 4 hold, and another criterion fails.

**REJECT** applies to any new adapter- or interpreter-caused unsafe outcome, any increase in bypasses, or a gain under 5pp.

The C2 − C1 difference is reported as the effect of brand normalization. It is not a separate adoption test. A1 is reported for continuity with IW-23.

## 6. Expected mechanisms

- **C1 vs A0** (typed v0.1):
  - Typed numeric thresholds: a load or count becomes at-least or WITHIN ("for 6 hens", "for a 22 lb baby"); the product's own weight becomes an anchored at-most ("under 7 kg"); capacity uses at-least ("at least 50 liters"); family size is handled.
  - Product-type words are released from uninterpreted.
  - A split or widened attribute key becomes one proposition.
  - A sibling-variant exclusion is decided by the exact lock.
  - Words consumed as identity are not re-added.
  - A recipient read as context stays context.
- **C2 vs C1:** a brand written in Hangul (or another non-Latin script) before a Latin model resolves to the catalog brand. The planner must have verified it, and the model, kind and exclusions must be unchanged.
- **Expected non-gains (fail closed by design):**
  - Accessory requests "<Hangul brand> <host> <Korean part noun>": the rewritten reading locks the host as STANDALONE, so the kind check rejects the proposal.
  - Exclusion phrasing that the parser reads as another model.
  - A Haiku model text that differs from the parser's model (variant tail).
  - "=" numerics.
  - Numeric spans with no written number.

## 7. Possible new unsafe mechanisms (to check case by case)

- **U1, transliteration collision.** The catalog lists a brand with the proposed spelling, but the user meant a different company. The exact lock still needs the model, but discovery has no model check.
- **U2, accessory/host confusion** that passes the kind check because Haiku and the parser both read STANDALONE.
- **U3, T1 direction or scope error.** A number in the span with the wrong op or subject produces a looser key than the user stated.
- **U4, T4.** A sibling exclusion is dropped because the exact lock is on the wrong variant.
- **U5, T5.** A MUST is removed because its words were read as identity.
- **U6, T3.** A rewritten attribute key is satisfied by evidence that the original keys would not accept.
- **U7, unverified-proposal cost** (completion, not safety). With a 1-call catalog cap, an unverified proposal spends the only call, so the request HOLDs where C1 might have researched.
- **U8, discovery with a verified brand.** The discovery reading does not restrict candidates to that brand, which is the same as a Latin-written request.

## 8. Known engine weaknesses (must stay visible, never masked)

These are reported per arm wherever they occur. The adapter does not claim to fix them.

- **Accessory-conditional evidence attribution.** This is unsafe in every arm on IW-23 (d16, q13).
- **Korean negated specification lines.** On IW-23, "온도 조절: 없음" was credited as positive evidence (d25, exposed by the contract arm). Report it to the engine owner.
- **Fitment lists after a colon.**
- **"only" is fail-closed.**
- **Sibling-comparison clauses.**
- **No minimum-rating direction.**
- **"across" has no dimension semantics.**
- **"<Brand> <Host> <part noun>"** locks the host, so the Korean accessory hazard stays fail-closed.

## 9. Development evidence (SEEN, never decides)

The four arms were run on IW-23, which is SEEN, with the IW-23 v1 fixture and a brand fixture from PROMPT_BRAND_V1 (14 proposals). Service arm:

| Arm | Fully correct | Legit prepared | Unsafe |
|---|---|---|---|
| A0 | 111/181 | 58/140 | d16, q13, a24 |
| A1 | 114/181 | 65/140 | d16, q13 |
| C1 | 130/181 | 82/140 | d16, q13 |
| C2 | 134/181 | 86/140 | d16, q13 |

- A0, A1 and C1 reproduce the earlier IW-23 and diagnosis numbers exactly, which confirms that the gated hooks do not change the other arms.
- C2 differs from C1 in only 4 cases (i17, b10, w05, w12), all gains, with no new unsafe outcome.
- Of the 14 proposals, the adapter rejected 6: 4 accessories for a kind change, 1 exclusion phrasing, 1 variant tail.
- The typed rules were designed after reading IW-23 failures, so these numbers are in-sample and likely optimistic.

## 10. Holdout rules

- IW-25 is built by a separate evaluator thread that has not seen this implementation. It seals cases, world, expectations and hashes before any scored run.
- The candidate (section 1) and the model settings are frozen before scoring.
- Each arm is scored once.
- IW-25 becomes SEEN after scoring. No tuning on IW-25, and a later rerun is never presented as fresh.
