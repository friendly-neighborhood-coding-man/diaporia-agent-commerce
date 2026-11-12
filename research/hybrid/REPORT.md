# Haiku 5.5 hybrid parser experiment: seen-set report

Status: **arms frozen; seen-set results only. The verdict waits on the fresh holdout (IW-23), scored by an independent evaluator.**

All runs here are **offline precomputed-parser experiments**:

- A Claude Code subagent on model `claude-haiku-5-5` produced the JSON interpretation of each request once.
- The engine reads that JSON from a fixture through `GatewayConfig.interpreter`.
- No live Anthropic API call is made, and this branch contains no production Haiku integration.

## What was built

| Piece | File |
|---|---|
| Versioned schema `diaporia.semantic-intent.v1` (zod) and merge adapter `hybrid-adapter-v1.0.0` | `src/intent/hybrid/SemanticIntent.ts` |
| Interpreter prompt, frozen (sha256 `a0691a63…9c78`) | `research/hybrid/PROMPT_V1.txt` |
| Engine hook (the only engine change): `researchPurchaseV2` calls `interpretIntent()` | `src/engine/CommerceGateway.ts`, `src/http/server.ts` |
| Arm configs: A `TS_ONLY` (no interpreter), B `ALWAYS`, C `SELECTIVE` | `HybridMode` and `escalationSignals()` |
| Offline fixture loader for the IW harness | `research/hybrid/hybrid-preload.mts` |
| Unit tests (21) | `tests/hybrid-semantic-intent.test.ts` |
| Decision criteria, frozen before any fresh result | `research/hybrid/DECISION-CRITERIA.md` |

Design rules: the TypeScript parse is the default. The interpreter's JSON can add or tighten. It can loosen only when the change is confirmed by the request's own words:

- **A, preservation.** If the schema is invalid, or there is no JSON, the TS intent is returned unchanged. The original request and TS reading are kept in the trace. Every span must occur verbatim (NFKC), or the item is rejected.
- **B, conservation.**
  - A context reading never removes a parser MUST.
  - A mandatory/compatibility reading tightens a parser CONTEXT/NICE item into a MUST.
  - A parser MUST stands in for an interpreter constraint only when it covers all of that constraint's content words.
- **C, numbers.** The number must appear in the span. "up to", or a limit on a component, user or load, is kept as the user's words, and the interpreter's direction is not used. A direction that contradicts the words becomes a blocking `unresolved:` MUST. A threshold is never an exact attribute.
- **D, identity.**
  - An interpreter identity is used only if the TS parser, re-reading a phrase built from verbatim spans, agrees and the result is more specific.
  - A kind or model conflict keeps the TS identity and adds a blocking `ambiguous:item-*` requirement.
  - A reparse that maps the type to words not in the request (a lexicon mapping to a different type) is not used.
- **E, conflicts.** Disagreement becomes an open MUST, so the request goes to HOLD or INVESTIGATE. Confidence is never read.
- **F, boundaries.** Budget, currency, condition, evidence, verification, checkout and payment are never touched. The interpreter cannot verify anything.

## Model identity and usage

- Every assistant message in all 15 subagent transcripts reports `model = claude-haiku-5-5`.
- Tool calls were only Read of the agent's own batch file and Write of its own output file.
- 703 unique requests in 15 batches. All 703 passed the zod schema, and all 1,827 spans were verbatim.

| | Value |
|---|---|
| Output tokens (including thinking) | 447,173, about 636 per request |
| Input tokens (uncached + cache write + cache read) | 1,516,433, about 2,157 per request |
| Wall time | 1,564 s over 15 batches of about 47 requests (88–148 s per batch), about 2.2 s per request batched |
| Estimated cost at list price ($0.10 / $0.50 per MTok, all input billed as uncached) | about $0.00053 per request; $0.37 for the 689 Phase 2 requests in arm B, $0.29 in arm C |
| Actual spend | $0. It ran inside the Claude Code session; no paid API was called. |
| TS parser alone | about 4 ms per request |

Live single-request latency on the production inference route was **not measured**.

## Phase 1: parse level, 50 seen requests (the Phase 0 set)

These use the same gold and the same strict rules as Phase 0. A request counts as correct only if its identity, numbers, every mandatory requirement and exclusions are right, with no false mandatory requirement.

| | A (TS 94e13ca) | B (always) | C (selective) |
|---|---|---|---|
| Correct | **25/50** | **41/50** | **41/50** |
| Escalated | – | 50 | 46 |

By family (A / B):

| Family | A | B |
|---|---|---|
| Identity | 5/7 | 7/7 |
| Accessory | 2/7 | 5/7 |
| For-X | 7/9 | 8/9 |
| Numeric | 4/8 | 8/8 |
| Negation | 2/7 | 4/7 |
| Optional | 3/4 | 3/4 |
| Ambiguous | 2/4 | 2/4 |
| Korean | 0/4 | 4/4 |

New error versus A: 1 (w09). an audience phrase was tightened into a MUST. It is a false block, not a loosening.

Remaining failures:

- A post-posed part: the interpreter reads it as a standalone item, so the TS identity stays.
- The parser's lexicon maps two Korean or English chair types to "office chair". The reparse is rejected, so the request blocks.
- Two interpreter false MUSTs.
- A "no X" fitment phrase is still read as a product exclusion.
- One request has the wrong product type (a sentence word).
- One Korean brand was not given by the interpreter.

## Phase 2: full engine, seen sets IW-16, IW-19, IW-20, IW-21 (689 cases)

Service arm; the expanded arm gives identical numbers. Each set is the sealed `final` harness copy. The only patch is that `createApp` receives the interpreter. Arm A at 94e13ca reproduces the sealed IW-21 evaluation exactly (134/190, unsafe d15, d22, q25, q46).

| Metric (sum of 4 sets) | A TS only | B always | C selective |
|---|---|---|---|
| **Fully correct state** | **502/689 (72.9%)** | **513/689 (74.5%)** | **512/689 (74.3%)** |
| Unsafe recommendations | **4** (IW-21 d15, d22, q25, q46) | **1** (IW-21 d15) | **1** (IW-21 d15) |
| Payment-gate bypasses | 5/815 | 1/815 | 1/815 |
| Legit checkout prepared | 269/480 | 286/480 | 285/480 |
| False HOLD | 60/480 | 69/480 | 70/480 |
| False INVESTIGATE | 125/409 | 107/409 | 107/409 |
| Lock correct | 468/543 | 481/543 | 479/543 |
| Wrong locks | 22 | 17 | 17 |
| Wrong product prepared / compare-lowest / compare-eligible | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |
| Korean | 11/36 | 11/36 | 11/36 |
| Interpreter calls (unique requests) | 0 | 689 | 541 (78.5%) |

By set, fully correct (A → B):

| Set | A | B |
|---|---|---|
| IW-16 | 100 | 101 |
| IW-19 | 131 | 135 |
| IW-20 | 137 | 136 |
| IW-21 | 134 | 141 |

By area, fully correct (A → B):

| Area | A | B |
|---|---|---|
| d, discovery | 75/136 | 81/136 |
| i, identity | 133/172 | 139/172 |
| b, budget | 78/90 | 78/90 |
| q, requirements | 96/122 | 98/122 |
| a, accessories | 89/106 | **84/106** |
| w, ordinary words | 31/63 | 33/63 |

The accessory drop is all false HOLDs, mostly Korean "<host> <part>" requests where the adapter will not release the part noun. None of them is unsafe.

### Safety probes

| Probe | A | B / C |
|---|---|---|
| IW-21 d22, a weather condition read as context | **unsafe** RECOMMEND | correct |
| IW-21 q25, known-false requirement | **unsafe** RECOMMEND | HOLD, correct |
| IW-21 q46, an "X only" requirement dropped | **unsafe** RECOMMEND | INVESTIGATE, correct |
| IW-21 d15, a sibling model's page verifies the claim (evidence attribution) | **unsafe** | **unsafe**, unchanged |
| IW-21 q07, accessory page names the candidate's number | INVESTIGATE | INVESTIGATE |
| IW-20 q29, household size plus water source | INVESTIGATE | INVESTIGATE, MUST kept |
| IW-20 d08, an audience count plus an "up to" load | INVESTIGATE | INVESTIGATE, both MUSTs, "up to" verbatim |
| IW-16 q20, a weight limit on a component | HOLD | HOLD, kept as written |
| IW-19 d27, a volume threshold | HOLD (wrongly an exact volume attribute) | RECOMMEND, correct |
| IW-20 a04 and a18, post-posed parts | INVESTIGATE, INVESTIGATE | INVESTIGATE; RECOMMEND (correct ACCESSORY) |
| IW-21 d37, a Korean feature-plus-type request | HOLD | RECOMMEND, correct, feature kept |

The d15 attribution weakness was deliberately **not** fixed through the interpreter, and no separate evidence intervention was run on this branch. The q07 mechanism is the same weakness. During development it became unsafe in arm B when a component threshold was parsed into a requirement that an accessory page could "verify". The final adapter keeps that requirement whole, and q07 is INVESTIGATE in every arm. On a fresh set, better parsing can still expose this weakness. Any fix belongs in evidence attribution, as a separate and documented intervention.

### Adapter loosenings found on the seen sets and fixed before freezing

Each one now has a regression test.

1. A parser MUST covering part of a constraint (a bare unit word covering a component threshold) released the rest of it.
2. "X only" was labelled an exclusion and turned into a must-not. An exclusion span with no negation word is now kept as a requirement.
3. Identity words were released from "uninterpreted" with no identity locked (a Korean brand and model): a wrong-sibling purchase.
4. A feature carried by the parser's reading of the English type (a feature word before the type noun) was lost.
5. The parser lexicon mapped the interpreter's type to another one; the reparse was used.
6. The fallback key builder stripped "no" from a REQUIRED phrase, inverting a "no X" compatibility phrase.
7. A post-posed part with a non-Latin host was locked as the host.
8. Trace text containing "Budget … conflicts" tripped the harness's informational budget-parse check, which fell from 189/190 to 0/190. The trace is reworded.

These fixes were made on seen data, so they are development changes. The holdout measures whether they generalize.

## Pre-registered criteria applied to the seen sets (development evidence only)

| Criterion | B | C |
|---|---|---|
| Fully correct +10pp | **+1.6pp**, not met | +1.5pp, not met |
| No new unsafe mechanism | met (unsafe 4 → 1; the remaining one is in A) | met |
| Bypasses not up | met (5 → 1) | met |
| Wrong product not up | met (0) | met |
| Gains in more than one family | d, i, q, w up; a down | same |
| Cost under $0.005 per request | met (about $0.0005) | met |

The parse-level gain (25 → 41 of 50) mostly becomes safety, not correct purchases. Four unsafe outcomes become one, and four bypasses go away. False INVESTIGATE falls, but false HOLD rises, and the evidence stage still cannot verify most free-text MUSTs.

**On seen data this points to REJECT on the accuracy criterion and a safety gain on every other criterion.** The verdict is reached only on IW-23.

## Unresolved

- The holdout (IW-23) has not been run.
- Phase 1 has one annotator, who also wrote the gold.
- There was one Haiku run per request, so there is no self-consistency check. Phase 0 showed that 3 of 50 verdicts flip between runs.
- Live latency and cost on the production inference route were not measured.
- Korean accessories over-block.
- d15 evidence attribution is unchanged.
- The seen-set request fixtures are kept outside this public repo, in the project files.
