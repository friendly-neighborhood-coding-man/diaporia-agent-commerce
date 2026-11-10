/**
 * Prints the exact Phase C approval statement and its SHA-256 digest. NO network, NO PayPal, NO KERNEL.
 * The owner approves the DIGEST; the operator then sets PHASE_C_APPROVED_DIGEST (+ the same parameters) on the merchant.
 * Any change (origin, allowlist, seller id, time window, limits) produces a different digest and the merchant refuses to start.
 *
 *   npm run phase-c:approval -- --gate C1 --origin https://shop.example.com --seller-merchant-id <SANDBOX_BUSINESS_MERCHANT_ID> --expires 2026-11-11T12:00:00Z [--max-minutes 10] [--max-kernel-usd 0.50]
 *   npm run phase-c:approval -- --gate C2 (same arguments; separate digest)
 */
import { readFileSync } from "node:fs";
import { DEFAULT_ALLOWLIST_PATH, approvalDigest, buildApprovalStatement, loadAllowlist, parsePublicOrigin, type Gate } from "../apps/phase-c-test-merchant/src/config.js";

const arg = (k: string): string | undefined => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
const gate = (arg("gate") ?? "").toUpperCase() as Gate;
if (gate !== "C1" && gate !== "C2") { console.error("--gate C1|C2 is required"); process.exit(2); }
const origin = parsePublicOrigin(arg("origin"));
const expires = arg("expires");
if (!expires) { console.error("--expires <ISO-8601> is required (at most 24 h after the merchant starts)"); process.exit(2); }
const allowlist = loadAllowlist(readFileSync(process.env.MERCHANT_ALLOWLIST_FILE || DEFAULT_ALLOWLIST_PATH, "utf8"));
const seller = arg("seller-merchant-id") ?? null;
if (!seller) { console.error("--seller-merchant-id (the Sandbox BUSINESS account's merchant id) is required for every gate"); process.exit(2); }
const statement = buildApprovalStatement({ gate, merchantOrigin: origin, allowlist, sellerMerchantId: seller,
  maxMinutes: Number(arg("max-minutes") ?? 10), maxKernelUsd: arg("max-kernel-usd") ?? "0.50", expiresAt: expires });
const digest = approvalDigest(statement);
console.log(JSON.stringify({ statement, digest }, null, 2));
console.log(`\n# After the owner approves digest ${digest}, set on the merchant host (never commit these):`);
console.log(`MERCHANT_CHECKOUT_MODE=${statement.mode}\nMERCHANT_PUBLIC_ORIGIN=${origin}\nPHASE_C_APPROVAL_EXPIRES_AT=${statement.expiresAt}\nPHASE_C_MAX_MINUTES=${statement.maxMinutes}\nPHASE_C_MAX_KERNEL_USD=${statement.maxKernelUsd}\nPHASE_C_APPROVED_DIGEST=${digest}`);
