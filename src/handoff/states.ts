/**
 * Browser checkout handoff states. Deliberately a SEPARATE table from the DIAPORIA-controlled PayPal
 * checkout (src/checkout/stateMachine.ts), which this module never reads or writes.
 *
 *   CHECKOUT_PREPARING → CHECKOUT_READY → HUMAN_ACTION_REQUIRED → HANDOFF_OPENED → RETURN_OBSERVED
 *                                                                           → ORDER_UNVERIFIED | ORDER_CONFIRMED | CANCELLED
 *
 * Honesty rules encoded here:
 *  - Once a human has taken over (HANDOFF_OPENED), the outcome can no longer be "nothing happened":
 *    EXPIRED and a plain CANCELLED are unreachable. Only an observation (RETURN_OBSERVED) can follow.
 *  - RETURN_OBSERVED → CANCELLED is allowed only when an authoritative seller-side source reports NO order.
 *  - ORDER_CONFIRMED requires authoritative seller-side confirmation (enforced by BrowserCheckoutHandoff),
 *    never a page text, a redirect or an AI reading of a page.
 */
export type HandoffState =
  | "CHECKOUT_PREPARING" | "CHECKOUT_READY" | "HUMAN_ACTION_REQUIRED" | "HANDOFF_OPENED" | "RETURN_OBSERVED"
  | "ORDER_UNVERIFIED" | "ORDER_CONFIRMED" | "HOLD" | "CANCELLED" | "EXPIRED";

export const HANDOFF_TRANSITIONS: Readonly<Record<HandoffState, readonly HandoffState[]>> = {
  CHECKOUT_PREPARING: ["CHECKOUT_READY", "HOLD", "CANCELLED", "EXPIRED"],
  CHECKOUT_READY: ["HUMAN_ACTION_REQUIRED", "HOLD", "CANCELLED", "EXPIRED"],
  // HOLD before takeover = a constraint failed (e.g. total above the authorized maximum). The human may raise
  // the maximum on the authenticated handoff page, which re-evaluates and can return to HUMAN_ACTION_REQUIRED.
  HUMAN_ACTION_REQUIRED: ["HANDOFF_OPENED", "HUMAN_ACTION_REQUIRED", "HOLD", "CANCELLED", "EXPIRED"],
  HOLD: ["HUMAN_ACTION_REQUIRED", "HOLD", "CANCELLED", "EXPIRED"],
  HANDOFF_OPENED: ["RETURN_OBSERVED"],
  RETURN_OBSERVED: ["ORDER_UNVERIFIED", "ORDER_CONFIRMED", "CANCELLED"],
  // A later authoritative seller confirmation may upgrade an unverified outcome; nothing downgrades a confirmed one.
  ORDER_UNVERIFIED: ["ORDER_UNVERIFIED", "ORDER_CONFIRMED"],
  ORDER_CONFIRMED: [],
  CANCELLED: [],
  EXPIRED: [],
};

export const HANDOFF_TERMINAL: ReadonlySet<HandoffState> = new Set(["ORDER_CONFIRMED", "CANCELLED", "EXPIRED"]);
/** States in which no human has touched the browser yet, so expiry/cancellation means "no purchase was possible". */
export const PRE_TAKEOVER: ReadonlySet<HandoffState> = new Set(["CHECKOUT_PREPARING", "CHECKOUT_READY", "HUMAN_ACTION_REQUIRED", "HOLD"]);

export class InvalidHandoffTransitionError extends Error {
  constructor(readonly from: string, readonly to: string) { super(`Invalid handoff transition ${from} → ${to}`); }
}

export function assertHandoffTransition(from: HandoffState, to: HandoffState): void {
  if (!(HANDOFF_TRANSITIONS[from] ?? []).includes(to)) throw new InvalidHandoffTransitionError(from, to);
}
