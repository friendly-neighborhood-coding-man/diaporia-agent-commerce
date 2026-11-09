import { createHash, randomUUID } from "node:crypto";
import type { IntentMode, ProductIdentity, ShippingDestination } from "../domain/types.js";
import type { Currency } from "../domain/money.js";
import type { CostBreakdown, OfferComparison } from "../merchant/MerchantOfferVerifier.js";
import type { RoutedIntent } from "../intent/PurchaseIntentRouter.js";
import type { Row, Store } from "../store/Database.js";
import { assertTransition, type PurchaseState } from "./stateMachine.js";

export class StaleStateError extends Error {}
export class NotFoundError extends Error {}

export interface PurchaseSession {
  purchaseSessionId: string;
  userId: string;
  state: PurchaseState;
  version: number;
  mode: IntentMode;
  request: string;
  intent: RoutedIntent;
  lockedIdentity: ProductIdentity | null;
  productId: string | null;
  research: Record<string, unknown>;
  comparison: OfferComparison | null;
  destination: ShippingDestination | null;
  createdAt: number;
  expiresAt: number;
}

export interface PurchaseSummary {
  checkoutSessionId: string;
  productIdentity: ProductIdentity;
  merchant: { merchantId: string; name: string; domain: string; checkoutPath: string };
  offerId: string;
  quoteId: string;
  quantity: number;
  cost: CostBreakdown;
  totalMinor: number;
  currency: Currency;
  paymentProvider: string;
  disclosure: string;
}

export interface CheckoutSession {
  checkoutSessionId: string;
  userId: string;
  purchaseSessionId: string;
  offerId: string;
  merchantId: string;
  quoteId: string;
  identity: ProductIdentity;
  quantity: number;
  currency: Currency;
  cost: CostBreakdown;
  totalMinor: number;
  clientMaxMinor: number;
  summary: PurchaseSummary;
  summaryHash: string;
  state: PurchaseState;
  version: number;
  mandateId: string | null;
  reservedMinor: number;
  provider: string;
  providerOrderId: string | null;
  approvalUrl: string | null;
  captureId: string | null;
  captureStatus: string | null;
  createKey: string;
  captureKey: string;
  failureCode: string | null;
  failureReason: string | null;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
}

const PURCHASE_TTL_MS = 30 * 60_000;
const j = (v: unknown) => JSON.stringify(v);

/** Durable repository for purchase and checkout sessions. Every state write is a guarded CAS. */
export class CheckoutSessionManager {
  constructor(private readonly store: Store, private readonly now: () => number = Date.now) {}

  createPurchaseSession(userId: string, request: string, intent: RoutedIntent): PurchaseSession {
    const id = `ps_${randomUUID()}`;
    const now = this.now();
    this.store.db.prepare(`INSERT INTO purchase_sessions(id,user_id,state,mode,request_text,intent_json,research_json,created_at,updated_at,expires_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, userId, "CREATED", intent.mode, request.slice(0, 2000), j(intent), "{}", now, now, now + PURCHASE_TTL_MS);
    return this.getPurchaseSession(id, userId);
  }

  /** Scoped by user: another user's session is indistinguishable from a missing one. */
  getPurchaseSession(id: string, userId: string): PurchaseSession {
    const r = this.store.db.prepare("SELECT * FROM purchase_sessions WHERE id = ? AND user_id = ?").get(id, userId) as Row | undefined;
    if (!r) throw new NotFoundError("Purchase session not found");
    return {
      purchaseSessionId: String(r.id), userId: String(r.user_id), state: r.state as PurchaseState, version: Number(r.version),
      mode: r.mode as IntentMode, request: String(r.request_text), intent: JSON.parse(String(r.intent_json)),
      lockedIdentity: r.locked_identity_json ? JSON.parse(String(r.locked_identity_json)) : null, productId: r.product_id === null ? null : String(r.product_id),
      research: JSON.parse(String(r.research_json)), comparison: r.comparison_json ? JSON.parse(String(r.comparison_json)) : null,
      destination: r.destination_json ? JSON.parse(String(r.destination_json)) : null, createdAt: Number(r.created_at), expiresAt: Number(r.expires_at),
    };
  }

  updatePurchaseSession(ps: PurchaseSession, to: PurchaseState, patch: Partial<Pick<PurchaseSession, "lockedIdentity" | "productId" | "research" | "comparison" | "destination">>): PurchaseSession {
    assertTransition("purchase", ps.state, to);
    const next = { ...ps, ...patch };
    const r = this.store.db.prepare(`UPDATE purchase_sessions SET state=?, version=version+1, locked_identity_json=?, product_id=?, research_json=?,
      comparison_json=?, destination_json=?, updated_at=? WHERE id=? AND user_id=? AND state=? AND version=?`).run(
      to, next.lockedIdentity ? j(next.lockedIdentity) : null, next.productId, j(next.research), next.comparison ? j(next.comparison) : null,
      next.destination ? j(next.destination) : null, this.now(), ps.purchaseSessionId, ps.userId, ps.state, ps.version);
    if (r.changes !== 1) throw new StaleStateError("Purchase session changed concurrently; retry with fresh state");
    return this.getPurchaseSession(ps.purchaseSessionId, ps.userId);
  }

  createCheckout(input: Omit<CheckoutSession, "checkoutSessionId" | "summary" | "summaryHash" | "state" | "version" | "mandateId" | "reservedMinor" |
    "providerOrderId" | "approvalUrl" | "captureId" | "captureStatus" | "createKey" | "captureKey" | "failureCode" | "failureReason" | "createdAt" | "updatedAt"> & {
    merchantName: string; merchantDomain: string; checkoutPath: string; disclosure: string }): CheckoutSession {
    const id = `cs_${randomUUID()}`;
    const now = this.now();
    const summary: PurchaseSummary = Object.freeze({
      checkoutSessionId: id, productIdentity: input.identity,
      merchant: { merchantId: input.merchantId, name: input.merchantName, domain: input.merchantDomain, checkoutPath: input.checkoutPath },
      offerId: input.offerId, quoteId: input.quoteId, quantity: input.quantity, cost: input.cost, totalMinor: input.totalMinor,
      currency: input.currency, paymentProvider: input.provider, disclosure: input.disclosure,
    });
    const summaryHash = createHash("sha256").update(j(summary)).digest("hex");
    this.store.db.prepare(`INSERT INTO checkout_sessions(id,user_id,purchase_session_id,offer_id,merchant_id,quote_id,identity_json,quantity,currency,
      cost_json,total_minor,client_max_minor,summary_json,summary_hash,state,provider,create_key,capture_key,expires_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, input.userId, input.purchaseSessionId, input.offerId, input.merchantId, input.quoteId, j(input.identity), input.quantity, input.currency,
      j(input.cost), input.totalMinor, input.clientMaxMinor, j(summary), summaryHash, "PREPARED", input.provider,
      `dac-create-${randomUUID()}`, `dac-capture-${randomUUID()}`, input.expiresAt, now, now);
    return this.getCheckout(id, input.userId);
  }

  getCheckout(id: string, userId: string): CheckoutSession {
    const r = this.store.db.prepare("SELECT * FROM checkout_sessions WHERE id = ? AND user_id = ?").get(id, userId) as Row | undefined;
    if (!r) throw new NotFoundError("Checkout session not found");
    return this.toCheckout(r);
  }

  /** Lookup for the provider return URL, which carries no user credential: requires id AND provider order id. */
  getCheckoutForProviderReturn(id: string, providerOrderId: string): CheckoutSession {
    const r = this.store.db.prepare("SELECT * FROM checkout_sessions WHERE id = ? AND provider_order_id = ?").get(id, providerOrderId) as Row | undefined;
    if (!r) throw new NotFoundError("Checkout session not found");
    return this.toCheckout(r);
  }

  findActiveDuplicate(userId: string, purchaseSessionId: string, offerId: string, quantity: number): CheckoutSession | null {
    const r = this.store.db.prepare(`SELECT * FROM checkout_sessions WHERE user_id=? AND purchase_session_id=? AND offer_id=? AND quantity=?
      AND state NOT IN ('COMPLETED','CANCELLED','FAILED','EXPIRED') ORDER BY created_at DESC LIMIT 1`).get(userId, purchaseSessionId, offerId, quantity) as Row | undefined;
    return r ? this.toCheckout(r) : null;
  }

  /** Compare-and-set transition. Throws StaleStateError when another request moved the session first. */
  transition(cs: CheckoutSession, to: PurchaseState, patch: Partial<Pick<CheckoutSession, "mandateId" | "reservedMinor" | "providerOrderId" | "approvalUrl" |
    "captureId" | "captureStatus" | "failureCode" | "failureReason">> = {}): CheckoutSession {
    assertTransition("checkout", cs.state, to);
    const n = { ...cs, ...patch };
    const r = this.store.db.prepare(`UPDATE checkout_sessions SET state=?, version=version+1, mandate_id=?, reserved_minor=?, provider_order_id=?,
      approval_url=?, capture_id=?, capture_status=?, failure_code=?, failure_reason=?, updated_at=?
      WHERE id=? AND user_id=? AND state=? AND version=?`).run(
      to, n.mandateId, n.reservedMinor, n.providerOrderId, n.approvalUrl, n.captureId, n.captureStatus, n.failureCode, n.failureReason, this.now(),
      cs.checkoutSessionId, cs.userId, cs.state, cs.version);
    if (r.changes !== 1) throw new StaleStateError(`Checkout ${cs.checkoutSessionId} changed concurrently (expected ${cs.state} v${cs.version})`);
    return this.getCheckout(cs.checkoutSessionId, cs.userId);
  }

  private toCheckout(r: Row): CheckoutSession {
    return {
      checkoutSessionId: String(r.id), userId: String(r.user_id), purchaseSessionId: String(r.purchase_session_id), offerId: String(r.offer_id),
      merchantId: String(r.merchant_id), quoteId: String(r.quote_id), identity: JSON.parse(String(r.identity_json)), quantity: Number(r.quantity),
      currency: r.currency as Currency, cost: JSON.parse(String(r.cost_json)), totalMinor: Number(r.total_minor), clientMaxMinor: Number(r.client_max_minor),
      summary: JSON.parse(String(r.summary_json)), summaryHash: String(r.summary_hash), state: r.state as PurchaseState, version: Number(r.version),
      mandateId: r.mandate_id === null ? null : String(r.mandate_id), reservedMinor: Number(r.reserved_minor), provider: String(r.provider),
      providerOrderId: r.provider_order_id === null ? null : String(r.provider_order_id), approvalUrl: r.approval_url === null ? null : String(r.approval_url),
      captureId: r.capture_id === null ? null : String(r.capture_id), captureStatus: r.capture_status === null ? null : String(r.capture_status),
      createKey: String(r.create_key), captureKey: String(r.capture_key), failureCode: r.failure_code === null ? null : String(r.failure_code),
      failureReason: r.failure_reason === null ? null : String(r.failure_reason), expiresAt: Number(r.expires_at), createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
    };
  }
}
