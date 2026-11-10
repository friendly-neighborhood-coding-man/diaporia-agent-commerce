import { createHmac, timingSafeEqual } from "node:crypto";
import type { Store } from "../store/Database.js";

/**
 * SERVICE BILLING bounded context: DIAPORIA charging a managed user for DIAPORIA's own service.
 * Completely separate from purchase mandates and merchandise checkout: it never authorizes a purchase,
 * and a purchase mandate never authorizes service billing. No stored value, escrow or fund collection
 * on behalf of third parties.
 *
 * PayPal facts checked 2026-11-10 (developer.paypal.com Subscriptions v1): plans support fixed_price or
 * VOLUME/TIERED pricing_model with quantity; no documented metered usage-reporting endpoint;
 * /v1/billing/subscriptions/{id}/capture only clears an OUTSTANDING_BALANCE. So usage-based PayPal
 * billing would need a plan design decision (e.g. tiered monthly plans). Only a MOCK provider exists here.
 */
export type BillingAuthorizationStatus = "ACTIVE" | "APPROVAL_PENDING" | "SUSPENDED" | "CANCELLED" | "EXPIRED" | "NONE" | "UNKNOWN";

export interface BillingAuthorization {
  userId: string;
  status: BillingAuthorizationStatus;
  planId: string | null;
  source: "MOCK_PAYPAL_SUBSCRIPTIONS" | "PAYPAL_SUBSCRIPTIONS" | "PAYPAL_SANDBOX_SUBSCRIPTIONS";
  subscriptionRef: string | null;
  verifiedAt: string;
  /** Subscription billing only: why the user is (not) entitled right now, and the current paid period. */
  entitlement?: unknown;
}

export interface BillingPlan { planId: string; name: string; currency: "USD"; monthlyCapMinor: number; description: string }

export interface PeriodSummary {
  userId: string; period: string; currency: "USD"; billableMinor: number; lines: Array<{ item: string; operations: number; billableMinor: number }>;
  status: "DRAFT_NOT_INVOICED" | "SUBMITTED_MOCK"; disclosure: string;
}

export class BillingUnavailableError extends Error {}

export interface BillingProvider {
  readonly name: string;
  getAuthorization(userId: string): Promise<BillingAuthorization>;
  /** Records a period summary with the billing system. MOCK only here: nothing is charged. Not used by subscription billing. */
  submitPeriodSummary?(summary: PeriodSummary): Promise<{ status: "SUBMITTED_MOCK"; reference: string }>;
}

/**
 * Mock of a PayPal-Subscriptions-backed billing account store. State changes only through
 * `setFixtureState` (tests) or a verified (HMAC) mock webhook. Labelled MOCK in every output.
 */
export class MockPayPalBillingProvider implements BillingProvider {
  readonly name = "mock-paypal-subscriptions";
  available = true;
  readonly plans: BillingPlan[] = [{ planId: "MOCK-PLAN-STARTER", name: "DIAPORIA Managed Starter (mock)", currency: "USD", monthlyCapMinor: 500, description: "Placeholder plan for tests; not a real price" }];
  constructor(private readonly store: Store, private readonly webhookSecret: string, private readonly now: () => number = Date.now) {
    if (webhookSecret.length < 16) throw new Error("mock billing webhook secret too short");
    store.db.exec(`CREATE TABLE IF NOT EXISTS billing_accounts (user_id TEXT PRIMARY KEY, status TEXT NOT NULL, plan_id TEXT, subscription_ref TEXT, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS billing_events (event_id TEXT PRIMARY KEY, user_id TEXT, type TEXT NOT NULL, received_at INTEGER NOT NULL, outcome TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS billing_summaries (reference TEXT PRIMARY KEY, user_id TEXT NOT NULL, period TEXT NOT NULL, billable_minor INTEGER NOT NULL, submitted_at INTEGER NOT NULL, UNIQUE(user_id, period));`);
  }

  setFixtureState(userId: string, status: BillingAuthorizationStatus, planId = "MOCK-PLAN-STARTER") {
    this.store.db.prepare(`INSERT INTO billing_accounts(user_id,status,plan_id,subscription_ref,updated_at) VALUES (?,?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET status=excluded.status, plan_id=excluded.plan_id, updated_at=excluded.updated_at`).run(userId, status, planId, `MOCK-SUB-${userId}`, this.now());
  }

  async getAuthorization(userId: string): Promise<BillingAuthorization> {
    if (!this.available) throw new BillingUnavailableError("Billing provider unavailable");
    const r = this.store.db.prepare("SELECT * FROM billing_accounts WHERE user_id=?").get(userId) as Record<string, string | number> | undefined;
    return { userId, status: (r?.status as BillingAuthorizationStatus) ?? "NONE", planId: r ? String(r.plan_id) : null, source: "MOCK_PAYPAL_SUBSCRIPTIONS",
      subscriptionRef: r ? String(r.subscription_ref) : null, verifiedAt: new Date(this.now()).toISOString() };
  }

  async submitPeriodSummary(s: PeriodSummary) {
    if (!this.available) throw new BillingUnavailableError("Billing provider unavailable");
    const reference = `MOCK-BILL-${s.userId}-${s.period}`;
    // Idempotent per user and period: re-submission never creates a second bill.
    this.store.db.prepare(`INSERT INTO billing_summaries(reference,user_id,period,billable_minor,submitted_at) VALUES (?,?,?,?,?)
      ON CONFLICT(user_id, period) DO UPDATE SET billable_minor=excluded.billable_minor`).run(reference, s.userId, s.period, s.billableMinor, this.now());
    return { status: "SUBMITTED_MOCK" as const, reference };
  }

  /** Mock webhook (HMAC-SHA256 over the raw body). Real PayPal webhooks use PayPal's own verification. */
  handleWebhook(rawBody: string, signature: string | undefined): { accepted: boolean; outcome: string } {
    const expected = createHmac("sha256", this.webhookSecret).update(rawBody).digest();
    let given: Buffer;
    try { given = Buffer.from(signature ?? "", "hex"); } catch { return { accepted: false, outcome: "BAD_SIGNATURE" }; }
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { accepted: false, outcome: "BAD_SIGNATURE" };
    let e: { id?: string; event_type?: string; resource?: { custom_id?: string; status?: string } };
    try { e = JSON.parse(rawBody); } catch { return { accepted: false, outcome: "MALFORMED" }; }
    const map: Record<string, BillingAuthorizationStatus> = { "BILLING.SUBSCRIPTION.ACTIVATED": "ACTIVE", "BILLING.SUBSCRIPTION.SUSPENDED": "SUSPENDED",
      "BILLING.SUBSCRIPTION.CANCELLED": "CANCELLED", "BILLING.SUBSCRIPTION.EXPIRED": "EXPIRED" };
    const userId = e.resource?.custom_id;
    if (!e.id || !e.event_type || !userId || !map[e.event_type]) return { accepted: true, outcome: "IGNORED" };
    const ins = this.store.db.prepare("INSERT OR IGNORE INTO billing_events(event_id,user_id,type,received_at,outcome) VALUES (?,?,?,?,?)").run(e.id, userId, e.event_type, this.now(), "APPLIED");
    if (ins.changes === 0) return { accepted: true, outcome: "DUPLICATE" };
    this.setFixtureState(userId, map[e.event_type]!);
    return { accepted: true, outcome: `APPLIED_${map[e.event_type]}` };
  }
}

/** Builds a period summary from the usage ledger. Purely derived; nothing is charged. */
export function periodSummaryFrom(ledgerSummary: { userId: string; period: string; lines: Array<{ provider: string; operation: string; status: string; operations: number; billableMinor: number }> }): PeriodSummary {
  const lines = ledgerSummary.lines.filter((l) => l.status === "SUCCEEDED" && l.billableMinor > 0)
    .map((l) => ({ item: `DIAPORIA research service: ${l.provider} ${l.operation}`, operations: l.operations, billableMinor: l.billableMinor }));
  return { userId: ledgerSummary.userId, period: ledgerSummary.period, currency: "USD", billableMinor: lines.reduce((a, l) => a + l.billableMinor, 0), lines,
    status: "DRAFT_NOT_INVOICED", disclosure: "Simulated service-billing summary. Not an invoice; no PayPal subscription, order or capture exists." };
}
