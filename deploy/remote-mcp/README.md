# deploy/remote-mcp: research/read-only remote MCP service

A two-container stack: **Caddy** (HTTPS, path allowlist) in front of the **remote read-only profile** of DIAPORIA (`src/remote/main.ts`). It exposes only research and read tools over OAuth 2.1. Payment, mandate, owner, handoff, billing and operator capabilities do not exist in this profile, and no setting enables them.

**Nothing here has been deployed.** Each external step needs its own owner approval: see [docs/REMOTE_MCP_SECURITY_GATES.md](../../docs/REMOTE_MCP_SECURITY_GATES.md).

| File | Purpose |
|---|---|
| `Dockerfile` (+ `Dockerfile.dockerignore`) | builds `dist/src` only; non-root; pinned base image digest |
| `compose.yaml` | app + Caddy; read-only root filesystems, dropped capabilities, memory/CPU/pid limits, health check, log rotation, fixed internal addresses |
| `Caddyfile` | TLS (ACME, Cloudflare Origin CA, or `internal` for local checks), path allowlist, 64 KB bodies, HSTS, log redaction |
| `.env.example` | non-secret settings; the only secret (`DIAPORIA_OWNER_KEYS`) lives in `secrets/app.env` (gitignored) |
| `healthcheck.mjs` | container health: fails unless the service reports read-only |
| `local-https-check.sh` | full stack on `127.0.0.1:8443` with Caddy's internal CA, then the validation harness over TLS |

## Validate locally (no DNS, no public exposure)

```bash
npm run remote:validate          # spawns the service, emulates the proxy: 15 steps + startup refusals
npm run remote:validate:https    # Docker + Caddy over real TLS on 127.0.0.1:8443, then the same steps
```

Behind a TLS-inspecting proxy, build the image first with the proxy CA as a build secret, then run with `SKIP_BUILD=1`:

```bash
docker build --network host --build-arg HTTPS_PROXY --secret id=npm_ca,src=<ca.pem> -f deploy/remote-mcp/Dockerfile -t diaporia-remote-mcp:local-check .
SKIP_BUILD=1 npm run remote:validate:https
```

Reports go to `.data/remote-validate/<time>-<mode>/report.json`. They are **local** results (LOCAL_VERIFIED), never remote-host verification.

## Deploy (only after the gates)

[docs/REMOTE_MCP_DEPLOYMENT.md](../../docs/REMOTE_MCP_DEPLOYMENT.md) (runbook) · [docs/REMOTE_MCP_ROLLBACK.md](../../docs/REMOTE_MCP_ROLLBACK.md) · [docs/REMOTE_HOST_COMPATIBILITY.md](../../docs/REMOTE_HOST_COMPATIBILITY.md)
