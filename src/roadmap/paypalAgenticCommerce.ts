/**
 * FUTURE INTEGRATION PORTS — NOT IMPLEMENTED, NOT INTEGRATED.
 *
 * PayPal Agent Ready and Store Sync are not part of this version: the project does not
 * currently have the applicable onboarding or eligibility arrangements. These interfaces
 * only reserve where such adapters would plug in. There are deliberately NO mock
 * implementations, so nothing can suggest these integrations work.
 *
 * Docs: https://developer.paypal.com/agent-ready/overview/
 *       https://developer.paypal.com/store-sync/overview
 *       https://developer.paypal.com/agentic-commerce-services/about/
 */
import type { MerchantOffer, MerchantQuote, ProductIdentity, ShippingDestination } from "../domain/types.js";

export const PAYPAL_AGENTIC_INTEGRATION_STATUS = {
  agentReady: "NOT_INTEGRATED_ACCESS_DEPENDENT",
  storeSync: "NOT_INTEGRATED_ACCESS_DEPENDENT",
} as const;

/** Would source merchant catalogs/offers from a merchant-authorized feed instead of fixtures. */
export interface MerchantCatalogSyncPort {
  findOffers(identity: ProductIdentity): Promise<MerchantOffer[]>;
  getQuote(offerId: string, quantity: number, destination: ShippingDestination): Promise<MerchantQuote | null>;
}

/** Would hand a verified, mandate-bounded checkout to an eligible merchant's agent-ready checkout. */
export interface AgentReadyCheckoutPort {
  createMerchantCheckout(input: { offerId: string; quoteId: string; quantity: number; totalMinor: number; currency: string; checkoutSessionId: string }): Promise<{ approvalUrl: string; merchantCheckoutId: string }>;
}
