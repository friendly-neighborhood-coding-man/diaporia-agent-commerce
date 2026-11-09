# Browser Checkout Handoff: security and data-retention review (V0)

Scope: `src/handoff/*`, the `/handoff/<id>` routes, and the two MCP tools. This review was written by the implementer
and has not been independently audited.

## Requirements and controls

| Requirement | Control | Test |
|---|---|---|
| Never copy or recreate a merchant's PayPal button outside the originating checkout | DIAPORIA renders no payment UI. The human uses the merchant's own page inside the same browser, through Live View. | `handoff-fixture`: the popup comes from the merchant page |
| Never generate merchant PayPal orders with DIAPORIA credentials | `src/handoff` imports no payment provider and contains no `createOrder` or `captureOrder` | `handoff-unit`: module boundaries. Mock PayPal `createOrder` count stays 0 |
| Never submit payment credentials, final confirmation or capture autonomously | (1) Recipe validation rejects click steps naming payment controls. (2) A runtime inspection of every click target refuses payment and order controls. (3) Popups are closed and off-merchant navigation is aborted during automation. (4) The driver refuses all code during takeover. | `handoff-fixture`, `handoff-unit` |
| Pause automation during human takeover | `pauseForHuman()` runs **before** the human view is released. After that, `run()` throws until `beginObservation()`, and observation snippets are read-only. | `AutomationPausedError` test. The KERNEL wire test counts zero executes during takeover. |
| Disable payment-stage recordings and sensitive logging | KERNEL is created with `telemetry.enabled=false`, replays are never started, and no screenshots are taken. Audit events hold state and failure codes only. Observation keeps host and path only (query strings and fragments, where PayPal tokens live, are dropped) plus at most 200 characters of the merchant confirmation element. | KERNEL wire test asserts the create body and no `/replays` calls |
| Never expose raw live-view URLs, credentials, cookies or CDP endpoints to AI tools or public logs | The live URL sits in a private field (`#live`). `toJSON` prints `[SECRET]`. It is emitted only in the authenticated takeover HTML (no-store, CSP-limited). CDP and WebDriver URLs are dropped at creation. Errors are scrubbed of `jwt=`. | KERNEL wire test greps MCP output, the audit table and the handoff table for `LIVE_SECRET`, `CDP_SECRET`, `jwt=` and the API key |
| A redirect is not proof of payment | `ORDER_CONFIRMED` only from a registered, signature-verified seller source that matches the prepared cart | "fake confirmation" test |
| Keep the direct PayPal Sandbox state machine unchanged | Separate state table and SQLite table. `stateMachine.ts` is untouched. | `handoff-unit`. The original 119 tests still pass. |
| Separate owner authority | The handoff page needs the owner key, which AI tokens cannot use, plus an owner-entered maximum for every handoff | "link alone grants nothing" and "isolation" tests |

## Residual risks (open)

1. **The KERNEL live-view URL is a bearer capability.** Per KERNEL's docs it stays valid until the browser is deleted, and it is not bound to a viewer. Anyone who obtains it during the session can operate the browser, including the human's PayPal session. Mitigations: it is shown only after owner authentication, `timeout_seconds` bounds the browser's life, and the browser is deleted on finish, cancel and expiry. It still reaches the human's own browser (history is not written because the response is POST and no-store, but browser extensions could read the DOM). **If Phase B shows that the URL leaks through referrers or KERNEL telemetry, that is a blocker.**
2. **The human can change the cart during takeover.** DIAPORIA cannot prevent this. The fixture's seller check catches total, quantity and SKU changes. For real merchants without a seller source the outcome stays `ORDER_UNVERIFIED`, and the human approved the amount on PayPal themselves.
3. **The pause is enforced by DIAPORIA, not KERNEL.** Any holder of the KERNEL API key could still drive the browser. Mitigation: the key is held only by this process (BYOK) and never logged.
4. **A remote datacenter browser at PayPal** may trigger risk checks or block login. This is unverified (Phase C).
5. **The handoff page is plain HTTP on loopback**, matching the existing dev-auth model. It is not a production deployment. The routes are disabled whenever payment execution is disabled (non-loopback or public mode).
6. **Owner sessions are in memory** and lost on restart, so the user re-enters the owner key. That is acceptable.
7. **The fixture HMAC secret** is generated per run and lives in memory. A real seller channel needs a real merchant integration.

## Data retention

| Data | Where | Retention |
|---|---|---|
| Handoff row: displayed cart fields, constraints, observation (hosts, paths, titles, at most 200 characters of confirmation text), seller status, owner maximum | SQLite `browser_handoffs` (local `.data/`, gitignored) | Kept like other checkout records. **No automatic deletion yet** (the same gap exists repo-wide). |
| Audit events (`HANDOFF_*`, `AUTOMATION_PAUSED_FOR_HUMAN`) | SQLite `audit_events`, hash-chained, redacted | Same as above |
| Browser state (cookies, PayPal login, storage, popups) | Inside the KERNEL or local browser | **Destroyed** when the browser is deleted: finish, cancel, expiry or server shutdown. No KERNEL profile is used or saved. |
| Live-view URL | Process memory only | Until the browser is deleted |
| Screenshots, recordings, HAR, page HTML | **Not collected** | none |
| KERNEL account-side records (usage, billing, any platform audit log) | KERNEL | Outside DIAPORIA's control. Telemetry is disabled per browser. |

## Before Phase B or C

- Phase B: check that the Live View leaks no referrer or URL to third parties (the iframe uses `referrerpolicy="origin"`, so only the loopback origin is sent), and that the popup is visible and operable.
- Phase C: a separately authorized, controlled Sandbox merchant with its own Sandbox app. Never reuse order 9DL148415W2504835 or capture 92U85747JU359434A, and never call capture from DIAPORIA.
