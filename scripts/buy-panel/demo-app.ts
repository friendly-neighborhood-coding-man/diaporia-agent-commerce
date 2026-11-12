/**
 * DIAPORIA Buy panel: the offline MOCK demo world as a running app (same world as `npm run demo:full`): fictional catalog
 * and web in Channel3 / Tavily shapes, the repository's attested MOCK merchants, MOCK PayPal. No network, no provider keys,
 * no money. Used by `npm run dev:buy-panel` and tests/buy-panel.test.ts.
 */
import { createApp, type App } from "../../src/http/server.js";
import { ALL_CLIENT_SCOPES, DevAuth } from "../../src/auth/devAuth.js";
import { Store } from "../../src/store/Database.js";
import { UsageLedger, PLACEHOLDER_PRICING } from "../../src/metering/UsageLedger.js";
import { EvidenceRouter } from "../../src/evidence/EvidenceRouter.js";
import { TavilySearch } from "../../src/evidence/providers.js";
import { Channel3ResearchAdapter } from "../../src/research/Channel3ResearchAdapter.js";
import { MERCHANT_CLAIMS } from "../../src/merchant-identity/fixtures.js";
import { EXPERT_DOMAINS, OFFICIAL_DOMAINS, demoFetch, demoQuote, type DemoCounters } from "../demo-full/world.js";

export interface DemoAppOptions { host: string; port: number; baseUrl: string; dbPath: string; userId: string; clientToken: string; ownerKey: string;
  clientScopes?: string[]; now?: () => number; researchDelayMs?: number }

export function createDemoWorldApp(o: DemoAppOptions): { app: App; counters: DemoCounters } {
  const auth = new DevAuth(); auth.addClientToken(o.clientToken, o.userId, o.clientScopes ?? ALL_CLIENT_SCOPES); auth.addOwnerKey(o.ownerKey, o.userId);
  const counters: DemoCounters = { channel3: 0, tavily: 0, queries: [] };
  const inner0 = demoFetch(counters);
  // Optional delay per provider call so live progress is visible in a demo (default 0 in tests).
  const fetchImpl = (async (...a: Parameters<typeof fetch>) => { if (o.researchDelayMs) await new Promise((r) => setTimeout(r, o.researchDelayMs)); return inner0(...a); }) as typeof fetch;
  const now = o.now ?? (() => Date.now());
  const evStore = new Store(":memory:");
  const ledger = new UsageLedger(evStore, PLACEHOLDER_PRICING, { perRequestSupplierMicro: 10_000_000, monthlyBillableMinor: 0, perRequestCalls: { CHANNEL3: 6, TAVILY: 12, KERNEL: 0 } }, now);
  const router = new EvidenceRouter(evStore, ledger, new TavilySearch("tvly-DEMO-OFFLINE-0000", "community", fetchImpl), null,
    { billable: false, now, policy: "v2", sources: { expertReviewDomains: EXPERT_DOMAINS, officialDomains: OFFICIAL_DOMAINS } });
  const inner = new Channel3ResearchAdapter("ch3-DEMO-OFFLINE-0000", { fetchImpl, now });
  const listing = new Map<string, string | null>();
  const adapter: any = {
    name: "demo-world (offline, MOCK)", isMock: true,
    searchProducts: (q: any) => inner.searchProducts(q), getProduct: (id: string) => inner.getProduct(id),
    async findOffers(identity: any) {
      const offers = await inner.findOffers(identity);
      return offers.map((x: any) => { listing.set(x.offerId, x.listingUrl); return { ...x, checkoutCapability: (MERCHANT_CLAIMS as any)[x.merchantDomain] ? "DIAPORIA_SANDBOX_DEMO_MERCHANT" : x.checkoutCapability,
        merchantId: `mer_${x.merchantDomain.split(".")[0]!.replace(/-/g, "_")}`, identityClaim: structuredClone((MERCHANT_CLAIMS as any)[x.merchantDomain] ?? null) }; });
    },
    getQuote: async (offerId: string, quantity: number, destination: unknown) => demoQuote(listing.get(offerId) ?? null, offerId, quantity, destination, now()),
  };
  for (const m of ["searchPage", "searchCandidates", "lookupUrl", "resolveVariant", "getVariantProduct"]) if (typeof (inner as any)[m] === "function") adapter[m] = (inner as any)[m].bind(inner);
  const app = createApp({ host: o.host, port: o.port, baseUrl: o.baseUrl, authMode: "dev", dbPath: o.dbPath, auth, now, research: adapter,
    service: { mode: "community", ledger, router, billing: null }, buyPanel: true } as any);
  return { app, counters };
}
