# Browser Checkout Handoff: four-host compatibility matrix

The same MCP server and the same handoff contract are used for every host. The commerce logic is identical; only
the presentation of `humanAction.url` differs by host.

## Contract delivery

| Host | Version in the four-host interop run | Contract delivered (protocol-level, offline) | Real host run with `prepare_browser_checkout` | Presentation used | Embedded Live View |
|---|---|---|---|---|---|
| Claude Code | 2.1.310 | **PASS** (clientInfo `claude-code`) | NOT_TESTED | Link opened in the default browser (CLI) | Not assumed |
| OpenAI Codex CLI | 0.160.0 | **PASS** (clientInfo `codex-mcp-client`) | NOT_TESTED | Link opened in the default browser (CLI) | Not assumed |
| xAI Grok Build | 1.0.77 | **PASS** (clientInfo `grok-shell-diaporia`) | NOT_TESTED | Link opened in the default browser (CLI) | Not assumed |
| Hermes Agent | 0.22.7 | **PASS** (clientInfo `hermes-agent`) | NOT_TESTED | Link (CLI, or relayed through a Hermes messaging gateway) | Not assumed |

"Protocol-level PASS" is `tests/handoff-host-contract.test.ts`. A real MCP client over Streamable HTTP announces each
host's clientInfo name and gets an **identical** contract shape. The text block equals `structuredContent`, so
text-only hosts see the same data. No secret-shaped fields appear. This is **not** evidence that the real host
programs handle the tool. Under this repo's interop rule, compatibility is never inferred without a host-originated call.

## Fallback rule

No host is assumed to support in-chat payment UI. Every host gets the same `OPEN_HANDOFF_PAGE` link with
`presentation.inChatPaymentModal = "NOT_ASSUMED"`. A host that can render UI may open the authenticated page. The raw
KERNEL Live View URL is never sent to a host.

## To complete Phase D with the real hosts

Rerun the interop recipe in `docs/INTEROP.md` with a token that has `purchase.prepare` and `HANDOFF_DRIVER=fixture`
(offline merchant, local browser). Ask each host to call `prepare_browser_checkout` once and report `humanAction.url`.
Claude Code, Codex and Hermes run on the owner's subscriptions. Grok is billed by xAI (about $0.07 to $0.16 per run
previously). This needs the owner's approval before it runs.
