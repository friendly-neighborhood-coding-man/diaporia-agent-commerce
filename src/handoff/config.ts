import { readFileSync } from "node:fs";
import type { HandoffConfig } from "./BrowserCheckoutHandoff.js";
import { KernelDriver, LocalFixtureDriver, launchLocalChromium } from "./drivers.js";
import { MerchantRecipeRegistry, type MerchantCheckoutRecipe } from "./recipes.js";
import { HmacFixtureSellerSource, SellerSourceRegistry } from "./sellerConfirmation.js";
import { FIXTURE_MERCHANT_DOMAIN, fixtureRecipe, startFixtureMerchant } from "./fixtureMerchant.js";
import { PHASE_C_MERCHANT_DOMAIN, PhaseCSellerStatusSource } from "./phaseCMerchant.js";
import { KernelCreationLedger } from "./kernelLedger.js";
import { verifyPhaseCApproval, type VerifiedPhaseCApproval } from "./phaseCApproval.js";

/**
 * A KERNEL configuration that includes the Phase C test merchant must name the owner-approved digest. It becomes the run
 * id of the durable creation ledger: at most ONE browser for that approval, across restarts and processes on this host.
 * The ledger dir is fixed (~/.diaporia/kernel-browser-ledger), not configurable from the environment.
 */
export function phaseCKernelLedgerFromEnv(env: NodeJS.ProcessEnv, recipes: MerchantRecipeRegistry, dir?: string,
  verifyOpts?: Parameters<typeof verifyPhaseCApproval>[2]): { ledger: KernelCreationLedger; approval: VerifiedPhaseCApproval } | null {
  const recipe = recipes.get(PHASE_C_MERCHANT_DOMAIN);
  if (!recipe) return null;
  // Signed statement, pinned code, host and user, exact origin and egress list: all before any provider call.
  const approval = verifyPhaseCApproval(env, recipe, verifyOpts);
  return { approval, ledger: new KernelCreationLedger({ runId: approval.digest, maxBrowsers: approval.kernelBrowsers, ...(dir ? { dir } : {}) }) };
}

/**
 * Optional authenticated seller channel for the Phase C test merchant (KERNEL mode only):
 * PHASE_C_SELLER_ORIGIN (https) + PHASE_C_SELLER_STATUS_SECRET (>= 32 chars, same as the merchant's MERCHANT_STATUS_SECRET).
 * Unset = no seller source, so the best possible outcome stays ORDER_UNVERIFIED. MOCK evidence is never accepted here.
 */
export function phaseCSellerSourcesFromEnv(env: NodeJS.ProcessEnv, recipes: MerchantRecipeRegistry): PhaseCSellerStatusSource[] {
  if (!env.PHASE_C_SELLER_ORIGIN && !env.PHASE_C_SELLER_STATUS_SECRET) return [];
  if (!env.PHASE_C_SELLER_ORIGIN || !env.PHASE_C_SELLER_STATUS_SECRET) throw new Error("PHASE_C_SELLER_ORIGIN and PHASE_C_SELLER_STATUS_SECRET must be set together");
  const recipe = recipes.get(PHASE_C_MERCHANT_DOMAIN);
  if (!recipe || new URL(recipe.origin).origin !== new URL(env.PHASE_C_SELLER_ORIGIN).origin)
    throw new Error("PHASE_C_SELLER_ORIGIN must equal the reviewed Phase C recipe origin");
  return [new PhaseCSellerStatusSource({ origin: env.PHASE_C_SELLER_ORIGIN, secret: env.PHASE_C_SELLER_STATUS_SECRET, acceptMockEvidence: false })];
}

export interface ConfiguredHandoff {
  config: Omit<HandoffConfig, "baseUrl" | "enabled">;
  note: string | null;
  shutdown(): Promise<void>;
}

/**
 * HANDOFF_DRIVER:
 *   off (default)  — browser handoff tools are not offered
 *   fixture        — offline Phase A: in-process synthetic merchant on 127.0.0.1 + local Chromium
 *                    (HANDOFF_FIXTURE_HEADED=1 shows the browser window so a person can act in it)
 *   kernel         — Phase B: KERNEL headful browsers. BILLED. Requires KERNEL_API_KEY, DIAPORIA_ALLOW_KERNEL_LIVE=1
 *                    and HANDOFF_RECIPES_FILE (JSON array of recipes for public https merchants). No seller source is
 *                    registered for real merchants, so outcomes stay ORDER_UNVERIFIED.
 */
export async function configureHandoffFromEnv(env: NodeJS.ProcessEnv): Promise<ConfiguredHandoff | null> {
  const mode = (env.HANDOFF_DRIVER ?? "off").toLowerCase();
  if (mode === "off" || mode === "") return null;
  if (mode === "fixture") {
    const merchant = await startFixtureMerchant();
    const driver = new LocalFixtureDriver(() => launchLocalChromium({ headless: env.HANDOFF_FIXTURE_HEADED !== "1" }));
    return {
      config: { driver, recipes: new MerchantRecipeRegistry([fixtureRecipe(merchant.origin)], { allowLoopbackOrigin: true }),
        sellers: new SellerSourceRegistry([new HmacFixtureSellerSource(FIXTURE_MERCHANT_DOMAIN, merchant.origin, merchant.secret)]) },
      note: `OFFLINE fixture merchant ${merchant.origin} for ${FIXTURE_MERCHANT_DOMAIN}; mock payment popup, not PayPal`,
      shutdown: async () => { await driver.shutdown(); await merchant.close(); },
    };
  }
  if (mode === "kernel") {
    if (env.DIAPORIA_ALLOW_KERNEL_LIVE !== "1") throw new Error("HANDOFF_DRIVER=kernel needs DIAPORIA_ALLOW_KERNEL_LIVE=1 (KERNEL browsers are billed)");
    if (!env.KERNEL_API_KEY) throw new Error("HANDOFF_DRIVER=kernel needs KERNEL_API_KEY");
    if (!env.HANDOFF_RECIPES_FILE) throw new Error("HANDOFF_DRIVER=kernel needs HANDOFF_RECIPES_FILE");
    const recipes = JSON.parse(readFileSync(env.HANDOFF_RECIPES_FILE, "utf8")) as MerchantCheckoutRecipe[];
    if (!Array.isArray(recipes) || recipes.length === 0) throw new Error("KERNEL handoff requires at least one reviewed merchant recipe");
    // Validate every public merchant and its egress allowlist BEFORE any provider API call.
    const registry = new MerchantRecipeRegistry(recipes, { allowLoopbackOrigin: false });
    const sellers = phaseCSellerSourcesFromEnv(env, registry);
    const phaseC = phaseCKernelLedgerFromEnv(env, registry);
    const ledger = phaseC?.ledger ?? null;
    if (ledger && ledger.used() >= 1) throw new Error("The Phase C approval's KERNEL browser was already created; a new owner approval (new digest) is required");
    const maxSessions = ledger ? 1 : Number(env.HANDOFF_KERNEL_MAX_SESSIONS ?? 2);
    const driver = new KernelDriver(env.KERNEL_API_KEY, { allowLive: true, maxSessions, ...(phaseC ? { creationLedger: phaseC.ledger, maxWallMs: phaseC.approval.maxWallMs } : {}) });
    // The old human session is no longer authenticated after restart. Reap every durable
    // unverified browser record before exposing another live handoff.
    await driver.recoverOrphanedBrowsers();
    return {
      config: { driver, recipes: registry, sellers: new SellerSourceRegistry(sellers),
        handoffTtlMs: 10 * 60_000, takeoverTtlMs: 10 * 60_000 },
      note: `KERNEL live, max ${maxSessions} browsers ${ledger ? "for this approval (durable ledger)" : "this process"}; seller sources: ${sellers.length ? sellers.map((x) => x.name).join(",") : "none (ORDER_UNVERIFIED at best)"}`,
      shutdown: async () => undefined,
    };
  }
  throw new Error(`Unknown HANDOFF_DRIVER ${mode}`);
}
