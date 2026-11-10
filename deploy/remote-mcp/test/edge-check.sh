#!/usr/bin/env bash
# Integration test of the ACTUAL reverse-proxy configuration (Caddyfile + edge/*.caddy + compose.yaml)
# with Docker. The app is replaced by a stub that records what Caddy forwards; client containers with
# fixed addresses play distinct users, a spoofing client and a "Cloudflare" peer. Offline: no DNS, no
# Cloudflare, no public exposure (ports bound to 127.0.0.1 only). Run from the repository root:
#   bash deploy/remote-mcp/test/edge-check.sh            (report: deploy/remote-mcp/local/edge-test/)
# Substitutions, all test-only: direct mode uses tls internal instead of ACME; cloudflare mode uses a
# test ranges file (172.31.250.50/32) and locally generated origin / origin-pull certificates.
set -uo pipefail
cd "$(dirname "$0")/.."
W=local/edge-test; rm -rf "$W"; mkdir -p "$W/certs"
NODE_IMG=node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d
CADDY_IMG=$(sed -n 's/^ *image: \(caddy:2@sha256:[0-9a-f]*\)$/\1/p' compose.yaml)
status=0

# --- test certificates (throwaway) ---
gen_ca() { openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 2 -subj "/CN=$2" -keyout "$W/certs/$1.key" -out "$W/certs/$1.pem" 2>/dev/null; }
gen_leaf() { # name ca cn ext
  openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -subj "/CN=$3" -keyout "$W/certs/$1.key" -out "$W/certs/$1.csr" 2>/dev/null
  openssl x509 -req -in "$W/certs/$1.csr" -CA "$W/certs/$2.pem" -CAkey "$W/certs/$2.key" -CAcreateserial -days 2 -extfile <(printf '%s' "$4") -out "$W/certs/$1.pem" 2>/dev/null; }
gen_ca origin-ca "test origin CA"; gen_ca origin-pull-ca "test origin-pull CA"; gen_ca rogue-ca "rogue CA"
gen_leaf origin origin-ca mcp.diaporia.test "subjectAltName=DNS:mcp.diaporia.test
extendedKeyUsage=serverAuth"
gen_leaf cf-client origin-pull-ca "test cloudflare edge" "extendedKeyUsage=clientAuth"
gen_leaf rogue-client rogue-ca "rogue" "extendedKeyUsage=clientAuth"
chmod 644 "$W"/certs/*

# --- 1. caddy validate: every committed edge mode, unmodified ---
mkdir -p "$W/edge-validate"; cp edge/*.caddy "$W/edge-validate/"
echo "trusted_proxies static 173.245.48.0/20 2400:cb00::/32" > "$W/edge-validate/cloudflare-ips.caddy"
cp "$W/certs/origin.pem" "$W/certs/origin.key" "$W/certs/origin-pull-ca.pem" "$W/edge-validate/" 2>/dev/null
for mode in direct cloudflare local; do
  if docker run --rm -e MCP_HOSTNAME=mcp.diaporia.test -e CADDY_EDGE=$mode -e CADDY_EMAIL=ops@diaporia.test \
      -v "$PWD/Caddyfile:/etc/caddy/Caddyfile:ro" -v "$PWD/$W/edge-validate:/etc/caddy/edge:ro" -v "$PWD/$W/certs:/certs:ro" \
      "$CADDY_IMG" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile > "$W/validate-$mode.log" 2>&1; then
    echo "PASS  caddy validate (edge mode $mode)"; else echo "FAIL  caddy validate (edge mode $mode)"; tail -3 "$W/validate-$mode.log"; status=1; fi
done
# Fail closed: cloudflare mode without the generated ranges file, and an unknown mode, must not start.
mkdir -p "$W/edge-noips"; cp edge/*.caddy "$W/edge-noips/"
for neg in "cloudflare edge-noips" "bogus edge-validate"; do set -- $neg
  if docker run --rm -e MCP_HOSTNAME=mcp.diaporia.test -e CADDY_EDGE=$1 -v "$PWD/Caddyfile:/etc/caddy/Caddyfile:ro" -v "$PWD/$W/$2:/etc/caddy/edge:ro" -v "$PWD/$W/certs:/certs:ro" \
      "$CADDY_IMG" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile > "$W/validate-neg-$1.log" 2>&1; then
    echo "FAIL  caddy accepted edge mode $1 without its files"; status=1; else echo "PASS  caddy refuses edge mode $1 without its files (fail closed)"; fi
done

# --- 2. running stack per mode ---
run_mode() { # mode
  local mode=$1 P=diaporia-remote-mcp-edgetest ED="$W/edge-$1"
  mkdir -p "$ED"; cp edge/*.caddy "$ED/"
  if [ "$mode" = direct ]; then cp edge/local.site.caddy "$ED/direct.site.caddy"; fi   # no ACME offline
  echo "trusted_proxies static 172.31.250.50/32" > "$ED/cloudflare-ips.caddy"
  cat > "$W/stack-$mode.env" <<ENV
MCP_HOSTNAME=mcp.diaporia.test
CADDY_EDGE=$mode
CADDY_EDGE_DIR=./$ED
ORIGIN_CERT_DIR=./$W/certs
PUBLISH_HTTP=127.0.0.1:18080
PUBLISH_HTTPS=127.0.0.1:18443
DIAPORIA_SECRETS_FILE=/dev/null
ENV
  local DC=(docker compose -p $P -f compose.yaml -f test/compose.edge-test.yaml --env-file "$W/stack-$mode.env")
  "${DC[@]}" down -v --remove-orphans >/dev/null 2>&1
  if ! "${DC[@]}" up -d --wait --wait-timeout 120 > "$W/up-$mode.log" 2>&1; then echo "FAIL  stack did not start (edge mode $mode)"; tail -5 "$W/up-$mode.log"; "${DC[@]}" logs caddy | tail -5; "${DC[@]}" down -v >/dev/null 2>&1; return 1; fi
  for _ in $(seq 30); do "${DC[@]}" logs caddy 2>&1 | grep -q '"serving initial configuration"' && break; sleep 1; done
  node test/edge-cases.mjs cases $mode > "$W/cases-$mode.json"
  : > "$W/results-$mode.jsonl"
  for src in "a 172.31.250.61" "b 172.31.250.62" "cf 172.31.250.50"; do set -- $src
    docker run --rm --network ${P}_edge --ip "$2" -v "$PWD/test:/t:ro" -v "$PWD/$W:/w:ro" "$NODE_IMG" node /t/edge-client.mjs "/w/cases-$mode.json" "$1" >> "$W/results-$mode.jsonl" 2>>"$W/client-$mode.err"
  done
  # The app container has no route out of the internal backend network.
  if "${DC[@]}" exec -T app node -e 'const s=require("net").connect({host:"172.31.250.61",port:9,timeout:3000});s.on("connect",()=>process.exit(0));s.on("error",()=>process.exit(1));s.on("timeout",()=>process.exit(1))' 2>/dev/null; then
    echo "FAIL  [$mode] app reached the client network"; status=1; else echo "PASS  [$mode] app has no route to the client network (internal backend network)"; fi
  # Userland-proxy observation (loopback through Docker's port publishing): what address does Caddy see?
  curl -sk --noproxy '*' -o /dev/null --resolve mcp.diaporia.test:18443:127.0.0.1 -H 'x-edge-case: observe-loopback' $( [ "$mode" = cloudflare ] && echo "--cert $W/certs/cf-client.pem --key $W/certs/cf-client.key" ) https://mcp.diaporia.test:18443/.well-known/oauth-protected-resource || true
  "${DC[@]}" logs --no-color app > "$W/upstream-$mode.jsonl" 2>&1
  "${DC[@]}" logs --no-color caddy > "$W/caddy-$mode.log" 2>&1
  echo "OBSERVATION [$mode] host loopback via published port reaches Caddy as: $(grep -o '"case":"observe-loopback"' -m1 "$W/upstream-$mode.jsonl" >/dev/null && node -e 'const l=require("fs").readFileSync(process.argv[1],"utf8").split("\n").map(x=>x.slice(x.indexOf("{"))).filter(x=>x.includes("observe-loopback"))[0];console.log(JSON.parse(l).xff)' "$W/upstream-$mode.jsonl" || echo "not reached")"
  node test/edge-cases.mjs assert $mode "$W/results-$mode.jsonl" "$W/upstream-$mode.jsonl" "$W/report-$mode.json" || status=1
  "${DC[@]}" down -v --remove-orphans >/dev/null 2>&1
}
run_mode direct || status=1
run_mode cloudflare || status=1
echo "BLOCKED  IPv6 transport cases: this environment's kernel has no IPv6 (Docker cannot create a dual-stack network); run with compose.ipv6.yaml on the server at gate A1"
exit $status
