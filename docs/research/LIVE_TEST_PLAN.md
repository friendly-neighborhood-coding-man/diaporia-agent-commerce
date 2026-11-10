# Live-test call plan LTP-V2-01 (PREPARED, NOT AUTHORIZED, NOT RUN)

Purpose: the first real-world check of Research V2 against live Channel3 and Tavily, measuring what the offline eval
cannot (real listing noise, real snippet attribution, real rate limits and latency). **Needs the owner's separate
approval of this plan id.** Nothing here touches PayPal, KERNEL, Cloudflare, Sandbox, checkout or the Scenario I
evidence.

## What runs

`scripts/live-research-v2.ts` (refuses to start without `--confirm-live --plan LTP-V2-01` and both API keys):

```
node --env-file=<owner env with CHANNEL3_API_KEY, TAVILY_API_KEY> --import tsx scripts/live-research-v2.ts --confirm-live --plan LTP-V2-01
```

10 fixed requests (in the script, `LIVE_REQUESTS`): Sony WH-CH720N Black (replay of the 2026-11-09 smoke), Sony
WH-CH720N, ANC + multipoint headphones under $150, AirPods Pro 2 with USB-C case (generation/variant trap), renewed
iPhone 13 128GB (condition), waterproof hiking boots size 10 under $200, cheapest programmable coffee maker with thermal
carafe, 4K USB-C monitor under $400, a Korean KRW request (expected currency blocker), cordless HEPA vacuum under $300.
Research only: no `compare_purchase_offers`, no mandate, no checkout.

## Request count and credit use (hard caps, fail closed)

| | Per request | Whole run | Credits per call | Max credits | Max USD after free tier |
|---|---|---|---|---|---|
| Channel3 HTTP (search; detail is free but counted) | ≤ 3 | ≤ 30 | 1 (search) / 0 (detail) | 30 | $0.21 |
| Tavily HTTP (`basic` depth only) | ≤ 6 | ≤ 60 | 1 | 60 | $0.48 |
| KERNEL | 0 | 0 | – | 0 | $0 |
| **Total** | | **≤ 90 HTTP calls** | | | **≤ $0.69** |

Both providers give 1,000 free credits per month. The committed evidence records 2 Channel3 searches and 1 Tavily
search this month (two smokes and one evidence check on 2026-11-09); any other use of the keys is unknown to me. If
nothing else used them, the expected cost is $0. Retries are bounded (one retry
on 429/5xx/network, Retry-After ≤ 3 s) and every retry counts against the caps above. Per-request caps are enforced by
the `UsageLedger`; run totals by the script's own fetch wrapper, which also rejects any host other than Channel3 and
Tavily.

## Logging

One file, `docs/evidence/live-research-v2-<timestamp>.json`:

- each HTTP call: provider, path, status, credits reported by the provider, provider request id, duration;
- each request: V2 decision (state, ranking, six-part rationale), identity resolution, planner trace (queries, pages,
  stops), candidate titles/identity/listing price, and every evidence item (url, source class, counted or why not,
  quote ≤ 300 chars, published date);
- totals and the stop reason, if any.

No API keys, headers or raw full pages are logged. The repository is public, so the owner reviews the file before it
is committed (third-party snippets are kept short for that reason).

## Stopping conditions

The run stops, and the remaining requests are recorded as NOT_RUN, on the first of:

1. HTTP 401 or 403 (key problem) from either provider;
2. HTTP 402, 432 or 433 (credit, plan or pay-as-you-go limit);
3. a 429 or 5xx that survives the one bounded retry;
4. any run-total cap reached;
5. any request to a host other than the two providers;
6. any unexpected exception.

## What is measured, and pass criteria proposed in advance

| Check | Pass |
|---|---|
| No unsafe recommendation (wrong variant, bundle, accessory, wrong condition, over budget, wrong pack) | 0, judged by the owner from the logged titles |
| No "verified" capability whose counted sources are not manufacturer or ≥ 2 expert groups | 0 |
| L01 does not lock a color-unknown listing or the bundle | yes |
| L09 does not invent a KRW price | yes |
| Share of evidence items whose title names the exact model | reported (this decides whether the replay's assumed titles hold) |
| Calls, credits and latency p50/p95 per request | reported |

A pass here is a real-world smoke result on 10 requests, not a quality benchmark. Suggested next step after it: a
larger, independently written case set before any change to the live per-request caps in `main.ts` (currently Channel3
1, Tavily 2), which stay unchanged unless the owner decides otherwise.
