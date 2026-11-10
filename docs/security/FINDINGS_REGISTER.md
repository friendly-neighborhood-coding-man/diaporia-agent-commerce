# Findings Register: Independent MVP Review

**Target:** `759bd37b0ad254f414fd61b9a009631c026f97f5` (draft PR #9). **Report:** [`INDEPENDENT_MVP_REVIEW.md`](./INDEPENDENT_MVP_REVIEW.md). **Probes:** `tests/security-review/independent-probes.test.ts`.

## How to read this register

**Severity:** CRITICAL, HIGH, MEDIUM, LOW or INFORMATIONAL.

**Status:**

| Status | Meaning |
|---|---|
| CONFIRMED | The defect is certain from reading the code. |
| REPRODUCED | A local probe demonstrates it. |
| MITIGATED | A fix has been independently verified: the ATTACK probe now fails and the regression suite passes. |
| NOT_REPRODUCED | An attempt was made and the defect did not appear. |
| UNVERIFIED | The finding needs an external service or more evidence. |

**Probes:** a passing ATTACK probe means the vulnerability is REPRODUCED. It does not mean the vulnerability is mitigated. All 14 ATTACK probes pass today, which means 14 open vulnerabilities. See [`REMEDIATION_WORK_PACKAGES.md`](./REMEDIATION_WORK_PACKAGES.md) for the fix plan.

**Rules for updating:**
- A proposed patch never changes a status.
- Only a verified flip of the probe moves a finding to MITIGATED.
- "Gate" lists the gates that the finding blocks or conditions: R = remote read-only, C = Sandbox, P = production.

## Register

| ID | Severity | Status | Gate | Location | Summary | Probe | Prior ref | Recommended remediation |
|---|---|---|---|---|---|---|---|---|
| IR-01 | HIGH | REPRODUCED | C, P | `src/http/server.ts:303,350`; `src/engine/CommerceGateway.ts:370-377`; `src/main.ts:26-38` | AI token plus an existing REUSABLE mandate completes a MOCK purchase. The mock approve needs no credential. An AI host running as the same OS user can read owner keys and other secrets and can write SQLite. | ATTACK IR-01 | SR-01 | Separate the OS user or container from AI hosts. Owner session on mock approve. Request provenance in the audit log. Opt-in for automatic use of REUSABLE mandates. |
| IR-02 | MEDIUM | REPRODUCED | C, P | `src/engine/CommerceGateway.ts:322-356` | The in-flight and duplicate checks run before awaits. Concurrent identical `prepare_checkout` calls produce 2 checkouts, 2 orders and 2 COMPLETED. The mandate ceiling still holds. | ATTACK IR-02 (+ CONTROL sequential) | new | Atomic claim in `BEGIN IMMEDIATE`, or a partial unique index on the live checkout per purchase session. |
| IR-03 | MEDIUM | REPRODUCED | R | `src/auth/oauth.ts:141-166,219`; `src/http/server.ts:411-421` | Open DCR with any name and any https redirect, plus consent by owner key, allows consent phishing. | ATTACK IR-03 | SR-03 (part) | Redirect allowlist or a pre-registered client for a restricted deployment. A deployment-specific credential. |
| IR-04 | MEDIUM | REPRODUCED | R | `src/auth/oauth.ts:156-157` | The DCR cap (1000) is never pruned, so registration is denied permanently once reached. | ATTACK IR-04 | SR-04, F4 | Client GC, a separate register rate limit, or a closed allowlist. |
| IR-05 | MEDIUM | REPRODUCED (simulated proxy) | R | `src/http/server.ts:101,130`; `src/http/rateLimit.ts` | Rate limits key on the socket IP. Behind a proxy one 30/min bucket covers everyone, so OAuth can be denied for all users. | ATTACK IR-05 | F1, SR-02 (part) | Client IP from the trusted proxy hop only. Per-route limits. |
| IR-06 | LOW | REPRODUCED | R | `src/auth/oauth.ts:345-349` | More than 5000 pending authorizations clears every legitimate pending consent. | ATTACK IR-06 | SR-04 (part) | Evict by age (LRU). Cap per client and IP. |
| IR-07 | MEDIUM | REPRODUCED | R, C, P | `src/auth/oauth.ts:312-317,336-343` | OAuth grants survive owner-key rotation. Refresh tokens slide 30 days on every use, giving indefinite life. There is no revoke-all operation. | ATTACK IR-07 | new | Absolute family lifetime. Owner revoke-all. Bind grants to a key fingerprint. Delete the DB at the end of a time-boxed deployment. |
| IR-08 | MEDIUM | REPRODUCED (simulated proxy) | R | `src/http/server.ts:70,86,160` | The payment gate is decided from configuration only. A proxy that rewrites Host to `127.0.0.1:<port>` exposes owner and mock-payment routes. | ATTACK IR-08 + CONTROL | SR-02, F2 | Dedicated remote entrypoint that refuses a loopback base URL. Refuse payment routes when forwarding headers are present. |
| IR-09 | LOW | REPRODUCED | C | `src/http/server.ts:219-245` | The `/authorize` review session is not bound to the reviewed checkout: reviewing A allows authorizing B. | ATTACK IR-09 | SR-05 | Store `csId` in the session and check it. |
| IR-10 | LOW | REPRODUCED | C | `src/domain/money.ts:28` | `"60,00"` parses as 600000 minor units (100× the intended limit) on the owner and handoff pages. | ATTACK IR-10 | new | Reject ambiguous commas. Echo the parsed amount for confirmation. |
| IR-11 | LOW | REPRODUCED (MOCK) | C | `src/engine/CommerceGateway.ts:432-443,717` | Owner reconcile replays `createOrder` after expiry with no age bound, possibly beyond PayPal's 6 h key retention. | ATTACK IR-11 | SR-06 | Skip the replay when expired or older than about 5 h. Close from local evidence or leave UNKNOWN. |
| IR-12 | LOW | REPRODUCED (own RSA key) | C, P | `src/payment/PayPalWebhook.ts:63`; `src/engine/CommerceGateway.ts` (webhook dedup on event id) | The signature covers only CRC32(body), so a captured signature verifies a forged body (new event id, capture or type). Impact is low because events only trigger reads and the route is loopback-only. | ATTACK IR-12 | new | Deduplicate on transmission id. Use PayPal `verify-webhook-signature` for any reachable listener. |
| IR-13 | LOW | REPRODUCED | all | `src/security/redact.ts:2-6` | Redaction misses the tails of base64url owner and dev keys and every OAuth token shape. | ATTACK IR-13 | SR-07 | Pattern `[A-Za-z0-9_-]{16,}`. Add `dat_`, `drt_`, `dac_` and `dcs_`. |
| IR-14 | LOW | REPRODUCED | all | `scripts/interop/semantic-fidelity.mjs:27-60` | The regex-based English rules miss paraphrased and Korean false claims (scored NO_CONTRADICTION). | ATTACK IR-14 | new | Keep it labelled detection-only with mandatory human review. Add a multilingual and paraphrase corpus. |
| IR-15 | MEDIUM | CONFIRMED (code) | R | `src/main.ts:48-60`; `src/metering/UsageLedger.ts:132-151` | Anonymous or public mode with live BYOK keys has per-request caps only. There is no deployment-wide cap for Tavily or Channel3. | — | SR-04 | Refuse live providers in public modes, or add a fail-closed deployment budget. |
| IR-16 | MEDIUM | CONFIRMED (code) | R, C | `src/auth/devAuth.ts:42-46`; `src/auth/oauth.ts:219`; `src/main.ts:26-38` | A single static owner key is the OAuth login, the mandate creator and the owner-page credential. There is only a per-IP limit. Oauth mode silently reuses `.data/dev-credentials.json`. | (SR-03 P5) | SR-03, F3, F5 | Separate credential per deployment. Startup refusal without explicit keys. A real IdP for Gate P. |
| IR-17 | INFO | CONFIRMED (code) | C, P | `src/http/server.ts:70,160,268-292` | PayPal webhook and return routes exist only with a loopback base URL, so PayPal can never push in any supported configuration. | — | new | Accept for C1/C2 on one host. Gate P needs a reachable, verified listener. |
| IR-18 | INFO | UNVERIFIED (docs partially verified 2026-11-10) | C, P | `src/payment/PayPalCheckoutAdapter.ts:179-236` | **Documented (owner check of official developer.paypal.com pages, 2026-11-10):** the default PayPal-Request-Id retention is 6 h for both Create Order and Capture Order, and can be extended via an Account Manager. **Still unverified:** actual Sandbox replay behaviour and the capture-once guarantee. | — | RISK_REGISTER R2 | Before C2, verify the capture-once and replay behaviour in a bounded Sandbox test (separate go). Record the 6 h default as a documented guarantee and keep R2 open for behaviour. |
| IR-19 | LOW | UNVERIFIED | R (if KERNEL on) | `src/evidence/KernelPageInspector.ts:43-67` | The SSRF filter is checked locally while the remote browser resolves again (DNS rebinding). IPv6 6to4 and Teredo ranges pass as public. The target network is KERNEL's. | — | new | Keep KERNEL inspection off in public modes. Tighten the IPv6 ranges. Rely on KERNEL egress policy, once verified. |
| IR-20 | INFO | UNVERIFIED | C | `src/handoff/drivers.ts:274-349`; `src/handoff/http.ts:90-108` | KERNEL `network.allowed_hosts` enforcement, Live View URL secrecy (a bearer capability) and cleanup guarantees all need the real service. | — | Phase C memory ("KERNEL proxy v3 verification") | Run a bounded negative egress test as part of the C1 statement. |
| IR-21 | INFO | CONFIRMED (code) | R | `src/http/server.ts:104` | `/healthz` discloses the auth mode, payment provider, research adapter and payment flag. | — | new | Return only `{ok:true}` publicly. |

## Controls verified as holding

| Control | Probe | Result |
|---|---|---|
| Cross-user isolation (MCP token, owner key, owner page) | CONTROL cross-user | held |
| Owner-page authorization is atomic across two processes on one SQLite file | CONTROL two processes | held (303 + 409, one mandate) |
| An expired checkout creates no authority. Revoking a reusable mandate before capture blocks the capture | CONTROL expired / revoke | held (409; FAILED, 0 captures) |
| A non-loopback base URL closes all payment route families. `purchase.prepare` is not offered. A foreign Host gets 421 | CONTROL non-loopback | held |
| Sequential duplicate `prepare_checkout` is deduplicated | CONTROL sequential | held |

## Correspondence with the previous review (cce2237) and remote-thread findings

| Prior | This register |
|---|---|
| SR-01 | IR-01 (agree, HIGH) |
| SR-02 / F2 | IR-08 (agree, MEDIUM) |
| SR-03 / F5 | IR-16, IR-03 (agree) |
| SR-04 / F4 | IR-04, IR-06, IR-15 (agree) |
| SR-05 | IR-09 |
| SR-06 | IR-11 |
| SR-07 | IR-13 |
| F1 | IR-05 |
| F3 | IR-16 |
| SR-08 | not re-tested (robustness) |
| SR-09 | partly IR-12/IR-19 |

New in this review: IR-02, IR-07, IR-10, IR-12, IR-14, IR-17, IR-21.
