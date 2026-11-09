# Hackathon demo (judge-runnable, about 5 minutes)

**What it shows:** an AI assistant you already use buys through DIAPORIA over MCP. DIAPORIA researches with evidence, refuses unauthorized spending, and only takes payment after the buyer approves on PayPal. It reports exactly what is verified and what is not.

## Run it locally (no credentials)

```bash
git clone <repo> && cd diaporia-agent-commerce
npm ci && npm test
npm run demo:e2e
npm run demo:identity
npm run demo:service
```

| # | Step | Where to see it | Evidence class |
|---|---|---|---|
| 1 | An external AI host calls DIAPORIA over MCP | `docs/HOST_TEST_EVIDENCE.md` (Claude Code CLI 2.1.310 → localhost) and `docs/SETUP.md` §2 to repeat it | **Live host** (localhost) |
| 2 | Product discovery and grounded research | `demo:service` (mock), `docs/evidence/live-smoke-2026-11-09.json` | Mock, plus **one live Channel3 search and one live Tavily search** |
| 3 | Policy-controlled purchase preparation | `demo:e2e` steps 5–6; checkout summary binds amount, merchant identity and recipient | Mock |
| 4 | Rejection of a $6,000 transaction under a $60 mandate | `demo:e2e` step 4: HOLD / AMOUNT_EXCEEDED with zero PayPal calls; also live-host run 2 in HOST_TEST_EVIDENCE | Mock + live host |
| 5 | PayPal Sandbox buyer approval, recipient verification, single capture | `docs/TEST_REPORT.md` Sandbox run 2: order `99X21669LS4807358`, payee merchant ID verified from PayPal data, one capture `92U85747JU359434A` | **Live PayPal Sandbox** (recorded; needs your own Sandbox app to repeat) |
| 6 | Correct `CAPTURE_PENDING` reporting | Same capture is `PENDING / PENDING_REVIEW`; DIAPORIA reports `CAPTURE_PENDING`, not completed | **Live Sandbox**, re-read 2026-11-09 |
| 7 | Purchase authorization and DIAPORIA service billing are independent | `demo:service` (managed simulation) and tests in `tests/service-plane.test.ts` | Mock |

## Truthfulness constraints

- The Sandbox capture is **pending**, not settled. No real money moved.
- "alpha-audio.example" and every other merchant in the demos is **fictional**.
- Shopify integration is fixture-tested only; there is no live store.
- There is no merchant order or fulfillment, no production OAuth, and no live managed billing.
