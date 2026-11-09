import { randomBytes } from "node:crypto";
import type { Store } from "../../store/Database.js";
import type { UsageLedger } from "../../metering/UsageLedger.js";
import { MockPayPalBillingProvider, type BillingProvider } from "../Billing.js";
import { ManagedSubscriptionBilling } from "./ManagedSubscriptionBilling.js";
import { PayPalPostbackWebhookVerifier, PayPalSubscriptionsSandboxAdapter } from "./PayPalSubscriptionsAdapter.js";
import { FakePayPalSubscriptions } from "./FakePayPalSubscriptions.js";
import { MANAGED_PLANS_PLACEHOLDER, MANAGED_PLANS_PRICES_UNKNOWN } from "./plans.js";

/**
 * Chooses the managed-mode billing provider from the environment.
 *  MANAGED_BILLING=subscriptions-mock (default): subscription billing against an in-process FAKE PayPal,
 *    placeholder plan prices. Nothing leaves the process.
 *  MANAGED_BILLING=paypal-sandbox-subscriptions: the real Sandbox adapter. Plan prices are UNKNOWN (so
 *    nothing can be subscribed) unless MANAGED_PLAN_PRICES=placeholder is set explicitly. Billing webhooks
 *    need PAYPAL_BILLING_WEBHOOK_ID (verified through PayPal's verification API).
 *  MANAGED_BILLING=legacy-mock: the previous HMAC mock account store (kept for compatibility).
 */
export function createManagedBilling(env: NodeJS.ProcessEnv, store: Store, ledger: UsageLedger, baseUrl: string): BillingProvider {
  const kind = (env.MANAGED_BILLING ?? "subscriptions-mock").toLowerCase();
  if (kind === "legacy-mock") return new MockPayPalBillingProvider(store, env.MOCK_BILLING_WEBHOOK_SECRET ?? randomBytes(24).toString("hex"));
  if (kind === "paypal-sandbox-subscriptions") {
    const adapter = new PayPalSubscriptionsSandboxAdapter({ clientId: env.PAYPAL_CLIENT_ID ?? "", clientSecret: env.PAYPAL_CLIENT_SECRET ?? "", env: env.PAYPAL_ENV ?? "SANDBOX" });
    const plans = env.MANAGED_PLAN_PRICES === "placeholder" ? MANAGED_PLANS_PLACEHOLDER : MANAGED_PLANS_PRICES_UNKNOWN;
    return new ManagedSubscriptionBilling(store, ledger, adapter, { plans, baseUrl,
      webhookVerifier: env.PAYPAL_BILLING_WEBHOOK_ID ? new PayPalPostbackWebhookVerifier(adapter, env.PAYPAL_BILLING_WEBHOOK_ID) : null });
  }
  if (kind !== "subscriptions-mock") throw new Error(`Unknown MANAGED_BILLING=${kind}`);
  const fake = new FakePayPalSubscriptions();
  const adapter = new PayPalSubscriptionsSandboxAdapter({ clientId: "MOCK-CLIENT", clientSecret: "MOCK-SECRET", env: "SANDBOX", fetchImpl: fake.fetch, label: "MOCK" });
  return new ManagedSubscriptionBilling(store, ledger, adapter, { plans: MANAGED_PLANS_PLACEHOLDER, baseUrl, webhookVerifier: new PayPalPostbackWebhookVerifier(adapter, fake.webhookId) });
}
