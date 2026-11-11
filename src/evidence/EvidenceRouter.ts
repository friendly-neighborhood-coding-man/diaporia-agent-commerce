import { createHash } from "node:crypto";
import type { CapabilityClaim, CatalogProduct } from "../domain/types.js";
import { normalizeModel } from "../identity/ProductIdentityResolver.js";
import type { Store } from "../store/Database.js";
import { CAPABILITY_KEYWORDS, CAPABILITY_NEGATED, CAPABILITY_PHRASE } from "./capabilityText.js";
import { UsageLimitError, type UsageLedger, type UsageProvenance } from "../metering/UsageLedger.js";
import type { EvidenceSearchRequest, EvidenceSearchResponse } from "./providers.js";
import { SourceRegistry, hostOf, type DomainValidity } from "./SourceRegistry.js";
import { classifyItem, evidenceKindOf, judgeV2, statementFrom, type CapabilityVerdict, type EvidenceItem } from "./EvidenceV2.js";
import { capabilityPhrase, capabilityQueryPhrase } from "../research/capabilities.js";

/** Independent web search (e.g. Tavily). */
export interface IndependentSearchProvider {
  readonly name: string; readonly provenance: UsageProvenance;
  search(query: string): Promise<Array<{ url: string; title: string; snippet: string }>>;
  /** Optional research-V2 search with documented parameters (Tavily). Absent = plain `search`. */
  searchV2?(req: EvidenceSearchRequest): Promise<EvidenceSearchResponse>;
}
/** Research V2 multi-capability verification result. */
export interface VerifyManyResult {
  verdicts: Record<string, CapabilityVerdict>;
  steps: RouterStep[];
  /** Tavily searches actually sent (cache hits excluded). */
  searchesSent: number;
  /** Capabilities left UNVERIFIED because a limit stopped verification (never treated as optional). */
  blockedByLimit: string[];
}
/** Original-page inspection with a real browser (e.g. KERNEL). Returns explicit statements only. */
export interface PageInspectionResult {
  statements: Array<{ value: boolean; quote: string }>;
  browserSeconds: number;
  /** Why the page did or did not yield statements (diagnostic only; never evidence by itself). */
  outcome?: string;
}
export interface PageInspectionProvider {
  readonly name: string; readonly provenance: UsageProvenance;
  inspect(url: string, capability: string, modelToken: string): Promise<PageInspectionResult>;
  /** Optional free pre-check (URL/DNS policy). A non-null reason means the page is never inspected or metered. */
  refuse?(url: string): Promise<string | null>;
}

export type Sufficiency = "SUFFICIENT_TRUE" | "SUFFICIENT_FALSE" | "CONTRADICTED" | "INSUFFICIENT";
export interface RouterStep {
  provider: "STORE" | "TAVILY" | "KERNEL";
  action: "REUSED_EXISTING_EVIDENCE" | "SKIPPED_SUFFICIENT" | "CALLED" | "REUSED_CACHED_QUERY" | "REUSED_CACHED_PAGE" | "BLOCKED_BY_LIMIT" | "FAILED" | "EXCLUDED_NON_INDEPENDENT_SOURCE" | "REFUSED_BY_URL_POLICY";
  capability: string; detail: string;
  /** Cost provenance of the provider behind this step (MOCK, BYOK_LIVE or MANAGED_LIVE). Absent for STORE steps. */
  provenance?: UsageProvenance;
}
export interface RouterResult { capability: string; sufficiency: Sufficiency; claims: CapabilityClaim[]; steps: RouterStep[]; reason: string }

const PHRASE = CAPABILITY_PHRASE, KEYWORDS = CAPABILITY_KEYWORDS, NEGATED = CAPABILITY_NEGATED;
const MAX_KERNEL_PAGES = 2;
const EVIDENCE_TTL_MS = 30 * 86400_000;
const TRANSIENT_PAGE_OUTCOME = /^(NAVIGATION_FAILED|HTTP_5\d\d|HTTP_429|HTTP_408|ACCESS_CHALLENGE|EMPTY_DOCUMENT)/;
const host = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
/** Retailer / marketplace pages are merchant-controlled: never counted as INDEPENDENT evidence. */
const NOT_INDEPENDENT = /(^|\.)(amazon|ebay|walmart|bestbuy|target|aliexpress|temu|costco|newegg|bhphotovideo|sweetwater|cdw)\.[a-z.]+$/i;
/** Naive registrable domain (last two labels; known two-label public suffixes handled). */
function registrableDomain(h: string): string {
  const parts = h.split(".").filter(Boolean);
  const twoLabelSuffix = /^(co|com|org|net|ac|gov)\.(uk|kr|jp|au|nz|br|in)$/;
  return parts.length > 2 && twoLabelSuffix.test(parts.slice(-2).join(".")) ? parts.slice(-3).join(".") : parts.slice(-2).join(".");
}
/** Normalized statement fingerprint: lowercase words, first 12, without punctuation. Empty if too short. */
function fingerprint(text: string): string {
  const words = text.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean);
  return words.length >= 6 ? words.slice(0, 12).join(" ") : "";
}

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
    private readonly inspector: PageInspectionProvider | null,
    private readonly opts: { billable: boolean; now?: () => number; policy?: "v1" | "v2"; sources?: { expertReviewDomains?: string[]; forumDomains?: string[]; retailerDomains?: string[]; officialDomains?: Record<string, string[]>; domainValidity?: Record<string, DomainValidity>; asOf?: string; maxAgeDays?: number } } = { billable: false }) {
    this.policy = opts.policy ?? "v1";
    this.registry = new SourceRegistry({ ...(opts.sources ?? {}), now: opts.now ?? Date.now });
    store.db.exec(`CREATE TABLE IF NOT EXISTS evidence_items (id TEXT PRIMARY KEY, product_key TEXT NOT NULL, capability TEXT NOT NULL, value INTEGER NOT NULL,
        kind TEXT NOT NULL, host TEXT NOT NULL, url TEXT NOT NULL, provider TEXT NOT NULL, provenance TEXT NOT NULL, quote TEXT NOT NULL, observed_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS evidence_by_product ON evidence_items(product_key, capability);
      CREATE TABLE IF NOT EXISTS evidence_query_cache (query_key TEXT PRIMARY KEY, provider TEXT NOT NULL, hits_json TEXT NOT NULL, observed_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS evidence_page_cache (page_key TEXT PRIMARY KEY, provider TEXT NOT NULL, result_json TEXT NOT NULL, observed_at INTEGER NOT NULL);`);
  }
  /** "v1": legacy per-capability `verify`. "v2": `verifyMany` with source classes and the V2 sufficiency rule. */
  readonly policy: "v1" | "v2";
  readonly registry: SourceRegistry;
  private now() { return (this.opts.now ?? Date.now)(); }

  /**
   * Research V2: verifies several capabilities of one product with ONE combined search (cached), classifies every
   * source, applies the V2 sufficiency rule (EvidenceV2.ts) and returns traceable evidence for each capability.
   * `sellers` = domains that sell any candidate in this session (always retailer-class). Fails closed on limits.
   */
  async verifyMany(product: CatalogProduct, capabilities: string[], ctx: { userId: string; requestId: string }, o: { sellers?: string[]; maxSearches?: number } = {}): Promise<VerifyManyResult> {
    const steps: RouterStep[] = [];
    const sellers = o.sellers ?? [];
    const brand = product.identity.brand || null;
    const productKey = `v2|${product.identity.brand}|${normalizeModel(product.identity.model || product.title)}|${product.identity.variant ?? ""}`.toLowerCase();
    const items: Record<string, EvidenceItem[]> = Object.fromEntries(capabilities.map((c) => [c, [] as EvidenceItem[]]));
    const nowIso = new Date(this.now()).toISOString();
    // Stored evidence is reclassified with the CURRENT registry on read (a registry change takes effect immediately).
    for (const cap of capabilities) for (const r of this.store.db.prepare("SELECT * FROM evidence_items WHERE product_key=? AND capability=? AND observed_at>?").all(productKey, cap, this.now() - EVIDENCE_TTL_MS) as Array<Record<string, string | number>>) {
      const [quote, publishedDate, requestId] = String(r.quote).split("\u0000");
      items[cap]!.push(classifyItem({ url: String(r.url), domain: String(r.host), sourceClass: this.registry.classify(String(r.url), brand, sellers, publishedDate || null), value: Number(r.value) === 1, quote: quote ?? "",
        publishedDate: publishedDate || null, provider: String(r.provider), requestId: requestId || null, observedAt: new Date(Number(r.observed_at)).toISOString() }, this.now()));
    }
    // Claims already on the product (fixtures, catalog data) count only if the registry confirms their declared source (V2.1).
    for (const c of product.capabilities) if (items[c.capability] && c.source.kind !== "CATALOG_LISTING")
      items[c.capability]!.push(classifyItem({ url: c.source.url, domain: hostOf(c.source.url), sourceClass: this.registry.confirmDeclared(c.source.kind, c.source.url, brand, null),
        value: c.value, quote: c.source.title, publishedDate: null, provider: "CATALOG_FIXTURE", requestId: null, observedAt: c.source.retrievedAt }, this.now()));
    const verdicts = (): Record<string, CapabilityVerdict> => Object.fromEntries(capabilities.map((c) => [c, judgeV2(c, items[c]!)]));
    let v = verdicts();
    const pending = () => capabilities.filter((c) => v[c]!.status === "UNVERIFIED");
    if (capabilities.length && !pending().length) steps.push({ provider: "STORE", action: "SKIPPED_SUFFICIENT", capability: capabilities.join(","), detail: "stored evidence meets the V2 sufficiency rule" });
    const blocked: string[] = [];
    let sent = 0;
    const maxSearches = o.maxSearches ?? 2;
    for (let round = 0; this.search && pending().length && round < maxSearches; round++) {
      // One combined query for up to three pending capabilities, the model quoted for precision; sellers excluded.
      const caps = pending().slice(0, 3);
      const subject = product.identity.model ? `"${[product.identity.brand, product.identity.model].filter(Boolean).join(" ")}"` : `"${product.identity.brand}" ${product.title.replace(new RegExp(product.identity.brand, "i"), "").slice(0, 60)}`;
      const query = `${subject} ${caps.map(capabilityQueryPhrase).join(" ")} specs review`.replace(/\s+/g, " ").trim();
      const req: EvidenceSearchRequest = { query, maxResults: 10, exactMatch: !!product.identity.model, excludeDomains: [...new Set(sellers)].slice(0, 150), depth: "basic" };
      const queryKey = createHash("sha256").update(`${this.search.name}|v2|${JSON.stringify(req).toLowerCase()}`).digest("hex");
      let resp: EvidenceSearchResponse;
      const cached = this.store.db.prepare("SELECT hits_json, observed_at FROM evidence_query_cache WHERE query_key=?").get(queryKey) as { hits_json: string; observed_at: number } | undefined;
      if (cached && this.now() - cached.observed_at < EVIDENCE_TTL_MS) { resp = JSON.parse(cached.hits_json); steps.push({ provider: "TAVILY", action: "REUSED_CACHED_QUERY", capability: caps.join(","), detail: query, provenance: this.search.provenance }); }
      else {
        const r = await this.metered(ctx, "TAVILY", "search", "search", 1, `tavily:${queryKey}`, this.search.provenance,
          async () => this.search!.searchV2 ? this.search!.searchV2(req) : { hits: (await this.search!.search(query)).map((h) => ({ ...h, publishedDate: null, score: null })), requestId: null, credits: 1, responseTimeS: null },
          (x) => Math.max(1, x.credits));
        if (!r.ok) { steps.push({ provider: "TAVILY", action: r.blocked ? "BLOCKED_BY_LIMIT" : "FAILED", capability: caps.join(","), detail: r.reason, provenance: this.search.provenance }); if (r.blocked) blocked.push(...caps); break; }
        resp = r.value; sent++;
        this.store.db.prepare("INSERT OR REPLACE INTO evidence_query_cache(query_key,provider,hits_json,observed_at) VALUES (?,?,?,?)").run(queryKey, this.search.name, JSON.stringify(resp), this.now());
        steps.push({ provider: "TAVILY", action: "CALLED", capability: caps.join(","), detail: `${query} → ${resp.hits.length} results${resp.requestId ? ` (request ${resp.requestId})` : ""}`, provenance: this.search.provenance });
      }
      let gained = false;
      for (const h of resp.hits) for (const cap of caps) {
        const st = statementFrom(h, product, cap);
        if (!st || items[cap]!.some((x) => x.url === h.url)) continue;
        const it = classifyItem({ url: h.url, domain: hostOf(h.url), sourceClass: this.registry.classify(h.url, brand, sellers, h.publishedDate), value: st.value, quote: st.quote, publishedDate: h.publishedDate,
          provider: this.search.name, requestId: resp.requestId, observedAt: nowIso }, this.now());
        items[cap]!.push(it); gained = true;
        const id = createHash("sha256").update(`${productKey}|${cap}|${h.url}`).digest("hex").slice(0, 24);
        this.store.db.prepare("INSERT OR IGNORE INTO evidence_items(id,product_key,capability,value,kind,host,url,provider,provenance,quote,observed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
          .run(id, productKey, cap, st.value ? 1 : 0, evidenceKindOf(it.sourceClass), it.domain, h.url, this.search.name, this.search.provenance, `${st.quote}\u0000${h.publishedDate ?? ""}\u0000${resp.requestId ?? ""}`, this.now());
      }
      v = verdicts();
      // Stopping rule: another combined query only when this one taught us something and capabilities remain beyond the first three.
      if (!gained || pending().every((c) => caps.includes(c))) break;
    }
    if (!this.search && pending().length) steps.push({ provider: "TAVILY", action: "FAILED", capability: pending().join(","), detail: "no independent search provider configured" });
    return { verdicts: v, steps, searchesSent: sent, blockedByLimit: blocked };
  }

  static judge(claims: CapabilityClaim[]): Sufficiency {
    const manu = claims.filter((c) => c.source.kind === "MANUFACTURER");
    const indep = claims.filter((c) => c.source.kind === "INDEPENDENT_REVIEW");
    const strong = [...manu, ...indep];
    if (strong.some((c) => c.value) && strong.some((c) => !c.value)) return "CONTRADICTED";
    if (manu.length) return manu[0]!.value ? "SUFFICIENT_TRUE" : "SUFFICIENT_FALSE";
    for (const v of [true, false]) if (EvidenceRouter.independentSources(indep.filter((c) => c.value === v)) >= 2) return v ? "SUFFICIENT_TRUE" : "SUFFICIENT_FALSE";
    return "INSUFFICIENT";
  }

  /**
   * Counts genuinely independent sources: subdomains of one registrable domain count once, and pages on
   * different domains that reproduce the same statement (syndicated / copied text) count once.
   */
  static independentSources(claims: CapabilityClaim[]): number {
    const groups: Array<{ domains: Set<string>; prints: Set<string> }> = [];
    for (const c of claims) {
      const d = registrableDomain(host(c.source.url));
      const fp = fingerprint(c.source.title.includes("]: ") ? c.source.title.split("]: ").slice(1).join("]: ") : "");
      const g = groups.find((x) => x.domains.has(d) || (fp !== "" && x.prints.has(fp)));
      if (g) { g.domains.add(d); if (fp) g.prints.add(fp); } else groups.push({ domains: new Set([d]), prints: new Set(fp ? [fp] : []) });
    }
    return groups.length;
  }

  async verify(product: CatalogProduct, capability: string, ctx: { userId: string; requestId: string }): Promise<RouterResult> {
    const steps: RouterStep[] = [];
    const productKey = `${product.identity.brand}|${normalizeModel(product.identity.model)}`.toLowerCase();
    const modelToken = product.identity.model;
    let claims = [...product.capabilities.filter((c) => c.capability === capability), ...this.stored(productKey, capability)];
    if (claims.length > product.capabilities.filter((c) => c.capability === capability).length) steps.push({ provider: "STORE", action: "REUSED_EXISTING_EVIDENCE", capability, detail: "previously verified independent evidence (fresh)" });
    const done = (reason: string): RouterResult => {
      const sufficiency = EvidenceRouter.judge(claims);
      return { capability, sufficiency, claims, steps, reason: sufficiency === "CONTRADICTED" ? "CONTRADICTED_EVIDENCE_NEEDS_REVIEW" : reason };
    };
    const existing = EvidenceRouter.judge(claims);
    if (existing !== "INSUFFICIENT") {
      steps.push({ provider: "STORE", action: "SKIPPED_SUFFICIENT", capability, detail: existing === "CONTRADICTED" ? "existing evidence is contradictory; more searching cannot resolve it automatically" : "existing evidence meets the sufficiency rule" });
      return done("EXISTING_EVIDENCE_SUFFICIENT");
    }
    if (!this.search) return done("NO_INDEPENDENT_SEARCH_PROVIDER");

    // Tavily: one normalized query per (product, capability), cached.
    const query = `"${product.identity.brand} ${modelToken}" ${PHRASE[capability] ?? capability} review`;
    const queryKey = createHash("sha256").update(`${this.search.name}|${query.toLowerCase()}`).digest("hex");
    let hits: Array<{ url: string; title: string; snippet: string }>;
    const cached = this.store.db.prepare("SELECT hits_json, observed_at FROM evidence_query_cache WHERE query_key=?").get(queryKey) as { hits_json: string; observed_at: number } | undefined;
    if (cached && this.now() - cached.observed_at < EVIDENCE_TTL_MS) { hits = JSON.parse(cached.hits_json); steps.push({ provider: "TAVILY", action: "REUSED_CACHED_QUERY", capability, detail: query, provenance: this.search.provenance }); }
    else {
      const r = await this.metered(ctx, "TAVILY", "search", "search", 1, `tavily:${queryKey}`, this.search.provenance, () => this.search!.search(query));
      if (!r.ok) { steps.push({ provider: "TAVILY", action: r.blocked ? "BLOCKED_BY_LIMIT" : "FAILED", capability, detail: r.reason, provenance: this.search.provenance }); return done(r.blocked ? "VERIFICATION_REQUIRED_BUT_LIMIT_REACHED" : "SEARCH_FAILED"); }
      hits = r.value;
      this.store.db.prepare("INSERT OR REPLACE INTO evidence_query_cache(query_key,provider,hits_json,observed_at) VALUES (?,?,?,?)").run(queryKey, this.search.name, JSON.stringify(hits), this.now());
      steps.push({ provider: "TAVILY", action: "CALLED", capability, detail: `${query} → ${hits.length} results`, provenance: this.search.provenance });
    }
    // Snippet statements count only if they name the exact model token and state the capability.
    const model = new RegExp(modelToken.replace(/[^A-Za-z0-9]/g, "[- ]?"), "i");
    const needsPage: string[] = [];
    for (const h of hits) {
      if (!model.test(`${h.title} ${h.snippet}`)) continue;
      if (NOT_INDEPENDENT.test(host(h.url))) { steps.push({ provider: "TAVILY", action: "EXCLUDED_NON_INDEPENDENT_SOURCE", capability, detail: `excluded retailer/marketplace source ${host(h.url)}` }); continue; }
      const kw = KEYWORDS[capability];
      const sentence = kw ? h.snippet.split(/(?<=[.!?])\s+/).find((s) => kw.test(s)) : undefined;
      if (sentence) claims = this.add(claims, productKey, capability, !(NEGATED[capability]?.test(sentence) ?? false), h.url, "TAVILY", this.search.provenance, sentence);
      else needsPage.push(h.url);
    }
    if (EvidenceRouter.judge(claims) !== "INSUFFICIENT") return done("INDEPENDENT_SEARCH_SUFFICIENT");
    if (!this.inspector) return done("NO_PAGE_INSPECTION_PROVIDER");
    // KERNEL: only pages that mention the exact model but whose snippet did not state the capability.
    for (const url of needsPage.slice(0, MAX_KERNEL_PAGES)) {
      const prov = this.inspector.provenance;
      // URL policy is checked BEFORE metering: a refused URL costs nothing and uses no call budget.
      const refused = this.inspector.refuse ? await this.inspector.refuse(url) : null;
      if (refused) { steps.push({ provider: "KERNEL", action: "REFUSED_BY_URL_POLICY", capability, detail: `${url}: ${refused}`, provenance: prov }); continue; }
      const pageKey = createHash("sha256").update(`${this.inspector.name}|${url}|${capability}`).digest("hex");
      const pc = this.store.db.prepare("SELECT result_json, observed_at FROM evidence_page_cache WHERE page_key=?").get(pageKey) as { result_json: string; observed_at: number } | undefined;
      let res: PageInspectionResult;
      if (pc && this.now() - pc.observed_at < EVIDENCE_TTL_MS) { res = JSON.parse(pc.result_json); steps.push({ provider: "KERNEL", action: "REUSED_CACHED_PAGE", capability, detail: url, provenance: prov }); }
      else {
        const epoch = Math.floor(this.now() / EVIDENCE_TTL_MS);
        const r = await this.metered(ctx, "KERNEL", "inspect", "browser_second", 30, `kernel:${pageKey}:${epoch}`, prov, () => this.inspector!.inspect(url, capability, modelToken),
          (v) => Math.max(1, Math.ceil(v.browserSeconds)));
        if (!r.ok) { steps.push({ provider: "KERNEL", action: r.blocked ? "BLOCKED_BY_LIMIT" : "FAILED", capability, detail: `${url}: ${r.reason}`, provenance: prov }); if (r.blocked) return done("VERIFICATION_REQUIRED_BUT_LIMIT_REACHED"); continue; }
        res = r.value;
        // Transient outcomes (navigation failure, server errors, rate limits, challenges, empty renders) are not cached.
        if (!TRANSIENT_PAGE_OUTCOME.test(res.outcome ?? ""))
          this.store.db.prepare("INSERT OR REPLACE INTO evidence_page_cache(page_key,provider,result_json,observed_at) VALUES (?,?,?,?)").run(pageKey, this.inspector.name, JSON.stringify(res), this.now());
        steps.push({ provider: "KERNEL", action: "CALLED", capability, detail: `${url} → ${res.statements.length} explicit statement(s)${res.outcome ? ` [${res.outcome}]` : ""}; ${Math.ceil(res.browserSeconds)} browser-second(s)`, provenance: prov });
      }
      for (const st of res.statements) claims = this.add(claims, productKey, capability, st.value, url, "KERNEL", prov, st.quote);
      if (EvidenceRouter.judge(claims) !== "INSUFFICIENT") return done("PAGE_INSPECTION_SUFFICIENT");
    }
    return done("INSUFFICIENT_AFTER_ALL_ALLOWED_STEPS");
  }

  private async metered<T>(ctx: { userId: string; requestId: string }, provider: "TAVILY" | "KERNEL", operation: string, unit: string, estQty: number, logicalKey: string,
    provenance: UsageProvenance, fn: () => Promise<T>, actualQty?: (v: T) => number): Promise<{ ok: true; value: T } | { ok: false; blocked: boolean; reason: string }> {
    let rec;
    try { rec = this.ledger.begin({ userId: ctx.userId, requestId: ctx.requestId, provider, operation, logicalKey, quantity: estQty, unit, provenance, billable: this.opts.billable }); }
    catch (e) { if (e instanceof UsageLimitError) return { ok: false, blocked: true, reason: e.code }; throw e; }
    // The ledger already holds a completed record for this logical operation but our cache does not: never make
    // an unrecorded provider call. Treat as not verified (the caller keeps the capability INSUFFICIENT).
    if (rec.reuse) return { ok: false, blocked: true, reason: "LEDGER_RECORDED_RESULT_NOT_CACHED" };
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
