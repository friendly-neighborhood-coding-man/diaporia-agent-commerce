# DIAPORIA Agent Commerce: submission notes

This page is the reviewer's entry point. It says what DIAPORIA does, how to reproduce it, what is proven, what is simulated and what is still open. Numbers marked *seen* come from evaluation sets the builder has already looked at. They are regression evidence, not independent evidence.

## Project description (Devpost)

**DIAPORIA: bring safe purchasing to the AI assistant you already use.**

AI assistants can already find products. The risky part is everything after that. They might buy the wrong model, trust a listing that tells them what to do, call a search price the "total", or spend money the user never authorized. DIAPORIA is an MCP server that any assistant (Claude, ChatGPT, Grok, Codex, Hermes) can call. The assistant does the talking. DIAPORIA owns the facts and the money boundary.

- **Grounded research.** The user's words become structured requirements: the budget, the exact model, MUST and nice-to-have features, and unfamiliar requirements as generic propositions. Each requirement is verified from attributable evidence. A manufacturer can state a property, but a performance claim such as "quiet" or "comfortable" needs two independent expert sources. Listing text is never evidence, and text that tries to instruct the AI is flagged.
- **No silent substitution.** The exact model, variant, condition and kind (standalone, bundle or accessory) are locked. "A9" never becomes "A9 Pro". A request word that research could not interpret blocks recommendation instead of being ignored.
- **Honest outcomes.** RECOMMEND only when every MUST requirement is verified. INVESTIGATE says exactly which requirement is open and why. HOLD says what is known to be wrong. Ranking can never compensate for an unmet requirement.
- **Verified totals.** Offers are compared on fresh merchant quotes with shipping and tax, and merchant identity is checked against a registry. A search price is never shown as a checkout total. Unknown costs stay unknown, and an unsupported currency is refused, never converted.
- **Bounded spending.** The AI can prepare a checkout but cannot authorize one. The human sets a spending limit on the owner page, and the buyer approves on PayPal's page. The limit is server-enforced and atomic, and every step is in an audit trail. Only the owner, with a passkey, can settle a requirement the research could not verify. The ledger then says OWNER_ATTESTED, never VERIFIED.

**Built with:** TypeScript, Node 22 (`node:sqlite`), the official MCP TypeScript SDK (Streamable HTTP), PayPal Orders v2 (Sandbox adapter), WebAuthn-style passkey verification, Channel3 and Tavily adapters (bring your own key; off by default).

## Reproduce

```bash
git clone <repo> && cd diaporia-agent-commerce
npm ci                 # Node.js 22.13+
npm run demo:full      # unattended end-to-end demo, offline, MOCK; writes demo-output/<run>/trace.json + transcript.md + trace.sha256
npm test               # 929 automated tests (offline)
npm run typecheck
```

Measured on a fresh clone in the build container, with a warm npm cache: clone, `npm ci` and `demo:full` took 4.6 s in total. The demo itself runs in about 0.4 s and has 18 checked steps. A failed expectation exits non-zero, so a run is never shown as successful when it was not.

## What is real and what is simulated

| Part | In the demo | Elsewhere in the repository |
|---|---|---|
| AI host ↔ DIAPORIA | Real MCP over HTTP (official SDK client) | Tested with Claude Code, Codex CLI, Grok Build and Hermes on localhost (docs/INTEROP.md) |
| Catalog and web evidence | Offline fictional world in the documented Channel3 and Tavily response shapes; the real adapters, evidence router, decision engine and gate run unmodified | Live Channel3/Tavily adapters exist; only bounded live smoke was run; provider outputs stay private |
| Merchants and quotes | Repository MOCK merchants with MOCK registry attestations and a MOCK quote API | Shopify Storefront cart estimate (V0) |
| Payment | **MOCK PayPal: no PayPal API call, no money** | PayPal Sandbox adapter; two owner-approved Sandbox runs earlier, with capture left in `PENDING_REVIEW`. Sandbox `COMPLETED` was not observed |
| Human owner and buyer | **Scripted demo owner with DEMO-ONLY credentials generated per run.** This is a development simulation, not real consent | Real owners use their own owner key and passkey, enrolled in a registry that the server's OS account cannot write |
| Merchant fulfilment | Not claimed (`merchantPurchaseComplete: false`) | Not provided |

## Proven guarantees (automated tests and runs)

- Monetary constraints are never dropped. Budget parsing was 28/28 on seen IW-4 and 15/15 on the fresh IW-5 run, with no money bypass on either. An approximate budget is applied as a maximum and stated as an assumption.
- The AI host cannot forge owner confirmation. A database row is never trusted: each gate check re-verifies the stored passkey signature against the binding. The AI-resolution probes found 0 bypasses on every set, including the fresh IW-5 run (0/3), where all 9 attacks that used only the AI's own access were refused.
- No wrong model is locked. A NOT_REQUESTED_MODEL disqualifier applies; seen IW-4 and the fresh IW-5 run had 0 wrong locks.
- Payment-gate bypasses: 0 in every current seen run (IW-1.1 0/15, IW-2 0/19, IW-3 0/20, IW-4 0/48, IW-5 0/46). On fresh cases, the first IW-5 run found **1 bypass in 46** (an accessory prepared for a named tent). V2.4 fixes that class, but no unseen set has measured V2.4 yet.
- Unsafe recommendations: 0 on every current seen run (builder eval 0/90 at both caps; IW-1.1 to IW-5). The first fresh IW-5 run had 1 (the same tent case).

## Evaluation (measured on code commit 5e37f7f)

| Set | State correct | Unsafe | Gate bypasses | Notes |
|---|---|---|---|---|
| Builder eval (90, expanded / service caps) | 87/90 / 81/90 | 0 | 0 unsafe prepares | seen |
| IW-1.1 (39) | 33/39 | 0 | 0/15 | seen |
| IW-2 (48) | 47/48 | 0 | 0/19 | seen |
| IW-3 (46) | 40/46 | 0 | 0/20 | seen |
| IW-4 (54) | 52/54, legitimate checkouts 20/21 | 0 | 0/48 | seen. It was 45/54 with 2 unsafe on V2.2 when first scored independently |
| **IW-5 first scored run (independent, on e397ef9)** | **26/39, legitimate checkouts 11/26** | **1** | **1/46** | Fresh cases, sealed before the run. Recorded unchanged. The bypass prepared a tent's footprint accessory for "Talus Ridge 2 tent" |
| IW-5 after the V2.4 fixes (now seen) | 36/39 service caps, 38/39 expanded; legitimate checkouts 22/26 | 0 | 0/46 | seen, regression only. A clean measurement of V2.4 needs a new unseen set (IW-6) |

## Open risks (not fixed, stated plainly)

- **Payment routes accept the owner key without a passkey** (V22-05 / R-A-1). The IW-5 evaluator confirmed it: a stolen owner key alone completes a MOCK purchase end to end. Research holds already require a passkey. Checkout authorization, owner-API mandates, the handoff and MOCK approval rely on the owner key, which is protected at rest by the OS-account boundary. Adding a passkey there is a deployment precondition. It is not done here, because a new approval step is the operator's decision.
- **The service-isolation self-check trusts declared uids** (V22-04 / H2-R1). The independent IW-5 evaluator showed it: a copy of the service run from the AI's own account with a fake AI uid reports isolation as established. That copy does not touch the real service's gate or audit trail. The check re-runs while the service is up (V22-08 fixed), but it should verify the service uid against a root-owned pin before any deployment.
- **Lexical evidence matching.** A manufacturer statement phrased very differently from the request can stay unverified. The outcome is INVESTIGATE, never an unsafe purchase.
- **Nothing is deployed.** There is no remote host connector, no live PayPal, and no real merchant checkout.

## Submission checklist

- [x] One-command reproducible demo with a verified trace (`npm run demo:full`)
- [x] README quick start and an honest status table
- [x] Automated tests pass (929) and the typecheck is clean
- [x] Secret scan clean (`npm run scan:secrets`)
- [x] Fresh independent IW-5 scored once on e397ef9 (26/39, 1 bypass in 46; result recorded unchanged above)
- [ ] Fresh independent IW-6 for V2.4 (not run)
- [ ] CI status on the final HEAD (to be recorded at the final checkpoint)
- [ ] Demo video (record `npm run demo:full` and the owner pages; MOCK labels visible)
