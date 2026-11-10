# Remote MCP deployment runbook (research/read only)

**Status: PREPARED, NOT EXECUTED.** Every external step below is a *proposed* command for a later, separately approved gate (REMOTE_MCP_SECURITY_GATES.md §4). Do not run any of them without the owner's approval of that gate.

Architecture:

```
Remote AI host ──HTTPS──▶ Caddy (TLS, path allowlist, body limit, HSTS, log redaction)
                           │ only /mcp, /oauth/{authorize,token,revoke}, /.well-known/oauth-*
                           │ exactly one client address upstream (X-Forwarded-For {client_ip})
                           ▼  backend network (internal: true; app not published)
                         app: node dist/src/remote/main.js  (remote-readonly profile)
                           OAuth 2.1 AS + MCP resource server, research/read tools, MOCK fixtures
                           SQLite on volume app-data (/data)
```

Files: `deploy/remote-mcp/` (Dockerfile, compose.yaml, compose.ipv6.yaml (optional, unverified), Caddyfile, edge/*.caddy, .env.example, healthcheck.mjs, local-https-check.sh, test/edge-check.sh). Code: `src/remote/` (startup check, app builder, audit log). Scripts: `scripts/remote/` (owner-key, oauth-client, cloudflare-ips, preflight, manifest, validate).

Independence: the service shares no process, database, key or hostname with the local Phase C merchant, `diaporia.com`, `bot.diaporia.com`, `phase-c.diaporia.com` or any existing Cloudflare tunnel.

## 0. Before anything external

```bash
npm ci && npm run typecheck && npm test && npm run scan:secrets
npm run remote:validate            # local integration, emulated proxy (no Docker)
npm run remote:validate:https      # Docker: Caddy internal CA + app on 127.0.0.1:8443
npm run remote:edge-check          # Docker: the real Caddyfile in direct and cloudflare edge modes, stub upstream
```

Record the commit SHA and the report paths (`.data/remote-validate/*/report.json`) in the deployment manifest.

## 1. Server provisioning (gate A1, proposed)

Recommended: one small isolated Linux VPS (Ubuntu 24.04 LTS, x86_64, 1–2 vCPU, 2 GB RAM, 20 GB disk) at a provider the owner already uses. Monthly price: **not verified here**; the owner sets a cost cap at A1. The owner's PC must not be the public host.

Proposed steps (provider console):
1. Create the server with only the owner's SSH public key; no password login.
2. Provider firewall: inbound 22/tcp from the owner's IP only; 80/tcp and 443/tcp from anywhere; everything else denied.
3. On the server:
   ```bash
   sudo apt-get update && sudo apt-get -y upgrade
   sudo apt-get -y install docker.io docker-compose-v2 git unattended-upgrades
   sudo adduser --disabled-password --gecos "" diaporia && sudo usermod -aG docker diaporia
   sudo sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config && sudo systemctl reload ssh
   ```

## 2. DNS (gate A2, proposed)

Create exactly one record; change nothing else in the zone:

| Option | Record | Edge mode (`CADDY_EDGE`) | Notes |
|---|---|---|---|
| **A (recommended)** | `mcp.diaporia.com A <server IPv4>`, **DNS only**, no AAAA | `direct`: Let's Encrypt via HTTP-01, contact `CADDY_EMAIL` | simplest; no proxy is trusted, the client address is the TCP peer; Claude's egress `160.79.104.0/21` reaches Caddy directly |
| B | same record, **proxied** | `cloudflare`: Cloudflare Origin CA cert (`origin.pem`/`origin.key`, Full (strict) for this hostname only) and **mandatory Authenticated Origin Pulls** with a per-hostname certificate whose CA is `origin-pull-ca.pem` | needs `node scripts/remote/cloudflare-ips.mjs > deploy/remote-mcp/edge/cloudflare-ips.caddy` from Cloudflare's official lists (preflight refuses a file older than 7 days); do not alter zone-wide SSL/WAF settings; Caddy refuses to start in this mode without the ranges file or the certificates |

Cloudflare is not authentication: the app enforces OAuth whatever sits in front.

## 3. Environment configuration (gate A3)

On the server, as `diaporia`:

```bash
git clone https://github.com/friendly-neighborhood-coding-man/diaporia-agent-commerce.git && cd diaporia-agent-commerce
git checkout <approved commit SHA>
cp deploy/remote-mcp/.env.example deploy/remote-mcp/.env       # edit: MCP_HOSTNAME, CADDY_EDGE, CADDY_EMAIL, DIAPORIA_IMAGE_TAG=<sha>
install -d -m 700 deploy/remote-mcp/secrets
( umask 077; printf 'DIAPORIA_OWNER_KEYS=%s=eric-remote\n' "$(node scripts/remote/owner-key.mjs)" > deploy/remote-mcp/secrets/app.env )
# One OAuth client per host and user. Prints client_id + client_secret ONCE (to the user, out of band)
# and env_entry (secret as sha256 only) for the secrets file:
node scripts/remote/oauth-client.mjs --user eric-remote --name "Claude (Eric)" --redirect https://claude.ai/api/mcp/auth_callback
( umask 077; printf 'DIAPORIA_OAUTH_CLIENTS=%s\n' '<env_entry>' >> deploy/remote-mcp/secrets/app.env )
node scripts/remote/preflight.mjs        # must print OK; refuses e.g. an existing app-data volume, a dirty checkout, local edge mode
```

- Dynamic client registration is closed. A host connects only with a client registered here, and that client can only be approved by its bound user's key. Several entries are separated by `;`.
- The owner key is generated **for this deployment only** and handed to the owner out of band (never in chat, git, tickets or logs). Do not reuse a local `dok_` key; the service refuses it.
- Issuer and resource are derived from `MCP_HOSTNAME`: issuer `https://<host>`, resource `https://<host>/mcp`. They must match what users type in the host.
- The startup check refuses: http or loopback/IP base URLs, missing or non-`drk_` keys, any `PAYPAL_*`, `HANDOFF_*`, `KERNEL_*`, `MERCHANT_*`, `MANAGED_*`, Tavily/Channel3 variables, dev tokens, managed mode, non-oauth auth modes, `:memory:` or relative DB paths (exit 78, event `startup_refused`).

## 4. Application startup (gate A3)

```bash
docker compose -f deploy/remote-mcp/compose.yaml --env-file deploy/remote-mcp/.env up -d --build --wait
docker compose -f deploy/remote-mcp/compose.yaml logs app | grep '"event":"startup"'
```

Check the startup line: `paymentExecutionEnabled:false`, `research:"mock-fixtures"`, `scopes:["purchase.research","purchase.read"]`, `registration:"closed"`, `grantsBoundToOwnerKey:true`. Then write the manifest and keep it with the approval record:

```bash
node scripts/remote/manifest.mjs --window-end <UTC end of the approved window> > ~/manifest-$(date -u +%Y%m%dT%H%M%SZ).json   # exit 0 required; no secrets inside
```

From the owner's machine (not the server), run the negative-test checklist (REMOTE_MCP_NEGATIVE_TESTS.md). With A4 approved and throwaway test users and clients registered for it:

```bash
npm run remote:validate -- --https https://mcp.diaporia.com --secrets-file <json {keys:{alice,bob}, clients:{alice:{id,secret},bob:{id,secret}}}>
```

## 5. First-user authentication and remote host connection (gates A4, A5)

Follow REMOTE_HOST_COMPATIBILITY.md §5. One host, one named user, inside the approved window.

## 6. Monitoring and logs

- **Health:** Docker health check (`healthcheck.mjs`, internal `/healthz`, fails unless `paymentExecutionEnabled=false`); `docker compose ps`. External probe: `GET https://<host>/.well-known/oauth-protected-resource` (200) every 5 minutes from the owner's monitor.
- **App audit log** (stdout, JSON lines): `event:"http"` with route label, status, duration and a salted client hash. Never query strings, headers, tokens, codes or keys. `event:"startup"`, `"shutdown"`, `"oauth_prune"`, `"startup_refused"`.
- **Caddy access log** (stdout, JSON): query strings and all request and response headers removed (no Authorization, X-Owner-Key, Cookie or Location with codes).
- Rotation: Docker json-file, 10 MB × 5 per container.
- Watch for: 429 bursts, 5xx, 401 bursts on `/oauth/token` (guessing client secrets), `startup_refused`, unhealthy containers, disk use of the `app-data` volume.

```bash
docker compose -f deploy/remote-mcp/compose.yaml logs --since 1h app | grep -c '"status":5'
docker compose -f deploy/remote-mcp/compose.yaml logs --since 1h app | grep '"route":"/oauth/token"' | grep -c '"status":401'
```

## 7. Resource exhaustion

Limits: app 512 MB RAM, 1 CPU, 128 pids, read-only root, 64 KB request bodies (app and Caddy), 30 s request timeout; Caddy 256 MB, 0.5 CPU. Per client address: 120 `/mcp` calls/min, 30 other calls/min; registration closed; 500 pending consents; hourly prune of unused clients and dead grants. On sustained abuse: stop Caddy (`docker compose stop caddy`) to close the endpoint; the app and its data stay intact.

## 8. Database backup

SQLite files `/data/remote.sqlite` and `/data/remote-service.sqlite` on volume `app-data`. Back up only while the app is stopped:

```bash
docker compose -f deploy/remote-mcp/compose.yaml stop app
docker run --rm -v diaporia-remote-mcp_app-data:/data -v "$PWD/backup":/b busybox tar czf /b/app-data-$(date -u +%Y%m%dT%H%M%SZ).tgz -C /data .
docker compose -f deploy/remote-mcp/compose.yaml start app
```

The database holds OAuth token *hashes*, client registrations and research records; treat backups as sensitive and delete them at the end of the window.

## 9. Secret rotation

1. **Owner key:** generate a new key (`npm run remote:owner-key`), replace it in `secrets/app.env`, `docker compose up -d app`. Every grant approved with the old key stops working immediately and is revoked persistently at startup (`housekeeping.stale`); putting the old key back does not revive them. The user approves again with the new key.
2. **OAuth client secret:** create a new client (`npm run remote:oauth-client`), replace the old entry, restart; grants of the removed client are revoked at startup. Update the host's client ID/secret.
3. **Everything at once (incident):** `DIAPORIA_REVOKE_ALL_GRANTS_ON_START=1`, `up -d app`, check `housekeeping.all`, set it back to `0`, `up -d app`.
4. Removing a user's key and restarting revokes that user's grants automatically.

## 10. Service restart

`docker compose -f deploy/remote-mcp/compose.yaml restart app` (tokens and research sessions persist; verified locally, step 14 of the harness). `restart: unless-stopped` restarts after crashes or reboots.

## 11. Rollback and incident response

See REMOTE_MCP_ROLLBACK.md. Fastest safe state at any time: `docker compose -f deploy/remote-mcp/compose.yaml down` (endpoint closed, data kept).

## 12. Provider costs and budget

- This release uses **MOCK fixtures only**; the remote entrypoint cannot construct Channel3, Tavily or KERNEL clients. Provider cost: **$0**.
- Infrastructure: one small VPS (price not verified; owner sets the cap at A1) and a free Let's Encrypt certificate (or Cloudflare Origin CA).
- Live research (Channel3/Tavily/KERNEL) would be a new gate A6 and a code change; supplier prices are recorded as UNKNOWN in the code (`LIVE_PRICES_UNKNOWN`). No live call was prepared or made.
