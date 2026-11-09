import { createHash } from "node:crypto";
import type { CapabilityClaim, CatalogProduct } from "../domain/types.js";
import { normalizeModel } from "../identity/ProductIdentityResolver.js";
import type { Store } from "../store/Database.js";
import { UsageLimitError, type UsageLedger, type UsageProvenance } from "../metering/UsageLedger.js";

/** Independent web search (e.g. Tavily). */
export interface IndependentSearchProvider {
  readonly name: string; readonly provenance: UsageProvenance;
  search(query: string): Promise<Array<{ url: string; title: string; snippet: string }>>;
}
/** Original-page inspection with a real browser (e.g. KERNEL). Returns explicit statements only. */
export interface PageInspectionProvider {
  readonly name: string; readonly provenance: UsageProvenance;
  inspect(url: string, capability: string, modelToken: string): Promise<{ statements: Array<{ value: boolean; quote: string }>; browserSeconds: number }>;
}

export type Sufficiency = "SUFFICIENT_TRUE" | "SUFFICIENT_FALSE" | "CONTRADICTED" | "INSUFFICIENT";
export interface RouterStep {
  provider: "STORE" | "TAVILY" | "KERNEL";
  action: "REUSED_EXISTING_EVIDENCE" | "SKIPPED_SUFFICIENT" | "CALLED" | "REUSED_CACHED_QUERY" | "REUSED_CACHED_PAGE" | "BLOCKED_BY_LIMIT" | "FAILED";
  capability: string; detail: string;
}
export interface RouterResult { capability: string; sufficiency: Sufficiency; claims: CapabilityClaim[]; steps: RouterStep[]; reason: string }

const PHRASE: Record<string, string> = { active_noise_cancellation: "noise cancelling", wireless: "wireless bluetooth", multipoint: "multipoint", over_ear: "over-ear" };
const KEYWORDS: Record<string, RegExp> = {
  active_noise_cancellation: /\b(active )?noise[- ]?cancel(l)?ing\b|\banc\b/i, wireless: /\bwireless\b|\bbluetooth\b/i,
  multipoint: /\bmulti-?point\b|\btwo devices\b/i, over_ear: /\bover[- ]ear\b/i,
};
const NEGATION = /\b(no|lacks|without|does not|doesn't|not)\b/i;
const MAX_KERNEL_PAGES = 2;
const EVIDENCE_TTL_MS = 30 * 86400_000;
const host = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };

/**
 * Deterministic evidence routing. Explicit sufficiency rule per must-have capability:
 *   SUFFICIENT if a MANUFACTURER claim exists, or >= 2 INDEPENDENT_REVIEW claims from distinct hosts agree;
 *   CONTRADICTED if strong claims disagree; otherwise INSUFFICIENT.
 * Order: existing catalog/stored evidence → Tavily (cached per normalized query) → KERNEL only for pages
 * whose snippet names the exact model but does not state the capability. A limit never turns verification
 * into "optional": the capability stays INSUFFICIENT with BLOCKED_BY_LIMIT.
 */
export class EvidenceRouter {
  constructor(private readonly store: Store, private readonly ledger: UsageLedger, private readonly search: IndependentSearchProvider | null,
    private readonly inspector: PageInspectionProvider | null, private readonly opts: { billable: boolean; now?: () => number } = { billable: false }) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS evidence_items (id TEXT PRIMARY KEY, product_key TEXT NOT NULL, capability TEXT NOT NULL, value INTEGER NOT NULL,
        kind TEXT NOT NULL, host TEXT NOT NULL, url TEXT NOT NULL, provider TEXT NOT NULL, provenance TEXT NOT NULL, quote TEXT NOT NULL, observed_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS evidence_by_product ON evidence_items(product_key, capability);
      CREATE TABLE IF NOT EXISTS evidence_query_cache (query_key TEXT PRIMARY KEY, provider TEXT NOT NULL, hits_json TEXT NOT NULL, observed_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS evidence_page_cache (page_key TEXT PRIMARY KEY, provider TEXT NOT NULL, result_json TEXT NOT NULL, observed_at INTEGER NOT NULL);`);
  }
  private now() { return (this.opts.now ?? Date.now)(); }

  static judge(claims: CapabilityClaim[]): Sufficiency {
    const manu = claims.filter((c) => c.source.kind === "MANUFACTURER");
    const indep = claims.filter((c) => c.source.kind === "INDEPENDENT_REVIEW");
    const strong = [...manu, ...indep];
    if (strong.some((c) => c.value) && strong.some((c) => !c.value)) return "CONTRADICTED";
    if (manu.length) return manu[0]!.value ? "SUFFICIENT_TRUE" : "SUFFICIENT_FALSE";
    for (const v of [true, false]) if (new Set(indep.filter((c) => c.value === v).map((c) => host(c.source.url))).size >= 2) return v ? "SUFFICIENT_TRUE" : "SUFFICIENT_FALSE";
    return "INSUFFICIENT";
  }

  async verify(product: CatalogProduct, capability: string, ctx: { userId: string; requestId: string }): Promise<RouterResult> {
    const steps: RouterStep[] = [];
    const productKey = `${product.identity.brand}|${normalizeModel(product.identity.model)}`.toLowerCase();
    const modelToken = product.identity.model;
    let claims = [...product.capabilities.filter((c) => c.capability === capability), ...this.stored(productKey, capability)];
    if (claims.length > product.capabilities.filter((c) => c.capability === capability).length) steps.push({ provider: "STORE", action: "REUSED_EXISTING_EVIDENCE", capability, detail: "previously verified independent evidence (fresh)" });
    const done = (reason: string): RouterResult => ({ capability, sufficiency: EvidenceRouter.judge(claims), claims, steps, reason });
    if (EvidenceRouter.judge(claims) !== "INSUFFICIENT") { steps.push({ provider: "STORE", action: "SKIPPED_SUFFICIENT", capability, detail: "existing evidence meets the sufficiency rule" }); return done("EXISTING_EVIDENCE_SUFFICIENT"); }
    if (!this.search) return done("NO_INDEPENDENT_SEARCH_PROVIDER");

    // Tavily: one normalized query per (product, capability), cached.
    const query = `"${product.identity.brand} ${modelToken}" ${PHRASE[capability] ?? capability} review`;
    const queryKey = createHash("sha256").update(`${this.search.name}|${query.toLowerCase()}`).digest("hex");
    let hits: Array<{ url: string; title: string; snippet: string }>;
    const cached = this.store.db.prepare("SELECT hits_json, observed_at FROM evidence_query_cache WHERE query_key=?").get(queryKey) as { hits_json: string; observed_at: number } | undefined;
    if (cached && this.now() - cached.observed_at < EVIDENCE_TTL_MS) { hits = JSON.parse(cached.hits_json); steps.push({ provider: "TAVILY", action: "REUSED_CACHED_QUERY", capability, detail: query }); }
    else {
      const r = await this.metered(ctx, "TAVILY", "search", "search", 1, `tavily:${queryKey}`, this.search.provenance, () => this.search!.search(query));
      if (!r.ok) { steps.push({ provider: "TAVILY", action: r.blocked ? "BLOCKED_BY_LIMIT" : "FAILED", capability, detail: r.reason }); return done(r.blocked ? "VERIFICATION_REQUIRED_BUT_LIMIT_REACHED" : "SEARCH_FAILED"); }
      hits = r.value;
      this.store.db.prepare("INSERT OR REPLACE INTO evidence_query_cache(query_key,provider,hits_json,observed_at) VALUES (?,?,?,?)").run(queryKey, this.search.name, JSON.stringify(hits), this.now());
      steps.push({ provider: "TAVILY", action: "CALLED", capability, detail: `${query} → ${hits.length} results` });
    }
    // Snippet statements count only if they name the exact model token and state the capability.
    const model = new RegExp(modelToken.replace(/[^A-Za-z0-9]/g, "[- ]?"), "i");
    const needsPage: string[] = [];
    for (const h of hits) {
      if (!model.test(`${h.title} ${h.snippet}`)) continue;
      const kw = KEYWORDS[capability];
      const sentence = kw ? h.snippet.split(/(?<=[.!?])\s+/).find((s) => kw.test(s)) : undefined;
      if (sentence) claims = this.add(claims, productKey, capability, !NEGATION.test(sentence), h.url, "TAVILY", this.search.provenance, sentence);
      else needsPage.push(h.url);
    }
    if (EvidenceRouter.judge(claims) !== "INSUFFICIENT") return done("INDEPENDENT_SEARCH_SUFFICIENT");
    if (!this.inspector) return done("NO_PAGE_INSPECTION_PROVIDER");
    // KERNEL: only pages that mention the exact model but whose snippet did not state the capability.
    for (const url of needsPage.slice(0, MAX_KERNEL_PAGES)) {
      const pageKey = createHash("sha256").update(`${this.inspector.name}|${url}|${capability}`).digest("hex");
      const pc = this.store.db.prepare("SELECT result_json FROM evidence_page_cache WHERE page_key=?").get(pageKey) as { result_json: string } | undefined;
      let res: { statements: Array<{ value: boolean; quote: string }>; browserSeconds: number };
      if (pc) { res = JSON.parse(pc.result_json); steps.push({ provider: "KERNEL", action: "REUSED_CACHED_PAGE", capability, detail: url }); }
      else {
        const r = await this.metered(ctx, "KERNEL", "inspect", "browser_second", 30, `kernel:${pageKey}`, this.inspector.provenance, () => this.inspector!.inspect(url, capability, modelToken),
          (v) => Math.max(1, Math.ceil(v.browserSeconds)));
        if (!r.ok) { steps.push({ provider: "KERNEL", action: r.blocked ? "BLOCKED_BY_LIMIT" : "FAILED", capability, detail: `${url}: ${r.reason}` }); if (r.blocked) return done("VERIFICATION_REQUIRED_BUT_LIMIT_REACHED"); continue; }
        res = r.value;
        this.store.db.prepare("INSERT OR REPLACE INTO evidence_page_cache(page_key,provider,result_json,observed_at) VALUES (?,?,?,?)").run(pageKey, this.inspector.name, JSON.stringify(res), this.now());
        steps.push({ provider: "KERNEL", action: "CALLED", capability, detail: `${url} → ${res.statements.length} explicit statement(s)` });
      }
      for (const st of res.statements) claims = this.add(claims, productKey, capability, st.value, url, "KERNEL", this.inspector.provenance, st.quote);
      if (EvidenceRouter.judge(claims) !== "INSUFFICIENT") return done("PAGE_INSPECTION_SUFFICIENT");
    }
    return done("INSUFFICIENT_AFTER_ALL_ALLOWED_STEPS");
  }

  private async metered<T>(ctx: { userId: string; requestId: string }, provider: "TAVILY" | "KERNEL", operation: string, unit: string, estQty: number, logicalKey: string,
    provenance: UsageProvenance, fn: () => Promise<T>, actualQty?: (v: T) => number): Promise<{ ok: true; value: T } | { ok: false; blocked: boolean; reason: string }> {
    let rec;
    try { rec = this.ledger.begin({ userId: ctx.userId, requestId: ctx.requestId, provider, operation, logicalKey, quantity: estQty, unit, provenance, billable: this.opts.billable }); }
    catch (e) { if (e instanceof UsageLimitError) return { ok: false, blocked: true, reason: e.code }; throw e; }
    try {
      const value = await fn();
      this.ledger.complete(rec.record.id, { success: true, ...(actualQty ? { actualQuantity: actualQty(value) } : {}) });
      return { ok: true, value };
    } catch (e) {
      this.ledger.complete(rec.record.id, { success: false, failureReason: e instanceof Error ? e.message.slice(0, 120) : "error" });
      return { ok: false, blocked: false, reason: e instanceof Error ? e.message.slice(0, 120) : "provider error" };
    }
  }

  private stored(productKey: string, capability: string): CapabilityClaim[] {
    return (this.store.db.prepare("SELECT * FROM evidence_items WHERE product_key=? AND capability=? AND observed_at>?").all(productKey, capability, this.now() - EVIDENCE_TTL_MS) as Array<Record<string, string | number>>)
      .map((r) => ({ capability, value: Number(r.value) === 1, source: { kind: "INDEPENDENT_REVIEW" as const, url: String(r.url), title: `${r.provider} [${r.provenance}]: ${String(r.quote).slice(0, 120)}`, retrievedAt: new Date(Number(r.observed_at)).toISOString() } }));
  }

  private add(claims: CapabilityClaim[], productKey: string, capability: string, value: boolean, url: string, provider: string, provenance: string, quote: string): CapabilityClaim[] {
    if (claims.some((c) => c.source.url === url && c.capability === capability)) return claims;
    const id = createHash("sha256").update(`${productKey}|${capability}|${url}`).digest("hex").slice(0, 24);
    this.store.db.prepare("INSERT OR IGNORE INTO evidence_items(id,product_key,capability,value,kind,host,url,provider,provenance,quote,observed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, productKey, capability, value ? 1 : 0, "INDEPENDENT_REVIEW", host(url), url, provider, provenance, quote.slice(0, 300), this.now());
    return [...claims, { capability, value, source: { kind: "INDEPENDENT_REVIEW", url, title: `${provider} [${provenance}]: ${quote.slice(0, 120)}`, retrievedAt: new Date(this.now()).toISOString() } }];
  }
}
