# Independent Security Review: DIAPORIA Agent Commerce MVP

| | |
|---|---|
| Reviewed commit | `759bd37b0ad254f414fd61b9a009631c026f97f5` (head of draft PR #9, branch `integration/mvp-full-layer`, verified via the GitHub API at 2026-11-10 17:37Z) |
| Review date | 2026-11-10 |
| Reviewer | Independent review session (fresh context). It did not ask the implementation threads to certify their own work. |
| Environment | Cloud Linux container, Node 22.23.4, `npm ci` from the lockfile, `node:sqlite`. Disposable in-process MOCK apps on 127.0.0.1 with `:memory:` or fresh temporary SQLite files. |
| External calls | None. No PayPal Sandbox, KERNEL, Cloudflare, Channel3 or Tavily call, no deployment, no production credentials. One web search covered PayPal's public documentation. |
| Changes to the target | None. `integration/mvp-full-layer` is untouched. This report, `FINDINGS_REGISTER.md` and `tests/security-review/independent-probes.test.ts` are test/doc-only files on a separate review branch. |
| Findings register | [`FINDINGS_REGISTER.md`](./FINDINGS_REGISTER.md) |

## 0. Answer to the final question

**What can DIAPORIA safely expose to remote AI assistants today?**
Nothing yet without changes. With the conditions in §8 met, it can expose a **research/read-only OAuth MCP endpoint** as a separate, supervised, single-owner deployment running MOCK fixtures. Gate R is **CONDITIONAL PASS**.
- The controls that matter for that target hold, and I tested them. On a non-loopback base URL every payment, owner, mock and handoff route returns 403. `purchase.prepare` is neither offered nor grantable. Tokens are audience-bound. PKCE S256 is mandatory. Code replay revokes the grant family. The Host guard returns 421.
- What fails is availability and operator safety in front of a proxy. One shared 30/min bucket lets any visitor lock everyone out (IR-05). Client registration is permanently exhaustible (IR-04). The payment gate depends only on configuration (IR-08). Open registration plus the master owner key on a public form allows consent phishing (IR-03, IR-16). Grants survive key rotation and slide forever (IR-07). Each of these needs a fix or an operational control first.

**What must be fixed before Sandbox payment testing?**
- **C1 preflight** (popup, one order, no capture) is a **CONDITIONAL PASS**. The main condition is that AI hosts must not run under the OS account that holds the owner keys, the Phase C signing key or Sandbox credentials (IR-01).
- **C2 capture** is **not authorized** by this review. Before C2:
  - fix the concurrent-prepare duplicate (IR-02);
  - make expired reconcile truly read-only (IR-11);
  - bind the owner review session to its checkout (IR-09);
  - reject ambiguous decimal input (IR-10);
  - verify KERNEL egress allowlisting and Live View secrecy against the real service (IR-20);
  - re-verify PayPal's idempotency and single-capture guarantees from the official reference (IR-18).

**What remains unsuitable for production?**
- Everything that moves real money. Gate P is **BLOCKED**.
- There is no real identity provider; the owner key is the only human credential.
- Live PayPal is refused by construction.
- There is no reachable, verified webhook path.
- There is no merchant-order integration.
- Merchant identity uses MOCK registries.
- Storage, rate limiting and secrets are single-host.
- The human/AI separation is procedural on a shared machine.

The full list is in §8.

## 1. Scope and method

I read these files myself:
- `src/http/server.ts`, `src/auth/oauth.ts`, `src/auth/devAuth.ts`, `src/http/rateLimit.ts`, `src/main.ts`
- `src/engine/CommerceGateway.ts` (all of it), `src/policy/*`, `src/checkout/*`, `src/store/Database.ts`
- `src/payment/*`
- `src/mcp/MCPCommerceAdapter.ts`
- `src/handoff/{http,config,BrowserCheckoutHandoff}.ts`, the KERNEL parts of `src/handoff/drivers.ts`
- `src/evidence/KernelPageInspector.ts`, `src/metering/UsageLedger.ts` (limits)
- `src/security/{redact,untrusted}.ts`, `src/domain/money.ts`
- `apps/phase-c-test-merchant/src/{server,orders}.ts` (routes, operator gate, capture path; partial)
- `scripts/interop/semantic-fidelity.mjs`

For each area I wrote down the invariants, traced entry points and state transitions, and built adversarial cases. I then wrote 19 local probes: 14 `ATTACK` probes, each asserting the current weak behaviour so that a fix makes it fail, and 5 `CONTROL` probes asserting defences that held.

**Independence.** The review was done in this order:
1. My own pass: code reading, then probes.
2. A comparison with the earlier review of `cce2237` (`/mnt/project-files/agent-commerce-mvp/security-review-cce2237/REPORT.md`, SR-01..SR-09) and with the findings F1–F5 that the remote-deployment thread sent me.

I treated both as claims. Where I re-verified one, the register says so ("SR-0x re-verified"). New findings that neither source lists: IR-02, IR-07, IR-10, IR-12, IR-14 and the gate verdicts.

**Not reviewed in depth:**
- the managed-billing / subscription routes (`src/billing/*`; reachable only in managed mode, which refuses to start except as a loopback simulation);
- the Shopify/Channel3 live adapters;
- the Phase C merchant's browser script (`public/checkout.js`);
- the KERNEL proxy/egress behaviour, which needs the real service;
- `scripts/interop/scenario-i.mjs` beyond the credential files it writes.

## 2. Trust boundaries

```
 Internet / remote AI host ──TLS──▶ [proxy / tunnel] ──▶ DIAPORIA HTTP (one Node process, one SQLite file)
        │                                                   │
        │  AI INVOCATION AUTHORITY                          ├─ /mcp            bearer: dev token or OAuth access token
        │  (dct_ dev token / dat_ OAuth token)              │                  scopes research / read / prepare
        │                                                   ├─ /oauth/*        open DCR, consent = OWNER KEY form
        │                                                   ├─ /.well-known/*  public metadata
 Human owner (browser) ── HUMAN PURCHASING AUTHORITY ──────▶├─ /owner/*, /authorize/*, /handoff/*   OWNER KEY (dok_)
        │                                                   │       only when paymentExecutionEnabled (config: loopback)
        │                                                   ├─ /mock-paypal/*  MOCK buyer approval: NO credential
        ▼                                                   ├─ /paypal/return  GET, unauthenticated, triggers capture after server-side GET
 PayPal (Sandbox) ── PAYMENT-PROVIDER AUTHORITY ───────────▶├─ /paypal/webhook signature (CRC32-based) → read-only reconcile
        │   buyer login + approval on paypal.com            │
        ▼                                                   └─ Phase C merchant (separate app): MERCHANT-ORDER CONFIRMATION
 Merchant server ── seller status (HMAC) ──────────────────▶   via HMAC-signed /api/orders/status; never from redirects
 KERNEL (remote browser, Live View URL = bearer capability) ◀── handoff driver (billed; per-process + durable ledger caps)
```

How well the four authorities are separated in code:

| Authority | Enforced by | Holds against a remote attacker | Holds against a same-OS-user AI host |
|---|---|---|---|
| AI invocation | bearer → `Principal`; user id from token only | yes (CONTROL cross-user) | yes (it *is* this authority) |
| Human purchasing | owner key on owner routes; checkout-bound mandates | yes when payment routes are off; else owner-key strength | **no**: owner keys sit in `.data/*.json` and in the process environment (IR-01) |
| Payment provider | PayPal buyer login/approval; server re-reads order and capture | Sandbox: yes (needs buyer login) | MOCK: **no** (unauthenticated approve, IR-01). Sandbox: only if buyer creds or session are reachable |
| Merchant-order confirmation | HMAC-signed seller status (Phase C); otherwise `MERCHANT_ORDER_NOT_VERIFIED` | yes (never claimed without it) | the HMAC secret is in the same environment |

## 3. Threat model: adversaries and results

| Adversary | Result |
|---|---|
| Unauthenticated external attacker | With a non-loopback base URL, payment routes are closed (CONTROL). Availability attacks work: IR-04, IR-05, IR-06. A Host-rewriting proxy exposes payment routes (IR-08). With live providers, anonymous demo spends operator money (IR-15). |
| Authenticated user, cross-user | Not reproduced. Every query is scoped by `user_id` and the id comes from the token (CONTROL). |
| Compromised AI assistant / MCP client | Cannot create spending authority over MCP. With an existing REUSABLE mandate it can complete a MOCK purchase alone (IR-01). Concurrent calls duplicate purchases (IR-02). On the same OS user it can read owner keys (IR-01). |
| Malicious seller / listing / review / page | Text is flagged and never executed. Merchant manipulation excludes an offer. Whether an AI host *obeys* injected text is outside the server's control, and the server's authority model is the defence. KERNEL inspection only yields statements tied to the page heading. SSRF is filtered locally, but DNS rebinding and some IPv6 transition ranges are not covered (IR-19, affects KERNEL's network). |
| Stolen / replayed OAuth token | Access tokens are audience-bound and expire after 1 h. A code replay revokes the family; refresh reuse revokes the family. **A stolen refresh token lives forever by sliding, and owner-key rotation does not revoke grants** (IR-07). |
| Compromised / overprivileged browser session | The owner review cookie is not bound to its checkout (IR-09). The KERNEL Live View URL is a bearer capability, shown only on the authenticated takeover page. Its secrecy at KERNEL is unverified (IR-20). |
| User approving an expired or modified transaction | Expired checkout → no authority (CONTROL, DF-4). Buyer approval after expiry never captures (code + existing tests). Amount, currency, custom_id and payee are re-checked from the provider before capture. "60,00" silently becomes a 100× limit (IR-10). |
| Concurrent requests racing authorization / capture | Owner authorization is atomic, even across two processes on one DB (CONTROL). Capture is gated by a version CAS. **`prepare_checkout` dedup is not atomic** (IR-02). |
| Provider timeout / ambiguous response | UNKNOWN keeps the reservation. 5xx counts as unknown. A capture replay never fails closed into a release. One write path remains after expiry (IR-11). |
| Server crash / restart during payment | `capture_requested_at` is durable before the call. Stuck CAPTURE_PENDING → UNKNOWN after 5 min. Startup reconcile is read-only. MOCK loses its provider state on restart (SR-08, test artefact). |
| Malicious use of registration / authorization endpoints | Permanent DCR exhaustion (IR-04). Pending-consent wipe (IR-06). Consent phishing with a look-alike client name (IR-03). |

## 4. Attack surface inventory

| Surface | Auth | Public deployment (non-loopback base URL) | Local (loopback) |
|---|---|---|---|
| `GET /healthz` | none | open; discloses auth mode, provider, payment flag (IR-21) | open |
| `POST /mcp` | bearer | research/read tools only | + `prepare_checkout`, `prepare_browser_checkout` |
| `/.well-known/oauth-*` | none (CORS `*`) | open, 30/min per socket IP | open |
| `POST /oauth/register` | none | open, cap 1000 forever (IR-04) | open |
| `GET/POST /oauth/authorize` | owner key in form | open | open |
| `POST /oauth/token`, `/oauth/revoke` | client auth / PKCE | open | open |
| `/owner/*` (mandates, revoke, reconcile, cancel) | `X-Owner-Key` | 403 | open |
| `/authorize/<cs>` | owner key → 10-min cookie | 403 | open |
| `/mock-paypal/checkout/<id>/approve\|cancel` | **none** | 403 | open (IR-01) |
| `GET /paypal/return\|cancel` | knowledge of cs id + order id | 403 | open; triggers capture after a server-side check |
| `POST /paypal/webhook` | PayPal signature | 403 | open only if `PAYPAL_WEBHOOK_ID` is set. Unreachable by PayPal in practice (loopback). |
| `/billing/*` | owner key / signatures | 403 | managed simulation only |
| `/handoff/<ho>` | owner key → cookie | 403 | open when `HANDOFF_DRIVER` is set |
| Phase C merchant (separate app, public HTTPS) | cart cookie + CSRF; operator bearer; owner Ed25519 for C2 retry | — | — |

Limits: body 64 KiB (`readText`), `requestTimeout` 30 s, `headersTimeout` 10 s, MCP 120/min per token|IP, web 30/min per socket IP. The limiter clears all windows at 10,000 keys.

## 5. Findings (summary)

The register is authoritative and has the status of each item. Severity reflects exploitability *in the deployment it applies to*.

| ID | Sev | Status | Title | Gate |
|---|---|---|---|---|
| IR-01 | HIGH | REPRODUCED | AI token + REUSABLE mandate completes a MOCK purchase with no human; a same-user host can read owner keys (SR-01) | C, P |
| IR-02 | MEDIUM | REPRODUCED | Concurrent identical `prepare_checkout` creates two checkouts and two orders for one purchase session | C, P |
| IR-03 | MEDIUM | REPRODUCED | Open DCR + owner-key consent allows consent phishing with a look-alike client | R |
| IR-04 | MEDIUM | REPRODUCED | DCR capped at 1000 and never pruned: permanent registration DoS (F4/SR-04) | R |
| IR-05 | MEDIUM | REPRODUCED | Behind a proxy all visitors share one 30/min bucket: OAuth DoS (F1) | R |
| IR-07 | MEDIUM | REPRODUCED | OAuth grants survive owner-key rotation; refresh lifetime slides indefinitely | R, C, P |
| IR-08 | MEDIUM | REPRODUCED (simulated proxy) | Payment gate is config-only; a Host-rewriting proxy exposes payment routes (F2/SR-02) | R |
| IR-15 | MEDIUM | CONFIRMED (code) | Anonymous demo / public mode with live BYOK keys: no deployment-wide spend cap (SR-04) | R |
| IR-16 | MEDIUM | CONFIRMED (code) | Owner key = OAuth login and spending credential; per-IP limit only; silent dev-credential reuse (SR-03, F3, F5) | R, C |
| IR-06 | LOW | REPRODUCED | >5000 pending authorizations wipes all legitimate consents | R |
| IR-09 | LOW | REPRODUCED | Owner review session not bound to the reviewed checkout (SR-05) | C |
| IR-10 | LOW | REPRODUCED | `parseDecimalToMinor("60,00")` = 600000 (a 100× limit) | C |
| IR-11 | LOW | REPRODUCED (MOCK) | Reconcile replays `createOrder` past expiry / past the 6 h idempotency window (SR-06) | C |
| IR-12 | LOW | REPRODUCED (own key) | Webhook signature covers only CRC32(body): a captured signature verifies a forged body | C, P |
| IR-13 | LOW | REPRODUCED | Redaction misses base64url tails and OAuth token shapes (SR-07) | all |
| IR-14 | LOW | REPRODUCED | `semantic-fidelity/v1` misses paraphrased and non-English false claims | all |
| IR-19 | LOW | UNVERIFIED | KERNEL evidence SSRF filter: no DNS-rebinding pinning; IPv6 6to4/Teredo allowed | R (if KERNEL on) |
| IR-17 | INFO | CONFIRMED (code) | PayPal webhook and return routes exist only on loopback: no provider-push reconciliation in any supported config | C, P |
| IR-18 | INFO | UNVERIFIED | PayPal-Request-Id retention (6 h documented for capture) and single-capture-per-order are not verified here | C, P |
| IR-20 | INFO | UNVERIFIED | KERNEL `network.allowed_hosts`, Live View URL secrecy and cleanup guarantees need the real service | C |
| IR-21 | INFO | CONFIRMED (code) | `/healthz` discloses configuration | R |

**No CRITICAL finding.** I found no path by which an attacker without the owner key and without local access can create spending authority, capture funds, or read another user's data.

## 6. Details, reproduction and evidence

All probes are in `tests/security-review/independent-probes.test.ts`. Run them with:

```
npm ci && npx vitest run tests/security-review --reporter=verbose
```

Output at the reviewed commit is in §7.

### IR-01 HIGH: no human in the MOCK purchase loop; same-user hosts can read owner keys

**Code**
- `src/http/server.ts:303`: the mock approve needs only `sameOrigin()`. `sameOrigin()` returns true when the Origin header is absent (`server.ts:350`).
- `src/engine/CommerceGateway.ts:370-377`: `prepare_checkout` auto-reserves any matching REUSABLE mandate and creates the order.
- `src/main.ts:26-38` writes the owner key to `.data/dev-credentials.json`. It also reuses that file in oauth mode when `DIAPORIA_OWNER_KEYS` is unset (F3).

**Probe.** `ATTACK IR-01`:
1. The owner creates a REUSABLE mandate.
2. The AI token runs research → compare → prepare.
3. One bare `POST /mock-paypal/checkout/<id>/approve` (no cookie, key or Origin) is sent.
4. `get_checkout_status` returns `COMPLETED`.

**Exploitability**
- **Local MOCK (Scenario I):** trivial for any MCP client, because the MOCK approval URL is in the tool output.
- **Sandbox:** the buyer step needs a PayPal Sandbox login, so the AI alone cannot complete it.
- **Either environment:** a same-OS-user host can still read owner keys, `PAYPAL_CLIENT_SECRET`, the Phase C seller HMAC secret and the owner's Ed25519 key if it lives on that machine. It can also write SQLite directly.

**Consequence.** Scenario I's human/AI separation is procedural. Its evidence cannot attribute the owner-page and approval requests to a human.

**Mitigation**
- Run DIAPORIA and the owner secrets under a different OS user or container from every AI host.
- Require the owner session for the mock approve.
- Record request provenance on owner and approval actions.
- Do not let `prepare_checkout` auto-start payment from REUSABLE mandates unless the owner opted in for automatic use.

**Regression check.** Gating the mock approve behind the owner session changes `tests/helpers.ts:buyer()`, which approves without a session, so existing tests need a helper that authenticates. No race is introduced.

### IR-02 MEDIUM: concurrent `prepare_checkout` duplicates a purchase

**Code.** `CommerceGateway.prepareCheckout`:
- the in-flight check (`:322`) and the duplicate check (`:328`) run before several awaits: `findOffers`, `getQuote` and `verifyMerchant` (`:332-339`);
- `createCheckout` (`:356`) then inserts unconditionally;
- no unique constraint covers a live checkout per purchase session.

**Probe.** `ATTACK IR-02`:
- Setup: one REUSABLE mandate ($120, 2 transactions); a MOCK catalog whose merchant quote takes 150 ms (live quote adapters are slower).
- Two concurrent identical calls return different `checkoutSessionId`s and `deduplicated:false`. There are 2 `createOrder` calls, and both checkouts reach `COMPLETED`.
- The mandate ceiling still held (consumed ≤ max).
- `CONTROL`: sequential identical calls are deduplicated. With the zero-latency fixture catalog the race did not reproduce over HTTP.

**Necessary conditions**
- A REUSABLE mandate with room for ≥2 transactions and ≥2× the total.
- Two concurrent calls from a host or retrying client.
- Quote latency.
- In Sandbox, each order still needs its own buyer approval. A user who is shown two approval links may approve both, believing one is a retry.

**Mitigation**
- Claim the slot atomically before the awaits. For example, insert a placeholder checkout in a `BEGIN IMMEDIATE` that re-runs both checks.
- Or add a partial unique index, e.g. `checkout_sessions(purchase_session_id) WHERE state NOT IN ('CANCELLED','FAILED','EXPIRED')`, and map the constraint error to the existing deduplicated result.
- Re-run the DF-4 suite afterwards. The index must not block a legitimate re-prepare after FAILED or EXPIRED.

### IR-03 MEDIUM (Gate R): consent phishing via open DCR

**Code**
- `oauth.ts:141-166` accepts any https redirect and any `client_name` from anyone.
- The consent form asks for the owner key (`oauth.ts:219`, `server.ts:411-421`).

**Probe.** `ATTACK IR-03`:
1. A client named "Claude" with redirect `https://claude-ai.attacker.example/...` is registered.
2. The victim approves on the genuine consent page.
3. The code goes to the attacker origin, and the attacker's PKCE verifier exchanges it for a token as `alice`.

**Mitigating factors**
- The page shows "self-registered; name not verified" and the redirect host.
- On a public deployment the scope is research/read, and a fresh deployment DB holds no checkouts.

**Mitigation for a restricted deployment**
- Allowlist redirect URIs (or pre-register the one intended client) and disable open DCR.
- Use a deployment-specific credential, never the local owner key.

### IR-04 / IR-05 / IR-06 (Gate R availability)

- **IR-04** (`oauth.ts:156-157`, no pruning). Probe: with `maxClients: 5`, the 6th registration returns 503 even one year later.
- **IR-05** (`server.ts:101,130`; limiter keyed on `req.socket.remoteAddress`). Probe: 30 requests from "attacker" (`X-Forwarded-For` 198.51.100.7), then an unrelated user (203.0.113.50) gets 429 on discovery. A proxy delivers all users from one socket IP.
- **IR-06** (`oauth.ts:348`, `pending.clear()` above 5000). Probe: a victim's pending consent is gone after 5002 begins. It needs many source IPs, or one IP behind a proxy that is not trusted.

**Mitigation**
- Trusted-proxy client IP (only from the configured proxy hop).
- A separate, stricter `/oauth/register` limit.
- Client GC, or a closed client allowlist.
- LRU eviction by age instead of a wholesale clear.

### IR-07 MEDIUM: grants outlive owner-key rotation; refresh slides forever

**Code**
- `oauth.ts:312-317` issues a fresh 30-day refresh token on every refresh.
- Tokens are bound to `user_id` only. Nothing links a grant to the owner key that approved it, and no "revoke all grants for user" operation exists.

**Probe.** `ATTACK IR-07`:
1. Obtain tokens.
2. Restart on the same DB with Alice's owner key replaced.
3. The access token still verifies and the refresh still succeeds.

**Impact.** After a suspected owner-key leak, an attacker's grant keeps working indefinitely unless the operator deletes the DB. Reuse detection fires only if the legitimate client refreshes the same family.

**Mitigation**
- An absolute grant lifetime (family `created_at` + N days).
- An owner-authenticated "revoke all grants" operation.
- Bind the grant to a key fingerprint and revoke on rotation.
- For the time-boxed Gate R window, delete the deployment DB at the end.

### IR-08 MEDIUM (Gate R): config-only payment gate

**Code**
- `server.ts:70` computes `paymentExecutionEnabled` from `HOST` and `PUBLIC_BASE_URL` strings.
- `server.ts:86` always allows `127.0.0.1:<port>` and `localhost:<port>` as Host.

**Probe.** `ATTACK IR-08`, raw HTTP as a Host-rewriting proxy would send it (loopback socket, `Host: 127.0.0.1:<port>`, `X-Forwarded-*` from the internet): `/owner/mandates` → 401 (live route, only the owner key stands), `/mock-paypal/...` → 404 (live route). With `Host: public.example` the result is 421. So only a Host *rewrite* exposes the routes.

**CONTROL.** With an https base URL, all six payment route families return 403 and `/mcp` with a foreign Host returns 421.

**Mitigation**
- A dedicated remote entrypoint that refuses to start on a loopback base URL.
- Refuse payment routes when any forwarding header is present.
- Never front a dev or loopback instance.

### IR-09, IR-10, IR-11 (before C2)

- **IR-09** (`server.ts:219-245`). Probe: a review session opened for checkout A authorizes checkout B → 303. Bind the session to `csId`, as `src/handoff/http.ts:52` already does.
- **IR-10** (`money.ts:28` strips commas). `"60,00"` USD = 600000 minor units. Impact is bounded because a bound mandate covers one fixed, displayed total. It is still a trust problem in the limit the owner types. Reject `,` unless it is a thousands separator in a valid position, and echo the parsed amount for confirmation.
- **IR-11** (`CommerceGateway.ts:717` → `:432-443`; no expiry or age check). Probe: an UNKNOWN create timeout plus 7 h, then an owner reconcile sends one more `createOrder`. In Sandbox, past PayPal's documented 6 h key retention, this can create a second, never-approved order. No money moves, but "past expiry: read-only" is not true for this path. Skip the replay when `now ≥ expiresAt` or `now − createdAt ≥ 5 h`.

### IR-12 LOW: CRC32-only body binding in PayPal webhook signatures

**Code.** `PayPalWebhook.ts:63`. The signed string is `id|time|webhookId|crc32(body)`, as PayPal specifies.

**Probe.** `ATTACK IR-12` used a locally generated RSA key standing in for PayPal's certificate. A genuine `PAYMENT.CAPTURE.COMPLETED` body is signed. A forged body with a different event id, capture id and type (`DENIED`), made to match the CRC32 by linear algebra over 48 padding characters, verifies with the same signature.

**Impact**
- Low here: the endpoint is unreachable from PayPal in every supported config (IR-17), and events only trigger an authoritative GET of a capture that DIAPORIA already knows.
- The forged id defeats event-id dedup.

**Mitigation**
- Deduplicate on `paypal-transmission-id` as well.
- For any reachable webhook, prefer PayPal's server-side `verify-webhook-signature` API, or treat events purely as "re-read everything pending".

### IR-13, IR-14

- **IR-13.** `redact.ts:5` stops at the first `-` or `_` of base64url keys, so key tails survive. `dat_`, `drt_`, `dac_` and `dcs_` are not matched at all.
- **IR-14.** `semantic-fidelity/v1` is regex-based and English-only. "All done! The headphones are yours now … heading to your door." and a Korean "payment complete, order confirmed" both score `NO_CONTRADICTION` against UNKNOWN/MOCK evidence. The literal phrasing is caught. It is a detection aid, so `NO_CONTRADICTION` must never be read as "the host told the truth". The script already avoids a PASS verdict. Keep human review mandatory, and add multilingual and paraphrase cases if it is used as evidence.

### Code-only findings

- **IR-15.** `main.ts:48-60` allows `public-readonly-demo` with `EVIDENCE_PROVIDERS=byok`/`RESEARCH_PROVIDER=channel3`. The ledger has per-request call caps only (`UsageLedger.ts:132-151`). Tavily and Channel3 have no deployment cap; KERNEL inspection has 20 sessions per process.
- **IR-16.** One static `dok_` key per user serves as the OAuth login, the mandate creator and the owner page. The only defence against guessing is the per-IP 30/min limit (guessing is infeasible for 192-bit generated keys, but operator-supplied keys need only ≥24 characters). F3: oauth mode silently falls back to `.data/dev-credentials.json`.
- **IR-17.** `/paypal/*` sits behind `paymentExecutionEnabled`, which requires a loopback base URL, so PayPal can never deliver webhooks or redirect to a public return URL. Reconciliation relies on the buyer's browser return, startup reads and manual owner reconcile. That is acceptable for C1/C2 on one machine and a gap for P.
- **IR-18.** See §9.
- **IR-19.** `KernelPageInspector.ts:43-53`:
  - DNS is checked locally, but the remote browser resolves again (rebinding);
  - IPv6 `2002::/16` (6to4) and `2001::/32` (Teredo) pass the "public" test;
  - the probed network is KERNEL's, not DIAPORIA's.
  Unverified without KERNEL.
- **IR-20.**
  - `KernelDriver.open` passes `network.allowed_hosts` and relies on KERNEL to enforce it.
  - The Live View URL is a bearer capability that lets anyone holding it take over the browser.
  - Cleanup is verified by list and DELETE.
  None of this can be verified offline. The Phase C ledger caps browser count per approval (good).
- **IR-21.** `/healthz` returns `authMode`, `paymentProvider`, `researchAdapter` and `paymentExecutionEnabled` to anyone.

### Verified as holding (no finding)

- **PKCE and codes:** PKCE S256 only. The code is single-use, with an atomic `UPDATE … used_at IS NULL`.
- **Redirect URIs:** exact match; loopback port variance only for http loopback; no fragments or userinfo.
- **Errors before client validation:** shown on the page, never redirected.
- **Resources and audience:** RFC 8707 resource is enforced at authorize, token and verify.
- **Refresh tokens:** cannot widen scope; reuse revokes the family.
- **Revocation:** scoped to the client.
- **MCP surface:**
  - tool exposure is per scope and per deployment;
  - the user id never comes from tool arguments;
  - DNS-rebinding protection is on in the SDK transport, and the Host allowlist returns 421.
- **Spending authority:**
  - mandate reservation is a single `BEGIN IMMEDIATE` with SQL guards and CHECK constraints;
  - DF-4's partial unique index blocks a second live bound mandate, even across two processes on one DB (CONTROL);
  - a CHECKOUT_BOUND mandate is never auto-selected and is revoked on release.
- **Expiry and capture timing:**
  - expiry releases only on a CAS;
  - capture is gated in a transaction after every await;
  - `capture_requested_at` is durable;
  - after expiry a capture is never sent;
  - a replay keeps UNKNOWN and keeps the reservation;
  - a VOIDED order is the only evidence that releases an uncertain capture.
- **Provider checks:** amount, currency, `custom_id` and payee are re-read from the provider before capture. The capture amount is re-read before COMPLETED.
- **Status reporting:**
  - payment completion, merchant order confirmation and fulfillment are reported as separate fields;
  - MOCK is never labelled Sandbox (DF-5 fix present);
  - UNKNOWN and FAILED are distinct, and only provider evidence moves UNKNOWN.
- **Phase C merchant:**
  - strict JSON field lists;
  - browser-supplied prices are rejected;
  - the operator bearer is checked in constant time;
  - reconcile is GET-only;
  - a capture retry needs the digest *and* the owner's Ed25519 signature;
  - creates and captures are counted in a durable ledger.

## 7. Tests executed (evidence)

| Run | Result |
|---|---|
| `npx tsc --noEmit` at 759bd37 | exit 0 |
| `npx vitest run` at 759bd37 (baseline) | **390/390 pass**, 28 files |
| `npm audit --omit=dev` | 0 vulnerabilities |
| `node scripts/secret-scan.mjs` | 213 tracked files, no findings |
| `npx vitest run tests/security-review` | **19/19 pass**: 14 ATTACK probes reproduce, 5 CONTROL probes hold |
| full suite with probes added | 409/409 pass; `tsc --noEmit` exit 0 |

Probe output (verbose), at 759bd37 plus the probe file only:

```
✓ B  ATTACK IR-01 (SR-01 re-verified) AI token + REUSABLE mandate completes a MOCK purchase with NO human step
✓ B  ATTACK IR-02 concurrent identical prepare_checkout → TWO checkouts, TWO orders, both COMPLETED
✓ B  CONTROL sequential identical prepare_checkout is deduplicated
✓ B  CONTROL two processes on ONE SQLite file: concurrent owner authorizations → exactly one
✓ B  CONTROL cross-user: Bob's token / owner key cannot read or authorize Alice's checkout
✓ B  ATTACK IR-09 (SR-05) owner-page session not bound to its checkout
✓ B  ATTACK IR-10 "60,00" → 100x limit
✓ B  CONTROL expired checkout's owner page creates no authority; revoke before capture blocks capture
✓ C  ATTACK IR-11 (SR-06) reconcile replays createOrder after expiry
✓ C  ATTACK IR-12 CRC32-only webhook body binding: forged body verifies
✓ AE ATTACK IR-03 consent phishing with look-alike client
✓ AE ATTACK IR-04 DCR cap never pruned
✓ AE ATTACK IR-05 one global web bucket behind a proxy
✓ AE ATTACK IR-06 pending-consent wipe at 5000
✓ AE ATTACK IR-07 grants survive owner-key rotation
✓ AE ATTACK IR-08 config-only payment gate + Host rewrite
✓ AE CONTROL non-loopback base URL closes every payment route; foreign Host → 421
✓ AE ATTACK IR-13 redaction gaps
✓ F  ATTACK IR-14 semantic-fidelity misses paraphrase / Korean
Tests 19 passed (19)
```

No preserved Scenario I evidence was read for writing or modified. Every database was `:memory:` or a fresh `mkdtemp` file, deleted after each test.

## 8. Gate verdicts

### Gate R: public research/read-only remote MCP: **CONDITIONAL PASS**

**Why it is not BLOCKED**
- The payment boundary on a non-loopback base URL is enforced in code and tested (CONTROL).
- The OAuth core (PKCE, audience, rotation, replay) is sound.
- No reproduced finding leaks data or creates authority on such a deployment.

**Why it is not PASS.** At 759bd37 as-is, a deployment behind any proxy can be locked out by one visitor (IR-05, IR-04). The owner key would be typed into a phishable flow (IR-03, IR-16). Grants cannot be revoked by rotation (IR-07).

**Required conditions, all of them:**
1. A separate process and entrypoint for the public instance:
   - `DIAPORIA_AUTH_MODE=oauth`, https `PUBLIC_BASE_URL`, `PAYMENT_PROVIDER=mock`;
   - started with a clean environment (`env -i`): no `*_API_KEY`, no PayPal or KERNEL variables, no `HANDOFF_DRIVER`;
   - a fresh database;
   - startup refuses a loopback base URL, live provider keys or a missing `DIAPORIA_OWNER_KEYS`.
   Covers IR-08, IR-15, IR-16/F3.
2. A fresh owner key used for nothing else. It never appears on the local spending instance (IR-16).
3. Client-IP rate limiting that trusts forwarding headers only from the configured proxy hop, plus a separate strict limit on `/oauth/register` (IR-05).
4. Registration closed to the intended host: a redirect-URI allowlist or pre-registered client, or at minimum client GC and a lower cap (IR-03, IR-04). Pending authorizations evicted by age, not wholesale (IR-06).
5. A supervised, time-boxed window. At the end, delete the deployment DB to revoke all grants, until an absolute grant lifetime and revoke-all exist (IR-07).
6. Never front a dev or loopback instance with the tunnel. No `httpHostHeader` or Host rewrite to `127.0.0.1:<port>` (IR-08).
7. A post-deploy negative check *through the public hostname*:
   - payment route families → 403;
   - `/.well-known/oauth-authorization-server` scopes = research/read;
   - foreign Host → 421;
   - `/mcp` without a token → 401 with `resource_metadata`.
8. An independent re-check of the deployment branch's diff (`infra/remote-mcp-readonly`) against conditions 1–6 before go-live. Proposed patches do not count until verified.

**Assumptions unverified until a real remote client connects:**
- the client honours RFC 9728 `resource_metadata` and sends `resource`;
- it uses PKCE S256 and a stable DCR redirect URI (that is, an allowlist will not break it);
- it refreshes correctly with rotation (reuse detection would otherwise revoke the grant);
- how it renders `structuredContent` and untrusted merchant text to the user;
- the proxy's real TLS termination and header behaviour;
- whether CORS `*` on metadata is needed or sufficient for browser-based clients.

### Gate C: isolated PayPal Sandbox merchant: **CONDITIONAL PASS for C1 preflight only. C2 capture is not authorized.**

**Conditions for C1** (popup / approval test, one order, no capture), all required:
1. AI hosts run under a different OS account or container from the one holding:
   - `DIAPORIA_OWNER_KEYS` and `.data/`;
   - PayPal Sandbox client credentials;
   - the merchant `MERCHANT_STATUS_SECRET` / operator key;
   - the owner Ed25519 signing key.
   This is IR-01. Without it the "human approved" evidence is not attributable.
2. The existing Phase C controls are used as designed:
   - Eric approves the printed C1 digest;
   - one KERNEL browser per approval (durable ledger);
   - `SANDBOX_POPUP_TEST` mode;
   - exact HTTPS host listing.
   A Gate R approval does not cover this.
3. KERNEL egress allowlisting, Live View URL handling and orphan cleanup are recorded as UNVERIFIED (IR-20) unless a bounded negative test against the real service is part of the C1 statement.
4. The DIAPORIA server stays loopback. The public merchant host is separate from any Gate R deployment and from the DIAPORIA process.

**Must be fixed before C2 (capture), in addition to the C1 conditions:**
- IR-02: atomic prepare dedup, if the DIAPORIA Sandbox provider path or REUSABLE mandates are used at all.
- IR-11: no provider write on expired or aged reconcile.
- IR-09: owner review session bound to its checkout.
- IR-10: reject ambiguous decimals and echo the parsed amount.
- IR-18: confirm from the official PayPal reference, not a mirror:
  - PayPal-Request-Id retention for create and capture;
  - the behaviour of a repeated capture on a COMPLETED order;
  - order expiry.
  Record them as documented guarantees, and keep R2 open for anything undocumented.
- IR-12: deduplicate webhooks on transmission id, if a webhook listener is configured for C2.
- IR-20: a bounded KERNEL egress negative test.
- An independent re-review of the fix diff, with the full suite and these probes updated to expect the fixed behaviour.

### Gate P: production purchasing: **BLOCKED**

**Missing controls and integrations:**
1. A real identity provider and account system, with MFA, session management, lockout and recovery, replacing static owner keys (IR-16). Grant lifetime and revoke-all (IR-07).
2. Separation of AI hosts from owner credentials by construction, not by procedure (IR-01): separate service account, HSM/KMS-held secrets, no secrets on AI-reachable disks.
3. Live PayPal integration. It is refused by construction (`PayPalCheckoutAdapter.ts` allows only the Sandbox host). It needs merchant onboarding (Partner/Commerce Platform or equivalent), payee verification against real PayPal merchant data, and jurisdiction eligibility (KR→KR PayPal restriction noted in project memory).
4. A reachable, authenticated webhook path with PayPal-side verification and transmission-id dedup (IR-12, IR-17), plus a reconciliation scheduler.
5. Real merchant identity: the KR/US business registries and PayPal recipient attestations are MOCK fixtures (`src/merchant-identity/fixtures.ts`).
6. Merchant order confirmation and fulfillment integration. Today `MERCHANT_ORDER_NOT_VERIFIED` is always reported, which is honest, but there is no order.
7. Refunds, disputes, chargebacks, partial captures and multi-currency rounding policy.
8. Production data plane: a multi-instance database (SQLite with per-process in-memory sessions, OAuth pending and rate limits does not scale), a distributed rate limiter, backups, audit-log retention and privacy.
9. Deployment isolation, secrets management, monitoring/alerting, incident response.
10. Spend controls at the deployment and user level for paid providers (IR-15). KERNEL network isolation verified (IR-19, IR-20).
11. Legal and compliance: terms, consumer protection, payments regulation, PCI scope assessment for the hosted-page model.
12. An independent penetration test of the deployed system.

Gate R or Gate C results do not imply any of these.

## 9. PayPal documentation: guarantees vs unverified

- **Documented** (Orders v2 OpenAPI reference for *capture payment for order*, read through a docs.paypal.ai mirror; developer.paypal.com was not opened from this container):
  - `PayPal-Request-Id` keys are stored for **6 hours**;
  - reusing a key retries the same request.
  - PayPal's idempotency guide recommends retrying a timed-out capture with the same header.
  - An order in CREATED state is kept for about 3 hours.
- **Consequence for DIAPORIA.** Checkout TTL is ≤ 15 min, so every *intended* create or capture replay happens inside the window. The exception is IR-11, which has no age bound.
- **Not verified here:**
  - retention for *create order* specifically;
  - whether a capture replay after the window returns `ORDER_ALREADY_CAPTURED` (expected, since an order with intent CAPTURE captures once, but I did not confirm it from an official page in this session);
  - Sandbox-vs-live differences.
  Treat all of these as UNVERIFIED until checked against developer.paypal.com and recorded in `docs/RISK_REGISTER.md` R2.

Sources:
- [Capture payment for order (Orders v2 reference mirror)](https://docs.paypal.ai/reference/api/rest/orders/capture-payment-for-order.md)
- [PayPal API idempotency](https://developer.paypal.com/api/rest/reference/idempotency/)
- [Orders v2 capture](https://developer.paypal.com/docs/api/orders/v2/orders-capture)

## 10. Residual risks after the recommended fixes

- Prompt injection that makes an AI host *mislead the user*. Server-side authority limits the damage, but cannot stop a host from misreporting. Semantic fidelity is a detector with known blind spots (IR-14).
- A user approving two PayPal pages, or approving on PayPal without reading. DIAPORIA's limit is not a PayPal-enforced cap, as the UI states.
- Single-host SQLite: a crash between the provider response and the local write. This is handled by UNKNOWN plus reconcile, and depends on PayPal's idempotency window (IR-18).
- KERNEL as a third party holding live merchant sessions (IR-20).
- Any finding marked MITIGATED later must be re-verified by flipping its ATTACK probe. A proposed patch does not change a status.
