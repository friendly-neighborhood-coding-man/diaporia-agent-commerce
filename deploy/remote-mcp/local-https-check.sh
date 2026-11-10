#!/usr/bin/env bash
# Local HTTPS emulation of the full stack (Caddy with its own internal CA + the read-only app), then the
# 15-step validation over real TLS. Publishes on 127.0.0.1:8443 only. No DNS, no public exposure, no
# external calls besides pulling the pinned base images. Run from the repository root:
#   npm run remote:validate:https
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p local secrets
umask 077
# Throwaway owner keys and operator-registered OAuth clients for alice-remote and bob-remote. The app env
# holds only the secrets' sha256; the clear secrets go to the harness file, which stays under local/.
node --input-type=module - local/owner-keys.env local/harness-secrets.json <<'NODE'
import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
const [envFile, harnessFile] = process.argv.slice(2);
const keys = {}, clients = {}, entries = [];
for (const u of ["alice", "bob"]) {
  keys[u] = `drk_${randomBytes(32).toString("base64url")}`;
  clients[u] = { id: `dcl_${randomBytes(16).toString("hex")}`, secret: `dcs_${randomBytes(32).toString("base64url")}` };
  entries.push(`${clients[u].id}|${createHash("sha256").update(clients[u].secret).digest("hex")}|${u}-remote|http://127.0.0.1:53682/callback,https://claude.ai/api/mcp/auth_callback|Validation client (${u})`);
}
writeFileSync(envFile, `DIAPORIA_OWNER_KEYS=${Object.entries(keys).map(([u, k]) => `${k}=${u}-remote`).join(";")}\nDIAPORIA_OAUTH_CLIENTS=${entries.join(";")}\n`, { mode: 0o600 });
writeFileSync(harnessFile, JSON.stringify({ keys, clients }), { mode: 0o600 });
NODE
cat > local/stack.env <<ENV
MCP_HOSTNAME=mcp.diaporia.test
PUBLIC_PORT_SUFFIX=:8443
CADDY_EDGE=local
PUBLISH_HTTP=127.0.0.1:8080
PUBLISH_HTTPS=127.0.0.1:8443
DIAPORIA_IMAGE_TAG=local-check
DIAPORIA_SECRETS_FILE=./local/owner-keys.env
DIAPORIA_WEB_RATE_PER_MIN=600
DIAPORIA_REGISTER_PER_HOUR=100
ENV
DC=(docker compose -p diaporia-remote-mcp-check -f compose.yaml --env-file local/stack.env)
cleanup() { "${DC[@]}" down -v --remove-orphans >/dev/null 2>&1 || true; }
trap cleanup EXIT
# SKIP_BUILD=1 uses an image already tagged diaporia-remote-mcp:local-check (e.g. built behind a proxy).
if [ "${SKIP_BUILD:-0}" = 1 ]; then "${DC[@]}" up -d --no-build --wait --wait-timeout 180; else "${DC[@]}" up -d --build --wait --wait-timeout 180; fi
# Caddy writes its internal CA shortly after start; wait for it (up to 60 s).
for _ in $(seq 60); do "${DC[@]}" exec -T caddy test -f /data/caddy/pki/authorities/local/root.crt && break; sleep 1; done
"${DC[@]}" cp caddy:/data/caddy/pki/authorities/local/root.crt local/caddy-root.crt
"${DC[@]}" logs app > local/app-start.log 2>&1 || true
cd ../..
npx tsx scripts/remote/validate.ts --https https://mcp.diaporia.test:8443 --resolve 127.0.0.1 \
  --ca deploy/remote-mcp/local/caddy-root.crt --secrets-file deploy/remote-mcp/local/harness-secrets.json \
  --restart-cmd "docker compose -p diaporia-remote-mcp-check -f deploy/remote-mcp/compose.yaml --env-file deploy/remote-mcp/local/stack.env restart app" "$@"
status=$?
cd deploy/remote-mcp
"${DC[@]}" logs --no-color > local/stack.log 2>&1 || true
# The app answers /healthz only to a loopback peer: from the Caddy container it must be 404.
if "${DC[@]}" exec -T caddy wget -q -O /dev/null --header "Host: mcp.diaporia.test:8443" http://app:8080/healthz 2>/dev/null; then echo "FAIL  app served /healthz to a non-loopback peer"; status=1; else echo "PASS  app refuses /healthz from a non-loopback peer (Caddy container)"; fi
# Log hygiene over both containers: no access/refresh token, authorization code or owner key may appear.
if grep -Eq '(dat|drt|dac|drk|dcs)_[A-Za-z0-9_-]{40,}' local/stack.log; then echo "FAIL  stack logs contain a token, code, client secret or key"; status=1; else echo "PASS  stack logs (Caddy + app) contain no token, code, client secret or owner key"; fi
exit $status
