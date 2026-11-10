/**
 * The ONE product this test merchant sells. Fictional brand, fixed USD price, immutable SKU/variant/quantity.
 * Aligned with DIAPORIA's research fixture `off_lumen_q3` (merchant domain bravo-electronics.example,
 * EXTERNAL_CHECKOUT_ONLY, listing price $95.00) so the existing research -> compare -> prepare_browser_checkout
 * contract reaches it without changing any DIAPORIA fixture.
 *
 * No physical goods exist and none will ever ship.
 */
export const PRODUCT = Object.freeze({
  offerId: "off_lumen_q3",
  brand: "Lumen",
  model: "Q3",
  title: "Lumen Q3 Wireless Headphones",
  variant: "Black",
  condition: "New",
  sku: "LUM-Q3-B",
  /** Quantity is locked: every order is exactly one unit. */
  quantity: 1,
  currency: "USD" as const,
  unitMinor: 9500,
  shippingMinor: 500,
  /** Flat 8.00% test tax on the item subtotal, rounded half-up to the cent. */
  taxBps: 800,
  description: "Fictional test listing for DIAPORIA Phase C. Not for sale. No goods will be shipped.",
});

/** DIAPORIA merchant domain this store represents in the research fixtures. */
export const MERCHANT_DOMAIN = "bravo-electronics.example";

export interface Totals { subtotalMinor: number; shippingMinor: number; taxMinor: number; totalMinor: number; currency: "USD" }

/** Server-side totals. Browser-submitted prices are never read anywhere in this app. */
export function computeTotals(unitMinor: number, quantity: number): Totals {
  if (!Number.isSafeInteger(unitMinor) || unitMinor <= 0 || !Number.isSafeInteger(quantity) || quantity < 1) throw new Error("invalid line");
  const subtotalMinor = unitMinor * quantity;
  const taxMinor = Math.floor((subtotalMinor * PRODUCT.taxBps + 5_000) / 10_000);
  return { subtotalMinor, shippingMinor: PRODUCT.shippingMinor, taxMinor, totalMinor: subtotalMinor + PRODUCT.shippingMinor + taxMinor, currency: PRODUCT.currency };
}

/** The fixed total of a correct one-unit order: $95.00 + $5.00 + $7.60 = $107.60. */
export const FIXED_TOTAL_MINOR = computeTotals(PRODUCT.unitMinor, PRODUCT.quantity).totalMinor;

export const formatUsd = (minor: number): string => `$${(minor / 100).toFixed(2)}`;
/** PayPal Orders v2 decimal string ("107.60"). */
export const toValue = (minor: number): string => (minor / 100).toFixed(2);
export function fromValue(v: unknown): number | null {
  if (typeof v !== "string" || !/^\d{1,7}\.\d{2}$/.test(v)) return null;
  const [a, b] = v.split(".");
  return Number(a) * 100 + Number(b);
}
