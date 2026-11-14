# Phase C MOCK public smoke via the existing Windows Cloudflare Tunnel

**Status: CONFIG + LAUNCHER PREPARED. No Cloudflare route, DNS, process, PayPal Sandbox order, or KERNEL browser has been started from this repository.**

This is an explicitly limited **MOCK-only** exception to the earlier "do not publicly tunnel the personal PC" rule. Running a public process on a personal Windows machine has additional risks. Use only a supervised, short-lived local demo, run as a non-administrator without privileged filesystem access, and disable the route immediately afterward. **Do not extend this route to C1 or C2.** For those gates use a reviewed isolated VPS or equivalent remote sandbox plus separate owner authorization.

## Existing routing to preserve

- **Playground**: existing locally-managed tunnel `diaporia-playground` (may have `diaporia.com` / `www.diaporia.com` → `http://127.0.0.1:8787`).
- **Kakao bot**: `bot.diaporia.com` previously used its own tunnel/service and `http://127.0.0.1:18080`. Do not stop/reinstall/modify the Windows `cloudflared` service that serves it.
- **New temporary MOCK only**: `phase-c.diaporia.com` → `http://127.0.0.1:8791`, via `diaporia-playground`.
- These are *previously reported* assignments, **not a current inventory**. Verify on the operator's Windows PC; don't run commands against a tunnel that doesn't exist.

## 0. Read-only Windows inventory

Open **a fresh, non-admin PowerShell** window on the machine with cloudflared installed:

```powershell
$cf = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source
if (-not $cf) { $cf = 'C:\Program Files (x86)\cloudflared\cloudflared.exe' }
if (-not (Test-Path $cf)) { throw 'cloudflared not found; locate the installed executable' }
& $cf --version
& $cf tunnel list
& $cf tunnel info diaporia-playground
Get-Service cloudflared -ErrorAction SilentlyContinue
Get-Process cloudflared -ErrorAction SilentlyContinue | Select-Object Id, ProcessName
Get-NetTCPConnection -State Listen -LocalPort 8787,8791,18080 -ErrorAction SilentlyContinue |
  Select-Object LocalAddress,LocalPort,OwningProcess
$cfg = Join-Path $env:USERPROFILE '.cloudflared\config.yml'
if (Test-Path $cfg) { & $cf tunnel --config $cfg ingress validate }
```

Confirm `diaporia-playground` is a **locally-managed** tunnel that uses the config above. If it is remotely managed, modify its published-application route in the Cloudflare Zero Trust dashboard instead; do not run this config snippet verbatim. Inspect whether another connector is running the same tunnel with an older config. A second simultaneous connector with different ingress rules can create inconsistent routing.

**Do not paste tunnel credentials, tokens, cert.pem, private keys, full cloudflared config, service tokens, or private account IPs into issues or chat.** The existing Kakao service must remain running.

## 1. Launch the MOCK-only merchant (local, no paid providers)

Use the current code from [PR #6](https://github.com/friendly-neighborhood-coding-man/diaporia-agent-commerce/pull/6) and this preparation branch. In a **fresh PowerShell** window in the repo root:

```powershell
npm.cmd ci
npm.cmd run build
npm.cmd run typecheck
npm.cmd test
powershell -NoProfile -File scripts/phase-c-local-mock.ps1
```

The launcher runs the built Phase C merchant with these enforced values:

```text
MERCHANT_CHECKOUT_MODE=MOCK
MERCHANT_LISTEN_HOST=127.0.0.1
MERCHANT_LISTEN_PORT=8791
MERCHANT_PUBLIC_ORIGIN=https://phase-c.diaporia.com
MERCHANT_OPERATOR_KEY=(unset)
MERCHANT_DATA_DIR=(unset)
MERCHANT_STATUS_SECRET=(unset)
```

It fails if the process inherited `MERCHANT_PAYPAL_CLIENT_SECRET`, `MERCHANT_PAYPAL_CLIENT_ID`, `MERCHANT_PAYPAL_SELLER_MERCHANT_ID`, `PHASE_C_APPROVED_DIGEST`, `PHASE_C_APPROVAL_SIGNATURE`, `KERNEL_API_KEY`, `DIAPORIA_ALLOW_KERNEL_LIVE`, or `HANDOFF_DRIVER`.

Leave this window open. In a second PowerShell window:

```powershell
Invoke-RestMethod http://127.0.0.1:8791/healthz
# Expected: {"ok":true,"mode":"MOCK"}
```

**No actual PayPal or KERNEL call occurs**, and the merchant doesn't read credentials in MOCK. There is no persistent data directory. Since the application accepts public browser sessions, do not leave it exposed unattended or run it as Windows Administrator.

## 2. Stage only the new Cloudflare ingress rule

First **back up** the existing `%USERPROFILE%\.cloudflared\config.yml` outside any public repository. Open it locally and preserve its original `tunnel:`, `credentials-file:`, existing `ingress:` entries and final `- service: http_status:404`.

Insert only these two items **above** the existing catch-all; do **not** create a second `ingress:` key:

```yaml
- hostname: phase-c.diaporia.com
  path: "^/operator(/|$)"
  service: http_status:404
- hostname: phase-c.diaporia.com
  service: http://127.0.0.1:8791
```

The reusable fragment is [deploy/phase-c/local-tunnel-mock/ingress-snippet.yml](../deploy/phase-c/local-tunnel-mock/ingress-snippet.yml), **not** a standalone config file. This is defense in depth; the MOCK process also has no operator key, so operator routes are unauthorized at the origin.

Verify **before applying the route**:

```powershell
& $cf tunnel --config $cfg ingress validate
& $cf tunnel --config $cfg ingress rule 'https://phase-c.diaporia.com/p/off_lumen_q3'
# Expected local destination: http://127.0.0.1:8791
& $cf tunnel --config $cfg ingress rule 'https://phase-c.diaporia.com/operator/diagnostics'
# Expected: http_status:404
& $cf tunnel --config $cfg ingress rule 'https://diaporia.com/'
# Must still match the ORIGINAL existing routing (typically 127.0.0.1:8787)
```

**Limitations:** ingress path regex alone is not a substitute for origin authentication or path normalization; `/operator/*` is additionally inaccessible because `MERCHANT_OPERATOR_KEY` is unset. If any original ingress match is lost, stop and restore the original config.

## 3. Cloudflare DNS / tunnel activation — explicit external change

**These commands modify Cloudflare DNS and start an external connection. They have NOT been run.**

Only after verifying the existing tunnel and accepting temporary public MOCK exposure:

```powershell
# Inspect Cloudflare DNS first; do not override an existing record.
& $cf tunnel route dns diaporia-playground phase-c.diaporia.com
# If an existing connector for diaporia-playground is active, first stop/restart
# ONLY that connector in a controlled way to load the updated config.
# NEVER stop the separate Kakao cloudflared service.
& $cf tunnel --config $cfg run diaporia-playground
```

For a locally-managed tunnel, the DNS record should be a **Proxied CNAME** `phase-c` pointing at `<playground-tunnel-UUID>.cfargotunnel.com`, **not** an A record pointing at the home PC. If Cloudflare says the hostname's record already exists, inspect the record instead of overwriting or creating a duplicate. For a remotely-managed tunnel, add a published application route in Cloudflare Zero Trust that targets `http://127.0.0.1:8791`, with an explicit deny for operator paths, and preserve existing routes.

Cloudflare docs: [locally managed configuration](https://developers.cloudflare.com/tunnel/features/locally-managed-tunnels/configuration-file/), [DNS routing](https://developers.cloudflare.com/tunnel/features/locally-managed-tunnels/create-local-tunnel/).

## 4. Smoke tests and rollback

Check with the browser at `https://phase-c.diaporia.com/p/off_lumen_q3`:

- [ ] Banner says **TEST MERCHANT. MOCK mode: no PayPal, no network.**
- [ ] Fixed Lumen Q3 Black, quantity 1, USD **107.60**.
- [ ] Add-to-cart → cart → **PayPal (MOCK)** opens the synthetic popup. **This is NOT PayPal Sandbox**.
- [ ] Synthetic approve → merchant confirmation. There is no payment and no shipment.
- [ ] `https://phase-c.diaporia.com/operator/diagnostics` returns **404** via Cloudflare; also without an operator key the merchant cannot execute protected routes.
- [ ] `diaporia.com` and `bot.diaporia.com` still work independently.
- [ ] If Cloudflare Tunnel reports stale/unmatched ingress, stop MOCK publication and investigate before proceeding.

To stop the experiment, Ctrl+C the **playground tunnel foreground process** and the MOCK merchant process (do **not** stop the Kakao service). Remove only the two `phase-c.diaporia.com` ingress entries, then remove the new `phase-c` DNS record **after checking it is the record created for this test**. Restore or restart the original playground connector configuration if required. Existing apex, www and Kakao routes must remain unchanged. A deleted DNS record will not delete the underlying named tunnel.

## C1 boundary

This public personal-PC tunnel is authorized **only for the MOCK smoke**, not Phase C C1. Do not set `SANDBOX_POPUP_TEST` or `SANDBOX_APPROVAL_TEST`, do not inject PayPal credentials, do not start KERNEL. Before any real Sandbox order/paid KERNEL browser: independent review; a remote isolated test host; exact origin/allowlist; pinned code; a fresh owner-signed approval; and explicit budget confirmation. Refer to [PHASE_C_OPERATOR_CHECKLIST.md](PHASE_C_OPERATOR_CHECKLIST.md).
