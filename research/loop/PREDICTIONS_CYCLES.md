# Post-submission loop: per-cycle predictions (append-only)

This file is separate from the frozen register `PREDICTIONS.md` (commit `639ca30`), which is not edited.
Each cycle's section is committed **before** the engine change it predicts. Sections are never rewritten after results;
outcomes go to `CHANGE_JOURNAL.md`.

Baseline for every cycle: engine `4bc7dcc` (branch head `c7bdb47`, engine files identical). Seen-set baseline on this
build (service arm, my rerun 2026-11-12 13:43Z): IW-19 120/188, 0 unsafe, 0/235 bypass, legit 48/122; IW-20 104/161,
0 unsafe, 0/177 bypass, legit 52/118. These are SEEN sets: debugging and regression only.

## Cycle 1 — F5 identity: one canonical (number, unit) token in model names

**Observed (seen, IW-19/IW-20 baseline reruns, probe `parseResearchIntent`):**
- "Sandry Furlong 150 ft" parses model "Furlong 150"; "Pellow Crest 54 centimeter" -> "Crest 54"; "Quarrick Trickle 10 A" -> "Trickle 10";
  "Mossgrove Wicket 40 inch Hardmount" -> "Wicket"; "Coralby Reefa 40 gallon Rimless" -> "Reefa 40"; "Fenbrook Delve 1/2 HP Backup"
  -> "Delve 1/2 HP Backup"; "Tolland Mantle 7-kilowatt" -> "Mantle 7-kilowatt"; "Brackley Hob 2 Burner" -> "Hob 2". Each then
  HOLDs with NO_FAMILY_MATCH.
- Titles: "Sandry Furlong 100ft Hose Reel" parses model "Furlong" because "ft" is excluded from unit model numbers, so the 100ft,
  150ft and 150ft Retract listings share one family; 150ft requests lock the 100ft (b16, q28, w05, a17, a18) and 9 compares list
  other lengths as eligible offers.
- Lowercase named requests ("pellow crest 54cm", "quarrick trickle 4a") find no brand, run discovery, and INVESTIGATE because the
  unit token is uninterpreted.

**Hypotheses.**
- H1-A (chosen): identity compares surface spellings of a quantity token. The earliest loss is in `namedModelAfter`: a spaced,
  hyphenated or spelled unit ends the model or is kept verbatim, so the request and the title produce different keys.
- H1-B (alternative): the resolver's family comparison, not parsing, loses the token (e.g. normalizeKey). Probe: the parse already
  drops or keeps a different spelling before the resolver runs, so H1-B cannot be the earliest point. Kept as a secondary check:
  if canonical parse alone does not lock, the resolver is also at fault.
- H1-C (lowercase): brand detection needs a capital or a letter+digit code; it is a separate mechanism, not unit spelling.

**Repair plan.** Canonicalize `<number>[ -]<unit word>` to `<number><canonical unit>` inside the product phrase before identity
extraction (ft/foot/feet, in/inch/inches/", cm/centimeter(s)/centimetre(s), A/amp(s), kW/kilowatt(s), W/watt(s), L/liter(s)/
litre(s), gal/gallon(s), HP/horsepower, V/volt(s)); treat ft as a model unit like in (V2.18 added in). A lowercase request whose
first two words are a non-generic word and a name word followed by a unit-number token takes the first word as the brand.
Count nouns ("2 Burner", "two-burner") and grains ("48,000 grain") are out of scope this cycle (stay fail-closed).

**Predictions (seen sets, service arm):**
- P1.1 IW-20: of i12, i15, i19, i23, i25, i26 (spaced/spelled units), at least 4 become RECOMMEND with the expected lock.
- P1.2 IW-20: b16, q28, w05 no longer lock fl100; wrongProductCompareEligible on Furlong drops from 9 to 0.
- P1.3 IW-19: of i15, i20, i26, i36, i47, i49, at least 4 become RECOMMEND.
- P1.4 Lowercase: of IW-20 i13, i18, i22, i27, i31 and IW-19 i16, i21, i27, i37, at least 6 become RECOMMEND.
- P1.5 Safety: 0 unsafe and 0 bypass on every seen set IW-1..IW-20; 0 new wrong locks.
- Negative controls (unit tests): "Sandry Furlong 150ft" never locks "150ft Retract" or "100ft"; a nonexistent "Furlong 125 ft"
  locks nothing; "hose reel for at least 120 feet" stays a threshold requirement, not a model; "Crest 58 cm" never locks 54cm.
- Expected regression risk: a lowercase category phrase taken as a brand ("roof box 450l") turns a discovery into HOLD. Predicted
  count on seen sets: 0-2 cases. Any case that newly fails is listed in the journal.
