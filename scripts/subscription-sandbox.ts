/**
 * PayPal SANDBOX procedure for managed subscription billing. EVERY PayPal call requires the owner's
 * explicit approval of the exact step digest printed by `plan`. Nothing here can reach live PayPal.
 *
 *   npx tsx scripts/subscription-sandbox.ts plan [--user alice]            # no network; prints each step and its digest
 *   npx tsx scripts/subscription-sandbox.ts <step> --approve <digest> [--user alice] [--env-file .env.sandbox]
 *   steps: create-plan | subscribe | status | cancel
 *
 * See docs/SUBSCRIPTION_SANDBOX_PROCEDURE.md. Requires PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET (Sandbox app),
 * PAYPAL_ENV=SANDBOX. Plan prices are the labelled placeholder catalog (Sandbox money only).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { Store } from "../src/store/Database.js";
import { UsageLedger, PLACEHOLDER_PRICING } from "../src/metering/UsageLedger.js";
import { PayPalSubscriptionsSandboxAdapter, PAYPAL_SANDBOX_API } from "../src/billing/subscriptions/PayPalSubscriptionsAdapter.js";
import { ManagedSubscriptionBilling } from "../src/billing/subscriptions/ManagedSubscriptionBilling.js";
import { MANAGED_PLANS_PLACEHOLDER, termsDigest } from "../src/billing/subscriptions/plans.js";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { approve: { type: "string" }, user: { type: "string", default: "sandbox-owner" },
  "env-file": { type: "string" }, db: { type: "string", default: ".data/subscription-sandbox.sqlite" }, "base-url": { type: "string", default: "http://127.0.0.1:8790" } } });
const step = positionals[0] ?? "plan";
const plan = MANAGED_PLANS_PLACEHOLDER[0]!;
const STEPS: Record<string, { calls: string[]; effect: string }> = {
  "create-plan": { calls: ["POST /v1/oauth2/token", "POST /v1/catalogs/products", "POST /v1/billing/plans"], effect: "Creates one Sandbox catalog product and one ACTIVE Sandbox billing plan (fixed monthly placeholder price)." },
  subscribe: { calls: ["POST /v1/oauth2/token", "POST /v1/billing/subscriptions"], effect: "Creates one Sandbox subscription in APPROVAL_PENDING and prints its approval URL. Nothing is charged unless a Sandbox buyer approves it in the browser." },
  status: { calls: ["POST /v1/oauth2/token", "GET /v1/billing/subscriptions/{id}"], effect: "Read-only status check. May record a grant locally if PayPal reports a completed cycle." },
  cancel: { calls: ["POST /v1/oauth2/token", "POST /v1/billing/subscriptions/{id}/cancel", "GET /v1/billing/subscriptions/{id}"], effect: "Cancels the Sandbox subscription (stops future Sandbox cycles)." },
};
const digestOf = (s: string) => createHash("sha256").update(JSON.stringify({ step: s, user: values.user, host: PAYPAL_SANDBOX_API, plan: termsDigest(plan), calls: STEPS[s]!.calls })).digest("hex").slice(0, 16);

if (step === "plan") {
  console.log(`Sandbox host: ${PAYPAL_SANDBOX_API}\nPlan: ${plan.name} ${plan.version}, ${plan.priceLabel}\nTerms digest: ${termsDigest(plan)}\nUser: ${values.user}\n`);
  for (const [name, s] of Object.entries(STEPS)) console.log(`${name}\n  calls:  ${s.calls.join(", ")}\n  effect: ${s.effect}\n  approve with: --approve ${digestOf(name)}\n`);
  console.log("No PayPal call was made.");
  process.exit(0);
}
if (!STEPS[step]) { console.error(`Unknown step ${step}`); process.exit(2); }
if (values.approve !== digestOf(step)) { console.error(`REFUSED: step "${step}" needs the owner's approval digest (run "plan" to see it). No PayPal call was made.`); process.exit(3); }

const env: Record<string, string | undefined> = { ...process.env };
if (values["env-file"]) for (const line of readFileSync(values["env-file"], "utf8").split(/\r?\n/)) {
  const m = /^\s*(PAYPAL_CLIENT_ID|PAYPAL_CLIENT_SECRET|PAYPAL_ENV)\s*=\s*(.*?)\s*$/.exec(line);
  if (m && m[2]) env[m[1]!] = m[2].replace(/^["']|["']$/g, "");
}
const adapter = new PayPalSubscriptionsSandboxAdapter({ clientId: env.PAYPAL_CLIENT_ID ?? "", clientSecret: env.PAYPAL_CLIENT_SECRET ?? "", env: env.PAYPAL_ENV ?? "SANDBOX" });
const store = new Store(values.db!);
const billing = new ManagedSubscriptionBilling(store, new UsageLedger(store, PLACEHOLDER_PRICING), adapter, { plans: [plan], baseUrl: values["base-url"]! });
const user = values.user!;
const latest = () => billing.forUser(user)[0] ?? null;
const show = (s: ReturnType<typeof latest>) => s && ({ id: s.id, state: s.state, providerStatus: s.providerStatus, holdReason: s.holdReason, lastError: s.lastError, grants: billing.grants(s.id).map((g) => g.periodKey) });

if (step === "create-plan") console.log(await billing.ensurePlan(plan.planKey));
if (step === "subscribe") {
  const out = await billing.subscribe(user, plan.planKey, termsDigest(plan));
  console.log({ ...show(out.subscription), approvalUrl: out.approvalUrl, next: "Open the approval URL signed in as a Sandbox PERSONAL test account, then run the status step." });
}
if (step === "status") { const s = latest(); if (!s) throw new Error("No local subscription"); console.log(show(await billing.refresh(s.id)), await billing.getAuthorization(user)); }
if (step === "cancel") { const s = latest(); if (!s) throw new Error("No local subscription"); console.log(show(await billing.cancel(user, s.id))); }
store.close();
