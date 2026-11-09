# Browser Checkout Handoff: four-host compatibility matrix

The same MCP server and the same handoff contract are used for every host. The commerce logic is identical; only
the presentation of `humanAction.url` differs by host.

## Contract delivery

| Host | Version | Seen by server (User-Agent) | Protocol-level contract (offline test) | Real host-originated `prepare_browser_checkout` (2026-11-09, MOCK) | Presentation used | Embedded Live View |
|---|---|---|---|---|---|---|
| Claude Code | 2.1.310 | `claude-code/2.1.310` | **PASS** | **PASS** | Link opened in the default browser (CLI) | Not assumed |
| OpenAI Codex CLI | 0.160.0 | `codex-mcp-client/0.160.0` | **PASS** | **PASS** (second attempt; see below) | Link opened in the default browser (CLI) | Not assumed |
| xAI Grok Build | 1.0.77 | `grok-cli/1.0.77` | **PASS** | **PASS** (3 turns, $0.07 xAI) | Link opened in the default browser (CLI) | Not assumed |
| Hermes Agent | 0.22.7 | `python-httpx2/2.15.1` (Hermes' own MCP client, model `haiku`) | **PASS** | **PASS** | Link (CLI, or relayed through a Hermes messaging gateway) | Not assumed |

### Real host run (Phase D, MOCK only)

The server was `dist/src/main.js` with `HANDOFF_DRIVER=fixture` and `PAYMENT_PROVIDER=mock`: the offline fixture merchant, a local Chromium and no paid research. Each host had its own token with prepare scope, and its own user. `research_purchase` and `compare_purchase_offers` were seeded directly against the server with that host's token. Each host was then asked to make exactly **one** call, `prepare_browser_checkout`, through the audit proxy.

**PASS** requires all of the following:

- the proxy recorded a host-originated `tools/call` from that host's token, with HTTP 200;
- the result was `HUMAN_ACTION_REQUIRED`, with `OPEN_HANDOFF_PAGE`, `OWNER_KEY` and `NONE_BY_DIAPORIA`;
- the server's handoff row matches the returned id;
- the host's own transcript shows the call;
- the host called no other tool.

Evidence is in `docs/evidence/handoff-interop/matrix.json`. All four hosts got the same contract, a $59.98 captured total and a loopback handoff link. No host opened the link.

Host observations:

- **Codex CLI.** The first attempt was blocked **by Codex itself**: "MCP tool call requires approval, but approval policy is never". The tool is correctly annotated as not read-only, and `codex exec` has no interactive approver. Nothing reached the server. The passing run added a per-tool allowance for that single tool (`-c mcp_servers.diaporia.tools.prepare_browser_checkout.approval_mode="approve"`) without bypassing the sandbox. Expect this behavior in any non-interactive Codex run.
- **Claude Code and Hermes** pointed out that `humanAction.expiresAt` was close, comparing it against their own clocks. The contract carries the absolute expiry, as designed.
- **Grok** needed user-scope MCP registration (unchanged from the earlier interop run). The registration was removed afterwards.

"Protocol-level PASS" is `tests/handoff-host-contract.test.ts`. A real MCP client over Streamable HTTP announces each
host's clientInfo name and gets an **identical** contract shape. The text block equals `structuredContent`, so
text-only hosts see the same data. No secret-shaped fields appear. On its own that test would not prove the real host programs handle the tool; the real-host column above does. Under this repo's interop rule, compatibility is never inferred without a host-originated call.

## Fallback rule

No host is assumed to support in-chat payment UI. Every host gets the same `OPEN_HANDOFF_PAGE` link with
`presentation.inChatPaymentModal = "NOT_ASSUMED"`. A host that can render UI may open the authenticated page. The raw
KERNEL Live View URL is never sent to a host.

