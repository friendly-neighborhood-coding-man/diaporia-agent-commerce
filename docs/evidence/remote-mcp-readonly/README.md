# Remote MCP read-only: local validation evidence (2026-11-10)

Base commit `759bd37` (integration/mvp-full-layer), branch `infra/remote-mcp-readonly`. Cloud build container, Node 22.23, Docker 29.9 with Compose v5.6. No public deployment, DNS change, Cloudflare change or paid provider call was made.

| Layer | Command | Result | Report |
|---|---|---|---|
| Unit tests | `npm test` | 431/431 (29 files; 41 new in `tests/remote-readonly.test.ts`) | CI log |
| Local integration (spawned service, emulated proxy) | `npm run remote:validate` | **PASS 108/108**, all 15 steps + 16 startup refusals | [local-integration-report.json](local-integration-report.json) |
| Local HTTPS emulation (Docker: Caddy `tls internal` + app image, 127.0.0.1:8443) | `npm run remote:validate:https` | **PASS 84/84** + log-hygiene check over both containers | [local-https-emulation-report.json](local-https-emulation-report.json) |
| **Hardening A–E (after `0d9b931`)** | | | |
| Unit tests | `npm test` | 440/440 (50 in `tests/remote-readonly.test.ts`: closed registration, bound clients, owner-key binding across restart and rollback, key format) | — |
| Local integration | `npm run remote:validate` | **PASS 139/139** (DCR refused, phishing simulation, cross-user approval refused, rotation without the flag, pre-rotation backup restore, removed client) | [local-integration-report.json](local-integration-report.json) |
| Local HTTPS emulation | `npm run remote:validate:https` | **PASS 101/101** + log hygiene (incl. client secrets) + app refuses `/healthz` from the Caddy container | [local-https-emulation-report.json](local-https-emulation-report.json) |
| Real Caddy edge test (stub upstream) | `npm run remote:edge-check` | `caddy validate` of direct / cloudflare / local; fail-closed without CF ranges or unknown mode; **direct 56/56, cloudflare 66/66**; IPv6 transport **BLOCKED** (no IPv6 in this kernel) | [edge-report-direct.json](edge-report-direct.json), [edge-report-cloudflare.json](edge-report-cloudflare.json) |
| Actual remote AI host | gate A5 | **NOT RUN (BLOCKED on owner gates A1–A5 and the Gate R re-check)** | — |

Found and fixed during HTTPS emulation (not present in the reviewed `759bd37` code): Caddy's default access log recorded request headers, including `X-Owner-Key` sent to blocked routes. The Caddyfile now drops all request and response headers from access logs; the check script fails if any token, code or `drk_` key appears in either container's log.

Status summary (see docs/REMOTE_MCP_SECURITY_GATES.md):

| Item | Status |
|---|---|
| Deployment artifacts (deploy/remote-mcp, docs) | IMPLEMENTED |
| OAuth + MCP research/read flow, payment surface closed, startup refusal, restart persistence, rollback path | LOCAL_VERIFIED |
| Push of `0d9b931` (gate A0) | done, draft PR #11 (CI: tests green; gitleaks false positive fixed in the hardening commit) |
| Push of the hardening commit | READY_FOR_OWNER_APPROVAL |
| Gate R re-check of the hardening diff | BLOCKED (pending, requested) |
| IPv6 transport, Cloudflare official ranges | BLOCKED here (no IPv6; cloudflare.com blocked by network policy) |
| Server, DNS, deployment, OAuth window, remote host (A1–A5) | BLOCKED (owner gates) |
| Identity provider for open sign-up | BLOCKED (external dependency, not chosen) |
| Grok consumer connector (OAuth details unknown) | BLOCKED (undocumented) |
| Hosts that support only DCR or CIMD (closed registration) | BLOCKED by design until such a host is needed |
| Any host REMOTE_VERIFIED | none |
