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

/**
 * BYOK Tavily search adapter (community mode: the operator's own key; managed mode: the server's key).
 * Request shape mirrors the integration used in DIAPORIA Buy V7. NOT live-tested in this repository.
 * The key is held privately and never returned or logged.
 */
export class TavilySearch implements IndependentSearchProvider {
  readonly name = "tavily";
  readonly provenance: "BYOK_LIVE" | "MANAGED_LIVE";
  #key: string;
  constructor(apiKey: string, mode: "community" | "managed", private readonly fetchImpl: typeof fetch = fetch) {
    if (!apiKey || apiKey.length < 10) throw new Error("Tavily API key missing");
    this.#key = apiKey;
    this.provenance = mode === "managed" ? "MANAGED_LIVE" : "BYOK_LIVE";
  }
  async search(query: string) {
    const r = await this.fetchImpl("https://api.tavily.com/search", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.#key}` },
      body: JSON.stringify({ query, search_depth: "basic", max_results: 10, include_answer: false, include_raw_content: false, include_images: false }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) throw new Error(`Tavily HTTP ${r.status}`);
    const body = (await r.json()) as { results?: Array<{ url?: string; title?: string; content?: string }> };
    return (body.results ?? []).filter((x) => typeof x.url === "string" && x.url.startsWith("https://"))
      .map((x) => ({ url: x.url!, title: String(x.title ?? "").slice(0, 200), snippet: String(x.content ?? "").slice(0, 600) }));
  }
  toJSON() { return { name: this.name, provenance: this.provenance, key: "[REDACTED]" }; }
}
