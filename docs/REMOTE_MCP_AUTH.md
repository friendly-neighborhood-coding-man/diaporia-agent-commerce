# Remote MCP authentication (OAuth 2.1)

`DIAPORIA_AUTH_MODE=oauth` replaces static dev tokens with an OAuth 2.1 authorization server built into the service. It follows the MCP authorization spec so a remote MCP client can discover, register and authenticate without manual token copying.

| Standard | What the server does |
|---|---|
| RFC 9728 | `GET /.well-known/oauth-protected-resource` (and `/mcp` suffix). Every 401 from `/mcp` carries `WWW-Authenticate: Bearer resource_metadata="…"` |
| RFC 8414 | `GET /.well-known/oauth-authorization-server` |
| RFC 7591 | `POST /oauth/register`: public clients (`none`, PKCE) or confidential (`client_secret_post` / `client_secret_basic`). Redirect URIs must be `https`, or `http` on loopback. At most 5 URIs, 1000 clients |
| OAuth 2.1 | Authorization code only, PKCE `S256` mandatory, exact redirect URI match (loopback may change port, RFC 8252 §7.3), single-use 60 s codes; replaying a code revokes the tokens it produced |
| RFC 8707 | Tokens are bound to `<origin>/mcp`; a token for another resource is refused |
| Refresh | 30-day refresh tokens rotate on every use; reuse revokes the whole grant; a refresh cannot widen scope |
| RFC 7009 | `POST /oauth/revoke` revokes the grant family |
| RFC 9207 | `iss` is returned in the authorization response |

Tokens are opaque random strings; only SHA-256 hashes are stored (SQLite tables `oauth_clients`, `oauth_codes`, `oauth_tokens`). Access tokens live 1 hour.

## Who consents

The consent page (`GET /oauth/authorize`) names the self-registered client (its name is not verified), shows where the browser returns, and lists each requested scope with a checkbox, so the owner can grant less than asked. The human authenticates with their **owner key**, the same human-held secret that creates purchase mandates. A client that asks for no scope gets `purchase.research purchase.read`, never `purchase.prepare`.

An OAuth access token is an AI-client credential. It cannot create a mandate, reach `/owner/*`, or authorize spending. That is the same boundary dev tokens already had.

## Where payment tools exist

| Deployment | Research / read tools | `prepare_checkout`, `prepare_browser_checkout` | Owner, PayPal return, handoff routes |
|---|---|---|---|
| `oauth`, loopback host + loopback base URL | yes | yes, with the `purchase.prepare` scope | yes |
| `oauth`, public https base URL | yes | **not offered** | **403** |
| `dev`, loopback | yes | yes | yes |
| `public-readonly-demo` | anonymous | no | 403 |

A public deployment stays research/read only until an independent security review approves payment-capable routes. No flag in this code turns them on.

## Verified (offline, `tests/oauth.test.ts`)

- The official MCP TypeScript SDK client (`@modelcontextprotocol/sdk` 1.32.2, `StreamableHTTPClientTransport` + `OAuthClientProvider`) completes discovery, dynamic registration, PKCE authorization and token exchange against this server, then lists tools and runs research/compare.
- Negative cases: unregistered redirect (no redirect issued), PKCE `plain`, wrong resource, wrong owner key, denial, CSRF mismatch, empty grant, verifier mismatch, code replay (tokens revoked), stolen code from another client, expiry, refresh reuse, scope widening, audience mismatch, revocation, confidential client without secret, cross-user reads, OAuth token used as an owner key.

## Not verified

- No real remote host (ChatGPT, Claude, Grok) has connected yet. That needs a public HTTPS deployment, which needs the owner's approval. Identical tool calls do not prove equivalent platform onboarding: each platform's connector UI, redirect URI and accepted auth methods must be checked on its own.
- Owner-key login is a stand-in for a real identity provider. Multi-user production needs an IdP and per-user owner credentials.
- Rate limits are per-process, in-memory. A multi-node deployment needs a shared store.
