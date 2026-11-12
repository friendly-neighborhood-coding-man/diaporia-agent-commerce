# Purchase funnel summary (SEEN IW-23 + IW-25, service caps, automatic attribution)

Reporting only: derived after scoring; oracles, cases and gates unchanged. Stage = first failing stage (IW-25 evaluator logic). Safety is reported separately in REPORT.md.

| Arm | Positives | DISCOVERY | IDENTITY | REQUIREMENTS | EVIDENCE | ELIGIBILITY | OFFER | PREPARE | Failed legit | in discovery | after discovery | top causes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A0 | 334 | 282 (84%) | 213 (64%) | 113 (34%) | 113 (34%) | 137 (41%) | 173 (52%) | 120 (36%) | 214 | 52 | 162 | INTENT_PARSE_ERROR 102, DISCOVERY_MISS 52, IDENTITY_MISMATCH 44 |
| C2 | 334 | 301 (90%) | 250 (75%) | 161 (48%) | 161 (48%) | 180 (54%) | 221 (66%) | 168 (50%) | 166 | 33 | 133 | INTENT_PARSE_ERROR 92, DISCOVERY_MISS 33, FALSE_HOLD 19 |
| K3 | 334 | 297 (89%) | 247 (74%) | 150 (45%) | 150 (45%) | 171 (51%) | 215 (64%) | 156 (47%) | 178 | 37 | 141 | INTENT_PARSE_ERROR 96, DISCOVERY_MISS 37, FALSE_HOLD 19 |
| K4 | 334 | 295 (88%) | 245 (73%) | 152 (46%) | 152 (46%) | 172 (51%) | 215 (64%) | 158 (47%) | 176 | 39 | 137 | INTENT_PARSE_ERROR 95, DISCOVERY_MISS 39, FALSE_HOLD 17 |
| K5 | 334 | 298 (89%) | 248 (74%) | 152 (46%) | 152 (46%) | 171 (51%) | 216 (65%) | 158 (47%) | 176 | 36 | 140 | INTENT_PARSE_ERROR 93, DISCOVERY_MISS 36, FALSE_HOLD 19 |
| K6 | 334 | 295 (88%) | 247 (74%) | 152 (46%) | 152 (46%) | 171 (51%) | 217 (65%) | 159 (48%) | 175 | 39 | 136 | INTENT_PARSE_ERROR 93, DISCOVERY_MISS 39, FALSE_HOLD 19 |
| K7 | 334 | 294 (88%) | 247 (74%) | 152 (46%) | 152 (46%) | 172 (51%) | 217 (65%) | 159 (48%) | 175 | 40 | 135 | INTENT_PARSE_ERROR 94, DISCOVERY_MISS 40, FALSE_HOLD 18 |
| K3F | 334 | 297 (89%) | 250 (75%) | 153 (46%) | 153 (46%) | 172 (51%) | 218 (65%) | 160 (48%) | 174 | 37 | 137 | INTENT_PARSE_ERROR 91, DISCOVERY_MISS 37, FALSE_HOLD 19 |

Conditional rates: each stage's PASS count over the positives that reached it is in purchase-funnel.csv (NOT_REACHED rows excluded).
