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
npm run dev             # http://127.0.0.1:8790/mcp; dev credentials are written to .data/dev-credentials.json (gitignored)
```

Write `mcp.json` with the `clientToken` from `.data/dev-credentials.json`:

```json
{"mcpServers":{"diaporia":{"type":"http","url":"http://127.0.0.1:8790/mcp","headers":{"Authorization":"Bearer <clientToken>"}}}}
```

```bash
claude -p "Use the diaporia tools to research 'Buy Sony WH-CH720N Black, never exceed $60', compare offers for destination US/CA, then prepare checkout for the lowest PayPal-checkoutable offer with a 6000 cent maximum." --mcp-config mcp.json --strict-mcp-config
```

Interactive use also works with `claude mcp add --transport http diaporia http://127.0.0.1:8790/mcp --header "Authorization: Bearer <clientToken>"`.

The owner (not the AI) creates spending limits:

```bash
npm run mandate:create -- --brand Sony --model WH-CH720N --variant Black --sku WHCH720N/B --max 60.00
```

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
