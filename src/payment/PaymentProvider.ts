import type { Currency } from "../domain/money.js";

export interface ProviderMoney { currency: Currency; amountMinor: number }

export type ProviderOrderStatus = "CREATED" | "SAVED" | "APPROVED" | "VOIDED" | "COMPLETED" | "PAYER_ACTION_REQUIRED" | "UNRECOGNIZED";
export type ProviderCaptureStatus = "COMPLETED" | "PENDING" | "DECLINED" | "FAILED" | "REFUNDED" | "PARTIALLY_REFUNDED" | "UNRECOGNIZED";

export interface ProviderCapture { captureId: string; status: ProviderCaptureStatus; amount: ProviderMoney | null; reason: string | null }
export interface ProviderOrder { orderId: string; status: ProviderOrderStatus; amount: ProviderMoney | null; customId: string | null; captures: ProviderCapture[] }

export interface CreateOrderInput {
  checkoutSessionId: string;
  amount: ProviderMoney;
  description: string;
  returnUrl: string;
  cancelUrl: string;
  idempotencyKey: string;
}

/** Network timeout or connection loss: the remote outcome is UNKNOWN and must be reconciled. */
export class ProviderTimeoutError extends Error {}
/** Definite error response from the provider. */
export class ProviderError extends Error {
  constructor(message: string, readonly httpStatus: number | null, readonly debugId: string | null) { super(message); }
}

/**
 * Payment port. Implementations: MockPayPalProvider (offline, labelled MOCK) and
 * PayPalSandboxProvider (PayPal Orders v2, Sandbox host only).
 */
export interface PaymentProvider {
  readonly name: "MOCK_PAYPAL" | "PAYPAL_SANDBOX";
  createOrder(input: CreateOrderInput): Promise<{ orderId: string; approvalUrl: string }>;
  getOrder(orderId: string): Promise<ProviderOrder>;
  captureOrder(orderId: string, idempotencyKey: string): Promise<ProviderCapture>;
  getCapture(captureId: string): Promise<ProviderCapture>;
}
