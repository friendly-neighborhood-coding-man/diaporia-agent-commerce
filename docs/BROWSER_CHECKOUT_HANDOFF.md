# Browser Checkout Handoff V0 (KERNEL)

A second checkout path, **separate** from the direct PayPal Sandbox checkout. An AI host (Claude Code, Codex CLI,
Grok Build, Hermes) starts the purchase. DIAPORIA prepares the cart on an authorized merchant's own website and stops
before payment. The human then completes the merchant's own PayPal step in that same browser session.

DIAPORIA does not press payment or order-submission controls, does not create the merchant's PayPal order, and
does not touch the direct PayPal Sandbox state machine. `src/handoff/` imports no payment provider, and a test
enforces that.

## Flow

1. `research_purchase` and `compare_purchase_offers` work as before. The offer must have `checkoutPath = EXTERNAL_MERCHANT_CHECKOUT`, an exact identity match, and no blocking verification issues. These issues are allowed because the browser will read the real cart: unknown total, estimate only, unknown merchant identity, stale quote.
2. `prepare_browser_checkout` needs `purchase.prepare` and dev auth on loopback. It works only for merchants that have a DIAPORIA **recipe**, a trusted per-merchant configuration listing selectors and steps (`src/handoff/recipes.ts`). A merchant without a recipe is not authorized.
3. An isolated browser does the following. For KERNEL this is one browser per handoff; for the fixture it is one BrowserContext per handoff.
   - It opens the product page, selects the **locked** variant, sets the quantity, adds to cart, and opens the cart. Step values are symbolic (`variant`, `quantity`) and come from the locked identity, so a recipe cannot pick another product.
   - While it runs, a guard aborts main-frame navigation off the merchant host and closes every popup or new tab. Before each click it inspects the target and refuses anything that looks like a payment or order-submission control (`PAYMENT_CONTROL_REFUSED`).
4. **Capture.** DIAPORIA reads what the merchant displays: title, variant, condition, quantity, subtotal, shipping, tax, total, currency label and the cart reference. A missing field becomes an explicit **unknown** and is never treated as zero.
5. **Constraints.** These run on the displayed cart. Any of the following puts the handoff in HOLD with no link offered: a product, variant, condition, quantity, currency or host mismatch, an unknown total, or a total that does not add up. The maximum is the **lowest** of four values: the assistant's requested maximum, the research budget, an active owner mandate, and the owner's maximum on the handoff page. A total above it is `AMOUNT_EXCEEDED`, the only HOLD the owner can fix.
6. **Handoff.** The state goes to `HUMAN_ACTION_REQUIRED`, and the contract returns `humanAction.url = /handoff/<ho_id>`. The link alone grants nothing. The human must:
   - enter their **owner key**, which the AI token cannot do;
   - receive a 10-minute HttpOnly, SameSite=Strict cookie scoped to that one handoff path, with CSRF protection;
   - **set their own maximum**, which is fresh human authority for this handoff;
   - press **Take over**.
7. **Takeover.** Automation is disabled first: the driver refuses every `run()`. Then the page shows the KERNEL Live View of the **same** browser. The human uses the merchant's own PayPal button. A popup, if any, opens inside that browser.
8. **Return.** "I'm done" or the takeover timeout runs one **read-only** observation: open pages as host and path only, titles, and the merchant confirmation element. DIAPORIA then queries the **seller-side** source and deletes the browser.

## States (`src/handoff/states.ts`)

`CHECKOUT_PREPARING → CHECKOUT_READY → HUMAN_ACTION_REQUIRED → HANDOFF_OPENED → RETURN_OBSERVED → ORDER_UNVERIFIED | ORDER_CONFIRMED | CANCELLED`, plus `HOLD` and `EXPIRED`.

- `EXPIRED` and owner `CANCELLED` exist only **before** takeover. After takeover, an observation must follow. A takeover timeout never becomes "nothing happened".
- `RETURN_OBSERVED → CANCELLED` happens only when an authenticated seller source reports **NO_ORDER**.
- `ORDER_CONFIRMED` requires all of the following: a seller source registered for that exact merchant domain, a valid signature, status `CONFIRMED`, and a match on total, quantity, currency and SKU with the prepared cart. A thank-you page or redirect alone yields at most `ORDER_UNVERIFIED`, with the discrepancy `PAGE_CLAIMS_CONFIRMATION_WITHOUT_SELLER_CONFIRMATION`.
- Real merchants have **no** registered seller source in V0, so their best outcome is `ORDER_UNVERIFIED`. That is reported honestly.

## Host UX (same contract for every host)

The `prepare_browser_checkout` and `get_browser_checkout_status` results contain `humanAction` with these fields:

```json
{ "kind": "OPEN_HANDOFF_PAGE", "url": "http://127.0.0.1:8790/handoff/ho_…", "authentication": "OWNER_KEY",
  "presentation": { "cliHosts": "OPEN_LINK_IN_DEFAULT_BROWSER", "uiHosts": "OPEN_LINK_OR_EMBED_AUTHENTICATED_PAGE", "inChatPaymentModal": "NOT_ASSUMED" } }
```

- **CLI hosts** show the link, and the user opens it in their default browser. The JSON text block equals `structuredContent`, so text-only hosts see the same contract.
- **UI-capable hosts** may open or embed the authenticated handoff page. The raw KERNEL live-view URL is **never** in the contract. It appears only inside the authenticated takeover HTML (`Cache-Control: no-store`, CSP `frame-src` limited to the live-view origin, `frame-ancestors 'none'`). The handoff page itself cannot currently be framed by a host. Allowing that is a deliberate follow-up that needs per-host origin allowlisting.
- No host is assumed to support in-chat payment modals.

## Drivers (`src/handoff/drivers.ts`)

| Driver | Use | Notes |
|---|---|---|
| `LocalFixtureDriver` | Phase A, tests, `npm run demo:handoff` | playwright-core with a local Chromium (no browser download). One BrowserContext per handoff. |
| `KernelDriver` | Phase B, live | Fetch-only KERNEL REST, the same approach as the BYOK `KernelPageInspector` on `feature/byok-completion-v1` (consolidate both after merge). It creates a **headful** browser with `telemetry.enabled=false`, `kiosk_mode=false` and `stealth=false`, never starts replays, and discards `cdp_ws_url`, `webdriver_ws_url` and `base_url`. It requires `allowLive: true` and has a per-process browser cap. |

Both drivers execute the **same** snippets (`buildPrepareScript`, `buildObserveScript`) with `page` and `context` in scope, which is KERNEL's `/playwright/execute` contract. Phase A therefore tests the code that KERNEL will run.

## Verified vs. unsupported browser behavior

| Behavior | Status | Evidence |
|---|---|---|
| Cart preparation stops before payment; payment and order controls are never activated | **Verified offline** (local Chromium) | `tests/handoff-fixture.test.ts`: merchant counters show 0 popup, approve and place-order hits |
| Runtime refusal of a recipe step targeting "Place order" | **Verified offline** | same file |
| Prompt-injection text on merchant pages has no effect | **Verified offline** | same file |
| Silent substitution (variant, condition) and price drift lead to HOLD | **Verified offline** | same file |
| The human opens the merchant's payment **popup** (`window.open` with popup features) in the same browser context, and approve/cancel returns to the opener | **Verified offline** (local Chromium, not KERNEL) | same file |
| Automation is hard-paused during takeover | **Verified offline** | `run()` throws `AutomationPausedError` |
| A fake confirmation page is not proof | **Verified offline** | same file |
| Expiry before takeover, and takeover timeout leading to observation instead of EXPIRED | **Verified offline** | same file |
| Per-user isolation (separate contexts, cart refs, links and cookies) | **Verified offline** | same file |
| KERNEL request shapes (headful, telemetry off, no replay, DELETE on finish), live URL kept out of MCP, audit and DB | **Verified offline** with a fake KERNEL backend that runs the same snippets locally | `tests/handoff-kernel-wire.test.ts` |
| **A popup window is visible and operable through KERNEL Live View, in the same browser session** | **VERIFIED live (Phase B, 2026-11-09)** with a synthetic `window.open(…, "popup,…")` popup. The human saw it and clicked and typed in it. A read-only DOM read afterwards confirmed it: popup button `CLICKED`, 5 characters typed, and the popup is a page of the same browser context. Live View events: CONNECTED, then PLAYING. | `docs/evidence/handoff-phase-b-2026-11-09T18-38-35-558Z.json` |
| PayPal accepts login and approval from a KERNEL datacenter browser (risk checks, 2FA, bot detection) | **NOT VERIFIED.** Needs Phase C (separate owner authorization) | none |
| `network.allowed_hosts` egress allowlist still lets PayPal checkout assets load | **NOT VERIFIED.** Off by default (`networkAllowedHosts` unset) | none |
| Live View `readOnly=true` as a protection | **Unsupported as a security control.** It is a URL query parameter the viewer can remove. Automation pause is enforced on DIAPORIA's side instead. | KERNEL docs |
| Real merchant checkouts | **Not in V0.** Recipes exist only for the offline fixture. | none |

## Phases

| Phase | Status |
|---|---|
| A, offline fixture | **Done.** 20 browser tests, 31 unit and KERNEL-wire tests, and an offline demo (`npm run demo:handoff`, with `--headed` or `--interactive`). |
| B, KERNEL Live View | **PASS (synthetic popup, no payment).** One headful non-GPU browser ran for 64 s, about $0.009. The DELETE was sent and KERNEL confirmed the browser is gone, and a follow-up account check showed 0 running browsers. This proves same-session popup interaction through Live View. It does **not** prove PayPal compatibility: PayPal's own popup, login, risk checks and 2FA in a KERNEL datacenter browser remain Phase C. |
| C, PayPal Sandbox through a controlled sandbox merchant | **Not started.** It needs separate owner authorization. Existing Sandbox orders must never be reused. |
| D, cross-host | **Done (MOCK).** All four real hosts made a host-originated `prepare_browser_checkout` call and got the same contract: 4/4 PASS. See `docs/HANDOFF_HOST_MATRIX.md`. |

## Run it

```bash
npm run demo:handoff                       # simulated human, headless, offline
npm run demo:handoff -- --interactive      # you act as the human in a visible Chromium window
HANDOFF_DRIVER=fixture npm run dev         # MCP server with the handoff tools and the offline fixture merchant
```

KERNEL (billed; needs the owner's OK): `HANDOFF_DRIVER=kernel DIAPORIA_ALLOW_KERNEL_LIVE=1 KERNEL_API_KEY=… HANDOFF_RECIPES_FILE=recipes.json npm run dev`.
