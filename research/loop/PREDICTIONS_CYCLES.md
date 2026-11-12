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

## Cycle 2 — F4/F2 numeric meaning: one canonical unit dimension, counts, and "for <a quantity>" as a fit limit

**Observed (seen, cycle-1 build, IW-20 world pages):** every one of these stays INVESTIGATE with "no attributable statement found"
although the registered manufacturer states the number:
- unit spelled differently on the page: "at least 8 amps" vs "at 10 A"; "at least 5 kilowatts" vs "delivers 7 kW"; "at least 120
  feet" vs "holds up to 150 ft"; IW-19 "at least 400 liters" vs "450 L", "at least 30 gallons" vs "40 gal".
- count stated as a word with a measurement between: "at least 3 burners" vs "three 10,000 BTU burners".
- a quantity that the product must accommodate ("for my 45 lb son", "for a 57 cm head", "for a family of 5", "for use at 4,000 m",
  "for a 650 sq ft garage") vs a stated limit or range ("carries one child up to 40 lb", "fits heads 52 to 55 cm", "for homes of 3
  to 5 people", "rated for use up to 4,500 m", "heats up to 700 sq ft"). These are kept as MUST since V2.19.2 but never compared.

**Hypotheses.**
- H2-A (chosen): the earliest loss is in `numericStatement`: the unit is matched as a literal string and the count noun must touch
  its number, so the number the page states is never read; and a "for <quantity>" phrase has no numeric proposition at all, so its
  value is never compared with the page's limit.
- H2-B (alternative): evidence retrieval never fetches the page (search terms). Discriminator: the "windscreen" and "jogging" cases
  on the same pages DO verify, and the trace shows the page in the evidence list with value null; H2-B would show no page.
- H2-C (risk): a unit-dimension match will read an unrelated number of the same unit ("weighs 7 kg" for a kg capacity) as the limit.
  Mitigation built into the repair: a "for <quantity>" fit is decided only by a bounded statement (up to N, N to M, maximum N,
  rated for N, not above N), never by a bare number.

**Repair plan.** (1) Canonical unit dimensions in `numericStatement` (ft/foot/feet, in/inch, cm, mm, m/meter, A/amp, kW/kilowatt,
W/watt, V/volt, L/liter, gal/gallon, lb/pound, kg, sq ft/square feet, people/persons); a spelled count word before the noun with
at most one measurement in between counts. (2) A "for <quantity>" requirement becomes a WITHIN proposition: TRUE when a bounded
statement of the same dimension contains the value, FALSE when it excludes it, otherwise unknown. Directions are kept: "up to N" on
the product side is an upper limit of what it accepts; "not above N" is an upper limit; the requested value must be inside.

**Predictions (seen sets, service arm, vs the cycle-1 build):**
- P2.1 IW-20: of d05, d12, d14, d21 (spelled/count thresholds), at least 3 become RECOMMEND.
- P2.2 IW-20: of d09, d19, d28, q05, q18, q29 (for <quantity>), at least 3 become RECOMMEND for the expected product, and the
  products whose stated limit excludes the value (Tote 1-Seat for 45 lb, Crest 54cm for 57 cm, Plinth 32k for 5 people, Hob
  2-Burner for 3,800 m) are never RECOMMEND.
- P2.3 IW-19: of d24, d25, d27, d19, d36 at least 2 become RECOMMEND.
- P2.4 Safety: 0 unsafe and 0 bypass on every seen set; no new wrong-product prepared.
- P2.5 Regression risk: a few cases move from INVESTIGATE to HOLD because a limit now reads FALSE; each is checked against the
  world page (a correct refusal is not a regression). Predicted new false HOLD: 0-2.
- Negative controls (unit tests): "at least 5 kilowatts" vs "delivers 4 kW" is FALSE; "for my 45 lb son" vs "weighs 30 lb" stays
  unknown (bare number, no bound); "up to 90 lb total" keeps its fail-closed EXACT reading; "for use at 3,800 m" vs "not suitable
  above 3,000 m" is never TRUE.

## Cycle 3 — F3 a part titled with the family name, never the host

**Observed (seen, IW-19 a01/a07/a10/a14/a16/a23, IW-20 a05/a08/a11/a14/a21/a17):** a request for a part of a named host HOLDs with
"Only standalone listings of this model were found" when the part is listed under the family name only ("Wenlow Tote Kid Seat
Pad", "Sandry Furlong Leader Hose", "Tolland Mantle Home Thermostat"). The resolver looks for the part under the host's full model
or a prefix of it; a family-titled listing's parsed model ("Tote Kid Seat") is neither. Cycle 1 also showed the converse defect:
a host whose own product noun contains the part word ("Hose Reel" for "leader hose") was taken as the part.

**Hypotheses.**
- H3-A (chosen): the part's identity is the pair (brand + family, part noun as the title's head noun), and fitment to the exact
  host is a separate claim that only the manufacturer can verify. The resolver conflates the two by requiring the host model in
  the part's title.
- H3-B (alternative): the accessory-noun vocabulary is too small ("pad", "thermostat" unknown). Discriminator: "check valve",
  "wall cups", "glass lid" are already parsed as accessory nouns in the request and still HOLD; adding words would not create a
  candidate listing. H3-B predicts gains only for unknown nouns; H3-A predicts gains for known nouns too.

**Repair plan.** When the exact and base-model searches find no part, a single same-brand listing whose title names brand +
family word, has the requested part noun as its head noun and carries no number token other than the host's, is locked with
`fitModel` = the full host (the existing V2.10 path), so a must-have "fits <host>" is added and only a manufacturer fit statement
can verify it. Two or more such listings stay NOT_FOUND (no guessing).

**Predictions (seen sets, service arm, vs the cycle-2 build):**
- P3.1 IW-20: of a05, a08, a11, a14, a21, a17, at least 3 move from HOLD to RECOMMEND or INVESTIGATE (both allowed by the oracle).
- P3.2 IW-19: of a01, a07, a10, a14, a16, a23, at least 3 move from HOLD to RECOMMEND or INVESTIGATE.
- P3.3 Safety: no host is ever locked for a part request; 0 unsafe, 0 bypass on every seen set; a part whose page says it does not
  fit the requested host is never RECOMMEND.
- P3.4 Regression risk: a family-titled part that fits only a sibling (number token differs) is excluded by the number rule; a part
  whose page is silent stays INVESTIGATE (not a regression).
- Negative controls (unit tests): a "wall bracket for the <100ft model>" with only a 150ft bracket listed locks nothing; the host
  reel is never the "lead hose"; two family-titled pads lock nothing.

## Cycle 4: the IW-21 findings (IW-21 is SEEN from here on; registered before the engine change)

IW-21 was scored once, independently, on 94e13ca (134/190, 4 unsafe, 5/209 bypass, legit 80/141). It is now a seen
regression set like IW-1..IW-20. Reproduced locally: 134/190 on 94e13ca, 108/190 on the frozen engine.

### Observations and diagnosis

- **d15 (unsafe, new in 94e13ca).** "pond pump that lifts water at least 12 feet" recommends the Tessel 2000 (9 ft) on the
  Tessel 4000 pages. H4.1-A (established by probe): `stripYear` drops any trailing 20[0-3]x token, while `modelYear`
  only accepts 2005-2035, so "Merewell Tessel 2000 Pond Pump" has the model "Tessel" with no year attribute (both
  builds). H4.1-B (established by reading the code): `mentionsExactModel` accepts "Tessel 4000" as naming the digit-less
  model "Tessel", so a numbered sibling's page counts. Cycle 2 made the feet threshold readable, which exposed the
  latent defect (the frozen build returned INVESTIGATE for an unrelated reason). Rejected H4.1-C: a cycle-3 fit change.
  The page sentences are not fit statements.
- **d22, q25 (unsafe, both builds).** "for heavy snow" is read as context, because PURPOSE_FOR lists the usage-intensity
  word "heavy" (meant for "for heavy use") without checking the noun after it. H4.2-B (rejected): the greenhouse negation
  is misread. The manufacturer sentence is never consulted because the phrase is not a requirement.
- **q46 (unsafe, both builds).** "Emberline Smokebox 20, Wi-Fi only" yields no requirement and no uninterpreted word.
  With a named target, a capitalized leftover ("Wi-Fi") is excluded from the must-have pass and is not purpose context.
  The comma-item rule misses it because of the trailing "only", and the X-only rule only fires when a requirement
  already covers the word. So the word is silently dropped (hard word accounting hole).
- **d33 (false HOLD).** "home safe with at least 50 liters": the threshold words are also parsed as the exact attribute
  capacity = 50 L, so the 60 L safe is a "known violation". The AT_LEAST requirement itself is correct.
- **a04, a07 (wrong identity, INVESTIGATE).** "Merewell Tessel 4000 pre-filter": the part noun is not in the part-noun
  list, so the request is STANDALONE with the tail "pre-filter". The listed "Tessel 4000 Pre-Filter" is an ACCESSORY
  by category, so the host locks. a11, a18 additionally name a sibling host ("28ft Pro", "8x10 Snowload") while the
  part is titled with the base model.
- **w01 (false INVESTIGATE).** "for a backyard party next week:" is a MUST because "backyard" is not an occasion modifier.

### Repairs (smallest general change each)

R4.1 `stripYear` strips only what `modelYear` accepts (2005-2035). R4.2 a digit-less model followed by a bare number or
number-code names a numbered sibling, not this model (unless that number carries a unit). R4.3 an intensity adjective
(light, heavy, long, short) after "for" is context only before a use-noun ("use", "duty", "commute", ...). R4.4 "<word>
only" whose word no requirement accounts for is a blocking uninterpreted phrase. R4.5 threshold phrases ("at least 50
liters", "50 L or more") are masked before exact attributes are parsed. R4.6 a STANDALONE request whose tail is the head
noun of a listed same-family ACCESSORY title is resolved as that part (falls back to the old result if that does not
lock). R4.7 one free modifier word is allowed before a closed list of occasion nouns (party, trip, vacation, holiday,
gift, present, wedding, birthday, anniversary, graduation, weekend, event).

### Predictions

- P4.1 IW-21 unsafe 4 -> 0: d15 never recommends ts2; d22 and q25 never recommend a glasshouse its manufacturer says is
  unsuited to heavy snow; q46 does not RECOMMEND.
- P4.2 IW-21 must-refuse bypass 5/209 -> 0/209.
- P4.3 d33 becomes correct (RECOMMEND). i11 and i13 (AMBIGUOUS on the collapsed "Tessel" name): at least one improves
  (low confidence; the pump and skimmer still share "Tessel 2000").
- P4.4 a04 and a07 lock the part; a11 and a18 are uncertain (they need the sibling-host fit path).
- P4.5 w01 becomes correct; w04 ("for the new koi pond:") stays INVESTIGATE (not targeted).
- P4.6 Seen IW-1..IW-20: 0 unsafe, 0 bypass, legit prepared >= 664, newly failed <= 3. The most likely regression is R4.2
  (a word-only model followed by a count, such as "Aero 2 pack", treated as a sibling) giving false INVESTIGATE.
- Negative controls: "Drift 15 2024" still strips its year; "for heavy use" stays context; "pickup only" is still not a
  requirement; "Coffer 60L with at least 50 liters" still locks the 60L; a request naming the host only ("Merewell Tessel
  4000 pond pump") still locks the host.
