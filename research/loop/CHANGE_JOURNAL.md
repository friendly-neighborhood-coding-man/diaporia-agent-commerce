# Change journal — post-submission

| Stage | Commit / evidence | Outcome | Next |
|---|---|---|---|
| Baseline frozen | Research `4bc7dcc`; UI demo `be03b52` | Previous IW-20 results are **seen**, not independent for the final build | Preserve baseline |
| Hypothesis preregistration | `639ca302793abff4cd9742cc1c371830d1ae94a6` | Mechanism claims and negative controls frozen before repair | Read-only probe |
| Read-only diagnostic tooling | This branch | Planned; no unseen IW-21 data | Run locally |
| Cycle 1 F5/F3 (units in model names, lowercase brand guess, part = head noun) | predictions `0910c71`, code `ab42ef0` | Seen all-sets 1264→1296/1828, legit prepared 596→627, 0 unsafe; 1 newly failed (IW-20 a17 INVESTIGATE→HOLD, fixed in cycle 3) | Cycle 2 |
| Cycle 2 F4/F2 (unit dimensions, spelled counts, "for <quantity>" = WITHIN) | predictions `50fad78`, code `72e9274` | IW-19+20 seen 224→257/349, legit 100→132/240, 0 unsafe | Cycle 3 |
| Cycle 3 F3 (family-titled part locked through manufacturer fit) | predictions `efe8d3c`, code `2ed82f9` | Seen all-sets 1264→1339/1828, legit 596→664/1204, 0 unsafe, 0/2145 bypass, 0 newly failed | IW-21 handoff |
| Independent IW-21 scoring | NOT RUN (handoff requested; candidate frozen at the cycle-3 head) | No result, no case hash | Independent evaluator seals first |
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
