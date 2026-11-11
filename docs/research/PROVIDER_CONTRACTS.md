# Provider contracts as read on 2026-11-10

Read from the official documentation on 2026-11-10 (~21:00Z) through the owner's desktop browser, because the cloud
container's proxy refuses docs.trychannel3.com and docs.tavily.com. **No API was called.** Every field below is a
documented contract, not an observed live response. The 2026-11-09 live smoke (`docs/evidence/live-smoke-*.json`)
kept only normalized observations, not raw responses, so the response shapes here are still unverified against a live call.

Sources: `https://channel3.mintlify.dev/docs/api-reference/v1/search.md` (docs.trychannel3.com redirects there via
channel3.ai/docs), `/v1/product-detail.md`, `/v1/lookup-product.md`, `/docs/variants.md`, `/docs/pricing.md`;
`https://docs.tavily.com/documentation/api-reference/endpoint/search.md`, `/documentation/api-credits.md`.

## Channel3 (`https://api.trychannel3.com`, header `x-api-key`)

| Endpoint | Cost | Notes used by DIAPORIA |
|---|---|---|
| `POST /v1/search` | 1 credit | body: `query`, `limit` (default 20, **max 30**), `filters`, `config`, `page_token`. Response `{ products[], next_page_token }` |
| `GET /v1/products/{id}` | **free** | query `country`, `currency`, `language`, `option_<Name>=<Label>` variant selection |
| `POST /v1/lookup` | 1 credit | body `{ url, max_staleness_hours (default 3), realtime_fetch (default true) }` → `{ product }` |

Pricing: 1,000 free credits per month, then $0.007 per credit.

`filters` (all optional): `conditions` (`new`|`used`; default `["new"]`, **which also matches offers whose condition is
unknown**), `availability` (`InStock`|`OutOfStock`; default `["InStock"]`, **an offer with no availability data counts
as InStock**), `price {min_price, max_price}` (dollars and cents), `brand_ids`, `website_ids`, `category_ids`,
`exclude_*`, `colors`, `attributes`, `dimensions`, `gender`, `age`, `sale`.

`config`: `mode` (`default` = lexical + semantic, `keyword` = lexical only, `agentic` = LLM-planned sub-searches,
higher latency), `country` (US, GB, EU, AU, CA, IE, DE, AT, FR, BE, IT, ES, NL, SE, FI, PT, CZ, GR, RO, CH, PL),
`currency` (USD, CAD, AUD, GBP, EUR, SEK, CZK, RON, CHF, PLN), `language` (en, de, fr, it, es, nl, sv, fi, pt, cs, el,
ro, pl). **No KR / KRW / ko and no JPY**: Korean-won requests cannot be priced by Channel3.

Product: `id`, `title`, `description`, `brands[{id,name}]`, `images[]`, `category {slug,title,path[],has_children}`,
`key_features[]`, `materials[]`, `structured_attributes {handle: [values]}`, `ratings {value,count,source_count}`,
`variants {options[{name, values[{label, exists, available, thumbnail_url, product_id}]}], selected[{name,label}]}`,
`offers[{url, domain, price {price, compare_at_price, currency}, availability, condition (new|used|null),
max_commission_rate, dimensions}]`.

Facts that change identity logic:
- There is **no GTIN/UPC/MPN/SKU field**. DIAPORIA never fills `sku` from Channel3.
- Offer `condition` is `null` when unknown, and `refurbished` is deprecated (coerced to null). Unknown is not "new".
- `variants.options[].values[].available` is always null on search; only product detail hydrates it.
- Product detail **relaxes** an unsatisfiable `option_*` selection to the closest real variant without failing. The
  caller must diff the request against `variants.selected`; a relaxed selection is a different product.
- A value with `product_id` set is a different product (e.g. another colour).

## Tavily (`POST https://api.tavily.com/search`, `Authorization: Bearer <key>`)

Body used: `query`, `search_depth` (`basic`|`fast`|`ultra-fast` = 1 credit, `advanced` = 2), `max_results` (0–20,
default 10), `chunks_per_source` (1–3), `include_domains` (≤300) / `exclude_domains` (≤150), `include_domains_mode`
(`restrict` default | `prefer`), `exact_match` (quoted phrases only), `include_published_date` (beta),
`time_range`/`start_date`/`end_date`, `max_age_hours`, `include_usage`, `include_answer` (never used: an LLM answer is not
evidence), `include_raw_content`, `auto_parameters` (never used: it may silently switch to 2-credit advanced).

Response: `results[{title, url, content, score, raw_content?, published_date?, favicon?, id}]`, `response_time`,
`usage {credits}`, `request_id`. Errors: 400, 401, 422, 429 (with `Retry-After`), 432 (plan limit), 433 (PayGo limit).

Pricing: 1,000 free credits per month; pay-as-you-go $0.008 per credit.
