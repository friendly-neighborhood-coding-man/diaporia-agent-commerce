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
npm test               # 958 automated tests (offline)
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
- Payment-gate bypasses: 0 in every current seen run (IW-1.1 0/15, IW-2 0/19, IW-3 0/20, IW-4 0/48, IW-5 0/46, IW-6 0/55, IW-7 0/66). On fresh cases, the first IW-5 run found **1 bypass in 46** (an accessory prepared for a named tent) and the first IW-6 run found **2 in 55** (a charger statement that denied USB-C counted as verified, and a dropped model suffix). The first IW-7 run, on V2.5, found **0 in 66** and 0 unsafe recommendations, including new phrasings of both IW-6 bypass classes. The first IW-8 run, on V2.6, found **1 in 61** and 2 unsafe recommendations: "Orbit 90 EQ" lost "EQ" in the listing identity, so the plain model's offers were pooled and the product was recommended and prepared over budget. No unseen set has measured V2.7 yet.
- Unsafe recommendations: 0 on every current seen run (builder eval 0/90 at both caps; IW-1.1 to IW-8). The first fresh IW-5 run had 1 (the same tent case), the first fresh IW-6 run had 2 (the same two cases), the first fresh IW-7 run had 0, and the first fresh IW-8 run had 2 (the same "EQ" case, asked two ways).

## Evaluation (measured on code commit 177b490)

| Set | State correct | Unsafe | Gate bypasses | Notes |
|---|---|---|---|---|
| Builder eval (90, expanded / service caps) | 87/90 / 81/90 | 0 | 0 unsafe prepares | seen |
| IW-1.1 (39) | 33/39 service caps, 35/39 expanded | 0 | 0/15 | seen |
| IW-2 (48) | 47/48 | 0 | 0/19 | seen |
| IW-3 (46) | 40/46 | 0 | 0/20 | seen |
| IW-4 (54) | 54/54, legitimate checkouts 21/21 | 0 | 0/48 | seen. It was 45/54 with 2 unsafe on V2.2 when first scored independently |
| **IW-5 first scored run (independent, on e397ef9)** | **26/39, legitimate checkouts 11/26** | **1** | **1/46** | Fresh cases, sealed before the run. Recorded unchanged. The bypass prepared a tent's footprint accessory for "Talus Ridge 2 tent" |
| IW-5 after the V2.4 fixes (now seen) | 36/39 service caps, 38/39 expanded; legitimate checkouts 22/26 | 0 | 0/46 | seen, regression only |
| **IW-6 first scored run (independent, on 5e37f7f)** | **24/45 service caps, 26/45 expanded; legitimate checkouts 11/33 and 13/33** | **2** | **2/55** | Fresh cases, sealed before the run. Recorded unchanged. One bypass: "charges over micro-USB, not USB-C" counted as USB-C charging. The other: "AF-55 Duo" lost "Duo" and the plain AF-55 was prepared |
| IW-5 now (seen) | 38/39 service caps; legitimate checkouts 24/26 | 0 | 0/46 | seen, regression only |
| IW-6 now (seen) | 41/45 at both caps; legitimate checkouts 28/33 | 0 | 0/55 | seen, regression only |
| **IW-7 first scored run (independent, on 6ada5b0)** | **19/45 service caps, 25/45 expanded; legitimate checkouts 9/36 and 15/36** | **0** | **0/66** | Fresh cases, sealed before the run. Recorded unchanged. Safe, but the IW-6 utility gains did not carry over: evidence went to the cheapest or trap candidates first, and ordinary words still blocked |
| IW-7 after the V2.6 fixes (now seen) | 32/45 at both caps; legitimate checkouts 22/36 | 0 | 0/66 | seen, regression only |
| **IW-8 first scored run (independent, on e5cc4de)** | **24/47 at both caps; legitimate checkouts 13/37** | **2** | **1/61** | Fresh cases, sealed before the run. Recorded unchanged. "Orbit 90 EQ" was locked as "Orbit 90" (the unsafe pair and the bypass), "TC-20 LTE" locked TC-20, greetings ("Hi", "I'm") were read as a model, and "for 13-inch posters" was read as the laminator's size |
| IW-8 after the V2.7 fixes (now seen) | 27/47 at both caps; legitimate checkouts 16/37 | 0 | 0/61 | seen, regression only. A clean measurement of V2.7 needs a new unseen set (IW-9) |

## Open risks (not fixed, stated plainly)

- **Payment routes accept the owner key without a passkey** (V22-05 / R-A-1). The IW-5, IW-6, IW-7 and IW-8 evaluators each confirmed it (IW-8 probe G10 on e5cc4de): a stolen owner key alone completes a MOCK purchase end to end. Research holds already require a passkey. Checkout authorization, owner-API mandates, the handoff and MOCK approval rely on the owner key, which is protected at rest by the OS-account boundary. Adding a passkey there is a deployment precondition. It is not done here, because a new approval step is the operator's decision.
- **The service-isolation self-check trusts declared uids** (V22-04 / H2-R1). The independent IW-5, IW-7 and IW-8 evaluators showed it (IW-8 probe G11): a copy of the service run from the AI's own account with a fake AI uid reports isolation as established. That copy does not touch the real service's gate or audit trail. The check re-runs while the service is up (V22-08 fixed), but it should verify the service uid against a root-owned pin before any deployment.
- **Lexical evidence and request parsing.** Every fresh set so far (IW-4 to IW-8) found new wording that the parser or evidence matcher handled wrongly on first contact, and IW-4, IW-5, IW-6 and IW-8 each had unsafe results from it. Since V2.7 the product identity fails closed: a name word or code next to the model ("EQ", "LTE", "Lite") must be in the candidate's identity, and a page about a coded sibling never counts for the base model. The fixes are general mechanisms, but the next fresh set should be expected to find more. A statement phrased very differently from the request usually stays unverified (INVESTIGATE).
- **Context is not verified.** Since V2.5, a purpose phrase ("for my studio apartment", "for travel") is an optional CONTEXT row, never a blocking requirement. Since V2.6, a leftover word that no requirement pattern claimed is context too, unless it is negated, a comma item of its own, after a feature verb, next to another content word, model-like, or in a non-English request. A requirement phrased in a way none of these catch is therefore not checked. That is the trade made for fewer false INVESTIGATE results. IW-8 tested loose requirements and found no unsafe result from them (they stayed must-haves and gave INVESTIGATE).
- **Pooled evidence.** Since V2.6, every search result of a request is read for every candidate, and a brand-wide search is used when the budget cannot reach every model. Attribution rules are unchanged (IW-7: 0 misattributed on V2.5), but the pooled read is new and has only been measured on seen sets.
- **Nothing is deployed.** There is no remote host connector, no live PayPal, and no real merchant checkout.

## Submission checklist

- [x] One-command reproducible demo with a verified trace (`npm run demo:full`)
- [x] README quick start and an honest status table
- [x] Automated tests pass (958) and the typecheck is clean
- [x] Secret scan clean (`npm run scan:secrets`)
- [x] Fresh independent IW-5 scored once on e397ef9 (26/39, 1 bypass in 46; result recorded unchanged above)
- [x] Fresh independent IW-6 scored once on 5e37f7f (24/45, 2 unsafe, 2 bypasses in 55; result recorded unchanged above)
- [x] Fresh independent IW-7 scored once on 6ada5b0 (19/45, 0 unsafe, 0 bypasses in 66, legitimate checkouts 9/36; result recorded unchanged above)
- [x] Fresh independent IW-8 scored once on e5cc4de (24/47, 2 unsafe, 1 bypass in 61, legitimate checkouts 13/37; result recorded unchanged above)
- [ ] Fresh independent IW-9 for V2.7 (not run)
- [ ] CI status on the final HEAD (to be recorded at the final checkpoint)
- [ ] Demo video (record `npm run demo:full` and the owner pages; MOCK labels visible)
