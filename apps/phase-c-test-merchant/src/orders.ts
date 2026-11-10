import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PRODUCT, computeTotals, toValue, type Totals } from "./catalog.js";
import type { CheckoutMode } from "./config.js";
import { PayPalOutcomeUnknownError, PayPalRejectedError, type MerchantPayPal, type OrderView } from "./paypal.js";

/**
 * Merchant-side order states. Every state is backed by SERVER-SIDE evidence from PayPal Orders v2 (or the MOCK);
 * a browser callback can only ask the server to look, never set a state by itself.
 *
 *  NO_ORDER           cart exists, no PayPal order
 *  ORDER_CREATED      PayPal order created by this server and verified (amount, currency, payee, custom_id)
 *  BUYER_APPROVED     server GET shows the order APPROVED by the buyer; nothing captured
 *  CAPTURE_PENDING    capture exists with status PENDING (money NOT settled)
 *  PAYMENT_COMPLETED  capture COMPLETED (transient: immediately verified into ORDER_CONFIRMED or ORDER_UNKNOWN)
 *  ORDER_CONFIRMED    capture COMPLETED and verified against the locked cart and the configured seller
 *  PAYMENT_DENIED     capture DECLINED/FAILED, or PayPal refused it (e.g. INSTRUMENT_DECLINED)
 *  ORDER_CANCELLED    the buyer cancelled and the server confirmed the order was never approved
 *  ORDER_UNKNOWN      evidence missing or contradictory (timeout, payee/amount mismatch). Operator reconciles.
 *
 * Fulfillment is ALWAYS NOT_VERIFIED: no goods exist.
 */
export type MerchantOrderState =
  | "NO_ORDER" | "ORDER_CREATED" | "BUYER_APPROVED" | "CAPTURE_PENDING" | "PAYMENT_COMPLETED"
  | "ORDER_CONFIRMED" | "PAYMENT_DENIED" | "ORDER_CANCELLED" | "ORDER_UNKNOWN";

export const MERCHANT_TRANSITIONS: Readonly<Record<MerchantOrderState, readonly MerchantOrderState[]>> = {
  NO_ORDER: ["ORDER_CREATED", "ORDER_UNKNOWN"],
  ORDER_CREATED: ["BUYER_APPROVED", "ORDER_CANCELLED", "ORDER_UNKNOWN"],
  BUYER_APPROVED: ["CAPTURE_PENDING", "PAYMENT_COMPLETED", "PAYMENT_DENIED", "ORDER_UNKNOWN"],
  CAPTURE_PENDING: ["PAYMENT_COMPLETED", "PAYMENT_DENIED", "ORDER_UNKNOWN"],
  PAYMENT_COMPLETED: ["ORDER_CONFIRMED", "ORDER_UNKNOWN"],
  ORDER_CONFIRMED: [],
  PAYMENT_DENIED: [],
  ORDER_CANCELLED: [],
  // Only an operator reconciliation (server GET) leaves UNKNOWN, and only to a state the evidence supports.
  ORDER_UNKNOWN: ["ORDER_CREATED", "BUYER_APPROVED", "CAPTURE_PENDING", "PAYMENT_COMPLETED", "PAYMENT_DENIED", "ORDER_CANCELLED"],
};

export class MerchantError extends Error {
  constructor(readonly code: string, readonly httpStatus: number, message?: string) { super(message ?? code); }
}

export interface HistoryEntry { at: string; from: MerchantOrderState; to: MerchantOrderState; evidence: string; problem: string | null }

export interface Cart {
  cartRef: string;
  sessionId: string;
  csrf: string;
  sku: string; variant: string; quantity: number; unitMinor: number;
  totals: Totals;
  createdAt: number;
  state: MerchantOrderState;
  paypalOrderId: string | null;
  merchantOrderRef: string;
  captureId: string | null;
  payeeVerified: boolean;
  problem: string | null;
  history: HistoryEntry[];
}

interface Persisted { v: 1; carts: Cart[]; ordersCreated: Record<string, number>; capturesAttempted: Record<string, number> }

export interface CheckoutOptions {
  mode: CheckoutMode;
  paypal: MerchantPayPal;
  /** Seller merchant id every order must carry (MOCK uses a fixed fake id). */
  payeeMerchantId: string;
  /** Approval binding for Sandbox modes. */
  approval: { digest: string; expiresAtMs: number; maxSandboxOrders: number; maxCaptures: number } | null;
  dataDir: string | null;
  now?: () => number;
  /** MOCK-only test knobs for a drifting / hostile merchant. Refused outside MOCK. */
  mockKnobs?: {
    extraVariants?: string[];
    /** The cart silently holds this variant instead of the requested one. */
    substituteVariant?: string;
    displayQuantityOverride?: number | null;
    unitPriceDriftAfterCartMinor?: number;
    /** Behave like SANDBOX_POPUP_TEST: never capture, so an approved order stays BUYER_APPROVED. */
    neverCapture?: boolean;
  };
}

export const MOCK_SELLER_MERCHANT_ID = "MOCKSELLER01";
const CART_TTL_MS = 30 * 60_000;

export class MerchantCheckout {
  private readonly carts = new Map<string, Cart>();
  private readonly bySession = new Map<string, string>();
  private ordersCreated: Record<string, number> = {};
  private capturesAttempted: Record<string, number> = {};
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly now: () => number;
  readonly knobs: NonNullable<CheckoutOptions["mockKnobs"]>;

  constructor(private readonly o: CheckoutOptions) {
    this.now = o.now ?? Date.now;
    if (o.mode !== "MOCK" && o.mockKnobs && Object.keys(o.mockKnobs).length) throw new Error("mock knobs are refused outside MOCK mode");
    if (o.mode !== "MOCK" && o.paypal.kind !== "SANDBOX") throw new Error("Sandbox modes need the Sandbox client");
    if (o.mode === "MOCK" && o.paypal.kind !== "MOCK") throw new Error("MOCK mode must not hold a Sandbox client");
    if (o.mode !== "MOCK" && (!o.approval || !o.dataDir)) throw new Error("Sandbox modes need an approval binding and a data dir");
    this.knobs = o.mockKnobs ?? {};
    this.load();
  }

  get mode() { return this.o.mode; }
  get captureAllowed() { return (this.o.mode === "MOCK" && !this.knobs.neverCapture) || this.o.mode === "SANDBOX_APPROVAL_TEST"; }
  counters() {
    const k = this.o.approval?.digest ?? "MOCK";
    return { ordersCreated: this.ordersCreated[k] ?? 0, capturesAttempted: this.capturesAttempted[k] ?? 0,
      maxOrders: this.o.approval?.maxSandboxOrders ?? null, maxCaptures: this.o.approval?.maxCaptures ?? null };
  }

  // ------------------------------------------------------------------ persistence (Sandbox: survives restarts)
  private file(): string | null { return this.o.dataDir ? join(this.o.dataDir, "merchant-state.json") : null; }
  private load() {
    const f = this.file();
    if (!f || !existsSync(f)) return;
    const p = JSON.parse(readFileSync(f, "utf8")) as Persisted;
    if (p.v !== 1) throw new Error("unknown merchant state file version");
    for (const c of p.carts) { this.carts.set(c.cartRef, c); this.bySession.set(c.sessionId, c.cartRef); }
    this.ordersCreated = p.ordersCreated; this.capturesAttempted = p.capturesAttempted;
  }
  private save() {
    const f = this.file();
    if (!f) return;
    mkdirSync(this.o.dataDir!, { recursive: true, mode: 0o700 });
    const tmp = `${f}.${process.pid}.tmp`;
    const data: Persisted = { v: 1, carts: [...this.carts.values()], ordersCreated: this.ordersCreated, capturesAttempted: this.capturesAttempted };
    writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    renameSync(tmp, f);
    try { chmodSync(f, 0o600); } catch { /* best effort on non-POSIX */ }
  }

  /** Serializes every mutation of one cart: concurrent create/approve/cancel requests run one after another. */
  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(fn);
    this.locks.set(key, run.catch(() => undefined));
    return run;
  }

  private transition(c: Cart, to: MerchantOrderState, evidence: string, problem: string | null = null) {
    if (!MERCHANT_TRANSITIONS[c.state].includes(to)) throw new MerchantError("INVALID_TRANSITION", 409, `${c.state} -> ${to}`);
    c.history.push({ at: new Date(this.now()).toISOString(), from: c.state, to, evidence, problem });
    c.state = to; c.problem = problem;
    this.save();
  }

  // ------------------------------------------------------------------ cart
  newSessionId(): string { return randomBytes(18).toString("base64url"); }
  cartForSession(sessionId: string | null): Cart | null {
    if (!sessionId) return null;
    const ref = this.bySession.get(sessionId);
    const c = ref ? this.carts.get(ref) ?? null : null;
    if (c && c.state === "NO_ORDER" && this.now() - c.createdAt > CART_TTL_MS) return null;
    return c;
  }
  get(cartRef: string): Cart | null { return /^cart_[a-f0-9]{24}$/.test(cartRef) ? this.carts.get(cartRef) ?? null : null; }
  variants(): string[] { return [PRODUCT.variant, ...(this.knobs.extraVariants ?? [])]; }
  displayedQuantity(c: Cart): number { return this.knobs.displayQuantityOverride ?? c.quantity; }

  /** One cart per browser session. Once a PayPal order exists for it, the cart is locked against any change. */
  addToCart(sessionId: string, input: { variant: unknown; quantity: unknown }): Cart {
    const existing = this.cartForSession(sessionId);
    if (existing && existing.state !== "NO_ORDER") throw new MerchantError("CART_LOCKED", 409, "This cart already has a PayPal order and cannot change.");
    const requested = typeof input.variant === "string" ? input.variant : "";
    if (!this.variants().includes(requested)) throw new MerchantError("VARIANT_UNKNOWN", 400);
    const variant = this.knobs.substituteVariant ?? requested;
    const quantity = Number(input.quantity);
    if (quantity !== PRODUCT.quantity) throw new MerchantError("QUANTITY_LOCKED", 400, `Quantity is fixed at ${PRODUCT.quantity}.`);
    const sku = variant === PRODUCT.variant ? PRODUCT.sku : `LUM-Q3-${variant.slice(0, 1).toUpperCase()}`;
    const cart: Cart = {
      cartRef: existing?.cartRef ?? `cart_${randomBytes(12).toString("hex")}`, sessionId, csrf: randomBytes(18).toString("base64url"),
      sku, variant, quantity, unitMinor: PRODUCT.unitMinor, totals: computeTotals(PRODUCT.unitMinor, quantity), createdAt: this.now(),
      state: "NO_ORDER", paypalOrderId: null, merchantOrderRef: "", captureId: null, payeeVerified: false, problem: null, history: [],
    };
    cart.merchantOrderRef = `PHC-${cart.cartRef.slice(5, 17).toUpperCase()}`;
    this.carts.set(cart.cartRef, cart); this.bySession.set(sessionId, cart.cartRef);
    this.save();
    return cart;
  }

  private owned(cartRef: string, sessionId: string | null, csrf: unknown): Cart {
    const c = this.get(cartRef);
    if (!c || !sessionId || c.sessionId !== sessionId) throw new MerchantError("CART_NOT_FOUND", 404);
    if (typeof csrf !== "string" || csrf !== c.csrf) throw new MerchantError("CSRF_INVALID", 403);
    return c;
  }

  private verifyAgainstCart(c: Cart, v: OrderView): string | null {
    if (v.currency !== c.totals.currency) return "CURRENCY_MISMATCH";
    if (v.amountMinor !== c.totals.totalMinor) return "AMOUNT_MISMATCH";
    if (v.payeeMerchantId !== this.o.payeeMerchantId) return "PAYEE_MISMATCH";
    if (v.customId !== c.cartRef) return "CUSTOM_ID_MISMATCH";
    return null;
  }

  // ------------------------------------------------------------------ create (merchant server owns it)
  async createOrder(cartRef: string, sessionId: string | null, csrf: unknown): Promise<{ orderId: string; deduplicated: boolean }> {
    const c0 = this.owned(cartRef, sessionId, csrf);
    return this.withLock(c0.cartRef, async () => {
      const c = this.get(cartRef)!;
      if (c.paypalOrderId && c.state !== "ORDER_UNKNOWN") return { orderId: c.paypalOrderId, deduplicated: true };
      if (c.state !== "NO_ORDER") throw new MerchantError("ORDER_STATE_UNKNOWN", 409, "This cart's order outcome is unknown; the operator must reconcile.");
      if (this.now() - c.createdAt > CART_TTL_MS) throw new MerchantError("CART_EXPIRED", 409);
      // Price binding: the order total must equal the cart locked when it was displayed.
      const nowTotals = computeTotals(PRODUCT.unitMinor + (this.knobs.unitPriceDriftAfterCartMinor ?? 0), c.quantity);
      if (nowTotals.totalMinor !== c.totals.totalMinor) throw new MerchantError("PRICE_CHANGED", 409, "The price changed after this cart was shown. Add to cart again.");
      if (c.sku !== PRODUCT.sku || c.variant !== PRODUCT.variant || c.quantity !== PRODUCT.quantity) throw new MerchantError("CART_NOT_ORDERABLE", 409);
      const key = this.o.approval?.digest ?? "MOCK";
      if (this.o.approval) {
        if (this.now() >= this.o.approval.expiresAtMs) throw new MerchantError("APPROVAL_EXPIRED", 403, "The owner's approval window has ended.");
        if ((this.ordersCreated[key] ?? 0) >= this.o.approval.maxSandboxOrders) throw new MerchantError("ORDER_CAP_REACHED", 403, "The approved number of Sandbox orders is used up.");
      }
      // Reserve the slot BEFORE calling PayPal: an unknown outcome still consumes it.
      this.ordersCreated[key] = (this.ordersCreated[key] ?? 0) + 1;
      this.save();
      let v: OrderView;
      try { v = await this.o.paypal.createOrder(orderBody(c, this.o.payeeMerchantId), `phc-create-${c.cartRef}`); }
      catch (e) {
        if (e instanceof PayPalRejectedError) { this.transition(c, "ORDER_UNKNOWN", "PAYPAL_CREATE_REJECTED", `CREATE_REJECTED_${e.httpStatus}`); throw new MerchantError("ORDER_CREATE_REJECTED", 502); }
        this.transition(c, "ORDER_UNKNOWN", "PAYPAL_CREATE_NO_RESPONSE", "CREATE_OUTCOME_UNKNOWN");
        throw new MerchantError("ORDER_OUTCOME_UNKNOWN", 502, "PayPal did not answer; no retry is made automatically.");
      }
      c.paypalOrderId = v.id;
      const bad = this.verifyAgainstCart(c, v) ?? (v.status === "CREATED" || v.status === "PAYER_ACTION_REQUIRED" ? null : `UNEXPECTED_STATUS_${v.status}`);
      if (bad) { this.transition(c, "ORDER_UNKNOWN", "PAYPAL_CREATE_RESPONSE", bad); throw new MerchantError(bad, 502, "PayPal's order does not match this cart; it will not be shown to the buyer."); }
      c.payeeVerified = true;
      this.transition(c, "ORDER_CREATED", `${this.o.paypal.kind}_ORDERS_V2_CREATE`);
      return { orderId: v.id, deduplicated: false };
    });
  }

  // ------------------------------------------------------------------ approval callback (browser claim -> server GET)
  async onBuyerApproved(cartRef: string, sessionId: string | null, csrf: unknown, orderId: unknown): Promise<Cart> {
    const c0 = this.owned(cartRef, sessionId, csrf);
    return this.withLock(c0.cartRef, async () => {
      const c = this.get(cartRef)!;
      if (typeof orderId !== "string" || !c.paypalOrderId || orderId !== c.paypalOrderId) throw new MerchantError("ORDER_MISMATCH", 409, "This approval does not belong to this cart's order.");
      // Replay / duplicate callback: no new PayPal call and no second capture.
      if (c.state !== "ORDER_CREATED") return c;
      let v: OrderView;
      try { v = await this.o.paypal.getOrder(c.paypalOrderId); } catch { return c; /* stays ORDER_CREATED; nothing inferred */ }
      if (v.status === "CREATED" || v.status === "PAYER_ACTION_REQUIRED") return c; // browser said approved, PayPal says not
      const bad = this.verifyAgainstCart(c, v);
      if (bad) { this.transition(c, "ORDER_UNKNOWN", "PAYPAL_GET_AFTER_APPROVE", bad); return c; }
      if (v.status !== "APPROVED") { this.transition(c, "ORDER_UNKNOWN", "PAYPAL_GET_AFTER_APPROVE", `UNEXPECTED_STATUS_${v.status}`); return c; }
      this.transition(c, "BUYER_APPROVED", `${this.o.paypal.kind}_ORDERS_V2_GET`);
      if (this.captureAllowed) await this.capture(c);
      return c;
    });
  }

  private async capture(c: Cart): Promise<void> {
    const key = this.o.approval?.digest ?? "MOCK";
    if (this.o.approval) {
      if (this.now() >= this.o.approval.expiresAtMs) { c.problem = "APPROVAL_EXPIRED_BEFORE_CAPTURE"; this.save(); return; }
      if ((this.capturesAttempted[key] ?? 0) >= this.o.approval.maxCaptures) { c.problem = "CAPTURE_CAP_REACHED"; this.save(); return; }
    }
    this.capturesAttempted[key] = (this.capturesAttempted[key] ?? 0) + 1;
    this.save();
    let v: OrderView;
    try { v = await this.o.paypal.captureOrder(c.paypalOrderId!, `phc-capture-${c.paypalOrderId}`); }
    catch (e) {
      if (e instanceof PayPalRejectedError && e.issue === "INSTRUMENT_DECLINED") return this.transition(c, "PAYMENT_DENIED", "PAYPAL_CAPTURE_REJECTED", "INSTRUMENT_DECLINED");
      if (e instanceof PayPalRejectedError) return this.transition(c, "ORDER_UNKNOWN", "PAYPAL_CAPTURE_REJECTED", `CAPTURE_REJECTED_${e.issue ?? e.httpStatus}`);
      return this.transition(c, "ORDER_UNKNOWN", "PAYPAL_CAPTURE_NO_RESPONSE", e instanceof PayPalOutcomeUnknownError ? "CAPTURE_OUTCOME_UNKNOWN" : "CAPTURE_ERROR");
    }
    this.applyCaptureEvidence(c, v, `${this.o.paypal.kind}_ORDERS_V2_CAPTURE`);
  }

  private applyCaptureEvidence(c: Cart, v: OrderView, evidence: string) {
    const cap = v.captures[0];
    if (!cap) return this.transition(c, "ORDER_UNKNOWN", evidence, "NO_CAPTURE_IN_RESPONSE");
    c.captureId = cap.id || null;
    if (cap.status === "PENDING") return c.state === "CAPTURE_PENDING" ? undefined : this.transition(c, "CAPTURE_PENDING", evidence);
    if (cap.status === "DECLINED" || cap.status === "FAILED") return this.transition(c, "PAYMENT_DENIED", evidence, `CAPTURE_${cap.status}`);
    if (cap.status !== "COMPLETED") return this.transition(c, "ORDER_UNKNOWN", evidence, `CAPTURE_STATUS_${cap.status}`);
    this.transition(c, "PAYMENT_COMPLETED", evidence);
    const bad = this.verifyAgainstCart(c, v) ?? (cap.amountMinor !== c.totals.totalMinor || cap.currency !== c.totals.currency ? "CAPTURE_AMOUNT_MISMATCH" : null);
    if (bad) return this.transition(c, "ORDER_UNKNOWN", "MERCHANT_VERIFICATION", bad);
    this.transition(c, "ORDER_CONFIRMED", "MERCHANT_VERIFICATION");
  }

  // ------------------------------------------------------------------ cancel callback (browser claim -> server GET)
  async onBuyerCancelled(cartRef: string, sessionId: string | null, csrf: unknown, orderId: unknown): Promise<Cart> {
    const c0 = this.owned(cartRef, sessionId, csrf);
    return this.withLock(c0.cartRef, async () => {
      const c = this.get(cartRef)!;
      if (typeof orderId !== "string" || orderId !== c.paypalOrderId) throw new MerchantError("ORDER_MISMATCH", 409);
      if (c.state !== "ORDER_CREATED") return c;
      let v: OrderView;
      try { v = await this.o.paypal.getOrder(c.paypalOrderId); } catch { return c; }
      // Only an order PayPal still shows as un-approved may be abandoned. An approved order is never "cancelled" by a browser claim.
      if (v.status === "CREATED" || v.status === "PAYER_ACTION_REQUIRED") this.transition(c, "ORDER_CANCELLED", `${this.o.paypal.kind}_ORDERS_V2_GET`, "BUYER_CANCELLED");
      return c;
    });
  }

  // ------------------------------------------------------------------ operator reconciliation (read-first)
  /**
   * Re-reads the order from PayPal and moves to the state the evidence supports. A capture is re-sent ONLY when
   * `retryCapture` is set, the mode allows capture, and the GET just proved the order is APPROVED with no capture;
   * it reuses the same PayPal-Request-Id, so PayPal's idempotency also applies.
   */
  async reconcile(cartRef: string, opts: { retryCapture?: boolean } = {}): Promise<Cart> {
    const c0 = this.get(cartRef);
    if (!c0) throw new MerchantError("CART_NOT_FOUND", 404);
    return this.withLock(c0.cartRef, async () => {
      const c = this.get(cartRef)!;
      if (!c.paypalOrderId) return c;
      if (["ORDER_CONFIRMED", "PAYMENT_DENIED", "ORDER_CANCELLED"].includes(c.state)) return c;
      let v: OrderView;
      try { v = await this.o.paypal.getOrder(c.paypalOrderId); } catch { return c; }
      const ev = `${this.o.paypal.kind}_ORDERS_V2_GET_RECONCILE`;
      const bad = this.verifyAgainstCart(c, v);
      if (bad) { if (c.state !== "ORDER_UNKNOWN") this.transition(c, "ORDER_UNKNOWN", ev, bad); else { c.problem = bad; this.save(); } return c; }
      if (v.captures.length) {
        if (c.state === "ORDER_UNKNOWN" || c.state === "CAPTURE_PENDING" || c.state === "BUYER_APPROVED") this.applyCaptureEvidence(c, v, ev);
        return c;
      }
      if (v.status === "APPROVED") {
        if (c.state === "ORDER_UNKNOWN" || c.state === "ORDER_CREATED") this.transition(c, "BUYER_APPROVED", ev);
        if (opts.retryCapture && this.captureAllowed && c.state === "BUYER_APPROVED") {
          const key = this.o.approval?.digest ?? "MOCK";
          // The capture slot was already consumed by the lost attempt; the retry reuses it (same request id).
          if ((this.capturesAttempted[key] ?? 0) > 0) this.capturesAttempted[key]! -= 1;
          await this.capture(c);
        }
        return c;
      }
      if ((v.status === "CREATED" || v.status === "PAYER_ACTION_REQUIRED") && c.state === "ORDER_UNKNOWN") this.transition(c, "ORDER_CREATED", ev);
      else if (v.status === "VOIDED") {
        if (c.state === "ORDER_UNKNOWN" || c.state === "ORDER_CREATED") this.transition(c, "ORDER_CANCELLED", ev, "ORDER_VOIDED");
        else this.transition(c, "ORDER_UNKNOWN", ev, "ORDER_VOIDED_AFTER_APPROVAL");
      }
      return c;
    });
  }

  // ------------------------------------------------------------------ status (non-sensitive)
  publicStatus(cartRef: string) {
    const c = this.get(cartRef);
    const base = { cartRef, mode: this.o.mode, evidenceSource: this.o.paypal.kind === "MOCK" ? "MOCK_PAYPAL_IN_PROCESS" : "PAYPAL_SANDBOX_ORDERS_V2_SERVER_SIDE",
      fulfillment: "NOT_VERIFIED" as const, sandboxOnly: true as const };
    if (!c) return { ...base, state: "NO_ORDER" as MerchantOrderState, known: false, orderRef: null, paypalOrderIdSuffix: null, sku: null, variant: null, quantity: null,
      currency: null, totalMinor: null, payeeVerified: false, problem: "CART_UNKNOWN", updatedAt: null };
    return { ...base, state: c.state, known: true, orderRef: c.paypalOrderId ? c.merchantOrderRef : null, paypalOrderIdSuffix: c.paypalOrderId ? c.paypalOrderId.slice(-4) : null,
      sku: c.sku, variant: c.variant, quantity: c.quantity, currency: c.totals.currency, totalMinor: c.totals.totalMinor, payeeVerified: c.payeeVerified,
      problem: c.problem, updatedAt: c.history.at(-1)?.at ?? new Date(c.createdAt).toISOString() };
  }
  history(cartRef: string): HistoryEntry[] { return this.get(cartRef)?.history ?? []; }
}

/** Orders v2 body built ONLY from the server-side cart. Intent CAPTURE; the browser contributes nothing but the cart ref. */
export function orderBody(c: Cart, payeeMerchantId: string): Record<string, unknown> {
  const t = c.totals;
  return {
    intent: "CAPTURE",
    purchase_units: [{
      reference_id: c.cartRef, custom_id: c.cartRef, invoice_id: c.merchantOrderRef,
      description: "DIAPORIA Phase C Sandbox test order (fictional item, no shipment)",
      payee: { merchant_id: payeeMerchantId },
      amount: { currency_code: t.currency, value: toValue(t.totalMinor), breakdown: {
        item_total: { currency_code: t.currency, value: toValue(t.subtotalMinor) },
        shipping: { currency_code: t.currency, value: toValue(t.shippingMinor) },
        tax_total: { currency_code: t.currency, value: toValue(t.taxMinor) } } },
      items: [{ name: PRODUCT.title, sku: c.sku, quantity: String(c.quantity), unit_amount: { currency_code: t.currency, value: toValue(c.unitMinor) } }],
    }],
  };
}
