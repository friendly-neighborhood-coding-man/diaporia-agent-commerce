/**
 * MOCK demonstration of DIAPORIA Managed subscription billing. No network: PayPal is an in-process FAKE
 * (every id contains "MOCK"), prices are labelled placeholders, nothing is charged.
 *   npm run demo:subscription
 */
import { Store } from "../src/store/Database.js";
import { UsageLedger, UsageLimitError, PLACEHOLDER_PRICING } from "../src/metering/UsageLedger.js";
import { PayPalPostbackWebhookVerifier, PayPalSubscriptionsSandboxAdapter } from "../src/billing/subscriptions/PayPalSubscriptionsAdapter.js";
import { ManagedSubscriptionBilling } from "../src/billing/subscriptions/ManagedSubscriptionBilling.js";
import { FakePayPalSubscriptions } from "../src/billing/subscriptions/FakePayPalSubscriptions.js";
import { MANAGED_PLANS_PLACEHOLDER, termsDigest } from "../src/billing/subscriptions/plans.js";

const clock = { t: Date.parse("2026-11-10T09:00:00Z") };
const now = () => clock.t;
const store = new Store(":memory:");
const ledger = new UsageLedger(store, PLACEHOLDER_PRICING, { perRequestSupplierMicro: 10_000_000, monthlyBillableMinor: 100_000 }, now);
const fake = new FakePayPalSubscriptions("MOCKWEBHOOK0001", now);
const adapter = new PayPalSubscriptionsSandboxAdapter({ clientId: "MOCK-CLIENT", clientSecret: "MOCK-SECRET", env: "SANDBOX", fetchImpl: fake.fetch, label: "MOCK" });
const plan = MANAGED_PLANS_PLACEHOLDER[0]!;
const billing = new ManagedSubscriptionBilling(store, ledger, adapter, { plans: [plan], baseUrl: "http://127.0.0.1:8790", webhookVerifier: new PayPalPostbackWebhookVerifier(adapter, fake.webhookId), now });

let step = 0;
const say = (title: string, detail?: unknown) => { console.log(`\n[${++step}] ${title}`); if (detail !== undefined) console.log(typeof detail === "string" ? `    ${detail}` : JSON.stringify(detail, null, 2).replace(/^/gm, "    ")); };
let seq = 0;
const research = (provider: "TAVILY" | "CHANNEL3" = "TAVILY") => {
  const i = ++seq;
  try {
    const r = ledger.begin({ userId: "alice", requestId: `demo-${i}`, provider, operation: "search", logicalKey: `demo-${i}`, quantity: 1, unit: "search", provenance: "MOCK", billable: true });
    ledger.complete(r.record.id, { success: true }); ledger.settleRequest(`demo-${i}`, "alice");
    return "ALLOWED";
  } catch (e) { if (e instanceof UsageLimitError) return `DENIED (${e.reason ?? e.code})`; throw e; }
};

console.log("DIAPORIA Managed subscription billing — MOCK demo (fake PayPal, placeholder prices, nothing charged)");
say("Operator creates the plan at (fake) PayPal: fixed monthly price, included allowance, overage denied", { plan: { ...plan }, termsDigest: termsDigest(plan), created: await billing.ensurePlan(plan.planKey) });
say("Before subscribing, a paid research call is denied", research());

const { subscription, approvalUrl } = await billing.subscribe("alice", plan.planKey, termsDigest(plan));
say("Owner subscribes once, accepting the terms digest (AI clients cannot do this)", { state: subscription.state, approvalUrl });

const ret = await billing.handleBuyerReturn(subscription.id, subscription.paypalSubscriptionId);
say("Browser comes back from PayPal BEFORE approving: DIAPORIA reads PayPal and does not activate", { state: ret.state, call: research() });

fake.buyerApproves(subscription.paypalSubscriptionId!);
const ev = fake.makeWebhook("BILLING.SUBSCRIPTION.ACTIVATED", { id: subscription.paypalSubscriptionId });
say("Buyer approves; PayPal sends a webhook, verified through PayPal's verification API, which triggers an authoritative read", await billing.handlePayPalWebhook(ev.headers, ev.rawBody));
say("Same webhook replayed 3 times", await Promise.all([1, 2, 3].map(() => billing.handlePayPalWebhook(ev.headers, ev.rawBody))));
const tampered = await billing.handlePayPalWebhook(ev.headers, ev.rawBody.replace("ACTIVATED", "CANCELLED"));
say("Tampered webhook body", tampered);
say("Grants for this subscription (one per paid cycle)", billing.grants(subscription.id).map((g) => ({ periodKey: g.periodKey, allowanceMinor: g.allowanceMinor, billedMinor: g.billedMinor })));

const results: Record<string, number> = {};
for (let i = 0; i < 200; i++) { const r = research(); results[r] = (results[r] ?? 0) + 1; }
say("200 Tavily searches without per-call approval: allowance and caps enforced inside the ledger transaction", results);

say("Period statement: billed amount, service price, estimated and reconciled supplier cost kept apart", billing.statement("alice"));

const cancelled = await billing.cancel("alice", subscription.id);
say("Owner cancels: PayPal stops future cycles; the paid period stays usable until its end", { state: cancelled.state, entitlement: billing.entitlementFor("alice").entitled });

say("PayPal calls made by the adapter", fake.calls);
say("Calls that could debit a PayPal balance on DIAPORIA's initiative (capture/vault/orders/activate)", fake.forbiddenCalls());
console.log("\nAll identifiers above are MOCK. No PayPal Sandbox or live API was contacted.");
