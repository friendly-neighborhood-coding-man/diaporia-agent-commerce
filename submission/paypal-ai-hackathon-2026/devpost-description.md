# DIAPORIA Buy — Secure AI Purchasing for Every Assistant

**Don't switch AI assistants to shop.** DIAPORIA brings evidence-based product research, verified offers, and human-authorized PayPal checkout to the AI you already use.

## Inspiration and the problem

AI assistants are good at finding products. Buying is harder. An assistant can confuse the "A9" with the "A9 Pro", trust a listing that tells it what to do, call a search price the "total", or spend money nobody authorized. The usual answer is a new shopping chatbot, which means switching assistants and trusting another model with your wallet.

We wanted the opposite. Keep the assistant you already use, and give it purchasing infrastructure that owns the facts and the money boundary. The assistant does the talking. DIAPORIA decides what is verified, what it costs, and what the human has allowed.

## What DIAPORIA Buy does

DIAPORIA Buy is an MCP server with a browser shopping panel. An assistant (Claude Code in our video) sends the user's request. DIAPORIA:

1. turns the request into structured requirements: budget, exact model and variant, must-haves and nice-to-haves;
2. discovers candidates and verifies every must-have from attributable evidence;
3. recommends only when every must-have is verified, and says what is open otherwise;
4. asks each merchant for a fresh quote and compares the full verified total (item, shipping, tax, fees), rejecting look-alike merchants;
5. prepares a checkout that the AI cannot authorize;
6. lets the human set a spending limit on an owner page, then approve payment on PayPal's page;
7. shows a receipt only after the backend verifies the payment, and never claims a merchant order or a shipment it has not seen.

The **Buy panel** shows all of this beside the conversation: live research progress, up to three candidates, evidence per requirement, verified offers, the approval timeline and the receipt.

## How the MCP architecture works

DIAPORIA is a TypeScript service using the official MCP TypeScript SDK over Streamable HTTP. Tools include `research_purchase`, `compare_purchase_offers`, `prepare_checkout`, `get_checkout_status` and `get_purchase_receipt`. With the panel enabled, `start_shopping_panel` starts the same research and returns a panel link at once. The user's identity comes from the verified token, never from tool arguments. A token only sees the tools its scopes allow. The panel is not a second engine: it observes and drives the same purchase session, and the browser sends only a product id, an offer id and a destination. Prices, identities and states always come from the server's records.

## Product identity and evidence verification

The exact model, variant, condition and kind (standalone, bundle or accessory) are locked. A request word that research could not interpret blocks a recommendation instead of being ignored. Each requirement is verified from attributable evidence, such as a manufacturer's statement about that exact product. Listing text is never evidence. Negated or hedged statements never verify anything, and a denial on a page wins. Text that tries to instruct the AI is flagged and shown only as untrusted data. The outcome is RECOMMEND, INVESTIGATE (with exactly what is open) or HOLD (with what is wrong). Ranking can never make up for an unmet requirement.

## Verified total cost and purchase mandates

A search price is never shown as a checkout total. Comparison asks each merchant for a fresh quote and checks the merchant's identity against a registry and the payee. Unknown costs stay unknown and are never ranked as cheapest. Spending authority is a **purchase mandate**, created only by the human with an owner key the AI never holds. It is bound to amount, currency, quantity, product and merchant, with expiry and revocation. Reservation is atomic in SQLite. In the video, a $100 limit against a $138.35 total is refused with `AMOUNT_EXCEEDED` before any payment starts.

## PayPal Orders v2 Sandbox integration

DIAPORIA has a PayPal Orders v2 adapter (CAPTURE intent, `PayPal-Request-Id` idempotency, Sandbox host only) and capture reconciliation through Payments v2. In two owner-approved Sandbox runs on 2026-11-09, the flow created one order, the buyer approved it on PayPal's Sandbox page, and DIAPORIA verified the payee merchant id from PayPal's own data before capturing once. PayPal still reports that capture as `PENDING / PENDING_REVIEW`, and DIAPORIA reports `CAPTURE_PENDING`, not completed. We never observed a Sandbox capture reach `COMPLETED`. No real money was involved.

The demo video uses **MOCK PayPal** (no PayPal API call), so judges can run it with no credentials. The Sandbox evidence is shown separately and labelled.

## Human authorization and payment safety

- The AI can prepare a checkout but cannot authorize spending or approve a payment.
- The owner sets the limit on the owner page; the buyer approves on PayPal's hosted page (MOCK in the demo).
- A forged "the owner already approved" message changes nothing. A misled AI's inflated budget is ignored in favour of the user's words.
- A requirement nobody can verify can only be settled by the owner with a passkey, and the ledger then says OWNER_ATTESTED, never VERIFIED.
- Every step is in an audit trail, and a captured payment is reported as payment only (`merchantPurchaseComplete: false`).

## Cross-host interoperability

The same server was called by four real MCP hosts on localhost with MOCK commerce data: Claude Code, OpenAI Codex CLI, xAI Grok Build and Nous Hermes Agent, 4/4 PASS on identical results. The Buy panel was opened in the Claude Desktop Browser pane on Windows during development, and the video shows it beside Claude Code. Codex Desktop, MCP Apps hosts and remote connectors (claude.ai, ChatGPT) have not been verified.

## Technical implementation and tools

TypeScript on Node.js 22 with the built-in `node:sqlite`; the official MCP TypeScript SDK; Zod schemas for every tool input and output; a plain HTML/CSS/JS panel with a strict CSP and a capability link kept in the URL fragment; server-sent events for live updates; PayPal Orders v2 and Payments v2 (Sandbox); bring-your-own-key Channel3 (catalog) and Tavily (evidence) adapters, off by default; Vitest (1045 tests); Playwright and ffmpeg for the recorded demo.

DIAPORIA Buy is everything in the public repository, open source under the MIT license. Any future proprietary research infrastructure would be a separate service behind the same MCP tools. It is not part of this submission, and the open product does not depend on it.

## Challenges and lessons learned

The hardest part was language, not payments. Every new unseen evaluation set found phrasing that our request parser or evidence matcher handled wrongly on first contact: a dropped "EQ" suffix, "up to 180 kg" read the wrong way, a sentence that denied a feature counted as confirming it. We learned to fail closed (INVESTIGATE or HOLD rather than guess), to keep the payment gate independent of research quality, and to keep fresh measurements separate from re-runs on cases we had already studied. We also learned that "COMPLETED" means different things to different APIs: PayPal marks an order COMPLETED while its capture is still pending, so DIAPORIA keys on the capture.

## Accomplishments and measured results

- A one-command offline demo (`npm run demo:full`) with 18 checked steps and a hashed trace, and the Buy panel journey in the video, both on build `be03b52`.
- 1045 automated tests, typecheck, build and secret scan clean; CI green on Node 22 and 24.
- Unseen evaluation sets IW-5 to IW-20, each written and sealed by a separate evaluator and scored once before we looked at it. The latest, the **first scored run of IW-20 (fresh, unseen)**: 102/161 correct, 6 unsafe recommendations, 6 payment-gate bypasses in 177 attempts, legitimate checkouts 56/118. We fixed what it found. On the frozen build, every set we have already seen, IW-1.1 to IW-20, now shows 0 unsafe recommendations and 0 gate bypasses. That is **seen-set regression evidence, not a fresh evaluation and not a zero-risk guarantee**. The frozen build has not yet been measured on a new unseen set.
- Two real PayPal Sandbox runs with payee verification from PayPal data and honest pending reporting.

## Current limitations and future work

- The demo uses an offline fictional catalog, fictional merchants and MOCK PayPal. Nothing is deployed.
- Sandbox payments went to our own Sandbox business account. Paying a real merchant needs that merchant onboarded as the payee, or the merchant's own checkout. Merchant order confirmation and fulfilment are not integrated.
- PayPal Agent Ready and Store Sync are not integrated.
- Payment routes accept the owner key without a passkey (a documented deployment precondition), and the service-isolation self-check needs a root-owned uid pin before deployment.
- On fresh sets, roughly 40–50% of legitimate checkouts get through (IW-20: 56/118); the rest stop safely at INVESTIGATE or HOLD. Improving that without new unsafe results is the main research task.
- Next: a fresh IW-21 measurement of the frozen build, a passkey on payment routes, a hosted HTTPS deployment with OAuth for remote assistants, and merchant-side order confirmation.
