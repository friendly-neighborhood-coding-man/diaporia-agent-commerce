import type { CatalogProduct, ProductIdentity, ShippingDestination } from "../domain/types.js";
import { isCurrency, isMinor } from "../domain/money.js";
import { PurchaseIntentRouter, type PurchaseRequestInput } from "../intent/PurchaseIntentRouter.js";
import { ProductIdentityResolver, identityEquals } from "../identity/ProductIdentityResolver.js";
import type { CommerceResearchAdapter } from "../research/CommerceResearchAdapter.js";
import { MerchantOfferVerifier, type VerifiedOffer } from "../merchant/MerchantOfferVerifier.js";
import { PurchasePolicyEngine, type PolicyDecision } from "../policy/PurchasePolicyEngine.js";
import { MandateRepository } from "../policy/PurchaseMandate.js";
import { CheckoutSessionManager, NotFoundError, StaleStateError, type CheckoutSession, type PurchaseSession } from "../checkout/CheckoutSessionManager.js";
import { TERMINAL } from "../checkout/stateMachine.js";
import { PurchaseAuditJournal } from "../audit/PurchaseAuditJournal.js";
import { ProviderError, ProviderTimeoutError, type PaymentProvider, type ProviderCapture } from "../payment/PaymentProvider.js";
import { inspectUntrusted } from "../security/untrusted.js";
import type { Store } from "../store/Database.js";
import { CommerceError } from "./errors.js";
import { MerchantIdentityVerifier } from "../merchant-identity/MerchantIdentityVerifier.js";
import { CompositeBusinessRegistry, MockKoreanBusinessRegistry, MockPayPalRecipientAttestationProvider, MockUSBusinessRegistry } from "../merchant-identity/providers.js";
import { ATTESTATIONS, KR_REGISTRY, US_REGISTRY } from "../merchant-identity/fixtures.js";
import { normalizeIdentifier } from "../merchant-identity/identifiers.js";
import type { MerchantIdentityAssessment } from "../merchant-identity/types.js";
import { newCheckoutSessionId, type MerchantIdentityBinding } from "../checkout/CheckoutSessionManager.js";
import type { MerchantOffer } from "../domain/types.js";
import type { ServicePlane } from "./ServicePlane.js";
import { EvidenceRouter, type RouterResult } from "../evidence/EvidenceRouter.js";
import { UsageLimitError } from "../metering/UsageLedger.js";
import { BillingUnavailableError, periodSummaryFrom } from "../billing/Billing.js";
import { createHash as hashForKeys } from "node:crypto";
import { parseWebhookEvent, type WebhookHeaders, type WebhookSignatureVerifier } from "../payment/PayPalWebhook.js";

export interface GatewayConfig {
  /** Public base URL of this server, used for return/cancel/authorization links. */
  baseUrl: string;
  /** false on public deployments without production auth: payment flows return HOLD. */
  paymentExecutionEnabled: boolean;
  checkoutTtlMs?: number;
  /** Merchant identity verifier. Defaults to the MOCK registries and MOCK recipient attestation. */
  merchantIdentity?: MerchantIdentityVerifier;
  /**
   * PayPal Sandbox only: DIAPORIA's own Sandbox business account (merchant id), which is the real
   * recipient of every Sandbox demo payment. Unset = recipient cannot be verified = checkout HOLDs.
   */
  sandboxPlatformPayeeId?: string | null;
  /** PayPal Sandbox only, optional: the same account's email. When set, the order payee email must match too. */
  sandboxPlatformPayeeEmail?: string | null;
  /** PayPal webhook signature verifier. Unset = the webhook endpoint is disabled. */
  webhookVerifier?: WebhookSignatureVerifier | null;
  /** Usage metering, evidence routing, deployment mode and service billing. Optional: absent = legacy behaviour. */
  service?: ServicePlane | null;
  /** Read-only provider retries during reconciliation (attempts, base backoff). */
  readRetry?: { attempts: number; baseDelayMs: number };
}

export type ReconcileSource = "MANUAL" | "STARTUP" | "WEBHOOK" | "RETURN";
export type ReconcileOutcome =
  | "SETTLED_COMPLETED" | "SETTLED_FAILED" | "REFUNDED" | "STILL_PENDING" | "NO_CHANGE" | "PROVIDER_UNAVAILABLE"
  | "CAPTURE_ID_MISMATCH" | "AMOUNT_MISMATCH" | "CONFLICT_IGNORED" | "NOT_APPLICABLE";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function defaultMockMerchantIdentityVerifier(now: () => number = Date.now): MerchantIdentityVerifier {
  return new MerchantIdentityVerifier(
    new CompositeBusinessRegistry([new MockKoreanBusinessRegistry(KR_REGISTRY, now), new MockUSBusinessRegistry(US_REGISTRY, now)]),
    new MockPayPalRecipientAttestationProvider(ATTESTATIONS, now), now);
}

export type CapabilityStatus = "VERIFIED_TRUE" | "VERIFIED_FALSE" | "LISTING_CLAIM_ONLY" | "UNKNOWN";
const CHECKOUT_TTL_MS = 15 * 60_000;
const DISCLOSURE = "PayPal Sandbox demonstration. The merchant is a fictional DIAPORIA demo merchant paid through DIAPORIA's own Sandbox account; this is not a retail purchase and no goods will ship.";

export class CommerceGateway {
  readonly router = new PurchaseIntentRouter();
  readonly resolver = new ProductIdentityResolver();
  readonly verifier = new MerchantOfferVerifier();
  readonly sessions: CheckoutSessionManager;
  readonly policy: PurchasePolicyEngine;
  readonly mandates: MandateRepository;
  readonly audit: PurchaseAuditJournal;
  readonly identity: MerchantIdentityVerifier;

  constructor(private readonly store: Store, readonly research: CommerceResearchAdapter, readonly payments: PaymentProvider, readonly config: GatewayConfig,
    private readonly now: () => number = Date.now) {
    this.sessions = new CheckoutSessionManager(store, now);
    this.policy = new PurchasePolicyEngine(store, now);
    this.mandates = new MandateRepository(store, now);
    this.audit = new PurchaseAuditJournal(store, now);
    this.identity = config.merchantIdentity ?? defaultMockMerchantIdentityVerifier(now);
  }

  private verifyMerchant(offer: MerchantOffer, checkoutSessionId?: string, expected?: { payeeAccountId: string; identifierValue: string }) {
    return this.identity.verify({ offer, claim: offer.identityClaim ?? null, ...(checkoutSessionId !== undefined ? { checkoutSessionId } : {}), ...(expected ? { expected } : {}) });
  }

  /** Builds the checkout binding, or explains why the identity or the recipient cannot be bound. */
  private bindIdentity(offer: MerchantOffer, a: MerchantIdentityAssessment): { binding: MerchantIdentityBinding } | { code: "MERCHANT_IDENTITY_MISMATCH" | "MERCHANT_IDENTITY_UNKNOWN" | "MERCHANT_RECIPIENT_UNKNOWN"; detail: string } {
    if (a.overall === "MISMATCH") return { code: "MERCHANT_IDENTITY_MISMATCH", detail: a.checks.filter((c) => c.result === "MISMATCH").map((c) => `${c.check}: ${c.detail}`).join("; ") };
    if (a.overall !== "MATCH" || !offer.identityClaim || !a.intendedPayeeAccountId || !a.attestationId || !a.attestationExpiresAt || !a.verifiedLegalName || !a.identifierMasked)
      return { code: "MERCHANT_IDENTITY_UNKNOWN", detail: a.checks.filter((c) => c.result === "UNKNOWN").map((c) => `${c.check}: ${c.detail}`).join("; ") || "identity incomplete" };
    const norm = normalizeIdentifier(offer.identityClaim.identifier.scheme, offer.identityClaim.identifier.value);
    if (!norm.ok) return { code: "MERCHANT_IDENTITY_MISMATCH", detail: norm.reason };
    const sandbox = this.payments.name === "PAYPAL_SANDBOX";
    const intended = sandbox ? (this.config.sandboxPlatformPayeeId ?? null) : a.intendedPayeeAccountId;
    if (!intended) return { code: "MERCHANT_RECIPIENT_UNKNOWN", detail: "PAYPAL_SANDBOX_PAYEE_MERCHANT_ID is not configured, so the Sandbox order recipient cannot be verified" };
    return { binding: {
      overall: "MATCH", legalEntity: "MATCH", paymentRelationship: "MATCH", identifierMasked: a.identifierMasked, identifierScheme: norm.identifier.scheme,
      identifierValue: norm.identifier.value, verifiedLegalName: a.verifiedLegalName, attestedPayeeId: a.intendedPayeeAccountId, intendedPayeeId: intended,
      payeeRelationship: sandbox ? "DIAPORIA_SANDBOX_PLATFORM_ACCOUNT" : "MERCHANT_ATTESTED_PAYEE",
      attestationId: a.attestationId, attestationExpiresAt: a.attestationExpiresAt,
      provenance: [...new Set(a.checks.map((c) => c.provenance).filter((x): x is NonNullable<typeof x> => !!x))],
    } };
  }

  private dataSource() {
    return { researchAdapter: this.research.name, mockData: this.research.isMock, paymentProvider: this.payments.name,
      paymentEnvironment: paymentEnvironment(this.payments.name), liveMerchantCheckout: false as const };
  }

  // ---------------------------------------------------------------- research_purchase
  async researchPurchase(userId: string, input: PurchaseRequestInput) {
    const ctx: { requestId: string | null } = { requestId: null };
    try {
      const out = await this.researchPurchaseInner(userId, input, ctx);
      // Service delivered: bill its metered operations once (managed mode); supplier costs are already recorded.
      if (this.config.service && ctx.requestId) { this.config.service.ledger.settleRequest(ctx.requestId, userId); out.usage = this.requestUsage(ctx.requestId, userId); }
      return out;
    } catch (e) {
      // Service not delivered: provider calls that happened keep their supplier cost, nothing is billed.
      if (this.config.service && ctx.requestId) this.config.service.ledger.abandonRequest(ctx.requestId, userId);
      throw e;
    }
  }

  private async researchPurchaseInner(userId: string, input: PurchaseRequestInput, ctx: { requestId: string | null }) {
    if (typeof input.request !== "string" || !input.request.trim()) throw new CommerceError("INVALID_INPUT", "request is required");
    if (input.budgetMinor !== undefined && !isMinor(input.budgetMinor)) throw new CommerceError("INVALID_INPUT", "budgetMinor must be integer minor units");
    if (input.currency !== undefined && !isCurrency(input.currency)) throw new CommerceError("INVALID_INPUT", "unsupported currency");
    await this.assertServiceAuthorized(userId);
    const intent = this.router.route(input);
    let ps = this.sessions.createPurchaseSession(userId, input.request, intent);
    ctx.requestId = ps.purchaseSessionId;
    this.audit.append(ps.purchaseSessionId, userId, "RESEARCH_STARTED", { mode: intent.mode, budgetMinor: intent.budgetMinor, budgetSource: intent.budgetSource });
    const unknowns: string[] = [];
    let identityResult: Record<string, unknown> = { status: "NOT_APPLICABLE" };
    let products: CatalogProduct[];
    let locked: { identity: ProductIdentity; productId: string } | null = null;

    if (intent.mode === "EXACT_PRODUCT_PURCHASE") {
      const found = await this.meteredDiscovery(userId, ps.purchaseSessionId, { text: input.request, category: intent.category, brand: intent.identityHints.brand, model: intent.identityHints.model });
      const res = this.resolver.resolve(intent.identityHints, found);
      if (res.status === "LOCKED") { locked = { identity: res.identity, productId: res.productId }; identityResult = { status: "LOCKED", lockedIdentity: res.identity, assumptions: res.assumptions }; }
      else if (res.status === "AMBIGUOUS") { identityResult = { status: "AMBIGUOUS", question: res.question, options: res.options }; unknowns.push(res.question); }
      else { identityResult = { status: "NOT_FOUND", reason: res.reason }; unknowns.push(res.reason); }
      products = locked ? found.filter((p) => p.productId === locked!.productId) : res.status === "AMBIGUOUS" ? found.filter((p) => res.options.some((o) => o.productId === p.productId)) : [];
    } else {
      products = await this.meteredDiscovery(userId, ps.purchaseSessionId, { text: input.request, category: intent.category, brand: intent.identityHints.brand, model: null });
    }

    // Evidence routing for must-have capabilities that are not yet verified (explicit sufficiency rule).
    const routing: Record<string, RouterResult[]> = {};
    if (this.config.service?.router && intent.mustHave.length) {
      for (const p of products) {
        for (const cap of intent.mustHave) {
          if (["VERIFIED_TRUE", "VERIFIED_FALSE"].includes(capabilityStatus(p, cap).status)) continue;
          const r = await this.config.service.router.verify(p, cap, { userId, requestId: ps.purchaseSessionId });
          (routing[p.productId] ??= []).push(r);
          // Only evidence that meets the sufficiency rule is merged; partial evidence never upgrades a claim.
          if (r.sufficiency === "SUFFICIENT_TRUE" || r.sufficiency === "SUFFICIENT_FALSE")
            p.capabilities = [...p.capabilities.filter((c) => c.capability !== cap || c.source.kind === "MANUFACTURER"), ...r.claims.filter((c) => c.source.kind !== "CATALOG_LISTING")];
        }
      }
    }
    const candidates = await Promise.all(products.map(async (p) => {
      const offers = await this.research.findOffers(p.identity);
      const sameProduct = offers.filter((o) => o.productId === p.productId && o.availability === "IN_STOCK" && o.currency === intent.currency);
      const lowest = sameProduct.length ? Math.min(...sameProduct.map((o) => o.itemPriceMinor)) : null;
      const must = intent.mustHave.map((c) => capabilityStatus(p, c));
      const nice = intent.niceToHave.map((c) => capabilityStatus(p, c));
      const suitability = must.some((m) => m.status === "VERIFIED_FALSE") ? "NOT_SUITABLE" : must.every((m) => m.status === "VERIFIED_TRUE") ? "SUITABLE" : "NEEDS_VERIFICATION";
      return {
        productId: p.productId, title: p.title, identity: p.identity, suitability, mustHave: must, niceToHave: nice,
        listingPrice: { lowestListingMinor: lowest, currency: intent.currency, note: "Search-time listing price, not a checkout total." },
        budgetFit: lowest === null || intent.budgetMinor === null ? "UNKNOWN" : lowest <= intent.budgetMinor ? "LISTING_WITHIN_BUDGET" : "LISTING_OVER_BUDGET",
        untrustedContent: [p.description, ...p.reviews].filter((x): x is NonNullable<typeof x> => !!x).map(inspectUntrusted),
        evidenceRouting: (routing[p.productId] ?? []).map((r) => ({ capability: r.capability, sufficiency: r.sufficiency, reason: r.reason, steps: r.steps,
          claims: r.claims.filter((c) => c.source.kind !== "CATALOG_LISTING").map((c) => ({ value: c.value, kind: c.source.kind, url: c.source.url, statement: c.source.title.slice(0, 220) })) })),
      };
    }));
    const order = { SUITABLE: 0, NEEDS_VERIFICATION: 1, NOT_SUITABLE: 2 } as const;
    candidates.sort((a, b) => order[a.suitability as keyof typeof order] - order[b.suitability as keyof typeof order] || (a.listingPrice.lowestListingMinor ?? Infinity) - (b.listingPrice.lowestListingMinor ?? Infinity));
    for (const c of candidates) for (const m of c.mustHave) if (m.status === "UNKNOWN" || m.status === "LISTING_CLAIM_ONLY") unknowns.push(`${c.title}: "${m.capability}" is ${m.status === "UNKNOWN" ? "not evidenced" : "only a listing claim"}`);
    for (const [pid, rs] of Object.entries(routing)) for (const r of rs) if (r.sufficiency === "CONTRADICTED" || r.reason === "VERIFICATION_REQUIRED_BUT_LIMIT_REACHED")
      unknowns.push(`${pid}: "${r.capability}" ${r.sufficiency === "CONTRADICTED" ? "has contradicting independent evidence" : "still needs independent verification (usage limit reached; verification was not skipped)"}`);
    if (intent.budgetMinor === null) unknowns.push("No budget given; totals will not be filtered by budget.");

    const research = { identity: identityResult, candidates, unknowns };
    const holdNeeded = intent.mode === "EXACT_PRODUCT_PURCHASE" ? !locked : candidates.length === 0;
    ps = this.sessions.updatePurchaseSession(ps, holdNeeded ? "HOLD" : "RESEARCHED", { research, lockedIdentity: locked?.identity ?? null, productId: locked?.productId ?? null });
    this.audit.append(ps.purchaseSessionId, userId, holdNeeded ? "RESEARCH_HOLD" : "RESEARCHED", { candidates: candidates.length });
    return {
      purchaseSessionId: ps.purchaseSessionId, state: ps.state, mode: intent.mode,
      intent: { currency: intent.currency, budgetMinor: intent.budgetMinor, budgetSource: intent.budgetSource, mustHave: intent.mustHave, niceToHave: intent.niceToHave, objective: intent.objective, identityHints: intent.identityHints, assumptions: intent.assumptions },
      identity: identityResult, candidates, unknowns, dataSource: this.dataSource(),
      paymentEffect: "NONE" as const,
      usage: this.config.service ? this.requestUsage(ps.purchaseSessionId, userId) : null,
      note: "Budgets here only filter research. Spending authority comes only from a user-created purchase mandate plus PayPal buyer approval.",
    };
  }

  // ---------------------------------------------------------------- service plane (metering / billing)
  /** Managed mode: paid operations require ACTIVE service billing. Fails closed when billing is unavailable. */
  private async assertServiceAuthorized(userId: string) {
    const svc = this.config.service;
    if (!svc || svc.mode !== "managed") return;
    if (!svc.billing) throw new CommerceError("FORBIDDEN", "Managed mode without a billing provider is not allowed");
    let auth;
    try { auth = await svc.billing.getAuthorization(userId); }
    catch (e) { if (e instanceof BillingUnavailableError) throw new CommerceError("BILLING_UNAVAILABLE", "Service billing is unavailable; paid research is denied until it recovers."); throw e; }
    if (auth.status !== "ACTIVE") throw new CommerceError("BILLING_AUTHORIZATION_REQUIRED", `Managed service billing is ${auth.status}; paid operations are denied.`, { billingStatus: auth.status, source: auth.source });
  }

  private readonly discoveryCache = new Map<string, { at: number; products: CatalogProduct[] }>();
  /** Catalog discovery (Channel3 or fixtures) with metering and reuse of identical recent searches. */
  private async meteredDiscovery(userId: string, requestId: string, q: Parameters<CommerceResearchAdapter["searchProducts"]>[0]): Promise<CatalogProduct[]> {
    const svc = this.config.service;
    if (!svc) return this.research.searchProducts(q);
    const key = "channel3:" + hashForKeys("sha256").update(JSON.stringify([q.text.toLowerCase().trim(), q.category, q.brand, q.model])).digest("hex").slice(0, 32);
    const hit = this.discoveryCache.get(`${userId}|${key}`);
    if (hit && this.now() - hit.at < 10 * 60_000) return structuredClone(hit.products);
    let rec;
    try { rec = svc.ledger.begin({ userId, requestId, provider: "CHANNEL3", operation: "search", logicalKey: `${key}:${Math.floor(this.now() / 600_000)}`, quantity: 1, unit: "search",
      provenance: this.research.isMock ? "MOCK" : svc.mode === "managed" ? "MANAGED_LIVE" : "BYOK_LIVE", billable: svc.mode === "managed" }); }
    catch (e) { if (e instanceof UsageLimitError) throw new CommerceError("USAGE_LIMIT", e.message, { limit: e.code }); throw e; }
    try {
      const products = await this.research.searchProducts(q);
      svc.ledger.complete(rec.record.id, { success: true });
      this.discoveryCache.set(`${userId}|${key}`, { at: this.now(), products: structuredClone(products) });
      return products;
    } catch (e) { svc.ledger.complete(rec.record.id, { success: false, failureReason: errorText(e) }); throw e; }
  }

  private requestUsage(requestId: string, userId: string) {
    const recs = this.config.service!.ledger.forRequest(requestId, userId);
    return { records: recs.map((r) => ({ provider: r.provider, operation: r.operation, status: r.status, billingState: r.billingState, provenance: r.provenance, attempts: r.attempts,
      estimatedSupplierMicroUsd: r.estSupplierMicro, pricingVersion: r.pricingVersion, billableMinor: r.billableMinor })), mode: this.config.service!.mode };
  }

  /** Read-only usage and (managed) simulated service-billing summary for the calling user only. */
  async getUsageSummary(userId: string) {
    const svc = this.config.service;
    if (!svc) return { mode: "NONE", usage: null, billing: { status: "NOT_CONFIGURED" } };
    const usage = svc.ledger.summary(userId);
    if (svc.mode !== "managed") return { mode: svc.mode, usage, billing: { status: "NOT_APPLICABLE_COMMUNITY", note: "Community mode: no DIAPORIA billing; provider costs are the operator's own." } };
    let billingAuthorization: unknown = null;
    try { billingAuthorization = svc.billing ? await svc.billing.getAuthorization(userId) : null; } catch { billingAuthorization = { status: "UNKNOWN", note: "billing provider unavailable" }; }
    // Subscription billing reports a period statement (billed amount, service price, supplier cost kept apart); the legacy mock reports a draft summary.
    const statementOf = (svc.billing as { statement?: (u: string) => unknown } | null)?.statement;
    const periodView = typeof statementOf === "function" ? { subscriptionStatement: statementOf.call(svc.billing, userId) } : { periodSummary: periodSummaryFrom(usage) };
    return { mode: svc.mode, simulation: svc.managedSimulation === true, usage, billing: { billingAuthorization, ...periodView,
      separation: "Service billing is independent of purchase mandates: it never authorizes a merchandise purchase, and a purchase mandate never authorizes service charges." } };
  }

  // ---------------------------------------------------------------- compare_purchase_offers
  async compareOffers(userId: string, input: { researchSessionId: string; productIdentity: ProductIdentity; destination?: ShippingDestination | null }) {
    await this.assertServiceAuthorized(userId);
    let ps = this.livePurchaseSession(input.researchSessionId, userId);
    const destination = input.destination ? validateDestination(input.destination) : ps.destination;
    let locked = ps.lockedIdentity;
    if (ps.mode === "EXACT_PRODUCT_PURCHASE") {
      if (!locked) throw new CommerceError("INVALID_STATE", "No exact identity is locked for this session (see research unknowns).");
      if (!identityEquals(locked, normalizeIdentity(input.productIdentity)))
        throw new CommerceError("IDENTITY_MISMATCH", "Requested product identity differs from the locked identity. DIAPORIA never substitutes another product or variant.", { lockedIdentity: locked });
    } else {
      const candidates = (ps.research.candidates ?? []) as Array<{ identity: ProductIdentity; productId: string }>;
      const pick = candidates.find((c) => identityEquals(c.identity, normalizeIdentity(input.productIdentity)));
      if (!pick) throw new CommerceError("IDENTITY_MISMATCH", "Product identity is not one of this session's researched candidates.");
      if (locked && !identityEquals(locked, pick.identity)) throw new CommerceError("IDENTITY_MISMATCH", "This session already locked a different product. Start a new research session.");
      locked = pick.identity;
    }
    const offers = await this.research.findOffers(locked);
    // Quote anything not known to be out of stock: a merchant cart may establish availability.
    const items = await Promise.all(offers.map(async (offer) => ({ offer, quote: offer.availability !== "OUT_OF_STOCK" ? await this.research.getQuote(offer.offerId, 1, destination) : null,
      identity: await this.verifyMerchant(offer) })));
    const comparison = this.verifier.compare(locked, items, { now: this.now(), currency: ps.intent.currency, budgetMinor: ps.intent.budgetMinor });
    const holdReasons: string[] = [];
    if (!comparison.lowestVerifiedEligible) {
      holdReasons.push("No offer has a verified, fully known total that meets every requirement.");
      if (!destination) holdReasons.push("No shipping destination was given, so tax cannot be quoted. Provide country/region to get verified totals.");
    }
    const to = comparison.lowestVerifiedEligible ? "OFFER_VERIFIED" : "HOLD";
    ps = this.sessions.updatePurchaseSession(ps, to, { comparison, lockedIdentity: locked, destination });
    this.audit.append(ps.purchaseSessionId, userId, "OFFERS_COMPARED", { eligible: comparison.eligible.map((o) => o.offerId), lowest: comparison.lowestVerifiedEligible?.offerId ?? null });
    return {
      purchaseSessionId: ps.purchaseSessionId, state: ps.state, productIdentity: locked, destinationUsed: destination,
      eligibleOffers: comparison.eligible.map((o) => publicOffer(o, this.research.isMock)), ineligibleOffers: comparison.ineligible.map((o) => publicOffer(o, this.research.isMock)),
      lowestVerifiedEligibleOffer: comparison.lowestVerifiedEligible ? publicOffer(comparison.lowestVerifiedEligible, this.research.isMock) : null,
      lowestPayPalCheckoutableOffer: comparison.lowestPayPalCheckoutable ? publicOffer(comparison.lowestPayPalCheckoutable, this.research.isMock) : null,
      holdReasons, disclosure: comparison.disclosure, dataSource: this.dataSource(), paymentEffect: "NONE" as const,
    };
  }

  // ---------------------------------------------------------------- prepare_checkout
  async prepareCheckout(userId: string, input: { purchaseSessionId: string; offerId: string; maximumApprovedTotalMinor: number; currency: string; quantity: number }) {
    const ps = this.livePurchaseSession(input.purchaseSessionId, userId);
    if (ps.state !== "OFFER_VERIFIED" || !ps.comparison || !ps.lockedIdentity) throw new CommerceError("INVALID_STATE", `Session is ${ps.state}; compare offers and obtain a verified offer first.`);
    if (!isMinor(input.maximumApprovedTotalMinor) || input.maximumApprovedTotalMinor <= 0) throw new CommerceError("INVALID_INPUT", "maximumApprovedTotalMinor must be a positive integer of minor units");
    if (!Number.isSafeInteger(input.quantity) || input.quantity < 1 || input.quantity > 10) throw new CommerceError("INVALID_INPUT", "quantity must be an integer 1..10");
    if (input.currency !== ps.intent.currency) throw new CommerceError("INVALID_INPUT", `Currency ${input.currency} does not match the session currency ${ps.intent.currency}`);
    const known = [...ps.comparison.eligible, ...ps.comparison.ineligible].find((o) => o.offerId === input.offerId);
    if (!known) throw new CommerceError("NOT_FOUND", "Offer is not part of this session's verified comparison.");
    if (!known.eligible) throw new CommerceError("OFFER_NOT_ELIGIBLE", "Offer was not eligible at comparison time.", { issues: known.issues });

    const inFlight = this.sessions.findPaymentInFlightOrDone(userId, ps.purchaseSessionId);
    if (inFlight && !(inFlight.offerId === input.offerId && inFlight.quantity === input.quantity))
      throw new CommerceError("INVALID_STATE", `A payment for this purchase session is ${inFlight.state}; a new payment attempt is prohibited until it is final.`, { checkoutSessionId: inFlight.checkoutSessionId });
    // A repeated identical prepare after the payment completed returns that checkout: one purchase
    // session buys at most once. A new purchase needs a new research session (and new authorization).
    if (inFlight && inFlight.state === "COMPLETED") { this.audit.append(inFlight.checkoutSessionId, userId, "PREPARE_DEDUPLICATED", { after: "COMPLETED" }); return this.prepareResult(inFlight, null, true); }
    const dup = this.sessions.findActiveDuplicate(userId, ps.purchaseSessionId, input.offerId, input.quantity);
    if (dup) { this.audit.append(dup.checkoutSessionId, userId, "PREPARE_DEDUPLICATED", {}); return this.prepareResult(this.expireIfNeeded(dup), null, true); }

    // Re-verify with a fresh server-side quote for the requested quantity. Client values are never trusted.
    const offer = (await this.research.findOffers(ps.lockedIdentity)).find((o) => o.offerId === input.offerId);
    if (!offer) throw new CommerceError("OFFER_NOT_ELIGIBLE", "Offer no longer exists at the merchant.");
    if (offer.merchantId !== known.merchantId || offer.merchantDomain !== known.merchantDomain)
      throw new CommerceError("MERCHANT_IDENTITY_MISMATCH", "Merchant id or domain changed since comparison; the offer is not the one that was verified.", { compared: known.merchantId, now: offer.merchantId });
    const quote = await this.research.getQuote(offer.offerId, input.quantity, ps.destination);
    const checkoutSessionId = newCheckoutSessionId();
    const identity = await this.verifyMerchant(offer, checkoutSessionId);
    const v = this.verifier.verifyOne(ps.lockedIdentity, offer, quote, { now: this.now(), currency: ps.intent.currency, budgetMinor: ps.intent.budgetMinor }, identity);
    const bound = this.bindIdentity(offer, identity);
    // The recipient only matters when DIAPORIA itself creates the payment order.
    if ("code" in bound && !(bound.code === "MERCHANT_RECIPIENT_UNKNOWN" && v.checkoutPath === "EXTERNAL_MERCHANT_CHECKOUT")) {
      this.audit.append(ps.purchaseSessionId, userId, "MERCHANT_IDENTITY_REJECTED", { offerId: offer.offerId, code: bound.code });
      throw new CommerceError(bound.code, `Merchant identity could not be bound to this checkout: ${bound.detail}`, { merchantIdentity: { overall: identity.overall, legalEntity: identity.legalEntity, paymentRelationship: identity.paymentRelationship } });
    }
    if (!v.eligible || !v.cost || v.cost.totalMinor === null || !quote) throw new CommerceError("OFFER_NOT_ELIGIBLE", "Fresh merchant quote failed verification.", { issues: v.issues });
    if (v.cost.totalMinor > input.maximumApprovedTotalMinor)
      throw new CommerceError("CLIENT_LIMIT_EXCEEDED", `Verified total ${v.cost.totalMinor} exceeds the requested maximum ${input.maximumApprovedTotalMinor}.`, { totalMinor: v.cost.totalMinor });
    if (v.checkoutPath === "EXTERNAL_MERCHANT_CHECKOUT") {
      this.audit.append(ps.purchaseSessionId, userId, "EXTERNAL_CHECKOUT_HANDOFF", { offerId: offer.offerId });
      return { checkoutSessionId: null, state: "HOLD" as const, checkoutPath: "EXTERNAL_MERCHANT_CHECKOUT" as const, externalCheckoutUrl: v.listingUrl,
        purchaseSummary: null, authorizationRequirements: ["COMPLETE_PURCHASE_ON_MERCHANT_SITE"], approvalUrl: null, userAuthorizationUrl: null, expiresAt: null,
        policy: null, paymentEffect: "NONE" as const, paymentEnvironment: paymentEnvironment(this.payments.name), liveMerchantCheckout: false as const, note: "This merchant has no DIAPORIA-supported checkout. DIAPORIA does not pay third-party merchants; use the merchant's own checkout." };
    }
    if ("code" in bound) throw new CommerceError(bound.code, bound.detail);
    let cs = this.sessions.createCheckout({
      checkoutSessionId, merchantIdentity: bound.binding,
      userId, purchaseSessionId: ps.purchaseSessionId, offerId: offer.offerId, merchantId: offer.merchantId, quoteId: quote.quoteId, identity: ps.lockedIdentity,
      quantity: input.quantity, currency: ps.intent.currency, cost: v.cost, totalMinor: v.cost.totalMinor, clientMaxMinor: input.maximumApprovedTotalMinor,
      provider: this.payments.name, expiresAt: Math.min(Date.parse(quote.expiresAt), Date.parse(bound.binding.attestationExpiresAt), this.now() + (this.config.checkoutTtlMs ?? CHECKOUT_TTL_MS)),
      merchantName: offer.merchantName, merchantDomain: offer.merchantDomain, checkoutPath: v.checkoutPath, disclosure: DISCLOSURE,
    });
    this.audit.append(cs.checkoutSessionId, userId, "CHECKOUT_PREPARED", { totalMinor: cs.totalMinor, currency: cs.currency, summaryHash: cs.summaryHash });
    this.audit.append(cs.checkoutSessionId, userId, "MERCHANT_IDENTITY_BOUND", { attestationId: bound.binding.attestationId, intendedPayeeId: bound.binding.intendedPayeeId,
      payeeRelationship: bound.binding.payeeRelationship, provenance: bound.binding.provenance });
    if (!this.config.paymentExecutionEnabled) {
      cs = this.sessions.transition(cs, "HOLD", { failureCode: "PUBLIC_PAYMENT_DISABLED", failureReason: "Payment execution is disabled on this deployment (no production user authentication)." });
      return this.prepareResult(cs, null, false);
    }
    const mandate = this.policy.findApplicable(userId, cs.identity);
    if (!mandate) {
      cs = this.sessions.transition(cs, "APPROVAL_REQUIRED", { failureCode: null });
      this.audit.append(cs.checkoutSessionId, userId, "OWNER_AUTHORIZATION_REQUIRED", {});
      return this.prepareResult(cs, null, false);
    }
    const { checkout, decision } = await this.startPayment(cs, mandate.mandateId);
    return this.prepareResult(checkout, decision, false);
  }

  /**
   * Reserves the amount against a mandate atomically, then creates the provider order.
   * A policy denial happens BEFORE any payment provider call.
   */
  async startPayment(cs: CheckoutSession, mandateId: string): Promise<{ checkout: CheckoutSession; decision: PolicyDecision }> {
    cs = this.expireIfNeeded(cs);
    if (!["PREPARED", "APPROVAL_REQUIRED", "HOLD"].includes(cs.state) || cs.providerOrderId) throw new CommerceError("INVALID_STATE", `Checkout is ${cs.state}; payment cannot be started.`);
    if (!this.config.paymentExecutionEnabled) throw new CommerceError("PAYMENT_DISABLED", "Payment execution is disabled on this deployment.");
    const decision = this.policy.reserve(mandateId, { userId: cs.userId, checkoutSessionId: cs.checkoutSessionId, productIdentity: cs.identity, merchantId: cs.merchantId,
      currency: cs.currency, quantity: cs.quantity, totalMinor: cs.totalMinor });
    this.audit.append(cs.checkoutSessionId, cs.userId, decision.allowed ? "MANDATE_RESERVED" : "MANDATE_REJECTED", { mandateId, code: decision.code, totalMinor: cs.totalMinor });
    if (!decision.allowed) {
      const checkout = cs.state === "HOLD" ? this.sessions.transition(this.sessions.transition(cs, "APPROVAL_REQUIRED"), "HOLD", { failureCode: decision.code, failureReason: decision.detail })
        : this.sessions.transition(cs, "HOLD", { failureCode: decision.code, failureReason: decision.detail });
      return { checkout, decision };
    }
    if (cs.state === "PREPARED" || cs.state === "HOLD") cs = this.sessions.transition(cs, "APPROVAL_REQUIRED", { mandateId, reservedMinor: cs.totalMinor, failureCode: null, failureReason: null });
    else cs = this.sessions.transition(cs, "APPROVAL_REQUIRED", { mandateId, reservedMinor: cs.totalMinor });
    try {
      const order = await this.payments.createOrder({
        checkoutSessionId: cs.checkoutSessionId, amount: { currency: cs.currency, amountMinor: cs.totalMinor },
        description: `DIAPORIA Sandbox demo: ${cs.identity.brand} ${cs.identity.model} ${cs.identity.variant ?? ""} x${cs.quantity}`.trim(),
        returnUrl: `${this.config.baseUrl}/paypal/return?checkout=${encodeURIComponent(cs.checkoutSessionId)}`,
        cancelUrl: `${this.config.baseUrl}/paypal/cancel?checkout=${encodeURIComponent(cs.checkoutSessionId)}`,
        idempotencyKey: cs.createKey,
        payeeMerchantId: cs.intendedPayeeId,
      });
      cs = this.sessions.transition(cs, "APPROVAL_REQUIRED", { providerOrderId: order.orderId, approvalUrl: order.approvalUrl });
      this.audit.append(cs.checkoutSessionId, cs.userId, "PROVIDER_ORDER_CREATED", { provider: this.payments.name, orderId: order.orderId });
    } catch (e) {
      if (e instanceof ProviderTimeoutError) {
        cs = this.sessions.transition(cs, "UNKNOWN", { failureCode: "CREATE_ORDER_TIMEOUT", failureReason: e.message });
      } else {
        this.policy.release(mandateId, cs.userId, cs.totalMinor, cs.checkoutSessionId);
        cs = this.sessions.transition(cs, "FAILED", { reservedMinor: 0, failureCode: "CREATE_ORDER_FAILED", failureReason: errorText(e) });
      }
      this.audit.append(cs.checkoutSessionId, cs.userId, "PROVIDER_ORDER_ERROR", { state: cs.state, reason: errorText(e) });
    }
    return { checkout: cs, decision };
  }

  /** Owner-authenticated page: creates a mandate bound to exactly this checkout, then starts payment. */
  async authorizeCheckoutAsOwner(ownerUserId: string, checkoutSessionId: string, maximumTotalMinor: number) {
    const cs = this.expireIfNeeded(this.sessions.getCheckout(checkoutSessionId, ownerUserId));
    if (!isMinor(maximumTotalMinor) || maximumTotalMinor <= 0) throw new CommerceError("INVALID_INPUT", "Maximum must be a positive amount");
    const mandate = this.mandates.create({ userId: ownerUserId, productIdentity: cs.identity, currency: cs.currency, maximumTotalMinor, maximumQuantity: cs.quantity,
      maximumTransactions: 1, ttlSeconds: 1800, allowedMerchantIds: [cs.merchantId], createdVia: "OWNER_APPROVAL_PAGE" });
    this.audit.append(cs.checkoutSessionId, ownerUserId, "MANDATE_CREATED_BY_OWNER", { mandateId: mandate.mandateId, maximumTotalMinor });
    return { mandate, ...(await this.startPayment(cs, mandate.mandateId)) };
  }

  /**
   * The owner withdraws a checkout before any capture. Allowed only while nothing can have been
   * captured: PREPARED, HOLD, or APPROVAL_REQUIRED when the provider still reports the order as not
   * approved. If the provider says the buyer already approved (or the read fails), the checkout is
   * left alone and the reason is returned: cancelling then could race a capture.
   */
  async cancelCheckoutAsOwner(ownerUserId: string, checkoutSessionId: string): Promise<{ checkout: CheckoutSession; cancelled: boolean; reason: string }> {
    let cs = this.expireIfNeeded(this.sessions.getCheckout(checkoutSessionId, ownerUserId));
    if (!["PREPARED", "HOLD", "APPROVAL_REQUIRED"].includes(cs.state)) return { checkout: cs, cancelled: false, reason: `NOT_CANCELLABLE_IN_${cs.state}` };
    if (cs.state === "APPROVAL_REQUIRED" && cs.providerOrderId) {
      try {
        const order = await this.payments.getOrder(cs.providerOrderId);
        if (order.status === "APPROVED" || order.status === "COMPLETED") {
          this.audit.append(cs.checkoutSessionId, ownerUserId, "OWNER_CANCEL_REFUSED", { providerStatus: order.status });
          return { checkout: cs, cancelled: false, reason: "BUYER_ALREADY_APPROVED_AT_PROVIDER" };
        }
      } catch (e) {
        this.audit.append(cs.checkoutSessionId, ownerUserId, "OWNER_CANCEL_CHECK_FAILED", { reason: errorText(e) });
        return { checkout: cs, cancelled: false, reason: "PROVIDER_STATE_UNKNOWN" };
      }
    }
    const reserved = cs.reservedMinor;
    cs = this.sessions.transition(cs, "CANCELLED", { reservedMinor: 0, failureCode: "OWNER_CANCELLED", failureReason: "The owner cancelled this checkout before payment" });
    if (cs.mandateId && reserved > 0) this.policy.release(cs.mandateId, cs.userId, reserved, cs.checkoutSessionId);
    this.audit.append(cs.checkoutSessionId, ownerUserId, "OWNER_CANCELLED", { releasedMinor: reserved });
    return { checkout: cs, cancelled: true, reason: "OWNER_CANCELLED" };
  }

  // ---------------------------------------------------------------- provider return / cancel / reconcile
  /** Buyer came back from PayPal. The redirect itself proves nothing: PayPal is queried. */
  async handleBuyerReturn(checkoutSessionId: string, providerOrderId: string): Promise<CheckoutSession> {
    let cs = this.sessions.getCheckoutForProviderReturn(checkoutSessionId, providerOrderId);
    this.audit.append(cs.checkoutSessionId, cs.userId, "BUYER_RETURNED", { stateAtReturn: cs.state });
    if (cs.state === "UNKNOWN") return this.reconcile(cs.userId, cs.checkoutSessionId);
    if (cs.state !== "APPROVAL_REQUIRED" && cs.state !== "APPROVED") return cs; // duplicate/late redirect: no second capture
    if (cs.state === "APPROVAL_REQUIRED") {
      let order;
      try { order = await this.payments.getOrder(providerOrderId); }
      catch (e) { this.audit.append(cs.checkoutSessionId, cs.userId, "APPROVAL_CHECK_FAILED", { reason: errorText(e) }); return cs; }
      const mismatch = order.customId !== cs.checkoutSessionId || !order.amount || order.amount.currency !== cs.currency || order.amount.amountMinor !== cs.totalMinor;
      if (mismatch) return this.fail(cs, "PROVIDER_ORDER_MISMATCH", "PayPal order amount, currency or ownership differs from the checkout summary");
      if (order.status === "COMPLETED") return this.reconcile(cs.userId, cs.checkoutSessionId);
      if (order.status !== "APPROVED") { this.audit.append(cs.checkoutSessionId, cs.userId, "APPROVAL_NOT_VERIFIED", { providerStatus: order.status }); return cs; }
      try { cs = this.sessions.transition(cs, "APPROVED"); }
      catch (e) { if (e instanceof StaleStateError) return this.sessions.getCheckout(cs.checkoutSessionId, cs.userId); throw e; }
      this.audit.append(cs.checkoutSessionId, cs.userId, "BUYER_APPROVAL_VERIFIED", { providerStatus: order.status });
    }
    return this.capture(cs);
  }

  private async capture(cs: CheckoutSession): Promise<CheckoutSession> {
    const mandate = cs.mandateId ? this.mandates.get(cs.mandateId, cs.userId) : null;
    if (!mandate || mandate.authorizationStatus === "REVOKED" || mandate.authorizationStatus === "EXPIRED")
      return this.fail(cs, "MANDATE_NO_LONGER_VALID", "Mandate was revoked or expired before capture; nothing was captured.");
    const recipient = await this.verifyRecipientBeforeCapture(cs);
    if (recipient.fail) return this.fail(cs, recipient.fail.code, recipient.fail.detail);
    try { cs = this.sessions.transition(cs, "CAPTURE_PENDING", recipient.actual ? { actualRecipientId: recipient.actual } : {}); }
    catch (e) { if (e instanceof StaleStateError) return this.sessions.getCheckout(cs.checkoutSessionId, cs.userId); throw e; }
    this.audit.append(cs.checkoutSessionId, cs.userId, "CAPTURE_REQUESTED", { idempotent: true });
    let capture: ProviderCapture;
    try { capture = await this.payments.captureOrder(cs.providerOrderId!, cs.captureKey); }
    catch (e) {
      if (e instanceof ProviderError) return this.fail(cs, "CAPTURE_REJECTED", errorText(e));
      cs = this.sessions.transition(cs, "UNKNOWN", { failureCode: "CAPTURE_OUTCOME_UNKNOWN", failureReason: errorText(e) });
      this.audit.append(cs.checkoutSessionId, cs.userId, "CAPTURE_OUTCOME_UNKNOWN", { reason: errorText(e) });
      return cs;
    }
    return this.applyCapture(cs, capture);
  }

  /**
   * Before any capture: (1) the merchant's identity is re-verified with an attestation bound to this
   * checkout, the same payee and the same legal entity; (2) the actual order recipient reported by the
   * payment provider equals the intended payee. Any MISMATCH or UNKNOWN fails closed (nothing captured).
   */
  private async verifyRecipientBeforeCapture(cs: CheckoutSession): Promise<{ fail?: { code: string; detail: string }; actual?: string }> {
    const mi = cs.merchantIdentity;
    if (!mi || !cs.intendedPayeeId) return { fail: { code: "MERCHANT_IDENTITY_UNKNOWN", detail: "No merchant identity was bound to this checkout" } };
    const offer = (await this.research.findOffers(cs.identity)).find((o) => o.offerId === cs.offerId);
    if (!offer || offer.merchantId !== cs.merchantId) return { fail: { code: "MERCHANT_IDENTITY_MISMATCH", detail: "Offer merchant changed or disappeared before capture" } };
    const again = await this.verifyMerchant(offer, cs.checkoutSessionId, { payeeAccountId: mi.attestedPayeeId, identifierValue: mi.identifierValue });
    if (again.overall !== "MATCH") {
      this.audit.append(cs.checkoutSessionId, cs.userId, "MERCHANT_IDENTITY_RECHECK_FAILED", { overall: again.overall, failing: again.checks.filter((c) => c.result !== "MATCH").map((c) => c.check) });
      return { fail: { code: again.overall === "MISMATCH" ? "MERCHANT_IDENTITY_MISMATCH" : "MERCHANT_IDENTITY_UNKNOWN",
        detail: again.checks.filter((c) => c.result !== "MATCH").map((c) => `${c.check}: ${c.detail}`).join("; ") } };
    }
    let order;
    try { order = await this.payments.getOrder(cs.providerOrderId!); }
    catch (e) { return { fail: { code: "MERCHANT_RECIPIENT_UNVERIFIED", detail: `Could not read the order recipient: ${errorText(e)}` } }; }
    const actual = order.payee.merchantId;
    if (!actual) return { fail: { code: "MERCHANT_RECIPIENT_UNVERIFIED", detail: "Payment provider did not report the order recipient" } };
    // The merchant id is the authoritative recipient and is always required (checked below).
    // PayPal echoes payee.email_address only when the order was created with it; DIAPORIA creates
    // orders with merchant_id only (observed in the 2026-11-09 Sandbox run). So the configured email is
    // a secondary check: if PayPal reports an email it must match; if it reports none, that is recorded.
    const expectedEmail = this.payments.name === "PAYPAL_SANDBOX" ? (this.config.sandboxPlatformPayeeEmail ?? null) : null;
    const actualEmail = order.payee.emailAddress ?? null;
    if (expectedEmail && !actualEmail) this.audit.append(cs.checkoutSessionId, cs.userId, "RECIPIENT_EMAIL_NOT_REPORTED", { verifiedBy: "merchant_id" });
    if (expectedEmail && actualEmail) {
      if (actualEmail.trim().toLowerCase() !== expectedEmail.trim().toLowerCase()) {
        this.audit.append(cs.checkoutSessionId, cs.userId, "MERCHANT_RECIPIENT_MISMATCH", { field: "email" });
        return { fail: { code: "MERCHANT_RECIPIENT_MISMATCH", detail: "The order recipient email differs from the configured Sandbox business account" } };
      }
    }
    if (actual !== cs.intendedPayeeId) {
      this.audit.append(cs.checkoutSessionId, cs.userId, "MERCHANT_RECIPIENT_MISMATCH", { intended: cs.intendedPayeeId, actual });
      return { fail: { code: "MERCHANT_RECIPIENT_MISMATCH", detail: "The order would pay a different account than the one bound to the verified merchant" } };
    }
    this.audit.append(cs.checkoutSessionId, cs.userId, "MERCHANT_RECIPIENT_VERIFIED", { recipient: actual, provenance: this.payments.name === "PAYPAL_SANDBOX" ? "PAYMENT_PROVIDER" : "MOCK", attestationRechecked: again.attestationId });
    return { actual };
  }

  private async applyCapture(cs: CheckoutSession, capture: ProviderCapture): Promise<CheckoutSession> {
    if (!capture.amount || capture.amount.amountMinor !== cs.totalMinor || capture.amount.currency !== cs.currency) {
      cs = this.sessions.transition(cs, "UNKNOWN", { captureId: capture.captureId || null, captureStatus: capture.status, failureCode: "CAPTURE_AMOUNT_MISMATCH", failureReason: "Captured amount differs from the approved summary; manual review required" });
      this.audit.append(cs.checkoutSessionId, cs.userId, "CAPTURE_AMOUNT_MISMATCH", {});
      return cs;
    }
    if (capture.status === "COMPLETED") {
      // Re-read the capture from the provider before declaring completion.
      let verified: ProviderCapture | null = null;
      try { verified = await this.payments.getCapture(capture.captureId); } catch { verified = null; }
      if (verified?.status === "COMPLETED" && verified.amount?.amountMinor === cs.totalMinor) {
        if (cs.state === "UNKNOWN") cs = this.sessions.transition(cs, "CAPTURE_PENDING", { captureId: capture.captureId, captureStatus: "COMPLETED" });
        cs = this.sessions.transition(cs, "COMPLETED", { captureId: capture.captureId, captureStatus: "COMPLETED", failureCode: null, failureReason: null });
        if (cs.mandateId) this.policy.consume(cs.mandateId, cs.userId, cs.reservedMinor);
        this.audit.append(cs.checkoutSessionId, cs.userId, "PAYMENT_COMPLETED_VERIFIED", { captureId: capture.captureId });
        return cs;
      }
      cs = this.sessions.transition(cs, "CAPTURE_PENDING", { captureId: capture.captureId, captureStatus: "COMPLETED_UNVERIFIED", failureCode: "CAPTURE_VERIFICATION_PENDING", failureReason: "Capture reported COMPLETED but could not be re-read yet" });
      return cs;
    }
    if (capture.status === "PENDING") {
      cs = this.sessions.transition(cs, "CAPTURE_PENDING", { captureId: capture.captureId, captureStatus: "PENDING", failureCode: "CAPTURE_PENDING", failureReason: capture.reason ?? "PayPal reports the capture as pending" });
      this.audit.append(cs.checkoutSessionId, cs.userId, "CAPTURE_PENDING", { reason: capture.reason });
      return cs;
    }
    if (capture.status === "DECLINED" || capture.status === "FAILED")
      return this.fail({ ...cs, captureId: capture.captureId, captureStatus: capture.status }, "CAPTURE_DECLINED", capture.reason ?? `Capture ${capture.status}`);
    cs = this.sessions.transition(cs, "UNKNOWN", { captureId: capture.captureId || null, captureStatus: capture.status, failureCode: "CAPTURE_STATUS_UNRECOGNIZED", failureReason: `Unrecognized capture status ${capture.status}` });
    return cs;
  }

  async handleBuyerCancel(checkoutSessionId: string, providerOrderId: string): Promise<CheckoutSession> {
    const cs = this.sessions.getCheckoutForProviderReturn(checkoutSessionId, providerOrderId);
    if (cs.state !== "APPROVAL_REQUIRED") return cs;
    try {
      const order = await this.payments.getOrder(providerOrderId);
      if (order.status === "APPROVED" || order.status === "COMPLETED") return this.handleBuyerReturn(checkoutSessionId, providerOrderId);
    } catch (e) {
      this.audit.append(cs.checkoutSessionId, cs.userId, "CANCEL_CHECK_FAILED", { reason: errorText(e) });
      return cs;
    }
    const out = this.sessions.transition(cs, "CANCELLED", { reservedMinor: 0, failureCode: "BUYER_CANCELLED", failureReason: "Buyer cancelled on the payment page" });
    if (cs.mandateId && cs.reservedMinor > 0) this.policy.release(cs.mandateId, cs.userId, cs.reservedMinor, cs.checkoutSessionId);
    this.audit.append(cs.checkoutSessionId, cs.userId, "BUYER_CANCELLED", {});
    return out;
  }

  /** Re-reads authoritative provider state for UNKNOWN / CAPTURE_PENDING checkouts. */
  async reconcile(userId: string, checkoutSessionId: string): Promise<CheckoutSession> {
    let cs = this.sessions.getCheckout(checkoutSessionId, userId);
    if (cs.captureId) return (await this.reconcileCapture(cs, "MANUAL")).checkout;
    if (!["UNKNOWN", "CAPTURE_PENDING"].includes(cs.state) || !cs.providerOrderId) return cs;
    const order = await this.payments.getOrder(cs.providerOrderId);
    this.audit.append(cs.checkoutSessionId, userId, "RECONCILED", { providerStatus: order.status, captures: order.captures.length });
    const cap = order.captures[0];
    if (cap) {
      // Never trust the order's embedded capture: read the capture itself (Payments v2).
      let fresh: ProviderCapture;
      try { fresh = await this.readWithRetry(() => this.payments.getCapture(cap.captureId)); }
      catch (e) { this.audit.append(cs.checkoutSessionId, userId, "RECONCILE_PROVIDER_UNAVAILABLE", { reason: errorText(e) }); return cs; }
      return this.applyCapture(cs, fresh);
    }
    if (cs.state === "UNKNOWN" && order.status === "APPROVED") {
      cs = this.sessions.transition(cs, "APPROVED", { failureCode: null, failureReason: null });
      return this.capture(cs); // same PayPal-Request-Id: a replay cannot double-capture
    }
    return cs;
  }

  // ---------------------------------------------------------------- authoritative capture reconciliation
  /** Bounded retries for READ-ONLY provider calls; only network/5xx-class failures are retried. */
  private async readWithRetry<T>(fn: () => Promise<T>): Promise<T> {
    const { attempts, baseDelayMs } = this.config.readRetry ?? { attempts: 3, baseDelayMs: 250 };
    let last: unknown;
    for (let i = 0; i < attempts; i++) {
      try { return await fn(); }
      catch (e) {
        last = e;
        if (!(e instanceof ProviderTimeoutError) || i === attempts - 1) break;
        await sleep(baseDelayMs * 2 ** i);
      }
    }
    throw last;
  }

  /**
   * Re-reads the capture from the provider (GET /v2/payments/captures/{id}) and applies only
   * evidence-backed, monotonic transitions. It never creates, captures, refunds or voids anything,
   * and never releases a reservation because a read failed.
   */
  async reconcileCapture(cs: CheckoutSession, source: ReconcileSource): Promise<{ checkout: CheckoutSession; outcome: ReconcileOutcome; providerStatus: string | null }> {
    if (!cs.captureId) return { checkout: cs, outcome: "NOT_APPLICABLE", providerStatus: null };
    let cap: ProviderCapture;
    try { cap = await this.readWithRetry(() => this.payments.getCapture(cs.captureId!)); }
    catch (e) {
      this.audit.append(cs.checkoutSessionId, cs.userId, "RECONCILE_PROVIDER_UNAVAILABLE", { source, reason: errorText(e) });
      return { checkout: cs, outcome: "PROVIDER_UNAVAILABLE", providerStatus: null };
    }
    cs = this.sessions.getCheckout(cs.checkoutSessionId, cs.userId); // freshest local state
    const ev = { source, providerStatus: cap.status, reason: cap.reason, captureId: cap.captureId };
    if (cap.captureId !== cs.captureId) {
      this.audit.append(cs.checkoutSessionId, cs.userId, "RECONCILE_CAPTURE_ID_MISMATCH", ev);
      return { checkout: cs, outcome: "CAPTURE_ID_MISMATCH", providerStatus: cap.status };
    }
    const amountOk = !!cap.amount && cap.amount.amountMinor === cs.totalMinor && cap.amount.currency === cs.currency;
    if (!amountOk) {
      this.audit.append(cs.checkoutSessionId, cs.userId, "RECONCILE_AMOUNT_MISMATCH", ev);
      if (cs.state === "CAPTURE_PENDING" || cs.state === "UNKNOWN")
        cs = this.sessions.transition(cs, "UNKNOWN", { failureCode: "CAPTURE_AMOUNT_MISMATCH", failureReason: "Provider capture amount differs from the approved summary; manual review required", providerVerifiedAt: this.now() });
      return { checkout: cs, outcome: "AMOUNT_MISMATCH", providerStatus: cap.status };
    }
    const awaiting = cs.state === "CAPTURE_PENDING" || cs.state === "UNKNOWN";
    const verifiedAt = this.now();
    if (cap.status === "PENDING") {
      if (awaiting) {
        cs = cs.state === "UNKNOWN"
          ? this.sessions.transition(cs, "CAPTURE_PENDING", { captureStatus: "PENDING", failureCode: "CAPTURE_PENDING", failureReason: cap.reason ?? "PENDING", providerVerifiedAt: verifiedAt, providerPendingReason: cap.reason })
          : this.sessions.recordProviderVerification(cs, "PENDING", cap.reason);
        this.audit.append(cs.checkoutSessionId, cs.userId, "RECONCILED_STILL_PENDING", ev);
        return { checkout: cs, outcome: "STILL_PENDING", providerStatus: cap.status };
      }
      this.audit.append(cs.checkoutSessionId, cs.userId, "RECONCILE_CONFLICT_IGNORED", { ...ev, localState: cs.state, rule: "no regression from a final local state" });
      return { checkout: cs, outcome: "CONFLICT_IGNORED", providerStatus: cap.status };
    }
    if (cap.status === "COMPLETED") {
      if (!awaiting) {
        this.audit.append(cs.checkoutSessionId, cs.userId, cs.state === "COMPLETED" ? "RECONCILED_NO_CHANGE" : "RECONCILE_CONFLICT_IGNORED", { ...ev, localState: cs.state });
        return { checkout: cs, outcome: cs.state === "COMPLETED" ? "NO_CHANGE" : "CONFLICT_IGNORED", providerStatus: cap.status };
      }
      if (cs.state === "UNKNOWN") cs = this.sessions.transition(cs, "CAPTURE_PENDING", { captureStatus: "COMPLETED" });
      cs = this.sessions.transition(cs, "COMPLETED", { captureStatus: "COMPLETED", failureCode: null, failureReason: null, providerVerifiedAt: verifiedAt, providerPendingReason: null });
      if (cs.mandateId) this.policy.consume(cs.mandateId, cs.userId, cs.reservedMinor);
      this.audit.append(cs.checkoutSessionId, cs.userId, "PAYMENT_COMPLETED_VERIFIED", ev);
      return { checkout: cs, outcome: "SETTLED_COMPLETED", providerStatus: cap.status };
    }
    if (cap.status === "DECLINED" || cap.status === "FAILED") {
      if (!awaiting) {
        this.audit.append(cs.checkoutSessionId, cs.userId, "RECONCILE_CONFLICT_IGNORED", { ...ev, localState: cs.state });
        return { checkout: cs, outcome: "CONFLICT_IGNORED", providerStatus: cap.status };
      }
      // Definitive provider outcome: nothing was paid, so the reservation is returned.
      const out = this.sessions.transition(cs, "FAILED", { reservedMinor: 0, captureStatus: cap.status, failureCode: "CAPTURE_DECLINED", failureReason: cap.reason ?? `Capture ${cap.status}`, providerVerifiedAt: verifiedAt, providerPendingReason: null });
      if (cs.mandateId && cs.reservedMinor > 0) this.policy.release(cs.mandateId, cs.userId, cs.reservedMinor, cs.checkoutSessionId);
      this.audit.append(cs.checkoutSessionId, cs.userId, "PAYMENT_FAILED_VERIFIED", ev);
      return { checkout: out, outcome: "SETTLED_FAILED", providerStatus: cap.status };
    }
    if (cap.status === "REFUNDED" || cap.status === "PARTIALLY_REFUNDED") {
      if (cs.state === "REFUNDED") { this.audit.append(cs.checkoutSessionId, cs.userId, "RECONCILED_NO_CHANGE", ev); return { checkout: cs, outcome: "NO_CHANGE", providerStatus: cap.status }; }
      if (cs.state !== "COMPLETED" && !awaiting) {
        this.audit.append(cs.checkoutSessionId, cs.userId, "RECONCILE_CONFLICT_IGNORED", { ...ev, localState: cs.state });
        return { checkout: cs, outcome: "CONFLICT_IGNORED", providerStatus: cap.status };
      }
      // A refund implies the funds were captured: the reservation becomes spend and the mandate is NOT restored.
      if (awaiting && cs.mandateId && cs.reservedMinor > 0) this.policy.consume(cs.mandateId, cs.userId, cs.reservedMinor);
      cs = this.sessions.transition(cs, "REFUNDED", { captureStatus: cap.status, failureCode: null, failureReason: null, providerVerifiedAt: verifiedAt, providerPendingReason: null });
      this.audit.append(cs.checkoutSessionId, cs.userId, "PAYMENT_REFUNDED_VERIFIED", ev);
      return { checkout: cs, outcome: "REFUNDED", providerStatus: cap.status };
    }
    this.audit.append(cs.checkoutSessionId, cs.userId, "RECONCILE_UNRECOGNIZED_STATUS", ev);
    return { checkout: cs, outcome: "NO_CHANGE", providerStatus: cap.status };
  }

  /** Startup recovery: re-read every capture whose outcome is not final. Read-only toward the provider. */
  async reconcileAwaitingSettlement(source: ReconcileSource = "STARTUP") {
    const results: Array<{ checkoutSessionId: string; outcome: ReconcileOutcome; state: string }> = [];
    for (const cs of this.sessions.listAwaitingProviderSettlement()) {
      const r = await this.reconcileCapture(cs, source);
      results.push({ checkoutSessionId: cs.checkoutSessionId, outcome: r.outcome, state: r.checkout.state });
    }
    // UNKNOWN with no local capture id (e.g. the capture call timed out after PayPal may have captured):
    // read the order and adopt a capture only if the provider shows one. Never captures here; if the
    // order is merely APPROVED the checkout stays UNKNOWN for the owner's explicit reconcile.
    for (const cs of this.sessions.listUnknownWithoutCapture()) {
      let outcome: ReconcileOutcome = "NO_CHANGE"; let state: string = cs.state;
      try {
        const order = await this.readWithRetry(() => this.payments.getOrder(cs.providerOrderId!));
        const cap = order.captures[0];
        this.audit.append(cs.checkoutSessionId, cs.userId, "RECONCILED_READ_ONLY", { source, providerStatus: order.status, captures: order.captures.length });
        if (cap) {
          const fresh = await this.readWithRetry(() => this.payments.getCapture(cap.captureId));
          const after = await this.applyCapture(cs, fresh);
          state = after.state;
          outcome = after.state === "COMPLETED" ? "SETTLED_COMPLETED" : after.state === "FAILED" ? "SETTLED_FAILED" : after.state === "CAPTURE_PENDING" ? "STILL_PENDING" : "NO_CHANGE";
        }
      } catch (e) {
        this.audit.append(cs.checkoutSessionId, cs.userId, "RECONCILE_PROVIDER_UNAVAILABLE", { source, reason: errorText(e) });
        outcome = "PROVIDER_UNAVAILABLE";
      }
      results.push({ checkoutSessionId: cs.checkoutSessionId, outcome, state });
    }
    return results;
  }

  // ---------------------------------------------------------------- webhooks
  /**
   * Authenticated, replay-safe webhook handling. The event only identifies WHICH capture to re-read;
   * the state change (if any) comes from the authoritative provider GET in reconcileCapture.
   */
  async handlePayPalWebhook(headers: WebhookHeaders, rawBody: string): Promise<{ http: number; outcome: string }> {
    const verifier = this.config.webhookVerifier;
    if (!verifier) return { http: 503, outcome: "WEBHOOKS_NOT_CONFIGURED" };
    const v = await verifier.verify(headers, rawBody);
    if (!v.ok) return { http: 401, outcome: `REJECTED_SIGNATURE: ${v.reason}` };
    let body: unknown;
    try { body = JSON.parse(rawBody); } catch { return { http: 400, outcome: "REJECTED_MALFORMED_JSON" }; }
    const ev = parseWebhookEvent(body);
    if ("error" in ev) return { http: 200, outcome: `IGNORED: ${ev.error}` }; // 2xx so PayPal stops retrying an event we will never handle
    const claim = this.store.db.prepare("INSERT OR IGNORE INTO webhook_events(event_id,event_type,capture_id,received_at,outcome) VALUES (?,?,?,?,?)")
      .run(ev.eventId, ev.eventType, ev.captureId, this.now(), "RECEIVED");
    if (claim.changes === 0) return { http: 200, outcome: "DUPLICATE" };
    const finish = (outcome: string, csId: string | null = null) => {
      this.store.db.prepare("UPDATE webhook_events SET outcome=?, checkout_session_id=? WHERE event_id=?").run(outcome, csId, ev.eventId);
      return { http: 200, outcome };
    };
    const cs = this.sessions.findByCaptureId(ev.captureId);
    if (!cs) return finish("IGNORED_UNRELATED_CAPTURE");
    if (ev.payeeMerchantId && cs.intendedPayeeId && ev.payeeMerchantId !== cs.intendedPayeeId) {
      this.audit.append(cs.checkoutSessionId, cs.userId, "WEBHOOK_PAYEE_MISMATCH_IGNORED", { eventId: ev.eventId, eventType: ev.eventType });
      return finish("IGNORED_PAYEE_MISMATCH", cs.checkoutSessionId);
    }
    this.audit.append(cs.checkoutSessionId, cs.userId, "WEBHOOK_RECEIVED", { eventId: ev.eventId, eventType: ev.eventType, claimedStatus: ev.claimedStatus });
    const r = await this.reconcileCapture(cs, "WEBHOOK");
    return finish(`RECONCILED_${r.outcome}`, cs.checkoutSessionId);
  }

  // ---------------------------------------------------------------- read-only
  getCheckoutStatus(userId: string, checkoutSessionId: string) {
    const cs = this.sessions.getCheckout(checkoutSessionId, userId);
    const expired = !TERMINAL.has(cs.state) && ["PREPARED", "APPROVAL_REQUIRED", "HOLD"].includes(cs.state) && cs.expiresAt <= this.now();
    return {
      checkoutSessionId: cs.checkoutSessionId, state: expired ? "EXPIRED" as const : cs.state, stateIsServerVerified: true,
      amount: { totalMinor: cs.totalMinor, currency: cs.currency }, quantity: cs.quantity, productIdentity: cs.identity,
      approval: { required: cs.state === "APPROVAL_REQUIRED", approvalUrl: cs.state === "APPROVAL_REQUIRED" ? cs.approvalUrl : null,
        // Also true for checkouts that failed AFTER verified buyer approval (from the audit journal).
        buyerApprovalVerified: ["APPROVED", "CAPTURE_PENDING", "COMPLETED"].includes(cs.state) ||
          this.audit.timeline([cs.checkoutSessionId], userId).some((e) => e.type === "BUYER_APPROVAL_VERIFIED") },
      capture: { captureId: cs.captureId, status: cs.captureStatus },
      failure: cs.failureCode ? { code: cs.failureCode, reason: cs.failureReason } : null,
      uncertainty: cs.state === "UNKNOWN" ? "Payment outcome is not known; the server will reconcile with the provider before any retry." : cs.state === "CAPTURE_PENDING" ? "Provider has not confirmed final settlement." : null,
      paymentStatus: paymentStatusOf(cs.state, expired),
      payment: this.paymentDetails(cs, expired),
      merchantOrderStatus: "MERCHANT_ORDER_NOT_VERIFIED" as const,
      merchantFundsAvailability: "NOT_DETERMINED_BY_CAPTURE_API" as const,
      merchantIdentity: publicBinding(cs),
      recipient: { intendedPayeeId: cs.intendedPayeeId, actualRecipientId: cs.actualRecipientId, verified: cs.actualRecipientId !== null && cs.actualRecipientId === cs.intendedPayeeId,
        provenance: cs.actualRecipientId ? (cs.provider === "PAYPAL_SANDBOX" ? "PAYMENT_PROVIDER" : "MOCK") : null },
      paymentProvider: cs.provider, paymentEnvironment: paymentEnvironment(cs.provider), liveMerchantCheckout: false as const, sandboxOrMock: true, fulfillment: "NOT_VERIFIED" as const, expiresAt: new Date(cs.expiresAt).toISOString(),
      purchaseOutcome: purchaseOutcomeOf(cs.provider, expired ? "EXPIRED" : cs.state, paymentStatusOf(cs.state, expired)),
    };
  }

  getPurchaseReceipt(userId: string, checkoutSessionId: string) {
    const cs = this.sessions.getCheckout(checkoutSessionId, userId);
    const timeline = this.audit.timeline([cs.purchaseSessionId, cs.checkoutSessionId], userId).map((e) => ({ at: e.at, type: e.type, data: e.data }));
    const completed = cs.state === "COMPLETED";
    return {
      checkoutSessionId: cs.checkoutSessionId, state: cs.state,
      paymentResult: completed ? { status: "COMPLETED" as const, provider: cs.provider, providerOrderId: cs.providerOrderId, captureId: cs.captureId,
        amount: { totalMinor: cs.totalMinor, currency: cs.currency }, verifiedBy: "Provider capture re-read after capture" } : null,
      paymentEnvironment: paymentEnvironment(cs.provider), liveMerchantCheckout: false as const,
      paymentStatus: paymentStatusOf(cs.state, false), isFinalPaymentReceipt: completed,
      payment: this.paymentDetails(cs, false),
      refund: cs.state === "REFUNDED" ? { status: cs.captureStatus, verifiedAt: cs.providerVerifiedAt ? new Date(cs.providerVerifiedAt).toISOString() : null } : null,
      merchantOrderStatus: "MERCHANT_ORDER_NOT_VERIFIED" as const,
      merchantIdentity: publicBinding(cs), recipient: { intendedPayeeId: cs.intendedPayeeId, actualRecipientId: cs.actualRecipientId },
      paymentStatusNote: completed ? (cs.provider === "MOCK_PAYPAL" ? "MOCK payment: no PayPal API was called." : "PayPal Sandbox payment: no real money moved.") : `No completed payment. Current state: ${cs.state}.`,
      merchantOrder: { status: "NOT_VERIFIED" as const, note: "Fictional demo merchant; no merchant order, shipment or fulfillment exists or is claimed." },
      purchaseOutcome: purchaseOutcomeOf(cs.provider, cs.state, paymentStatusOf(cs.state, false)),
      purchaseSummary: cs.summary, summaryHash: cs.summaryHash, auditTimeline: timeline,
    };
  }

  // ---------------------------------------------------------------- helpers
  private paymentDetails(cs: CheckoutSession, expired: boolean) {
    const state = expired ? "EXPIRED" : cs.state;
    const prohibited = ["APPROVED", "CAPTURE_PENDING", "UNKNOWN", "COMPLETED"].includes(state);
    const next: Record<string, string> = {
      PREPARED: "WAIT", HOLD: "OWNER_AUTHORIZATION_OR_NEW_LIMIT_REQUIRED", APPROVAL_REQUIRED: cs.approvalUrl ? "BUYER_MUST_APPROVE_AT_APPROVAL_URL" : "OWNER_MUST_AUTHORIZE_AT_USER_AUTHORIZATION_URL",
      APPROVED: "WAIT_FOR_SERVER_CAPTURE", CAPTURE_PENDING: "WAIT_FOR_PROVIDER_SETTLEMENT_DO_NOT_RETRY", UNKNOWN: "WAIT_FOR_RECONCILIATION_DO_NOT_RETRY",
      COMPLETED: "NONE_PAYMENT_COMPLETED_MERCHANT_ORDER_NOT_VERIFIED", FAILED: "NEW_OWNER_AUTHORIZATION_REQUIRED_FOR_ANY_NEW_ATTEMPT",
      REFUNDED: "NONE_PAYMENT_REFUNDED", CANCELLED: "NEW_CHECKOUT_REQUIRED", EXPIRED: "NEW_CHECKOUT_REQUIRED",
    };
    return {
      paymentEnvironment: paymentEnvironment(cs.provider), providerOrderId: cs.providerOrderId, captureId: cs.captureId,
      providerCaptureStatus: cs.captureStatus, pendingReason: state === "CAPTURE_PENDING" ? (cs.providerPendingReason ?? cs.failureReason) : null,
      lastAuthoritativeVerificationAt: cs.providerVerifiedAt ? new Date(cs.providerVerifiedAt).toISOString() : null,
      recommendedNextAction: next[state] ?? "CHECK_STATUS_LATER", newPaymentAttemptProhibited: prohibited,
      note: state === "CAPTURE_PENDING" ? "A pending capture is not a completed payment. Do not report this purchase as paid." : null,
    };
  }

  private livePurchaseSession(id: string, userId: string): PurchaseSession {
    let ps: PurchaseSession;
    try { ps = this.sessions.getPurchaseSession(id, userId); }
    catch (e) { if (e instanceof NotFoundError) throw new CommerceError("NOT_FOUND", "Purchase session not found"); throw e; }
    if (ps.expiresAt <= this.now()) {
      if (!TERMINAL.has(ps.state)) this.sessions.updatePurchaseSession(ps, "EXPIRED", {});
      throw new CommerceError("SESSION_EXPIRED", "Purchase session expired; research again.");
    }
    return ps;
  }

  expireIfNeeded(cs: CheckoutSession): CheckoutSession {
    if (["PREPARED", "APPROVAL_REQUIRED", "HOLD"].includes(cs.state) && cs.expiresAt <= this.now()) {
      if (cs.mandateId && cs.reservedMinor > 0) this.policy.release(cs.mandateId, cs.userId, cs.reservedMinor, cs.checkoutSessionId);
      const out = this.sessions.transition(cs, "EXPIRED", { reservedMinor: 0, failureCode: "CHECKOUT_EXPIRED", failureReason: "Checkout expired before approval" });
      this.audit.append(cs.checkoutSessionId, cs.userId, "CHECKOUT_EXPIRED", {});
      return out;
    }
    return cs;
  }

  private fail(cs: CheckoutSession, code: string, reason: string): CheckoutSession {
    const current = this.sessions.getCheckout(cs.checkoutSessionId, cs.userId);
    const out = this.sessions.transition(current, "FAILED", { reservedMinor: 0, captureId: cs.captureId, captureStatus: cs.captureStatus, failureCode: code, failureReason: reason });
    if (current.mandateId && current.reservedMinor > 0) this.policy.release(current.mandateId, current.userId, current.reservedMinor, current.checkoutSessionId);
    this.audit.append(cs.checkoutSessionId, cs.userId, "CHECKOUT_FAILED", { code, reason });
    return out;
  }

  private prepareResult(cs: CheckoutSession, decision: PolicyDecision | null, deduplicated: boolean) {
    const requirements: string[] = [];
    if (cs.state === "APPROVAL_REQUIRED" && !cs.providerOrderId) requirements.push("OWNER_MANDATE_REQUIRED");
    if (cs.state === "APPROVAL_REQUIRED") requirements.push("PAYPAL_BUYER_APPROVAL_REQUIRED");
    return {
      checkoutSessionId: cs.checkoutSessionId, state: cs.state, checkoutPath: "PAYPAL_SANDBOX_DEMO_MERCHANT" as const, externalCheckoutUrl: null,
      purchaseSummary: cs.summary, summaryHash: cs.summaryHash, authorizationRequirements: requirements,
      approvalUrl: cs.state === "APPROVAL_REQUIRED" ? cs.approvalUrl : null,
      userAuthorizationUrl: cs.state === "APPROVAL_REQUIRED" && !cs.providerOrderId ? `${this.config.baseUrl}/authorize/${cs.checkoutSessionId}` : null,
      expiresAt: new Date(cs.expiresAt).toISOString(),
      policy: decision ? { code: decision.code, allowed: decision.allowed, detail: decision.detail } : cs.failureCode ? { code: cs.failureCode, allowed: false, detail: cs.failureReason ?? "" } : null,
      deduplicated, paymentEffect: "NO_FUNDS_CAPTURED" as const, paymentEnvironment: paymentEnvironment(cs.provider), liveMerchantCheckout: false as const,
      note: "Funds are captured only after the buyer approves on PayPal and the server verifies that approval.",
    };
  }
}

export type PaymentStatus = "NOT_STARTED" | "NOT_AUTHORIZED" | "APPROVAL_REQUIRED" | "APPROVED_NOT_CAPTURED" | "CAPTURE_PENDING"
  | "PAYMENT_COMPLETED" | "PAYMENT_FAILED" | "PAYMENT_REFUNDED" | "PAYMENT_UNKNOWN" | "CANCELLED" | "EXPIRED";
/**
 * The three layers of a purchase, always reported separately. A completed PayPal capture is ONLY the first
 * layer: it proves the payer's funds were captured for the payee, not that a merchant accepted an order or
 * shipped anything. This server has no merchant order integration, so layers 2 and 3 are never confirmed here.
 */
export function purchaseOutcomeOf(provider: string, state: string, paymentStatus: PaymentStatus) {
  const env = provider === "PAYPAL_SANDBOX" ? "PayPal Sandbox (no real money)" : provider === "MOCK_PAYPAL" ? "MOCK (no PayPal API call)" : provider;
  const paymentLine: Record<string, string> = {
    PAYMENT_COMPLETED: `Payment captured (${env}).`, CAPTURE_PENDING: `Payment capture is pending at the provider (${env}); not final.`,
    PAYMENT_REFUNDED: `Payment was captured and then refunded (${env}).`, PAYMENT_FAILED: "Payment failed; nothing was captured.",
  };
  return {
    payment: paymentStatus,
    merchantOrderConfirmation: "NOT_CONFIRMED" as const,
    fulfillment: "NOT_VERIFIED" as const,
    merchantPurchaseComplete: false as const,
    statement: `${paymentLine[paymentStatus] ?? `Payment status: ${paymentStatus} (state ${state}).`} No merchant order confirmation was received and no fulfillment or shipment is verified, so this is not a completed merchant purchase.`,
  };
}

export function paymentStatusOf(state: string, expired: boolean): PaymentStatus {
  if (expired) return "EXPIRED";
  switch (state) {
    case "PREPARED": return "NOT_STARTED";
    case "HOLD": return "NOT_AUTHORIZED";
    case "APPROVAL_REQUIRED": return "APPROVAL_REQUIRED";
    case "APPROVED": return "APPROVED_NOT_CAPTURED";
    case "CAPTURE_PENDING": return "CAPTURE_PENDING";
    case "COMPLETED": return "PAYMENT_COMPLETED";
    case "FAILED": return "PAYMENT_FAILED";
    case "REFUNDED": return "PAYMENT_REFUNDED";
    case "CANCELLED": return "CANCELLED";
    case "EXPIRED": return "EXPIRED";
    default: return "PAYMENT_UNKNOWN";
  }
}

function publicBinding(cs: CheckoutSession) {
  if (!cs.merchantIdentity) return null;
  const { identifierValue: _hidden, ...pub } = cs.merchantIdentity;
  return pub;
}

/** MOCK = no PayPal API at all; PAYPAL_SANDBOX = PayPal test environment, no real money. Live is not supported. */
export function paymentEnvironment(provider: string): "MOCK" | "PAYPAL_SANDBOX" { return provider === "PAYPAL_SANDBOX" ? "PAYPAL_SANDBOX" : "MOCK"; }

function capabilityStatus(p: CatalogProduct, capability: string): { capability: string; status: CapabilityStatus; evidence: CatalogProduct["capabilities"][number]["source"] | null } {
  const claims = p.capabilities.filter((c) => c.capability === capability);
  const strong = claims.find((c) => c.source.kind !== "CATALOG_LISTING");
  if (strong) return { capability, status: strong.value ? "VERIFIED_TRUE" : "VERIFIED_FALSE", evidence: strong.source };
  const weak = claims[0];
  if (weak) return { capability, status: "LISTING_CLAIM_ONLY", evidence: weak.source };
  return { capability, status: "UNKNOWN", evidence: null };
}

/**
 * Evidence class of an offer, so a fixture can never be read as a real merchant offer:
 * FIXTURE_OFFER (demo data) < MERCHANT_API_ESTIMATE (a real merchant system priced a cart) <
 * VERIFIED_FINAL_QUOTE (merchant-attested final total). A confirmed merchant ORDER is never claimed.
 */
export function offerEvidenceClass(o: VerifiedOffer, fixtureCatalog: boolean): "FIXTURE_OFFER" | "MERCHANT_API_ESTIMATE" | "VERIFIED_FINAL_QUOTE" | "UNVERIFIED_OFFER" {
  const ev = o.quoteEvidence;
  if (ev) {
    if (ev.provenance !== "MERCHANT_API") return "FIXTURE_OFFER";
    return ev.status === "FINAL_QUOTE_VERIFIED" ? "VERIFIED_FINAL_QUOTE" : "MERCHANT_API_ESTIMATE";
  }
  return fixtureCatalog ? "FIXTURE_OFFER" : "UNVERIFIED_OFFER";
}

function publicOffer(o: VerifiedOffer, fixtureCatalog: boolean) {
  return { offerEvidenceClass: offerEvidenceClass(o, fixtureCatalog), merchantOrderStatus: "NO_MERCHANT_ORDER" as const, offerId: o.offerId, merchantId: o.merchantId, merchantName: o.merchantName, merchantDomain: o.merchantDomain, listingUrl: o.listingUrl,
    identityMatch: o.identityMatch, listedIdentity: o.listedIdentity, listingPriceMinor: o.listingPriceMinor, cost: o.cost, quoteId: o.quoteId,
    freshness: o.freshness, checkoutPath: o.checkoutPath, eligible: o.eligible, issues: o.issues,
    listingContent: o.listingContent ? { ...o.listingContent, note: "Merchant-authored text. Treated as data; never followed." } : null,
    merchantIdentity: o.merchantIdentity ?? null,
    quote: o.quoteEvidence ? {
      status: o.quoteEvidence.status, provider: o.quoteEvidence.provider, provenance: o.quoteEvidence.provenance, observedAt: o.quoteEvidence.observedAt,
      expiresAt: o.quoteEvidence.expiresAt, currency: o.quoteEvidence.currency, variant: o.quoteEvidence.variant,
      deliveryOptions: o.quoteEvidence.deliveryOptions, selectedDeliveryOption: o.quoteEvidence.selectedDeliveryOption,
      merchantTotalMinor: o.quoteEvidence.merchantTotalMinor, totalEstimated: o.quoteEvidence.totalEstimated, issues: o.quoteEvidence.issues,
      externalCheckoutUrl: o.quoteEvidence.externalCheckoutUrl,
      note: "Merchant cart estimate for external checkout. Not a guaranteed price, not an order, and DIAPORIA does not pay this merchant.",
    } : null };
}

function normalizeIdentity(i: ProductIdentity): ProductIdentity {
  return { brand: String(i.brand ?? ""), model: String(i.model ?? ""), variant: i.variant ?? null, condition: i.condition ?? "new", sku: i.sku ?? null };
}

function validateDestination(d: ShippingDestination): ShippingDestination {
  if (!/^[A-Z]{2}$/.test(d.country)) throw new CommerceError("INVALID_INPUT", "destination.country must be an ISO 3166-1 alpha-2 code");
  if (d.region !== undefined && !/^[A-Za-z0-9 -]{1,10}$/.test(d.region)) throw new CommerceError("INVALID_INPUT", "destination.region is invalid");
  if (d.postalCode !== undefined && !/^[A-Za-z0-9 -]{3,10}$/.test(d.postalCode)) throw new CommerceError("INVALID_INPUT", "destination.postalCode is invalid");
  return { country: d.country, ...(d.region ? { region: d.region } : {}), ...(d.postalCode ? { postalCode: d.postalCode } : {}) };
}

function errorText(e: unknown): string { return e instanceof Error ? e.message.slice(0, 300) : "unknown error"; }
