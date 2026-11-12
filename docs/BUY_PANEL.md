# DIAPORIA Buy panel (browser shopping UI)

One responsive web UI at `/buy/` that an AI host shows in its own browser surface beside the conversation. It is an
observer and interaction surface over the **same purchase session** the MCP tools use, not a second purchasing engine.
MOCK development only in this slice: no provider calls in the dev world, MOCK PayPal, no money.

## Host placement

| Host | How the panel is shown | Status in this slice |
|---|---|---|
| Claude Desktop / Claude Code Desktop | The assistant opens `panelUrl` in the built-in Browser panel | See "Validation" |
| Codex Desktop | The assistant opens `panelUrl` in the right-side Browser tab | **Unverified** (no Codex Desktop session was driven) |
| CLI hosts | Open `panelUrl` in a separate browser window when the host can; always print it as a clickable link | Link fallback only |
| Other hosts | Clickable `panelUrl` in a normal browser on the same machine | Works (headless Chromium, 360 px) |
| MCP Apps hosts | `start_shopping_panel` / `open_shopping_panel` declare `_meta.ui.resourceUri = ui://diaporia/buy-panel.html`; that small view receives the tool result and asks the host to open `panelUrl` (`ui/open-link`) | Resource + metadata tested over MCP; **unverified** in a real MCP Apps host |

DIAPORIA never assumes a host can open or dock a panel. The MCP tool result always carries `panelUrl` plus `openIn`
hints per host; when the host cannot open it programmatically, the assistant shows the link.

## Flow

1. The assistant calls `start_shopping_panel` (same input as `research_purchase`). Research runs in the background
   through `gateway.researchPurchase`, the research tool's own code path; the tool returns `panelUrl` at once.
2. The panel shows live progress (catalog search, product details, evidence checks, merchant listings and quotes).
3. Results: up to three candidates, eligible ones first, then investigable ones (no disqualifier, open blockers), in the
   decision engine's rank order. A disqualified product is never shown as a card.
4. Detail: identity, requirement and feature status with evidence links, counted/not-counted sources, disqualifiers,
   unresolved conditions (the purchase gate's open items), the search-time merchant and flagged untrusted listing text.
5. Select → compare: the server looks up the identity of the selected candidate in its stored research and calls
   `gateway.compareOffers`. The browser sends only `productId` and a shipping country/region.
6. Verified offers: merchant-verified totals (unknown stays unknown), rejected offers with reasons, readiness.
7. Prepare: `gateway.prepareCheckout` with the server's own verified total as the client maximum, quantity 1. The browser
   sends only `offerId`, which must be an eligible offer of the server's comparison.
8. Handoff: the panel links to the existing owner page (`/authorize/cs_…`, owner key, preview + confirm), then to the
   payment approval (MOCK: owner key stands in for the buyer's PayPal login). The panel cannot do either step.
9. Receipt: shown only when `gateway.getCheckoutStatus` reports `COMPLETED`; the content is `getPurchaseReceipt`.

`open_shopping_panel` opens a panel on an existing purchase session (e.g. after `research_purchase`).
`get_shopping_panel` lets the assistant read what the panel shows.

## Security invariants

- **Capability link.** `panelUrl` = `/buy/#run=br_…&k=dpl_…`. The key is in the fragment (never sent to the server in a
  URL, never in logs or Referer), stored only as SHA-256, bound to one run, one user and at most one purchase session,
  and expires after 2 hours. The page moves it to `sessionStorage` and removes it from the address bar.
- **No widening.** A link can never do more than the MCP principal that minted it: compare needs the research scope
  (required to mint); prepare needs the prepare scope and a deployment where payment preparation is enabled
  (loopback + service isolation). The AI host that minted the link could already do all of it.
- **Server-authoritative.** Identity, prices, totals, the client maximum, checkout state and payment status come from
  server records. Extra fields in a request body (prices, identities, states) are ignored.
- **Approval unchanged.** No route of the panel touches mandates, the owner page, the MOCK buyer step, capture or
  reconcile. A panel key is not an owner key (tests check both owner steps refuse it).
- **Requests.** API calls use `Authorization: Bearer dpl_…` (not CSRF-able); a present `Origin` must be this server's;
  a cross-site `Sec-Fetch-Site` is refused; POST bodies must be `application/json`; 240 requests/min per run.
- **Rendering.** Strict CSP (`script-src 'self'`, no inline script, `frame-ancestors 'none'`); all server text is
  placed with `textContent`; untrusted listing text is labelled and never followed; external links use `noopener`.
- **Opt-in.** The routes and MCP tools exist only with `buyPanel: true` (`DIAPORIA_BUY_PANEL=1`), never in
  `public-readonly-demo` mode. The default MCP tool list is unchanged.
- Documented residuals are unchanged: R-A-1 (owner key alone completes the MOCK/Sandbox payment approval) and H2-R1
  (spoofable isolation self-check). The panel neither widens nor fixes them.

## Interface (UI polish, 2026-11-12)

- Neutral slate palette with one teal accent; light and dark follow the OS (`prefers-color-scheme`); visible focus rings;
  no horizontal scroll at 320, 360, 400 and 768 px. Plain HTML/CSS/JS, no framework, same CSP.
- Progress: six stages (interpreting request, finding candidates, verifying requirements, comparing verified offers,
  preparing checkout, awaiting authorization / payment confirmed) computed only from real research events and the
  session's own records; the full event list is behind "Research activity".
- Cards: the catalog has no product images, so each card shows a monogram labelled "No product image available" (never
  a stock or generated picture). The price is a **listing price (unverified)** until a comparison exists; only then
  does the selected card show the **merchant-verified total**. "Lowest verified total" appears only on a comparison
  offer. Requirement chips use the evidence ledger's status; the one-line reason is taken from the decision engine's
  own records.
- Detail: verified / not yet verified / failed requirement groups, each expandable to its attributed sources (host,
  source class, counted or not); identity; search-time merchant marked "not yet verified"; open conditions; untrusted
  listing text collapsed.
- Offers: lowest verified eligible offer first with item, shipping, tax, fees and total lines (unknown is shown as
  unknown, never zero), other verified offers, rejected merchants with reasons, hold callout, one primary action.
- Checkout: approval timeline (prepared → owner limit + confirm → payment approval → backend confirmation); the
  handoff links are unchanged. Receipt only when the backend reports `COMPLETED`.
- Environment pill: amber "MOCK · no money moves" vs blue "PayPal Sandbox · test funds".

## Live updates, refresh, reconnect

`GET /buy/api/runs/:run/events` is a `text/event-stream` of full snapshots (sent on change; re-read every 1.5 s so
changes made on other routes, such as the owner page or the payment return, appear). The page reads it with `fetch`
streaming so the key stays in a header. On disconnect it shows "reconnecting…", falls back to a plain GET and retries
with backoff (1 s → 10 s). Refresh resumes from `sessionStorage`; `/buy/` alone resumes the last panel of the tab (the
payment return page links there). Panel runs are stored in SQLite: a server restart keeps finished panels; research
that was running is reported as `INTERRUPTED`.

## Run it (MOCK)

```
npm run dev:buy-panel            # offline demo world on http://127.0.0.1:8790, prints a panel link,
                                 # a DEV-ONLY MCP token and a DEV-ONLY owner key (simulated human)
npm run dev:buy-panel -- --port 8791 --delay 600 --persist
```

Point an MCP host at `http://127.0.0.1:8790/mcp` with the printed token to call `start_shopping_panel` yourself.
For the real server: `DIAPORIA_BUY_PANEL=1 npm run dev`.

## API

| Method | Path | Body |
|---|---|---|
| GET | `/buy/api/runs/:run` | – |
| GET | `/buy/api/runs/:run/events` | – (SSE) |
| GET | `/buy/api/runs/:run/candidates/:productId` | – |
| POST | `/buy/api/runs/:run/select` | `{ productId }` |
| POST | `/buy/api/runs/:run/compare` | `{ destination?: { country, region?, postalCode? } }` |
| POST | `/buy/api/runs/:run/prepare` | `{ offerId }` |
| POST | `/buy/api/runs/:run/reset` | `{}`: leave a CANCELLED / FAILED / EXPIRED checkout and compare again (fresh quotes) |

## Validation record (2026-11-12)

- Linux CI and the cloud container: full suite green; `tests/buy-panel.test.ts` covers the slice, access control, the
  prepare scope, three cards, expiry, owner cancel → back to offers, live stream, restart/resume, CSP, MCP Apps resource.
- Headless Chromium at 360 px (cloud): full flow through receipt, refresh, bad link; no page errors.
- **Claude Desktop Browser pane** on Eric's Windows PC (MOCK server on 127.0.0.1:8795): two- and three-card results,
  detail, select, compare (look-alike merchant rejected), prepare, owner page limit → MOCK buyer approval → receipt only
  after server verification, owner cancel shown live, server restart with automatic reconnect, reload resume, 360 px
  without horizontal overflow, and the refusals (panel key on the owner page and the MOCK buyer step, wrong key, key in
  the query, foreign Origin, text/plain, unknown product, made-up offer with a price attached).
- **Codex Desktop** (installed on that PC, OpenAI.Codex 26.1103.7773.0): not driven; its Browser tab is unverified.
- **MCP Apps**: resource and tool metadata tested over MCP only; unverified in a real MCP Apps host.
- Known, outside the panel: in the demo world the decision engine can rank a product first by its search-time listing
  (from a merchant that comparison later rejects) above a product whose verified total is lower. The panel labels that
  number as a search-time listing from an unverified merchant; the ranking itself belongs to the research engine.
