# Remote MCP (research/read only): security gates and owner approvals

Status on 2026-11-10, branch `infra/remote-mcp-readonly` (base `759bd37`): gate A0 approved and done for `0d9b931` (draft PR #11); the hardening commit on top of it is **READY_FOR_OWNER_APPROVAL (push only)** and needs a fresh Gate R re-check. Nothing has been deployed. No server, DNS record, Cloudflare setting, certificate, OAuth client on a real host, or paid provider call exists for this work.

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
| `/healthz` | internal only (container health check) | Caddy allowlist, and the app answers it only to a loopback peer (`healthzLoopbackOnly`) | LOCAL_VERIFIED (HTTPS emulation: 404 from the Caddy container) |
| OAuth client registration | closed: operator-registered confidential clients only | no `registration_endpoint` in metadata, `/oauth/register` answers 403 and is not forwarded by Caddy | LOCAL_VERIFIED |
| The app container | reachable only from Caddy | `backend` network is `internal: true`, app not published | LOCAL_VERIFIED (real-Caddy edge test) |

There is no flag, scope, route or header that turns a payment capability on in this profile. The local payment-capable server is a different entrypoint (`src/main.ts`) and works only on loopback.

## 2. Security review dependency (Gate R)

The independent review of `759bd37` (`/mnt/project-files/agent-commerce-mvp/independent-review-759bd37/`, INDEPENDENT_MVP_REVIEW.md §8) is a **required, separate gate**. Its verdict for the remote read-only surface is CONDITIONAL PASS, and the conditions must be re-checked independently against this branch's diff. This branch does not declare itself safe.

| Review item | Condition | What this branch does | Status |
|---|---|---|---|
| IR-05 (F1) rate limit keyed on proxy IP | client IP only from the trusted proxy hop | Caddy sends exactly one address (`X-Forwarded-For {client_ip}`) and strips CF-Connecting-IP, True-Client-IP, X-Real-IP, Forwarded; the app trusts it only from Caddy's fixed backend address. Edge mode `direct`: `{client_ip}` = TCP peer. Edge mode `cloudflare`: CF-Connecting-IP only from a peer inside the generated Cloudflare ranges **and** holding an origin-pull client certificate (mTLS required) | IMPLEMENTED, LOCAL_VERIFIED with the real Caddyfile (`deploy/remote-mcp/test/edge-check.sh`, IPv4); IPv6 transport BLOCKED here; needs re-check |
| IR-08 (F2) config-derived payment gate | refuse loopback base URL; no Host rewrite to loopback | startup refuses loopback/wildcard/IP-literal/http base URLs; `strictHost` refuses `127.0.0.1:PORT`/`localhost:PORT` Host and Origin; Caddy forwards the original Host | IMPLEMENTED, LOCAL_VERIFIED; needs re-check |
| IR-16 (F3/F5) owner-key fallback and reuse | explicit keys; deployment-only key | `DIAPORIA_OWNER_KEYS` required, no file fallback; keys must be exactly `drk_` + 43 base64url characters (local `dok_` keys refused); secret scan rule for `drk_` | IMPLEMENTED, LOCAL_VERIFIED; needs re-check |
| IR-04 (F4) open DCR exhaustion | redirect allowlist or pre-registered client, or client GC | **dynamic registration is closed** in the remote profile; clients come only from `DIAPORIA_OAUTH_CLIENTS` (secret stored as sha256); startup deletes any other client row | IMPLEMENTED, LOCAL_VERIFIED; needs re-check |
| IR-03 consent phishing via look-alike client (Gate R b) | a familiar name plus an allowed shared callback must not yield a token | each client is confidential (`client_secret_basic`/`_post`) and **bound to one user**; the token endpoint needs the secret, so a code obtained with a copied client id is useless; another user's key cannot approve; the consent page says "registered by this server's operator for account X only" | IMPLEMENTED, LOCAL_VERIFIED (harness step 3/5 phishing simulation); needs re-check |
| IR-06 pending map wiped at 5000 | evict by age | oldest-first eviction (all deployments); remote cap 500 | IMPLEMENTED, unit-tested; needs re-check |
| IR-07 grants survive key rotation, refresh slides forever (Gate R c, g) | fail closed on rotation; time-boxed window; fresh DB | every code and token records the sha256 fingerprint of the owner key that approved it; a token whose key is no longer configured fails at once (access, refresh, code exchange), and startup persistently revokes it, so a rollback to the old key or a restored backup cannot revive it; absolute grant age (default 24 h); grants of removed users and of removed clients revoked; `scripts/remote/preflight.mjs` refuses a first deployment onto an existing `app-data` volume | IMPLEMENTED, LOCAL_VERIFIED (unit tests, harness step 15); needs re-check |
| IR-15 live provider keys | keep off | entrypoint never builds live providers; their variables are refused | IMPLEMENTED, LOCAL_VERIFIED |
| IR-21 `/healthz` disclosure | keep internal | not forwarded by Caddy | IMPLEMENTED, LOCAL_VERIFIED |

### Gate R re-check of `0d9b931`: residuals and what changed

| Residual | Change | Evidence | Status |
|---|---|---|---|
| (a) Cloudflare-proxied mode collapses users onto Cloudflare edge IPs | edge modes; `cloudflare` trusts CF-Connecting-IP only from generated official ranges plus mandatory Authenticated Origin Pulls; ports published on IPv4 only so Docker's userland proxy never relays IPv6 clients from one address | edge test: distinct identities, spoofed headers ignored from untrusted peers, no client cert / rogue CA refused | IMPLEMENTED, LOCAL_VERIFIED (IPv4); Cloudflare ranges not retrievable here (network policy), generated at A2 |
| (b) shared-callback phishing | pre-registered confidential clients bound to one user | harness step 3 and 5, unit tests | IMPLEMENTED, LOCAL_VERIFIED |
| (c) rotation without revoke-all keeps grants | owner-key fingerprint binding | unit tests (restart, rollback), harness step 15 | IMPLEMENTED, LOCAL_VERIFIED |
| (d) pending flood evicts the oldest consent (LOW) | unchanged; with registration closed, a flood needs a valid client id and stays rate-limited per client address | — | ACCEPTED RISK (LOW) |
| (e) owner key check is length-only (LOW) | exact format `drk_` + 43 base64url | unit tests | IMPLEMENTED, LOCAL_VERIFIED |
| (f) `/healthz` hidden only by Caddy | the app answers it only to loopback; app on an internal network | HTTPS check (404 from the Caddy container), edge test (backend unreachable) | IMPLEMENTED, LOCAL_VERIFIED |
| (g) compose volume persists into A3 | preflight refuses an existing `app-data` volume unless `--redeploy` | preflight run locally | IMPLEMENTED, LOCAL_VERIFIED (script), not run on a server |

Not addressed by code here, and stated as limitations:

- **Owner key is not an identity provider.** Each human gets a remote-only key typed into the DIAPORIA consent page in their own browser; the AI host never sees it. There is no account recovery, MFA, lockout or per-user self-service. Acceptable for a supervised research window with named test users; **an IdP is required before open public sign-up** (BLOCKED: external dependency, not chosen).
- **No CIMD and no DCR** in the remote profile. Each host is connected with an operator-registered client ("use your own OAuth client" in Claude); a host that supports only DCR or CIMD cannot connect. See REMOTE_HOST_COMPATIBILITY.md.
- **IPv6 transport not verified** (this environment has no IPv6). Publish an A record only; `compose.ipv6.yaml` is optional and unverified.
- **Cloudflare mode depends on the owner** generating the ranges file and a per-hostname origin-pull certificate at A2; the shared zone-level origin-pull certificate would let any Cloudflare customer's traffic pass the mTLS check (it would still not get a trusted client address unless it comes from Cloudflare's ranges).
- **Single process.** Rate limits and pending consents are in memory; one app container only.

## 2a. Isolation from Phase C and the local payment server

| Boundary | How it holds | Checked by |
|---|---|---|
| Process / code path | separate entrypoint `src/remote/main.ts`; payment execution needs a loopback base URL, which the remote startup check refuses | harness startup refusals, invariant check after start |
| Data | own SQLite files on the `app-data` volume; `:memory:` and relative paths refused; first deployment needs a fresh volume | startup check, preflight |
| Credentials | `drk_` keys only (local `dok_` refused); `PAYPAL_*`, `HANDOFF_*`, `KERNEL_*`, `MERCHANT_*`, `MANAGED_*`, Tavily/Channel3 variables refused; secrets file may hold only owner keys and hashed client secrets | startup check, preflight |
| Network | app on an internal network, reachable only from Caddy; Caddy forwards only the allowlist and only for `MCP_HOSTNAME` | edge test |
| Hostname / infrastructure | preflight refuses `diaporia.com`, `bot.diaporia.com`, `phase-c.diaporia.com`; one new record only; no tunnel, WAF or zone-wide change; a server separate from the owner's PC | preflight, gate A1/A2 checklist |

## 3. Requirements before any public exposure

All must hold. Local test success alone never satisfies this list.

- [ ] Gate R re-check of this branch's diff: no unresolved CRITICAL/HIGH finding on the deployed surface, every deployment-blocking finding resolved.
- [ ] Authentication and authorization regression tests pass (`npm test`, includes `tests/oauth.test.ts`, `tests/remote-readonly.test.ts`).
- [ ] `npm run remote:validate`, `npm run remote:validate:https` and `npm run remote:edge-check` PASS on the exact commit.
- [ ] `node scripts/remote/preflight.mjs` OK on the server before the first `up`; `scripts/remote/manifest.mjs` output reviewed after it.
- [ ] Negative-test checklist (REMOTE_MCP_NEGATIVE_TESTS.md) run against the public host at A3, all refusals observed.
- [ ] Secret scan and gitleaks clean; CI green on the pushed commit.
- [ ] Reviewed deployment manifest: commit SHA, image digest, startup `configDigest`, hostname, TLS mode, allowlist, users, window end time.
- [ ] Owner approval of that exact destination and configuration (gates below).

## 4. Owner approval checklist (one approval per gate, in order)

Each gate is a separate, explicit owner decision naming the exact values. Approving one gate never approves the next. Every step is written as a proposed command; none has been run.

| Gate | Operation | Owner must approve exactly | Reversal |
|---|---|---|---|
| A0 | Push branch `infra/remote-mcp-readonly` and open a draft PR | the commit SHA and diff digest | delete branch/PR |
| A1 | **Provision one isolated server** | provider, region, size, monthly cost cap, OS image, SSH key fingerprint, firewall rules (22 from owner IP only, 80/443 in) | destroy the server |
| A2 | **Create a DNS record** | exact record (e.g. `mcp.diaporia.com A <ip>`, no AAAA), DNS-only (`CADDY_EDGE=direct`) or proxied (`cloudflare`: also the ranges file, Origin CA cert, per-hostname Authenticated Origin Pulls for this hostname only), TTL; confirm `diaporia.com`, `bot.diaporia.com`, `phase-c.diaporia.com`, tunnels and WAF rules are untouched | delete that one record |
| A3 | **Deploy the read-only service, OAuth closed** | commit SHA, image digest, `.env` values, `configDigest`, the OAuth clients (id, user, redirect; `npm run remote:oauth-client`); preflight OK; manifest reviewed; owner keys loaded but no remote host connected yet; negative tests from the owner's machine | `docker compose down` (rollback doc) |
| A4 | **Enable remote OAuth authorization** for a time-boxed window | window start/end (UTC), test users, `DIAPORIA_GRANT_MAX_AGE_SEC`, redirect allowlist; brief each user on the consent page (it must name the operator-registered client and their own account) | stop the app, remove or rotate the user's key (revokes their grants), or `DIAPORIA_REVOKE_ALL_GRANTS_ON_START=1` |
| A5 | **Connect one real remote AI client** | which host (one), account/plan used, the test script in REMOTE_HOST_COMPATIBILITY.md §5 | remove the connector in the host; revoke grants |
| A6 | **Paid research-provider calls** (separate, not part of this release) | provider, per-request and monthly caps, keys stored where; needs a code change (the remote entrypoint has no live providers) | remove keys, redeploy |

Notes: A3 and A4 may be approved together only if the owner says so explicitly. Making the server reachable at all (A2+A3) already exposes `/.well-known/*` and the consent page, so A3 should run inside the A4 window or with Caddy stopped between checks.
