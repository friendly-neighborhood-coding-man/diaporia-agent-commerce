# Four-host MCP interoperability

The same DIAPORIA MCP server was used by four independent AI hosts, each through its own MCP client. The server was this repository at `ac0a4c1`, with no changes for any host. **No payment state machine, purchase policy, authorization or validation was changed for any host.** No PayPal call and no paid research call was made.

### What is live and what is mock

| Layer | Evidence class | What it shows |
|---|---|---|
| **Host interoperability**: discovery, auth, the real host-originated `tools/call`, response shape | **LIVE**, real installed host clients on a local machine | Each host's own MCP client spoke Streamable HTTP to this server. Shown in each host's transcript and in the server's wire log. |
| **Commerce data inside the response**: catalog, Sony fixture, manufacturer citation, listing price | **MOCK fixtures** (`dataSource` = mock fixtures, `paymentEffect` = no payment) | Deterministic data, so the four results can be compared field by field. This is not live research evidence. Live Channel3 and Tavily evidence is separate, in `docs/TEST_REPORT.md` and `docs/evidence/live-*.json`. |
| **Model behind each host** | Live, from each host's own provider | Claude Code: its default Claude model. Codex: its default OpenAI model. Grok: its default xAI model ($0.07 for the run). Hermes: **Claude Haiku**, model alias `haiku`, through the `claude-subscription-directsdk-experimental` provider plugin on the owner's Claude subscription. |

## Result

<!-- MATRIX:START -->
| Host | Version | Client seen by server (User-Agent / clientInfo) | Result | How the call was made |
|---|---|---|---|---|
| Claude Code | Claude Code 2.1.310 | claude-code/2.1.310 (claude-desktop, agent-sdk/0.3.317) / claude-code 2.1.310 | **PASS** | `claude -p`, model from the CLI default; native MCP tool `mcp__diaporia__research_purchase` |
| OpenAI Codex CLI | codex-cli 0.160.0 (codex exec --json) | codex-mcp-client/0.160.0 / codex-mcp-client 0.160.0 | **PASS** | `codex exec --json`; `mcp_tool_call` item |
| xAI Grok Build | grok 1.0.77 (50ca579fa996) [stable] | grok-cli/1.0.77 (discovery checks earlier also seen from 1.0.52) / grok-shell-diaporia 1.0.77 | **PASS** | `grok -p`; MCP tool reached through Grok’s built-in deferred-tool helper `use_tool` (`diaporia__research_purchase`) |
| Nous Research Hermes Agent | Hermes Agent v0.22.7 (2026.9.24) · stable | python-httpx2/2.15.1 / hermes-agent 0.22.7 | **PASS** | `hermes chat --oneshot`; model **Claude Haiku** (`haiku`) via the Claude subscription provider plugin; Hermes’ own MCP client executes `mcp__diaporia__research_purchase` |

All four `research_purchase` results are identical on every compared field: mode, state, intent, identity, candidates, unknowns, data source and payment effect. Session IDs differ by design. Each session is stored under its own host user id, and each has its own hash-chained audit events (`RESEARCH_STARTED`, `RESEARCHED`) and a MOCK usage record with 0 billable. A request without a token got **401**.
<!-- MATRIX:END -->

**PASS** means all nine checks in [`scripts/interop/build-evidence.mjs`](../scripts/interop/build-evidence.mjs) hold. In particular, the server saw the call from that host's own token, the host's own transcript shows it issued the call, and the result matches the reference result field for field. **NOT_TESTED** means no host-originated tool call happened. Compatibility is never inferred from discovery alone.

## Fixture scenario (reproducible)

- **Server:** `npm run build`, then `dist/src/main.js` with `PAYMENT_PROVIDER=mock`, no research or evidence keys (MOCK catalog and MOCK evidence), `HOST=127.0.0.1`, `PORT=18791`, its own SQLite file.
- **Auth:** one development bearer token per host, set through `DIAPORIA_DEV_TOKENS` with scopes `purchase.research,purchase.read` only. Each token maps to its own user id (`interop-<host>`), so the server attributes every session to the host that made it. `prepare_checkout` needs `purchase.prepare`, so it is not offered to any host. Tokens live only in the gitignored `.data/interop/`.
- **Wire evidence:** [`scripts/interop/audit-proxy.mjs`](../scripts/interop/audit-proxy.mjs) is a transparent loopback proxy on `127.0.0.1:18790`. It forwards bytes unchanged and logs each JSON-RPC message with the token's SHA-256 fingerprint, never the token. Hosts connect to `http://127.0.0.1:18790/mcp`.
- **Identical prompt for every host** (`.data/interop/prompt.txt`):

  > Use the MCP server named diaporia. List its tools, then call the tool research_purchase exactly once with exactly these arguments: `{"request":"Buy Sony WH-CH720N Black","currency":"USD","budgetMinor":6000,"mustHave":["active_noise_cancellation"]}`. Do not call any other tool and do not use any other way to reach the server. Then report: the tool names you saw, and from the result: mode, state, identity.status, identity.lockedIdentity, and the number of candidates.

- **Expected semantics:**
  - `mode EXACT_PRODUCT_PURCHASE`, `state RESEARCHED`
  - `identity LOCKED` to Sony WH-CH720N Black, new, SKU `WHCH720N/B`
  - 1 candidate, with `active_noise_cancellation` `VERIFIED_TRUE` from a MANUFACTURER fixture citation
  - listing price 3999 USD cents, labelled as not a checkout total
  - `paymentEffect` stating that no payment happened

No public tunnel is used. Everything is bound to 127.0.0.1.

## Per-host setup

The examples use `$TOKEN` for that host's dev token. Never paste a token into a shared file or a public tunnel.

### Claude Code (CLI)

```json
{"mcpServers":{"diaporia":{"type":"http","url":"http://127.0.0.1:18790/mcp","headers":{"Authorization":"Bearer $TOKEN"}}}}
```

```bash
claude -p "$(cat .data/interop/prompt.txt)" --mcp-config .data/interop/claude-mcp.json --strict-mcp-config --allowedTools mcp__diaporia__research_purchase --output-format stream-json --verbose
```

### OpenAI Codex CLI

No config file is written. Use `-c` overrides plus an environment variable holding the token:

```bash
DIAPORIA_INTEROP_TOKEN=$TOKEN codex exec --json --ephemeral --skip-git-repo-check -s read-only -c 'mcp_servers.diaporia.url="http://127.0.0.1:18790/mcp"' -c 'mcp_servers.diaporia.bearer_token_env_var="DIAPORIA_INTEROP_TOKEN"' "$(cat .data/interop/prompt.txt)"
```

### xAI Grok Build

Grok does not start project-scoped (`.grok/config.toml`) MCP servers in an untrusted folder, and a `GROK_CONFIG_PATH` overlay did not register the server. The working setup is user scope; remove it afterwards.

```bash
grok mcp add -s user -t http -H "Authorization: Bearer $TOKEN" diaporia http://127.0.0.1:18790/mcp
grok mcp doctor            # expect: handshake OK, 5 tools
grok -p "$(cat .data/interop/prompt.txt)" --output-format streaming-json --allow mcp__diaporia__research_purchase --disable-web-search
grok mcp remove diaporia
```

Grok needs `grok login` (or `XAI_API_KEY`) before `-p` can call the model.

### Nous Research Hermes Agent

The verified run used a **separate, disposable `HERMES_HOME`** (`.data/interop/hermes-home`), not the user's normal Hermes home. That home has:

- the official `claude-subscription-directsdk-experimental` model-provider plugin (model `haiku`, the user's Claude subscription);
- no Hermes toolsets, memory or fallback providers;
- this MCP server as the only MCP server:

```yaml
mcp_servers:
  diaporia:
    url: "http://127.0.0.1:18790/mcp"
    headers:
      Authorization: "Bearer $TOKEN"
```

```bash
export HERMES_HOME=<path to the disposable home>
hermes mcp test diaporia   # expect: Connected, 5 tools
hermes chat --query-file .data/interop/prompt.txt --oneshot -Q --format stream-json --max-turns 6
```

The model only *proposes* the tool call. Hermes' own MCP client executes it: the server saw `clientInfo hermes-agent 0.22.7` over `python-httpx2`. The provider's native Claude Code MCP is inert and denied execution.

Hermes also used two host-internal helpers first (`tool_search`, `tool_describe`). These are Hermes tools, not server calls.

Launch notes:

- Remove `OPENROUTER_API_KEY` from the launch environment. Hermes otherwise ingests it as a paid fallback credential.
- Remove `ANTHROPIC_*` and `CLAUDE*` variables inherited from a parent Claude Code session. The provider plugin refuses `ANTHROPIC_BASE_URL` overrides.
- Hermes auto-starts a gateway that keeps the environment of its first launch. If that environment was wrong, stop that home's gateway before retrying.

## Protocol observations (no adaptation was needed)

- **Discovery probe.** Claude Code 2.1.310 and Grok 1.0.52/1.0.77 first send `server/discover` with protocol `2026-07-28`. This server (MCP TypeScript SDK 1.32.2) answers 400, and both hosts fall back to `initialize` with protocol `2025-11-25`. The fallback is automatic, and nothing was changed.
- **GET probes.** Claude Code and Hermes probe `GET /mcp` for a standalone SSE stream. The stateless server answers 405, which the spec allows, and both continue over POST.
- **Server instructions (fixed after the run).** During the run, the server's `instructions` text named `prepare_checkout` even for tokens without `purchase.prepare`, and Claude Code pointed this out in its answer. The tool was never listed or callable, so this was text only. The instructions are now built from the same scope checks as tool registration (`serverInstructions`, `tests/mcp-instructions.test.ts`). Authorization, tool registration and business logic are unchanged. The evidence files keep the original host answers.

## Evidence

- **Matrix:** `docs/evidence/interop/matrix.json`, including an unauthenticated probe answered with **401**.
- **Per host:** `docs/evidence/interop/<host>.json` contains:
  - handshake sequence with `clientInfo` and protocol version
  - discovered tools
  - exact tool arguments, full structured result and the host's own transcript of the call
  - server purchase session, hash-chained audit events and the MOCK usage record
- **Regenerate:** `node scripts/interop/build-evidence.mjs`

## Four-panel recording plan

Record one 2×2 screen layout (about 60 s). Each panel is a terminal for one host, all pointed at the same server.

| Panel | Host | Show |
|---|---|---|
| Top-left | Claude Code | prompt → `mcp__diaporia__research_purchase` tool call → answer `LOCKED / 1 candidate` |
| Top-right | Codex CLI | `codex exec` → `mcp_tool_call diaporia.research_purchase` → same answer |
| Bottom-left | Grok Build | `grok mcp doctor` (5 tools) → `-p` run → `use_tool diaporia__research_purchase` → same answer |
| Bottom-right | Hermes Agent | `hermes mcp test` → one-shot chat → tool call → same answer |

1. Start the server and proxy on screen (`[diaporia] ... payments=MOCK_PAYPAL`).
2. Run the four panels one after another, so each call is readable on its own.
3. End on `tail -f .data/interop/audit.jsonl | jq -c '{host, method: .requests[0].method, tool: .requests[0].tool, status}'`. It shows four `tools/call research_purchase` lines, one per host, each with a different token fingerprint.
4. Close with `matrix.json`.

Do not show `.data/interop/tokens.json`, the Hermes or Grok config with the header, or any env file.
