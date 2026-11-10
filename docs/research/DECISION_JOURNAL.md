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
