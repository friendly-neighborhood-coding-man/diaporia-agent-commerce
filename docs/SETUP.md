# Setup

Requires Node.js 22.13+ (built-in `node:sqlite`). Everything below works **without any paid credentials** unless marked.

```bash
npm ci
npm test
npm run typecheck
npm run build
```

## 1. Mock demos (no keys)

```bash
npm run demo:e2e        # MCP purchase path: research → compare → $6,000 refusal → $59.39 checkout → capture (MOCK PayPal)
npm run demo:identity   # merchant identity: valid merchant vs impersonator with stolen registration details
npm run demo:service    # evidence routing + usage ledger; community vs simulated managed billing
npm run demo:quote      # discovery → Shopify cart estimate (synthetic fixture) → external checkout handoff
```

## 2. Local MCP server for Claude Code

```bash
npm run dev             # http://127.0.0.1:8790/mcp; the AI-client token is written to .data/dev-credentials.json (gitignored)
```

`npm run dev` runs as your own account, the same one as your AI host, so it starts with **research and comparison
only**: checkout preparation, browser handoff and the owner pages stay disabled (`service isolation NOT established`)
until you set up the service account below ("Service account").

Write `mcp.json` with the `clientToken` from `.data/dev-credentials.json`:

```json
{"mcpServers":{"diaporia":{"type":"http","url":"http://127.0.0.1:8790/mcp","headers":{"Authorization":"Bearer <clientToken>"}}}}
```

```bash
claude -p "Use the diaporia tools to research 'Buy Sony WH-CH720N Black, never exceed $60', compare offers for destination US/CA, then prepare checkout for the lowest PayPal-checkoutable offer with a 6000 cent maximum." --mcp-config mcp.json --strict-mcp-config
```

Interactive use also works with `claude mcp add --transport http diaporia http://127.0.0.1:8790/mcp --header "Authorization: Bearer <clientToken>"`.

The owner (not the AI) creates spending limits, typing the owner key when asked:

```bash
npm run mandate:create -- --brand Sony --model WH-CH720N --variant Black --sku WHCH720N/B --max 60.00
```

### Service account (required for payment-facing operations)

V2.2 (H-2): an AI host that runs as the same OS account as DIAPORIA can open its SQLite database and write an
owner confirmation, or delete an open requirement, and it can edit DIAPORIA's code. No check inside the application
can stop that. So DIAPORIA runs under **its own OS account**, and your AI host's account can neither read nor change its
database (including the WAL and SHM files), its data folder, its code or its configuration.

At startup the server checks this and logs `service isolation: established` or `service isolation NOT established`
with every reason. When it is not established, **checkout preparation, browser handoff and every owner page are
disabled** (research and comparison still work). It checks that:

- the server does not run as root, and its account is not one of the AI host accounts you declare in
  `DIAPORIA_AI_HOST_UIDS` (numbers or names; required);
- the data folder and every database file are owned by the server account with no group or other access (700/600);
- every file of the code it runs (`src`, `node_modules`, `package.json`, `tsconfig*.json`, `dist`, `.env*`, the Node
  binary, following links) is not owned by an AI host account and not group- or world-writable;
- no folder above the data, the code or the Node binary is owned by an AI host account or writable by others;
- the owner registry boundary below is established, and the registry is not owned by an AI host account either.

On Linux or WSL, run the setup yourself (never let an AI assistant run it), from your DIAPORIA checkout after `npm ci`:

```bash
sudo scripts/setup-service-account.sh --ai-user "$USER"      # the account your AI host runs as
sudo npx tsx scripts/owner-enroll.ts --registry /etc/diaporia/owners.json --user demo-user --new-owner-key
sudo /opt/diaporia/bin/diaporia-server                      # starts DIAPORIA as the diaporia account
```

The setup script creates the `diaporia` system account, copies the code to `/opt/diaporia/app` (owned by root), creates
`/var/lib/diaporia` (700, `diaporia`), writes `/etc/diaporia/server.env` (root:diaporia, 640) with a new AI-client
token, and gives your AI host its own copy of that token only, in `~/.config/diaporia/client-token`. Configure your AI
host with that token (Bearer) and `http://localhost:8790/mcp`. After you update the checkout, run the setup script again
so the installed copy is updated. On macOS, do the same steps by hand (a separate standard user for the server, a
root-owned copy of the code, a 700 data folder), and set `DIAPORIA_AI_HOST_UIDS`.

Keep your AI host's account from becoming the `diaporia` account or root without you: `sudo` must ask for your password,
and the account should not be in the `docker` or `lxd` group. The server logs a warning when an AI host account is in
`sudo`, `wheel`, `admin`, `docker` or `lxd`.

`scripts/service-isolation-e2e.ts` reproduces the independent reviewer's database attack with real OS accounts (run it
as root on a disposable machine only).

### Owner confirmation (separate OS account + passkey)

Confirming a research hold needs a **passkey with user verification** (fingerprint, face or PIN) on the owner's own
device, enrolled in an **owner registry file administered by root** (not by the `diaporia` account and not by your AI
host's account). The server holds owner-key hashes and passkey public keys only.

1. As root, create the registry outside the DIAPORIA folders: `sudo mkdir -p /etc/diaporia && sudo npx tsx
   scripts/owner-enroll.ts --registry /etc/diaporia/owners.json --user demo-user --new-owner-key`. The owner key is
   printed once; keep it yourself. (The setup script already points `DIAPORIA_OWNER_REGISTRY` at this path.)
2. Start the server (`sudo /opt/diaporia/bin/diaporia-server`; passkeys need a host name, so it uses
   `PUBLIC_BASE_URL=http://localhost:8790`).
3. Open `http://localhost:8790/research-holds/passkey-setup` in your browser, create a passkey for `demo-user`, and
   enroll the printed JSON: `sudo npx tsx scripts/owner-enroll.ts --registry /etc/diaporia/owners.json --add-passkey '<JSON>'`.
   Restart the server.

The server checks at startup that the registry and every directory above it are outside its working tree and data
directory, are not owned by its own OS account or an AI host account, and are not writable by others. If any check
fails, or `DIAPORIA_OWNER_REGISTRY` is unset, it logs `owner confirmation UNAVAILABLE: <reason>` and no research hold
can be confirmed (fail closed). Every later gate check verifies each stored confirmation's passkey signature again
against the registry; a confirmation written into the database by anything else does not count.

## 3. Real research providers (optional, paid by you)

| Provider | Variable | Status in this repo |
|---|---|---|
| Channel3 catalog search | `CHANNEL3_API_KEY` + `RESEARCH_PROVIDER=channel3` | Live adapter (`Channel3ResearchAdapter`); one live call made on 2026-11-09 |
| Tavily independent search | `TAVILY_API_KEY` + `EVIDENCE_PROVIDERS=byok` | Live adapter (`TavilySearch`); one live call made on 2026-11-09 |
| KERNEL page inspection | `KERNEL_API_KEY` + `EVIDENCE_PROVIDERS=byok` (+ `TAVILY_API_KEY`) | BYOK adapter (`KernelPageInspector`, plain HTTPS to `api.onkernel.com`). **Paid per browser-second. Fake-HTTP tested only; no live KERNEL call has been made from this repository.** At most 1 session per request, `KERNEL_MAX_SESSIONS` per process (default 20) |

A bounded live smoke test refuses to run without `--confirm-live` and enforces per-request call caps. Supplier prices are recorded as **unknown**:

```bash
node --env-file=<your env file> --import tsx scripts/live-smoke.ts --confirm-live
```

KERNEL is never used by the smoke test unless you also pass `--allow-kernel` (one browser session at most, `LIVE_MAX_KERNEL` to change). Run it only after deciding to spend KERNEL credit.

## 4. PayPal Sandbox (optional; Sandbox only, Live is refused)

1. Create a PayPal Developer **Sandbox** REST app.
2. Note your Sandbox **business** account's merchant ID.
3. Create a Sandbox **personal** buyer account.
4. Put these in a local, gitignored env file:

   ```
   PAYMENT_PROVIDER=paypal_sandbox
   PAYPAL_ENV=SANDBOX
   PAYPAL_CLIENT_ID=...
   PAYPAL_CLIENT_SECRET=...
   PAYPAL_SANDBOX_PAYEE_MERCHANT_ID=...
   ```

5. Run the preflight. It makes OAuth calls only and creates no order:

   ```bash
   npm run preflight:sandbox -- --env-file <env file>
   ```

6. Start the server (`node --env-file=<env file> dist/src/main.js` after `npm run build`). Create a $60 mandate, prepare the checkout through your MCP client, open the returned `https://www.sandbox.paypal.com/…` link, and approve as the Sandbox buyer **on the same machine**, because the return URL is `127.0.0.1`.

The server verifies the order, amount and recipient, captures once, and reports `COMPLETED` or `CAPTURE_PENDING`.

## 5. Merchant quotes from a Shopify development store (optional)

```bash
SHOPIFY_STORE_DOMAIN=<dev-store>.myshopify.com SHOPIFY_VARIANT_ID=gid://shopify/ProductVariant/<id> npm run smoke:shopify
```

## Never commit

`.env*` (except `.env.example`), `.data/`, and Sandbox credentials. `npm run scan:secrets` checks tracked files.
