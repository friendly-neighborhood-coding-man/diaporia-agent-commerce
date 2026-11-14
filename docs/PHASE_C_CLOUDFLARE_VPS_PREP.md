# Phase C Cloudflare + VPS deployment preparation

**Status: PREPARED CONFIG ONLY. NO VPS CREATED, DNS CHANGED, EXTERNAL DEPLOYMENT OR PAYPAL/KERNEL CALLS.**

This file stages an operator-controlled deployment of the fictional Lumen Q3 merchant at
`https://phase-c.diaporia.com`. Do not deploy or enable Sandbox until Phase C's signed
approval gate in [PHASE_C_OPERATOR_CHECKLIST.md](PHASE_C_OPERATOR_CHECKLIST.md) is satisfied.

## What was found

- `friendly-neighborhood-coding-man/diaporia` currently publishes a static
  site through GitHub Pages; it is **not** a VPS.
- Prior work records mention a local Windows gateway plus Cloudflare tunnel
  `diaporia-playground`, not an independent Linux VPS.
- The user owns `diaporia.com` and administers Cloudflare DNS. This does
  **not** imply that `phase-c.diaporia.com` is presently provisioned.
- There is no connected Hetzner/cloud infrastructure management credential in
  this workflow. Inventory, payment account, DNS and server provisioning require
  the account owner/operator. DO NOT claim any machine is provisioned.

## Intended layout

`Cloudflare Proxied DNS phase-c.diaporia.com → Linux VPS public IP :443 → Caddy → 127.0.0.1:8791 Phase C Merchant`.

DIAPORIA's MCP gateway should remain loopback-only; do NOT expose its dev bearer
tokens, KERNEL browser URLs, SSH, RDP, dashboard, or internal ports publicly.
Merchant order mutations remain Sandbox-only and owner-signature gated.

## Operator checklist before spending

1. Open the actual cloud-provider console and inspect existing servers, IPs,
   bills and powered-on status. **Reuse a verified isolated VPS** if available.
   Do not infer existence merely from a GitHub repo, Cloudflare tunnel or a
   hostname; record the cloud server ID and region privately.
2. If none exists, create **one** low-cost Ubuntu 24.04 LTS x86_64 VPS, with
   persistent root disk and public IPv4, named `diaporia-phase-c`. Select a
   plan whose exact displayed price is acceptable *before* clicking Create/Buy.
   Pick a region and size available to that account. The test merchant is a
   simple Node HTTP service; there is no GPU requirement.
3. Add only the owner's **SSH public key** at creation. Enable provider firewall:
   TCP/22 from the operator's source IP only; TCP/443 from Cloudflare-published
   proxy IP ranges if practical; no public 8791, databases, Docker socket or
   DIAPORIA MCP endpoint. Never put SSH private keys in GitHub.
4. In Cloudflare DNS, add `A phase-c → <VPS IPv4>`, **Proxied**. Leave the apex
   `diaporia.com` and existing tunnel records unchanged.
5. Issue a Cloudflare Origin CA cert covering `phase-c.diaporia.com`; securely
   install its certificate and key on the VPS at the paths in
   [deploy/phase-c/Caddyfile.example](../deploy/phase-c/Caddyfile.example).
   Use Cloudflare **Full (strict)** for this hostname (via a scoped
   Configuration Rule if the zone-wide setting would disturb other hosts).
   Never commit the origin private key.
6. Install Caddy and place the reviewed Caddyfile in its configuration.
   The sample blocks `/operator/*` at the public reverse proxy, leaving that
   diagnostic surface available **only** over localhost after SSH login.
7. Create a dedicated `diaporia-merchant` OS account, clone the **exact approved
   commit**, `npm ci`, `npm run build`, and review the built artifact hashes.
   Put credentials and owner **public** key in restricted server-only files,
   not a GitHub commit. Keep the owner Ed25519 **private** key off the VPS.
   Provision persistent `MERCHANT_DATA_DIR` and check lease/counter ownership.
8. For an initial **MOCK-only** deployment, use `MERCHANT_CHECKOUT_MODE=MOCK`
   and **no** Sandbox secret or owner approval digest. Run local checks and
   review the Caddy routing; this is not approval to expose it publicly.
9. For real C1, follow the signed, commit-pinned Phase C operator checklist.
   Requires separate owner approval of **the exact HTTPS origin, seller account,
   code hashes, deployment hosts, egress allowlist, KERNEL browser count,
   expiry and estimated spend**. C1 may create at most one Sandbox order and
   must not capture. C2 requires a new approval.

## Important limitations

- KERNEL `allowed_hosts` is not a VM-level egress firewall or complete
  DNS-rebinding defense; code review plus bounded negative network test remain
  necessary.
- A dollar value in the signed statement is an **estimate, not an enforced
  KERNEL monetary budget**. Use account-side limit and human supervision.
- The durable KERNEL ledger is shared only by processes accessing the same
  persistent home directory; other hosts/OS users are not automatically capped.
- A public Origin CA certificate is trusted between Cloudflare and your
  origin with Full (strict), **not** as a general public browser TLS certificate
  for direct origin bypass.
- All external deployment, DNS edits, purchases, Sandbox orders/captures,
  and paid KERNEL calls are **NOT AUTHORIZED by this preparation PR**.

## Authoritative references

- Hetzner Create Server: https://docs.hetzner.com/cloud/servers/getting-started/creating-a-server/
- Hetzner Cloud pricing: https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/
- Cloudflare subdomain: https://developers.cloudflare.com/dns/manage-dns-records/how-to/create-subdomain/
- Cloudflare Origin CA: https://developers.cloudflare.com/ssl/origin-configuration/origin-ca/
- Cloudflare Full (strict): https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/full-strict/
- Phase C's required owner approval: [PHASE_C_OPERATOR_CHECKLIST.md](PHASE_C_OPERATOR_CHECKLIST.md)
