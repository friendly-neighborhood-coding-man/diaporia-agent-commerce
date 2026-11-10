# Remote MCP rollback and incident response (research/read only)

**Status: PREPARED, NOT EXECUTED on any real server.** The stop/restore path, including restoring a pre-rotation backup, is LOCAL_VERIFIED by `npm run remote:validate` (step 15) and restart persistence by both harness modes (step 14). After every rollback or restore, run `node scripts/remote/manifest.mjs` and compare with the approved manifest.

`DC` below means `docker compose -f deploy/remote-mcp/compose.yaml --env-file deploy/remote-mcp/.env`.

## Levels (pick the smallest that fixes the problem)

| Level | Effect | Command | Data |
|---|---|---|---|
| R1 Close the endpoint | no public traffic; app keeps running for inspection | `$DC stop caddy` | kept |
| R2 Stop the service | endpoint and app stopped | `$DC down` | kept (volumes) |
| R3 Revoke grants | the affected hosts lose access at once | one user: rotate or remove their owner key, `$DC up -d app` (automatic, persistent); one client: remove its `DIAPORIA_OAUTH_CLIENTS` entry, restart; all: `DIAPORIA_REVOKE_ALL_GRANTS_ON_START=1`, `$DC up -d app`, then back to `0` | kept |
| R4 Roll back the release | previous approved commit/image | below | kept |
| R5 Restore data | database back to a stopped-state backup | below | replaced |
| R6 Decommission | nothing left | below | deleted |

## R4: roll back to the previous release

```bash
$DC down
git checkout <previous approved SHA>
sed -i 's/^DIAPORIA_IMAGE_TAG=.*/DIAPORIA_IMAGE_TAG=<previous SHA>/' deploy/remote-mcp/.env
$DC up -d --build --wait
$DC logs app | grep '"event":"startup"'     # configDigest must match that release's manifest
```

The schema only adds tables and nullable columns (`owner_fp`), so an older release can open a newer database. **Rolling back to `0d9b931` or earlier drops the owner-key binding and closed registration**: those releases reopen dynamic registration and would accept grants approved by a since-rotated key. Roll back only to a release whose manifest shows `registration:"closed"` and `grantsBoundToOwnerKey:true`; otherwise use R2. If the startup line shows `startup_refused`, the environment no longer matches that release: fix `.env`, never relax the check.

## R5: restore a backup

```bash
$DC stop app
docker run --rm -v diaporia-remote-mcp_app-data:/data -v "$PWD/backup":/b busybox sh -c 'rm -f /data/* && tar xzf /b/<backup>.tgz -C /data'
$DC start app
```

Grants issued after the backup are lost (hosts must reconnect). Grants of keys or clients removed since the backup are revoked again at startup (owner-key binding); other revocations made after the backup (a revoked refresh token, a revoke-all) come back: follow with R3 if any of them mattered.

## R6: decommission (end of the research window)

```bash
$DC down -v                                   # deletes app-data, caddy-data, caddy-config
rm -rf deploy/remote-mcp/secrets backup
```

Then, each as its own owner-approved step: delete the single DNS record created at A2; destroy the server created at A1; remove the connector in each remote host; retire the `drk_` keys.

## Incident response

1. **Contain:** R1 immediately (seconds). If a token or key may be exposed: R3. If the server may be compromised: R2 and isolate the server at the provider firewall.
2. **Preserve:** `$DC logs --no-color > incident-<UTC>.log`; copy the stopped-state backup; record the running commit, image digest and `configDigest`. Logs contain no tokens or keys by design, so they can be shared with the reviewer.
3. **Assess:** payment capability cannot be reached in this profile; check anyway that every startup line says `paymentExecutionEnabled:false` and that no `/owner`, `/paypal`, `/billing`, `/handoff` request returned 2xx in the Caddy log.
4. **Recover:** rotate keys (runbook §9), redeploy the approved commit (R4), re-run the public preflight.
5. **Report:** a note to the owner and the security-review workstream with times (UTC), scope and evidence hashes.
