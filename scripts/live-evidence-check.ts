/**
 * BOUNDED LIVE independent-evidence check (Tavily only). Requires --confirm-live.
 * Verifies one must-have capability of one exact model through the Evidence Router, then repeats the
 * same verification to show cache reuse. Hard total cap: LIVE_MAX_TAVILY (default 2). No retries.
 *   node --env-file=<env> --import tsx scripts/live-evidence-check.ts --confirm-live
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { Store } from "../src/store/Database.js";
import { UsageLedger, LIVE_PRICES_UNKNOWN } from "../src/metering/UsageLedger.js";
import { EvidenceRouter } from "../src/evidence/EvidenceRouter.js";
import { TavilySearch } from "../src/evidence/providers.js";
import type { CatalogProduct } from "../src/domain/types.js";

if (!process.argv.includes("--confirm-live")) { console.error("Refusing to make live calls without --confirm-live"); process.exit(2); }
if (!process.env.TAVILY_API_KEY) { console.error("TAVILY_API_KEY not configured: stopping (no fixture substitution)."); process.exit(3); }
const max = Number(process.env.LIVE_MAX_TAVILY ?? 2);
let calls = 0;
const capped: typeof fetch = async (u, init) => {
  if (!String(u).startsWith("https://api.tavily.com/")) throw new Error("unexpected host");
  if (calls >= max) throw new Error("TOTAL Tavily budget exhausted");
  calls++;
  return fetch(u, init);
};
const store = new Store(":memory:");
const ledger = new UsageLedger(store, LIVE_PRICES_UNKNOWN, { perRequestSupplierMicro: 0, monthlyBillableMinor: 0, perRequestCalls: { TAVILY: 1 } });
const router = new EvidenceRouter(store, ledger, new TavilySearch(process.env.TAVILY_API_KEY, "community", capped), null);
const product: CatalogProduct = { productId: "exact:sony-wh-ch720n", title: "Sony WH-CH720N", category: "headphones",
  identity: { brand: "Sony", model: "WH-CH720N", variant: null, condition: "new", sku: null }, capabilities: [], description: null, reviews: [] };
const startedAt = new Date().toISOString();
const first = await router.verify(product, "active_noise_cancellation", { userId: "live-check", requestId: "req-1" });
const afterFirst = calls;
const second = await router.verify(product, "active_noise_cancellation", { userId: "live-check", requestId: "req-2" });
const out = { kind: "LIVE_EVIDENCE_CHECK", startedAt, maxTavily: max, tavilyCalls: { afterFirst, total: calls },
  first: { sufficiency: first.sufficiency, reason: first.reason, steps: first.steps,
    claims: first.claims.map((c) => ({ value: c.value, kind: c.source.kind, url: c.source.url, statement: c.source.title.split("]: ").slice(1).join("]: ") })) },
  second: { sufficiency: second.sufficiency, reason: second.reason, steps: second.steps },
  ledger: ledger.summary("live-check").totals };
mkdirSync("docs/evidence", { recursive: true });
const file = `docs/evidence/live-evidence-check-${startedAt.slice(0, 19).replace(/[:T]/g, "-")}.json`;
writeFileSync(file, JSON.stringify(out, null, 2));
console.log(JSON.stringify({ file, tavilyCalls: out.tavilyCalls, first: { sufficiency: first.sufficiency, reason: first.reason, claims: out.first.claims.length }, second: { sufficiency: second.sufficiency, steps: second.steps.map((s) => s.action) } }, null, 1));
