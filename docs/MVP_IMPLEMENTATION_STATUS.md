# MVP implementation status

Checkpoint: 2026-11-10. Branch `integration/mvp-full-layer` (**local only, not pushed**; a git bundle of it is kept in the project files). The machine-readable copy is [evidence/mvp-status.json](evidence/mvp-status.json). Categories: NOT_STARTED, SCAFFOLDED, IMPLEMENTED, MOCK_VERIFIED, LIVE_VERIFIED, BLOCKED, FAILED. MOCK_VERIFIED means deterministic tests and the dogfood harness pass against MOCK providers. It says nothing about live behaviour.

## How to resume

```bash
npm ci
npm run typecheck && npm test && npm run build && npm run scan:secrets   # 347 tests at this checkpoint
npm run dogfood                  # scenarios A–K, writes docs/evidence/dogfood/*.json (J needs local Chromium)
npm run eval:research            # 18-case research eval, writes docs/evidence/research-eval/*.json
```

## Integration base

| Input | Head | How it entered this branch |
|---|---|---|
| main | 280e869 | base of every PR |
| PR #5 integration/commerce-v1 (#2 BYOK 345d69c, #3 handoff 8af6652, #4 billing 94bbc21, squash-integrated + hardening) | a64f5c4 | ancestor of #6 |
| PR #6 Phase C merchant | 221fda9 | branch base |
| PR #7 Cloudflare/VPS prep (staged config, no deployment) | f6860d3 | merge commit |
| PR #8 local tunnel MOCK runbook | 8520cdb | merge commit |

Every file and every test title from #2, #3 and #4 exists in this branch (checked by script, see the decision journal). Baseline before any change: 322/322 tests, typecheck, build and secret scan clean.

## Gap matrix and layer status

| Layer | Before this branch | Now | Evidence | Open limits | Next executable task | Needs owner approval |
|---|---|---|---|---|---|---|
| 0 Integration and security foundation | Spread across 7 draft PRs | **MOCK_VERIFIED** (local integration branch) | 347/347 tests, build, secret scan; [MERGE_READINESS.md](MERGE_READINESS.md) | Phase C C0 needs an independent security review; KERNEL network isolation unverified in the real KERNEL environment; CI has no runner result for this branch | Independent review of the Phase C C0 diff and this branch | Push and merge |
| 1 Research and product intelligence | Router, identity lock, offer verifier, Channel3/Tavily/KERNEL adapters, fixtures | **MOCK_VERIFIED**; live adapters LIVE_VERIFIED only for 2 Channel3 + 2 Tavily calls (earlier) | `npm run eval:research` 18/18, 0 critical ([evidence](evidence/research-eval/)); first run 13/18 kept | The eval world and the system were written by the same author, so it is not independent; router is rule-based (closed brand and color lists); discovery ranking is shallow | Grow the eval set from real Channel3/Tavily responses (needs keys and budget) | Paid provider calls |
| 2 Purchase authorization (PurchaseMandate) | Complete: binding, limits, expiry, revocation, atomic reservation, cross-user isolation | **MOCK_VERIFIED** | core + mcp-e2e tests; dogfood B, F, G | Single-node SQLite; multi-node needs a shared transactional DB | None blocking | No |
| 3 Checkout and PayPal | Orders v2, idempotent create/capture, UNKNOWN + reconcile, webhooks (simulated), handoff, Phase C merchant | **MOCK_VERIFIED**; PayPal Sandbox: 1 capture still PENDING_REVIEW at last read (not COMPLETED) | dogfood A, E, H, J; payment-lifecycle tests; two dogfood defects fixed (DF-1, DF-2) | Phase C C1/C2/C3 **BLOCKED** (security review, HTTPS host, new approval); no real webhook delivery | Re-generate Phase C approval statement from the new commit when C1 is approved (merchant tree hash changed) | C1, C2, C3, any Sandbox mutation |
| 4 Host-neutral MCP/API service | Dev tokens only; remote hosts impossible | **MOCK_VERIFIED**: OAuth 2.1 (PKCE, DCR, RFC 8707/9728/7009/9207, refresh rotation) | tests/oauth.test.ts (12); official MCP SDK client completes the flow; dogfood K | No remote host has connected; no public HTTPS deployment; owner-key login stands in for an IdP | Deploy research/read-only OAuth endpoint and connect one remote host | Public deployment, Cloudflare route |
| 5 Approval and trust UI | Owner page: product, merchant, item/shipping/tax/total | **MOCK_VERIFIED**: environment label, payee with provenance, fees, discount, unknown charges, requested max, existing limit, expiry, cancel; MOCK pages never say Sandbox; Phase C return label fixed | tests/approval-ui.test.ts (6); phase-c-merchant test; dogfood A | Plain server-rendered HTML; no accessibility review | Visual pass at demo time | No |
| 6 Service plane and managed billing | Community/BYOK, managed simulation, metering, caps, PayPal Subscriptions adapter (MOCK) | **MOCK_VERIFIED** (unchanged here) | service-plane + subscription-billing tests | Managed mode still refuses to start outside loopback simulation; plan price UNKNOWN; KR merchant eligibility unchecked | Owner decisions on PR #4 | Price, country, every Sandbox step |
| 7 Outcomes, recovery, accountability | States incl. UNKNOWN/REFUNDED, journals, startup reconcile, receipts | **MOCK_VERIFIED**: owner cancellation added; startup recovery now covers UNKNOWN without capture id (read-only) | dogfood E, H; tests/dogfood-findings.test.ts | Merchant fulfillment, shipping and third-party refunds: **NOT_INTEGRATED** by scope | None blocking | No |
| 8 Dogfooding and evaluation | Per-feature tests and demos | **MOCK_VERIFIED**: `npm run dogfood` (A–H, J, K pass; I NOT_RUN) | [evidence/dogfood/](evidence/dogfood/) | I needs the owner's PC; J public HTTPS smoke not run | Run scenario I on the owner's PC | Using the owner's PC |

## Dogfood scenarios (latest run)

| ID | Scenario | Result |
|---|---|---|
| A | Exact product, $60 limit, human authorization, verified MOCK result | PASS (18 checks) |
| B | $6,000 offer under a $60 mandate | PASS: HOLD `AMOUNT_EXCEEDED`, zero provider calls |
| C | Wrong color, refurbished, look-alike merchant, quantity beyond limit | PASS: no substitution |
| D | Unknown shipping/tax | PASS: no verified cheapest claim |
| E | Provider timeout after a possible capture | PASS: UNKNOWN, read-only reconcile, one capture |
| F | Cross-user / cross-scope access | PASS: refused |
| G | Prompt injection in listing and review text | PASS: flagged, ineligible, mandate unchanged |
| H | Restart mid-transaction | PASS (after fixing DF-1, DF-2) |
| I | Four local AI hosts | **NOT_RUN** here (needs the owner's PC). Earlier evidence, all MOCK: 4/4 hosts ran research and compare ([INTEROP.md](INTEROP.md)), and 4/4 made one `prepare_browser_checkout` call each ([HANDOFF_HOST_MATRIX.md](HANDOFF_HOST_MATRIX.md)) |
| J | Phase C fictional merchant via browser handoff | PASS offline on loopback; public HTTPS smoke **not run** |
| K | Remote-style OAuth client (official SDK) on loopback | PASS |

## Hackathon acceptance criteria

| Criterion | Status |
|---|---|
| Integrated branch passes build, typecheck, tests, secret scan | MET locally (347/347). CI not run for this branch (not pushed) |
| Core purchase policies intact | MET (all prior tests kept and passing) |
| Research, authorization, execution, status and service layers connected | MET (dogfood A–H, K run end to end over MCP) |
| All critical MOCK scenarios pass | MET for A–H, J (offline), K |
| Four local hosts run the full workflow including status | **BLOCKED**: needs the owner's PC. Earlier host runs covered research, compare and one `prepare_browser_checkout`; no host has yet run `prepare_checkout` through to `get_checkout_status` / `get_purchase_receipt` |
| One approved remote host verified against an authenticated HTTPS MCP endpoint | **BLOCKED**: OAuth is implemented and SDK-verified; needs an approved public deployment |
| Phase C seller-owned Sandbox workflow verified through C1/C2/C3 | **BLOCKED**: security review, HTTPS host, new approval |
| No payment can exceed a mandate | MET (MOCK): tests + dogfood B |
| UNKNOWN states cause no duplicate capture | MET (MOCK): dogfood E, H |
| Receipt and merchant-order evidence reported truthfully | MET (MOCK) |
| Usage and cost limits fail closed | MET (MOCK, earlier service-plane tests) |
| Failures observable and recoverable | MET (MOCK): audit journal, reconcile, startup recovery |
| Approval UI distinguishes MOCK and Sandbox | MET |
| Docs explain real vs simulated vs blocked | This file, README status table, MISSION.md |
| Reviewer can reproduce the demo | `npm run dogfood` and `npm run demo:e2e` (offline) |

The MVP is **not** technically complete: three criteria are BLOCKED on owner-approved external steps.

## Waiting on owner approval (prepared, not executed)

1. **Push this branch and open a draft PR** (no merge): `git push -u origin integration/mvp-full-layer`. Reversible; publishes code to the public repo.
2. **Scenario I on the owner's PC**: four hosts run research → compare → prepare (MOCK) → status, against a local server. No money, no paid calls; uses the owner's host subscriptions.
3. **Remote host test**: deploy `DIAPORIA_AUTH_MODE=oauth` on an HTTPS host in research/read mode (payment tools are not offered there by design), then connect one remote MCP client. Needs a hostname, a Cloudflare route that does not touch existing routes, and an owner key held only by the owner.
4. **Phase C C1** stays on hold as before (independent C0 review, exact HTTPS host, new signed approval). The merchant artifact hash changed in this branch, so any C1 statement must be generated from this commit.
5. **Managed billing (PR #4)**: plan price, country eligibility, each Sandbox step.
