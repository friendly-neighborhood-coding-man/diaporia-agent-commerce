import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { MerchantCheckoutRecipe } from "./recipes.js";
import type { SellerOrderStatus, SellerOrderStatusSource } from "./sellerConfirmation.js";

/**
 * DIAPORIA side of the Phase C test merchant (apps/phase-c-test-merchant). Two pieces:
 *
 *  1. `phaseCRecipe` — the trusted cart-preparation recipe for MerchantRecipeRegistry. It opens the fixed product,
 *     selects the locked variant, sets the authorized quantity, adds to cart, reads the displayed cart and stops.
 *     It names no payment control; the human uses the merchant's own PayPal button during takeover.
 *  2. `PhaseCSellerStatusSource` — the authenticated seller-side status channel. ORDER_CONFIRMED in DIAPORIA is only
 *     possible when the merchant's HMAC-signed, nonce-bound, fresh status says CONFIRMED with a verified payee.
 *     Anything else (unsigned, stale, replayed, wrong domain, MOCK evidence where Sandbox is required, PENDING,
 *     APPROVED-but-not-captured) yields UNKNOWN and the handoff stays ORDER_UNVERIFIED.
 *
 * This module never talks to PayPal and never creates, approves or captures a merchant order.
 */
export const PHASE_C_MERCHANT_DOMAIN = "bravo-electronics.example";
export const PHASE_C_OFFER_ID = "off_lumen_q3";

/** Parses the reviewed allowlist file (same file the merchant uses) into the browser host list. */
export function phaseCBrowserHosts(allowlistJson: string): string[] {
  const j = JSON.parse(allowlistJson) as { schema?: string; browserHosts?: Array<{ host?: unknown }> };
  if (j.schema !== "diaporia.phase-c.network-allowlist.v1" || !Array.isArray(j.browserHosts)) throw new Error("PHASE_C_ALLOWLIST_INVALID");
  return j.browserHosts.map((e) => { if (typeof e?.host !== "string") throw new Error("PHASE_C_ALLOWLIST_INVALID"); return e.host; });
}

/**
 * Builds the recipe. `origin` is the operator's public https merchant origin for KERNEL, or a loopback origin
 * for the offline fixture driver. `networkAllowedHosts` = merchant host + reviewed PayPal Sandbox browser hosts;
 * MerchantRecipeRegistry rejects it for public origins unless every host is an exact public DNS name.
 */
export function phaseCRecipe(origin: string, browserHosts: string[] | null): MerchantCheckoutRecipe {
  const o = new URL(origin);
  const merchantHost = o.host;
  const loopback = /^(127\.0\.0\.1|localhost|\[::1\])$/.test(o.hostname);
  return {
    recipeId: "phase-c-test-merchant-v1", merchantDomain: PHASE_C_MERCHANT_DOMAIN, origin: `${o.origin}/`, productPath: "/p/{offerId}",
    steps: [
      { action: "select", selector: "#variant", value: "variant" },
      { action: "fill", selector: "#qty", value: "quantity" },
      { action: "click", selector: "#add-to-cart" },
      { action: "waitFor", selector: "#cart" },
    ],
    cartPath: "/cart",
    extract: { title: "[data-field=title]", variant: "[data-field=variant]", condition: "[data-field=condition]", quantity: "[data-field=qty]",
      subtotal: "[data-field=subtotal]", shipping: "[data-field=shipping]", tax: "[data-field=tax]", total: "[data-field=total]",
      currency: "[data-field=currency]", cartRef: "#cart" },
    confirmationSelector: "[data-order-confirmation]",
    // Hosts the merchant's own PayPal button legitimately opens during the human takeover.
    paymentHosts: loopback ? [merchantHost] : ["www.sandbox.paypal.com"],
    ...(browserHosts ? { networkAllowedHosts: [o.hostname, ...browserHosts] } : {}),
  };
}

export interface PhaseCSellerSourceOptions {
  /** Merchant origin DIAPORIA reads the status from (https for Sandbox; loopback allowed only for tests/MOCK). */
  origin: string;
  secret: string;
  /** Accept statuses produced by the merchant's MOCK PayPal. True only for offline tests/demos. */
  acceptMockEvidence: boolean;
  fetchImpl?: typeof fetch;
  now?: () => number;
  maxSkewMs?: number;
}

const STATES = new Set(["NO_ORDER", "ORDER_CREATED", "BUYER_APPROVED", "CAPTURE_PENDING", "PAYMENT_COMPLETED", "ORDER_CONFIRMED", "PAYMENT_DENIED", "ORDER_CANCELLED", "ORDER_UNKNOWN"]);

/** Authenticated seller-side status for the Phase C test merchant. */
export class PhaseCSellerStatusSource implements SellerOrderStatusSource {
  readonly merchantDomain = PHASE_C_MERCHANT_DOMAIN;
  readonly name: string;
  #secret: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  constructor(private readonly o: PhaseCSellerSourceOptions) {
    if (o.secret.length < 32) throw new Error("Phase C seller status secret must be at least 32 characters");
    const u = new URL(o.origin);
    const loopback = /^(127\.0\.0\.1|localhost|\[::1\])$/.test(u.hostname);
    if (u.protocol !== "https:" && !(loopback && o.acceptMockEvidence)) throw new Error("Phase C seller status must be read over https");
    this.#secret = o.secret;
    this.fetchImpl = o.fetchImpl ?? fetch;
    this.now = o.now ?? Date.now;
    this.name = o.acceptMockEvidence ? "PHASE_C_MERCHANT_SIGNED_STATUS_MOCK_ALLOWED" : "PHASE_C_MERCHANT_SIGNED_STATUS";
  }
  toJSON() { return { name: this.name, secret: "[SECRET]" }; }

  async lookup(cartRef: string): Promise<SellerOrderStatus> {
    const unknown = (problem: string): SellerOrderStatus => ({ status: "UNKNOWN", orderRef: null, cartRef, totalMinor: null, currency: null, quantity: null, sku: null, source: this.name, problem });
    if (!/^cart_[a-f0-9]{24}$/.test(cartRef)) return unknown("CART_REF_INVALID");
    const nonce = randomBytes(18).toString("base64url");
    let r: Response;
    try {
      r = await this.fetchImpl(`${new URL(this.o.origin).origin}/api/orders/status?cart=${encodeURIComponent(cartRef)}&nonce=${nonce}`,
        { redirect: "error", signal: AbortSignal.timeout(5_000) });
    } catch { return unknown("SELLER_UNREACHABLE"); }
    if (r.status !== 200) return unknown(`SELLER_HTTP_${r.status}`);
    const body = await r.text();
    const sig = r.headers.get("x-merchant-signature") ?? "";
    if (!sig) return unknown("SIGNATURE_MISSING");
    const want = `v1=${createHmac("sha256", this.#secret).update(body).digest("hex")}`;
    if (sig.length !== want.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return unknown("SIGNATURE_INVALID");
    let j: any;
    try { j = JSON.parse(body); } catch { return unknown("BODY_INVALID"); }
    // Replay protection: the signed body must echo THIS request's nonce and be fresh.
    if (j?.nonce !== nonce) return unknown("NONCE_MISMATCH");
    const issued = Date.parse(j.issuedAt);
    if (Number.isNaN(issued) || Math.abs(this.now() - issued) > (this.o.maxSkewMs ?? 60_000)) return unknown("STATUS_STALE");
    if (j.v !== 1 || j.merchantDomain !== PHASE_C_MERCHANT_DOMAIN) return unknown("MERCHANT_DOMAIN_MISMATCH");
    if (j.cartRef !== cartRef) return unknown("CART_REF_MISMATCH");
    if (j.fulfillment !== "NOT_VERIFIED" || j.sandboxOnly !== true) return unknown("STATUS_SHAPE_INVALID");
    if (j.evidenceSource === "MOCK_PAYPAL_IN_PROCESS" && !this.o.acceptMockEvidence) return unknown("MOCK_EVIDENCE_NOT_ACCEPTED");
    if (j.evidenceSource !== "MOCK_PAYPAL_IN_PROCESS" && j.evidenceSource !== "PAYPAL_SANDBOX_ORDERS_V2_SERVER_SIDE") return unknown("EVIDENCE_SOURCE_UNKNOWN");
    if (typeof j.state !== "string" || !STATES.has(j.state)) return unknown("MERCHANT_STATE_INVALID");
    const fields = {
      orderRef: typeof j.orderRef === "string" ? j.orderRef.slice(0, 60) : null, cartRef,
      totalMinor: Number.isSafeInteger(j.totalMinor) ? j.totalMinor : null, currency: typeof j.currency === "string" ? j.currency : null,
      quantity: Number.isSafeInteger(j.quantity) ? j.quantity : null, sku: typeof j.sku === "string" ? j.sku : null, source: this.name,
    };
    // Recompute the seller verdict from the merchant state instead of trusting the summary field alone.
    if (j.state === "ORDER_CONFIRMED" && j.sellerStatus === "CONFIRMED") {
      if (j.payeeVerified !== true) return { ...unknown("PAYEE_NOT_VERIFIED"), ...fields, status: "UNKNOWN", problem: "PAYEE_NOT_VERIFIED" };
      return { status: "CONFIRMED", ...fields, problem: null };
    }
    if ((j.state === "NO_ORDER" || j.state === "ORDER_CANCELLED") && j.sellerStatus === "NO_ORDER" && j.known === true) return { status: "NO_ORDER", ...fields, problem: null };
    // PENDING, APPROVED-not-captured, DENIED, UNKNOWN: never success, never "nothing happened".
    return { status: "UNKNOWN", ...fields, problem: `MERCHANT_STATE_${j.state}` };
  }
}

/**
 * C3 consistency rule: the DIAPORIA handoff state that a given merchant-side state must produce.
 * PENDING, APPROVED-not-captured, DENIED and UNKNOWN are never success. Without a seller source, ORDER_UNVERIFIED always.
 */
export function expectedDiaporiaOutcome(merchantState: string, sellerSourceConfigured: boolean): "ORDER_CONFIRMED" | "CANCELLED" | "ORDER_UNVERIFIED" {
  if (!sellerSourceConfigured) return "ORDER_UNVERIFIED";
  if (merchantState === "ORDER_CONFIRMED") return "ORDER_CONFIRMED";
  if (merchantState === "NO_ORDER" || merchantState === "ORDER_CANCELLED") return "CANCELLED";
  return "ORDER_UNVERIFIED";
}
