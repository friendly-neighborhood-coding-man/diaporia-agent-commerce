# Remote MCP (research/read only): security gates and owner approvals

Status on 2026-11-10, branch `infra/remote-mcp-readonly` (base `759bd37`): **READY_FOR_OWNER_APPROVAL for gate A0 only.** Nothing has been deployed. No server, DNS record, Cloudflare setting, certificate, OAuth client on a real host, or paid provider call exists for this work.

Status words: IMPLEMENTED (code exists) · LOCAL_VERIFIED (passed offline here) · READY_FOR_OWNER_APPROVAL · BLOCKED · REMOTE_VERIFIED (only after a real remote AI host connects). Local tests are never reported as remote-host verification.

## 1. What the public surface is

| Capability | Remote profile | How it is enforced | Status |
|---|---|---|---|
| `research_purchase`, `compare_purchase_offers`, `get_checkout_status`, `get_purchase_receipt`, `get_usage_summary` | offered, OAuth bearer with `purchase.research`/`purchase.read` | MCP adapter registers payment tools only when payment execution is on | IMPLEMENTED, LOCAL_VERIFIED |
| `prepare_checkout`, `prepare_browser_checkout`, any capture/buy tool | absent ("tool not found") | `paymentExecutionEnabled` is false for any non-loopback base URL; the entrypoint refuses loopback base URLs | LOCAL_VERIFIED |
| `purchase.prepare` scope | not offered, not grantable, not reachable by refresh | `offeredScopes` = research + read; invariant checked after start | LOCAL_VERIFIED |
| Mandate creation, owner approvals, cancel/reconcile, `/authorize/*` | closed | Caddy path allowlist (404) and app (403) | LOCAL_VERIFIED |
| PayPal return/webhook, MOCK PayPal pages | closed | same | LOCAL_VERIFIED |
| Browser checkout takeover (`/handoff/*`) | closed; no handoff object is built | entrypoint never passes a handoff config; `HANDOFF_*` refused | LOCAL_VERIFIED |
| Managed billing (`/billing/*`) | closed; community mode, no billing provider | `MANAGED_*`, `DIAPORIA_DEPLOYMENT_MODE` refused | LOCAL_VERIFIED |
| Operator administration | does not exist in this service; `/operator/*` 404 at Caddy | — | LOCAL_VERIFIED |
| `/healthz` | internal only (container health check) | Caddy allowlist | LOCAL_VERIFIED (HTTPS emulation) |

There is no flag, scope, route or header that turns a payment capability on in this profile. The local payment-capable server is a different entrypoint (`src/main.ts`) and works only on loopback.

## 2. Security review dependency (Gate R)

The independent review of `759bd37` (`/mnt/project-files/agent-commerce-mvp/independent-review-759bd37/`, INDEPENDENT_MVP_REVIEW.md §8) is a **required, separate gate**. Its verdict for the remote read-only surface is CONDITIONAL PASS, and the conditions must be re-checked independently against this branch's diff. This branch does not declare itself safe.

| Review item | Condition | What this branch does | Status |
|---|---|---|---|
| IR-05 (F1) rate limit keyed on proxy IP | client IP only from the trusted proxy hop; stricter limit on `/oauth/register` | `trustedProxies` + `clientIp()` (last X-Forwarded-For hop, only from Caddy's fixed address); `/oauth/register` limited to 10/hour per client | IMPLEMENTED, LOCAL_VERIFIED; needs re-check |
| IR-08 (F2) config-derived payment gate | refuse loopback base URL; no Host rewrite to loopback | startup refuses loopback/wildcard/IP-literal/http base URLs; `strictHost` refuses `127.0.0.1:PORT`/`localhost:PORT` Host and Origin; Caddy forwards the original Host | IMPLEMENTED, LOCAL_VERIFIED; needs re-check |
| IR-16 (F3/F5) owner-key fallback and reuse | explicit keys; deployment-only key | `DIAPORIA_OWNER_KEYS` required, no file fallback; keys must be `drk_` + 43 random characters (local `dok_` keys refused); secret scan rule for `drk_` | IMPLEMENTED, LOCAL_VERIFIED; needs re-check |
| IR-04 (F4) open DCR exhaustion | redirect allowlist or pre-registered client, or client GC | redirect allowlist (Claude, ChatGPT callbacks, loopback); registration limit; hourly prune of unused clients and dead grants; client cap 200 | IMPLEMENTED, LOCAL_VERIFIED; needs re-check |
| IR-03 consent phishing via look-alike client | same allowlist | a code can only be delivered to an allowlisted host callback or the user's own loopback | IMPLEMENTED, LOCAL_VERIFIED; needs re-check |
| IR-06 pending map wiped at 5000 | evict by age | oldest-first eviction (all deployments); remote cap 500 | IMPLEMENTED, unit-tested; needs re-check |
| IR-07 grants survive key rotation, refresh slides forever | time-boxed window, delete DB at end | absolute grant age (default 24 h, rotation never extends it); startup revokes grants of removed users; `DIAPORIA_REVOKE_ALL_GRANTS_ON_START=1` for rotation; teardown deletes the volume | IMPLEMENTED, unit/local verified; needs re-check |
| IR-15 live provider keys | keep off | entrypoint never builds live providers; their variables are refused | IMPLEMENTED, LOCAL_VERIFIED |
| IR-21 `/healthz` disclosure | keep internal | not forwarded by Caddy | IMPLEMENTED, LOCAL_VERIFIED |

Not addressed by code here, and stated as limitations:

- **Owner key is not an identity provider.** Each human gets a remote-only key typed into the DIAPORIA consent page in their own browser; the AI host never sees it. There is no account recovery, MFA, lockout or per-user self-service. Acceptable for a supervised research window with named test users; **an IdP is required before open public sign-up** (BLOCKED: external dependency, not chosen).
- **No CIMD** (Client ID Metadata Documents, a SHOULD in MCP 2025-11-25). Claude and ChatGPT fall back to DCR; see REMOTE_HOST_COMPATIBILITY.md.
- **Single process.** Rate limits and pending consents are in memory; one app container only.

## 3. Requirements before any public exposure

All must hold. Local test success alone never satisfies this list.

- [ ] Gate R re-check of this branch's diff: no unresolved CRITICAL/HIGH finding on the deployed surface, every deployment-blocking finding resolved.
- [ ] Authentication and authorization regression tests pass (`npm test`, includes `tests/oauth.test.ts`, `tests/remote-readonly.test.ts`).
- [ ] `npm run remote:validate` PASS and `npm run remote:validate:https` PASS on the exact commit.
- [ ] Secret scan and gitleaks clean; CI green on the pushed commit.
- [ ] Reviewed deployment manifest: commit SHA, image digest, startup `configDigest`, hostname, TLS mode, allowlist, users, window end time.
- [ ] Owner approval of that exact destination and configuration (gates below).

## 4. Owner approval checklist (one approval per gate, in order)

Each gate is a separate, explicit owner decision naming the exact values. Approving one gate never approves the next. Every step is written as a proposed command; none has been run.

| Gate | Operation | Owner must approve exactly | Reversal |
|---|---|---|---|
| A0 | Push branch `infra/remote-mcp-readonly` and open a draft PR | the commit SHA and diff digest | delete branch/PR |
| A1 | **Provision one isolated server** | provider, region, size, monthly cost cap, OS image, SSH key fingerprint, firewall rules (22 from owner IP only, 80/443 in) | destroy the server |
| A2 | **Create a DNS record** | exact record (e.g. `mcp.diaporia.com A <ip>`), DNS-only or proxied, TTL; confirm `diaporia.com`, `bot.diaporia.com`, `phase-c.diaporia.com`, tunnels and WAF rules are untouched | delete that one record |
| A3 | **Deploy the read-only service, OAuth closed** | commit SHA, image digest, `.env` values, `configDigest`; owner keys loaded but no remote host connected yet; run the public preflight (`npm run remote:validate -- --https https://<host> --keys-file …` from the owner's machine) | `docker compose down` (rollback doc) |
| A4 | **Enable remote OAuth authorization** for a time-boxed window | window start/end (UTC), test users, `DIAPORIA_GRANT_MAX_AGE_SEC`, redirect allowlist | stop the app or set `DIAPORIA_REVOKE_ALL_GRANTS_ON_START=1` and restart |
| A5 | **Connect one real remote AI client** | which host (one), account/plan used, the test script in REMOTE_HOST_COMPATIBILITY.md §5 | remove the connector in the host; revoke grants |
| A6 | **Paid research-provider calls** (separate, not part of this release) | provider, per-request and monthly caps, keys stored where; needs a code change (the remote entrypoint has no live providers) | remove keys, redeploy |

Notes: A3 and A4 may be approved together only if the owner says so explicitly. Making the server reachable at all (A2+A3) already exposes `/.well-known/*` and the consent page, so A3 should run inside the A4 window or with Caddy stopped between checks.
