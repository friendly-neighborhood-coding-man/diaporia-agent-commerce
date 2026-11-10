# Research & Decision V2: architecture

Branch `feature/research-decision-v2`, based on `fix/security-wp1-wp5` (c46a0f4). The output is a research decision,
never a payment authorization. No file under `src/payment`, `src/checkout`, `src/policy`, `src/handoff` or `src/billing`
changed. PurchaseMandate, expiry, identity locking at checkout and UNKNOWN handling are unchanged. All pre-existing
tests are unchanged and pass.

```
request ─► Intent V2 ─► Planner V2 ─┬─► Channel3 adapter (search ≤ N pages, free detail) ─► Identity extractor ─► Resolver V2 (exact mode)
                                    ├─► Evidence router V2 (Tavily, source registry, sufficiency rule, cache)
                                    └─► Decision engine (hard eligibility → blockers → versioned utility) ─► RECOMMEND | INVESTIGATE | HOLD
```

## Stage A: discovery and identity

| Module | Role |
|---|---|
| `src/intent/ResearchIntentV2.ts` | Parses en/ko requests: mode (exact needs a buy verb plus a target, or a structured `exactProduct`), brand/model/kind, attributes (color, storage, memory, capacity, size, pack), condition, category, must-have vs nice-to-have per clause, budget with currency (USD, EUR, KRW, JPY…, 만원/원/달러), objective (best or lowest price), primary and fallback queries. Text after `SYSTEM:`/`ASSISTANT:`/`ignore the…` is cut off. |
| `src/research/capabilities.ts` | Lexicon of 15 capabilities plus numeric families (battery_Nh, keeps_cold_Nh), 11 categories (en/ko), clause-level statement detection with governed negation. |
| `src/research/Channel3ResearchAdapter.ts` | Channel3 v1 contract (see `PROVIDER_CONTRACTS.md`): `limit ≤ 30`, filters in major units, `page_token` pagination, free product detail for variant siblings, dedup across pages, bounded retry on 429/5xx only. `variants.selected` is authoritative; a title that disagrees becomes a conflicting axis. |
| `src/identity/ProductIdentityExtractor.ts` | Model, named-model, kind (STANDALONE/BUNDLE/ACCESSORY) and attribute extraction for non-headphone categories. |
| `src/identity/ProductResolverV2.ts` | Exact identity: SKU → family → kind → each stated attribute → condition → stock. Listings group by variant; more than one group is AMBIGUOUS (never a pick). A listing that does not state a requested attribute is excluded with the reason. NOT_FOUND carries a code and, where possible, a sibling variant to check. |

Invariants enforced here: a variant is never substituted, a bundle is never the standalone product, an accessory is never
the product, used/refurbished never mixes with new, no SKU is invented, and an unstated field stays `null`/`unknown`.

## Stage B: evidence

| Module | Role |
|---|---|
| `src/evidence/SourceRegistry.ts` | Classifies a URL as MANUFACTURER (brand slug is the registrable domain label), EXPERT_REVIEW (registry), RETAILER (registry or any domain selling in this session), USER_FORUM, or UNKNOWN. Starter lists are data, overridable per deployment. |
| `src/evidence/EvidenceV2.ts` | `statementFrom` accepts a statement only if the text names the exact model (a family extension such as "Pro" does not count), comes from one explicit clause, is not a table row, and does not clash with the product's attributes. `judgeV2` is the sufficiency rule below. |
| `src/evidence/EvidenceRouter.ts` | `verifyMany`: stored evidence first (reclassified on read), then one combined Tavily query for up to 3 capabilities (`exact_match`, sellers excluded, `basic` depth = 1 credit), metered and cached; actual credits recorded. The V1 `verify` path is unchanged and still used when the router policy is `v1`. |
| `src/evidence/providers.ts` | `TavilySearch.searchV2` with only documented parameters; never `include_answer` or `auto_parameters`. |

**Sufficiency rule (V2).** VERIFIED when the manufacturer's own domain states it, or when at least two independent expert
groups agree. A group is one registrable domain; near-duplicate (syndicated) text with word-trigram Jaccard ≥ 0.6
merges into one group. Disagreement among counted sources gives CONTRADICTED. Retailers (including the session's own
sellers), forums, unknown sites, search snippets and pages older than 4 years are recorded with `whyNotCounted` but never
counted. A retailer claim alone never establishes a fact.

## Stage C: decision

`src/decision/DecisionEngine.ts`, weights in `src/decision/weights.ts` (`rank-v2.0.0/best-suitability`,
`rank-v2.0.0/lowest-price`).

1. **Hard eligibility (disqualifiers):** CATEGORY_MISMATCH, NOT_STANDALONE, BUNDLE_EXCLUDED, ATTRIBUTE_MISMATCH (incl. pack
   size), CONDITION_MISMATCH, OVER_BUDGET, UNAVAILABLE, MUST_HAVE_FALSE, NOT_LOCKED_IDENTITY.
2. **Blockers (eligible but not recommendable):** MUST_HAVE_UNVERIFIED / CONTRADICTED, VERIFICATION_LIMIT_REACHED,
   PRICE_NOT_IN_REQUESTED_CURRENCY, BUDGET_TIGHT (> 90% of budget), AVAILABILITY_UNKNOWN, CONDITION_UNCONFIRMED,
   ATTRIBUTE_UNKNOWN.
3. **Order:** eligible → fewer blockers → more verified nice-to-haves → listing-claim prior (ordering only, never
   evidence) → utility → price.
4. **State:** RECOMMEND only if the top candidate is eligible with zero blockers; INVESTIGATE if eligible with blockers
   (the open items are listed); HOLD otherwise, with reasons.
5. **Rationale (six parts):** whySelected, whyOthersRankedLower, verifiedFacts (with sources), unknownOrDisputed,
   priceEvidence (`LISTING_PRICE_ONLY`; "never a verified total"), verifyBeforePurchase. A disclaimer states it is not a
   payment authorization.

## Planner and cost orchestration

`src/research/ResearchPlannerV2.ts`. Defaults: ≤ 3 catalog calls, ≤ 2 pages per query, ≤ 4 evidence candidates, ≤ 2
searches per candidate, ≤ 6 searches per request. Stopping rules: fallback query only if fewer than 5 candidates pass
free checks; a second page only if useful; evidence only for candidates that can still win; same-family products reuse
evidence for free; a `UsageLimitError` stops the stage and is recorded in `trace.stops` (fail closed: the affected
capabilities become `notChecked`, which blocks RECOMMEND).

Every provider call goes through `UsageLedger` (per-request call caps, managed monthly caps) and the cache key includes
the request text, so a managed cap cannot be bypassed across requests. BYOK (`community`) and managed modes keep
separate ledgers and billing rules; Channel3 product detail is metered with quantity 0 (free). Live caps in `main.ts`
are unchanged (Channel3 1, Tavily 2, KERNEL 1 per request): under them V2 degrades to fewer calls, and records the stop.

## Compatibility switches

- `GatewayConfig.researchEngine`: `"v2"` (default) or `"v1"`.
- `DIAPORIA_RESEARCH_POLICY=v1`: router keeps the frozen V1 sufficiency rule; V2 output then reproduces V1 routing
  (`evidenceRouting`).
- Output keeps every V1 field and adds `decision`, `researchTrace`, candidate `eligibility`/`evidence`/`research`,
  `identity.productId`, `intent.v2`.
