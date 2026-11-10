/**
 * Prints the exact Phase C approval statement and its SHA-256 digest. NO network, NO PayPal, NO KERNEL.
 * The owner approves the DIGEST; the operator then sets PHASE_C_APPROVED_DIGEST (+ the same parameters) on the merchant
 * AND on DIAPORIA (which uses the digest as the run id of its durable KERNEL browser-creation ledger).
 * Any change (origin, allowlist, seller id, data dir, time window, limits) produces a different digest and the merchant refuses to start.
 *
 *   npm run phase-c:approval -- --gate C1 --origin https://shop.example.com --seller-merchant-id <SANDBOX_BUSINESS_MERCHANT_ID> \
 *       --data-dir /srv/phase-c/c1-run-1 --expires 2026-11-11T12:00:00Z [--max-minutes 10] [--kernel-usd-estimate 0.50]
 *   npm run phase-c:approval -- --gate C2 (same arguments, a NEW --data-dir; separate digest)
 *   npm run phase-c:approval -- --gate C2_CAPTURE_RETRY --c2-digest <C2 digest> --cart <cartRef> --order-ref <PHC-...>
 *       (only after a read-only GET /operator/reconcile proved the order APPROVED with no capture)
 */
import { readFileSync } from "node:fs";
import { DEFAULT_ALLOWLIST_PATH, approvalDigest, buildApprovalStatement, buildCaptureRetryStatement, loadAllowlist, parsePublicOrigin, type Gate } from "../apps/phase-c-test-merchant/src/config.js";

const arg = (k: string): string | undefined => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
const fail = (m: string): never => { console.error(m); process.exit(2); };
const gate = (arg("gate") ?? "").toUpperCase();

if (gate === "C2_CAPTURE_RETRY") {
  const statement = buildCaptureRetryStatement({ c2ApprovalDigest: arg("c2-digest") ?? "", cartRef: arg("cart") ?? "", merchantOrderRef: arg("order-ref") ?? "" });
  const digest = approvalDigest(statement);
  console.log(JSON.stringify({ statement, digest }, null, 2));
  console.log(`\n# After the owner approves digest ${digest}, the operator sends it ONCE (it is not an env var):`);
  console.log(`# curl -sS -X POST -H "Authorization: Bearer $MERCHANT_OPERATOR_KEY" -H "Content-Type: application/json" \\\n#   -d '{"cartRef":"${statement.cartRef}","retryApprovalDigest":"${digest}"}' <origin>/operator/c2/retry-capture`);
  process.exit(0);
}
if (gate !== "C1" && gate !== "C2") fail("--gate C1|C2|C2_CAPTURE_RETRY is required");
const origin = parsePublicOrigin(arg("origin"));
const expires = arg("expires") ?? fail("--expires <ISO-8601> is required (at most 24 h after the merchant starts)");
const seller = arg("seller-merchant-id") ?? fail("--seller-merchant-id (the Sandbox BUSINESS account's merchant id) is required for every gate");
const dataDir = arg("data-dir") ?? fail("--data-dir <absolute path, new and empty for this approval> is required");
const allowlist = loadAllowlist(readFileSync(process.env.MERCHANT_ALLOWLIST_FILE || DEFAULT_ALLOWLIST_PATH, "utf8"));
const statement = buildApprovalStatement({ gate: gate as Gate, merchantOrigin: origin, allowlist, sellerMerchantId: seller, merchantDataDir: dataDir,
  maxMinutes: Number(arg("max-minutes") ?? 10), kernelUsdEstimate: arg("kernel-usd-estimate") ?? "0.50", expiresAt: expires });
const digest = approvalDigest(statement);
console.log(JSON.stringify({ statement, digest }, null, 2));
console.log(`\n# kernelUsdEstimateNotEnforced is an estimate only: nothing here can stop KERNEL billing. Set an account-side limit and supervise the run.`);
console.log(`\n# After the owner approves digest ${digest}, set on the merchant host (never commit these):`);
console.log(`MERCHANT_CHECKOUT_MODE=${statement.mode}\nMERCHANT_PUBLIC_ORIGIN=${origin}\nMERCHANT_DATA_DIR=${statement.merchantDataDir}\nPHASE_C_APPROVAL_EXPIRES_AT=${statement.expiresAt}\nPHASE_C_MAX_MINUTES=${statement.maxMinutes}\nPHASE_C_KERNEL_USD_ESTIMATE=${statement.kernelUsdEstimateNotEnforced}\nPHASE_C_APPROVED_DIGEST=${digest}`);
console.log(`\n# And on the DIAPORIA host (KERNEL ledger run id; max ${statement.kernelBrowsers} browser for this digest, ever):\nPHASE_C_APPROVED_DIGEST=${digest}`);
