# Research & Decision V2: decision journal

Format as in `docs/DECISION_JOURNAL.md`: attempted → observed → cause → change → verification → uncertainty. Every
eval run, including failed drafts, is preserved under `docs/evidence/research-eval-v2/`. A run's `commit` field is
HEAD at run time; draft runs were taken on an uncommitted working tree on top of that commit.

## J-01 · Contracts before code (b430096)
- **Decision:** record the Channel3 v1 and Tavily search contracts from the providers' own docs before writing adapters
  (`PROVIDER_CONTRACTS.md`). Documented facts drive limits: Channel3 `limit ≤ 30`, price filter in major units, product
  detail free, lookup 1 credit, no KRW/JPY/Korean locale; Tavily basic = 1 credit, advanced = 2, `auto_parameters` can
  silently switch to advanced, so it is never sent.
- **Uncertainty:** docs can drift from the live API; the live plan checks the fields we rely on.

## J-02 · Baseline frozen first (3742d16)
- **Attempted:** a multi-category fictional world and 68 cases (34 dev, 34 holdout 1), V1 run before any V2 code.
- **Observed:** V1 22/68 state accuracy, 8 unsafe (`v1-baseline-c46a0f4-…T21-00-39`).
- **Decision:** V1 output is mapped to host decisions by a fixed rule written in the harness header before V2 existed.

## J-03 · Draft runs on dev and holdout 1 (drafts 1–5)
- draft1: 65/68 (misses d32, h21, h25). **h21 cause:** "Basic Task" chair — "task" was in GENERIC and truncated the
  named model. Removed. → draft2 66/68.
- draft3: recall 0.967 → 0.994 by running the fallback query when fewer than 5 candidates pass free checks (was < 3);
  d09 then mis-ordered (65/68). **Cause:** unverified candidates were ordered by price only. **Change:** listing-claim
  prior (ordering only, never evidence). → draft4/5 66/68.
- **Failed attempt kept:** draft3 shows the recall gain cost one ordering miss before the prior existed.

## J-04 · Legacy compatibility (148 failing tests during integration)
- **Observed:** with V2 as default engine, 148 pre-existing tests failed.
- **Cause:** (1) the mock adapter needed `model` on exact-mode queries; (2) tests assert V1 evidence routing and the V1
  `unknowns` wording; (3) suitability meant "must-haves only" in V1; (4) the catalog cache key was per session, so a
  managed monthly cap test could be bypassed across requests.
- **Change:** legacy evidence mode when the router policy is `v1` (V2 replicates V1 routing exactly), V1-shaped
  `evidenceRouting`/`unknowns`, suitability kept to V1 meaning, cache key includes request text. No existing test edited.
- **Verification:** all pre-existing tests pass unchanged.

## J-05 · Old research-eval cases R07 and R16
- R16 needed SKU support in exact identity; R07 needed a listing whose title states the requested condition to win within
  a variant group. Both added to the resolver with tests.

## J-06 · Live caps left unchanged
- **Decision:** `main.ts` keeps Channel3 1 / Tavily 2 / KERNEL 1 per request. V2's planner wants up to 3 / 6; under the
  current caps it stops early and records `USAGE_LIMIT` in `trace.stops`. Raising live caps is an owner decision and is
  part of the live-test plan, not this branch.

## J-07 · Holdout 1 is contaminated; holdout 2 created (168d1ea, 75fdae0)
- **Observed:** during dogfood iterations the harness printed holdout-1 results, and two changes (J-03: "task" removed
  from GENERIC after the h21 miss; the fallback threshold) were made after seeing holdout-1 misses.
- **Decision:** report holdout 1 as CONTAMINATED. Write holdout 2 (22 new cases, same world, same world rules) after
  the last code change, freeze its SHA-256 (`63ca2394…63b9`, harness refuses a mismatch), commit it before running any
  system on it, then run V1 and V2 exactly once (75fdae0).
- **Clean result:** V2 21/22, 1 unsafe (q20); V1 10/22, 2 unsafe.

## J-08 · q20: a 2-pack answered with a single bottle (414e3f0)
- **Observed (clean holdout 2):** "Insulated water bottle 2-pack under $80" → RECOMMEND of a single bottle.
- **Cause:** a requested `pack` was parsed but never enforced as a hard attribute in discovery.
- **Change:** pack size mismatch is ATTRIBUTE_MISMATCH (a single item counts as pack 1). Permanent regression test.
- **Consequence:** holdout 2 is now seen; post-fix holdout-2 numbers are regression evidence, not a clean measurement.
  The next clean measurement needs a holdout 3 or, better, independently written cases.

## J-09 · Replay of the recorded live observations (11fabda)
- **Attempted:** run V2 on the real 2026-11-09 Channel3 listings and Tavily results already in `docs/evidence/`.
- **Observed:** identity behaves as intended. Evidence: recorded snippets alone never name the model (titles were not
  recorded), so V2 attributes nothing and ANC stays UNVERIFIED; with an assumed model-naming title, ANC is verified by
  soundguys + whathifi and every weak source is excluded with a reason.
- **Change:** an exact lock on a listing that states no color/variant adds "confirm which variant ships" to
  verifyBeforePurchase.
- **Uncertainty:** whether real Tavily titles name the model as often as assumed is exactly what the live plan measures.

## J-10 · Not changed on purpose
- q09 (possessive multi-word brand) and the model-less products d32/h25 stay misses: both fail safe, and fixing q09 now
  would be tuning on a seen holdout.
- No change to PurchaseMandate, payment, checkout, expiry, identity locking at checkout, KERNEL or billing code.
- Accepted deviations of the base branch (`fix/security-wp1-wp5`, draft PR #12) still apply unchanged, because this
  branch does not touch the code involved: **D1** `/authorize` is not fully strict-origin (CONTROL probes post without
  an Origin header); **D2** the WP-5 confirm step is enforced by the page flow, while a direct authorize POST is still
  accepted. Both need review before any payment-capable deployment (PR #12 body).

## J-11 · Live-test hardening after the owner's push review (local, after PR #13 head 4a01434)
- **Owner findings:** the live fetch wrapper matched Channel3 by host suffix (look-alike domains could pass); redirects
  were followed by fetch without accounting; the live-test allowance (3/6) and the service caps (1/2) were not clearly
  separated; credit limits and cost reporting needed to be hard.
- **Change:** `src/metering/LiveCallGuard.ts` (exact hosts, https/default port, `redirect: "manual"` with stop-and-count,
  pre-send call and credit caps, Tavily basic only, stop rules, upper-bound cost) and `SERVICE_LIVE_CAPS` used by `main.ts`
  (values unchanged 1/2/1). The script uses the guard and names its allowance `LTP_V2_01_PER_REQUEST_ALLOWANCE`.
- **Verification:** `tests/live-call-guard.test.ts` (look-alike hosts refused with zero requests sent, 302 not followed
  and counted, caps checked before sending, stop on 401/402/403/432/433 and on a repeated 429, service caps pinned).
- **Not done:** provider docs could not be re-read (docs hosts blocked by this container's network policy); credit
  balances need the owner's dashboards. Live test remains NOT AUTHORIZED.

## J-12 · Independent review of PR #13: ACCEPT WITH CHANGES; fixes (local, after 74fb5f8)
Review: `/mnt/project-files/agent-commerce-research-v2/independent-review/RESEARCH-V2-INDEPENDENT-REVIEW.md` (separate
thread, reproduced every HIGH finding).
- **R-01 attribution:** `statementFrom` now counts a clause only if it names this exact model and no other product, or is
  a product-free clause in a single-product hit. Comparison/"best of" titles never count through the second rule.
  Questions are not statements. `OTHER_BRAND_WORDS` is a starter list; other model codes are detected by shape.
- **R-02 manufacturer:** `SourceRegistry` uses an explicit official-domain registry (`STARTER_OFFICIAL_DOMAINS` +
  `officialDomains`); `brand.<tld>` look-alikes are UNKNOWN.
- **R-03 ranking:** the listing-text prior orders only candidates with unverified must-haves. Among recommendable ones the
  cheapest objective sorts by price, the best objective by nice-to-haves then utility.
- **R-04 budget:** every budget match is considered; a number followed by a unit is a quantity; "up to/max/within" need a
  currency marker. "battery up to N hours" now becomes `battery_Nh`.
- **R-06:** a brandless listing never matches a branded exact request. **R-07:** a text budget in another currency than
  the structured one is recorded as `budgetConflict` and the decision HOLDs with a question. **R-08:** service adapters
  refuse redirects and make one HTTP attempt per metered call (`SERVICE_LIVE_RETRY`). **R-09:** cheapest objective spends
  evidence on the cheapest eligible candidate first; planner header corrected (fallback threshold 5).
- **R-05:** eval reported at service caps 1/2 (81/90, 0 unsafe); live plan has an arm A at 1/2. R-10…R-12 left for later.
- **Verification:** 21 regression tests (`tests/research-v2-review.test.ts`), full suite 492 pass; eval unchanged at eval
  caps (87/90), which shows the corpus cannot see these defects.
- **Still open:** new independently written frozen cases (multi-product snippets, look-alike domains, quantity phrases,
  service caps) before the next clean number; provider docs re-check and credit balances (owner).

## J-13 · V2.1 Phase 1: the research decision was advisory (root cause) → PurchaseGate
- **Root cause.** Three independent gaps lined up. (1) The purchase session state ignored `decision.state`: a HOLD
  decision (for example a 30만원 budget with currency USD) left the session RESEARCHED. (2) `compare_purchase_offers`
  set OFFER_VERIFIED whenever any offer had a verified quote, without looking at research requirements. (3)
  `prepare_checkout` and `prepare_browser_checkout` trusted the session state and comparison. The browser handoff did not
  even require OFFER_VERIFIED. On top of that, a budget in another currency became "no budget", so the verifier applied no
  budget at all.
- **Reproduced.** The probe showed decision HOLD, session RESEARCHED, compare OFFER_VERIFIED and prepare reaching the
  handoff. "Over-ear headphones under $60" (INVESTIGATE, unverified must-have) also reached prepare. On the 90 seen eval
  cases, the new workflow check against 04662bd allows a payment preparation for a non-RECOMMEND decision in 13/79 cases
  (eval caps) and 14/75 (service caps).
- **Change.**
  - `src/engine/PurchaseGate.ts` is stored on the session at research time. Per product it holds hard violations, which
    are never resolvable in the session, and open requirements (an unverified or contradicted must-have, the
    verification limit, an unconfirmed attribute), plus the budget conflict.
  - A decision of HOLD now puts the session in HOLD. Compare stays read-only but cannot reach OFFER_VERIFIED while
    anything is open.
  - Both prepare paths re-check the gate and fail closed on a missing gate, an unknown version or an unassessed product.
  - `resolve_research_hold` (PREPARE scope) appends the user's CONFIRM_BUDGET or DROP_REQUIREMENT with actor, time and the
    user's words. The original item stays, the comparison is cleared, and the confirmed budget is what the verifier
    enforces.
- **Verification.** 15 end-to-end tests (`tests/research-v2.1-purchase-gate.test.ts`), a Phase C handoff refusal test,
  and 0/79 and 0/75 unsafe prepares on the seen corpus.
- **Changed existing tests.** Two tool-list assertions gain `resolve_research_hold`. The Phase C Lumen flow now records
  the user's clarification for its unverified "wireless" must-have before the handoff. This is a behaviour change Eric
  should see: a Scenario-I-style rerun of that request on this branch now holds at compare until the user clarifies.
- **Residual.** The MCP host conveys the user's words, so the server cannot prove a clarification came from the user. It
  is the same trust level as the research request itself, and it never grants spending authority: the mandate and the
  buyer approval are still required. The owner review page does not yet show dropped requirements.

## J-14 · V2.1 Phase 2: attribution generalized beyond the starter lists
- **Root cause.** R-01/R-02 were fixed against named examples. Unlisted brands, word-like models ("Aero"), several
  products in one clause, version suffixes (Gen 2, Mk II, 프로), reported speech, Korean text, user content on brand
  domains, short syndicated quotes, ownership changes and stale registries all still passed or were unhandled.
- **Reproduced.** 45 adversarial regressions (`tests/research-v2.1-attribution.test.ts`); 22 failed before the fix.
- **Change.**
  - Snippet-level detection of unknown capitalized entities, with a feature, service, unit and heading allowlist.
  - A word-like model needs its brand next to it.
  - Version and Hangul suffixes count as different models.
  - Reported speech disqualifies its whole sentence.
  - Korean capability statements, read with tight negation, and Hangul brand names.
  - USER_FORUM is checked before MANUFACTURER and EXPERT_REVIEW for UGC hosts and paths.
  - A declared source kind on catalog claims counts only if the registry confirms it.
  - Short quotes are compared by their whole normalized text.
  - Per-domain validity windows.
  - A registry older than 365 days registers nothing.
- **Verification.** The eval is unchanged at both cap sets, with the same three and nine misses as 04662bd.
- **Residual.** A single unknown brand word that only starts a sentence ("Zorvex has multipoint.") is not detected.
  Unknown all-caps brands are detected, so they fail closed. Korean unknown brands are detected only if they are listed.

## J-15 · V2.1 Phase 3: listing price vs merchant-verified total
- **Finding.** No research text presents a listing price as a total. The gap was the hand-over: compare showed listing and
  quote side by side without provenance, and without saying that other research candidates were never quoted.
- **Change.** The QuotePromotion policy P1–P4 and `priceProvenance` on compare, documented in
  `docs/research/V2.1_PRICE_TERMINOLOGY.md`. It is descriptive only; the verifier and the gate still enforce. No mandate
  or capture code was touched.

## J-16 · V2.1 Phase 4: protocol, frozen runner, workflow metric
- `docs/research/V2.1_EVAL_PROTOCOL.md`, `scripts/research-eval-v2/frozen.ts` (sha256 pins for cases and world, and a
  FIRST_RUN/SEEN ledger), and a `--workflow` metric.
- The independent IW-1.1 set is frozen by the reviewer and runs with the reviewer's own harness and world. My frozen-r1
  runner is therefore a dev tool only, not independent evidence. The builder has not read the IW-1.1 cases.
- Interface note for the reviewer's runner: `/mnt/project-files/agent-commerce-research-v2/v2.1/IW1-INTERFACE-NOTE.md`.
  It points out that only `sources.officialDomains` is read.

## J-17 · V2.1 Phase 5: LTP-V2-01 readiness (not run)
- **Guard.** It stops on unexpected billing (this replaces charge-and-continue), on an uncertain Tavily cost, on an
  undocumented Channel3 locale (before sending) and on an unexpected response shape. It reports per arm.
- **Script.** The run is a testable function. A contract-age preflight refuses after 14 days.
- **Offline dry run.** Fake providers at the real hostnames; every HTTP call accounted; $0.375 upper bound.
- **Not re-verified.** The docs hosts are DNS-blocked from the cloud again, so the contracts were not re-verified. Live
  is still NOT AUTHORIZED.
