export type ErrorCode =
  | "NOT_FOUND" | "INVALID_INPUT" | "INVALID_STATE" | "IDENTITY_MISMATCH" | "OFFER_NOT_ELIGIBLE" | "CLIENT_LIMIT_EXCEEDED"
  | "SESSION_EXPIRED" | "FORBIDDEN" | "PAYMENT_DISABLED" | "PROVIDER_ERROR" | "STALE_STATE"
  | "MERCHANT_IDENTITY_MISMATCH" | "MERCHANT_IDENTITY_UNKNOWN" | "MERCHANT_RECIPIENT_UNKNOWN"
  | "BILLING_AUTHORIZATION_REQUIRED" | "BILLING_UNAVAILABLE" | "USAGE_LIMIT";

/** Expected, user-explainable failure. Message must not contain secrets. */
export class CommerceError extends Error {
  constructor(readonly code: ErrorCode, message: string, readonly details: Record<string, unknown> = {}) { super(message); }
}
