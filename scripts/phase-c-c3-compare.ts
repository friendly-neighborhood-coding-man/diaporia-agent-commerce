/**
 * C3 (read-only, offline comparison): checks that the merchant and DIAPORIA report the same outcome.
 * Inputs are two JSON files the operator saved: the merchant's /api/orders/status body and DIAPORIA's
 * get_browser_checkout_status result. No network.
 *
 *   npm run phase-c:c3-compare -- --merchant merchant-status.json --diaporia diaporia-status.json
 */
import { readFileSync } from "node:fs";
import { expectedDiaporiaOutcome } from "../src/handoff/phaseCMerchant.js";

const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
const mFile = arg("merchant"), dFile = arg("diaporia");
if (!mFile || !dFile) { console.error("--merchant <file> --diaporia <file> required"); process.exit(2); }
const m = JSON.parse(readFileSync(mFile, "utf8"));
const d = JSON.parse(readFileSync(dFile, "utf8"));
const sellerConfigured = !!d.sellerConfirmation || !(d.observation?.discrepancies ?? []).includes("NO_AUTHORITATIVE_SELLER_SOURCE_FOR_MERCHANT");
const expected = expectedDiaporiaOutcome(m.state, sellerConfigured);
const checks = {
  sameCart: m.cartRef === d.capturedCart?.cartRef,
  sameTotal: m.totalMinor === d.capturedCart?.totalMinor,
  outcomeConsistent: d.state === expected,
  fulfillmentNotClaimed: m.fulfillment === "NOT_VERIFIED",
  diaporiaCreatedNoPaymentOrder: d.diaporiaCreatedPaymentOrder === false,
};
const ok = Object.values(checks).every(Boolean);
console.log(JSON.stringify({ result: ok ? "C3_CONSISTENT" : "C3_MISMATCH_HOLD", merchantState: m.state, diaporiaState: d.state, expectedDiaporiaState: expected, checks }, null, 2));
process.exit(ok ? 0 : 1);
