import type { BusinessIdentifier, IdentifierScheme } from "./types.js";

const KR_WEIGHTS = [1, 3, 7, 1, 3, 7, 1, 3, 5];

/** Korean business registration number (사업자등록번호) check digit. A valid checksum proves nothing about identity. */
export function krBrnChecksumValid(digits: string): boolean {
  if (!/^\d{10}$/.test(digits)) return false;
  const d = [...digits].map(Number);
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += d[i]! * KR_WEIGHTS[i]!;
  sum += Math.floor((d[8]! * 5) / 10);
  return (10 - (sum % 10)) % 10 === d[9];
}

export type NormalizeResult = { ok: true; identifier: BusinessIdentifier } | { ok: false; reason: string };

/** Normalizes separators away and validates the format. Format validity is NOT identity verification. */
export function normalizeIdentifier(scheme: IdentifierScheme, raw: string): NormalizeResult {
  const digits = String(raw ?? "").replace(/[\s-]/g, "");
  if (!/^\d+$/.test(digits)) return { ok: false, reason: "Identifier contains non-digit characters" };
  if (scheme === "KR_BRN") {
    if (digits.length !== 10) return { ok: false, reason: "KR business registration number must have 10 digits" };
    if (!krBrnChecksumValid(digits)) return { ok: false, reason: "KR business registration number check digit is invalid" };
    return { ok: true, identifier: { scheme, value: digits } };
  }
  if (digits.length !== 9) return { ok: false, reason: "US EIN must have 9 digits" };
  return { ok: true, identifier: { scheme, value: digits } };
}

/** Masked form for outputs: enough to recognize, not enough to reuse. */
export function maskIdentifier(id: BusinessIdentifier): string {
  return id.scheme === "KR_BRN" ? `${id.value.slice(0, 3)}-${id.value.slice(3, 5)}-*****` : `**-***${id.value.slice(-4)}`;
}

export function sameIdentifier(a: BusinessIdentifier, b: BusinessIdentifier): boolean {
  return a.scheme === b.scheme && a.value === b.value;
}

/** Legal-name comparison: case, punctuation, and common corporate suffixes are ignored. */
export function normalizeLegalName(name: string): string {
  return name.normalize("NFKC").toLowerCase()
    .replace(/주식회사|\(주\)|유한회사/g, " ")
    .replace(/[.,'"()]/g, " ")
    .replace(/\b(co|ltd|limited|inc|incorporated|llc|corp|corporation|company)\b/g, " ")
    .replace(/\s+/g, " ").trim();
}
