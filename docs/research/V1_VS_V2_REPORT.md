# Research V1 vs V2: offline evaluation report

**Evidence class: OFFLINE_AGENT_AUTHORED_FIXTURE_EVAL.** The world (`scripts/research-eval-v2/world.ts`, fictional
`.example` brands and domains), all 90 cases, the fake Channel3/Tavily endpoints and the V2 code were written by the
same agent. The numbers show that V2 does what its rules say on inputs shaped like those rules; they are **not** a
measure of real-world quality. No live provider call was made in this sprint. Independent review of the cases has not
happened.

## Setup

- **V1** = `c46a0f4` source (run from worktree at `3742d16`, which adds only the contracts doc and the harness; `src/`
  is identical). **V2** = this branch.
- Same harness (`scripts/research-eval-v2/run.ts`), same fake endpoints, same per-request caps, no network.
- V1 has no decision states; its output is mapped to the decision a host would show (rule in the harness header,
  fixed before any V2 run).
- Splits: **dev** 34 (used to build V2), **holdout 1** 34 (frozen, SHA-256 `adec5184…`; **contaminated**, see
  journal J-07), **holdout 2** 22 (frozen after the last dev change, SHA-256 `63ca2394…63b9`, run once per version
  before any further change: the **clean** number).

## Clean result: holdout 2, first run (V2 at 90881d6, V1 at c46a0f4)

| Metric | V1 | V2 |
|---|---|---|
| Decision-state accuracy | 10/22 | **21/22** |
| Recall@10 | 0.225 | **0.931** |
| NDCG@5 | 0.233 | **0.886** |
| Exact lock correct | 2/11 | **10/11** |
| False / wrong-variant locks | 0 / 0 | 0 / 0 |
| Constraint violations (of RECOMMENDs) | 2/4 | **1/14** |
| Unsafe recommendations | 2/22 | **1/22** (q20) |
| Correct HOLD | 4/4 | 4/4 |
| False HOLD | 10/15 | **1/15** (q09) |
| Recommendation top accuracy | 2/4 | 13/14 |
| False "verified cheapest" | 0/1 | 0/1 |
| Provider calls per case | 1.14 | 2.05 |
| Documented USD per case (mean / max) | $0.008 / $0.023 | $0.015 / $0.039 |
| Latency p50 / p95 (in-process, fake providers) | 1.4 / 3.6 ms | 3.4 / 6.9 ms |

The one clean unsafe V2 result: **q20** "Insulated water bottle 2-pack under $80" recommended a single bottle. Fixed in
414e3f0 (a requested pack size is a hard attribute) with a permanent regression test. After that fix holdout 2 has also
been seen, so the post-fix holdout-2 numbers (21/22, 0 unsafe, NDCG 0.919) are **not** clean and are reported only as
regression evidence.

## All splits (V2 at current head 11fabda)

| Split | V1 state | V2 state | V1 unsafe | V2 unsafe | V1 R@10 | V2 R@10 | V1 NDCG@5 | V2 NDCG@5 |
|---|---|---|---|---|---|---|---|---|
| dev (34) | 11/34 | 33/34 | 2/34 | 0/34 | 0.280 | 0.994 | 0.258 | 0.996 |
| holdout 1 (34, contaminated) | 11/34 | 33/34 | 6/34 | 0/34 | 0.229 | 0.993 | 0.206 | 0.987 |
| holdout 2 (22, seen after q20 fix) | 10/22 | 21/22 | 2/22 | 0/22 | 0.225 | 0.931 | 0.233 | 0.919 |
| **all 90** | 32/90 | 87/90 | 10/90 | 0/90 | 0.249 | 0.978 | 0.234 | 0.974 |

All 90, V2: exact lock 45/46, lock precision 37/37, 0 false locks, constraint violations 0/58, correct HOLD 16/17, false
HOLD 1/60, false verified-cheapest 0/4 (V1 1/4), strong-source share of cited evidence 1.0 (56 cited; V1 cited 6).

V1's 10 unsafe recommendations (d30, d31, h11, h13, h22, h23, h30, h34, q06, q10) are wrong-category, accessory,
bundle or over-budget picks that V1's suitability check does not see.

## Remaining V2 misses (current head)

| Case | Result | Cause | Direction |
|---|---|---|---|
| d32, h25 | INVESTIGATE (expected RECOMMEND) | Product has no model ("Contoso Basics Bottle"); the fake Tavily only matches a contiguous family string, so no evidence attaches. | Safe side. Partly a world-matcher artifact. |
| q09 | HOLD (expected RECOMMEND) | Possessive multi-word brand: the parser reads brand "Margie" and model "Travel", and no listing has that model, so exact mode stops at NOT_FOUND. | Safe side (false HOLD). Fixing it now would be tuning on a seen holdout. |
| h15 | correct state, NDCG 0.69 | INVESTIGATE ordering puts a cheaper unverified product first. | Ordering only. |

## Cost and calls (all 90, fake endpoints, documented prices)

| | V1 | V2 |
|---|---|---|
| Channel3 search / detail / lookup | 90 / 0 / 0 | 124 / 2 / 0 |
| Tavily searches | 41 | 75 |
| Calls per case | 1.46 | 2.23 |
| USD per case mean / max | $0.011 / $0.071 | $0.016 / $0.046 |

Prices: Channel3 $0.007/credit, Tavily $0.008/credit (basic depth = 1 credit), both after 1,000 free monthly credits
(`PROVIDER_CONTRACTS.md`). V2 spends about 45% more per case on average but has a lower worst case, because it sends one
combined evidence query per candidate instead of one per capability.

## Replay of recorded live observations

`tests/research-v2-replay.test.ts` runs V2 components on the two real provider responses recorded on 2026-11-09:

- 9 real Channel3 listings for Sony WH-CH720N: "Buy … Black" is NOT_FOUND (the only Black listing is a bundle; the
  other 8 do not state a color). V1 also returned NOT_FOUND, without saying why. "Buy Sony WH-CH720N" locks a standalone
  listing and now tells the user the variant is not stated.
- 8 real Tavily results that V1 labelled all INDEPENDENT_REVIEW: V2 classifies 3 expert, 3 unknown blogs, 1 retailer
  (amazon), 1 forum (reddit). The table row from techgearlab is not a statement. **As recorded, the snippets never name
  the model and V2 leaves ANC UNVERIFIED** (recorded data has no result titles). With a model-naming title assumed, ANC
  is VERIFIED by soundguys + whathifi only.

## Not shown by this evaluation

Real catalog noise, real Tavily snippet quality, real rate limits and latency, Korean real-world coverage (Channel3
has no KRW and no Korean locale), and whether the cases represent real users. The live-test plan
(`LIVE_TEST_PLAN.md`) is the next step and needs owner approval.

## Addendum after the independent review (R-01 … R-09)

**At the service caps (review R-05).** The tables above use the eval's per-request caps (Channel3 6, Tavily 12), which
give the planner room. The deployed service runs 1 / 2. At 1 / 2 (`--service-caps`, same cases, same world):

| All 90 at service caps 1/2 | V1 (c46a0f4) | V2 (review fixes) |
|---|---|---|
| Decision-state accuracy | 32/90 | 81/90 |
| Unsafe recommendations | 10/90 | 0/90 |
| Recall@10 / NDCG@5 | 0.249 / 0.234 | 0.857 / 0.879 |
| Correct HOLD / false HOLD | 15/17 / 43/60 | 17/17 / 5/60 |
| Calls per case / USD per case mean (max) | 1.46 / $0.011 ($0.071) | 1.49 / $0.011 ($0.023) |

Holdout 2 at 1/2: V2 19/22 (recall 0.814), V1 10/22. Misses at 1/2 are d28, d33, h15, h17, h18, h25, q09, q13 and q22.
The 7 not missed at eval caps (d28, d33, h15, h17, h18, q13, q22) all end in HOLD instead of RECOMMEND or INVESTIGATE:
with one catalog call there is no fallback query, no second page and no variant-detail call, and with two Tavily calls
fewer candidates get evidence. They fail safe. (d32 passes at 1/2 and misses at 6/12; not investigated.) Evidence: `v2-review-fixes-service-caps-*.json`, `v1-baseline-c46a0f4-service-caps-*.json`.

**What the review fixes changed in these numbers: nothing.** At eval caps the fixed code scores the same 87/90, 0 unsafe
(`v2-review-fixes-*.json`). That is expected and is itself a limitation: the corpus has only single-product snippets on
correctly named brand domains and no quantity phrases, so it could not detect R-01, R-02 or R-04 (reviewer's analysis).
Those fixes are covered by `tests/research-v2-review.test.ts`, built from the reviewer's reproductions, not by the eval.
The harness now hands the system the world's official brand domains the same way it hands over the expert list
(`WORLD_OFFICIAL_DOMAINS`), so manufacturer classification in the eval is still correct by construction.
