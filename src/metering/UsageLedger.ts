import { randomUUID } from "node:crypto";
import type { Store } from "../store/Database.js";

/**
 * Usage meter and cost ledger (v2).
 *  - SUPPLIER side: what a provider may charge DIAPORIA. Integer micro-USD, or NULL when the price is unknown.
 *    A provider call incurs supplier cost even if DIAPORIA later fails and the user is not charged.
 *  - SERVICE side: what a managed user pays DIAPORIA. Integer USD cents, assigned only when the request's
 *    service is actually delivered (settleRequest). A failed service is never billed.
 *  - One logical operation (userId + logicalKey) is billed at most once; retries add supplier attempts only.
 *  - Unknown prices stay unknown (NULL), never 0. Unpriced providers require an explicit per-request call cap.
 *  - Every record carries the price-book version it was estimated with; a version's prices are immutable.
 */
export type Provider = "CHANNEL3" | "TAVILY" | "KERNEL" | "MODEL";
export type UsageStatus = "RESERVED" | "SUCCEEDED" | "FAILED";
export type BillingState = "NOT_BILLABLE" | "PENDING_DELIVERY" | "BILLED" | "NOT_BILLED_SERVICE_FAILED";
export type UsageProvenance = "MOCK" | "BYOK_LIVE" | "MANAGED_LIVE";

export interface PricingBook {
  version: string;
  /** Estimated supplier cost per unit in micro-USD; null = price unknown. */
  supplierMicroPerUnit: Record<Provider, Record<string, number | null>>;
  /** User-facing service price per delivered operation, USD cents (managed mode only). */
  serviceMinorPerOperation: Record<string, number>;
}

/** Labelled placeholder prices for tests and demos. Not real provider or DIAPORIA prices. */
export const PLACEHOLDER_PRICING: PricingBook = Object.freeze({
  version: "2026-11-placeholder-not-real-prices",
  supplierMicroPerUnit: { CHANNEL3: { search: 2_000 }, TAVILY: { search: 8_000, extract: 16_000 }, KERNEL: { browser_second: 500 }, MODEL: { token_1k: 3_000 } },
  serviceMinorPerOperation: { "CHANNEL3:search": 1, "TAVILY:search": 2, "KERNEL:inspect": 5, "MODEL:call": 1 },
}) as PricingBook;

/** For live runs before real contract prices are entered: every supplier price is explicitly UNKNOWN. */
export const LIVE_PRICES_UNKNOWN: PricingBook = Object.freeze({
  version: "live-supplier-prices-unknown",
  supplierMicroPerUnit: { CHANNEL3: { search: null }, TAVILY: { search: null, extract: null }, KERNEL: { browser_second: null }, MODEL: { token_1k: null } },
  serviceMinorPerOperation: {},
}) as PricingBook;

export interface Limits {
  /** Max known estimated supplier cost per request (micro-USD). */
  perRequestSupplierMicro: number;
  /** Max billable service usage per user per calendar month (USD cents). Managed mode. */
  monthlyBillableMinor: number;
  /** Max provider attempts per request. Required for providers whose price is unknown. */
  perRequestCalls?: Partial<Record<Provider, number>>;
}

export class UsageLimitError extends Error {
  constructor(readonly code: "REQUEST_COST_LIMIT" | "MONTHLY_BILLING_LIMIT" | "REQUEST_CALL_LIMIT" | "UNPRICED_PROVIDER_WITHOUT_CALL_CAP", message: string) { super(message); }
}

export interface UsageRecord {
  id: string; requestId: string; userId: string; provider: Provider; operation: string; logicalKey: string;
  attempts: number; quantity: number; unit: string; pricingVersion: string; estSupplierMicro: number | null; finalSupplierMicro: number | null;
  status: UsageStatus; billingState: BillingState; provenance: UsageProvenance; billable: boolean; billableMinor: number; failureReason: string | null; createdAt: number;
}

export interface BeginInput {
  userId: string; requestId: string; provider: Provider; operation: string;
  /** Stable key of the logical operation (provider + op + normalized input). Retries reuse it. */
  logicalKey: string;
  quantity: number; unit: string; provenance: UsageProvenance;
  /** True only in managed mode for user-facing operations. */
  billable: boolean;
}

export class UsageLedger {
  constructor(private readonly store: Store, readonly pricing: PricingBook = PLACEHOLDER_PRICING,
    readonly limits: Limits = { perRequestSupplierMicro: 200_000, monthlyBillableMinor: 500 }, private readonly now: () => number = Date.now) {
    const cols = store.db.prepare("PRAGMA table_info(usage_records)").all() as Array<{ name: string; notnull: number }>;
    if (cols.length && !cols.some((c) => c.name === "billing_state")) store.db.exec("ALTER TABLE usage_records RENAME TO usage_records_legacy_v1");
    store.db.exec(`CREATE TABLE IF NOT EXISTS usage_records (
      id TEXT PRIMARY KEY, request_id TEXT NOT NULL, user_id TEXT NOT NULL, provider TEXT NOT NULL, operation TEXT NOT NULL,
      logical_key TEXT NOT NULL, attempts INTEGER NOT NULL, quantity INTEGER NOT NULL CHECK (quantity >= 0), unit TEXT NOT NULL,
      pricing_version TEXT NOT NULL, est_supplier_micro INTEGER CHECK (est_supplier_micro IS NULL OR est_supplier_micro >= 0), final_supplier_micro INTEGER,
      status TEXT NOT NULL, billing_state TEXT NOT NULL, provenance TEXT NOT NULL, billable INTEGER NOT NULL,
      billable_minor INTEGER NOT NULL CHECK (billable_minor >= 0), failure_reason TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE (user_id, logical_key));
      CREATE INDEX IF NOT EXISTS usage_by_user_time ON usage_records(user_id, created_at);
      CREATE INDEX IF NOT EXISTS usage_by_request ON usage_records(request_id);
      CREATE TABLE IF NOT EXISTS usage_attempts (record_id TEXT NOT NULL, request_id TEXT NOT NULL, provider TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS pricing_versions (version TEXT PRIMARY KEY, book_json TEXT NOT NULL, registered_at INTEGER NOT NULL);`);
    // A pricing version is immutable: the same version string must always carry the same prices.
    const json = JSON.stringify(pricing);
    const existing = store.db.prepare("SELECT book_json FROM pricing_versions WHERE version=?").get(pricing.version) as { book_json: string } | undefined;
    if (existing && existing.book_json !== json) throw new Error(`Pricing version ${pricing.version} already exists with different prices; use a new version`);
    if (!existing) store.db.prepare("INSERT INTO pricing_versions(version,book_json,registered_at) VALUES (?,?,?)").run(pricing.version, json, now());
  }

  /** Estimated supplier cost, or null when the price is unknown. */
  estimateSupplierMicro(provider: Provider, unit: string, quantity: number): number | null {
    if (!Number.isSafeInteger(quantity) || quantity < 0) throw new Error("quantity must be a non-negative integer");
    const book = this.pricing.supplierMicroPerUnit[provider];
    if (!book || !(unit in book)) throw new Error(`Price book ${this.pricing.version} has no entry for ${provider}:${unit}`);
    const per = book[unit];
    return per === null || per === undefined ? null : per * quantity;
  }

  /**
   * Reserves an attempt before the provider is called. Returns `reuse` when the logical operation already
   * SUCCEEDED (no provider call, no charge). All caps are checked inside one IMMEDIATE transaction.
   */
  begin(input: BeginInput): { record: UsageRecord; reuse: boolean } {
    return this.store.transaction(() => {
      const existing = this.get(input.userId, input.logicalKey);
      if (existing?.status === "SUCCEEDED") return { record: existing, reuse: true };
      const est = this.estimateSupplierMicro(input.provider, input.unit, input.quantity);
      const callCap = this.limits.perRequestCalls?.[input.provider];
      if (est === null && callCap === undefined)
        throw new UsageLimitError("UNPRICED_PROVIDER_WITHOUT_CALL_CAP", `${input.provider} price is unknown; an explicit per-request call cap is required`);
      if (callCap !== undefined) {
        const used = (this.store.db.prepare("SELECT COUNT(*) n FROM usage_attempts a JOIN usage_records r ON r.id=a.record_id WHERE a.request_id=? AND a.provider=? AND r.user_id=?")
          .get(input.requestId, input.provider, input.userId) as { n: number }).n;
        if (used + 1 > callCap) throw new UsageLimitError("REQUEST_CALL_LIMIT", `${input.provider} call cap for this request (${callCap}) reached`);
      }
      if (est !== null) {
        const spent = (this.store.db.prepare(`SELECT COALESCE(SUM(est_supplier_micro),0) s FROM usage_records WHERE request_id=? AND user_id=? AND logical_key<>?`)
          .get(input.requestId, input.userId, input.logicalKey) as { s: number }).s + (existing?.estSupplierMicro ?? 0);
        if (spent + est > this.limits.perRequestSupplierMicro)
          throw new UsageLimitError("REQUEST_COST_LIMIT", `Estimated supplier cost would exceed the per-request limit (${this.limits.perRequestSupplierMicro} µUSD)`);
      }
      const price = input.billable ? (this.pricing.serviceMinorPerOperation[`${input.provider}:${input.operation}`] ?? 0) : 0;
      if (price > 0 && this.monthCommittedMinor(input.userId) + price > this.limits.monthlyBillableMinor)
        throw new UsageLimitError("MONTHLY_BILLING_LIMIT", `Monthly billable usage would exceed the limit (${this.limits.monthlyBillableMinor} cents)`);
      const t = this.now();
      let id: string;
      if (existing) {
        id = existing.id;
        // Retry of a failed/abandoned attempt: supplier may charge again; the user is still billed at most once.
        this.store.db.prepare(`UPDATE usage_records SET attempts=attempts+1, est_supplier_micro=CASE WHEN est_supplier_micro IS NULL OR ? IS NULL THEN NULL ELSE est_supplier_micro+? END,
          status='RESERVED', billing_state=?, request_id=?, updated_at=? WHERE id=?`).run(est, est, input.billable ? "PENDING_DELIVERY" : "NOT_BILLABLE", input.requestId, t, id);
      } else {
        id = `use_${randomUUID()}`;
        this.store.db.prepare(`INSERT INTO usage_records(id,request_id,user_id,provider,operation,logical_key,attempts,quantity,unit,pricing_version,est_supplier_micro,
          status,billing_state,provenance,billable,billable_minor,created_at,updated_at) VALUES (?,?,?,?,?,?,1,?,?,?,?,'RESERVED',?,?,?,0,?,?)`)
          .run(id, input.requestId, input.userId, input.provider, input.operation, input.logicalKey, input.quantity, input.unit, this.pricing.version, est,
            input.billable ? "PENDING_DELIVERY" : "NOT_BILLABLE", input.provenance, input.billable ? 1 : 0, t, t);
      }
      this.store.db.prepare("INSERT INTO usage_attempts(record_id,request_id,provider,at) VALUES (?,?,?,?)").run(id, input.requestId, input.provider, t);
      return { record: this.get(input.userId, input.logicalKey)!, reuse: false };
    });
  }

  /** Records the provider outcome. Supplier cost stays recorded either way; billing waits for service delivery. */
  complete(id: string, outcome: { success: boolean; failureReason?: string; actualQuantity?: number }): UsageRecord {
    return this.store.transaction(() => {
      const r = this.byId(id);
      if (!r) throw new Error("usage record not found");
      if (r.status === "SUCCEEDED") return r; // idempotent
      let est = r.estSupplierMicro;
      if (outcome.actualQuantity !== undefined && outcome.actualQuantity !== r.quantity && est !== null) {
        const before = this.estimateSupplierMicro(r.provider, r.unit, r.quantity), after = this.estimateSupplierMicro(r.provider, r.unit, outcome.actualQuantity);
        est = before === null || after === null ? null : est - before + after;
      }
      this.store.db.prepare(`UPDATE usage_records SET status=?, est_supplier_micro=?, quantity=?, failure_reason=?,
        billing_state=CASE WHEN ?=0 AND billing_state='PENDING_DELIVERY' THEN 'NOT_BILLED_SERVICE_FAILED' ELSE billing_state END, updated_at=? WHERE id=?`)
        .run(outcome.success ? "SUCCEEDED" : "FAILED", est, outcome.actualQuantity ?? r.quantity, outcome.failureReason ?? null, outcome.success ? 1 : 0, this.now(), id);
      return this.byId(id)!;
    });
  }

  /** The request's service was delivered: bill its successful, billable, not-yet-billed operations (once). */
  settleRequest(requestId: string, userId: string): void {
    this.store.transaction(() => {
      for (const r of this.forRequest(requestId, userId)) {
        if (r.status === "SUCCEEDED" && r.billingState === "PENDING_DELIVERY") {
          const price = this.pricing.serviceMinorPerOperation[`${r.provider}:${r.operation}`] ?? 0;
          this.store.db.prepare("UPDATE usage_records SET billing_state='BILLED', billable_minor=?, updated_at=? WHERE id=? AND billing_state='PENDING_DELIVERY'").run(price, this.now(), r.id);
        }
      }
    });
  }

  /** The request failed after provider calls: supplier costs remain, nothing is billed. */
  abandonRequest(requestId: string, userId: string): void {
    this.store.db.prepare("UPDATE usage_records SET billing_state='NOT_BILLED_SERVICE_FAILED', updated_at=? WHERE request_id=? AND user_id=? AND billing_state='PENDING_DELIVERY'")
      .run(this.now(), requestId, userId);
  }

  /** Enters a figure from a real provider statement. Until then, costs are estimates (or unknown). */
  reconcileSupplierCost(id: string, finalSupplierMicro: number): void {
    if (!Number.isSafeInteger(finalSupplierMicro) || finalSupplierMicro < 0) throw new Error("final cost must be integer micro-USD");
    this.store.db.prepare("UPDATE usage_records SET final_supplier_micro=?, updated_at=? WHERE id=?").run(finalSupplierMicro, this.now(), id);
  }

  /** Billed plus pending (committed) cents this month, used for the hard monthly cap. */
  monthCommittedMinor(userId: string, at = this.now()): number {
    const { start, end } = monthBounds(at);
    const rows = this.store.db.prepare("SELECT provider, operation, billing_state, billable_minor FROM usage_records WHERE user_id=? AND created_at>=? AND created_at<? AND billing_state IN ('BILLED','PENDING_DELIVERY')")
      .all(userId, start, end) as Array<{ provider: string; operation: string; billing_state: string; billable_minor: number }>;
    return rows.reduce((a, r) => a + (r.billing_state === "BILLED" ? r.billable_minor : (this.pricing.serviceMinorPerOperation[`${r.provider}:${r.operation}`] ?? 0)), 0);
  }

  summary(userId: string, at = this.now()) {
    const { start, end, label } = monthBounds(at);
    const rows = this.store.db.prepare(`SELECT provider, operation, status, billing_state, provenance, pricing_version, COUNT(*) n, SUM(attempts) attempts,
      SUM(CASE WHEN est_supplier_micro IS NULL THEN 1 ELSE 0 END) unknown_cost, SUM(COALESCE(est_supplier_micro,0)) est,
      SUM(CASE WHEN final_supplier_micro IS NULL THEN 0 ELSE 1 END) reconciled, SUM(COALESCE(final_supplier_micro,0)) final, SUM(billable_minor) billable
      FROM usage_records WHERE user_id=? AND created_at>=? AND created_at<? GROUP BY provider, operation, status, billing_state, provenance, pricing_version ORDER BY provider, operation`)
      .all(userId, start, end) as Array<Record<string, number | string>>;
    const lines = rows.map((r) => ({ provider: String(r.provider), operation: String(r.operation), status: String(r.status), billingState: String(r.billing_state),
      provenance: String(r.provenance), pricingVersion: String(r.pricing_version), operations: Number(r.n), attempts: Number(r.attempts),
      unknownCostRecords: Number(r.unknown_cost), estimatedSupplierMicroUsd: Number(r.unknown_cost) > 0 && Number(r.unknown_cost) === Number(r.n) ? null : Number(r.est),
      reconciledRecords: Number(r.reconciled), reconciledSupplierMicroUsd: Number(r.final), billableMinor: Number(r.billable) }));
    const unknown = lines.reduce((a, l) => a + l.unknownCostRecords, 0);
    return {
      userId, period: label, pricingVersions: [...new Set(lines.map((l) => l.pricingVersion))], lines,
      totals: { knownEstimatedSupplierMicroUsd: lines.reduce((a, l) => a + (l.estimatedSupplierMicroUsd ?? 0), 0), unknownCostRecords: unknown,
        supplierCostComplete: unknown === 0, billableMinor: lines.reduce((a, l) => a + l.billableMinor, 0),
        failedOperations: lines.filter((l) => l.status === "FAILED").reduce((a, l) => a + l.operations, 0) },
      limits: this.limits,
      disclosure: "Supplier costs are estimates (or explicitly unknown), not provider invoices. Billable amounts apply only in managed mode and only to delivered service.",
    };
  }

  forRequest(requestId: string, userId: string): UsageRecord[] {
    return (this.store.db.prepare("SELECT * FROM usage_records WHERE request_id=? AND user_id=? ORDER BY created_at").all(requestId, userId) as Row[]).map(toRecord);
  }

  private get(userId: string, logicalKey: string): UsageRecord | null {
    const r = this.store.db.prepare("SELECT * FROM usage_records WHERE user_id=? AND logical_key=?").get(userId, logicalKey) as Row | undefined;
    return r ? toRecord(r) : null;
  }
  private byId(id: string): UsageRecord | null {
    const r = this.store.db.prepare("SELECT * FROM usage_records WHERE id=?").get(id) as Row | undefined;
    return r ? toRecord(r) : null;
  }
}

type Row = Record<string, string | number | null>;
function toRecord(r: Row): UsageRecord {
  return { id: String(r.id), requestId: String(r.request_id), userId: String(r.user_id), provider: r.provider as Provider, operation: String(r.operation),
    logicalKey: String(r.logical_key), attempts: Number(r.attempts), quantity: Number(r.quantity), unit: String(r.unit), pricingVersion: String(r.pricing_version),
    estSupplierMicro: r.est_supplier_micro === null ? null : Number(r.est_supplier_micro), finalSupplierMicro: r.final_supplier_micro === null ? null : Number(r.final_supplier_micro),
    status: r.status as UsageStatus, billingState: r.billing_state as BillingState, provenance: r.provenance as UsageProvenance, billable: Number(r.billable) === 1,
    billableMinor: Number(r.billable_minor), failureReason: r.failure_reason === null ? null : String(r.failure_reason), createdAt: Number(r.created_at) };
}

export function monthBounds(at: number): { start: number; end: number; label: string } {
  const d = new Date(at);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  return { start, end, label: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}` };
}
