/**
 * Prints the exact Phase C approval statement and its SHA-256 digest. NO network, NO PayPal, NO KERNEL.
 * The owner approves the DIGEST; the operator then sets PHASE_C_APPROVED_DIGEST (+ the same parameters) on the merchant
 * AND on DIAPORIA (which uses the digest as the run id of its durable KERNEL browser-creation ledger).
 * Any change (origin, allowlist, seller id, data dir, time window, limits) produces a different digest and the merchant refuses to start.
 *
 * Run from a CLEAN checkout after `npm ci && npm run build`: the statement pins the git commit and the hashes of the built
 * merchant (dist-merchant/) and DIAPORIA (dist/src/) artifacts, which each side recomputes from its own code at startup.
 * The owner then signs the digest on their own machine (npm run phase-c:sign); a digest alone is only a checksum.
 *
 *   npm run phase-c:approval -- --gate C1 --origin https://shop.example.com --seller-merchant-id <SANDBOX_BUSINESS_MERCHANT_ID> \
 *       --data-dir /srv/phase-c/c1-run-1 --expires 2026-11-11T12:00:00Z --merchant-host <hostname> --diaporia-host <hostname> \
 *       --diaporia-user <os user> --owner-public-key owner-ed25519.pub.pem [--max-minutes 10] [--kernel-usd-estimate 0.50]
 *   npm run phase-c:approval -- --gate C2 (same arguments, a NEW --data-dir; separate digest)
 *   npm run phase-c:approval -- --gate C2_CAPTURE_RETRY --c2-digest <C2 digest> --cart <cartRef> --order-ref <PHC-...>
 *       (only after a read-only GET /operator/reconcile proved the order APPROVED with no capture)
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadOwnerPublicKey, merchantArtifactSha256 } from "../apps/phase-c-test-merchant/src/integrity.js";
import { diaporiaArtifactSha256 } from "../src/handoff/phaseCApproval.js";
import { DEFAULT_ALLOWLIST_PATH, approvalDigest, buildApprovalStatement, buildCaptureRetryStatement, loadAllowlist, parsePublicOrigin, type Gate } from "../apps/phase-c-test-merchant/src/config.js";

const arg = (k: string): string | undefined => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
const fail = (m: string): never => { console.error(m); process.exit(2); };
const gate = (arg("gate") ?? "").toUpperCase();

if (gate === "C2_CAPTURE_RETRY") {
  const statement = buildCaptureRetryStatement({ c2ApprovalDigest: arg("c2-digest") ?? "", cartRef: arg("cart") ?? "", merchantOrderRef: arg("order-ref") ?? "" });
  const digest = approvalDigest(statement);
  console.log(JSON.stringify({ statement, digest }, null, 2));
  console.log(`\n# After the owner approves digest ${digest}, the operator sends it ONCE (it is not an env var):`);
  console.log(`# curl -sS -X POST -H "Authorization: Bearer $MERCHANT_OPERATOR_KEY" -H "Content-Type: application/json" \\\n#   -d '{"cartRef":"${statement.cartRef}","retryApprovalDigest":"${digest}","ownerSignature":"<npm run phase-c:sign -- --purpose capture-retry>"}' <origin>/operator/c2/retry-capture`);
  process.exit(0);
}
if (gate !== "C1" && gate !== "C2") fail("--gate C1|C2|C2_CAPTURE_RETRY is required");
const origin = parsePublicOrigin(arg("origin"));
const expires = arg("expires") ?? fail("--expires <ISO-8601> is required (at most 24 h after the merchant starts)");
const seller = arg("seller-merchant-id") ?? fail("--seller-merchant-id (the Sandbox BUSINESS account's merchant id) is required for every gate");
const dataDir = arg("data-dir") ?? fail("--data-dir <absolute path, new and empty for this approval> is required");
const git = (...a: string[]) => execFileSync("git", a, { encoding: "utf8" }).trim();
const sourceCommit = arg("source-commit") ?? git("rev-parse", "HEAD");
if (!arg("source-commit") && git("status", "--porcelain")) fail("the working tree is not clean: commit or stash first, so sourceCommit describes the built code");
const merchantDir = resolve(arg("merchant-artifact-dir") ?? "dist-merchant/apps/phase-c-test-merchant/src");
const diaporiaDir = resolve(arg("diaporia-artifact-dir") ?? "dist/src");
if (!existsSync(merchantDir) || !existsSync(diaporiaDir)) fail("built artifacts missing: run npm run build first (or pass --merchant-artifact-dir / --diaporia-artifact-dir)");
const ownerKeyFile = arg("owner-public-key") ?? fail("--owner-public-key <owner-ed25519.pub.pem> is required (npm run phase-c:sign -- --gen-key on the owner's machine)");
const allowlist = loadAllowlist(readFileSync(process.env.MERCHANT_ALLOWLIST_FILE || DEFAULT_ALLOWLIST_PATH, "utf8"));
const statement = buildApprovalStatement({ gate: gate as Gate, merchantOrigin: origin, allowlist, sellerMerchantId: seller, merchantDataDir: dataDir,
  maxMinutes: Number(arg("max-minutes") ?? 10), kernelUsdEstimate: arg("kernel-usd-estimate") ?? "0.50", expiresAt: expires,
  sourceCommit, merchantArtifactSha256: merchantArtifactSha256(merchantDir), diaporiaArtifactSha256: diaporiaArtifactSha256(diaporiaDir),
  merchantHost: arg("merchant-host") ?? fail("--merchant-host <hostname of the merchant machine> is required"),
  diaporiaHost: arg("diaporia-host") ?? fail("--diaporia-host <hostname of the DIAPORIA machine> is required"),
  diaporiaServiceUser: arg("diaporia-user") ?? fail("--diaporia-user <OS account that runs DIAPORIA> is required"),
  ownerPublicKeySha256: loadOwnerPublicKey(readFileSync(ownerKeyFile, "utf8")).sha256 });
const digest = approvalDigest(statement);
console.log(JSON.stringify({ statement, digest }, null, 2));
console.log(`\n# kernelUsdEstimateNotEnforced is an estimate only: nothing here can stop KERNEL billing. Set an account-side limit and supervise the run.`);
console.log(`\n# After the owner approves digest ${digest}, set on the merchant host (never commit these):`);
console.log(`MERCHANT_CHECKOUT_MODE=${statement.mode}\nMERCHANT_PUBLIC_ORIGIN=${origin}\nMERCHANT_DATA_DIR=${statement.merchantDataDir}\nPHASE_C_APPROVAL_EXPIRES_AT=${statement.expiresAt}\nPHASE_C_MAX_MINUTES=${statement.maxMinutes}\nPHASE_C_KERNEL_USD_ESTIMATE=${statement.kernelUsdEstimateNotEnforced}\nPHASE_C_SOURCE_COMMIT=${sourceCommit}\nPHASE_C_DIAPORIA_ARTIFACT_SHA256=${statement.diaporiaArtifactSha256}\nPHASE_C_DIAPORIA_HOST=${statement.diaporiaHost}\nPHASE_C_DIAPORIA_SERVICE_USER=${statement.diaporiaServiceUser}\nPHASE_C_OWNER_PUBLIC_KEY_FILE=<path to owner-ed25519.pub.pem>\nPHASE_C_APPROVED_DIGEST=${digest}\nPHASE_C_APPROVAL_SIGNATURE=<owner's signature from npm run phase-c:sign -- --purpose approval>`);
console.log(`\n# And on the DIAPORIA host (save the JSON above as the statement file; KERNEL ledger: max ${statement.kernelBrowsers} browser for this digest, ever):\nPHASE_C_APPROVAL_STATEMENT_FILE=<path>\nPHASE_C_OWNER_PUBLIC_KEY_FILE=<path>\nPHASE_C_APPROVED_DIGEST=${digest}\nPHASE_C_APPROVAL_SIGNATURE=<same signature>`);
