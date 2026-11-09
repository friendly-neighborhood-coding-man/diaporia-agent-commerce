/**
 * One purchase lifecycle, persisted in two records:
 *   purchase session: CREATED → RESEARCHED → OFFER_VERIFIED   (or HOLD)
 *   checkout session: PREPARED → APPROVAL_REQUIRED → APPROVED → CAPTURE_PENDING → COMPLETED
 * plus HOLD, CANCELLED, FAILED, EXPIRED, UNKNOWN. Every write goes through `assertTransition`.
 */
export type PurchaseState =
  | "CREATED" | "RESEARCHED" | "OFFER_VERIFIED" | "PREPARED" | "APPROVAL_REQUIRED" | "APPROVED"
  | "CAPTURE_PENDING" | "COMPLETED" | "HOLD" | "CANCELLED" | "FAILED" | "EXPIRED" | "UNKNOWN";

export const PURCHASE_SESSION_TRANSITIONS: Readonly<Record<string, readonly PurchaseState[]>> = {
  CREATED: ["RESEARCHED", "HOLD", "EXPIRED", "CANCELLED"],
  RESEARCHED: ["OFFER_VERIFIED", "HOLD", "EXPIRED", "CANCELLED"],
  // Re-comparing is allowed (fresh quotes), so OFFER_VERIFIED/HOLD may re-enter themselves.
  OFFER_VERIFIED: ["OFFER_VERIFIED", "HOLD", "EXPIRED", "CANCELLED"],
  HOLD: ["OFFER_VERIFIED", "HOLD", "EXPIRED", "CANCELLED"],
};

export const CHECKOUT_TRANSITIONS: Readonly<Record<string, readonly PurchaseState[]>> = {
  PREPARED: ["APPROVAL_REQUIRED", "HOLD", "EXPIRED", "CANCELLED", "FAILED"],
  // HOLD here = policy rejected or awaiting user mandate; the user can still authorize.
  HOLD: ["APPROVAL_REQUIRED", "EXPIRED", "CANCELLED"],
  APPROVAL_REQUIRED: ["APPROVAL_REQUIRED", "APPROVED", "CANCELLED", "EXPIRED", "FAILED", "UNKNOWN", "HOLD"],
  APPROVED: ["CAPTURE_PENDING", "FAILED", "UNKNOWN"],
  CAPTURE_PENDING: ["COMPLETED", "FAILED", "UNKNOWN", "CAPTURE_PENDING"],
  // UNKNOWN is only left by reconciling against the payment provider's authoritative state.
  UNKNOWN: ["UNKNOWN", "APPROVED", "CAPTURE_PENDING", "COMPLETED", "FAILED", "CANCELLED"],
};

export const TERMINAL: ReadonlySet<PurchaseState> = new Set(["COMPLETED", "CANCELLED", "FAILED", "EXPIRED"]);

export class InvalidTransitionError extends Error {
  constructor(readonly from: string, readonly to: string, readonly kind: string) {
    super(`Invalid ${kind} transition ${from} → ${to}`);
  }
}

export function assertTransition(kind: "purchase" | "checkout", from: PurchaseState, to: PurchaseState): void {
  const table = kind === "purchase" ? PURCHASE_SESSION_TRANSITIONS : CHECKOUT_TRANSITIONS;
  if (!(table[from] ?? []).includes(to)) throw new InvalidTransitionError(from, to, kind);
}
