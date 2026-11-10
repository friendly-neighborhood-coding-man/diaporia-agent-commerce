# Remediation Work Packages: Independent MVP Review (759bd37)

**Status: PLAN ONLY.** This review branch contains no fix. The implementation workstream does the remediation on its own branch. This reviewer then verifies each fix independently.

## Contents

- [Common acceptance rule](#common-acceptance-rule)
- [Priority overview](#priority-overview)
- [P0: before C2 (and IR-01 before C1)](#p0-before-c2-and-ir-01-before-c1)
- [P1: before C2](#p1-before-c2)
- [P2: Gate R](#p2-gate-r-remote-read-only)
- [P3: hygiene](#p3-hygiene-all-gates)
- [External verification](#external-verification-separate-owner-approval-each)
- [Suggested order](#suggested-order)

**Sources:**
- Findings: [`FINDINGS_REGISTER.md`](./FINDINGS_REGISTER.md).
- Gate conditions: [`INDEPENDENT_MVP_REVIEW.md`](./INDEPENDENT_MVP_REVIEW.md) §8.

## Common acceptance rule

Every work package (WP) is accepted only when all of these hold:

1. The matching **ATTACK probe in `tests/security-review/independent-probes.test.ts` fails** against the fix, because the attack no longer works. The implementer then rewrites the probe into a regression test that asserts the fixed behaviour.
2. The full suite and the 5 CONTROL probes pass. No test is weakened, skipped or deleted to get green.
3. **This reviewer verifies the fix independently** on the exact fix commit. Only after that does the register status move to MITIGATED. A proposed patch never changes a status.
4. There is no change to preserved Scenario I evidence, and no Sandbox, KERNEL, Cloudflare or deployment action without a separate owner go.

## Priority overview

The six highlighted findings are **bold**.

| Priority | WP | Findings | Severity | Gate it unblocks |
|---|---|---|---|---|
| P0 | WP-1 | **IR-01** | HIGH | C1 (operational part), C2, P |
| P0 | WP-2 | **IR-02** | MEDIUM | C2 |
| P0 | WP-3 | **IR-11** | LOW | C2 |
| P1 | WP-4 | **IR-09** | LOW | C2 |
| P1 | WP-5 | **IR-10** | LOW | C2 |
| P1 | WP-6 | **IR-12** | LOW | C2 if a webhook listener is configured; P |
| P2 | WP-7 | IR-03, IR-04, IR-05, IR-06, IR-07, IR-08, IR-15, IR-16, IR-21 | MED/LOW/INFO | R (remote profile) |
| P3 | WP-8 | IR-13, IR-14 | LOW | all (hygiene) |
| — | WP-9 | IR-17, IR-18, IR-19, IR-20 | INFO/LOW | external verification, C2/P |

## P0: before C2 (and IR-01 before C1)

### WP-1: IR-01. An AI token plus a REUSABLE mandate completes a purchase with no human step (HIGH)

**Where:**
- `src/http/server.ts:303` (unauthenticated mock approve)
- `src/http/server.ts:350` (`sameOrigin` is true when Origin is absent)
- `src/engine/CommerceGateway.ts:370-377` (automatic reservation of REUSABLE mandates)
- `src/main.ts:26-38` (owner keys in `.data/*.json`)

**Change:**
1. *Operational (C1 condition, no code):* AI hosts run under a different OS user or container from the DIAPORIA process. That user cannot read `.data/`, the Phase C signing key or Sandbox credentials, and cannot write the SQLite file.
2. Require an owner session (cookie plus CSRF) on `/mock-paypal/checkout/*/approve`. Make `sameOrigin` refuse a missing Origin on state-changing owner and mock routes.
3. REUSABLE mandates are not used automatically by `prepare_checkout` unless the owner opted that mandate in with a flag such as `autoUse`. The default is to require per-checkout owner authorization.
4. Request provenance in the audit log: whether a step came from the MCP token, an owner session or the provider return.

**Acceptance:** probe *ATTACK IR-01* fails because the bare POST approve is refused. The CONTROL probes for cross-user isolation and the two-process case still hold.

### WP-2: IR-02. Concurrent `prepare_checkout` creates duplicate purchases (MEDIUM)

**Where:** `src/engine/CommerceGateway.ts:322-356`. The in-flight and duplicate checks run before the `await` on quotes.

**Change:**
- Claim the live checkout for a purchase session atomically. Use either a `BEGIN IMMEDIATE` claim row written before any await, or a partial unique index on (purchase session, live state). The loser returns the winner's checkout with `deduplicated: true`.
- Both an in-flight and a completed duplicate must collapse.

**Acceptance:**
- *ATTACK IR-02* fails: with the 150 ms `SlowQuotes` adapter, two concurrent calls give 1 checkout, 1 `createOrder` and 1 COMPLETED.
- *CONTROL sequential* still holds.
- Add a two-process variant on one SQLite file.

### WP-3: IR-11. Owner reconcile replays `createOrder` after expiry (LOW)

**Where:**
- `src/engine/CommerceGateway.ts:432-443` (`recoverTimedOutCreate`)
- `src/engine/CommerceGateway.ts:717` (reconcile)

**Change:**
- Make no provider write when the checkout has expired, or when the create attempt is older than about 5 h. This stays below PayPal's documented 6 h default `PayPal-Request-Id` retention (IR-18, documentation only).
- In those cases, close from local evidence or leave the checkout UNKNOWN, with a reason.
- Read-only provider lookups stay allowed.

**Acceptance:** *ATTACK IR-11* fails: an expired UNKNOWN checkout causes 0 additional `createOrder` calls. The existing UNKNOWN-reconcile tests still pass.

## P1: before C2

### WP-4: IR-09. Owner review session is not bound to its checkout (LOW)

**Where:** `src/http/server.ts:219-245` (`ownerSessions`).

**Change:** store `csId` in the session at review time, and refuse authorize or cancel when the checkout id in the path differs. Optionally rotate the cookie for each checkout.

**Acceptance:** *ATTACK IR-09* fails (reviewing A and then authorizing B is refused). The two-process authorization CONTROL still holds.

### WP-5: IR-10. "60,00" becomes a 100× limit (LOW)

**Where:** `src/domain/money.ts:28`. Commas are stripped. The owner and handoff pages use this parser.

**Change:**
- Reject input with a comma, or any ambiguous grouping, on spending-limit fields.
- Show the parsed amount on a confirmation step ("You are authorizing up to USD 60.00") before the mandate is created.

**Acceptance:**
- *ATTACK IR-10* fails: `"60,00"` is rejected, never 600000.
- Add `"1,000"`, `"1.000,00"` and full-width digit cases.

### WP-6: IR-12. A webhook signature can be replayed onto a forged body (LOW)

**Where:**
- `src/payment/PayPalWebhook.ts:63`. The signed string covers only CRC32 of the body.
- Webhook deduplication in `src/engine/CommerceGateway.ts`, which is keyed on event id.

**Change:**
- Deduplicate on `PAYPAL-TRANSMISSION-ID`, and reject a reused transmission id that arrives with a different body hash.
- For any listener reachable beyond loopback, verify through PayPal `verify-webhook-signature`, or treat the event only as a hint and re-read the order. The second option is the current design and must stay.

**Acceptance:** *ATTACK IR-12* fails: a captured signature with a new body or event id is refused, or deduplicated as a replay.

## P2: Gate R (remote read-only)

### WP-7: IR-03, IR-04, IR-05, IR-06, IR-07, IR-08, IR-15, IR-16, IR-21

Branch `infra/remote-mcp-readonly` at `0d9b931` already implements most of these for the **remote profile**. The reviewer's re-check is `GATE_R_RECHECK.md` (project files, `agent-commerce-mvp/independent-review-759bd37/gate-r-recheck-0d9b931/`): CONDITIONAL PASS stands. That work remains in the infra workstream.

Open items:

| Finding | Open item | Severity |
|---|---|---|
| IR-03 residual | Shared-callback consent phishing. Needs a user briefing plus consent-page text now; CIMD or pre-registered clients for Gate P. | MEDIUM |
| IR-07 residual | Key rotation must set `DIAPORIA_REVOKE_ALL_GRANTS_ON_START=1`, or grants must be bound to a key fingerprint. | — |
| IR-05 residual | The Cloudflare-proxied mode needs a trusted-proxy configuration, or DNS-only. | — |
| IR-06 residual | Age eviction can still be pushed by a flood. Add a per-client and per-IP pending cap. | LOW |
| IR-16 residual | Add an entropy check on remote keys. | LOW |
| IR-21 residual | Return `{ok:true}` from the app itself. | — |
| Local profile (`src/main.ts`) | Unchanged by design. IR-07 (revoke-all) and IR-16 (explicit keys) still apply there. | — |

## P3: hygiene (all gates)

### WP-8: IR-13 redaction, IR-14 semantic fidelity

- **IR-13**
  - Where: `src/security/redact.ts:2-6`.
  - Change: add a generic `[A-Za-z0-9_-]{16,}` tail pattern after the known prefixes, plus the `dat_`, `drt_`, `dac_` and `dcs_` prefixes.
  - Acceptance: *ATTACK IR-13* fails.
- **IR-14**
  - Where: `scripts/interop/semantic-fidelity.mjs`.
  - Change: keep the "detection-only, human review mandatory" label. Add a paraphrase and multilingual corpus (including Korean) and track recall on it. No PASS claim may rest on this score alone.
  - Acceptance: *ATTACK IR-14* fails only if the corpus cases are detected. Otherwise the probe stays, documented as a known limitation.

## External verification (separate owner approval each)

### WP-9: IR-18, IR-20, IR-19, IR-17

- **IR-18**
  - Documented (owner check, 2026-11-10): the default `PayPal-Request-Id` retention is 6 h for Create Order and Capture Order.
  - Remaining: a bounded Sandbox test of a capture replay on a COMPLETED order, and of a replay inside the window. This needs a separate go and its own digest.
- **IR-20:** a bounded KERNEL negative egress test (`network.allowed_hosts`), plus checks of Live View URL secrecy and cleanup. Needs a separate go, because it is a paid call.
- **IR-19:** keep KERNEL inspection off in public modes, and tighten the IPv6 6to4 and Teredo ranges. Code change, P2.
- **IR-17:** accept for C1 and C2 on one host. Gate P needs a reachable, verified listener (see WP-6).

## Suggested order

1. **WP-1 (operational part)** before C1.
2. **WP-2, then WP-3, then WP-4 and WP-5** as one C2 fix batch (small diffs, each with its probe flip).
3. **WP-6**, if C2 uses webhooks.
4. **WP-9 (IR-18 Sandbox test)** as the last step before the C2 go.
5. The reviewer then re-reviews the whole C2 fix diff (Gate C condition) before any capture.
