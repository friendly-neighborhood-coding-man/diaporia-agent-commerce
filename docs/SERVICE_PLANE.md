# Service plane: evidence routing, usage metering, community vs managed, service billing

All behavior in this document is **implemented and mock-tested**. Bounded live Channel3 and Tavily smoke runs are recorded in `docs/TEST_REPORT.md`. KERNEL and PayPal billing have never been called live from this repository.

## Evidence Router (`src/evidence/EvidenceRouter.ts`)

The router is deterministic. No LLM decides whether verification is optional.

**Sufficiency rule** for each must-have capability:

| Result | When |
|---|---|
| `SUFFICIENT_*` | A MANUFACTURER claim exists, **or** at least 2 INDEPENDENT_REVIEW claims from distinct hosts agree |
| `CONTRADICTED` | Strong claims disagree |
| `INSUFFICIENT` | Anything else, including a single independent source or listing claims only |

**Routing order:**
1. **Existing evidence first.** Catalog claims and stored independent evidence (30-day freshness) are checked before any call. If they are sufficient, no provider is called.
2. **Tavily (independent search).** The router makes one normalized query per product and capability; repeated queries reuse a cache. A snippet only counts if it names the exact model token and states the capability.
3. **KERNEL (original-page inspection).** It runs only for pages whose snippet names the exact model but does not state the capability, at most 2 pages, each cached.
4. **Merging.** Only evidence that meets the sufficiency rule is merged into the product. Partial evidence never upgrades a claim. Product identity and exact-model matching are unchanged.
5. **Limits.** When a cost limit blocks a needed call, the step is `BLOCKED_BY_LIMIT`, the capability stays unverified, and the response says "verification was not skipped". A provider failure is recorded as a failure, never as evidence.

Providers are ports (`IndependentSearchProvider`, `PageInspectionProvider`) that can be replaced without touching commerce policy:

| Port | Mock | Real adapter |
|---|---|---|
| Discovery | Fixture catalog stands in for Channel3 | The private DIAPORIA Buy app has the live Channel3 adapter |
| Independent search | Mock Tavily | BYOK `TavilySearch`, request shape from DIAPORIA Buy V7. Not live-tested here |
| Page inspection | Mock KERNEL | BYOK `KernelPageInspector` (below). Fake-HTTP tested; **not live-tested** |

### KERNEL BYOK adapter (`src/evidence/KernelPageInspector.ts`)

One inspection is one remote browser session: `POST /browsers` (headless, no stealth), then `POST /browsers/{id}/playwright/execute` (one bounded snippet that loads the page and returns its visible text), then `DELETE /browsers/{id}`. No SDK dependency.

| Concern | Rule |
|---|---|
| Call limits | Router: at most 2 candidate pages per capability. Ledger: `KERNEL: 1` call per request in live mode. Adapter: hard `maxSessions` per process (`KERNEL_MAX_SESSIONS`, default 20). A blocked call is `BLOCKED_BY_LIMIT` and the capability stays unverified |
| URL policy (free, before metering) | https only, port 443, no credentials, no IP literals, no local or reserved names, and every DNS answer must be a public address. A refused URL is `REFUSED_BY_URL_POLICY`, costs nothing and uses no call budget |
| Browser policy | Main-frame navigation limited to the same host; images, media and fonts blocked; no CAPTCHA solving, no sign-in, no stealth |
| Timeouts | One total deadline (default 45 s) covering create and execute; navigation timeout 15 s; the session is deleted in `finally`, even after a failure or timeout |
| Missing evidence | Statements are extracted locally with the same keyword and negation rules as search snippets. A page yields **zero** statements if it redirects to another host, returns HTTP 400 or above, shows an access challenge, renders empty, does not name the exact model in its title or heading, or never states the capability. Zero statements keep the capability `INSUFFICIENT` |
| Caching | Page results are cached for 30 days per (provider, URL, capability). Transient outcomes (navigation failure, 5xx, 429, 408, challenge, empty render) are not cached |
| Cost provenance | Each call is a ledger record: provider `KERNEL`, unit `browser_second`, measured quantity (session creation to deletion), provenance `BYOK_LIVE` (community) or `MANAGED_LIVE`, and supplier price **unknown** (`NULL`) until a real price is entered. Every router step also carries `provenance` |
| Secrets | The key is held in a private field, sent only to `api.onkernel.com` and never logged; error messages carry only the HTTP status and a templated path |

## Usage Ledger (`src/metering/UsageLedger.ts`)

**Units:**
- Supplier cost: integer **micro-USD**.
- User-facing billable usage: integer **USD cents**.
- Both are stored separately per record, with request id, user id, provider, operation, quantity and unit, pricing version, estimated supplier cost, final supplier cost (only after reconciliation with a real provider statement), provenance (`MOCK` / `BYOK_LIVE` / `MANAGED_LIVE`), billable flag and billable amount.

**Rules:**
- **Billing.** A logical operation (user + logical key) is billed **once**. Duplicates reuse the result, and retries add supplier attempts but no second charge. Failed operations are never billable.
- **Limits.** A per-request estimated supplier cap and a per-user monthly billable cap are checked atomically *before* the provider call.
- **Prices.** The price book is a clearly labelled **placeholder** (`2026-11-placeholder-not-real-prices`). Real provider prices and DIAPORIA service prices still have to be entered.
- **Estimates.** An estimate is never presented as an invoice.

## Community vs managed

| | Community | Managed |
|---|---|---|
| Provider keys | Operator's own (BYOK) or MOCK | Server-owned; never returned to users |
| DIAPORIA billing | None | Users pay DIAPORIA for completed service operations |
| Authorization | Dev tokens on localhost (as before) | **Requires production auth, which is not implemented.** It only runs as `managedSimulation` on loopback |
| Paid operations | Allowed within limits | Denied unless service billing is `ACTIVE`; fail closed if billing is unavailable |

Service billing and purchase authority are separate:
- an `ACTIVE` service subscription never authorizes a merchandise purchase;
- a purchase mandate never activates service billing.

## Service billing (`src/billing/Billing.ts`)

> **Managed Billing V1** replaces this mock for managed mode with PayPal Subscriptions billing: fixed monthly plans, included allowances, hard limits, paid-period grants, and entitlement checked inside the ledger transaction. See [MANAGED_BILLING.md](MANAGED_BILLING.md). The mock below remains available as `MANAGED_BILLING=legacy-mock`.

This is a separate bounded context covering plans, billing authorization, period summaries derived from the ledger, and billing webhooks. It is only a **mock** of a PayPal Subscriptions-backed account:
- state changes come from fixtures or an HMAC-signed mock webhook (duplicates ignored, forged signatures rejected);
- summaries are `DRAFT_NOT_INVOICED`;
- there is no stored value, escrow, or collection on behalf of third parties.

PayPal facts checked on 2026-11-10 (developer.paypal.com, Subscriptions v1):
- **Plans.** `fixed_price` or `pricing_model` `VOLUME`/`TIERED` with tiers; `quantity_supported`; and repricing via `/v1/billing/plans/{id}/update-pricing-schemes`.
- **Usage reporting.** There is **no documented metered-usage reporting endpoint**.
- **Capture.** `/v1/billing/subscriptions/{id}/capture` only accepts `capture_type: OUTSTANDING_BALANCE` and cannot exceed the outstanding balance.
- **Webhooks.** `BILLING.SUBSCRIPTION.CREATED`, `ACTIVATED`, `UPDATED`, `EXPIRED`, `CANCELLED`, `SUSPENDED`, `PAYMENT.FAILED`, and `PAYMENT.SALE.COMPLETED`.
- **Legacy.** Billing Agreements are deprecated.
- **Platform fees** for multiparty flows need PayPal Complete Payments Platform approval.

**Consequence:** usage-based PayPal service billing needs a product decision before integration, for example tiered monthly plans with hard caps.
