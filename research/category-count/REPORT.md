# DIAPORIA Buy: optimal semantic category count

> **Fresh result (IW-29, independent evaluator, 132 cases; see IW29-SCORING.md).** Fully correct: A0 82, C2 86, K3 81, K3F 83, K7 78. Unsafe is 1 in every interpreter arm (a02, an engine-level case) and 2 in A0. Bypasses are 0 apart from A0's 1. **Recommended category count: K3. Category count is not a lever. The category schema adds no value over the typed adapter v0.2.** K7 is significantly worse than C2 (p = 0.008). Do not adopt the category schema. The next lever is identity: bundle and tail-product kind, and host-for-part. The seen-set development report follows.

## SEEN development report

**Status.** Every number in this report comes from SEEN data (IW-23, IW-25, and the frozen gold of the earlier parser study). None of it is fresh evidence. The finalists were frozen at a929a44 and preregistered in PREREGISTRATION-IW29.md. The deciding test is the independent IW-29 holdout, which is still pending.

## Answer so far

On seen data, **the number of mandatory categories is not a lever.**

- From K3 to K7, every downstream metric moves less than the run-to-run variation of a single arm.
- Haiku produces the same atomic units in every arm: 2.7 units per request, the same unresolved rate, about 1,100 output tokens and about 5 s per request.
- There is no measurable fragmentation as categories are added. There is also no measurable gain.

Under the preregistered rule, the selected configuration is **K3: IDENTITY / BINDING / NON_BINDING**. A fixed core with an optional fine sub-type (K3F) does no better than K3:
- −0.45pp to +0.9pp across trials.
- 4–5× more classification conflicts in the Phase 1 gold.

None of the category arms beats the existing typed adapter v0.2 (C2). They sit 0.9–2.3pp below it, a difference that is not significant.

## Setup
- **Arms.**
  - K3 through K7 form a nested refinement chain (TAXONOMIES.md).
  - K3F is K3 plus an optional sub-type.
  - Every arm uses the same atomic unit schema, prompt template, examples, Zod validator and projection into `diaporia.semantic-intent.v1.1`.
  - Downstream, every arm runs the unchanged typed adapter v0.2, engine, evidence, gates and payment code.
  - Controls are A0 (TS only) and C2 (typed adapter v0.2 with its frozen fixtures).
- **Model.**
  - `claude-haiku-5-5`, one request per call, with structured output from a per-arm JSON schema.
  - All 9,000+ calls report `claude-haiku-5-5`.
  - 100% of outputs were schema-valid, and no span was non-verbatim.
- **Data.**
  - Phase 2 used 443 seen cases: IW-23 has 181 and IW-25 has 262.
  - Phase 1 used 80 gold-annotated requests (`phase1/gold_v1.py`, sha256 b93ff107…).
  - Both baselines reproduce exactly: IW-23 A0 111 and C2 134; IW-25 A0 143 and C2 154.

## Round 1, prompt v1.0 (recorded, superseded)
- Completion was flat: K3 287, K4 289, K5 288, K6 291, K7 290, K3F 283, against C2 288.
- **Every K arm failed the safety screen**, with 5–7 unsafe cases against 3 for C2.
- One mechanism common to all arms caused this: host-for-part identity.
  - "가람 GR-3 철판", "소래 DS-24 수저통" and "Karino MG-8S grinding plate set" were read as STANDALONE, with the host's model as the item.
  - The v0.2 kind check passes because both readings say standalone (preregistered risk U2), so the host gets recommended.
- The cause was the shared prompt: its only Korean example was a standalone. The category count was not involved.
- Prompt v1.1 added one rule and one example, identically in every arm. This fix was made after reading these seen failures; that is disclosed tuning.

## Round 2, prompt v1.1: downstream (443 cases, service caps)

| Arm | Fully correct | Δ vs C2 (95% CI) | Unsafe | Bypass | Wrong product | Legit prepared /334 | Fully correct prepared | False HOLD | False INV |
|---|---|---|---|---|---|---|---|---|---|
| A0 | 254 | −7.7 [−11.5, −4.1] | 3 | 3 | 0 | 120 | 113 | 65 | 123 |
| C2 | 288 | — | 3 | 3 | 0 | 168 | 161 | 61 | 92 |
| K3 | 280 | −1.8 [−4.1, +0.2] p=.15 | 3 | 3 | 0 | 156 | 149 | 65 | 96 |
| K4 | 284 | −0.9 [−3.2, +1.4] | 4 | 4 | 0 | 158 | 151 | 62 | 95 |
| K5 | 281 | −1.6 [−3.8, +0.7] | 3 | 3 | 0 | 158 | 151 | 63 | 97 |
| K6 | 282 | −1.4 [−3.6, +0.9] | 3 | 3 | 0 | 159 | 152 | 64 | 95 |
| K7 | 283 | −1.1 [−3.2, +0.9] | 4 | 4 | 0 | 159 | 152 | 64 | 94 |
| K3F | 282 | −1.4 [−3.6, +0.9] | 3 | 3 | 0 | 160 | 153 | 63 | 96 |

- **K arms against each other:** every pairwise difference is ≤ 0.9pp, and every McNemar p ≥ 0.22.
- **Safety.** The 3 unsafe cases shared with C2 come from existing engine weaknesses: IW-23 d16 and q13 (accessory-conditional evidence) and IW-25 a18 (blade assembly for a host it does not fit). The 4th unsafe case in K4 and K7 is IW-25 a27, "소래 DS-24 수저통", the residual host-for-part mechanism.
- **Repeat trial** (second independent Haiku generation for the finalists, all 443 cases):
  - K3: 280 → 282, unsafe 3 → 3.
  - K3F: 282 → 278, unsafe 3 → 4 (a27).
  - K7: 283 → 281, unsafe 4 → 3.
  - Run-to-run spread is ±4 cases, larger than the K3–K7 spread. A one-case unsafe difference, such as the one that excluded K4 and K7, sits inside generation noise. Only K3 kept the C2 safety count in both trials.

### By request complexity and family (correct / cases, trial 1)

| Stratum | A0 | C2 | K3 | K4 | K5 | K6 | K7 | K3F |
|---|---|---|---|---|---|---|---|---|
| simple (136) | 83 | **97** | 86 | 88 | 86 | 86 | 87 | 85 |
| medium (180) | 95 | 103 | 106 | 107 | 106 | 108 | 106 | **109** |
| high (127) | 76 | 88 | 88 | 89 | 89 | 88 | **90** | 88 |
| non-English (89) | 30 | **43** | 36 | 41 | 38 | 37 | 38 | 38 |
| accessory / compatibility (86) | **64** | 52 | 54 | 56 | 53 | 54 | 55 | 54 |

- The category arms gain on medium requests and lose on simple and non-English ones.
- More categories do not help highly constrained requests: K3 88, K7 90, within noise.
- Strata are a fixed regex function of the request text, defined before any K downstream run (`analyze_phase2.py`).

### Where meaning is lost (interface boundaries; same in every K arm)

1. **Request → Haiku.**
   - 3–7% of requests leave one or more content words uncovered; most are politeness or filler words not on the filler list.
   - 0.6 unresolved entries per request.
   - Duplicated mandatory units: ≤ 1 per arm.
2. **Haiku → projection.**
   - Units withheld for a category conflict: 4–8 requests per arm out of 493.
   - Classification conflicts do not grow with K: K3 4, K7 4.
3. **Projection → adapter/engine.** This is the largest shared loss. All 12 C2-only wins fall in three groups, and every K arm loses every one of them:
   - Quantity or delivery words ("하나 주문해 주세요", "Need it by Friday") become open MUST conditions, so the request ends at INVESTIGATE or HOLD. C2's v1 schema ignored them. This is a deliberate no-approximation choice, and it costs completion.
   - Bundle names ("starter bundle", "nursery bundle"): the kind reading changes.
   - Hangul brand + model with no product noun ("오르벨 Siftra 2 자동 화장실", "토빈 T-30").
4. **Engine outcomes** (funnel, results/purchase-funnel-summary.md). Every arm has the same shape: INTENT_PARSE_ERROR is the top cause (91–96 failed legit purchases), then DISCOVERY_MISS (36–40).
   - The category arms gain on "for N people / pets / family of N" and on context phrases ("for my apartment", "for the living room").

## Phase 1: interpretation against gold (80 requests × 3 trials, prompt v1.1)

| Arm | Parse-correct per trial (strict) | Tolerant* | Binding recall | Loosened | Context made mandatory | Invented | Conflicts | Out tokens | Median ms |
|---|---|---|---|---|---|---|---|---|---|
| K3 | 44 / 47 / 48 | 58 / 59 / 60 | 131/150 | 6 | 4 | 22 | 2 | 1311 | 6335 |
| K4 | 45 / 44 / 49 | 59 / 58 / 62 | 128/150 | 10 | 2 | 17 | 3 | 1302 | 6135 |
| K5 | 46 / 44 / 45 | 55 / 60 / 58 | 127/150 | 9 | 2 | 19 | 2 | 1239 | 6084 |
| K6 | 48 / 49 / 46 | 59 / 61 / 60 | 127/150 | 11 | 4 | 15 | 2 | 1258 | 6211 |
| K7 | 47 / 44 / 46 | 60 / 58 / 63 | 130/150 | 9 | 3 | 19 | 2 | 1235 | 5968 |
| K3F | 44 / 48 / 47 | 57 / 57 / 60 | 122/150 | 7 | 2 | 17 | 11 | 1292 | 6346 |

\* Tolerant accepts `item_kind = UNKNOWN` for brand + model requests that name no product type. This tolerance was added after seeing outputs, and it applies equally to every arm and to both prompt versions.

- Within-arm trial spread (up to ±5) is larger than the between-arm spread.
- Errors are dominated by item kind and identity, which no category arm addresses.
- K3 has the best binding recall (131/150) and the fewest loosened conditions (6). The differences are small.
- **Cost.** About $0.0018 per request at list price for every arm. Mean output 1,080–1,160 tokens; median latency 5.1–5.4 s; p90 latency 7.6–8.3 s. K does not change cost.

## Recommendation (provisional, pending IW-29)

1. **Use the smallest structure: K3 (IDENTITY / BINDING / NON_BINDING)** over the shared atomic fields.
   - More categories bought nothing measurable: no accuracy, no safety, no cost difference.
   - Every extra label is one more place for the model's label to disagree with its own fields.
2. **Do not add the optional fine sub-type (K3F).** It adds conflicts and does not help.
3. **The category schema is not yet better than the existing typed adapter v0.2** (−1 to −2pp, n.s.). The levers that matter are elsewhere:
   - accessory and host identity,
   - handling of quantity and delivery terms,
   - bundle-name kind, and
   - Hangul brand with no product noun.
   The category count does not address any of them.
4. **Uncertainty.**
   - The pooled 95% CI for K3 − K7 on correctness is −2.0 to +0.7pp.
   - Single-generation noise is about ±1pp.
   - The safety screen cannot reliably separate a one-case difference.
   - All results are in-sample; prompt v1.1 was tuned on these cases.

## Failure cases to watch on IW-29
- Host-for-part identity: a post-posed Korean part noun.
- Quantity or delivery words becoming open MUSTs.
- Bundle-name kind.
- Hangul brand + model with no product noun.
- Accessory-conditional evidence. This is an engine weakness, shared with C2.

## Files
- TAXONOMIES.md, SELECTION-RULE.md, JOURNAL.md, PREREGISTRATION-IW29.md
- results/:
  - case-comparison.csv
  - phase2-analysis.json
  - funnel exports
  - Phase 1 summary
  - cost and fragmentation data
- Raw Haiku outputs, fixtures and analysis for both rounds and the repeat trial: /mnt/project-files/agent-commerce-research-v2/category-count/
