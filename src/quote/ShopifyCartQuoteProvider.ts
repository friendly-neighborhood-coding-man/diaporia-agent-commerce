import { createHash } from "node:crypto";
import { isCurrency, parseDecimalToMinor, type Currency } from "../domain/money.js";
import { QuoteProviderError, type QuoteDeliveryOption, type QuoteEvidence, type QuoteIssue, type QuoteProvenance } from "./types.js";

/**
 * Shopify Storefront API (GraphQL) cart-based quotes. Schema verified against shopify.dev
 * (api_version 2026-10, read 2026-11-09): cartCreate, cartDeliveryAddressesAdd,
 * cartSelectedDeliveryOptionsUpdate, Cart.cost (CartCost: subtotalAmount, subtotalAmountEstimated,
 * totalAmount, totalAmountEstimated), Cart.deliveryGroups (CartDeliveryGroup.deliveryOptions,
 * selectedDeliveryOption), Cart.checkoutUrl. Deprecated tax/duty fields are deliberately not used.
 *
 * It creates a fresh cart per quote and never completes checkout: the merchant's checkoutUrl is
 * returned for an external handoff only. A cart is not an order and its cost is not a guarantee.
 */
export const SHOPIFY_STOREFRONT_API_VERSION = "2026-10";

export interface ShopifyCartQuoteConfig {
  /** e.g. "my-dev-store.myshopify.com" */
  shopDomain: string;
  apiVersion?: string;
  /** Storefront access token. Omit for tokenless cart access (allowed by Shopify for Cart, complexity-limited). */
  token?: string | null;
  tokenType?: "public" | "private";
  /** Additional hosts allowed for checkoutUrl (e.g. the shop's custom primary domain). */
  allowedCheckoutHosts?: string[];
  quoteTtlSeconds?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** FIXTURE for recorded/synthetic transports, MERCHANT_API for a real store. */
  provenance?: QuoteProvenance;
}

export interface QuoteRequest {
  /** gid://shopify/ProductVariant/<id> */
  variantId: string;
  quantity: number;
  currency: Currency;
  countryCode: string;
  destination?: { countryCode: string; provinceCode?: string | undefined; zip?: string | undefined; city?: string | undefined; address1?: string | undefined } | null;
  /** Delivery option to select; default selects the cheapest offered option. */
  deliveryOptionHandle?: string;
}

const MONEY = "{ amount currencyCode }";
const CART_FIELDS = `fragment CartFields on Cart {
  id checkoutUrl totalQuantity
  buyerIdentity { countryCode }
  lines(first: 10) { nodes { quantity merchandise { ... on ProductVariant { id title sku availableForSale product { title } } } } }
  cost { subtotalAmount ${MONEY} subtotalAmountEstimated totalAmount ${MONEY} totalAmountEstimated }
  deliveryGroups(first: 5, withCarrierRates: true) { nodes { id
    deliveryOptions { handle title code deliveryMethodType estimatedCost ${MONEY} }
    selectedDeliveryOption { handle title deliveryMethodType estimatedCost ${MONEY} } } }
}`;
const PAYLOAD = "cart { ...CartFields } userErrors { code field message } warnings { code message }";
export const Q_CREATE = `mutation CartCreate($input: CartInput!, $country: CountryCode) @inContext(country: $country) { cartCreate(input: $input) { ${PAYLOAD} } } ${CART_FIELDS}`;
export const Q_ADDRESS = `mutation CartAddr($cartId: ID!, $addresses: [CartSelectableAddressInput!]!, $country: CountryCode) @inContext(country: $country) { cartDeliveryAddressesAdd(cartId: $cartId, addresses: $addresses) { ${PAYLOAD} } } ${CART_FIELDS}`;
export const Q_SELECT = `mutation CartSelect($cartId: ID!, $selected: [CartSelectedDeliveryOptionInput!]!, $country: CountryCode) @inContext(country: $country) { cartSelectedDeliveryOptionsUpdate(cartId: $cartId, selectedDeliveryOptions: $selected) { ${PAYLOAD} } } ${CART_FIELDS}`;

type J = Record<string, any>;

export class ShopifyCartQuoteProvider {
  readonly name = "shopify-storefront-cart";
  private readonly fetchImpl: typeof fetch;
  private readonly version: string;

  constructor(private readonly cfg: ShopifyCartQuoteConfig) {
    if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(cfg.shopDomain)) throw new QuoteProviderError("shopDomain must be a *.myshopify.com domain", "CONFIG");
    this.fetchImpl = cfg.fetchImpl ?? fetch;
    this.version = cfg.apiVersion ?? SHOPIFY_STOREFRONT_API_VERSION;
  }

  private async gql(query: string, variables: J): Promise<J> {
    const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
    if (this.cfg.token) headers[this.cfg.tokenType === "private" ? "Shopify-Storefront-Private-Token" : "X-Shopify-Storefront-Access-Token"] = this.cfg.token;
    let res: Response;
    try {
      res = await this.fetchImpl(`https://${this.cfg.shopDomain}/api/${this.version}/graphql.json`, {
        method: "POST", headers, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 15_000),
      });
    } catch (e) { throw new QuoteProviderError(`Shopify request failed: ${e instanceof Error ? e.name : "network error"}`, "TIMEOUT"); }
    if (res.status === 401 || res.status === 403) throw new QuoteProviderError(`Shopify access denied (HTTP ${res.status})`, "ACCESS_DENIED");
    if (res.status === 429 || res.status === 430) throw new QuoteProviderError(`Shopify throttled or rejected the request (HTTP ${res.status})`, "THROTTLED");
    if (!res.ok) throw new QuoteProviderError(`Shopify HTTP ${res.status}`, "HTTP_ERROR");
    let body: J;
    try { body = (await res.json()) as J; } catch { throw new QuoteProviderError("Shopify returned non-JSON", "INVALID_RESPONSE"); }
    if (Array.isArray(body.errors) && body.errors.length) {
      const code = String(body.errors[0]?.extensions?.code ?? "");
      if (code === "THROTTLED") throw new QuoteProviderError("Shopify THROTTLED", "THROTTLED");
      if (code === "ACCESS_DENIED") throw new QuoteProviderError("Shopify ACCESS_DENIED", "ACCESS_DENIED");
      throw new QuoteProviderError(`Shopify GraphQL error ${code || "UNKNOWN"}`, "GRAPHQL_ERROR");
    }
    return body.data ?? {};
  }

  async quote(req: QuoteRequest): Promise<QuoteEvidence> {
    if (!/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(req.variantId)) throw new QuoteProviderError("variantId must be a ProductVariant GID", "CONFIG");
    if (!Number.isSafeInteger(req.quantity) || req.quantity < 1 || req.quantity > 10) throw new QuoteProviderError("quantity must be 1..10", "CONFIG");
    const country = req.countryCode.toUpperCase();
    const messages: string[] = [];
    const issues = new Set<QuoteIssue>();
    const step = (payload: J | undefined) => {
      if (!payload) throw new QuoteProviderError("Shopify response missing payload", "INVALID_RESPONSE");
      for (const e of payload.userErrors ?? []) { issues.add("MERCHANT_USER_ERROR"); messages.push(`userError ${e.code ?? ""}: ${String(e.message ?? "").slice(0, 160)}`); }
      for (const w of payload.warnings ?? []) { issues.add("PROVIDER_WARNING"); messages.push(`warning ${w.code ?? ""}: ${String(w.message ?? "").slice(0, 160)}`); }
      return payload.cart as J | null;
    };

    // 1. Fresh cart per request (never shared across users or quotes).
    let cart = step((await this.gql(Q_CREATE, { country, input: { lines: [{ merchandiseId: req.variantId, quantity: req.quantity }], buyerIdentity: { countryCode: country } } })).cartCreate);
    if (!cart?.id) return this.evidence(req, null, ["MERCHANT_USER_ERROR", ...issues], messages, "UNKNOWN");

    // 2. Delivery address (only country/province/zip/city/address1 the caller provided; no personal names).
    if (req.destination) {
      const d = req.destination;
      const deliveryAddress: J = { countryCode: d.countryCode.toUpperCase() };
      if (d.provinceCode) deliveryAddress.provinceCode = d.provinceCode;
      if (d.zip) deliveryAddress.zip = d.zip;
      if (d.city) deliveryAddress.city = d.city;
      if (d.address1) deliveryAddress.address1 = d.address1;
      cart = step((await this.gql(Q_ADDRESS, { country, cartId: cart.id, addresses: [{ selected: true, oneTimeUse: true, address: { deliveryAddress } }] })).cartDeliveryAddressesAdd) ?? cart;
    } else issues.add("DESTINATION_MISSING");

    // 3. Select a delivery option per group if none is selected.
    const groups: J[] = cart?.deliveryGroups?.nodes ?? [];
    const selections = groups.filter((g) => !g.selectedDeliveryOption && (g.deliveryOptions ?? []).length > 0).map((g) => {
      const opts: J[] = g.deliveryOptions;
      const chosen = req.deliveryOptionHandle ? opts.find((o) => o.handle === req.deliveryOptionHandle) : [...opts].sort((a, b) => Number(a.estimatedCost?.amount) - Number(b.estimatedCost?.amount))[0];
      return chosen ? { deliveryGroupId: g.id, deliveryOptionHandle: chosen.handle } : null;
    }).filter((x): x is { deliveryGroupId: string; deliveryOptionHandle: string } => !!x);
    if (selections.length) cart = step((await this.gql(Q_SELECT, { country, cartId: cart!.id, selected: selections })).cartSelectedDeliveryOptionsUpdate) ?? cart;

    return this.evidence(req, cart, [...issues], messages, null);
  }

  private evidence(req: QuoteRequest, cart: J | null, initial: QuoteIssue[], messages: string[], forced: QuoteEvidence["status"] | null): QuoteEvidence {
    const now = (this.cfg.now ?? Date.now)();
    const issues = new Set<QuoteIssue>(initial);
    const money = (m: J | null | undefined): { minor: number; currency: string } | null => {
      if (!m || typeof m.amount !== "string" || typeof m.currencyCode !== "string") return null;
      if (!isCurrency(m.currencyCode)) { issues.add("CURRENCY_MISMATCH"); return null; }
      try { return { minor: parseDecimalToMinor(m.amount, m.currencyCode), currency: m.currencyCode }; } catch { return null; }
    };
    const line: J | undefined = cart?.lines?.nodes?.[0];
    const v: J | undefined = line?.merchandise;
    const returnedId = typeof v?.id === "string" ? v.id : null;
    if (cart && returnedId !== req.variantId) issues.add("VARIANT_MISMATCH");
    if (cart && line && line.quantity !== req.quantity) issues.add("QUANTITY_NOT_IN_CART");
    const subtotal = money(cart?.cost?.subtotalAmount);
    const total = money(cart?.cost?.totalAmount);
    const options: QuoteDeliveryOption[] = [];
    let selected: QuoteDeliveryOption | null = null;
    const groups: J[] = cart?.deliveryGroups?.nodes ?? [];
    for (const g of groups) {
      for (const o of g.deliveryOptions ?? []) {
        const c = money(o.estimatedCost);
        if (c && isCurrency(c.currency)) options.push({ handle: String(o.handle), title: o.title ?? null, methodType: String(o.deliveryMethodType ?? "UNKNOWN"), costMinor: c.minor, currency: c.currency });
      }
      const s = g.selectedDeliveryOption ? money(g.selectedDeliveryOption.estimatedCost) : null;
      if (g.selectedDeliveryOption && s && isCurrency(s.currency)) selected = { handle: String(g.selectedDeliveryOption.handle), title: g.selectedDeliveryOption.title ?? null, methodType: String(g.selectedDeliveryOption.deliveryMethodType ?? "UNKNOWN"), costMinor: s.minor, currency: s.currency };
    }
    if (groups.length > 1) messages.push("Multiple delivery groups: only a single-group cart is supported for quoting");
    if (cart && req.destination && options.length === 0) issues.add("NO_DELIVERY_OPTIONS");
    if (cart && req.destination && options.length > 0 && !selected) issues.add("DELIVERY_OPTION_NOT_SELECTED");
    const currencies = new Set([subtotal?.currency, total?.currency, selected?.currency, ...options.map((o) => o.currency)].filter(Boolean));
    if ([...currencies].some((c) => c !== req.currency)) issues.add("CURRENCY_MISMATCH");
    const totalEstimated = typeof cart?.cost?.totalAmountEstimated === "boolean" ? cart.cost.totalAmountEstimated as boolean : null;
    if (totalEstimated !== false) issues.add("TOTAL_ESTIMATED");
    issues.add("TAX_NOT_ITEMIZED"); // The non-deprecated CartCost fields do not itemize tax.

    let checkoutUrl: string | null = null;
    if (typeof cart?.checkoutUrl === "string") {
      try {
        const u = new URL(cart.checkoutUrl);
        const hosts = [this.cfg.shopDomain, ...(this.cfg.allowedCheckoutHosts ?? [])];
        if (u.protocol === "https:" && hosts.includes(u.hostname) && !u.username && !u.password) checkoutUrl = u.toString();
        else issues.add("CHECKOUT_URL_INVALID");
      } catch { issues.add("CHECKOUT_URL_INVALID"); }
    } else if (cart) issues.add("CHECKOUT_URL_INVALID");

    const status: QuoteEvidence["status"] = forced ??
      (!cart || issues.has("VARIANT_MISMATCH") || issues.has("QUANTITY_NOT_IN_CART") || issues.has("CURRENCY_MISMATCH") || !subtotal ? "UNKNOWN"
        : v?.availableForSale === false ? "UNAVAILABLE"
        : "CART_ESTIMATE"); // FINAL_QUOTE_VERIFIED is never produced from a Storefront cart.
    if (v?.availableForSale === false) issues.add("VARIANT_UNAVAILABLE");

    return {
      status, provider: this.name, provenance: this.cfg.provenance ?? "MERCHANT_API", source: `storefront-api ${this.version}`,
      observedAt: new Date(now).toISOString(), expiresAt: new Date(now + (this.cfg.quoteTtlSeconds ?? 600) * 1000).toISOString(),
      currency: subtotal && isCurrency(subtotal.currency) ? subtotal.currency : null,
      variant: { requestedId: req.variantId, returnedId, title: v ? `${v.product?.title ?? ""} ${v.title ?? ""}`.trim() || null : null, sku: v?.sku ?? null,
        availableForSale: typeof v?.availableForSale === "boolean" ? v.availableForSale : null, quantity: typeof line?.quantity === "number" ? line.quantity : null },
      subtotalMinor: subtotal?.minor ?? null, subtotalEstimated: typeof cart?.cost?.subtotalAmountEstimated === "boolean" ? cart.cost.subtotalAmountEstimated : null,
      deliveryOptions: options, selectedDeliveryOption: selected,
      merchantTotalMinor: total?.minor ?? null, totalEstimated,
      externalCheckoutUrl: checkoutUrl,
      cartRef: typeof cart?.id === "string" ? "cart_" + createHash("sha256").update(cart.id).digest("hex").slice(0, 16) : null,
      issues: [...issues], messages,
    };
  }
}

/** Differences between two observations of the same cart quote (e.g. price moved between compare and handoff). */
export function diffQuoteObservations(a: QuoteEvidence, b: QuoteEvidence): string[] {
  const out: string[] = [];
  if (a.variant.requestedId !== b.variant.requestedId) out.push("VARIANT");
  if (a.currency !== b.currency) out.push("CURRENCY");
  if (a.subtotalMinor !== b.subtotalMinor) out.push("SUBTOTAL");
  if (a.selectedDeliveryOption?.costMinor !== b.selectedDeliveryOption?.costMinor) out.push("SHIPPING");
  if (a.merchantTotalMinor !== b.merchantTotalMinor) out.push("TOTAL");
  if (a.status !== b.status) out.push("STATUS");
  return out;
}
