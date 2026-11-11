# Channel3 provider compliance review (2026-11-11)

Read on 2026-11-11 through a desktop browser (the cloud build container cannot resolve channel3.ai or trychannel3.com).
Sources: https://channel3.ai/docs, https://channel3.ai/docs/guides/locale, https://channel3.ai/docs/pricing,
https://trychannel3.com/terms/publishers (Publisher Terms, effective November 2, 2026). This is a builder's reading,
not legal advice.

## What the documents say

| Topic | Source | Reading |
|---|---|---|
| Markets | locale guide | Countries US, CA, GB, IE, AU, DE, AT, FR, BE, IT, ES, NL, SE, FI, PT, CZ, GR, RO, CH, PL, EU. Currencies USD, CAD, AUD, GBP, EUR, SEK, CZK, RON, CHF, PLN. Languages en, de, fr, it, es, nl, sv, fi, pt, cs, el, ro, pl. **No Korea, KRW or Korean.** Defaults en / US / USD. |
| Price | pricing | 1,000 free credits a month, then $0.007 per credit. `/search` 1 credit; `/products` (detail) free. Matches PROVIDER_CONTRACTS.md. |
| Storage | terms §7 | Do not "cache, store, or redistribute a significant portion" of the catalog or Customer Output, or build a competing catalog. |
| Training | terms §7 | Customer Output and Channel3 IP may not be used to train, fine-tune or improve an ML/LLM model, or to make synthetic training data. |
| Benchmarks | terms §7 | Publishing "benchmark or evaluation results of the Services" needs Channel3's prior written consent. |
| Ownership | terms §8 | We do not own Customer Output; Channel3 may use our queries and outputs to improve its service and may show queries to merchants (naming the publisher). Keep personal data out of queries. |
| Accuracy | terms §9 | Output may be wrong or stale; it must be verified independently before purchase or checkout decisions. |
| Commission | terms §9 | Shown product links may be commission links; showing them to end customers requires a clear commission disclosure near the links. |
| Keys | terms §5 | End customers must never get our Channel3 key or direct API access. |

## Consequences for DIAPORIA

1. **KRW.** Confirms the policy in V2.1_EVAL_PROTOCOL.md §6a: KRW budgets are parsed and kept; Channel3 cannot price
   in KRW, so a KRW session holds or investigates and never claims budget compliance.
2. **Live research outputs stay private.** Results of live runs against Channel3 (LTP-V2-01 or any later live test) are
   evaluation results of the Services: they go to private storage only, never to the public repository, unless Channel3
   gives written consent. Offline evaluations run against the builder-written fake world (scripts/research-eval-v2)
   and do not measure Channel3; their reports must say so and must not be presented as Channel3 benchmarks.
3. **Already public (needs Eric's decision, not changed here).** The public main branch already carries two small live
   smoke files with Channel3 output (docs/evidence/live-smoke-2026-11-09.json, commit 0074707, and
   live-smoke-2026-11-09-16-05-08.json, commit b3de665): product ids, titles and identities from one search each. They
   are functional smoke records, not a benchmark, and far from a significant portion of the catalog, but they are
   provider output in a public repository. Options: keep (judging them outside §7), or remove them in a new commit
   (history keeps them) and ask Channel3. This change set does not touch docs/evidence/.
4. **Retention.** Research sessions store the candidates of one request in the local database for that session. This is
   per-request working data, not a catalog copy. Residual: there is no retention limit or purge job yet.
5. **No training use.** Nothing in DIAPORIA trains models. Provider output must never be added to a training or
   fine-tuning set, including prompt corpora for later model experiments.
6. **Commission disclosure (residual).** Listing URLs from Channel3 can be commission links. Before any live deployment
   that shows them to an end user, the UI and MCP output need the disclosure from §9.
7. **Verification duty.** Matches the design: listing claims never verify a requirement on their own, and prices are
   re-verified at compare and checkout.
