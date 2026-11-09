import type { CatalogProduct, Condition, MerchantOffer, MerchantQuote, ProductIdentity } from "../domain/types.js";
import { isCurrency, parseDecimalToMinor } from "../domain/money.js";
import { normalizeModel } from "../identity/ProductIdentityResolver.js";
import type { CommerceResearchAdapter, ProductSearchQuery } from "./CommerceResearchAdapter.js";

/**
 * LIVE Channel3 product discovery (BYOK). Request and normalization follow the integration used in
 * DIAPORIA Buy V7 (POST https://api.trychannel3.com/v1/search, x-api-key). Channel3 returns search-time
 * listings only: offers carry NO merchant quote (getQuote → null), so nothing becomes purchase-ready
 * without a merchant quote source. All offers are EXTERNAL_CHECKOUT_ONLY.
 */
type J = Record<string, any>;
/** Kits/bundles are a different product from the bare model: never matched as the exact product. */
export const BUNDLE_RE = /\bw\/|\bbundle\b|\bkit\b|\bcombo\b|\b\d+[- ]pack\b|\s\+\s/i;
const COLORS = ["black", "white", "blue", "silver", "gray", "grey", "graphite", "red", "green", "pink", "beige", "midnight"];

export function modelToken(text: string): string | null {
  const tokens = text.match(/\b[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)*\b/g) ?? [];
  const mixed = tokens.filter((raw) => { const t = raw.replace(/[-_]/g, ""); return t.length >= 4 && t.length <= 26 && /[A-Za-z]/.test(t) && /\d/.test(t.slice(1)) && !/^\d+(?:h|hrs|hours|gb|mm|w|mah)$/i.test(t); });
  return mixed.sort((a, b) => b.replace(/[-_]/g, "").length - a.replace(/[-_]/g, "").length)[0]?.toUpperCase() ?? null;
}
function condition(raw: unknown): Condition {
  const c = String(raw ?? "").toLowerCase();
  return /refurb|renewed/.test(c) ? "refurbished" : /open[- ]box/.test(c) ? "open_box" : /used|pre-?owned/.test(c) ? "used" : "new";
}
function cleanUrl(u: unknown): string | null {
  if (typeof u !== "string") return null;
  try { const x = new URL(u); if (x.protocol !== "https:") return null; x.search = ""; x.hash = ""; return x.toString(); } catch { return null; }
}

export class Channel3ResearchAdapter implements CommerceResearchAdapter {
  readonly name = "channel3-live";
  readonly isMock = false;
  #key: string;
  private readonly products = new Map<string, { product: CatalogProduct; offers: MerchantOffer[] }>();
  calls = 0;
  constructor(apiKey: string, private readonly opts: { limit?: number; fetchImpl?: typeof fetch; now?: () => number } = {}) {
    if (!apiKey || apiKey.length < 10) throw new Error("Channel3 API key missing");
    this.#key = apiKey;
  }

  async searchProducts(q: ProductSearchQuery): Promise<CatalogProduct[]> {
    const query = [q.brand, q.model, q.model ? "" : q.text].filter(Boolean).join(" ").trim() || q.text;
    this.calls++;
    const r = await (this.opts.fetchImpl ?? fetch)("https://api.trychannel3.com/v1/search", {
      method: "POST", headers: { "x-api-key": this.#key, "Content-Type": "application/json" },
      body: JSON.stringify({ query, limit: this.opts.limit ?? 10, config: { mode: "default" } }), signal: AbortSignal.timeout(25_000),
    });
    if (!r.ok) throw new Error(`Channel3 search failed (HTTP ${r.status})`);
    const data = (await r.json()) as J;
    const observedAt = new Date((this.opts.now ?? Date.now)()).toISOString();
    const out: CatalogProduct[] = [];
    for (const item of Array.isArray(data.products) ? data.products : []) {
      const title = typeof item.title === "string" ? item.title.trim() : "";
      const brand = typeof item.brands?.[0]?.name === "string" ? item.brands[0].name.trim() : null;
      const model = modelToken(`${brand ?? ""} ${title}`);
      if (!title || !brand || !model) continue; // without an exact model token the product cannot be locked
      const variant = COLORS.find((c) => new RegExp(`\\b${c}\\b`, "i").test(title)) ?? null;
      const color = variant ? variant[0]!.toUpperCase() + variant.slice(1) : null;
      const bundle = BUNDLE_RE.test(title);
      const identity: ProductIdentity = { brand, model, variant: bundle ? `${color ?? "UNSPECIFIED"} BUNDLE` : color, condition: "new", sku: null };
      const productId = `ch3:${String(item.id ?? title).slice(0, 80)}`;
      const offers: MerchantOffer[] = [];
      for (const [i, o] of (Array.isArray(item.offers) ? item.offers : []).entries()) {
        const cur = String(o?.price?.currency ?? "").toUpperCase();
        const amount = o?.price?.price ?? o?.price?.amount;
        if (!isCurrency(cur) || typeof amount !== "number" || !(amount > 0)) continue;
        let minor: number;
        try { minor = parseDecimalToMinor(amount.toFixed(2), cur); } catch { continue; }
        const domain = typeof o.domain === "string" ? o.domain.toLowerCase() : "unknown";
        offers.push({ offerId: `${productId}:${i}`, productId, merchantId: `mer_${domain.replace(/[^a-z0-9]+/g, "_")}`, merchantName: domain, merchantDomain: domain,
          listedIdentity: { ...identity, condition: condition(o.condition) }, itemPriceMinor: minor, currency: cur,
          availability: o.availability === "InStock" ? "IN_STOCK" : o.availability === "OutOfStock" ? "OUT_OF_STOCK" : "UNKNOWN",
          listingUrl: cleanUrl(o.url), checkoutCapability: "EXTERNAL_CHECKOUT_ONLY", listingText: null, observedAt, identityClaim: null });
      }
      const features: string[] = (Array.isArray(item.key_features) ? item.key_features : []).filter((f: unknown) => typeof f === "string").slice(0, 5);
      const product: CatalogProduct = { productId, title, category: "unknown", identity,
        // Catalog text is a LISTING claim at best; capabilities are left to independent verification.
        capabilities: [], description: features.length ? { origin: "channel3", text: features.join(" · ").slice(0, 400) } : null, reviews: [] };
      this.products.set(productId, { product, offers });
      out.push(structuredClone(product));
    }
    return q.model ? out.filter((p) => normalizeModel(p.identity.model) === normalizeModel(q.model!)) : out;
  }

  async getProduct(productId: string) { const p = this.products.get(productId); return p ? structuredClone(p.product) : null; }

  async findOffers(identity: ProductIdentity): Promise<MerchantOffer[]> {
    return [...this.products.values()].filter((p) => p.product.identity.brand.toLowerCase() === identity.brand.toLowerCase() && normalizeModel(p.product.identity.model) === normalizeModel(identity.model))
      .flatMap((p) => structuredClone(p.offers));
  }

  /** Channel3 has no checkout quote: the truthful answer is null (offer stays NO_MERCHANT_QUOTE). */
  async getQuote(): Promise<MerchantQuote | null> { return null; }

  toJSON() { return { name: this.name, key: "[REDACTED]" }; }
}
