/** Debug one case: npx tsx scripts/research-eval-v2/debug.ts <caseId> [root] — prints the raw research output. */
import { pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
import { DEV_CASES } from "./cases.js";
import { HOLDOUT_CASES } from "./holdout.js";
import { WORLD_SOURCES, newCounters, worldFetch } from "./world.js";
import { WORLD_OFFICIAL_DOMAINS } from "./run.js";
const id = process.argv[2]; const root = resolve(process.argv[3] ?? ".");
const c = [...DEV_CASES, ...HOLDOUT_CASES].find((x) => x.id === id)!;
const imp = (p: string) => import(pathToFileURL(join(root, p)).href);
const { createApp } = await imp("src/http/server.ts"); const { DevAuth } = await imp("src/auth/devAuth.ts");
const { Channel3ResearchAdapter } = await imp("src/research/Channel3ResearchAdapter.ts");
const { EvidenceRouter } = await imp("src/evidence/EvidenceRouter.ts"); const { UsageLedger, PLACEHOLDER_PRICING } = await imp("src/metering/UsageLedger.ts");
const { Store } = await imp("src/store/Database.ts"); const { TavilySearch } = await imp("src/evidence/providers.ts");
const counters = newCounters(); const fetchImpl = worldFetch(counters); const now = () => Date.parse("2026-11-10T12:00:00.000Z");
const store = new Store(":memory:");
const ledger = new UsageLedger(store, PLACEHOLDER_PRICING, { perRequestSupplierMicro: 10_000_000, monthlyBillableMinor: 0, perRequestCalls: { CHANNEL3: 6, TAVILY: 12, KERNEL: 0 } }, now);
const router = new EvidenceRouter(store, ledger, new TavilySearch("tvly-EVAL-FAKE-KEY-000", "community", fetchImpl), null, { billable: false, now, policy: "v2", sources: { expertReviewDomains: WORLD_SOURCES.expertReview, forumDomains: WORLD_SOURCES.forums, officialDomains: WORLD_OFFICIAL_DOMAINS } });
const app = createApp({ host: "127.0.0.1", port: 0, baseUrl: "http://127.0.0.1:1", authMode: "dev", dbPath: ":memory:", auth: new DevAuth(), now,
  research: new Channel3ResearchAdapter("ch3-EVAL-FAKE-KEY-0000", { fetchImpl, now }), service: { mode: "community", ledger, router, billing: null } });
const out = await app.gateway.researchPurchase("u", { request: c.request, ...(c.input ?? {}) });
const slim = (x: any) => JSON.stringify(x, (k, v) => (k === "untrustedContent" || k === "steps" ? undefined : v), 1);
console.log(slim({ mode: out.mode, state: out.state, intent: out.intent, identity: out.identity, decision: out.decision, unknowns: out.unknowns,
  candidates: out.candidates.map((x: any) => ({ id: x.productId, title: x.title, identity: x.identity, suit: x.suitability, must: x.mustHave.map((m: any) => `${m.capability}:${m.status}`), price: x.listingPrice?.lowestListingMinor })) }));
console.log("requests:", counters.requests.map((r) => `${r.url} ${JSON.stringify(r.body)}`).join("\n"));
