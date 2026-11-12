# Change journal — post-submission

| Stage | Commit / evidence | Outcome | Next |
|---|---|---|---|
| Baseline frozen | Research `4bc7dcc`; UI demo `be03b52` | Previous IW-20 results are **seen**, not independent for the final build | Preserve baseline |
| Hypothesis preregistration | `639ca302793abff4cd9742cc1c371830d1ae94a6` | Mechanism claims and negative controls frozen before repair | Read-only probe |
| Read-only diagnostic tooling | This branch | Planned; no unseen IW-21 data | Run locally |
| Cycle 1 F5/F3 (units in model names, lowercase brand guess, part = head noun) | predictions `0910c71`, code `ab42ef0` | Seen all-sets 1264→1296/1828, legit prepared 596→627, 0 unsafe; 1 newly failed (IW-20 a17 INVESTIGATE→HOLD, fixed in cycle 3) | Cycle 2 |
| Cycle 2 F4/F2 (unit dimensions, spelled counts, "for <quantity>" = WITHIN) | predictions `50fad78`, code `72e9274` | IW-19+20 seen 224→257/349, legit 100→132/240, 0 unsafe | Cycle 3 |
| Cycle 3 F3 (family-titled part locked through manufacturer fit) | predictions `efe8d3c`, code `2ed82f9` | Seen all-sets 1264→1339/1828, legit 596→664/1204, 0 unsafe, 0/2145 bypass, 0 newly failed | IW-21 handoff |
| Independent IW-21 scoring | Evaluator thread, sealed bundle cfe206fb…19aa2, scored once on 94e13ca | 134/190 (frozen 108), 4 unsafe (frozen 3), bypass 5/209 (frozen 6), legit 80/141 (frozen 55). IW-21 is now SEEN | Cycle 4 |
| Cycle 4 (IW-21 findings) | predictions `5e2138a`, code `a199885` | IW-21 (seen, in-sample) 134→142, unsafe 4→0, bypass 5→0/209; IW-1..IW-20 1339→1342, 0 newly failed | Fresh IW-22 needed |
| Independent IW-22 | sealed 3b2c3f2b…7116, scored once on c40edb1 / 94e13ca / 4bc7dcc | 138 / 136 / 127 of 221; unsafe 8 / 7 / 7; bypass 7 / 6 / 6 of 249; legit 68 / 64 / 58 of 160. **Cycle 4's seen safety gain did not generalize.** IW-22 now SEEN | Cycle 5 |
| Cycle 5 (five invariants) | predictions `20bbceb`, code `b58d673` | All 22 seen sets: unsafe 0, bypass 0/2603, legit 777→832 vs cycle 4; 4 newly failed (fail-closed) | Fresh IW-23 needed |
| Ordinary-debugging control | NOT RUN | Method superiority unknown | Match source access, time, probes |

All future entries must record failures of the diagnostic **method** as well as failures of the repaired code. Do not revise old predictions after seeing results.

## Cycles 1–3 (2026-11-12, seen sets only)

Predictions for each cycle were committed before its engine change in `PREDICTIONS_CYCLES.md` (append-only); `PREDICTIONS.md` is byte-identical to `639ca30` (`verify-predictions.mjs` PASS). Full table: `SEEN_RESULTS_C3.md`.

### Aggregate, all 20 seen sets, service arm (4bc7dcc → cycle-3 head)

| Metric | Before | After |
|---|---|---|
| Correct decisions | 1264/1828 | 1339/1828 |
| Unsafe recommendations | 0 | 0 |
| Payment-gate bypass / attempts | 0/2145 | 0/2145 |
| Legit prepared / positive gates | 596/1204 | 664/1204 |
| Proxy fully-correct prepared | 582 | 654 |
| False INVESTIGATE | 345 | 307 |
| False HOLD | 219 | 182 |
| Wrong lock (oracle) | 31 | 36 (see below) |
| Wrong product prepared / wrong lowest offer | 0 / 0 | 0 / 0 |
| Newly correct / newly failed | — | 75 / 0 |
| Cost | $0 (MOCK worlds, no provider calls); harness 33 s → 38 s | |

IW-20 alone: 104→137/161, legit 52→86/118 (cycle 1: 67, cycle 2: 77, cycle 3: 86). IW-19: 120→131/188, legit 48→59/122.

**Wrong-lock rise, decomposed.** Five IW-20 wrong locks (b16, q28, a17, a18, w05 on the 100ft sibling) are gone. Nine new ones are all `fit-excludes-model` negatives (IW-15 a02, IW-16 a05/a18, IW-17 a14, IW-18 a02/a07/a09/a17, IW-19 a24): the engine now locks the requested part itself and then refuses it because the manufacturer says it does not fit, or (IW-16 a18) because no fit statement could be attributed. The decision is correct in all nine, nothing is prepared, but the oracle counts any lock in a nothing-fits case as wrong. One real misidentification persists: IW-20 a18 "Sandry Furlong 150ft wall bracket" locks the 150ft host instead of the bracket (it was the 100ft host before), INVESTIGATE, nothing prepared.

### Prediction outcomes

- Cycle 1: P1.1 HIT, P1.2 HIT, **P1.3 MISS** (1 of 6 predicted IW-19 identity-tail cases fixed; i20 "Rimless" tail, i36, i47, i49 still fail), P1.4 HIT, P1.5 HIT on the final run only.
- Cycle 2: P2.1–P2.4 HIT (P2.2 5/6, q29 still INVESTIGATE). P2.5 regression form **unpredicted**: "for 20 lb propane tanks" was captured as a WITHIN limit and two IW-20 cases regressed to INVESTIGATE; fixed by a literal-restatement fallback.
- Cycle 3: P3.1 HIT (6/6), P3.2 HIT, P3.3 HIT (IW-19 a24 HOLDs on the manufacturer's non-fit). The wrong-lock-count effect above was not predicted.

### Method failures (recorded as required)

1. Cycle 1's first pass exposed a latent unsafe case (IW-20 a17: "leader hose for … 150ft Retract" locked the host Hose Reel). It had been masked by the uninterpreted "150ft" token. Fixed by requiring the part noun to be the head noun after the model.
2. Cycle 1 caused an unpredicted TV/monitor size-attribute regression (IW-2 b11/b14/e04, IW-4 q06); fixed by parsing attributes from the raw title.
3. Three cycle-3 defects (fit attribution when the parsed model holds the part's whole name, "clips onto/attaches to", the V2.19.2 for-phrase reading the host number as a quantity) were found by inspecting the first seen rerun, i.e. after the predictions and with seen-set feedback. They are general fixes with fictional-product tests, but the seen-set gains from them are in-sample.
4. One all-set run (`c3`) was contaminated by editing the scratch tree mid-run; it was discarded and fully rerun (`c3b`).
5. IW-16 i36 changed failure mode (INVESTIGATE → HOLD); both are wrong.

### Unresolved (seen) failures

IW-20: d02/q03 "included" vs "ships with"; d08 "up to 90 lb total" (EXACT, fail-closed by design); d10/d11/q14 lithium/LiFePO4; d13 "6V batteries"; d22 wall mounting; d23 3/4 inch hose; d25 "really quiet"; d30/d31/i32/w08 Korean; i02/i05 count nouns ("2 Burner", "two-burner"); i30 "48,000 grain"; b16 "between $100 and $150"; b17 "12V car battery"; q29 "family of 4 on well water"; a06 rain cover for a 2-Seat Jogger; a18 post-posed part with host number; w04, w07 phrasing. IW-19: most d-series discovery phrases, i20, i36, i47, i49, Korean, q05. IW-18 q27 accessory-page sentence attribution (pre-existing). Probe: "Delve 1/3HP check valve" still parses as STANDALONE at the intent level; the resolver handles it.

### Limits on the claims

All numbers are on seen sets. They show the repairs do what the tests say and break nothing measured; they are not evidence of generalization. No fresh IW-21 has been run. No ordinary-debugging control was run, so nothing here says the loop beats ordinary debugging. No model weights were trained or changed.

## Independent IW-21 and cycle 4 (2026-11-12)

**IW-21 (independent, fresh, scored once on 94e13ca).** 134/190 vs 108/190 for the frozen engine. Unsafe 4 vs 3, must-refuse bypass 5/209 vs 6/209, legit prepared 80/141 vs 55/141, false INVESTIGATE 40 vs 57, false HOLD 14 vs 23, wrong product prepared 0 vs 2. The evaluator reported **net safety about flat, not better**. The candidate removed the frozen engine's wrong-product compare (d07) but added a new unsafe mechanism (d15, sibling-page evidence). This is the only fresh evidence in this loop: completion improved out of sample, and safety did not improve. Report: `/mnt/project-files/agent-commerce-research-v2/iw21-independent-eval/IW21-REPORT.md`.

**Cycle 4 root causes (established by probe or code reading, both builds unless noted).**
- d15: `stripYear` dropped "2000" from "Tessel 2000". In addition, `mentionsExactModel` let "Tessel 4000" name a digit-less "Tessel". Cycle 2's threshold reading made this reachable.
- d22/q25: PURPOSE_FOR read the intensity word "heavy" in "for heavy snow" as a use.
- q46: a capitalized leftover with a named target was silently dropped by the word accounting.
- d33: threshold words were also parsed as an exact capacity.
- a04/a07: an unknown part noun after the model left the request STANDALONE.
- w01: an occasion with one modifier was not recognized.

**Prediction outcomes.**
- P4.1 HIT (IW-21 unsafe 4→0; d15 now recommends the Tessel 4000, d22 the snow-rated glasshouse, q25 HOLD, q46 INVESTIGATE).
- P4.2 HIT (0/209).
- P4.3 HIT, and stronger than predicted: i11 and i13 both became correct.
- P4.4 HIT for a07; a04 only after an in-cycle fix, because the first part-title check rejected "Pre-Filter" on its inner word "Filter". a11/a18 also lock the part, via the existing base-model fit path, which was not predicted.
- P4.5 HIT (w01 correct, w04 still INVESTIGATE).
- P4.6 HIT: IW-1..IW-20 0 unsafe, 0 bypass, legit 664→670, 0 newly failed. The predicted "Aero 2 pack" regression does not exist; the frozen engine already rejected it.
- Negative-control error: the prediction said "pickup only" is not a requirement; in fact it already was one on 4bc7dcc. Unchanged.

**After cycle 4 (all 21 sets SEEN, frozen → a199885).**
- Correct 1372→1484/2018, unsafe 3→0, bypass 6/2354→0/2354.
- Legit prepared 651→757/1345.
- False INVESTIGATE 402→350, false HOLD 242→184.
- Wrong lock 43→32; wrong product prepared 2→0.
- See `SEEN_RESULTS_C4.md`.
- The IW-21 gains after cycle 4 are in-sample. Only a new sealed IW-22 can say whether cycle 4 generalizes.

**Still failing on IW-21 (seen).**
- Thresholds on temperature, area, weight, length, blade size, snow load and egg count (d01, d04, d08, d10, d19, d23, d28, q08, q38).
- "really quiet" (d05, d30).
- "for painting the house" (d11, q14; kept a must-have since IW-20's "for cycling" unsafe).
- Fitment with numbers (d17, d32, d36, q16, q24).
- Identity spellings: "4000uv", "10 inch", "8 x 10", "48 Egg", "forty-eight egg", "60-liter Fireproof", "60l fireproof".
- Lowercase brand i22.
- Korean (d37, d38, i32, i33, q42, w08).
- Budget-with-named-product INVESTIGATEs (b03, b11, b16, b19).
- "comes complete with" and "turns eggs automatically" (q05, q30).
- Kit-word parts (a17, a28).
- Lead-ins w04, w09, w17, w18; w06, w07.

## Independent IW-22 and cycle 5 (2026-11-12)

**IW-22 (independent, fresh, scored once).**

| Build | Correct (of 221) | Unsafe | Bypass (of 249) | Legit prepared (of 160) |
|---|---|---|---|---|
| c40edb1 (cycle 4) | 138 | 8 | 7 | 68 |
| 94e13ca (cycle 3) | 136 | 7 | 6 | 64 |
| 4bc7dcc (frozen) | 127 | 7 | 6 | 58 |

- The cycle-4 seen gains (all 21 sets: 0 unsafe) **did not carry over**. Out of sample, cycle 4 added one unsafe case and one bypass (d15).
- d15 is the same mechanism as IW-21 d15 (evidence about one product verifying another), reached by a new route: an accessory page's conditional sentence.
- The other seven unsafe cases are shared by all three builds.
- Across both fresh sets, the loop as a whole improved completion (IW-21: +25 legit; IW-22: +10 legit over the frozen engine) and did not improve safety.
- Report: `/mnt/project-files/agent-commerce-research-v2/iw22-independent-eval/IW22-REPORT.md`.

**Method change.** Cycles 1–4 repaired the surface phrases of a family. Cycle 5 states each repair as an invariant that must hold for any wording. It uses the IW-22 cases only to locate where each invariant is broken.

**Invariants, root causes and repairs.**
- **I1, evidence names exactly the candidate.**
  - Root cause: `statementFrom` judged one product alone and never saw what else was listed.
  - Repair: attribution receives the research's listed products. A mention covered by a longer listed name, or a page title that continues the model with words the candidate's title lacks, belongs to that other product, listed or not. On such a page, a clause naming both is about the pair.
- **I2, context covers the whole phrase.**
  - Root cause: `PURPOSE_FOR` was a prefix test ("for winter" matched "for winter camping").
  - Repair: the head noun, modifiers and tail must all be occasion, time, use, event, indoor-place or company words.
- **I3, no silent drop.** 이상/이하 were stop words. A Korean number+unit followed by a direction word is now a threshold.
- **I4, stated product noun.**
  - Root cause: "room" was a blanket not-a-part word, so "annex room for the <host>" locked the host.
  - Repair: an amount word after a noun is the part's name. Any other noun phrase before "for (the) <named product>" that does not become the part blocks.
- **I5, variant minimality.**
  - Root cause: an unknown product noun counted as a name word, but a descriptor did not.
  - Repair: a strict-superset title is never kept for the plain name.

**Prediction outcomes.**
- P5.1 HIT, stronger than predicted: IW-22 unsafe 8→0. d15 needed I1's page-title rule, because the riser block was not among the listed products. That was a prediction-relevant miss in the first implementation, which only used listed products.
- P5.2 HIT (7→0/249).
- P5.3 HIT (legit 68→73).
- P5.4 HIT on safety (0 unsafe, 0 bypass on all 22 sets). Newly failed vs cycle 4 is 4, within the predicted ≤6:
  - iw10 w06 "for weekend baking" and iw15 w08 "for winter surfing": an activity head is now a requirement. This is the same form that was unsafe as context in IW-22 d01/q01, so the seen oracles conflict and the fail-closed reading was kept.
  - iw22 q07 "for a weekend in the desert": a place tail is a requirement.
  - iw22 d23 "10인용 이상": was an unsafe RECOMMEND, now INVESTIGATE, because no Korean page states the person count.
- The first implementation of I2 made 8 cases worse. A time-only phrase was stripped to nothing, and nested "for my <person>", audiences ("a beginner skier") and indoor places were not covered. These were fixed before the final run, using seen-set feedback.
- Negative controls held: "for heavy use", "for camping trips", "for my long commute", "for the weekend" stay context; own, review and punctuated pages still count; "6인용 밥솥" unchanged. The plain-name lock was checked on a fictional pair in the tests.

**After cycle 5 (all 22 sets SEEN, frozen → b58d673).**
- Correct 1499→1628/2239.
- Unsafe 10→0, bypass 12/2603→0/2603.
- Legit prepared 709→832/1505.
- False INVESTIGATE 472→411, false HOLD 264→200.
- Wrong lock 57→41; wrong product prepared 2→0.
- See `SEEN_RESULTS_C5.md`.
- IW-21 and IW-22 are in-sample now. Whether the invariants generalize needs a sealed IW-23.
