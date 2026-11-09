import type { ProductIdentity } from "../domain/types.js";
import type { Currency } from "../domain/money.js";
import { identityEquals } from "../identity/ProductIdentityResolver.js";
import type { Store } from "../store/Database.js";
import { MandateRepository, type PurchaseMandate } from "./PurchaseMandate.js";

export type PolicyCode =
  | "ALLOWED"
  | "MANDATE_NOT_FOUND" | "MANDATE_WRONG_USER" | "MANDATE_REVOKED" | "MANDATE_EXPIRED" | "MANDATE_EXHAUSTED"
  | "PRODUCT_MISMATCH" | "CURRENCY_MISMATCH" | "QUANTITY_EXCEEDED" | "AMOUNT_EXCEEDED"
  | "CUMULATIVE_AMOUNT_EXCEEDED" | "TRANSACTIONS_EXHAUSTED" | "MERCHANT_NOT_ALLOWED" | "BOUND_TO_OTHER_CHECKOUT" | "INVALID_AMOUNT";

export interface CheckoutAuthorizationRequest {
  userId: string;
  checkoutSessionId: string;
  productIdentity: ProductIdentity;
  merchantId: string;
  currency: Currency;
  quantity: number;
  totalMinor: number;
}

export interface PolicyDecision { allowed: boolean; code: PolicyCode; detail: string }

const deny = (code: PolicyCode, detail: string): PolicyDecision => ({ allowed: false, code, detail });

/**
 * Pure policy evaluation plus atomic reservation. All inputs are server-owned values
 * (the stored checkout session and the stored mandate). No client boolean or LLM text
 * can produce ALLOWED.
 */
export class PurchasePolicyEngine {
  private readonly mandates: MandateRepository;
  constructor(private readonly store: Store, private readonly now: () => number = Date.now) {
    this.mandates = new MandateRepository(store, now);
  }

  evaluate(m: PurchaseMandate | null, req: CheckoutAuthorizationRequest): PolicyDecision {
    if (!m) return deny("MANDATE_NOT_FOUND", "No purchase mandate exists for this user and product.");
    if (m.userId !== req.userId) return deny("MANDATE_WRONG_USER", "Mandate belongs to a different user.");
    if (m.authorizationStatus === "REVOKED" || m.revokedAt) return deny("MANDATE_REVOKED", "Mandate was revoked.");
    if (m.authorizationStatus === "EXPIRED" || Date.parse(m.expiresAt) <= this.now()) return deny("MANDATE_EXPIRED", "Mandate has expired.");
    if (m.authorizationStatus === "EXHAUSTED") return deny("MANDATE_EXHAUSTED", "Mandate has been fully used.");
    if (!Number.isSafeInteger(req.totalMinor) || req.totalMinor <= 0) return deny("INVALID_AMOUNT", "Total must be a positive integer of minor units.");
    if (!identityEquals(m.productIdentity, req.productIdentity)) return deny("PRODUCT_MISMATCH", "Product, variant, condition or SKU differs from the mandate.");
    if (m.currency !== req.currency) return deny("CURRENCY_MISMATCH", `Mandate is in ${m.currency}, checkout is in ${req.currency}.`);
    if (!Number.isSafeInteger(req.quantity) || req.quantity < 1 || req.quantity > m.maximumQuantity) return deny("QUANTITY_EXCEEDED", `Quantity ${req.quantity} exceeds mandate maximum ${m.maximumQuantity}.`);
    if (m.merchantConstraints.allowedMerchantIds && !m.merchantConstraints.allowedMerchantIds.includes(req.merchantId)) return deny("MERCHANT_NOT_ALLOWED", "Merchant is not allowed by the mandate.");
    if (req.totalMinor > m.maximumTotalMinor) return deny("AMOUNT_EXCEEDED", `Total ${req.totalMinor} exceeds mandate maximum ${m.maximumTotalMinor} (${m.currency} minor units).`);
    if (m.maximumTransactions === 1 && m.checkoutSessionId && m.checkoutSessionId !== req.checkoutSessionId) return deny("BOUND_TO_OTHER_CHECKOUT", "Single-use mandate is already bound to another checkout.");
    if (m.transactionsUsed >= m.maximumTransactions) return deny("TRANSACTIONS_EXHAUSTED", "No transactions remain on this mandate.");
    if (m.reservedMinor + m.consumedMinor + req.totalMinor > m.maximumTotalMinor) return deny("CUMULATIVE_AMOUNT_EXCEEDED", "Reserved and spent amounts would exceed the mandate maximum.");
    return { allowed: true, code: "ALLOWED", detail: "Within mandate." };
  }

  /**
   * Newest usable mandate of this user for exactly this product. If only an expired one
   * matches, it is returned so the caller gets an explicit MANDATE_EXPIRED rejection.
   */
  findApplicable(userId: string, identity: ProductIdentity): PurchaseMandate | null {
    const matches = this.mandates.listActive(userId).filter((m) => identityEquals(m.productIdentity, identity));
    return matches.find((m) => m.authorizationStatus === "ACTIVE") ?? matches[0] ?? null;
  }

  /**
   * Atomically re-reads the mandate, evaluates, and reserves the amount. Concurrent or
   * replayed attempts serialize on BEGIN IMMEDIATE and the CHECK constraints.
   */
  reserve(mandateId: string, req: CheckoutAuthorizationRequest): PolicyDecision {
    return this.store.transaction(() => {
      const m = this.mandates.get(mandateId, req.userId);
      const decision = this.evaluate(m, req);
      if (!decision.allowed) return decision;
      const r = this.store.db.prepare(`UPDATE mandates SET reserved_minor = reserved_minor + ?, transactions_used = transactions_used + 1,
        checkout_session_id = COALESCE(checkout_session_id, ?) WHERE id = ? AND user_id = ? AND status = 'ACTIVE'
        AND reserved_minor + consumed_minor + ? <= max_total_minor AND transactions_used < max_transactions`)
        .run(req.totalMinor, req.checkoutSessionId, mandateId, req.userId, req.totalMinor);
      if (r.changes !== 1) return deny("CUMULATIVE_AMOUNT_EXCEEDED", "Concurrent reservation exhausted the mandate.");
      return decision;
    });
  }

  /** Returns a reservation after cancellation/failure (not after UNKNOWN: fail closed). */
  release(mandateId: string, userId: string, amountMinor: number, checkoutSessionId: string): void {
    this.store.transaction(() => {
      this.store.db.prepare(`UPDATE mandates SET reserved_minor = reserved_minor - ?, transactions_used = transactions_used - 1,
        checkout_session_id = CASE WHEN checkout_session_id = ? AND transactions_used = 1 THEN NULL ELSE checkout_session_id END
        WHERE id = ? AND user_id = ? AND reserved_minor >= ? AND transactions_used >= 1`).run(amountMinor, checkoutSessionId, mandateId, userId, amountMinor);
    });
  }

  /** Converts a reservation into spend after a verified completed capture. */
  consume(mandateId: string, userId: string, amountMinor: number): void {
    this.store.transaction(() => {
      this.store.db.prepare(`UPDATE mandates SET reserved_minor = reserved_minor - ?, consumed_minor = consumed_minor + ?,
        status = CASE WHEN consumed_minor + ? >= max_total_minor OR transactions_used >= max_transactions THEN 'EXHAUSTED' ELSE status END
        WHERE id = ? AND user_id = ? AND reserved_minor >= ?`).run(amountMinor, amountMinor, amountMinor, mandateId, userId, amountMinor);
    });
  }
}
