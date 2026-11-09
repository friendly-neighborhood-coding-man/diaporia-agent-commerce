/**
 * SYNTHETIC Shopify Storefront responses shaped after the documented 2026-10 schema. They are NOT
 * recorded from a real store. Used for offline tests and the demo; evidence is labelled FIXTURE.
 */
export const FIXTURE_SHOP = "diaporia-demo-dev.myshopify.com";
export const FIXTURE_VARIANT = "gid://shopify/ProductVariant/44440000000001";

export type ShopifyScenario =
  | "OK_TWO_RATES" | "ESTIMATED_TOTAL" | "UNAVAILABLE" | "VARIANT_MISMATCH" | "CURRENCY_MISMATCH" | "NO_RATES"
  | "THROTTLED" | "TIMEOUT" | "HTTP_500" | "BAD_CHECKOUT_URL" | "USER_ERROR";

export interface FixtureState { carts: number; calls: Array<{ op: string; variables: Record<string, any> }>; priceMinor: number }

const money = (minor: number, cur = "USD") => ({ amount: (minor / 100).toFixed(2), currencyCode: cur });

export function shopifyFixtureFetch(scenario: ShopifyScenario, state: FixtureState = { carts: 0, calls: [], priceMinor: 5499 }): typeof fetch {
  return (async (_url: string | URL, init: RequestInit = {}) => {
    const { query, variables } = JSON.parse(String(init.body)) as { query: string; variables: Record<string, any> };
    const op = /cartCreate/.test(query) ? "cartCreate" : /cartDeliveryAddressesAdd/.test(query) ? "cartDeliveryAddressesAdd" : /cartSelectedDeliveryOptionsUpdate/.test(query) ? "cartSelectedDeliveryOptionsUpdate" : "unknown";
    state.calls.push({ op, variables });
    if (scenario === "TIMEOUT") throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    if (scenario === "HTTP_500") return new Response("oops", { status: 500 });
    if (scenario === "THROTTLED") return Response.json({ errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] });
    const cartNo = op === "cartCreate" ? ++state.carts : state.carts;
    const cartId = `gid://shopify/Cart/fixture${cartNo}?key=secretkey${cartNo}`;
    const cur = scenario === "CURRENCY_MISMATCH" ? "CAD" : "USD";
    const qty = (state.calls.find((c) => c.op === "cartCreate")?.variables.input as any)?.lines?.[0]?.quantity ?? 1;
    const variantId = scenario === "VARIANT_MISMATCH" ? "gid://shopify/ProductVariant/44440000000999" : (state.calls.find((c) => c.op === "cartCreate")?.variables.input as any)?.lines?.[0]?.merchandiseId;
    const hasAddress = state.calls.some((c) => c.op === "cartDeliveryAddressesAdd");
    const selectedHandle = [...state.calls].reverse().find((c) => c.op === "cartSelectedDeliveryOptionsUpdate")?.variables.selected?.[0]?.deliveryOptionHandle as string | undefined;
    const options = !hasAddress || scenario === "NO_RATES" ? [] : [
      { handle: "rate-standard", title: "Standard", code: "STANDARD", deliveryMethodType: "SHIPPING", estimatedCost: money(599, cur) },
      { handle: "rate-express", title: "Express", code: "EXPRESS", deliveryMethodType: "SHIPPING", estimatedCost: money(1499, cur) },
    ];
    const selected = options.find((o) => o.handle === selectedHandle) ?? null;
    const subtotal = state.priceMinor * qty;
    const total = subtotal + (selected ? Number(selected.estimatedCost.amount) * 100 : 0);
    const cart = {
      id: cartId,
      checkoutUrl: scenario === "BAD_CHECKOUT_URL" ? "https://pay-here.example/checkout/abc" : `https://${FIXTURE_SHOP}/cart/c/fixture${cartNo}?key=secretkey${cartNo}`,
      totalQuantity: qty,
      buyerIdentity: { countryCode: variables.country ?? "US" },
      lines: { nodes: [{ quantity: qty, merchandise: { id: variantId, title: "Black", sku: "DEMO-HP-BLK", availableForSale: scenario !== "UNAVAILABLE", product: { title: "Sony WH-CH720N (synthetic fixture listing)" } } }] },
      cost: { subtotalAmount: money(subtotal, cur), subtotalAmountEstimated: false, totalAmount: money(Math.round(total), cur),
        totalAmountEstimated: scenario === "ESTIMATED_TOTAL" ? true : !selected },
      deliveryGroups: { nodes: hasAddress ? [{ id: "gid://shopify/CartDeliveryGroup/1", deliveryOptions: options, selectedDeliveryOption: selected }] : [] },
    };
    const userErrors = scenario === "USER_ERROR" && op === "cartCreate" ? [{ code: "INVALID", field: ["input", "lines"], message: "Merchandise not found" }] : [];
    return Response.json({ data: { [op]: { cart: userErrors.length ? null : cart, userErrors, warnings: [] } } });
  }) as typeof fetch;
}
