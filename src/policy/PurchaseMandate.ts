import { randomUUID } from "node:crypto";
import type { ProductIdentity } from "../domain/types.js";
import { assertMinor, isCurrency, type Currency } from "../domain/money.js";
import type { Store } from "../store/Database.js";

export type MandateStatus = "ACTIVE" | "EXHAUSTED" | "REVOKED" | "EXPIRED";

/**
 * A user-created spending bound. It is DIAPORIA-side policy only: it does not create a
 * PayPal-enforced cap, wallet, or virtual card. PayPal buyer approval is still required.
 */
export interface PurchaseMandate {
  mandateId: string;
  userId: string;
  productIdentity: ProductIdentity;
  currency: Currency;
  maximumTotalMinor: number;
  maximumQuantity: number;
  maximumTransactions: number;
  expiresAt: string;
  merchantConstraints: { allowedMerchantIds: string[] | null };
  authorizationStatus: MandateStatus;
  /** Set when the mandate is bound to its first checkout session. */
  checkoutSessionId: string | null;
  revokedAt: string | null;
  reservedMinor: number;
  consumedMinor: number;
  transactionsUsed: number;
  createdVia: "OWNER_API" | "OWNER_APPROVAL_PAGE";
  /**
   * REUSABLE: created on purpose through the owner API; may authorize any matching checkout within its limits.
   * CHECKOUT_BOUND: created on the owner approval page for one checkout; never authorizes any other checkout and is
   * never selected automatically. Legacy page mandates without a bound id are CHECKOUT_BOUND to nothing (unusable).
   */
  scope: "REUSABLE" | "CHECKOUT_BOUND";
  boundCheckoutSessionId: string | null;
  createdAt: string;
}

export interface CreateMandateInput {
  userId: string;
  productIdentity: ProductIdentity;
  currency: string;
  maximumTotalMinor: number;
  maximumQuantity?: number;
  maximumTransactions?: number;
  ttlSeconds?: number;
  allowedMerchantIds?: string[] | null;
  createdVia: PurchaseMandate["createdVia"];
  /** Required for, and only allowed with, createdVia OWNER_APPROVAL_PAGE. */
  boundCheckoutSessionId?: string;
}

type MandateRow = Record<string, string | number | null>;

export class MandateRepository {
  constructor(private readonly store: Store, private readonly now: () => number = Date.now) {}

  /** Only callable from owner-authenticated surfaces (never from an MCP tool). */
  create(input: CreateMandateInput): PurchaseMandate {
    if (!isCurrency(input.currency)) throw new Error("Unsupported currency");
    const pi = input.productIdentity as Partial<ProductIdentity> | undefined;
    const str = (v: unknown, max: number) => typeof v === "string" && v.trim().length > 0 && v.length <= max;
    if (!pi || !str(pi.brand, 60) || !str(pi.model, 60) || !["new", "refurbished", "used", "open_box"].includes(String(pi.condition)) ||
        !(pi.variant === null || str(pi.variant, 40)) || !(pi.sku === null || str(pi.sku, 60)))
      throw new Error("productIdentity must have brand, model, condition, and variant/sku as string or null");
    assertMinor(input.maximumTotalMinor, "maximumTotalMinor");
    if (input.maximumTotalMinor <= 0) throw new Error("maximumTotalMinor must be positive");
    const maxQ = input.maximumQuantity ?? 1;
    const maxT = input.maximumTransactions ?? 1;
    if (!Number.isSafeInteger(maxQ) || maxQ < 1 || maxQ > 10) throw new Error("maximumQuantity must be 1..10");
    if (!Number.isSafeInteger(maxT) || maxT < 1 || maxT > 10) throw new Error("maximumTransactions must be 1..10");
    const bound = input.boundCheckoutSessionId ?? null;
    if ((input.createdVia === "OWNER_APPROVAL_PAGE") !== (bound !== null)) throw new Error("Owner-page mandates must be bound to exactly one checkout; owner-API mandates must not be");
    const ttl = input.ttlSeconds ?? 3600;
    if (!Number.isSafeInteger(ttl) || ttl < 60 || ttl > 7 * 86400) throw new Error("ttlSeconds must be 60..604800");
    const id = `mdt_${randomUUID()}`;
    const now = this.now();
    this.store.db.prepare(`INSERT INTO mandates(id,user_id,identity_json,currency,max_total_minor,max_quantity,max_transactions,expires_at,
      merchant_constraints_json,status,created_via,created_at,bound_checkout_session_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, input.userId, JSON.stringify(input.productIdentity), input.currency, input.maximumTotalMinor, maxQ, maxT, now + ttl * 1000,
      JSON.stringify({ allowedMerchantIds: input.allowedMerchantIds ?? null }), "ACTIVE", input.createdVia, now, bound);
    return this.get(id, input.userId)!;
  }

  get(mandateId: string, userId: string): PurchaseMandate | null {
    const row = this.store.db.prepare("SELECT * FROM mandates WHERE id = ? AND user_id = ?").get(mandateId, userId) as MandateRow | undefined;
    return row ? this.toMandate(row) : null;
  }

  listActive(userId: string): PurchaseMandate[] {
    return (this.store.db.prepare("SELECT * FROM mandates WHERE user_id = ? AND status = 'ACTIVE' ORDER BY created_at DESC").all(userId) as MandateRow[])
      .map((r) => this.toMandate(r));
  }

  revoke(mandateId: string, userId: string): PurchaseMandate {
    const r = this.store.db.prepare("UPDATE mandates SET status = 'REVOKED', revoked_at = ? WHERE id = ? AND user_id = ? AND status IN ('ACTIVE','EXHAUSTED')")
      .run(this.now(), mandateId, userId);
    if (r.changes !== 1) throw new Error("Mandate not found or not revocable");
    return this.get(mandateId, userId)!;
  }

  toMandate(r: MandateRow): PurchaseMandate {
    const expired = Number(r.expires_at) <= this.now() && r.status === "ACTIVE";
    return {
      mandateId: String(r.id), userId: String(r.user_id), productIdentity: JSON.parse(String(r.identity_json)),
      currency: r.currency as Currency, maximumTotalMinor: Number(r.max_total_minor), maximumQuantity: Number(r.max_quantity),
      maximumTransactions: Number(r.max_transactions), expiresAt: new Date(Number(r.expires_at)).toISOString(),
      merchantConstraints: JSON.parse(String(r.merchant_constraints_json)),
      authorizationStatus: expired ? "EXPIRED" : (r.status as MandateStatus),
      checkoutSessionId: r.checkout_session_id === null ? null : String(r.checkout_session_id),
      revokedAt: r.revoked_at === null ? null : new Date(Number(r.revoked_at)).toISOString(),
      reservedMinor: Number(r.reserved_minor), consumedMinor: Number(r.consumed_minor), transactionsUsed: Number(r.transactions_used),
      createdVia: r.created_via as PurchaseMandate["createdVia"],
      scope: r.created_via === "OWNER_APPROVAL_PAGE" ? "CHECKOUT_BOUND" : "REUSABLE",
      boundCheckoutSessionId: r.bound_checkout_session_id == null ? null : String(r.bound_checkout_session_id),
      createdAt: new Date(Number(r.created_at)).toISOString(),
    };
  }
}
