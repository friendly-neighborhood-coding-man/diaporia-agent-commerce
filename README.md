# DIAPORIA Agent Commerce

**Don't switch AI assistants to shop. Bring secure purchasing to the AI you already use.**

A cross-platform AI purchasing engine with evidence-based product research, bounded checkout authorization, and PayPal Sandbox integration. Built for MCP-enabled assistants.

## In 30 seconds

Any MCP client (Claude, ChatGPT, Grok, others) calls five tools on this server:

```
research_purchase → compare_purchase_offers → prepare_checkout → (user approves on PayPal) → get_checkout_status / get_purchase_receipt
```

- The **server** owns product identity, merchant totals, spending limits, payment state and idempotency. The AI only passes requests along.
- **No AI tool can move money.** A purchase needs a spending **mandate** created by the human (with an owner key the AI never holds) **and** the buyer's own approval on PayPal's hosted page.
- A `$6,000` checkout against a `$60` mandate is rejected **before** any PayPal call (see `npm run demo:e2e`, step 4).
- Unknown shipping or tax stays **unknown**; such offers are never ranked as "cheapest". Variant or condition substitutions are refused.
- Merchant and review text is treated as untrusted data; listings that try to instruct the agent are excluded.

## Status (what is real, what is not)

| Capability | Status |
|---|---|
| MCP server (`/mcp`, Streamable HTTP, stateless, official TypeScript SDK 1.32.2) with 5 tools, JSON-schema inputs/outputs, safety annotations | Implemented and tested (automated, real MCP client over HTTP) |
| PRODUCT_DISCOVERY and EXACT_PRODUCT_PURCHASE routing, identity locking, variant/condition mismatch rejection | Implemented and tested on fixtures |
| Merchant offer verification: stock, fresh quotes, total cost with unknowns, budget, eligibility | Implemented and tested on fixtures |
| PurchaseMandate: amount/currency/quantity/product/merchant binding, expiry, revocation, atomic cumulative reservation (SQLite `BEGIN IMMEDIATE` + CHECK constraints) | Implemented and tested |
| Checkout state machine with server-side transition guards, duplicate-capture prevention, UNKNOWN + reconciliation | Implemented and tested with the mock provider |
| Mock PayPal provider (offline, every id prefixed `MOCK`) | Implemented and tested |
| PayPal Sandbox Orders v2 adapter (CAPTURE intent, `PayPal-Request-Id`, Sandbox host only) | Implemented; unit-tested with a fake `fetch`; `npm run preflight:sandbox` verified Sandbox OAuth only. **No Sandbox order, approval or capture has been run yet** |
| Real MCP host: Claude Code CLI → localhost | **Tested** (discovery, research → compare → prepare → status, $6,000 refusal, cross-user and scope boundaries; mock payments). See docs/HOST_TEST_EVIDENCE.md |
| Remote hosts: claude.ai connector, ChatGPT, Grok | **Not tested.** Need a public HTTPS endpoint; only research-only public mode is available without OAuth |
| Production user authentication (OAuth 2.1 for MCP) | **Not implemented.** Dev-only per-user tokens on loopback; public deployments run research-only and payment is disabled |
| Live product research (catalog search, independent evidence) | Not in this public repo. The port `CommerceResearchAdapter` is public; the private DIAPORIA Buy app has an adapter over its Channel3 catalog and manufacturer registry |
| Merchant fulfillment / shipping | Not provided and never claimed. Sandbox payments go to a fictional demo merchant |
| PayPal Agent Ready, Store Sync | Not integrated (see roadmap below) |

## Quick start (no keys, no network)

Requires Node.js 22.13+ (uses the built-in `node:sqlite`).

```bash
npm ci
npm test            # 51 tests
npm run typecheck
npm run demo:e2e    # full MCP purchase path, all MOCK
```

Run the server:

```bash
npm run dev         # http://127.0.0.1:8790/mcp, mock payments, dev credentials written to .data/dev-credentials.json
```

Create a spending mandate as the human owner (in a second terminal):

```bash
npm run mandate:create -- --brand Sony --model WH-CH720N --variant Black --sku WHCH720N/B --max 60.00
```

Then point an MCP client at `http://127.0.0.1:8790/mcp` with header `Authorization: Bearer <clientToken from .data/dev-credentials.json>`. Without a mandate, `prepare_checkout` returns a `userAuthorizationUrl` where the owner can review the checkout and set a limit.

To use PayPal Sandbox instead of the mock, set `PAYMENT_PROVIDER=paypal_sandbox` and Sandbox REST credentials (see `.env.example`). Live credentials are refused by construction.

Every research, compare, prepare, status and receipt result carries `paymentEnvironment` (`MOCK` = no PayPal API at all, `PAYPAL_SANDBOX` = PayPal test environment) and `liveMerchantCheckout: false`. Live PayPal and live merchant checkout are not supported.

## Architecture

```
AI client (Claude / ChatGPT / Grok / any MCP client)
  → /mcp (Streamable HTTP, per-request server bound to one authenticated user)
  → CommerceGateway
      PurchaseIntentRouter · ProductIdentityResolver · CommerceResearchAdapter (port)
      MerchantOfferVerifier · PurchasePolicyEngine + PurchaseMandate
      CheckoutSessionManager (durable state machine) · PurchaseAuditJournal (hash-chained)
  → PaymentProvider port: MockPayPalProvider | PayPalSandboxProvider (Orders v2)
  → buyer approves on PayPal → /paypal/return → server verifies with PayPal, captures once, re-reads capture
  → get_checkout_status / get_purchase_receipt return server-verified state
```

Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · [docs/MCP_TOOLS.md](docs/MCP_TOOLS.md) · [docs/PURCHASE_POLICY.md](docs/PURCHASE_POLICY.md) · [docs/PAYPAL_INTEGRATION.md](docs/PAYPAL_INTEGRATION.md) · [docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md) · [docs/TEST_REPORT.md](docs/TEST_REPORT.md)

## Security model

- AI-client tokens carry `purchase.research`, `purchase.read`, `purchase.prepare`. No scope can create a mandate or capture funds.
- Owner keys (held by the human) create and revoke mandates via `/owner/mandates` or the `/authorize/<checkout>` page (cookie + CSRF, SameSite=Strict).
- Every lookup is scoped by the authenticated user; another user's session returns `NOT_FOUND`.
- Payment execution is enabled only when auth mode is `dev`, the server binds to loopback, and the public base URL is loopback. Anything else returns `HOLD / PUBLIC_PAYMENT_DISABLED`.
- Host-header and Origin allowlists (DNS-rebinding protection), 64 KiB body limit, per-token rate limits, 30 s request timeout.
- PayPal credentials stay server-side; errors carry only HTTP status and PayPal debug id; audit records are redacted.
- Known gaps: no OAuth, in-memory rate limiter and owner-page sessions (single process), no webhook listener (status comes from synchronous verification and explicit reconciliation).

Credentials needed for anything beyond the mock demo: PayPal Sandbox REST app (`PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`) for the Sandbox path, and a public HTTPS tunnel or host for remote AI clients.

## PayPal Agentic Commerce — Integration Roadmap

DIAPORIA Agent Commerce is designed to complement PayPal's agentic commerce infrastructure.

Our current implementation uses PayPal Sandbox APIs for checkout demonstration and transaction verification.

PayPal Agent Ready and Store Sync are not integrated in this version because the project does not currently have the applicable onboarding or eligibility arrangements.

We would welcome the opportunity to integrate these services once the appropriate developer and merchant access becomes available.

Our goal is to make PayPal-compatible purchasing available through the AI assistant users already prefer, while preserving transaction authorization, merchant integrity, and evidence-based purchasing decisions.

Future ports are reserved in `src/roadmap/paypalAgenticCommerce.ts` (interfaces only; no mock implementations). This project has no official PayPal partnership or endorsement.

References: [Agent Ready](https://developer.paypal.com/agent-ready/overview/) · [Store Sync](https://developer.paypal.com/store-sync/overview) · [Agentic commerce services](https://developer.paypal.com/agentic-commerce-services/about/) · [Orders API](https://developer.paypal.com/api/rest/integration/orders-api) · [Model Context Protocol](https://modelcontextprotocol.io/)

## License

Not yet in effect. MIT is proposed in `LICENSE.MIT.proposed` pending the owner's approval and code-ownership confirmation; all 95 production dependencies are MIT/ISC/BSD. Until a `LICENSE` file exists, all rights are reserved.
