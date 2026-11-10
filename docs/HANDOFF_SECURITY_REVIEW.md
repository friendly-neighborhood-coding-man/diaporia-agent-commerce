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

1. **The KERNEL live-view URL is a bearer capability.** Per KERNEL's docs it stays valid until the browser is deleted, and it is not bound to a viewer. Anyone who obtains it during the session can operate the browser, including the human's PayPal session. Mitigations: it is shown only after owner authentication, KERNEL `timeout_seconds` is an **idle timeout only**. The integrated driver now launches a detached wall-clock DELETE watchdog (hard maximum 10 minutes), uses an in-process timer, records session IDs and deadlines in a local mode-0600 journal, and attempts cleanup on restart. Deletion is checked against the provider's paginated active-browser list. This is still not an enforceable USD cost ceiling or a guarantee if the machine is powered off. It still reaches the human's own browser (history is not written because the response is POST and no-store, but browser extensions could read the DOM). **If Phase B shows that the URL leaks through referrers or KERNEL telemetry, that is a blocker.**
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
| Browser state (cookies, PayPal login, storage, popups) | Inside the KERNEL or local browser | **Intended to be destroyed** on verified browser deletion: finish, cancel, expiry, a detached watchdog, or restart recovery. If deletion cannot be verified, DIAPORIA reports an error and must not claim that the session is gone. No KERNEL profile is used or saved. |
| Live-view URL | Process memory only | Until the browser is deleted |
| Screenshots, recordings, HAR, page HTML | **Not collected** | none |
| KERNEL account-side records (usage, billing, any platform audit log) | KERNEL | Outside DIAPORIA's control. Telemetry is disabled per browser. |

## Phase B result (2026-11-09)

The Live View URL never left the process. It appeared only in the loopback page served at a random path. The evidence file contains no `jwt` value or KERNEL host. The browser was deleted and confirmed gone after 64 s. KERNEL's `timeout_seconds` turned out to be an **idle** timeout, and KERNEL spending caps do not stop browsers that are already running. Because of that, the Phase B script enforces its own hard wall-clock DELETE, runs a detached watchdog, and verifies the deletion afterwards. The integration branch adds a standalone watchdog (`scripts/kernel-handoff-watchdog.mjs`), driver-level hard wall timer, durable session cleanup journal and startup recovery. These have **not** been exercised against real KERNEL yet; only fake HTTP and CI tests support them. The independent watchdog does not run if the entire computer is off, in which case recovery occurs on the next start.

## Before Phase C

- Phase B: check that the Live View leaks no referrer or URL to third parties (the iframe uses `referrerpolicy="origin"`, so only the loopback origin is sent), and that the popup is visible and operable.
- Phase C: a separately authorized, controlled Sandbox merchant with its own Sandbox app. Never reuse order 9DL148415W2504835 or capture 92U85747JU359434A, and never call capture from DIAPORIA.

## Integration hardening checkpoint (2026-11-10, draft PR #5)

- **Implemented, offline only:** checkout driver wall-clock limit ≤10 minutes, detached watchdog, provider deletion verification, redacted failed-cleanup audit, and startup orphan reaper. CLI/headless fixture tests do not exercise real crash recovery.
- **Research browser:** per-session KERNEL-managed egress host allowlist plus Playwright context request and WebSocket routing; deletion failure withholds all evidence. This is defense in depth, **not verified IP-level SSRF isolation**. KERNEL's published `allowed_hosts` limitation states it filters KERNEL-managed egress, not all VM traffic. Research inspection is now **OFF by default** even when a KERNEL key exists; requires `DIAPORIA_ENABLE_LIVE_KERNEL_INSPECTION=1`.
- **Blocked:** Phase C PayPal Sandbox login and any real merchant checkout, pending independent network-policy validation, watchdog crash/restart tests, and separate explicit authorization. Do not expose LIVE KERNEL browser sessions to public endpoints.
- **Operational requirement:** when provider deletion cannot be verified, an operator must inspect the KERNEL dashboard and revoke/rotate compromised tokens if needed. Never claim cleanup solely from an HTTP DELETE attempt.
