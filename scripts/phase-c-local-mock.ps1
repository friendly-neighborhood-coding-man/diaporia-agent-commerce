# Starts ONLY the offline, fake-payment merchant on local loopback.
# No Cloudflare DNS edits, tunnel launch, paid browser, PayPal or cloud calls.
# Run from a fresh PowerShell window:
#   powershell -NoProfile -File scripts/phase-c-local-mock.ps1
#
# The separate operator manually runs their EXISTING Cloudflare Tunnel
# foreground process after reviewing the ingress rules.
param(
  [switch]$Build
)
$ErrorActionPreference = "Stop"

$unsafe = @(
  "MERCHANT_PAYPAL_CLIENT_SECRET",
  "MERCHANT_PAYPAL_CLIENT_ID",
  "MERCHANT_PAYPAL_SELLER_MERCHANT_ID",
  "PHASE_C_APPROVED_DIGEST",
  "PHASE_C_APPROVAL_SIGNATURE",
  "KERNEL_API_KEY",
  "DIAPORIA_ALLOW_KERNEL_LIVE",
  "HANDOFF_DRIVER"
)
foreach ($name in $unsafe) {
  $value = [Environment]::GetEnvironmentVariable($name, "Process")
  if (-not [string]::IsNullOrWhiteSpace($value)) {
    throw "Refused: $name is present in the environment. Start from a fresh PowerShell session without payment/KERNEL credentials."
  }
}

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$entry = Join-Path $root "dist-merchant/apps/phase-c-test-merchant/src/main.js"
$env:MERCHANT_CHECKOUT_MODE = "MOCK"
$env:MERCHANT_PUBLIC_ORIGIN = "https://phase-c.diaporia.com"
$env:MERCHANT_LISTEN_HOST = "127.0.0.1"
$env:MERCHANT_LISTEN_PORT = "8791"
# No operator authorization key; /operator routes are not publicly usable.
$env:MERCHANT_OPERATOR_KEY = ""
# No saved sessions or payment history on an externally available MOCK instance.
$env:MERCHANT_DATA_DIR = ""
$env:MERCHANT_STATUS_SECRET = ""

Push-Location $root
try {
  if ($Build) {
    & npm.cmd ci
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed ($LASTEXITCODE)" }
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed ($LASTEXITCODE)" }
  }
  if (-not (Test-Path -LiteralPath $entry)) {
    throw "Build not found: run 'npm ci' and 'npm run build' (or rerun this script with -Build) before starting the merchant."
  }
  Write-Host "Starting Phase C MOCK on http://127.0.0.1:8791"
  Write-Host "Public origin for secure cookies: https://phase-c.diaporia.com"
  Write-Host "PayPal Sandbox, KERNEL and operator APIs are NOT enabled."
  Write-Host "Press Ctrl+C to stop. This does NOT start a Cloudflare Tunnel."
  & node $entry
  if ($LASTEXITCODE -ne 0) { throw "Merchant exited with code $LASTEXITCODE" }
}
finally {
  Pop-Location
}
