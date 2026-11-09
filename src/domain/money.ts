/**
 * Money is always integer minor units (cents for USD). Floating-point amounts are
 * never stored, compared, or sent to a payment provider.
 */
export const CURRENCY_EXPONENT = { USD: 2, EUR: 2, GBP: 2, JPY: 0, KRW: 0 } as const;
export type Currency = keyof typeof CURRENCY_EXPONENT;
export const CURRENCIES = Object.keys(CURRENCY_EXPONENT) as Currency[];

/** Hard upper bound for any single amount handled by the demo engine (1,000,000.00 USD). */
export const MAX_MINOR = 100_000_000;

export function isCurrency(value: unknown): value is Currency {
  return typeof value === "string" && Object.hasOwn(CURRENCY_EXPONENT, value);
}

export function isMinor(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_MINOR;
}

export function assertMinor(value: unknown, label: string): number {
  if (!isMinor(value)) throw new MoneyError(`${label} must be a non-negative integer number of minor units`);
  return value;
}

/** Parses a human decimal string such as "59.99" into minor units without float math. */
export function parseDecimalToMinor(text: string, currency: Currency): number {
  const exp = CURRENCY_EXPONENT[currency];
  const cleaned = text.replace(/,/g, "").trim();
  const match = /^(\d{1,9})(?:\.(\d+))?$/.exec(cleaned);
  if (!match) throw new MoneyError(`Unparseable amount: ${text}`);
  const whole = match[1]!;
  const frac = match[2] ?? "";
  if (frac.length > exp) throw new MoneyError(`Amount ${text} has more decimals than ${currency} allows`);
  const minor = Number(whole) * 10 ** exp + Number(frac.padEnd(exp, "0") || "0");
  return assertMinor(minor, "amount");
}

/** Formats minor units to the decimal string PayPal expects ("59.39"). */
export function formatMinor(minor: number, currency: Currency): string {
  assertMinor(minor, "amount");
  const exp = CURRENCY_EXPONENT[currency];
  if (exp === 0) return String(minor);
  const s = String(minor).padStart(exp + 1, "0");
  return `${s.slice(0, -exp)}.${s.slice(-exp)}`;
}

/** Sums components; returns null when any component is unknown (null). Unknown is never zero. */
export function sumKnown(parts: Array<number | null>): number | null {
  let total = 0;
  for (const p of parts) {
    if (p === null) return null;
    total += assertMinor(p, "component");
  }
  return assertMinor(total, "total");
}

export class MoneyError extends Error {}
