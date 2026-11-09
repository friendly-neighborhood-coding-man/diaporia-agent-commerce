const SENSITIVE_KEY = /^(?:.*secret.*|.*password.*|authorization|.*api[-_]?key.*|client[-_]?id|cookie|set-cookie|.*owner[-_]?key.*|.*credential.*|.*access[-_]?token.*|.*refresh[-_]?token.*|bearer|id[-_]?token)$/i;
const SENSITIVE_VALUE = [
  /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/g,
  /\bA21AA[A-Za-z0-9_-]{20,}/g, // PayPal access-token shape
  /\b(?:sk|pk|dct|dok)_[A-Za-z0-9]{16,}/g,
];

/** Deep-redacts sensitive keys and token-shaped values before logging or returning data. */
export function redact<T>(value: T, depth = 0): T {
  if (depth > 8) return "[TRUNCATED]" as T;
  if (typeof value === "string") {
    let s: string = value;
    for (const re of SENSITIVE_VALUE) s = s.replace(re, "[REDACTED]");
    return s as T;
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = SENSITIVE_KEY.test(k) ? "[REDACTED]" : redact(v, depth + 1);
    return out as T;
  }
  return value;
}
