# Remote MCP (research/read only): negative-test checklist

Run at gate A3 against the public host, from the owner's machine (not the server), before any remote AI host is connected, and again after every redeploy or rollback. Every line must show the refusal. Any other answer stops the gate: run rollback R1 (`docker compose stop caddy`).

Local equivalents run automatically: `npm run remote:validate` (app), `npm run remote:validate:https` (Caddy + app over TLS) and `npm run remote:edge-check` (the real Caddyfile in both edge modes). Passing them is LOCAL_VERIFIED only. This checklist is what verifies the public host.

```bash
H=https://mcp.diaporia.com        # the approved hostname
c() { curl -s -o /dev/null -w '%{http_code}\n' "$@"; }
```

## 1. Payment and owner surface is absent

| # | Request | Expected |
|---|---|---|
| 1.1 | `c $H/owner/mandates` | 404 |
| 1.2 | `c -X POST $H/paypal/webhook` | 404 |
| 1.3 | `c $H/mock-paypal/approve` | 404 |
| 1.4 | `c $H/authorize/x` and `c $H/handoff/start` and `c $H/billing/subscriptions` and `c $H/operator` | 404 each |
| 1.5 | `c $H/healthz` | 404 |
| 1.6 | path variants: `c "$H/%6Fwner/mandates"`, `c "$H/OWNER/mandates"`, `c "$H//owner/mandates"`, `c --path-as-is "$H/mcp/../owner/mandates"`, `c "$H/owner%2Fmandates"` | 404 each |
| 1.7 | Host rewrite: `c -H 'Host: 127.0.0.1:8080' $H/mcp` and `c -H 'Host: localhost' $H/owner/mandates` | not 2xx with content; nothing in the app log for that minute |
| 1.8 | `c http://mcp.diaporia.com/owner/mandates` (plain HTTP) | 308 redirect only |
| 1.9 | direct connection to the app port from outside: `nc -zv <server ip> 8080` | refused / filtered |

## 2. OAuth surface is closed to strangers

| # | Request | Expected |
|---|---|---|
| 2.1 | `curl -s $H/.well-known/oauth-authorization-server` | 200; **no** `registration_endpoint`; `token_endpoint_auth_methods_supported` = `client_secret_basic`, `client_secret_post` (no `none`); scopes only `purchase.research`, `purchase.read` |
| 2.2 | `c -X POST -H 'content-type: application/json' -d '{"client_name":"Claude","redirect_uris":["https://claude.ai/api/mcp/auth_callback"]}' $H/oauth/register` | 404 (not forwarded) |
| 2.3 | `c "$H/oauth/authorize?response_type=code&client_id=dcl_00000000000000000000000000000000&redirect_uri=https://claude.ai/api/mcp/auth_callback&code_challenge=x&code_challenge_method=S256"` | 400, no `Location` header |
| 2.4 | the registered client id with `redirect_uri=https://evil.example/cb` | 400, no `Location` header |
| 2.5 | `c -X POST -d 'grant_type=authorization_code&code=x&client_id=<registered id>' $H/oauth/token` (no secret) | 401 `invalid_client` |
| 2.6 | same with `client_secret=wrong` | 401 |
| 2.7 | `c -X POST -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' $H/mcp` | 401 with `WWW-Authenticate: Bearer resource_metadata=…` |
| 2.8 | `c -H 'Authorization: Bearer dat_invalid' …` on `/mcp` | 401 |

## 3. Client address handling (rate limits cannot be shared or spoofed)

| # | Check | Expected |
|---|---|---|
| 3.1 | 40 requests to `/.well-known/oauth-authorization-server` within a minute from one machine | 429 after 30 |
| 3.2 | right after 3.1, the same from a second network (e.g. phone hotspot) | 200 (separate identity) |
| 3.3 | 3.1 again with `-H 'X-Forwarded-For: 203.0.113.<n>'` and `-H 'CF-Connecting-IP: …'` varying per request | still 429 after 30 (headers ignored) |
| 3.4 | Cloudflare mode only: `curl --resolve mcp.diaporia.com:443:<origin ip> $H/.well-known/oauth-protected-resource` (bypassing Cloudflare, no client certificate) | TLS handshake failure |

## 4. Logs contain no secrets

| # | Check | Expected |
|---|---|---|
| 4.1 | on the server: `docker compose -f deploy/remote-mcp/compose.yaml logs --no-color \| grep -Ec '(dat\|drt\|dac\|drk\|dcs)_[A-Za-z0-9_-]{40,}'` | 0 |
| 4.2 | `… logs caddy \| grep -ci 'authorization\|x-owner-key\|cookie'` | 0 |

## 5. Rotation fails closed (with A4 test users only)

| # | Check | Expected |
|---|---|---|
| 5.1 | after a test user completes a grant, rotate that user's key and `up -d app` | the host's next call gets 401; startup line shows `housekeeping.stale` ≥ 1 |
| 5.2 | put the old key back and restart | still 401 |

Record each result (UTC time, command, status) in the deployment manifest folder. Raw responses must not contain tokens; if one does, stop and treat it as an incident.
