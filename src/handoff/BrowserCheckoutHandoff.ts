import { randomUUID } from "node:crypto";
import type { CommerceGateway } from "../engine/CommerceGateway.js";
import { CommerceError } from "../engine/errors.js";
import { NotFoundError } from "../checkout/CheckoutSessionManager.js";
import type { Store } from "../store/Database.js";
import type { ProductIdentity } from "../domain/types.js";
import { isCurrency, isMinor, type Currency } from "../domain/money.js";
import { HANDOFF_TERMINAL, PRE_TAKEOVER, assertHandoffTransition, type HandoffState } from "./states.js";
import type { BrowserDriver, BrowserSession, HumanView } from "./drivers.js";
import {
  buildObserveScript, buildPrepareScript, parseDisplayedMoney, parseDisplayedQuantity,
  type MerchantCheckoutRecipe, type MerchantRecipeRegistry, type ObservationResult, type PrepareScriptRefusal, type PrepareScriptResult, type RawCartRead,
} from "./recipes.js";
import type { SellerOrderStatus, SellerSourceRegistry } from "./sellerConfirmation.js";

/**
 * BrowserCheckoutHandoff — a separate checkout path alongside the direct PayPal Sandbox checkout.
 *
 * DIAPORIA prepares a cart on an AUTHORIZED merchant's own website (a merchant with a DIAPORIA recipe), captures
 * what the merchant displays, applies purchase constraints, stops before any payment control, and hands the SAME
 * browser session to the human through an owner-authenticated, short-lived page. The human uses the merchant's
 * own PayPal button. Afterwards DIAPORIA only observes (read-only) and asks an authenticated seller-side source.
 *
 * This module has no access to any payment provider: it cannot create, approve, capture or refund a PayPal order.
 */
export interface HandoffConfig {
  baseUrl: string;
  /** Same rule as payment execution: dev auth on loopback only. */
  enabled: boolean;
  driver: BrowserDriver;
  recipes: MerchantRecipeRegistry;
  sellers: SellerSourceRegistry;
  /** Time a prepared cart waits for the human to take over. Default 15 min. */
  handoffTtlMs?: number;
  /** Time the human has once they took over; then a read-only observation ends the takeover. Default 20 min. */
  takeoverTtlMs?: number;
}

export interface CartSnapshot {
  merchantHost: string;
  title: string | null; variant: string | null; condition: string | null;
  quantity: number | null; currency: Currency;
  displayedCurrency: string | null;
  subtotalMinor: number | null; shippingMinor: number | null; taxMinor: number | null; totalMinor: number | null;
  cartRef: string | null;
  capturedAt: string;
  provenance: "MERCHANT_PAGE_AS_DISPLAYED";
}

export type ConstraintViolation =
  | "MERCHANT_HOST_MISMATCH" | "PRODUCT_MISMATCH" | "PRODUCT_UNKNOWN" | "VARIANT_MISMATCH" | "CONDITION_MISMATCH" | "CONDITION_UNRECOGNIZED"
  | "QUANTITY_MISMATCH" | "QUANTITY_UNKNOWN" | "CURRENCY_MISMATCH" | "TOTAL_UNKNOWN" | "TOTAL_INCONSISTENT" | "AMOUNT_EXCEEDED";

export interface ConstraintResult {
  violations: ConstraintViolation[];
  unknowns: string[];
  effectiveMaximumMinor: number | null;
  maximumSources: Array<{ source: "CLIENT_REQUEST" | "RESEARCH_BUDGET" | "OWNER_MANDATE" | "OWNER_HANDOFF_PAGE"; maximumMinor: number }>;
}

export interface Handoff {
  handoffId: string; userId: string; purchaseSessionId: string; offerId: string;
  merchantDomain: string; merchantName: string; recipeId: string; identity: ProductIdentity;
  quantity: number; currency: Currency; clientMaxMinor: number; ownerMaxMinor: number | null;
  state: HandoffState; version: number; snapshot: CartSnapshot | null; constraints: ConstraintResult | null;
  observation: ObservationSummary | null; seller: SellerOrderStatus | null; driver: string;
  failureCode: string | null; failureReason: string | null;
  expiresAt: number; takeoverDeadline: number | null; createdAt: number; updatedAt: number;
}

export interface ObservationSummary {
  observedAt: string;
  reason: "HUMAN_FINISHED" | "TAKEOVER_TIMEOUT" | "BROWSER_SESSION_LOST";
  pages: Array<{ host: string; path: string; title: string }>;
  /** A merchant page SAYS an order is confirmed. Untrusted: never sufficient for ORDER_CONFIRMED. */
  pageClaimsConfirmation: boolean;
  confirmationText: string | null;
  discrepancies: string[];
}

const ALLOWED_OFFER_ISSUES = new Set(["TOTAL_UNKNOWN", "NO_MERCHANT_QUOTE", "QUOTE_IS_ESTIMATE", "LISTING_PRICE_ONLY", "MERCHANT_IDENTITY_UNKNOWN", "QUOTE_STALE"]);
const CONDITION_WORDS: Array<[RegExp, ProductIdentity["condition"]]> = [
  [/^(brand\s+)?new$/i, "new"], [/^(refurbished|renewed|certified\s+refurbished|reconditioned)$/i, "refurbished"],
  [/^(used|pre-?owned|second-?hand)$/i, "used"], [/^open[\s-]?box$/i, "open_box"],
];
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Pure constraint evaluation over what the merchant displayed. Exported for tests. */
export function evaluateConstraints(s: CartSnapshot, expected: { identity: ProductIdentity; quantity: number; currency: Currency; merchantHost: string },
  caps: ConstraintResult["maximumSources"]): ConstraintResult {
  const v: ConstraintViolation[] = []; const unknowns: string[] = [];
  if (s.merchantHost !== expected.merchantHost) v.push("MERCHANT_HOST_MISMATCH");
  if (!s.title) v.push("PRODUCT_UNKNOWN");
  else if (!squash(s.title).includes(squash(expected.identity.model)) || !squash(s.title).includes(squash(expected.identity.brand))) v.push("PRODUCT_MISMATCH");
  if (expected.identity.variant) {
    if (!s.variant) unknowns.push("variant");
    else if (squash(s.variant) !== squash(expected.identity.variant)) v.push("VARIANT_MISMATCH");
  }
  if (!s.condition) unknowns.push("condition");
  else {
    const c = CONDITION_WORDS.find(([re]) => re.test(s.condition!.trim()))?.[1];
    if (!c) v.push("CONDITION_UNRECOGNIZED"); else if (c !== expected.identity.condition) v.push("CONDITION_MISMATCH");
  }
  if (s.quantity === null) v.push("QUANTITY_UNKNOWN"); else if (s.quantity !== expected.quantity) v.push("QUANTITY_MISMATCH");
  if (!s.displayedCurrency) unknowns.push("currency_label");
  else if (s.displayedCurrency.trim().toUpperCase() !== expected.currency) v.push("CURRENCY_MISMATCH");
  if (s.subtotalMinor === null) unknowns.push("subtotal");
  if (s.shippingMinor === null) unknowns.push("shipping");
  if (s.taxMinor === null) unknowns.push("tax");
  if (s.cartRef === null) unknowns.push("merchant_cart_reference");
  if (s.totalMinor === null) v.push("TOTAL_UNKNOWN");
  else if (s.subtotalMinor !== null && s.shippingMinor !== null && s.taxMinor !== null && s.subtotalMinor + s.shippingMinor + s.taxMinor !== s.totalMinor) v.push("TOTAL_INCONSISTENT");
  const effective = caps.length ? Math.min(...caps.map((c) => c.maximumMinor)) : null;
  if (s.totalMinor !== null && effective !== null && s.totalMinor > effective) v.push("AMOUNT_EXCEEDED");
  return { violations: v, unknowns, effectiveMaximumMinor: effective, maximumSources: caps };
}

export function snapshotFromRaw(raw: RawCartRead, currency: Currency, capturedAt: number): CartSnapshot {
  return {
    merchantHost: raw.finalHost, title: raw.title, variant: raw.variant, condition: raw.condition,
    quantity: parseDisplayedQuantity(raw.quantity), currency, displayedCurrency: raw.currency,
    subtotalMinor: parseDisplayedMoney(raw.subtotal, currency), shippingMinor: parseDisplayedMoney(raw.shipping, currency),
    taxMinor: parseDisplayedMoney(raw.tax, currency), totalMinor: parseDisplayedMoney(raw.total, currency),
    cartRef: raw.cartRef && /^[A-Za-z0-9_-]{6,80}$/.test(raw.cartRef) ? raw.cartRef : null,
    capturedAt: new Date(capturedAt).toISOString(), provenance: "MERCHANT_PAGE_AS_DISPLAYED",
  };
}

const TABLE = `CREATE TABLE IF NOT EXISTS browser_handoffs (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, purchase_session_id TEXT NOT NULL, offer_id TEXT NOT NULL,
  merchant_domain TEXT NOT NULL, merchant_name TEXT NOT NULL, recipe_id TEXT NOT NULL, identity_json TEXT NOT NULL,
  quantity INTEGER NOT NULL, currency TEXT NOT NULL, client_max_minor INTEGER NOT NULL, owner_max_minor INTEGER,
  state TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0, snapshot_json TEXT, constraints_json TEXT,
  observation_json TEXT, seller_json TEXT, driver TEXT NOT NULL, failure_code TEXT, failure_reason TEXT,
  expires_at INTEGER NOT NULL, takeover_deadline INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS handoff_by_user ON browser_handoffs(user_id, purchase_session_id, offer_id);`;

type Row = Record<string, string | number | null>;
const j = <T>(v: string | number | null | undefined): T | null => (typeof v === "string" ? (JSON.parse(v) as T) : null);

export class BrowserCheckoutHandoff {
  private readonly sessions = new Map<string, BrowserSession>();
  private readonly ttl: number;
  private readonly takeoverTtl: number;
  private ticking = false;

  constructor(private readonly store: Store, private readonly gateway: CommerceGateway, readonly cfg: HandoffConfig, private readonly now: () => number = Date.now) {
    this.store.db.exec(TABLE);
    this.ttl = cfg.handoffTtlMs ?? 15 * 60_000;
    this.takeoverTtl = cfg.takeoverTtlMs ?? 20 * 60_000;
  }

  // ------------------------------------------------------------------ persistence
  private toHandoff(r: Row): Handoff {
    return {
      handoffId: String(r.id), userId: String(r.user_id), purchaseSessionId: String(r.purchase_session_id), offerId: String(r.offer_id),
      merchantDomain: String(r.merchant_domain), merchantName: String(r.merchant_name), recipeId: String(r.recipe_id), identity: j<ProductIdentity>(r.identity_json)!,
      quantity: Number(r.quantity), currency: String(r.currency) as Currency, clientMaxMinor: Number(r.client_max_minor),
      ownerMaxMinor: r.owner_max_minor === null ? null : Number(r.owner_max_minor), state: String(r.state) as HandoffState, version: Number(r.version),
      snapshot: j(r.snapshot_json), constraints: j(r.constraints_json), observation: j(r.observation_json), seller: j(r.seller_json), driver: String(r.driver),
      failureCode: (r.failure_code as string | null) ?? null, failureReason: (r.failure_reason as string | null) ?? null,
      expiresAt: Number(r.expires_at), takeoverDeadline: r.takeover_deadline === null ? null : Number(r.takeover_deadline),
      createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
    };
  }

  get(handoffId: string, userId: string): Handoff {
    if (!/^ho_[0-9a-f-]{36}$/.test(handoffId)) throw new CommerceError("NOT_FOUND", "Handoff not found");
    const r = this.store.db.prepare("SELECT * FROM browser_handoffs WHERE id = ? AND user_id = ?").get(handoffId, userId) as Row | undefined;
    if (!r) throw new CommerceError("NOT_FOUND", "Handoff not found");
    return this.toHandoff(r);
  }

  private transition(h: Handoff, to: HandoffState, patch: Partial<Pick<Handoff, "snapshot" | "constraints" | "observation" | "seller" | "failureCode" | "failureReason" | "ownerMaxMinor" | "takeoverDeadline">> = {}): Handoff {
    assertHandoffTransition(h.state, to);
    const next = { ...h, ...patch };
    const r = this.store.db.prepare(`UPDATE browser_handoffs SET state = ?, version = version + 1, snapshot_json = ?, constraints_json = ?, observation_json = ?,
      seller_json = ?, failure_code = ?, failure_reason = ?, owner_max_minor = ?, takeover_deadline = ?, updated_at = ? WHERE id = ? AND version = ?`).run(
      to, next.snapshot ? JSON.stringify(next.snapshot) : null, next.constraints ? JSON.stringify(next.constraints) : null,
      next.observation ? JSON.stringify(next.observation) : null, next.seller ? JSON.stringify(next.seller) : null,
      next.failureCode, next.failureReason, next.ownerMaxMinor, next.takeoverDeadline, this.now(), h.handoffId, h.version);
    if (r.changes !== 1) throw new CommerceError("STALE_STATE", "Handoff changed concurrently; read its status again.");
    this.gateway.audit.append(h.handoffId, h.userId, `HANDOFF_${to}`, { from: h.state, failureCode: next.failureCode ?? null });
    return this.get(h.handoffId, h.userId);
  }

  private async closeSession(handoffId: string): Promise<void> {
    const s = this.sessions.get(handoffId);
    if (!s) return;
    try {
      await s.close();
      this.sessions.delete(handoffId);
    } catch {
      // Remote DELETE failure must never be silently considered cleanup.
      const owner = this.store.db.prepare("SELECT user_id FROM browser_handoffs WHERE id=?")
        .get(handoffId) as { user_id: string } | undefined;
      if (owner) this.gateway.audit.append(handoffId, owner.user_id,
        "HANDOFF_CLEANUP_UNVERIFIED", { browserProvider: s.provider });
      // Keep the session so a later tick, finish, or shutdown can retry.
      throw new CommerceError("PROVIDER_ERROR", "Browser cleanup not verified; retry or investigate the KERNEL session");
    }
  }

  // ------------------------------------------------------------------ prepare (AI-initiated, PREPARE scope)
  async prepare(userId: string, input: { purchaseSessionId: string; offerId: string; quantity: number; maximumApprovedTotalMinor: number; currency: string }) {
    if (!this.cfg.enabled) throw new CommerceError("PAYMENT_DISABLED", "Browser checkout handoff is disabled on this deployment (no production user authentication).");
    if (!isMinor(input.maximumApprovedTotalMinor) || input.maximumApprovedTotalMinor <= 0) throw new CommerceError("INVALID_INPUT", "maximumApprovedTotalMinor must be a positive integer of minor units");
    if (!Number.isSafeInteger(input.quantity) || input.quantity < 1 || input.quantity > 5) throw new CommerceError("INVALID_INPUT", "quantity must be an integer 1..5");
    let ps;
    try { ps = this.gateway.sessions.getPurchaseSession(input.purchaseSessionId, userId); }
    catch (e) { if (e instanceof NotFoundError) throw new CommerceError("NOT_FOUND", "Purchase session not found"); throw e; }
    if (ps.expiresAt <= this.now()) throw new CommerceError("SESSION_EXPIRED", "Purchase session expired; research again.");
    if (!ps.comparison || !ps.lockedIdentity) throw new CommerceError("INVALID_STATE", "Compare offers for an exact product first.");
    // V2.1: the research decision binds every payment-preparing path, not only prepare_checkout.
    this.gateway.assertServiceIsolated(ps.purchaseSessionId, userId, "prepare_browser_checkout");
    const readiness = this.gateway.assertPurchaseReady(ps, userId, "prepare_browser_checkout");
    if (!isCurrency(input.currency) || input.currency !== ps.intent.currency) throw new CommerceError("INVALID_INPUT", `Currency must be the session currency ${ps.intent.currency}`);
    const offer = [...ps.comparison.eligible, ...ps.comparison.ineligible].find((o) => o.offerId === input.offerId);
    if (!offer) throw new CommerceError("NOT_FOUND", "Offer is not part of this session's comparison.");
    if (offer.checkoutPath !== "EXTERNAL_MERCHANT_CHECKOUT") throw new CommerceError("HANDOFF_NOT_SUPPORTED", "Browser handoff is only for external merchant checkouts; use prepare_checkout for the DIAPORIA Sandbox demo merchant.");
    if (!offer.identityMatch) throw new CommerceError("IDENTITY_MISMATCH", "Offer lists a different product, variant or condition. DIAPORIA never substitutes.");
    const blocking = offer.issues.filter((i) => !ALLOWED_OFFER_ISSUES.has(i));
    if (blocking.length) throw new CommerceError("OFFER_NOT_ELIGIBLE", "Offer failed verification for browser handoff.", { issues: blocking });
    const recipe = this.cfg.recipes.get(offer.merchantDomain);
    if (!recipe) throw new CommerceError("HANDOFF_NOT_SUPPORTED", `Merchant ${offer.merchantDomain} is not an authorized browser-handoff merchant (no DIAPORIA recipe).`);

    const existing = this.store.db.prepare(`SELECT * FROM browser_handoffs WHERE user_id = ? AND purchase_session_id = ? AND offer_id = ? AND state NOT IN ('CANCELLED','EXPIRED','ORDER_CONFIRMED','ORDER_UNVERIFIED') ORDER BY created_at DESC LIMIT 1`)
      .get(userId, ps.purchaseSessionId, offer.offerId) as Row | undefined;
    if (existing) {
      const h = this.toHandoff(existing);
      if (h.quantity === input.quantity) return { ...this.publicStatus(h), deduplicated: true };
      throw new CommerceError("INVALID_STATE", `A browser handoff for this offer is ${h.state}; finish or cancel it first.`, { handoffId: h.handoffId });
    }

    const id = `ho_${randomUUID()}`;
    const t = this.now();
    this.store.db.prepare(`INSERT INTO browser_handoffs (id,user_id,purchase_session_id,offer_id,merchant_domain,merchant_name,recipe_id,identity_json,quantity,currency,
      client_max_minor,state,driver,expires_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, userId, ps.purchaseSessionId, offer.offerId, offer.merchantDomain, offer.merchantName, recipe.recipeId, JSON.stringify(ps.lockedIdentity),
      input.quantity, input.currency, input.maximumApprovedTotalMinor, "CHECKOUT_PREPARING", this.cfg.driver.name, t + this.ttl, t, t);
    this.gateway.audit.append(id, userId, "HANDOFF_CREATED", { purchaseSessionId: ps.purchaseSessionId, offerId: offer.offerId, merchantDomain: offer.merchantDomain, driver: this.cfg.driver.name });
    let h = this.get(id, userId);

    let session: BrowserSession;
    try {
      session = await this.cfg.driver.open({ label: `diaporia-${id.slice(3, 15)}`, merchantHost: new URL(recipe.origin).host,
        allowedHosts: recipe.networkAllowedHosts ?? null, timeoutSeconds: Math.ceil((this.ttl + this.takeoverTtl) / 1000) + 120 });
    } catch (e) {
      h = this.transition(h, "HOLD", { failureCode: "BROWSER_UNAVAILABLE", failureReason: errText(e) });
      return this.publicStatus(h);
    }
    this.sessions.set(id, session);

    let out: PrepareScriptResult | PrepareScriptRefusal;
    try { out = await session.run<PrepareScriptResult | PrepareScriptRefusal>(buildPrepareScript(recipe, { offerId: offer.offerId, variant: ps.lockedIdentity.variant, quantity: input.quantity }), { timeoutSec: 90 }); }
    catch (e) { out = { ok: false, refused: "PREPARATION_FAILED", detail: errText(e) }; }
    if (!out.ok) {
      await this.closeSession(id);
      h = this.transition(h, "HOLD", { failureCode: out.refused, failureReason: out.detail ?? null });
      return this.publicStatus(h);
    }
    this.gateway.audit.append(id, userId, "HANDOFF_CART_PREPARED", { popupsClosed: out.popupsClosed, navigationsBlocked: out.navigationsBlocked });

    const snapshot = snapshotFromRaw(out.cart, h.currency, this.now());
    const caps: ConstraintResult["maximumSources"] = [{ source: "CLIENT_REQUEST", maximumMinor: input.maximumApprovedTotalMinor }];
    // V2.2 WP-1: the same effective budget as prepare_checkout (the stated maximum, or the owner-confirmed budget).
    const researchMax = readiness.effectiveBudgetMinor ?? ps.intent.budgetMinor;
    if (researchMax !== null) caps.push({ source: "RESEARCH_BUDGET", maximumMinor: researchMax });
    const mandate = this.gateway.policy.findApplicable(userId, ps.lockedIdentity);
    if (mandate && mandate.authorizationStatus === "ACTIVE" && mandate.currency === h.currency) caps.push({ source: "OWNER_MANDATE", maximumMinor: mandate.maximumTotalMinor });
    const constraints = evaluateConstraints(snapshot, { identity: ps.lockedIdentity, quantity: input.quantity, currency: h.currency, merchantHost: new URL(recipe.origin).host }, caps);
    if (constraints.violations.length) {
      // Only an amount problem can be fixed by the owner; anything else means the cart is not the authorized purchase.
      const recoverable = constraints.violations.every((x) => x === "AMOUNT_EXCEEDED");
      if (!recoverable) await this.closeSession(id);
      h = this.transition(h, "HOLD", { snapshot, constraints, failureCode: constraints.violations[0]!, failureReason: recoverable ? "Displayed total exceeds the authorized maximum." : "The merchant cart is not the authorized purchase. No handoff is offered." });
      return this.publicStatus(h);
    }
    h = this.transition(h, "CHECKOUT_READY", { snapshot, constraints });
    h = this.transition(h, "HUMAN_ACTION_REQUIRED");
    return this.publicStatus(h);
  }

  // ------------------------------------------------------------------ human-side (owner-authenticated handoff page)
  /** Re-evaluates with the owner's own maximum. Never makes a cart with non-amount violations acceptable. */
  setOwnerMaximum(userId: string, handoffId: string, ownerMaxMinor: number): Handoff {
    let h = this.get(handoffId, userId);
    if (!["HUMAN_ACTION_REQUIRED", "HOLD"].includes(h.state) || !h.snapshot || !h.constraints) throw new CommerceError("INVALID_STATE", `Handoff is ${h.state}`);
    if (!isMinor(ownerMaxMinor) || ownerMaxMinor <= 0) throw new CommerceError("INVALID_INPUT", "Maximum must be a positive amount");
    if (!this.sessions.has(handoffId)) throw new CommerceError("INVALID_STATE", "The prepared browser is no longer available; prepare again.");
    const caps = h.constraints.maximumSources.filter((c) => c.source !== "OWNER_HANDOFF_PAGE").concat({ source: "OWNER_HANDOFF_PAGE", maximumMinor: ownerMaxMinor });
    const constraints = evaluateConstraints(h.snapshot, { identity: h.identity, quantity: h.quantity, currency: h.currency, merchantHost: h.snapshot.merchantHost }, caps);
    // merchantHost was already checked at preparation time; the snapshot host is reused here on purpose.
    if (constraints.violations.length) return this.transition(h, "HOLD", { constraints, ownerMaxMinor, failureCode: constraints.violations[0]!, failureReason: "Displayed total exceeds the effective maximum (the lowest of your limit, the assistant's requested limit and any budget)." });
    h = this.transition(h, "HUMAN_ACTION_REQUIRED", { constraints, ownerMaxMinor, failureCode: null, failureReason: null });
    return h;
  }

  /**
   * The human takes over. Requires an owner-entered maximum (fresh human authority for this handoff). Automation is
   * paused BEFORE the human view is released; the view is returned only to the authenticated handoff page.
   */
  async takeover(userId: string, handoffId: string): Promise<{ handoff: Handoff; view: HumanView }> {
    let h = this.get(handoffId, userId);
    if (h.state !== "HUMAN_ACTION_REQUIRED") throw new CommerceError("INVALID_STATE", `Handoff is ${h.state}`);
    if (h.ownerMaxMinor === null) throw new CommerceError("INVALID_STATE", "Set your maximum on the handoff page first.");
    if (h.expiresAt <= this.now()) { await this.tick(); throw new CommerceError("SESSION_EXPIRED", "The prepared cart expired."); }
    const s = this.sessions.get(handoffId);
    if (!s || s.phase === "CLOSED") throw new CommerceError("INVALID_STATE", "The prepared browser is no longer available; prepare again.");
    s.pauseForHuman();
    h = this.transition(h, "HANDOFF_OPENED", { takeoverDeadline: this.now() + this.takeoverTtl });
    this.gateway.audit.append(h.handoffId, userId, "AUTOMATION_PAUSED_FOR_HUMAN", { provider: s.provider });
    return { handoff: h, view: s.humanView() };
  }

  /** Human view for an ALREADY opened handoff (page reload). Same owner authentication required by the caller. */
  viewFor(userId: string, handoffId: string): HumanView | null {
    const h = this.get(handoffId, userId);
    if (h.state !== "HANDOFF_OPENED") return null;
    const session = this.sessions.get(handoffId);
    return session && session.phase !== "CLOSED" ? session.humanView() : null;
  }

  /** TEST/DEMO hook: the local fixture session (so a simulated human can operate it). */
  fixtureSession(handoffId: string): BrowserSession | null { return this.sessions.get(handoffId) ?? null; }

  async cancel(userId: string, handoffId: string): Promise<Handoff> {
    const h = this.get(handoffId, userId);
    if (!PRE_TAKEOVER.has(h.state)) throw new CommerceError("INVALID_STATE", h.state === "HANDOFF_OPENED"
      ? "You already took over the browser; finish the handoff so DIAPORIA can observe the outcome instead of assuming nothing happened."
      : `Handoff is ${h.state}`);
    await this.closeSession(handoffId);
    return this.transition(h, "CANCELLED", { failureCode: "CANCELLED_BY_OWNER", failureReason: null });
  }

  /** Ends the takeover: read-only observation, then the authoritative seller-side check, then the browser is destroyed. */
  async finish(userId: string, handoffId: string, reason: ObservationSummary["reason"] = "HUMAN_FINISHED"): Promise<Handoff> {
    let h = this.get(handoffId, userId);
    if (h.state !== "HANDOFF_OPENED") throw new CommerceError("INVALID_STATE", `Handoff is ${h.state}`);
    const s = this.sessions.get(handoffId);
    let obs: ObservationResult | null = null;
    if (s) {
      s.beginObservation();
      const recipe = this.cfg.recipes.get(h.merchantDomain);
      if (recipe) obs = await s.run<ObservationResult>(buildObserveScript(recipe), { timeoutSec: 30 }).catch(() => null);
    }
    await this.closeSession(handoffId);
    const confirmationPage = obs?.pages.find((p) => p.confirmationText) ?? null;
    const observation: ObservationSummary = {
      observedAt: new Date(this.now()).toISOString(), reason: s ? reason : "BROWSER_SESSION_LOST",
      pages: (obs?.pages ?? []).map((p) => ({ host: p.host, path: p.path, title: p.title })),
      pageClaimsConfirmation: !!confirmationPage, confirmationText: confirmationPage?.confirmationText ?? null, discrepancies: [],
    };
    h = this.transition(h, "RETURN_OBSERVED", { observation });
    return this.settleFromSeller(h);
  }

  private async settleFromSeller(h: Handoff): Promise<Handoff> {
    const src = this.cfg.sellers.get(h.merchantDomain);
    const seller = src && h.snapshot?.cartRef ? await src.lookup(h.snapshot.cartRef).catch(() => null) : null;
    const observation = { ...(h.observation ?? { observedAt: new Date(this.now()).toISOString(), reason: "HUMAN_FINISHED" as const, pages: [], pageClaimsConfirmation: false, confirmationText: null, discrepancies: [] }) };
    const d: string[] = [];
    if (!src) d.push("NO_AUTHORITATIVE_SELLER_SOURCE_FOR_MERCHANT");
    else if (!h.snapshot?.cartRef) d.push("NO_MERCHANT_CART_REFERENCE");
    if (seller?.status === "CONFIRMED" && h.snapshot) {
      if (seller.totalMinor !== h.snapshot.totalMinor) d.push("SELLER_TOTAL_DIFFERS_FROM_PREPARED_TOTAL");
      if (seller.quantity !== h.quantity) d.push("SELLER_QUANTITY_DIFFERS");
      if (seller.currency !== h.currency) d.push("SELLER_CURRENCY_DIFFERS");
      if (h.identity.sku && seller.sku !== h.identity.sku) d.push("SELLER_SKU_DIFFERS");
      if (h.ownerMaxMinor !== null && seller.totalMinor !== null && seller.totalMinor > h.ownerMaxMinor) d.push("SELLER_TOTAL_EXCEEDS_OWNER_MAXIMUM");
    }
    if (h.observation?.pageClaimsConfirmation && seller?.status !== "CONFIRMED") d.push("PAGE_CLAIMS_CONFIRMATION_WITHOUT_SELLER_CONFIRMATION");
    observation.discrepancies = d;
    if (h.state === "RETURN_OBSERVED" && seller?.status === "NO_ORDER")
      return this.transition(h, "CANCELLED", { seller, observation, failureCode: "SELLER_REPORTS_NO_ORDER", failureReason: null });
    const confirmed = seller?.status === "CONFIRMED" && d.length === 0;
    if (confirmed) return this.transition(h, "ORDER_CONFIRMED", { seller, observation, failureCode: null, failureReason: null });
    return this.transition(h, "ORDER_UNVERIFIED", { seller, observation, failureCode: seller?.problem ?? (d[0] ?? "NOT_VERIFIED"), failureReason: null });
  }

  /** Read-only re-check of an unverified outcome against the seller-side source. */
  async recheck(userId: string, handoffId: string): Promise<Handoff> {
    const h = this.get(handoffId, userId);
    if (h.state !== "ORDER_UNVERIFIED" || !this.cfg.sellers.get(h.merchantDomain)) return h;
    return this.settleFromSeller(h);
  }

  /** Expiry and lost-browser handling. Never marks a taken-over handoff as EXPIRED or "nothing happened". */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const rows = this.store.db.prepare(`SELECT * FROM browser_handoffs WHERE state IN ('CHECKOUT_PREPARING','CHECKOUT_READY','HUMAN_ACTION_REQUIRED','HOLD','HANDOFF_OPENED')`).all() as Row[];
      for (const r of rows) {
        const h = this.toHandoff(r);
        try {
          if (h.state === "HANDOFF_OPENED") {
            if (!this.sessions.has(h.handoffId) || this.sessions.get(h.handoffId)?.phase === "CLOSED")
              await this.finish(h.userId, h.handoffId, "BROWSER_SESSION_LOST");
            else if (h.takeoverDeadline !== null && h.takeoverDeadline <= this.now()) await this.finish(h.userId, h.handoffId, "TAKEOVER_TIMEOUT");
          } else if (h.expiresAt <= this.now()) {
            // Pre-takeover only: no human has touched the browser, so "no purchase was possible" is true.
            await this.closeSession(h.handoffId);
            this.transition(h, "EXPIRED", { failureCode: "HANDOFF_EXPIRED", failureReason: "No human took over before expiry; no purchase was possible." });
          } else if (h.state === "HUMAN_ACTION_REQUIRED" &&
              (!this.sessions.has(h.handoffId) || this.sessions.get(h.handoffId)?.phase === "CLOSED")) {
            // Startup loss OR the independent 10-minute watchdog closed the prepared session.
            await this.closeSession(h.handoffId);
            this.transition(h, "EXPIRED", { failureCode: "BROWSER_SESSION_LOST", failureReason: "The prepared browser is gone; prepare again." });
          }
        } catch { /* concurrent change; next tick re-reads */ }
      }
    } finally { this.ticking = false; }
  }

  async shutdown(): Promise<void> { for (const id of [...this.sessions.keys()]) await this.closeSession(id); }

  handoffUrl(h: Handoff): string { return `${this.cfg.baseUrl}/handoff/${h.handoffId}`; }

  // ------------------------------------------------------------------ host-neutral contract (MCP + HTTP)
  publicStatus(h: Handoff) {
    const session = this.sessions.get(h.handoffId);
    const browserAvailable = !!session && session.phase !== "CLOSED";
    const humanTurn = browserAvailable && (h.state === "HUMAN_ACTION_REQUIRED" ||
      (h.state === "HOLD" && !!h.constraints && h.constraints.violations.every((v) => v === "AMOUNT_EXCEEDED")));
    return {
      handoffId: h.handoffId, state: h.state, stateIsServerVerified: true as const, checkoutPath: "BROWSER_CHECKOUT_HANDOFF" as const,
      merchant: { name: h.merchantName, domain: h.merchantDomain, recipeId: h.recipeId },
      productIdentity: h.identity, quantity: h.quantity, currency: h.currency,
      capturedCart: h.snapshot, constraints: h.constraints,
      failure: h.failureCode ? { code: h.failureCode, detail: h.failureReason } : null,
      humanAction: humanTurn ? {
        required: true, kind: "OPEN_HANDOFF_PAGE" as const, url: this.handoffUrl(h), expiresAt: new Date(h.expiresAt).toISOString(),
        authentication: "OWNER_KEY" as const,
        instructions: "Give this link to the user. They open it in their own browser, sign in with their owner key, set their maximum, take over the prepared merchant browser, and use the merchant's own PayPal button. The assistant cannot open or operate this page.",
        presentation: { cliHosts: "OPEN_LINK_IN_DEFAULT_BROWSER" as const, uiHosts: "OPEN_LINK_OR_EMBED_AUTHENTICATED_PAGE" as const, inChatPaymentModal: "NOT_ASSUMED" as const },
      } : null,
      takeover: h.state === "HANDOFF_OPENED" ? { deadline: h.takeoverDeadline ? new Date(h.takeoverDeadline).toISOString() : null, automation: "PAUSED" as const } : null,
      observation: h.observation, sellerConfirmation: h.seller ? { status: h.seller.status, source: h.seller.source, orderRef: h.seller.orderRef, totalMinor: h.seller.totalMinor, problem: h.seller.problem } : null,
      orderStatus: orderStatusOf(h.state),
      browserProvider: h.driver, paymentEffect: "NONE_BY_DIAPORIA" as const, diaporiaCreatedPaymentOrder: false as const,
      note: "DIAPORIA never presses payment or order-submission controls and never creates the merchant's PayPal order. Only an authenticated seller-side confirmation yields ORDER_CONFIRMED; a confirmation page or redirect alone is not proof.",
    };
  }
}

export function orderStatusOf(s: HandoffState): "NO_ORDER_POSSIBLE_YET" | "AWAITING_HUMAN" | "HUMAN_IN_CONTROL" | "OUTCOME_UNVERIFIED" | "SELLER_CONFIRMED" | "NO_ORDER" {
  switch (s) {
    case "CHECKOUT_PREPARING": case "CHECKOUT_READY": case "HOLD": case "EXPIRED": return "NO_ORDER_POSSIBLE_YET";
    case "HUMAN_ACTION_REQUIRED": return "AWAITING_HUMAN";
    case "HANDOFF_OPENED": return "HUMAN_IN_CONTROL";
    case "RETURN_OBSERVED": case "ORDER_UNVERIFIED": return "OUTCOME_UNVERIFIED";
    case "ORDER_CONFIRMED": return "SELLER_CONFIRMED";
    case "CANCELLED": return "NO_ORDER";
  }
}

function errText(e: unknown): string { return (e instanceof Error ? e.message : "unknown error").replace(/jwt=[^\s&"']+/gi, "jwt=[REDACTED]").slice(0, 200); }

export { HANDOFF_TERMINAL };
export type { MerchantCheckoutRecipe };
