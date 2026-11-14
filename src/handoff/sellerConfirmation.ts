import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Seller-side order status. ORDER_CONFIRMED may only come from a source registered here for the exact merchant
 * domain — an authenticated merchant channel — never from page text, a redirect, or an AI reading of a page.
 *
 * V0 ships one source: the offline fixture merchant's HMAC-signed order-status endpoint. Real merchants have no
 * registered source, so their outcome stays ORDER_UNVERIFIED (and that is reported honestly).
 */
export interface SellerOrderStatus {
  status: "CONFIRMED" | "NO_ORDER" | "UNKNOWN";
  orderRef: string | null;
  cartRef: string;
  totalMinor: number | null;
  currency: string | null;
  quantity: number | null;
  sku: string | null;
  source: string;
  /** Why the source could not answer authoritatively (signature, transport, shape). */
  problem: string | null;
}

export interface SellerOrderStatusSource {
  readonly name: string;
  readonly merchantDomain: string;
  lookup(cartRef: string): Promise<SellerOrderStatus>;
}

export class SellerSourceRegistry {
  private readonly m = new Map<string, SellerOrderStatusSource>();
  constructor(sources: SellerOrderStatusSource[] = []) { for (const s of sources) this.m.set(s.merchantDomain, s); }
  get(domain: string): SellerOrderStatusSource | null { return this.m.get(domain) ?? null; }
}

export function signFixtureBody(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

/** Reads `GET {origin}/api/orders?cart=<ref>`; trusts the body only if its HMAC matches the shared secret. */
export class HmacFixtureSellerSource implements SellerOrderStatusSource {
  readonly name = "FIXTURE_MERCHANT_SIGNED_ORDER_API";
  #secret: string;
  constructor(readonly merchantDomain: string, private readonly origin: string, secret: string, private readonly fetchImpl: typeof fetch = fetch) {
    if (secret.length < 16) throw new Error("fixture seller secret too short");
    this.#secret = secret;
  }
  async lookup(cartRef: string): Promise<SellerOrderStatus> {
    const unknown = (problem: string): SellerOrderStatus => ({ status: "UNKNOWN", orderRef: null, cartRef, totalMinor: null, currency: null, quantity: null, sku: null, source: this.name, problem });
    if (!/^[A-Za-z0-9_-]{6,80}$/.test(cartRef)) return unknown("CART_REF_INVALID");
    let r: Response;
    try { r = await this.fetchImpl(`${this.origin}/api/orders?cart=${encodeURIComponent(cartRef)}`, { signal: AbortSignal.timeout(5_000) }); }
    catch { return unknown("SELLER_UNREACHABLE"); }
    const body = await r.text();
    const sig = r.headers.get("x-fixture-signature") ?? "";
    const want = signFixtureBody(this.#secret, body);
    if (sig.length !== want.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return unknown("SIGNATURE_INVALID");
    let j: any;
    try { j = JSON.parse(body); } catch { return unknown("BODY_INVALID"); }
    if (j?.cartRef !== cartRef) return unknown("CART_REF_MISMATCH");
    const status = j.status === "CONFIRMED" ? "CONFIRMED" : j.status === "NO_ORDER" ? "NO_ORDER" : "UNKNOWN";
    return { status, orderRef: typeof j.orderRef === "string" ? j.orderRef.slice(0, 60) : null, cartRef,
      totalMinor: Number.isSafeInteger(j.totalMinor) ? j.totalMinor : null, currency: typeof j.currency === "string" ? j.currency : null,
      quantity: Number.isSafeInteger(j.quantity) ? j.quantity : null, sku: typeof j.sku === "string" ? j.sku : null, source: this.name,
      problem: status === "UNKNOWN" ? "STATUS_UNKNOWN" : null };
  }
}
