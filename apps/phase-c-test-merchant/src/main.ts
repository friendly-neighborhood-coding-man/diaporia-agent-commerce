/**
 * Entry point: `npm run merchant:start` (MOCK by default). Sandbox modes refuse to start without an owner
 * approval digest that matches this exact configuration (see docs/PHASE_C_OPERATOR_CHECKLIST.md).
 */
import { ConfigRefusedError, loadMerchantConfig } from "./config.js";
import { startMerchantServer } from "./server.js";

async function main() {
  let config;
  try { config = loadMerchantConfig(process.env); }
  catch (e) {
    console.error(e instanceof ConfigRefusedError ? `REFUSED ${e.message}` : `REFUSED ${(e as Error).message}`);
    process.exit(2);
  }
  const m = await startMerchantServer({ config });
  // Never print secrets: only mode, origin, digest prefix and counters.
  console.log(JSON.stringify({ event: "MERCHANT_STARTED", mode: config.mode, listening: `${config.listenHost}:${(m.server.address() as any).port}`, origin: m.origin,
    approvalDigestPrefix: config.approval?.digest.slice(0, 12) ?? null, approvalExpiresAt: config.approval ? new Date(config.approval.expiresAtMs).toISOString() : null,
    counters: m.checkout.counters(), statusSigned: !!config.statusSecret }));
  let stopping = false;
  const stop = async (sig: string) => {
    if (stopping) return; stopping = true;
    await m.close();
    console.log(JSON.stringify({ event: "MERCHANT_STOPPED", signal: sig }));
    process.exit(0);
  };
  process.on("SIGINT", () => void stop("SIGINT"));
  process.on("SIGTERM", () => void stop("SIGTERM"));
  // An approval window ends the Sandbox process: no orders after expiry, and no forgotten long-running test merchant.
  if (config.approval) setTimeout(() => void stop("APPROVAL_EXPIRED"), Math.max(0, config.approval.expiresAtMs - Date.now())).unref();
}
void main();
