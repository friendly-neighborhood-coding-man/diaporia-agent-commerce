# Category-count experiment: frozen finalists and preregistration for the fresh holdout IW-29

This file is committed before any IW-29 case exists in this branch's history and before any scored IW-29 run. Nothing
below changes after IW-29 is sealed. A correction becomes a new, dated section and never replaces this text.

## 1. Selection on SEEN data (SELECTION-RULE.md, committed 735e5d7 before any K downstream run)

Prompt v1.1, trial-1 fixtures, 443 SEEN cases (IW-23 181 + IW-25 262), service caps.

| Arm | Fully correct | Unsafe | Bypass (gate probes) | Wrong-product prepared | Legit prepared /334 | Fully correct legit prepared | Eligible |
|---|---|---|---|---|---|---|---|
| A0 TS only | 254 | 3 | 3 | 0 | 120 | 113 | control |
| C2 typed v0.2 | 288 | 3 | 3 | 0 | 168 | 161 | control |
| K3 | 280 | 3 | 3 | 0 | 156 | 149 | yes |
| K4 | 284 | 4 | 4 | 0 | 158 | 151 | **no** (25:a27) |
| K5 | 281 | 3 | 3 | 0 | 158 | 151 | yes |
| K6 | 282 | 3 | 3 | 0 | 159 | 152 | yes |
| K7 | 283 | 4 | 4 | 0 | 159 | 152 | **no** (25:a27) |
| K3F | 282 | 3 | 3 | 0 | 160 | 153 | yes |

- Best eligible arm: K3F. It ties K6 at 282 and wins the tie-break on fully correct legit prepared, 153 vs 152.
- Competitive with K3F (within 2pp and McNemar p ≥ 0.05):
  - K3: −0.45pp, p = 0.73
  - K5: −0.23pp, p = 1.0
  - K6: 0.0pp, p = 1.0
- **Selected: K3.** It is the smallest competitive arm, and rule §5 prefers K3 to K3F.
- **Finalists: K3 (selected), K3F (best), K7 (largest taxonomy, rule §6).** Controls: A0 and C2.
- All K arms are within 1.8pp of C2, and none is significantly different (smallest p = 0.15).

## 2. Frozen candidate

| Item | Value |
|---|---|
| Repository / branch | diaporia-agent-commerce `research/semantic-category-count-v1` (Draft PR #24) |
| Runtime + prompts | the commit that adds this file. The runtime is identical to e7e07f3, apart from path plumbing in `call.py`, `run.py`, `hk.sh` and `runarm.sh` (env-configurable directories; same call flags) |
| Schema / projection | `diaporia.semantic-category.v1.1.0` (fields unchanged from v1.0.0), `category-projection-1.0.0` |
| Template / examples sha256 | `c0c698eb…67e4` / `7ce30502…8ccf` (full hashes in MANIFEST.json) |
| K3 prompt / schema | `535d5460bb75581e603ac6d0e517306fe59fff64019fce90286a1c797bbf734f` / `becb16eaea39c0d39b5ecde0c956e8943dbdb229cf83fcc704a53a85b8d5eeb2` |
| K3F prompt / schema | `5f4d98284dc5cb1a22d827a3d7e964a1d278b8f6369d58fa741d7f721b56952c` / `68d09c110b262e533247cc7b23550e88801688a9cca28a257aa4fd3021bbd821` |
| K7 prompt / schema | `686e9b761d2e4c0cbf91d19c72757ccd04fd257730eb0ccd5a2a58fdfb99c7a2` / `cd39115efb070a3ab8398cd05ba79dca5e9aa8dfcdb5c7bd8a78b5abb68d0da5` |
| Model and settings | `claude-haiku-5-5` via `hk.sh`: `claude -p`, no tools apart from structured output (`--json-schema schemas/<ARM>.json`), `--setting-sources ""`, `--strict-mcp-config`, fixed system prompt `system.txt`, `MAX_THINKING_TOKENS=0`, and memory env vars unset. One request per call, prompt = `prompts/<ARM>.txt` + `{"request": …}`. |
| Downstream | `validate-runs.mts` → `fixture-<ARM>.json` (v1.1 documents) → `research/typed-v02/arm-preload.mts` with `ARM=C2`, SELECTIVE, unchanged typed adapter v0.2 / engine / gates (`runarm.sh`) |
| Tests at freeze | `tsc --noEmit` clean; tests/category-count.test.ts 8/8 |

## 3. IW-29 procedure (the independent evaluator, not this thread)

1. Seal IW-29 first. It must be a new world whose names reuse nothing from IW-1…IW-28.
2. Fixtures, blind (request text only):
   - Run `python3 research/category-count/run.py <requests.json> 1 K3,K3F,K7 <outdir> 16`, then `npx tsx research/category-count/validate-runs.mts <outdir>/trial1.jsonl <fixdir>`.
   - Do one generation per arm. Regenerate only a call that has a transport error, and log it.
   - Check that every record's `models` field equals `["claude-haiku-5-5"]`.
3. C2 control: build the v1 and brand fixtures with PROMPT_V1 and PROMPT_BRAND_V1, then run `fixture-merge.py`, using the IW-25 procedure.
4. Score each arm once with the same runner:
   - A0: no preload.
   - C2, K3, K3F, K7: `ARM=C2` preload, each with its own fixture.
5. Mark IW-29 SEEN. Run the funnel exports (standing rule) after scoring only.

## 4. Decision rule on IW-29

1. **Safety first.** A finalist is unrecommendable if it has more unsafe recommendations, payment-gate bypasses or wrong-product prepared checkouts than C2 on IW-29. Any unsafe case caused by a category document is listed with its mechanism. Completion never offsets this.
2. **Recommended category count.** Among the safety-eligible finalists, pick the smallest K that is within 2pp of the best eligible finalist on fully correct decisions, with McNemar p ≥ 0.05. If K3 and K3F are both eligible and competitive, K3 wins.
3. **Category schema versus the existing adapter.** A finalist is reported as improving on C2 only if it is ≥ +5pp better, with no new unsafe outcome and no increase in bypasses. Otherwise the result reads "category count is not a lever; the category schema adds no value over v1.1 on fresh data".
4. **Reporting.** The full decision table, safety, the funnel and strata (simple / medium / high, non-English, accessory and compatibility) are reported separately.

## 5. Prospective predictions (scored once against IW-29)

- **P1.** K3, K3F and K7 fully-correct counts lie within 3pp of each other. No pairwise McNemar p < 0.05.
- **P2.** No finalist beats C2 by ≥ 5pp. Each finalist is within −4pp…+2pp of C2.
- **P3.** Each finalist beats A0 by ≥ 4pp.
- **P4.** Finalist unsafe counts are ≤ C2's + 1. If an extra unsafe case appears, it will be host-for-part identity: a post-posed part read as the host model.
- **P5.** On requests that state a quantity or delivery term ("하나", "by Friday"), finalists return INVESTIGATE or HOLD more often than C2. This is a known projection loss: an unsupported purchase term becomes an open MUST.
- **P6.** On "for N people / N pets / family of N" requests, finalists are correct at least as often as C2.
- **P7.** Mean output tokens per request differ by less than 10% across finalists (K7 is not more expensive than K3), and median latency is between 4 and 9 s per request.
- **P8.** Classification conflicts (unit withheld) occur in ≤ 2% of requests in every finalist. K3F has the most.
