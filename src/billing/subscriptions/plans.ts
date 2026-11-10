import { createHash } from "node:crypto";

/**
 * DIAPORIA Managed plan terms: a FIXED monthly price with an included usage allowance and a hard
 * spending limit. These terms are what the user authorizes when they subscribe once. Usage inside the
 * allowance needs no per-call approval; usage beyond it is DENIED (V1 has no overage billing).
 *
 * Money units: integer USD cents for DIAPORIA's service price and billed amounts. Supplier (provider)
 * costs live in the UsageLedger as micro-USD and are never mixed into these numbers.
 */
export type MeteredOperation = "CHANNEL3:search" | "TAVILY:search" | "TAVILY:extract" | "KERNEL:inspect";

export interface ManagedPlanTerms {
  /** Stable plan family key, e.g. "managed-starter". */
  planKey: string;
  /** Terms version. Changing any number requires a new version (and a new PayPal plan). */
  version: string;
  name: string;
  currency: "USD";
  /** DIAPORIA's fixed monthly service price. null = UNKNOWN: the plan cannot be created or offered. */
  monthlyPriceMinor: number | null;
  /** Service value (sum of DIAPORIA per-operation service prices) included per paid period. */
  includedAllowanceMinor: number;
  /** Optional per-operation count caps per paid period. */
  operationCaps: Partial<Record<MeteredOperation, number>>;
  /** The most DIAPORIA bills per paid period. V1: equals the fixed price, because overage is never billed. */
  hardSpendLimitMinor: number | null;
  /** V1 supports only DENY: when the allowance or a cap is used up, paid operations are refused. */
  overage: "DENY";
  /** Free-text label shown with the plan, e.g. that prices are placeholders. */
  priceLabel: string;
}

export class PlanTermsError extends Error {}

/** Validates terms. A plan with an UNKNOWN price is valid as data but `offerable` is false. */
export function validateTerms(t: ManagedPlanTerms): { offerable: boolean; reason: string | null } {
  if (!/^[a-z0-9-]{3,40}$/.test(t.planKey)) throw new PlanTermsError("planKey must be 3-40 chars of a-z, 0-9, -");
  if (!/^[A-Za-z0-9.-]{1,40}$/.test(t.version)) throw new PlanTermsError("version must be 1-40 chars of A-Z, a-z, 0-9, ., -");
  if (t.currency !== "USD") throw new PlanTermsError("only USD plans are supported in V1");
  if (t.overage !== "DENY") throw new PlanTermsError("V1 supports only overage=DENY");
  if (!Number.isSafeInteger(t.includedAllowanceMinor) || t.includedAllowanceMinor < 0) throw new PlanTermsError("includedAllowanceMinor must be a non-negative integer");
  for (const [k, v] of Object.entries(t.operationCaps)) if (!Number.isSafeInteger(v) || (v as number) < 0) throw new PlanTermsError(`operation cap ${k} must be a non-negative integer`);
  if (t.monthlyPriceMinor === null || t.hardSpendLimitMinor === null) return { offerable: false, reason: "PRICE_UNKNOWN" };
  if (!Number.isSafeInteger(t.monthlyPriceMinor) || t.monthlyPriceMinor <= 0) throw new PlanTermsError("monthlyPriceMinor must be a positive integer (cents)");
  if (t.hardSpendLimitMinor !== t.monthlyPriceMinor) throw new PlanTermsError("V1: hardSpendLimitMinor must equal monthlyPriceMinor (no overage billing)");
  return { offerable: true, reason: null };
}

/** Canonical JSON (sorted keys) of the terms, and its SHA-256. The user authorizes this digest. */
export function canonicalTerms(t: ManagedPlanTerms): string {
  const sort = (v: unknown): unknown => Array.isArray(v) ? v.map(sort) : v && typeof v === "object"
    ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])])) : v;
  return JSON.stringify(sort(t));
}
export function termsDigest(t: ManagedPlanTerms): string { return createHash("sha256").update(canonicalTerms(t)).digest("hex"); }

/**
 * Production catalog: prices are UNKNOWN until Eric decides them. Every plan here is NOT offerable,
 * so a misconfigured deployment fails closed instead of charging an invented price.
 */
export const MANAGED_PLANS_PRICES_UNKNOWN: readonly ManagedPlanTerms[] = Object.freeze([{
  planKey: "managed-starter", version: "v1-price-unknown", name: "DIAPORIA Managed Starter", currency: "USD",
  monthlyPriceMinor: null, includedAllowanceMinor: 0, operationCaps: {}, hardSpendLimitMinor: null, overage: "DENY",
  priceLabel: "Price not decided (UNKNOWN). This plan cannot be offered.",
}]);

/**
 * Labelled placeholder catalog for MOCK demos, tests and (owner-approved) Sandbox runs.
 * These are NOT real DIAPORIA prices and NOT supplier prices.
 */
export const MANAGED_PLANS_PLACEHOLDER: readonly ManagedPlanTerms[] = Object.freeze([{
  planKey: "managed-starter", version: "v1-placeholder-not-real-prices", name: "DIAPORIA Managed Starter (placeholder)", currency: "USD",
  monthlyPriceMinor: 900, includedAllowanceMinor: 300, operationCaps: { "CHANNEL3:search": 120, "TAVILY:search": 60, "KERNEL:inspect": 20 },
  hardSpendLimitMinor: 900, overage: "DENY", priceLabel: "PLACEHOLDER price for tests and demos. Not a real DIAPORIA price.",
}]);
