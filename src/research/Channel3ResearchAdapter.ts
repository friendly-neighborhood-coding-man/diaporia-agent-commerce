import type { CatalogProduct, CatalogResearchInfo, Condition, MerchantOffer, MerchantQuote, ProductIdentity } from "../domain/types.js";
import { CURRENCY_EXPONENT, isCurrency, parseDecimalToMinor } from "../domain/money.js";
import { normalizeModel } from "../identity/ProductIdentityResolver.js";
import { canonicalVariant, COLOR_WORDS, extractIdentity, familyKey, modelNumberToken, parseAttributes, BUNDLE_RE as BUNDLE_PATTERN,
  type AttributeAxis, type VariantAttributes } from "../identity/ProductIdentityExtractor.js";
import type { CommerceResearchAdapter, ProductSearchQuery, SearchPage } from "./CommerceResearchAdapter.js";

/**
 * LIVE Channel3 product discovery (BYOK). Request and response handling follow the documented v1 contract
 * (docs/research/PROVIDER_CONTRACTS.md, read 2026-11-10; NOT yet verified against a live response):
 *   POST /v1/search  {query, limit<=30, filters, config{mode,currency,country}, page_token} → {products, next_page_token}  (1 credit)
 *   GET  /v1/products/{id}?option_<Name>=<Label>                                           (free; relaxes impossible selections)
 *   POST /v1/lookup  {url, max_staleness_hours, realtime_fetch}                             (1 credit)
 * Channel3 returns search-time listings only: offers carry NO merchant quote (getQuote → null), so nothing becomes
 * purchase-ready without a merchant quote source. All offers are EXTERNAL_CHECKOUT_ONLY.
 * Identity: see ProductIdentityExtractor. Never fills `sku` (the API has no SKU field).
 */
type J = Record<string, any>;
/** Kits/bundles/multi-packs are a different product from the bare model: never matched as the exact product. */
export const BUNDLE_RE = BUNDLE_PATTERN;
/** Back-compatible model-number extractor (V1 export). Units such as "12-Cup" or "32GB" are never models. */
export function modelToken(text: string): string | null { return modelNumberToken(text); }

/** Currencies and countries Channel3 accepts in `config` (documented enums). KRW and JPY are not among them. */
export const CHANNEL3_CURRENCIES = new Set(["USD", "CAD", "AUD", "GBP", "EUR", "SEK", "CZK", "RON", "CHF", "PLN"]);
export const CHANNEL3_COUNTRIES = new Set(["US", "GB", "EU", "AU", "CA", "IE", "DE", "AT", "FR", "BE", "IT", "ES", "NL", "SE", "FI", "PT", "CZ", "GR", "RO", "CH", "PL"]);
const AXIS_OF: Record<string, AttributeAxis> = { color: "color", colour: "color", size: "size", "shoe size": "size", storage: "storage", memory: "memory", ram: "memory", capacity: "capacity", volume: "capacity", pack: "pack", quantity: "pack" };

function offerCondition(raw: unknown, title: CatalogResearchInfo["titleCondition"]): Condition {
  const c = typeof raw === "string" ? raw.toLowerCase() : null;
  // The API emits new | used | null ("refurbished" is deprecated → null). Unknown is never "new".
  if (c === "used") return title === "refurbished" || title === "open_box" ? "unknown" : "used";
  if (c === "new") return title ? "unknown" : "new";
  return title ?? "unknown";
}
function cleanUrl(u: unknown): string | null {
  if (typeof u !== "string") return null;
  try { const x = new URL(u); if (x.protocol !== "https:") return null; x.search = ""; x.hash = ""; return x.toString(); } catch { return null; }
}
function axisValue(axis: AttributeAxis, label: string): string {
  if (axis === "color") { const c = COLOR_WORDS[label.toLowerCase()]; return c ?? label.trim().replace(/\b\w/g, (m) => m.toUpperCase()); }
  if (axis === "storage" || axis === "memory") return label.replace(/\s+/g, "").toUpperCase();
  if (axis === "capacity") return parseAttributes(label).capacity ?? label.trim();
  if (axis === "pack") return label.replace(/\D+/g, "") || label;
  return label.trim().toUpperCase();
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class RedirectRefused extends Error {}

export class Channel3ResearchAdapter implements CommerceResearchAdapter {
  readonly name = "channel3-live";
  readonly isMock = false;
  #key: string;
  private readonly products = new Map<string, { product: CatalogProduct; offers: MerchantOffer[] }>();
  /** HTTP attempts made (including bounded retries). */
  calls = 0;
  constructor(apiKey: string, private readonly opts: { limit?: number; fetchImpl?: typeof fetch; now?: () => number; retry?: { attempts: number; baseDelayMs: number; maxRetryAfterMs: number } } = {}) {
    if (!apiKey || apiKey.length < 10) throw new Error("Channel3 API key missing");
    this.#key = apiKey;
  }

  /** Bounded retry: 429/5xx/network errors only, at most `attempts` tries, Retry-After honoured up to a cap. */
  private async request(url: string, init: RequestInit): Promise<Response> {
    const policy = this.opts.retry ?? { attempts: 2, baseDelayMs: 300, maxRetryAfterMs: 2000 };
    let last: unknown = null;
    for (let i = 0; i < policy.attempts; i++) {
      this.calls++;
      try {
        // Redirects are never followed (review R-08): the API key header must not leave api.trychannel3.com.
        const r = await (this.opts.fetchImpl ?? fetch)(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(25_000) });
        if ((r.status >= 300 && r.status < 400) || r.type === "opaqueredirect") throw new RedirectRefused(`Channel3 HTTP ${r.status} redirect refused`);
        if (r.status !== 429 && r.status < 500) return r;
        last = new Error(`Channel3 HTTP ${r.status}`);
        if (i + 1 < policy.attempts) await sleep(Math.min(policy.maxRetryAfterMs, Number(r.headers.get("retry-after") ?? 0) * 1000 || policy.baseDelayMs * 2 ** i));
        else return r;
      } catch (e) { if (e instanceof RedirectRefused) throw e; last = e; if (i + 1 < policy.attempts) await sleep(policy.baseDelayMs * 2 ** i); }
    }
    throw last instanceof Error ? last : new Error("Channel3 request failed");
  }

  private body(q: ProductSearchQuery, pageToken: string | null) {
    const currency = q.currency && CHANNEL3_CURRENCIES.has(q.currency) ? q.currency : null;
    const filters: J = {};
    if (q.conditions?.length) filters.conditions = q.conditions;
    if (q.maxPriceMinor != null && currency && isCurrency(currency)) filters.price = { max_price: q.maxPriceMinor / 10 ** CURRENCY_EXPONENT[currency] };
    const config: J = { mode: q.mode ?? "default" };
    if (currency) config.currency = currency;
    if (q.country && CHANNEL3_COUNTRIES.has(q.country)) config.country = q.country;
    const query = q.query ?? ([q.brand, q.model, q.model ? "" : q.text].filter(Boolean).join(" ").trim() || q.text);
    return pageToken ? { page_token: pageToken, limit: Math.min(30, q.limit ?? this.opts.limit ?? 10) }
      : { query, limit: Math.min(30, q.limit ?? this.opts.limit ?? 10), ...(Object.keys(filters).length ? { filters } : {}), config };
  }

  /** One provider call: one page of results. */
  async searchPage(q: ProductSearchQuery, pageToken: string | null = null, page = 1): Promise<SearchPage> {
    const before = this.calls;
    const body: J = this.body(q, pageToken);
    const r = await this.request("https://api.trychannel3.com/v1/search", { method: "POST", headers: { "x-api-key": this.#key, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`Channel3 search failed (HTTP ${r.status})`);
    const data = (await r.json()) as J;
    const observedAt = new Date((this.opts.now ?? Date.now)()).toISOString();
    const out: CatalogProduct[] = [];
    for (const item of Array.isArray(data.products) ? data.products : []) {
      const p = this.normalize(item, observedAt, { query: "query" in body ? String(body.query) : null, page, mode: body.config?.mode ?? null });
      if (p) out.push(p);
    }
    return { products: this.dedupe(out), nextPageToken: typeof data.next_page_token === "string" ? data.next_page_token : null, providerCalls: this.calls - before,
      locale: { currencyRequested: q.currency ?? null, currencySent: (body as J).config?.currency ?? null, supported: !q.currency || CHANNEL3_CURRENCIES.has(q.currency) } };
  }

  /** V1-compatible single search (first page). With a model hint, only that product family is returned. */
  async searchProducts(q: ProductSearchQuery): Promise<CatalogProduct[]> {
    const { products } = await this.searchPage(q);
    if (!q.model) return products;
    const key = familyKey(q.brand, q.model);
    return products.filter((p) => familyKey(p.identity.brand, p.identity.model) === key || (!q.brand && normalizeModel(p.identity.model) === normalizeModel(q.model!)));
  }

  /** Products whose identity is identical (same family, variant and kind) are one product: offers merged, listings recorded. */
  private dedupe(list: CatalogProduct[]): CatalogProduct[] {
    const out: CatalogProduct[] = []; const byKey = new Map<string, CatalogProduct>();
    for (const p of list) {
      const r = p.research;
      if (!r || r.modelBasis === "NONE" || r.conflictingAxes.length) { out.push(p); continue; }
      const key = `${familyKey(p.identity.brand, p.identity.model)}|${p.identity.variant ?? ""}|${p.identity.condition}`;
      const first = byKey.get(key);
      if (!first) { byKey.set(key, p); out.push(p); continue; }
      const a = this.products.get(first.productId)!; const b = this.products.get(p.productId)!;
      const urls = new Set(a.offers.map((o) => `${o.merchantDomain}|${o.listingUrl}`));
      for (const o of b.offers) if (!urls.has(`${o.merchantDomain}|${o.listingUrl}`)) a.offers.push({ ...o, productId: first.productId, offerId: `${first.productId}:${a.offers.length}` });
      first.research!.alsoListedAs.push(r.provenance.providerProductId);
      this.products.set(first.productId, { product: structuredClone(first), offers: a.offers });
      this.products.delete(p.productId);
    }
    return out.map((p) => structuredClone(this.products.get(p.productId)?.product ?? p));
  }

  private normalize(item: J, observedAt: string, prov: { query: string | null; page: number | null; mode: string | null }): CatalogProduct | null {
    const title = typeof item.title === "string" ? item.title.trim() : "";
    if (!title) return null;
    const brand = typeof item.brands?.[0]?.name === "string" ? item.brands[0].name.trim() : null;
    const ex = extractIdentity(title, brand);
    // V2.4: the catalog's own accessory category ("tent-accessories", "Earbud Accessories") marks an accessory even when
    // the title does not say so; a standalone category never overrides an accessory title.
    const catText = `${typeof item.category?.slug === "string" ? item.category.slug : ""} ${typeof item.category?.title === "string" ? item.category.title : ""}`;
    if (ex.kind === "STANDALONE" && /accessor|\bparts\b|spare/i.test(catText)) { ex.kind = "ACCESSORY"; ex.accessoryNoun = ex.accessoryNoun ?? "accessory"; }
    // Structured variant selection is authoritative; a title that disagrees makes that axis unknown (fail closed).
    const attrs: VariantAttributes = { ...ex.attributes };
    const conflicting: string[] = [];
    for (const s of Array.isArray(item.variants?.selected) ? item.variants.selected : []) {
      const axis = AXIS_OF[String(s?.name ?? "").toLowerCase()];
      if (!axis || typeof s.label !== "string") continue;
      const v = axisValue(axis, s.label);
      if (attrs[axis] && attrs[axis]!.toLowerCase() !== v.toLowerCase()) { conflicting.push(axis); attrs[axis] = "CONFLICT"; } else attrs[axis] = v;
    }
    const siblings: CatalogResearchInfo["siblingVariants"] = [];
    for (const op of Array.isArray(item.variants?.options) ? item.variants.options : [])
      for (const v of Array.isArray(op?.values) ? op.values : []) if (typeof v?.product_id === "string" && v.product_id !== item.id)
        siblings.push({ axis: String(op.name ?? ""), label: String(v.label ?? ""), providerProductId: v.product_id });
    const variant = canonicalVariant(attrs, ex.kind, ex.accessoryNoun);
    // N-06: a product with no model name/number keeps model "" and is identified by the provider's own product key
    // (in `sku`), so two model-less products of one brand never share an identity.
    const modelLess = !normalizeModel(ex.model ?? "");
    const identity: ProductIdentity = { brand: brand ?? "", model: ex.model ?? "", variant, condition: ex.titleCondition ?? "new", sku: modelLess && item.id ? `ch3:${String(item.id).slice(0, 56)}` : null };
    const productId = `ch3:${String(item.id ?? title).slice(0, 80)}`;
    const offers: MerchantOffer[] = [];
    for (const [i, o] of (Array.isArray(item.offers) ? item.offers : []).entries()) {
      const cur = String(o?.price?.currency ?? "").toUpperCase();
      const amount = o?.price?.price ?? o?.price?.amount;
      if (!isCurrency(cur) || typeof amount !== "number" || !(amount > 0)) continue;
      let minor: number;
      try { minor = parseDecimalToMinor(amount.toFixed(CURRENCY_EXPONENT[cur]), cur); } catch { continue; }
      const domain = typeof o.domain === "string" ? o.domain.toLowerCase() : "unknown";
      offers.push({ offerId: `${productId}:${i}`, productId, merchantId: `mer_${domain.replace(/[^a-z0-9]+/g, "_")}`, merchantName: domain, merchantDomain: domain,
        listedIdentity: { ...identity, condition: offerCondition(o.condition, ex.titleCondition) }, itemPriceMinor: minor, currency: cur,
        availability: o.availability === "InStock" ? "IN_STOCK" : o.availability === "OutOfStock" ? "OUT_OF_STOCK" : "UNKNOWN", availabilitySource: "PROVIDER_LISTING",
        listingUrl: cleanUrl(o.url), checkoutCapability: "EXTERNAL_CHECKOUT_ONLY", listingText: null, observedAt, identityClaim: null });
    }
    const features: string[] = (Array.isArray(item.key_features) ? item.key_features : []).filter((f: unknown) => typeof f === "string").slice(0, 5);
    const descText = [typeof item.description === "string" ? item.description : "", features.join(" · ")].filter(Boolean).join(" — ").slice(0, 600);
    const product: CatalogProduct = { productId, title, category: typeof item.category?.slug === "string" ? item.category.slug : "unknown", identity,
      // Catalog text is a LISTING claim at best; capabilities are left to independent verification.
      capabilities: [], description: descText ? { origin: "channel3", text: descText } : null, reviews: [],
      research: { kind: ex.kind, fitsBrand: ex.fitsBrand ?? null, modelBasis: ex.modelBasis, attributes: attrs, conflictingAxes: conflicting,
        categoryTitle: typeof item.category?.title === "string" ? item.category.title : null, titleCondition: ex.titleCondition,
        provenance: { provider: "channel3", providerProductId: String(item.id ?? ""), observedAt, ...prov }, alsoListedAs: [], siblingVariants: siblings } };
    this.products.set(productId, { product, offers });
    return structuredClone(product);
  }

  async getProduct(productId: string) {
    const p = this.products.get(productId);
    if (p) return structuredClone(p.product);
    const d = await this.detail(productId.replace(/^ch3:/, ""), {});
    return d;
  }

  private async detail(id: string, selection: Record<string, string>, locale: { currency?: string | null } = {}): Promise<CatalogProduct | null> {
    const u = new URL(`https://api.trychannel3.com/v1/products/${encodeURIComponent(id)}`);
    for (const [k, v] of Object.entries(selection)) u.searchParams.set(`option_${k}`, v);
    if (locale.currency && CHANNEL3_CURRENCIES.has(locale.currency)) u.searchParams.set("currency", locale.currency);
    const r = await this.request(u.toString(), { method: "GET", headers: { "x-api-key": this.#key } });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`Channel3 product detail failed (HTTP ${r.status})`);
    const item = (await r.json()) as J;
    return this.normalize(item, new Date((this.opts.now ?? Date.now)()).toISOString(), { query: null, page: null, mode: "detail" });
  }

  /**
   * Resolves one configuration through product detail (free). The API RELAXES an impossible selection to the closest
   * real variant; this method reports `honored: false` in that case and the caller must not use the product.
   */
  async resolveVariant(productId: string, selection: Record<string, string>, locale: { currency?: string | null } = {}) {
    const p = await this.detail(productId.replace(/^ch3:/, ""), selection, locale);
    if (!p) return { product: null, honored: false, effective: {} as VariantAttributes };
    const effective = p.research?.attributes ?? {};
    const honored = Object.entries(selection).every(([name, label]) => {
      const axis = AXIS_OF[name.toLowerCase()];
      return !!axis && (effective[axis] ?? "").toLowerCase() === axisValue(axis, label).toLowerCase();
    });
    return { product: p, honored, effective };
  }

  /** URL → product (1 credit). Catalog only (no live page fetch), at most 24 h old data. */
  async lookupUrl(url: string): Promise<CatalogProduct | null> {
    const r = await this.request("https://api.trychannel3.com/v1/lookup", { method: "POST", headers: { "x-api-key": this.#key, "Content-Type": "application/json" },
      body: JSON.stringify({ url, max_staleness_hours: 24, realtime_fetch: false }) });
    if (r.status === 404 || r.status === 422) return null;
    if (!r.ok) throw new Error(`Channel3 lookup failed (HTTP ${r.status})`);
    const data = (await r.json()) as J;
    return data.product ? this.normalize(data.product, new Date((this.opts.now ?? Date.now)()).toISOString(), { query: null, page: null, mode: "lookup" }) : null;
  }

  async findOffers(identity: ProductIdentity): Promise<MerchantOffer[]> {
    // N-06: a model-less identity matches only the listing with the same provider product key, never the whole brand.
    if (!normalizeModel(identity.model)) return identity.sku ? [...this.products.values()].filter((p) => p.product.identity.sku === identity.sku).flatMap((p) => structuredClone(p.offers)) : [];
    const key = familyKey(identity.brand, identity.model);
    return [...this.products.values()].filter((p) => familyKey(p.product.identity.brand, p.product.identity.model) === key).flatMap((p) => structuredClone(p.offers));
  }

  /** Channel3 has no checkout quote: the truthful answer is null (offer stays NO_MERCHANT_QUOTE). */
  async getQuote(): Promise<MerchantQuote | null> { return null; }

  toJSON() { return { name: this.name, key: "[REDACTED]" }; }
}
