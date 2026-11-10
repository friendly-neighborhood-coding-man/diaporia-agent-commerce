/**
 * Owner-side helper: creates a purchase mandate on a running local server using the
 * owner key from .data/dev-credentials.json (or DIAPORIA_OWNER_KEY).
 *   npm run mandate:create -- --brand Sony --model WH-CH720N --variant Black --sku WHCH720N/B --max 60.00 [--auto-use]
 */
import { readFileSync, existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { parseDecimalToMinor } from "../src/domain/money.js";

const { values } = parseArgs({ options: {
  url: { type: "string", default: process.env.DIAPORIA_URL ?? "http://127.0.0.1:8790" },
  brand: { type: "string" }, model: { type: "string" }, variant: { type: "string" }, sku: { type: "string" },
  condition: { type: "string", default: "new" }, currency: { type: "string", default: "USD" },
  max: { type: "string" }, "auto-use": { type: "boolean", default: false }, quantity: { type: "string", default: "1" }, transactions: { type: "string", default: "1" }, ttl: { type: "string", default: "3600" },
} });
if (!values.brand || !values.model || !values.max) { console.error("Required: --brand --model --max (e.g. 60.00)"); process.exit(2); }
const ownerKey = process.env.DIAPORIA_OWNER_KEY ?? (existsSync(".data/dev-credentials.json") ? JSON.parse(readFileSync(".data/dev-credentials.json", "utf8")).ownerKey : undefined);
if (!ownerKey) { console.error("No owner key: start the server once (it writes .data/dev-credentials.json) or set DIAPORIA_OWNER_KEY."); process.exit(2); }
const body = {
  productIdentity: { brand: values.brand, model: values.model, variant: values.variant ?? null, condition: values.condition, sku: values.sku ?? null },
  currency: values.currency, maximumTotalMinor: parseDecimalToMinor(values.max, values.currency as "USD"),
  maximumQuantity: Number(values.quantity), maximumTransactions: Number(values.transactions), ttlSeconds: Number(values.ttl),
  // Without --auto-use (default) the AI still needs a per-checkout owner authorization; this mandate only caps it.
  autoUse: values["auto-use"] === true,
};
const r = await fetch(`${values.url}/owner/mandates`, { method: "POST", headers: { "Content-Type": "application/json", "X-Owner-Key": ownerKey }, body: JSON.stringify(body) });
console.log(r.status, JSON.stringify(await r.json(), null, 2));
