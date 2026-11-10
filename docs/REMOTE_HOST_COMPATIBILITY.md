# Remote AI host compatibility (research/read-only MCP)

Researched 2026-11-10; client model changed the same day to operator-registered clients (Gate R re-check). **No remote host has connected to DIAPORIA.** Every row below is PROPOSED compatibility from documentation, not verified compatibility. A host becomes REMOTE_VERIFIED only after gate A5 (REMOTE_MCP_SECURITY_GATES.md) succeeds for that host. Local CLI support does not imply web-app support. Nothing here claims marketplace or directory listing, or platform approval.

Source quality: **[read]** = official page opened and read; **[excerpt]** = official page could not be opened from the build environment (network policy), so the row relies on search-engine excerpts of that official page and must be re-read before gate A5.

## What DIAPORIA offers a host

| Item | Value |
|---|---|
| MCP URL (enter this in the host) | `https://<hostname>/mcp` (proposed `https://mcp.diaporia.com/mcp`) |
| Transport | Streamable HTTP, stateless, JSON responses; protocol 2025-11-25 negotiated, older accepted. No SSE endpoint. |
| 401 challenge | `WWW-Authenticate: Bearer resource_metadata="https://<hostname>/.well-known/oauth-protected-resource", scope="purchase.research purchase.read"` |
| Protected resource metadata (RFC 9728) | `resource` = `https://<hostname>/mcp` exactly; `authorization_servers` = [`https://<hostname>`]; also at `/.well-known/oauth-protected-resource/mcp` |
| AS metadata (RFC 8414) | `/.well-known/oauth-authorization-server`; no OIDC discovery |
| Client registration | **Operator-registered confidential clients only** (`client_secret_basic` or `client_secret_post`, plus PKCE), one per host and user, created offline with `npm run remote:oauth-client` and loaded from `DIAPORIA_OAUTH_CLIENTS`. Dynamic Client Registration is **closed** (no `registration_endpoint`; `/oauth/register` refused). **No CIMD.** |
| PKCE / grants | S256 only; authorization code + refresh (rotating; reuse revokes the grant; absolute grant age 24 h by default) |
| Resource indicators (RFC 8707), `iss` (RFC 9207) | yes, both |
| Scopes | `purchase.research purchase.read`. `offline_access` is not listed (refresh tokens are issued without it). |
| Redirect allowlist (default) | `https://claude.ai/api/mcp/auth_callback`, `https://chatgpt.com/connector_platform_oauth_redirect`, `https://chatgpt.com/connector/oauth/*`, loopback `http://127.0.0.1|localhost|[::1]:<any port>/…`. Change with `DIAPORIA_ALLOWED_REDIRECT_URIS`. |
| Human sign-in | DIAPORIA consent page; the user types a remote-only owner key (`drk_…`) in their own browser. The AI host never receives it. |

## Hosts

### 1. Claude (claude.ai web, Desktop, mobile) — first target [read]

- **Connection:** Pro/Max/Free: Customize → Connectors → Add custom connector → URL. Team/Enterprise: an Owner adds it under Organization settings → Connectors, members then Connect. Free accounts are limited to one custom connector.
- **Client registration:** the "OAuth client" choice offers Claude's published identity (CIMD), "Register automatically" (DCR) or **"Use your own OAuth client" (client ID and optional secret)**. DIAPORIA's remote profile accepts only the last: the operator creates one client per user (`npm run remote:oauth-client -- --user <user> --name "Claude (<user>)" --redirect https://claude.ai/api/mcp/auth_callback`) and hands that user the client ID and secret out of band. Whether Claude sends the secret with `client_secret_basic` or `client_secret_post` is not documented; both are accepted. **To confirm at A5.**
- **Redirect URI:** `https://claude.ai/api/mcp/auth_callback` (allowlisted). Claude Code uses `http://localhost:<port>/callback` and `http://127.0.0.1:<port>/callback` (allowlisted as loopback).
- **Requirements that DIAPORIA meets (by design; to be confirmed at A5):** sign-in starts only from a 401 (yes); PRM `resource` equals the entered URL including `/mcp` (yes); first `authorization_servers` entry used (single entry); token endpoint accepts form bodies and returns `invalid_grant` for dead refresh tokens (yes); refresh rotation for public clients (yes); 10 s discovery/registration/token timeouts (local p50 well under 1 s, unmeasured remotely).
- **Network:** Claude's egress range is documented as `160.79.104.0/21`. Do not put a WAF/IP filter in front of the MCP or AS host that drops it. App rate limits key on the client address Caddy sees.
- **Claude API MCP connector (beta):** the caller passes `authorization_token`; the API runs no OAuth flow. Possible only after A4 with a token obtained interactively (e.g. MCP Inspector).
- **Unknown:** whether a claude.com callback exists (none documented); timeouts under real latency.
- Sources: https://claude.com/docs/connectors/building/authentication.md · https://claude.com/docs/connectors/custom/add-unlisted · https://support.claude.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp · https://platform.claude.com/docs/en/agents-and-tools/mcp-connector

### 2. ChatGPT [excerpt]

- **Connection:** custom MCP server added from the apps/plugins settings (developer mode history; current UI wording unconfirmed). Per-plan eligibility is **conflicting** in the excerpts (Business/Enterprise/Edu full MCP; Pro possibly read/fetch only). Publishing to a directory needs a separate review; not in scope.
- **Client registration:** CIMD, DCR and predefined clients are documented; DIAPORIA needs the **predefined client** path (client ID + secret). Whether the current ChatGPT UI exposes it for custom connectors is **unknown until tested**.
- **Redirect URI:** with RFC 9207 support (DIAPORIA advertises `authorization_response_iss_parameter_supported: true` and returns `iss`), ChatGPT is documented to use `https://chatgpt.com/connector_platform_oauth_redirect`; otherwise `https://chatgpt.com/connector/oauth/{callback_id}`. Both allowlisted.
- **Tools:** some docs say deep research / company knowledge need read-only `search` and `fetch` tools; DIAPORIA does not expose tools with those names. Normal chat use of custom tools should not need them. **Unknown until tested.**
- **Unknown:** current plan eligibility, egress IPs, transport list, write-tool confirmation UX (irrelevant here: all tools are read-only).
- Sources (excerpt only): https://developers.openai.com/apps-sdk/build/auth · https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt · https://developers.openai.com/api/docs/mcp

### 3. Grok / xAI [excerpt]

- **Consumer app:** a custom connector at grok.com (New Connector → Custom → URL) is described; localhost/private IPs rejected. **OAuth mechanism (DCR or CIMD) and redirect URI are unknown**, so the redirect allowlist must be extended with Grok's callback once known. BLOCKED until documented or observed.
- **xAI API remote MCP tools:** `server_url`, `server_label`, `authorization` (sent as the Authorization header), `allowed_tools`; no OAuth flow. A test needs a token obtained interactively first.
- Sources (excerpt only): https://docs.x.ai/developers/tools/remote-mcp · https://docs.x.ai/grok/connectors

### 4. Others (brief)

| Host | Fit | Notes |
|---|---|---|
| MCP Inspector (local) [read] | good for A3/A4 smoke tests | accepts a manual client ID/secret; sends `resource`, validates `iss`; default callback `http://localhost:6274/oauth/callback` (loopback, allowlisted; register it for the client) |
| Gemini CLI (local) [read] | uncertain | Streamable HTTP via `httpUrl`; documented with DCR; a static client needs to be configurable |
| Mistral Le Chat [excerpt] | uncertain | OAuth 2.1 + DCR documented; static clients unknown; callback unknown |
| Microsoft Copilot Studio [excerpt] | uncertain | "Manual" OAuth option takes a client ID/secret; callback unknown |
| VS Code, Cursor | unknown | docs not reachable from the build environment |

## 5. Remote-host connection test package (gate A5, one host)

Prerequisites: gates A1–A4 approved and done; the owner holds a `drk_` key for a named test user; window end time set.

1. In the host, add the connector with URL `https://<hostname>/mcp` (Claude: choose "Use your own OAuth client" and enter the client ID and secret registered for this user).
2. The host opens the DIAPORIA consent page. Check it says the client was registered by the operator for this user's account only, shows the callback host, and only "research" and "read" scopes. Enter the owner key; approve.
3. Confirm the host lists exactly: `research_purchase`, `compare_purchase_offers`, `get_checkout_status`, `get_purchase_receipt`, `get_usage_summary`.
4. Prompts (MOCK fixtures; expected behaviour in brackets):
   1. "Find Sony WH-CH720N headphones in black, new, for the lowest total price under $60, shipping to California." [candidates with evidence, then a comparison with item/shipping/tax/fees totals; `dataSource.mockData: true`]
   2. "Compare the offers you found and tell me what is still unknown about the total and the merchant." [unknown components and merchant identity status reported, not guessed]
   3. "I want wireless noise-cancelling headphones under $100." [several candidates (Sony and fictional demo brands), each with suitability and per-capability evidence status]
   4. "Buy the cheapest one now." [the host must say it cannot purchase through this connection; no tool for it exists]
   5. "What is the status of checkout cs_00000000-0000-4000-8000-000000000000?" [not found]
   6. "Show my usage this month." [usage summary, no charge]
5. Record for the evidence manifest: host and plan, timestamps (UTC), the discovery/registration/consent screens, the tool list as shown, each tool call and result, and whether the host's wording keeps research apart from purchase (Semantic Fidelity: never "purchased", "ordered" or "paid"). Keep raw transcripts private; store hashes in the manifest.
6. Afterwards: remove the connector in the host; revoke the grant (remove the client entry or rotate the user's key and restart, or stop the service per the window plan).

Pass criteria: OAuth completes with the operator-registered client without manual token copying; all six prompts behave as bracketed; no payment wording. Only then mark that one host REMOTE_VERIFIED, research/read scope only.
