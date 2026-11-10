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

/**
 * IR-10 (WP-5). Strict parser for amounts a HUMAN types as a spending limit (owner authorization page, handoff
 * maximum). Unlike parseDecimalToMinor (machine input: provider and merchant prices that may carry thousands
 * separators), it never guesses: only ASCII digits, an optional dot and at most the currency's decimals. Commas
 * (either meaning), any whitespace, non-ASCII or full-width digits, signs and exponents are refused, so "60,00" can
 * never become 6,000.00.
 */
export function parseOwnerAmountToMinor(text: string, currency: Currency): number {
  const exp = CURRENCY_EXPONENT[currency];
  const pattern = exp === 0 ? /^[0-9]{1,9}$/ : new RegExp(`^[0-9]{1,9}(?:\\.[0-9]{1,${exp}})?$`);
  if (typeof text !== "string" || !pattern.test(text)) throw new MoneyError(OWNER_AMOUNT_HELP[exp === 0 ? 0 : 1]!.replace("{c}", currency));
  const [whole, frac = ""] = text.split(".");
  const minor = Number(whole) * 10 ** exp + Number(frac.padEnd(exp, "0") || "0");
  return assertMinor(minor, "amount");
}
const OWNER_AMOUNT_HELP = [
  "Enter a whole number of {c} using digits only, for example 6000. No commas, spaces or decimals.",
  "Enter the amount with a dot as the decimal separator, for example 60.00. No commas or spaces.",
];

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
