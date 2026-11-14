# Mission (short, stable)

**Don't switch AI assistants to shop. Bring safe, evidence-based purchasing to the AI people already use.**

DIAPORIA Agent Commerce is host-neutral purchasing infrastructure that existing AI assistants call through MCP. It is not a shopping app.

## Invariants (never trade these for a demo)

1. Spending authority comes only from a human (owner key → PurchaseMandate or owner page). Nothing an AI sends, and nothing merchant or review text says, creates or widens it.
2. No payment can exceed its mandate. The check happens before any payment-provider call.
3. Unknown stays unknown. An unknown cost is not zero, and an unverifiable total is never "cheapest".
4. No silent substitution of brand, model, variant, condition or SKU.
5. Payment, merchant order and fulfillment are separate facts. A capture is not an order, an order is not a shipment, and a redirect proves nothing.
6. UNKNOWN payment outcomes are reconciled by reading the provider. They never trigger a blind second payment.
7. MOCK is never labelled Sandbox, Sandbox is never labelled live, and a behavioural PASS means agreement on the sampled inputs only.

## Owner approval boundaries

These need the owner's explicit, separate approval each time: PayPal Sandbox order or capture, subscription activation, any real money, paid KERNEL browsers or other paid provider calls beyond an approved budget, Cloudflare/DNS/WAF/Tunnel changes, public deployment or VPS provisioning, push or merge, and anything irreversible. An earlier approval never covers a new phase. Commits use only the owner's GitHub noreply email.

## Where state lives

- What is done, verified or blocked: [MVP_IMPLEMENTATION_STATUS.md](MVP_IMPLEMENTATION_STATUS.md) and [evidence/mvp-status.json](evidence/mvp-status.json)
- Why things changed: [DECISION_JOURNAL.md](DECISION_JOURNAL.md)
- Whether the integration branch can merge: [MERGE_READINESS.md](MERGE_READINESS.md)
