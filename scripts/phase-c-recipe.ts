/**
 * Writes the reviewed KERNEL recipe for the Phase C test merchant (for HANDOFF_RECIPES_FILE). NO network.
 * It is validated with the same MerchantRecipeRegistry rules KERNEL mode uses (exact-host egress allowlist required).
 *
 *   npm run phase-c:recipe -- --origin https://shop.example.com > .data/phase-c-recipes.json
 */
import { readFileSync } from "node:fs";
import { MerchantRecipeRegistry } from "../src/handoff/recipes.js";
import { phaseCBrowserHosts, phaseCRecipe } from "../src/handoff/phaseCMerchant.js";

const i = process.argv.indexOf("--origin");
const origin = i > 0 ? process.argv[i + 1] : undefined;
if (!origin) { console.error("--origin https://<operator merchant host> is required"); process.exit(2); }
const file = process.env.MERCHANT_ALLOWLIST_FILE || "apps/phase-c-test-merchant/config/network-allowlist.json";
const recipe = phaseCRecipe(origin, phaseCBrowserHosts(readFileSync(file, "utf8")));
new MerchantRecipeRegistry([recipe], { allowLoopbackOrigin: false }); // throws RECIPE_* on any problem
console.log(JSON.stringify([recipe], null, 2));
