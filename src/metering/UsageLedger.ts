import { randomUUID } from "node:crypto";
import type { Store } from "../store/Database.js";

/**
 * Usage meter and cost ledger.
 *  - Supplier cost (what a provider may charge DIAPORIA) is kept in integer MICRO-USD (1 USD = 1_000_000).
 *  - Billable service usage (what a managed user pays DIAPORIA) is kept in integer USD MINOR units (cents).
 *  - The two are recorded separately; a provider cost estimate is never an invoice (finalSupplierMicro stays null
 *    until reconciled against a real provider statement).
 *  - One logical operation (userId + logicalKey) is billed at most once, however many attempts it takes.
 */
export type Provider = "CHANNEL3" | "TAVILY" | "KERNEL" | "MODEL";
export type UsageStatus = "RESERVED" | "SUCCEEDED" | "FAILED";
export type UsageProvenance = "MOCK" | "BYOK_LIVE" | "MANAGED_LIVE";

export interface PricingBook {
  version: string;
  /** Estimated supplier cost per unit, micro-USD. PLACEHOLDERS until provider contracts are entered. */
  supplierMicroPerUnit: Record<Provider, Record<string, number>>;
  /** User-facing service price per completed operation, USD minor units (managed mode only). */
  serviceMinorPerOperation: Record<string, number>;
}

/** Clearly-labelled placeholder prices for tests and demos. Not real provider or DIAPORIA prices. */
export const PLACEHOLDER_PRICING: PricingBook = {
  version: "2026-11-placeholder-not-real-prices",
  supplierMicroPerUnit: {
    CHANNEL3: { search: 2_000 },
    TAVILY: { search: 8_000, extract: 16_000 },
    KERNEL: { browser_second: 500 },
    MODEL: { token_1k: 3_000 },
  },
  serviceMinorPerOperation: { "CHANNEL3:search": 1, "TAVILY:search": 2, "KERNEL:inspect": 5, "MODEL:call": 1 },
};

export interface Limits {
  /** Max estimated supplier cost per request (micro-USD). */
  perRequestSupplierMicro: number;
  /** Max billable service usage per user per calendar month (USD minor units). Managed mode. */
  monthlyBillableMinor: number;
}

export class UsageLimitError extends Error {
  constructor(readonly code: "REQUEST_COST_LIMIT" | "MONTHLY_BILLING_LIMIT", message: string) { super(message); }
}

export interface UsageRecord {
  id: string; requestId: string; userId: string; provider: Provider; operation: string; logicalKey: string;
  attempts: number; quantity: number; unit: string; pricingVersion: string; estSupplierMicro: number; finalSupplierMicro: number | null;
  status: UsageStatus; provenance: UsageProvenance; billable: boolean; billableMinor: number; failureReason: string | null; createdAt: number;
}

export interface BeginInput {
  userId: string; requestId: string; provider: Provider; operation: string;
  /** Stable key of the logical operation (e.g. provider+op+normalized query). Retries reuse it. */
  logicalKey: string;
  quantity: number; unit: string; provenance: UsageProvenance;
  /** True only in managed mode for user-facing operations. */
  billable: boolean;
}

export class UsageLedger {
  constructor(private readonly store: Store, readonly pricing: PricingBook = PLACEHOLDER_PRICING, readonly limits: Limits = { perRequestSupplierMicro: 200_000, monthlyBillableMinor: 500 },
    private readonly now: () => number = Date.now) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS usage_records (
      id TEXT PRIMARY KEY, request_id TEXT NOT NULL, user_id TEXT NOT NULL, provider TEXT NOT NULL, operation TEXT NOT NULL,
      logical_key TEXT NOT NULL, attempts INTEGER NOT NULL, quantity INTEGER NOT NULL CHECK (quantity >= 0), unit TEXT NOT NULL,
      pricing_version TEXT NOT NULL, est_supplier_micro INTEGER NOT NULL CHECK (est_supplier_micro >= 0), final_supplier_micro INTEGER,
      status TEXT NOT NULL, provenance TEXT NOT NULL, billable INTEGER NOT NULL, billable_minor INTEGER NOT NULL CHECK (billable_minor >= 0),
      failure_reason TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE (user_id, logical_key));
      CREATE INDEX IF NOT EXISTS usage_by_user_time ON usage_records(user_id, created_at);
      CREATE INDEX IF NOT EXISTS usage_by_request ON usage_records(request_id);`);
  }

  estimateSupplierMicro(provider: Provider, unit: string, quantity: number): number {
    const per = this.pricing.supplierMicroPerUnit[provider]?.[unit];
    if (per === undefined) throw new Error(`No placeholder price for ${provider}:${unit}`);
    if (!Number.isSafeInteger(quantity) || quantity < 0) throw new Error("quantity must be a non-negative integer");
    return per * quantity;
  }

  /**
   * Reserves a logical operation before the provider is called. Returns `reuse` when the same logical
   * operation already SUCCEEDED (no new provider call, no new charge). Limits are checked atomically.
   */
  begin(input: BeginInput): { record: UsageRecord; reuse: boolean } {
    return this.store.transaction(() => {
      const existing = this.get(input.userId, input.logicalKey);
      if (existing?.status === "SUCCEEDED") return { record: existing, reuse: true };
      const est = this.estimateSupplierMicro(input.provider, input.unit, input.quantity);
      const serviceMinor = input.billable ? (this.pricing.serviceMinorPerOperation[`${input.provider}:${input.operation}`] ?? 0) : 0;
      const requestSpent = (this.store.db.prepare("SELECT COALESCE(SUM(est_supplier_micro),0) s FROM usage_records WHERE request_id=? AND user_id=? AND logical_key<>?")
        .get(input.requestId, input.userId, input.logicalKey) as { s: number }).s + (existing?.estSupplierMicro ?? 0);
      if (requestSpent + est > this.limits.perRequestSupplierMicro)
        throw new UsageLimitError("REQUEST_COST_LIMIT", `Estimated supplier cost would exceed the per-request limit (${this.limits.perRequestSupplierMicro} µUSD)`);
      if (serviceMinor > 0) {
        const month = this.monthBillableMinor(input.userId);
        if (month + serviceMinor > this.limits.monthlyBillableMinor)
          throw new UsageLimitError("MONTHLY_BILLING_LIMIT", `Monthly billable usage would exceed the limit (${this.limits.monthlyBillableMinor} minor units)`);
      }
      const t = this.now();
      if (existing) {
        // Retry of a failed/reserved logical operation: the supplier may charge again; the user is billed once.
        this.store.db.prepare(`UPDATE usage_records SET attempts=attempts+1, est_supplier_micro=est_supplier_micro+?, status='RESERVED', request_id=?, updated_at=? WHERE id=?`)
          .run(est, input.requestId, t, existing.id);
        return { record: this.get(input.userId, input.logicalKey)!, reuse: false };
      }
      const id = `use_${randomUUID()}`;
      this.store.db.prepare(`INSERT INTO usage_records(id,request_id,user_id,provider,operation,logical_key,attempts,quantity,unit,pricing_version,est_supplier_micro,
        status,provenance,billable,billable_minor,created_at,updated_at) VALUES (?,?,?,?,?,?,1,?,?,?,?,'RESERVED',?,?,0,?,?)`)
        .run(id, input.requestId, input.userId, input.provider, input.operation, input.logicalKey, input.quantity, input.unit, this.pricing.version, est,
          input.provenance, input.billable ? 1 : 0, t, t);
      return { record: this.get(input.userId, input.logicalKey)!, reuse: false };
    });
  }

  /** Marks the outcome. Billable amount is assigned only on success, and only once. */
  complete(id: string, outcome: { success: boolean; failureReason?: string; actualQuantity?: number }): UsageRecord {
    return this.store.transaction(() => {
      const r = this.byId(id);
      if (!r) throw new Error("usage record not found");
      if (r.status === "SUCCEEDED") return r; // idempotent
      const serviceMinor = outcome.success && r.billable ? (this.pricing.serviceMinorPerOperation[`${r.provider}:${r.operation}`] ?? 0) : 0;
      let est = r.estSupplierMicro;
      if (outcome.actualQuantity !== undefined && outcome.actualQuantity !== r.quantity) {
        est = r.estSupplierMicro - this.estimateSupplierMicro(r.provider, r.unit, r.quantity) + this.estimateSupplierMicro(r.provider, r.unit, outcome.actualQuantity);
      }
      this.store.db.prepare("UPDATE usage_records SET status=?, billable_minor=?, est_supplier_micro=?, quantity=?, failure_reason=?, updated_at=? WHERE id=?")
        .run(outcome.success ? "SUCCEEDED" : "FAILED", serviceMinor, est, outcome.actualQuantity ?? r.quantity, outcome.failureReason ?? null, this.now(), id);
      return this.byId(id)!;
    });
  }

  /** Enters a real provider-statement figure. Until then, costs are estimates only. */
  reconcileSupplierCost(id: string, finalSupplierMicro: number): void {
    if (!Number.isSafeInteger(finalSupplierMicro) || finalSupplierMicro < 0) throw new Error("final cost must be integer micro-USD");
    this.store.db.prepare("UPDATE usage_records SET final_supplier_micro=?, updated_at=? WHERE id=?").run(finalSupplierMicro, this.now(), id);
  }

  monthBillableMinor(userId: string, at = this.now()): number {
    const { start, end } = monthBounds(at);
    return (this.store.db.prepare("SELECT COALESCE(SUM(billable_minor),0) s FROM usage_records WHERE user_id=? AND created_at>=? AND created_at<?").get(userId, start, end) as { s: number }).s;
  }

  summary(userId: string, at = this.now()) {
    const { start, end, label } = monthBounds(at);
    const rows = this.store.db.prepare(`SELECT provider, operation, status, provenance, COUNT(*) n, SUM(attempts) attempts, SUM(est_supplier_micro) est,
      SUM(CASE WHEN final_supplier_micro IS NULL THEN 0 ELSE 1 END) reconciled, SUM(COALESCE(final_supplier_micro,0)) final, SUM(billable_minor) billable
      FROM usage_records WHERE user_id=? AND created_at>=? AND created_at<? GROUP BY provider, operation, status, provenance ORDER BY provider, operation`).all(userId, start, end) as Array<Record<string, number | string>>;
    const lines = rows.map((r) => ({ provider: String(r.provider), operation: String(r.operation), status: String(r.status), provenance: String(r.provenance),
      operations: Number(r.n), attempts: Number(r.attempts), estimatedSupplierMicroUsd: Number(r.est), reconciledRecords: Number(r.reconciled),
      reconciledSupplierMicroUsd: Number(r.final), billableMinor: Number(r.billable) }));
    return {
      userId, period: label, pricingVersion: this.pricing.version, lines,
      totals: { estimatedSupplierMicroUsd: lines.reduce((a, l) => a + l.estimatedSupplierMicroUsd, 0), billableMinor: lines.reduce((a, l) => a + l.billableMinor, 0),
        failedOperations: lines.filter((l) => l.status === "FAILED").reduce((a, l) => a + l.operations, 0) },
      limits: this.limits,
      disclosure: "Supplier costs are estimates from a placeholder price book, not provider invoices. Billable amounts apply only in managed mode.",
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
    estSupplierMicro: Number(r.est_supplier_micro), finalSupplierMicro: r.final_supplier_micro === null ? null : Number(r.final_supplier_micro),
    status: r.status as UsageStatus, provenance: r.provenance as UsageProvenance, billable: Number(r.billable) === 1, billableMinor: Number(r.billable_minor),
    failureReason: r.failure_reason === null ? null : String(r.failure_reason), createdAt: Number(r.created_at) };
}

export function monthBounds(at: number): { start: number; end: number; label: string } {
  const d = new Date(at);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  return { start, end, label: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}` };
}
