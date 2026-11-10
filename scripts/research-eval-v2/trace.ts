/** Decision trace for one case against THIS checkout (V2 output): npx tsx scripts/research-eval-v2/trace.ts <caseId> [steps] */
import { DEV_CASES } from "./cases.js";
import { HOLDOUT_CASES } from "./holdout.js";
import { HOLDOUT2_CASES } from "./holdout2.js";
import { WORLD_SOURCES, newCounters, worldFetch } from "./world.js";
import { createApp } from "../../src/http/server.js";
import { DevAuth } from "../../src/auth/devAuth.js";
import { Channel3ResearchAdapter } from "../../src/research/Channel3ResearchAdapter.js";
import { EvidenceRouter } from "../../src/evidence/EvidenceRouter.js";
import { UsageLedger, PLACEHOLDER_PRICING } from "../../src/metering/UsageLedger.js";
import { Store } from "../../src/store/Database.js";
import { TavilySearch } from "../../src/evidence/providers.js";
const id = process.argv[2]!;
const c = [...DEV_CASES, ...HOLDOUT_CASES, ...HOLDOUT2_CASES].find((x) => x.id === id)!;
const counters = newCounters(); const fetchImpl = worldFetch(counters); const now = () => Date.parse("2026-11-10T12:00:00.000Z");
const store = new Store(":memory:");
const ledger = new UsageLedger(store, PLACEHOLDER_PRICING, { perRequestSupplierMicro: 10_000_000, monthlyBillableMinor: 0, perRequestCalls: { CHANNEL3: 6, TAVILY: 12, KERNEL: 0 } }, now);
const router = new EvidenceRouter(store, ledger, new TavilySearch("tvly-EVAL-FAKE-KEY-000", "community", fetchImpl), null, { billable: false, now, policy: "v2", sources: { expertReviewDomains: WORLD_SOURCES.expertReview, forumDomains: WORLD_SOURCES.forums } });
const app = createApp({ host: "127.0.0.1", port: 0, baseUrl: "http://127.0.0.1:1", authMode: "dev", dbPath: ":memory:", auth: new DevAuth(), now,
  research: new Channel3ResearchAdapter("ch3-EVAL-FAKE-KEY-0000", { fetchImpl, now }), service: { mode: "community", ledger, router, billing: null } } as any);
const out: any = await app.gateway.researchPurchase("u", { request: c.request, ...(c.input ?? {}) });
const d = out.decision;
console.log(c.id, c.request, "→", d.state, out.identity.status, out.identity.reason ?? out.identity.question ?? "");
console.log("queries", JSON.stringify(out.researchTrace.queries), "stops", out.researchTrace.stops);
for (const r of d.ranking) console.log(" ", r.rank, r.productId, r.eligible ? "ELIG" : "DQ", r.price.lowestListingMinor, r.utility, "DQ:", r.disqualifiers.map((x: any) => x.code).join(","), "BL:", r.blockers.map((x: any) => x.detail).join(" | "));
if (process.argv[3]) for (const s of out.researchTrace.evidenceSteps) console.log("   step", s.action, s.capability, s.detail);
if (process.argv[3]) for (const cnd of out.candidates) for (const e of cnd.evidence) console.log("   ev", cnd.productId, e.capability, e.status, e.basis, JSON.stringify(e.items.map((i: any) => [i.sourceClass, i.value, i.counts, i.quote.slice(0, 60)])));
