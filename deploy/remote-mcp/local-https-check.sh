#!/usr/bin/env bash
# Local HTTPS emulation of the full stack (Caddy with its own internal CA + the read-only app), then the
# 15-step validation over real TLS. Publishes on 127.0.0.1:8443 only. No DNS, no public exposure, no
# external calls besides pulling the pinned base images. Run from the repository root:
#   npm run remote:validate:https
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p local secrets
umask 077
cat > local/owner-keys.env <<KEYS
DIAPORIA_OWNER_KEYS=$(node ../../scripts/remote/owner-key.mjs)=alice-remote;$(node ../../scripts/remote/owner-key.mjs)=bob-remote
KEYS
cat > local/stack.env <<ENV
MCP_HOSTNAME=mcp.diaporia.test
PUBLIC_PORT_SUFFIX=:8443
CADDY_TLS=internal
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
"${DC[@]}" cp caddy:/data/caddy/pki/authorities/local/root.crt local/caddy-root.crt
"${DC[@]}" logs app > local/app-start.log 2>&1 || true
cd ../..
npx tsx scripts/remote/validate.ts --https https://mcp.diaporia.test:8443 --resolve 127.0.0.1 \
  --ca deploy/remote-mcp/local/caddy-root.crt --keys-file deploy/remote-mcp/local/owner-keys.env \
  --restart-cmd "docker compose -p diaporia-remote-mcp-check -f deploy/remote-mcp/compose.yaml --env-file deploy/remote-mcp/local/stack.env restart app" "$@"
status=$?
cd deploy/remote-mcp
"${DC[@]}" logs --no-color > local/stack.log 2>&1 || true
# Log hygiene over both containers: no access/refresh token, authorization code or owner key may appear.
if grep -Eq '(dat|drt|dac|drk)_[A-Za-z0-9_-]{40,}' local/stack.log; then echo "FAIL  stack logs contain a token, code or key"; status=1; else echo "PASS  stack logs (Caddy + app) contain no token, code or owner key"; fi
exit $status
