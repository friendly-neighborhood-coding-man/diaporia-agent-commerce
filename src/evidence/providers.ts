import type { IndependentSearchProvider, PageInspectionProvider } from "./EvidenceRouter.js";

/** MOCK Tavily: fixture results on fictional `.example` review sites. */
export class MockTavilySearch implements IndependentSearchProvider {
  readonly name = "mock-tavily"; readonly provenance = "MOCK" as const;
  calls = 0; failNext = 0;
  async search(query: string) {
    this.calls++;
    if (this.failNext > 0) { this.failNext--; throw new Error("mock Tavily timeout"); }
    if (/lumen q3/i.test(query) && /noise/i.test(query)) return [
      { url: "https://soundlab.example/lumen-q3", title: "Lumen Q3 review", snippet: "Solid battery life. The Lumen Q3 uses active noise cancelling that cut cabin rumble in our flight test." },
      { url: "https://headphonetests.example/q3-review", title: "Lumen Q3 long-term review", snippet: "We used the Lumen Q3 for a month." },
      { url: "https://listicle.example/best-2026", title: "Best headphones of 2026", snippet: "Our favourite noise cancelling headphones this year." },
    ];
    return [];
  }
}

/** MOCK KERNEL: fixture page statements. */
export class MockKernelInspector implements PageInspectionProvider {
  readonly name = "mock-kernel"; readonly provenance = "MOCK" as const;
  calls = 0;
  async inspect(url: string, capability: string) {
    this.calls++;
    if (url === "https://headphonetests.example/q3-review" && capability === "active_noise_cancellation")
      return { statements: [{ value: true, quote: "In our test chamber the Lumen Q3's ANC lowered 100 Hz noise by about 20 dB." }], browserSeconds: 12 };
    return { statements: [], browserSeconds: 8 };
  }
}

/** Research V2 search request (Tavily contract, docs/research/PROVIDER_CONTRACTS.md). */
export interface EvidenceSearchRequest {
  query: string;
  maxResults?: number;
  /** Results must contain the quoted phrase (model precision). */
  exactMatch?: boolean;
  includeDomains?: string[];
  excludeDomains?: string[];
  includeDomainsMode?: "restrict" | "prefer";
  /** "basic" = 1 credit (default); "advanced" = 2 credits and is never used without an explicit caller choice. */
  depth?: "basic" | "advanced";
  timeRange?: "year" | "month" | "week" | "day" | null;
}
export interface EvidenceSearchHit { url: string; title: string; snippet: string; publishedDate: string | null; score: number | null }
export interface EvidenceSearchResponse { hits: EvidenceSearchHit[]; requestId: string | null; credits: number; responseTimeS: number | null }

/**
 * BYOK Tavily search adapter (community mode: the operator's own key; managed mode: the server's key).
 * Request shape follows the documented contract; NOT live-tested in this repository. The key is held privately and
 * never returned or logged. Never sends include_answer (a generated answer is not evidence) or auto_parameters (it may
 * silently switch to the 2-credit depth).
 */
export class TavilySearch implements IndependentSearchProvider {
  readonly name = "tavily";
  readonly provenance: "BYOK_LIVE" | "MANAGED_LIVE";
  #key: string;
  /** HTTP attempts made (including bounded retries). */
  calls = 0;
  constructor(apiKey: string, mode: "community" | "managed", private readonly fetchImpl: typeof fetch = fetch,
    private readonly retry: { attempts: number; baseDelayMs: number; maxRetryAfterMs: number } = { attempts: 2, baseDelayMs: 300, maxRetryAfterMs: 2000 }) {
    if (!apiKey || apiKey.length < 10) throw new Error("Tavily API key missing");
    this.#key = apiKey;
    this.provenance = mode === "managed" ? "MANAGED_LIVE" : "BYOK_LIVE";
  }
  /** V1 interface: plain basic search. */
  async search(query: string) {
    const r = await this.searchV2({ query, maxResults: 10 });
    return r.hits.map((h) => ({ url: h.url, title: h.title, snippet: h.snippet }));
  }
  /** V2: documented parameters, published dates, usage and request id; bounded retry on 429/5xx/network errors only. */
  async searchV2(req: EvidenceSearchRequest): Promise<EvidenceSearchResponse> {
    const body: Record<string, unknown> = { query: req.query.slice(0, 400), search_depth: req.depth ?? "basic", max_results: Math.min(20, Math.max(1, req.maxResults ?? 10)),
      include_answer: false, include_raw_content: false, include_images: false, include_published_date: true, include_usage: true };
    if (req.exactMatch) body.exact_match = true;
    if (req.includeDomains?.length) { body.include_domains = req.includeDomains.slice(0, 300); if (req.includeDomainsMode) body.include_domains_mode = req.includeDomainsMode; }
    if (req.excludeDomains?.length) body.exclude_domains = req.excludeDomains.slice(0, 150);
    if (req.timeRange) body.time_range = req.timeRange;
    let last: unknown = null;
    for (let i = 0; i < this.retry.attempts; i++) {
      this.calls++;
      try {
        const r = await this.fetchImpl("https://api.tavily.com/search", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.#key}` },
          body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
        if (r.status === 429 || r.status >= 500) {
          last = new Error(`Tavily HTTP ${r.status}`);
          if (i + 1 < this.retry.attempts) { await new Promise((res) => setTimeout(res, Math.min(this.retry.maxRetryAfterMs, Number(r.headers.get("retry-after") ?? 0) * 1000 || this.retry.baseDelayMs * 2 ** i))); continue; }
          throw last;
        }
        // 401/432/433 (key, plan or pay-as-you-go limit) and 4xx are not retried.
        if (!r.ok) throw new Error(`Tavily HTTP ${r.status}`);
        const data = (await r.json()) as { results?: Array<Record<string, unknown>>; request_id?: string; usage?: { credits?: number }; response_time?: number | string };
        const hits = (data.results ?? []).filter((x) => typeof x.url === "string" && String(x.url).startsWith("https://")).map((x) => ({ url: String(x.url),
          title: String(x.title ?? "").slice(0, 200), snippet: String(x.content ?? "").slice(0, 800), publishedDate: typeof x.published_date === "string" ? x.published_date : null,
          score: typeof x.score === "number" ? x.score : null }));
        return { hits, requestId: typeof data.request_id === "string" ? data.request_id : null, credits: typeof data.usage?.credits === "number" ? data.usage.credits : body.search_depth === "advanced" ? 2 : 1,
          responseTimeS: data.response_time !== undefined ? Number(data.response_time) : null };
      } catch (e) {
        if (e instanceof Error && /^Tavily HTTP (?!429|5)/.test(e.message)) throw e;
        last = e;
        if (i + 1 < this.retry.attempts) await new Promise((res) => setTimeout(res, this.retry.baseDelayMs * 2 ** i));
      }
    }
    throw last instanceof Error ? last : new Error("Tavily request failed");
  }
  toJSON() { return { name: this.name, provenance: this.provenance, key: "[REDACTED]" }; }
}
