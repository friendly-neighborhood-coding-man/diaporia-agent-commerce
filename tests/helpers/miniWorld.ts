/**
 * A tiny builder-written fake world for the V2.1 remediation regressions (V21-02/V21-03). It serves the documented
 * Channel3 search/detail shapes for the products given and a Tavily search that returns only the hits whose `match`
 * regex matches the query. It never touches scripts/research-eval-v2/world.ts (pinned by the frozen-case manifests).
 */
import { createApp } from "../../src/http/server.js";
import { DevAuth } from "../../src/auth/devAuth.js";
import { Store } from "../../src/store/Database.js";
import { UsageLedger, PLACEHOLDER_PRICING } from "../../src/metering/UsageLedger.js";
import { EvidenceRouter } from "../../src/evidence/EvidenceRouter.js";
import { TavilySearch } from "../../src/evidence/providers.js";
import { Channel3ResearchAdapter } from "../../src/research/Channel3ResearchAdapter.js";

export interface MiniProduct { id: string; title: string; brand: string; category: string; categoryTitle: string; price: number; domain?: string; features?: string[] }
export interface MiniHit { match: RegExp; title: string; url: string; content: string; published_date?: string }

export function miniWorld(products: MiniProduct[], hits: MiniHit[] = [], o: { officialDomains?: Record<string, string[]>; expertReviewDomains?: string[]; caps?: { CHANNEL3: number; TAVILY: number } } = {}) {
  const NOW = Date.parse("2026-11-10T12:00:00.000Z");
  const now = () => NOW;
  const counters = { channel3Search: 0, tavilySearch: 0, tavilyQueries: [] as string[] };
  const pub = (p: MiniProduct) => ({ id: p.id, title: p.title, description: null, brands: [{ id: `br_${p.brand.toLowerCase()}`, name: p.brand }], images: [],
    category: { slug: p.category, title: p.categoryTitle, path: [], has_children: false }, key_features: p.features ?? null, variants: null, structured_attributes: {},
    offers: [{ url: `https://${p.domain ?? "shop.example"}/p/${p.id}`, domain: p.domain ?? "shop.example", price: { price: p.price, compare_at_price: null, currency: "USD" }, availability: "InStock", condition: "new", max_commission_rate: 0 }] });
  const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1);
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (url.hostname === "api.trychannel3.com" && url.pathname === "/v1/search") {
      counters.channel3Search++;
      const q = new Set(words(String(body?.query ?? "")));
      const found = products.filter((p) => words(`${p.brand} ${p.title} ${p.categoryTitle}`).filter((w) => q.has(w)).length >= Math.max(1, Math.ceil(q.size * 0.4)));
      return Response.json({ products: found.map(pub), next_page_token: null });
    }
    if (url.hostname === "api.trychannel3.com" && url.pathname.startsWith("/v1/products/")) {
      const p = products.find((x) => x.id === decodeURIComponent(url.pathname.slice(13)));
      return p ? Response.json(pub(p)) : Response.json({ detail: "Product not found" }, { status: 404 });
    }
    if (url.hostname === "api.tavily.com" && url.pathname === "/search") {
      counters.tavilySearch++;
      const q = String(body?.query ?? ""); counters.tavilyQueries.push(q);
      const include: string[] = Array.isArray(body?.include_domains) ? body.include_domains : [];
      const host = (u: string) => new URL(u).hostname;
      const ok = hits.filter((h) => h.match.test(q) && (!include.length || body.include_domains_mode === "prefer" || include.some((d) => host(h.url) === d || host(h.url).endsWith(`.${d}`))));
      return Response.json({ query: q, answer: null, images: [], response_time: 0.01, request_id: `req_${counters.tavilySearch}`, ...(body?.include_usage ? { usage: { credits: 1 } } : {}),
        results: ok.map((h, i) => ({ title: h.title, url: h.url, content: h.content, score: 1 - i * 0.05, ...(body?.include_published_date ? { published_date: h.published_date ?? null } : {}) })) });
    }
    if (url.hostname === "api.trychannel3.com") return Response.json({ detail: "Not Found" }, { status: 404 });
    throw new Error(`miniWorld: unexpected request to ${url.host}`);
  }) as typeof fetch;
  const caps = o.caps ?? { CHANNEL3: 6, TAVILY: 12 };
  const store = new Store(":memory:");
  const ledger = new UsageLedger(store, PLACEHOLDER_PRICING, { perRequestSupplierMicro: 10_000_000, monthlyBillableMinor: 0, perRequestCalls: { CHANNEL3: caps.CHANNEL3, TAVILY: caps.TAVILY, KERNEL: 0 } }, now);
  const router = new EvidenceRouter(store, ledger, new TavilySearch("tvly-TEST-0000000", "community", fetchImpl), null, { billable: false, now, policy: "v2",
    sources: { expertReviewDomains: o.expertReviewDomains ?? [], officialDomains: o.officialDomains ?? {} } });
  const app = createApp({ host: "127.0.0.1", port: 0, baseUrl: "http://127.0.0.1:1", authMode: "dev", dbPath: ":memory:", auth: new DevAuth(), now,
    research: new Channel3ResearchAdapter("ch3-TEST-KEY-000000", { fetchImpl, now }), service: { mode: "community", ledger, router, billing: null } } as any);
  return { app, counters, close: () => { app.store.close(); store.close(); } };
}
