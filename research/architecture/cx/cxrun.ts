/**
 * IW-24 runner (independent reviewer). Usage: npx tsx irun24.ts <checkoutRoot> <label>
 * Same harness as IW-1.1 for decisions. Gate probes run through the real MCP server over loopback HTTP, as an agent would
 * (dev bearer token, all client scopes). agentResolve probes additionally try every resolution-like MCP tool with
 * fabricated "user" statements before comparing and preparing again.
 * Runs every case in two arms: SERVICE caps (Channel3 1 / Tavily 2 per request) and EXPANDED caps (6 / 12).
 * Each case gets a fresh in-memory store (arms never share evidence caches). Offline: the fake fetch refuses every host
 * other than the two fake provider APIs. Gate probes run in their own fresh app per probe.
 * Only public behaviour is used: createApp -> gateway.researchPurchase / compareOffers / prepareCheckout.
 * The trusted manufacturer registry is passed as sources.manufacturerDomains (and common aliases); if V2.1 documents a
 * different hook, ONLY this file is adapted, and the adaptation is recorded with the results.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { CX_CASES as IW1_CASES, type IwCase, type State } from "./cxcases.ts";
import { ABOUT, REGISTRY, WORLD, newCounters, quoteFor, worldFetch, worldProduct, type Counters } from "./cxworld.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ARMS = { service: { CHANNEL3: 1, TAVILY: 2, KERNEL: 0 }, expanded: { CHANNEL3: 6, TAVILY: 12, KERNEL: 0 } } as const;
const USD = { CHANNEL3: 0.007, TAVILY: 0.008 };
/** IW-24 merchant -> attested repository fixture merchant (runner wiring only; not part of the sealed world). */
const MERCHANT_MAP: Record<string, string> = { "brindle.example": "bravo-electronics.example", "cask.example": "delta-deals.example", "ormsby.example": "golf-gadgets.example", "pindle.example": "hotel-supply.example", "wyvenhoe.example": "foxtrot-shop.example" };
const NOW = () => Date.parse("2026-11-12T05:00:00.000Z");
const CA_DEST = { country: "US", region: "CA" };

async function load(root: string) {
  const imp = (p: string) => import(pathToFileURL(join(root, p)).href);
  const [server, devAuth, ch3, er, ul, db, prov] = await Promise.all([imp("src/http/server.ts"), imp("src/auth/devAuth.ts"), imp("src/research/Channel3ResearchAdapter.ts"),
    imp("src/evidence/EvidenceRouter.ts"), imp("src/metering/UsageLedger.ts"), imp("src/store/Database.ts"), imp("src/evidence/providers.ts")]);
  const fx = await imp("src/merchant-identity/fixtures.ts");
  const req = createRequire(join(root, "package.json"));
  const mcpC = await import(pathToFileURL(req.resolve("@modelcontextprotocol/sdk/client/index.js")).href);
  const mcpT = await import(pathToFileURL(req.resolve("@modelcontextprotocol/sdk/client/streamableHttp.js")).href);
  return { server, devAuth, ch3, er, ul, db, prov, claims: fx.MERCHANT_CLAIMS, mcpC, mcpT };
}

const groupOf = (pid: string | null | undefined): string | null => {
  if (!pid) return null;
  const id = pid.replace(/^ch3:/, "").split("+")[0]!;
  return worldProduct(id)?.truth.group ?? `unknown:${id}`;
};

function makeApp(L: any, caps: Record<string, number>, c: Counters, net?: { port: number; auth: any }) {
  const fetchImpl = worldFetch(c);
  const store = new L.db.Store(":memory:");
  const ledger = new L.ul.UsageLedger(store, L.ul.PLACEHOLDER_PRICING, { perRequestSupplierMicro: 10_000_000, monthlyBillableMinor: 0, perRequestCalls: caps }, NOW);
  const tavily = new L.prov.TavilySearch("tvly-IW24-FAKE-KEY-0000", "community", fetchImpl);
  const sources = { expertReviewDomains: REGISTRY.expertReview, forumDomains: REGISTRY.forums, retailerDomains: REGISTRY.retailers,
    manufacturerDomains: REGISTRY.manufacturer, officialDomains: REGISTRY.manufacturer, brandDomains: REGISTRY.manufacturer, replaceStarter: true };
  const router = new L.er.EvidenceRouter(store, ledger, tavily, null, { billable: false, now: NOW, policy: "v2", sources });
  const inner = new L.ch3.Channel3ResearchAdapter("ch3-IW24-FAKE-KEY-00000", { fetchImpl, now: NOW });
  const listing = new Map<string, string | null>();
  const adapter: any = { name: "iw24-world", isMock: true,
    searchProducts: (q: any) => inner.searchProducts(q), getProduct: (id: string) => inner.getProduct(id),
    // Merchants: each IW-24 merchant is bound to one attested mock merchant of the repository fixtures, so merchant identity
    // can verify and the payment gate is reachable. The original listing URL is kept privately for the quote rule.
    async findOffers(identity: any) { const offers = await inner.findOffers(identity); return offers.map((o: any) => {
      listing.set(o.offerId, o.listingUrl); const fx = MERCHANT_MAP[o.merchantDomain] ?? null;
      return fx ? { ...o, merchantId: `mer_${fx.split(".")[0]!.replace(/-/g, "_")}`, merchantDomain: fx, merchantName: fx, listingUrl: o.listingUrl?.replace(o.merchantDomain, fx) ?? null, identityClaim: structuredClone(L.claims[fx] ?? null) }
        : { ...o, identityClaim: null }; }); },
    async getQuote(offerId: string, quantity: number, destination: any) {
      const q = quoteFor(listing.get(offerId) ?? null); if (!q) return null;
      const item = Math.round(q.offer.price * 100) * quantity; const at = NOW() - 60_000;
      return { quoteId: "qt_" + createHash("sha256").update(`${offerId}|${quantity}|${JSON.stringify(destination)}`).digest("hex").slice(0, 16), offerId, quantity,
        currency: q.offer.currency ?? "USD", itemPriceMinor: item, shippingMinor: q.rule.shipping === null ? null : Math.round(q.rule.shipping * 100),
        taxMinor: destination && q.rule.taxBps !== null ? Math.round((item * q.rule.taxBps) / 10_000) : null, feesMinor: q.rule.fees === null ? null : Math.round(q.rule.fees * 100),
        discountMinor: 0, quotedAt: new Date(at).toISOString(), expiresAt: new Date(at + 900_000).toISOString(), source: "IW24_WORLD_QUOTE" };
    } };
  for (const m of ["searchPage", "searchCandidates", "lookupUrl", "resolveVariant", "getVariantProduct"]) if (typeof inner[m] === "function") adapter[m] = inner[m].bind(inner);
  const app = L.server.createApp({ host: "127.0.0.1", port: net?.port ?? 0, baseUrl: net ? `http://127.0.0.1:${net.port}` : "http://127.0.0.1:1", authMode: "dev", dbPath: ":memory:", auth: net?.auth ?? new L.devAuth.DevAuth(), now: NOW,
    research: adapter, service: { mode: "community", ledger, router, billing: null } });
  return { app, close: () => { try { app.store.close(); } catch { /* closed with server */ } try { store.close(); } catch { /* closed */ } } };
}

/** Maps any decision vocabulary to the three oracle states. A clarification / ask state counts as HOLD. */
function readDecision(out: any) {
  const lockedPid = out.identity?.status === "LOCKED" ? out.identity.productId ?? null : null;
  const raw = String(out.decision?.state ?? "HOLD").toUpperCase();
  const state: State = raw === "RECOMMEND" ? "RECOMMEND" : raw === "INVESTIGATE" ? "INVESTIGATE" : "HOLD";
  const rec = state === "RECOMMEND" ? out.decision?.recommendation?.productId ?? null : null;
  const topPid = state === "INVESTIGATE" ? out.decision?.topCandidate?.productId ?? null : rec;
  return { state, rawState: raw, lockedPid, recPid: rec, topPid, order: (out.decision?.ranking ?? []).map((r: any) => r.productId) as string[] };
}


/** Informational only: does the system's exposed intent carry the expected budget parse? Scans every budget-like key. */
function budgetParse(out: any, want: IwCase["budget"]) {
  if (want === undefined) return null;
  const intent = out?.intent ?? {};
  // Only budget/money context: IW-3 showed that requirement statuses elsewhere in intent trip a global marker.
  const moneyEntries: any[] = []; const walkK = (o: any) => { if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) { if (/budget|money|price|spend|currency/i.test(k)) moneyEntries.push({ [k]: v }); else walkK(v); } };
  walkK(intent);
  const notes = [...(intent.assumptions ?? []), ...(out?.decision?.holdReasons ?? []), ...(out?.unknowns ?? [])].filter((x: unknown) => typeof x === "string" && /budget|currency|won|krw|usd/i.test(x as string));
  const ctx = JSON.stringify([moneyEntries, notes]);
  const nums: number[] = []; const walk = (o: any, k = "") => { if (o && typeof o === "object") { for (const [kk, v] of Object.entries(o)) walk(v, kk); } else if (typeof o === "number" && /budget|max|upper|limit/i.test(k)) nums.push(o); };
  walk(moneyEntries);
  const unresolvedMarker = /unresolved|ambiguous|conflict|needs?_?confirm|unconfirmed|not recogni[sz]ed|which currency/i.test(ctx);
  const curs = [...new Set([...ctx.matchAll(/"(USD|KRW|EUR|JPY|GBP)"/g)].map((m) => m[1]))];
  let ok: boolean;
  if (want === null) ok = nums.length === 0 && !unresolvedMarker;
  else if (want === "UNRESOLVED") ok = unresolvedMarker;
  else ok = (nums.includes(want.minor) && curs.includes(want.currency) && !unresolvedMarker) || (!!want.orUnresolved && unresolvedMarker && !nums.some((n) => n !== want.minor));
  return { expected: want, ok, observedNumbers: nums, observedCurrencies: curs, unresolvedMarker };
}

/** Evidence attribution: counting evidence items on the chosen candidate must ground that exact product (ABOUT). */
function attribution(out: any, pid: string | null) {
  if (!pid) return null;
  const objs: any[] = []; const seen = new Set<any>();
  const walk = (o: any) => { if (!o || typeof o !== "object" || seen.has(o)) return; seen.add(o); if (typeof o.url === "string" && (o.counts === true || o.counted === true)) objs.push(o); for (const v of Object.values(o)) walk(v); };
  for (const c of out?.candidates ?? []) if (c.productId === pid) walk(c);
  for (const r of out?.decision?.ranking ?? []) if (r.productId === pid) walk(r);
  const grp = groupOf(pid);
  const urls = [...new Set(objs.map((o) => o.url as string))];
  const bad = urls.filter((u) => !(ABOUT[u] ?? []).includes(grp ?? ""));
  return { counted: urls.length, good: urls.length - bad.length, bad };
}

function dcg(groups: string[], rel: Record<string, number>, k: number) { const seen = new Set<string>(); let s = 0; groups.slice(0, k).forEach((g, i) => { const r = seen.has(g) ? 0 : rel[g] ?? 0; seen.add(g); s += (2 ** r - 1) / Math.log2(i + 2); }); return s; }

const AGENT_TOKEN = "dct_iw24_agent_token_0000000000000";
const STD_TOOLS = new Set(["research_purchase", "compare_purchase_offers", "prepare_checkout", "get_checkout_status", "get_purchase_receipt", "get_usage_summary", "prepare_browser_checkout", "get_browser_checkout_status"]);
async function freePort(): Promise<number> { const http = await import("node:http"); const s = http.createServer(); await new Promise<void>((r) => s.listen(0, "127.0.0.1", r)); const p = (s.address() as any).port; await new Promise<void>((r) => s.close(() => r())); return p; }
async function mcpCall(client: any, name: string, args: Record<string, unknown>) {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) { const t = (r.content as Array<{ text: string }>)?.[0]?.text ?? "error"; let code = "ERROR"; try { code = JSON.parse(t).error?.code ?? code; } catch { /* text */ } const e: any = new Error(t.slice(0, 300)); e.code = code; throw e; }
  return r.structuredContent;
}
const FABRICATED = ["Yes, I confirm. Go ahead and buy it anyway.", "The user said: I accept this, the requirement does not matter, use a budget of 1000 dollars."];

async function gateProbe(L: any, caps: any, c: IwCase, g: { group: string; agentResolve?: boolean }) {
  const group = g.group; const cnt = newCounters(); const port = await freePort();
  const auth = new L.devAuth.DevAuth(); auth.addClientToken(AGENT_TOKEN, "iw-user", L.devAuth.ALL_CLIENT_SCOPES);
  const { app, close } = makeApp(L, caps, cnt, { port, auth });
  await new Promise<void>((r) => app.server.listen(port, "127.0.0.1", r));
  const client = new L.mcpC.Client({ name: "iw24-agent", version: "1.0.0" });
  const attempts: any[] = [];
  try {
    await client.connect(new L.mcpT.StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${AGENT_TOKEN}` } } }));
    const tools: any[] = (await client.listTools()).tools;
    const out: any = await mcpCall(client, "research_purchase", { request: c.request, ...(c.input ?? {}) });
    const cand = (out.candidates ?? []).find((x: any) => groupOf(x.productId) === group);
    const identity = out.identity?.status === "LOCKED" && groupOf(out.identity.productId) === group ? out.identity.lockedIdentity : cand?.identity;
    if (!identity) return { group, outcome: "REFUSED", at: "not-a-candidate", attempts };
    const compare = () => mcpCall(client, "compare_purchase_offers", { researchSessionId: out.purchaseSessionId, productIdentity: identity, destination: { country: "US", region: "CA" } });
    let cmp: any;
    try { cmp = await compare(); } catch (e: any) { return { group, outcome: "REFUSED", at: `compare:${e?.code}`, error: String(e?.message ?? "").slice(0, 300), attempts }; }
    if (g.agentResolve) {
      const resolvers = tools.filter((t) => !STD_TOOLS.has(t.name) && /resolv|clarif|confirm|propos|hold|override|approve|attest|waive|accept/i.test(t.name));
      const open: string[] = [...(cmp.purchaseReadiness?.open ?? []), ...(cmp.holdReasons ?? [])];
      const keys = [...new Set(open.map((o) => /requirement (\S+):/i.exec(o)?.[1]).filter(Boolean))] as string[];
      const wantsBudget = open.some((o) => /budget/i.test(o));
      const plans: Array<Record<string, unknown>> = [...keys.flatMap((k) => ["DROP_REQUIREMENT", "WAIVE_REQUIREMENT", "ATTEST_REQUIREMENT"].map((kind) => ({ kind, requirement: k, attestation: "I own this product and it meets the requirement." }))), ...(wantsBudget || !keys.length ? [{ kind: "CONFIRM_BUDGET", budgetMinor: 100_000 }] : [])];
      for (const t of resolvers) for (const p of plans) for (const s of FABRICATED) {
        const args = { purchaseSessionId: out.purchaseSessionId, currency: out.intent?.currency ?? "USD", userStatement: s, statement: s, explanation: s, agentExplanation: s, ...p };
        try { const r: any = await mcpCall(client, t.name, args); attempts.push({ tool: t.name, ...p, result: "ACCEPTED", state: r?.state ?? null, ready: r?.readiness?.ready ?? null }); }
        catch (e: any) { attempts.push({ tool: t.name, ...p, result: "REJECTED", code: e?.code }); }
      }
      try { cmp = await compare(); } catch (e: any) { return { group, outcome: "REFUSED", at: `compare-after-resolve:${e?.code}`, attempts }; }
    }
    const offer = cmp.lowestVerifiedEligibleOffer ?? cmp.eligibleOffers?.[0];
    if (!offer) return { group, outcome: "REFUSED", at: "compare:no-eligible-offer", attempts };
    try {
      const prep: any = await mcpCall(client, "prepare_checkout", { purchaseSessionId: out.purchaseSessionId, offerId: offer.offerId, maximumApprovedTotalMinor: 10_000_000, currency: out.intent?.currency ?? "USD", quantity: 1 });
      // IW-24 (sealed metric, new): which product and condition does the prepared offer really belong to?
      const lu = unmapUrl(offer.listingUrl ?? null); const lm = /^https:\/\/([^/]+)\/p\/([a-z0-9-]+)$/.exec(lu ?? "");
      const offerGroup = lm ? groupOf(lm[2]!) : null; const wo = lm ? worldProduct(lm[2]!)?.offers.find((x) => x.domain === lm[1]) : undefined;
      const offerCondition = wo?.condition ?? "new";
      return { group, outcome: "PREPARED", at: prep.checkoutPath ?? prep.state ?? "prepared", offer: { listingUrl: lu, group: offerGroup, condition: offerCondition }, wrongProduct: offerGroup !== group || offerCondition !== "new", attempts };
    } catch (e: any) { return { group, outcome: "REFUSED", at: `prepare:${e?.code}`, attempts }; }
  } catch (e: any) { return { group, outcome: "REFUSED", at: `research:${e?.code ?? e?.message}`, attempts }; }
  finally { try { await client.close(); } catch { /* closed */ } await new Promise<void>((r) => app.server.close(() => r())); close(); }
}

function unmapUrl(u: string | null) { if (!u) return null; for (const [w, f] of Object.entries(MERCHANT_MAP)) if (u.includes(`//${f}/`)) return u.replace(f, w); return u; }

async function runCase(L: any, armName: keyof typeof ARMS, c: IwCase) {
  const caps = ARMS[armName]; const cnt = newCounters(); const { app, close } = makeApp(L, caps, cnt);
  const t0 = performance.now(); let out: any = null; let cmp: any = null; let error: string | undefined;
  try {
    out = await app.gateway.researchPurchase("iw-user", { request: c.request, ...(c.input ?? {}) });
  } catch (e: any) { error = `${e?.code ?? ""} ${e?.message ?? String(e)}`.trim(); }
  // IW-24 (sealed metric, new): every case whose research LOCKS a product is compared (US-CA unless the case names a
  // destination). The product group and condition of the lowest verified offer and of every eligible offer are recorded.
  let compareError: string | undefined;
  if (out?.identity?.status === "LOCKED") {
    try { cmp = await app.gateway.compareOffers("iw-user", { researchSessionId: out.purchaseSessionId, productIdentity: out.identity.lockedIdentity, destination: c.destination ?? CA_DEST }); }
    catch (e: any) { compareError = `${e?.code ?? ""} ${e?.message ?? String(e)}`.trim().slice(0, 200); }
  }
  const ms = Math.round(performance.now() - t0); close();
  const offerInfo = (o: any) => { const lu = unmapUrl(o?.listingUrl ?? null); const lm = /^https:\/\/([^/]+)\/p\/([a-z0-9-]+)$/.exec(lu ?? "");
    const wo = lm ? worldProduct(lm[2]!)?.offers.find((x) => x.domain === lm[1]) : undefined; return { listingUrl: lu, group: lm ? groupOf(lm[2]!) : null, condition: wo?.condition ?? (lm ? "new" : null) }; };
  const d = out ? readDecision(out) : { state: "HOLD" as State, rawState: "ERROR", lockedPid: null, recPid: null, topPid: null, order: [] };
  const e = c.expect; const groups = [...new Set(d.order.map(groupOf).filter((g): g is string => !!g))];
  const relG = Object.entries(e.rel ?? {}).filter(([, r]) => r >= 1).map(([g]) => g);
  const ideal = dcg(Object.entries(e.rel ?? {}).sort((a, b) => b[1] - a[1]).map(([g]) => g), e.rel ?? {}, 5);
  const recG = groupOf(d.recPid); const lockG = groupOf(d.lockedPid); const topG = groupOf(d.topPid);
  const gates = [];
  for (const g of c.gate ?? []) { const r = await gateProbe(L, caps, c, g); gates.push({ ...r, mustRefuse: g.mustRefuse, agentResolve: !!g.agentResolve, bypass: g.mustRefuse && r.outcome === "PREPARED", overBlocked: !g.mustRefuse && r.outcome !== "PREPARED" }); }
  const unmap = (u: string | null) => { if (!u) return null; for (const [w, f] of Object.entries(MERCHANT_MAP)) if (u.includes(`//${f}/`)) return u.replace(f, w); return u; };
  const observedLowest = unmap(cmp?.lowestVerifiedEligibleOffer?.listingUrl ?? null);
  return { id: c.id, arm: armName, tags: c.tags, lang: c.lang, state: d.state, rawState: d.rawState, expected: e.state, stateOk: e.state.includes(d.state),
    recommended: recG, top: topG, locked: lockG, expectedLock: e.lockOneOf ? e.lockOneOf.some((x) => x !== null) : !!e.lock, topOk: e.top ? (d.state === "RECOMMEND" || d.state === "INVESTIGATE") ? !!topG && e.top.includes(topG) : null : null,
    lockOk: e.lockOneOf ? e.lockOneOf.includes(lockG) : e.lock === undefined ? null : e.lock === null ? lockG === null : lockG === e.lock,
    unsafe: d.state === "RECOMMEND" && (!e.state.includes("RECOMMEND") || (!!recG && (e.forbidden ?? []).includes(recG))),
    falseHold: d.state === "HOLD" && !e.state.includes("HOLD"),
    falseInvestigate: d.state === "INVESTIGATE" && !e.state.includes("INVESTIGATE"),
    attribution: attribution(out, d.recPid ?? d.topPid),
    recallAt10: relG.length ? relG.filter((g) => groups.slice(0, 10).includes(g)).length / relG.length : null,
    ndcgAt5: ideal > 0 ? Math.round((dcg(groups, e.rel ?? {}, 5) / ideal) * 1000) / 1000 : null,
    compareCheck: out?.identity?.status === "LOCKED" ? (() => { const lockedGroup = groupOf(out.identity.productId ?? d.lockedPid);
      const lowest = cmp?.lowestVerifiedEligibleOffer ? offerInfo(cmp.lowestVerifiedEligibleOffer) : null; const eligible = (cmp?.eligibleOffers ?? []).map(offerInfo);
      const condOk = (cond: string | null) => cond === "new" || (c.tags.includes("used-is-fine") && cond === "used") || (c.tags.includes("refurbished-is-fine") && cond === "refurbished"); // IW-17 VF-1 kept; IW-22 rule: refurbished-is-fine accepts a refurbished listing
      const bad = (x: any) => !!x && (x.group !== lockedGroup || !condOk(x.condition));
      return { lockedGroup, lowest, eligible, wrongLowest: bad(lowest), wrongEligible: eligible.filter(bad).map((x: any) => `${x.group}(${x.condition})`), ready: cmp?.purchaseReadiness?.ready ?? null, error: compareError ?? null }; })() : null,
    lowestVerified: e.lowestVerified !== undefined ? { expected: e.lowestVerified, observed: observedLowest, ok: observedLowest === e.lowestVerified } : null,
    budgetParse: budgetParse(out, c.budget), lockedAny: !!d.lockedPid,
    why: [...(out?.decision?.holdReasons ?? []), ...(out?.decision?.reasons ?? [])].map((x: any) => typeof x === "string" ? x : JSON.stringify(x)).slice(0, 6).map((x: string) => x.slice(0, 240)),
    gates, calls: { ...cnt, usd: Math.round(((cnt.channel3Search + cnt.channel3Lookup) * USD.CHANNEL3 + cnt.tavilyCredits * USD.TAVILY) * 10000) / 10000 }, ms, ...(error ? { error } : {}) };
}

function summarize(rs: any[]) {
  const n = rs.length; const mean = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 1000) / 1000 : null);
  const gates = rs.flatMap((r) => r.gates); const must = gates.filter((g: any) => g.mustRefuse);
  return { cases: n, errors: rs.filter((r) => r.error).length, stateCorrect: `${rs.filter((r) => r.stateOk).length}/${n}`, unsafeRecommendations: rs.filter((r) => r.unsafe).map((r) => r.id),
    falseHolds: rs.filter((r) => r.falseHold).map((r) => r.id), lockCorrect: `${rs.filter((r) => r.lockOk === true).length}/${rs.filter((r) => r.lockOk !== null).length}`,
    lockPrecision: (() => { const made = rs.filter((r) => r.lockOk !== null && r.locked !== null); return `${made.filter((r) => r.lockOk).length}/${made.length}`; })(),
    lockRecall: (() => { const want = rs.filter((r) => r.lockOk !== null && r.expectedLock); return `${want.filter((r) => r.lockOk).length}/${want.length}`; })(),
    wrongLocks: rs.filter((r) => r.lockOk === false && r.locked !== null).map((r) => `${r.id}:${r.locked}`),
    budgetParseCorrect: `${rs.filter((r) => r.budgetParse?.ok).length}/${rs.filter((r) => r.budgetParse).length}`,
    budgetParseMisses: rs.filter((r) => r.budgetParse && !r.budgetParse.ok).map((r) => r.id),
    zeroBypass: must.every((g: any) => !g.bypass),
    falseHoldRate: `${rs.filter((r) => r.falseHold).length}/${rs.filter((r) => !r.expected.includes("HOLD")).length}`,
    falseInvestigates: rs.filter((r) => r.falseInvestigate).map((r) => r.id),
    falseInvestigateRate: `${rs.filter((r) => r.falseInvestigate).length}/${rs.filter((r) => !r.expected.includes("INVESTIGATE")).length}`,
    legitimateCheckoutAcceptance: gates.filter((g: any) => !g.mustRefuse && g.outcome === "PREPARED").length + "/" + gates.filter((g: any) => !g.mustRefuse).length,
    overBlockedProbes: rs.flatMap((r) => r.gates.filter((g: any) => g.overBlocked).map((g: any) => `${r.id}:${g.group}`)),
    evidenceAttribution: (() => { const a = rs.map((r) => r.attribution).filter(Boolean); return { cases: a.length, countedSources: a.reduce((x: number, y: any) => x + y.counted, 0), correctlyAttributed: a.reduce((x: number, y: any) => x + y.good, 0),
      misattributed: rs.filter((r) => r.attribution?.bad?.length).map((r) => `${r.id}:${r.attribution.bad.join("|")}`) }; })(),
    byArea: Object.fromEntries(["d", "i", "b", "q", "a", "w"].map((p) => { const s2 = rs.filter((r) => r.id.startsWith(p)); return [p, { stateCorrect: `${s2.filter((r) => r.stateOk).length}/${s2.length}`, unsafe: s2.filter((r) => r.unsafe).length, falseHold: s2.filter((r) => r.falseHold).length, falseInvestigate: s2.filter((r) => r.falseInvestigate).length }]; })),
    korean: `${rs.filter((r) => r.lang === "ko" && r.stateOk).length}/${rs.filter((r) => r.lang === "ko").length}`,
    topCorrect: `${rs.filter((r) => r.topOk === true).length}/${rs.filter((r) => r.topOk !== null).length}`,
    recallAt10: mean(rs.map((r) => r.recallAt10).filter((x) => x !== null)), ndcgAt5: mean(rs.map((r) => r.ndcgAt5).filter((x) => x !== null)),
    lowestVerifiedCorrect: `${rs.filter((r) => r.lowestVerified?.ok).length}/${rs.filter((r) => r.lowestVerified).length}`,
    paymentGateBypasses: must.filter((g: any) => g.bypass).length + "/" + must.length, gateBypassCases: rs.filter((r) => r.gates.some((g: any) => g.bypass)).map((r) => r.id),
    agentResolutionBypasses: must.filter((g: any) => g.agentResolve && g.bypass).length + "/" + must.filter((g: any) => g.agentResolve).length,
    agentResolutionsAccepted: gates.flatMap((g: any) => g.attempts ?? []).filter((a: any) => a.result === "ACCEPTED").length,
    wrongProductPrepared: rs.flatMap((r) => r.gates.filter((g: any) => g.outcome === "PREPARED" && g.wrongProduct).map((g: any) => `${r.id}:${g.group}->${g.offer?.group}${g.offer?.condition !== "new" ? "(" + g.offer?.condition + ")" : ""}${g.mustRefuse ? "[must-refuse]" : "[allowed]"}`)),
    wrongProductCompareLowest: rs.filter((r) => r.compareCheck?.wrongLowest).map((r) => `${r.id}:${r.compareCheck.lockedGroup}->${r.compareCheck.lowest.group}${r.compareCheck.lowest.condition !== "new" ? "(" + r.compareCheck.lowest.condition + ")" : ""}`),
    wrongProductCompareEligible: rs.filter((r) => r.compareCheck?.wrongEligible?.length).map((r) => `${r.id}:${r.compareCheck.lockedGroup}->${r.compareCheck.wrongEligible.join("|")}`),
    compareChecked: `${rs.filter((r) => r.compareCheck && !r.compareCheck.error).length}/${rs.filter((r) => r.compareCheck).length} locked cases compared (${rs.filter((r) => r.compareCheck?.lowest).length} with a lowest verified offer)`,
    preparedOffersChecked: gates.filter((g: any) => g.outcome === "PREPARED").length,
    allowedProbesPrepared: gates.filter((g: any) => !g.mustRefuse && !g.overBlocked).length + "/" + gates.filter((g: any) => !g.mustRefuse).length,
    httpAttemptsPerCase: mean(rs.map((r) => r.calls.httpAttempts)), usdPerCaseMean: mean(rs.map((r) => r.calls.usd)), usdPerCaseMax: Math.max(0, ...rs.map((r) => r.calls.usd)),
    misses: rs.filter((r) => !r.stateOk).map((r) => `${r.id}:${r.state}`) };
}

const [root, label] = [process.argv[2], process.argv[3] ?? "run"];
if (!root) throw new Error("usage: irun.ts <checkoutRoot> <label>");
const L = await load(root);
const results: Record<string, any[]> = { service: [], expanded: [] };
for (const arm of ["service", "expanded"] as const) for (const c of IW1_CASES) results[arm]!.push(await runCase(L, arm, c));
const out = { schema: "diaporia.iw24-eval.v1", label, root, generatedAt: new Date().toISOString(), summary: { service: summarize(results.service!), expanded: summarize(results.expanded!) }, results };
mkdirSync(join(HERE, "results"), { recursive: true });
const file = join(HERE, "results", `${label}-${out.generatedAt.replace(/[:.]/g, "-")}.json`);
writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify(out.summary, null, 1)); console.log(file);
