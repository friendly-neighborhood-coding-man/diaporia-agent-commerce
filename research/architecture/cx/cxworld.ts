/**
 * CX counterexample world (architecture thread, 2026-11-12). Builder-written fictional products (Corvane, Ostlund) for the
 * discriminating probes in PREDICTION_REGISTER.md section C. The fake-endpoint machinery is copied unchanged from the
 * IW-24 harness (already SEEN); only the data is new.
 */
import { createHash } from "node:crypto";

export type Kind = "STANDALONE" | "BUNDLE" | "ACCESSORY";
export interface WOffer { domain: string; price: number; currency?: string; availability?: "InStock" | "OutOfStock" | null; condition?: "new" | "used" | "refurbished" | null;
  quote?: { shipping: number | null; taxBps: number | null; fees: number | null } | null }
export interface WProduct { id: string; title: string; brand: string | null; category: string; key_features?: string[]; description?: string;
  variants?: { options: Array<{ name: string; values: Array<{ label: string; product_id?: string }> }>; selected: Array<{ name: string; label: string }> };
  offers: WOffer[]; truth: { kind: Kind; group: string; family: string; version?: string | null; condition?: "new" | "used" | "refurbished" } }

export const REGISTRY = {
  manufacturer: { Corvane: ["corvane.example"], Ostlund: ["ostlund.example"] } as Record<string, string[]>,
  expertReview: ["trolleytest-review.example", "smokelab-review.example"],
  forums: ["forum.paddlers.example"],
  retailers: ["brindle.example", "cask.example"],
};
const Q_FULL = { shipping: 0, taxBps: 825, fees: 0 };
const P = (id: string, title: string, brand: string | null, category: string, offers: WOffer[], truth: WProduct["truth"], extra: Partial<WProduct> = {}): WProduct =>
  ({ id, title, brand, category, offers, truth, ...extra });
const S = (id: string, family: string, version: string | null = null) => ({ kind: "STANDALONE" as Kind, group: id, family, version });
const A = (id: string, family: string) => ({ kind: "ACCESSORY" as Kind, group: id, family });
const Q = "brindle.example", H = "cask.example";
const o = (domain: string, price: number, quote: WOffer["quote"] = Q_FULL): WOffer => ({ domain, price, quote });
export const WORLD: WProduct[] = [
  P("ht40", "Corvane Hauler 40 Kayak Trolley", "Corvane", "kayak-trolleys", [o(Q, 129)], S("ht40", "Corvane Hauler 40")),
  P("ht40w", "Corvane Hauler 40 Wide Kayak Trolley", "Corvane", "kayak-trolleys", [o(H, 159)], S("ht40w", "Corvane Hauler 40 Wide")),
  P("ht60", "Corvane Hauler 60 Kayak Trolley", "Corvane", "kayak-trolleys", [o(Q, 189)], S("ht60", "Corvane Hauler 60")),
  P("wheel", "Corvane Hauler Puncture-proof Wheel Set", "Corvane", "kayak-trolley-accessories", [o(H, 49)], A("wheel", "Corvane Hauler accessories")),
  P("em18", "Ostlund Embry 18 Offset Box Smoker", "Ostlund", "smokers", [o(Q, 599)], S("em18", "Ostlund Embry 18")),
  P("em18p", "Ostlund Embry 18 Pro Smoker", "Ostlund", "smokers", [o(H, 799)], S("em18p", "Ostlund Embry 18 Pro")),
  P("em24", "Ostlund Embry 24 Box Smoker", "Ostlund", "smokers", [o(Q, 899)], S("em24", "Ostlund Embry 24")),
  P("em24p", "Ostlund Embry 24 Pro Box Smoker", "Ostlund", "smokers", [o(H, 1099)], S("em24p", "Ostlund Embry 24 Pro")),
  P("hood18", "Ostlund Embry 18 Rain Hood", "Ostlund", "smoker-accessories", [], A("hood18", "Ostlund Embry 18 accessories")),
  P("hood24", "Ostlund Embry 24 Rain Hood", "Ostlund", "smoker-accessories", [o(Q, 69)], A("hood24", "Ostlund Embry 24 accessories")),
];
export interface WPage { url: string; title: string; content: string; published_date?: string | null }
const pg = (url: string, title: string, content: string, published_date: string | null = "2026-10-30"): WPage => ({ url, title, content, published_date });
export const WEB: WPage[] = [
  pg("https://corvane.example/hauler-40", "Corvane Hauler 40 Kayak Trolley specifications", "The Corvane Hauler 40 Kayak Trolley carries up to 90 kg. The Hauler 40 is not recommended for beach sand. It is not designed for beach launches. It folds flat."),
  pg("https://corvane.example/hauler-40-wide", "Corvane Hauler 40 Wide Kayak Trolley specifications", "The Corvane Hauler 40 Wide Kayak Trolley has balloon tyres built for beach sand and carries up to 90 kg. It folds flat."),
  pg("https://corvane.example/hauler-60", "Corvane Hauler 60 Kayak Trolley specifications", "The Corvane Hauler 60 Kayak Trolley is a heavy-duty trolley. Compared with the 90 kg Hauler 40, the Hauler 60 carries up to 140 kg. It folds flat."),
  pg("https://corvane.example/hauler-puncture-proof-wheel-set", "Corvane Hauler Puncture-proof Wheel Set", "The Corvane Hauler Puncture-proof Wheel Set fits the Hauler 40 and the Hauler 60. With the puncture-proof wheels, the Hauler 40 carries up to 150 kg."),
  pg("https://ostlund.example/embry-18", "Ostlund Embry 18 Offset Box Smoker specifications", "The Ostlund Embry 18 Offset Box Smoker is a charcoal offset smoker with an 18 inch firebox. Wi-Fi: not available. 와이파이: 없음."),
  pg("https://ostlund.example/embry-18-pro", "Ostlund Embry 18 Pro Smoker specifications", "The Ostlund Embry 18 Pro Smoker adds Wi-Fi temperature control to the 18 inch firebox."),
  pg("https://ostlund.example/embry-24", "Ostlund Embry 24 Box Smoker specifications", "The Ostlund Embry 24 Box Smoker has a 24 inch firebox."),
  pg("https://ostlund.example/embry-24-pro", "Ostlund Embry 24 Pro Box Smoker specifications", "The Ostlund Embry 24 Pro Box Smoker has a 24 inch firebox and a raised chimney."),
  pg("https://ostlund.example/embry-18-rain-hood", "Ostlund Embry 18 Rain Hood", "The Ostlund Embry 18 Rain Hood fits the Embry 18."),
  pg("https://ostlund.example/embry-24-rain-hood", "Ostlund Embry 24 Rain Hood", "The Ostlund Embry 24 Rain Hood fits the Embry 24 Pro only. It does not fit the Embry 24."),
];
export const ABOUT: Record<string, string[]> = Object.fromEntries(([
  ["corvane.example/hauler-40", "ht40"], ["corvane.example/hauler-40-wide", "ht40w"], ["corvane.example/hauler-60", "ht60"], ["corvane.example/hauler-puncture-proof-wheel-set", "wheel"],
  ["ostlund.example/embry-18", "em18"], ["ostlund.example/embry-18-pro", "em18p"], ["ostlund.example/embry-24", "em24"], ["ostlund.example/embry-24-pro", "em24p"],
  ["ostlund.example/embry-18-rain-hood", "hood18"], ["ostlund.example/embry-24-rain-hood", "hood24"],
] as Array<[string, string]>).map(([u, g]) => ["https://" + u, [g]]));
const CAT: Record<string, string> = { "kayak-trolleys": "Kayak Trolleys", "kayak-trolley-accessories": "Kayak Trolley Accessories", "smokers": "Smokers", "smoker-accessories": "Smoker Accessories" };

// ------------------------------------------------------------------------------------------------- fake endpoints
const STOP = new Set("a an the i me my we need want looking for find buy purchase order get please some with and or of to in on under below less than at most max budget is am would like that this it be can you should must have has prefer ideally nice also new any specs review".split(" "));
const tok = (s: string) => s.toLowerCase().normalize("NFKC").split(/[^a-z0-9가-힣]+/).filter(Boolean).map((w) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w));
const SYN0: Record<string, string[]> = { trolley: ["trolleys"], smoker: ["smokers"], 와이파이: ["wi-fi"] };
// CX: only the synonym table is new; the rest of the IW-6..IW-23 machinery (incl. D-1) is copied unchanged.
//
// IW-6 machinery (unchanged in IW-7 and IW-8): keys and targets are tokenised like listing words, so plural/singular forms match.
const SYN: Record<string, string[]> = Object.fromEntries(Object.entries(SYN0).map(([k, v]) => [tok(k)[0] ?? k, v.flatMap((x) => tok(x))]));

// IW-9 validation fix VF-2 (realism): like a real catalog / web search engine, model codes match whatever their hyphenation
// or spacing. Only the indexed side is augmented: "MD-7" also indexes "md7", and "T8" also indexes "t" + "8", so the
// queries "MD7", "T-8", "BM 3 HD" and "ff4" find the listings and pages. Query tokenisation is unchanged.
function codeForms(ws: string[]): Set<string> {
  const out = new Set(ws);
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i]!; const m = /^([a-z]+)(\d+)([a-z]*)$/.exec(w); if (m) { out.add(m[1]!); out.add(m[2]!); if (m[3]) out.add(m[3]); out.add(m[2]! + m[3]!); }
    const nx = ws[i + 1]; if (nx && /^[a-z]+$/.test(w) && /^\d+[a-z]*$/.test(nx)) out.add(w + nx);
    // IW-10 design note D-1: a code followed by a short letter suffix also indexes the joined form ("x4" + "se" -> "x4se").
    if (nx && /^[a-z]+\d+$/.test(w) && /^[a-z]{1,4}$/.test(nx)) out.add(w + nx);
  }
  return out;
}
function publicProduct(p: WProduct, currency: string): Record<string, unknown> {
  return { id: p.id, title: p.title, description: p.description ?? null, brands: p.brand ? [{ id: `br_${p.brand.toLowerCase().replace(/[^a-z]+/g, "_")}`, name: p.brand }] : [],
    images: [], category: { slug: p.category, title: CAT[p.category] ?? p.category, path: [], has_children: false }, key_features: p.key_features ?? null,
    variants: p.variants ? structuredClone(p.variants) : null, structured_attributes: {},
    offers: p.offers.filter((x) => (x.currency ?? "USD") === currency).map((x) => ({ url: `https://${x.domain}/p/${p.id}`, domain: x.domain,
      price: { price: x.price, compare_at_price: null, currency: x.currency ?? "USD" }, availability: x.availability ?? "InStock", condition: x.condition ?? "new", max_commission_rate: 0 })) };
}
function search(body: any) {
  const limit = Math.min(30, Math.max(1, Number(body.limit ?? 20)));
  const start = typeof body.page_token === "string" ? Number(body.page_token.replace(/^p/, "")) : 0;
  const q = typeof body.query === "string" ? body.query : "";
  const currency = body.config?.currency ?? "USD";
  const conditions: string[] = body.filters?.conditions ?? ["new"];
  const maxPrice: number | null = body.filters?.price?.max_price ?? null;
  const qt = [...new Set(tok(q).filter((w) => !STOP.has(w)))];
  const need = Math.max(1, Math.ceil(qt.length * 0.5));
  const scored: Array<{ p: WProduct; s: number }> = [];
  for (const p of WORLD) {
    const words = codeForms(tok(`${p.brand ?? ""} ${p.title} ${CAT[p.category] ?? ""} ${(p.key_features ?? []).join(" ")}`));
    let s = 0; for (const w of qt) if (words.has(w) || (SYN[w] ?? []).some((x) => words.has(x))) s++;
    // Realism (validation fix VF-1): a catalog search engine returns the category's items for a category query even when
    // the listing does not repeat every word of the request; the 50% word rule alone dropped them.
    // IW-5 validation fix VF-5.1: only the category head noun counts, so adjectives in a category title ("Wireless Earbuds")
    // do not pull a whole unrelated category into any query that uses the adjective.
    const catWords = new Set([tok(CAT[p.category] ?? "").at(-1) ?? "", tok(p.category).at(-1) ?? ""].filter(Boolean).flatMap((w) => [w, w.replace(/e$/, "")]));
    const catHit = qt.some((w) => catWords.has(w) || (SYN[w] ?? []).some((x) => catWords.has(x)));
    if (s < need && !catHit) continue;
    const passing = p.offers.filter((x) => (x.currency ?? "USD") === currency && (x.condition == null ? conditions.includes("new") : conditions.includes(x.condition)) && x.availability !== "OutOfStock");
    if (!passing.length) continue;
    if (maxPrice !== null && Math.min(...passing.map((x) => x.price)) > maxPrice) continue;
    scored.push({ p, s });
  }
  scored.sort((a, b) => b.s - a.s || a.p.id.localeCompare(b.p.id));
  return { products: scored.slice(start, start + limit).map((x) => publicProduct(x.p, currency)), next_page_token: start + limit < scored.length ? `p${start + limit}` : null };
}
function detail(id: string, params: URLSearchParams) {
  let p = WORLD.find((x) => x.id === id); if (!p) return null;
  for (const [k, v] of params) { if (!k.startsWith("option_") || !p!.variants) continue;
    const t = p!.variants.options.find((o) => o.name === k.slice(7))?.values.find((x) => x.label === v)?.product_id; const tp = t ? WORLD.find((x) => x.id === t) : undefined; if (tp) p = tp; }
  return publicProduct(p!, params.get("currency") ?? "USD");
}
/** Document retrieval: quoted phrases must appear (separator-insensitive) when exact_match; >= 50% of other words. */
function tavily(body: any) {
  const q = String(body.query ?? "");
  const exclude: string[] = Array.isArray(body.exclude_domains) ? body.exclude_domains : [];
  const include: string[] = Array.isArray(body.include_domains) ? body.include_domains : [];
  const norm = (s: string) => s.toLowerCase().normalize("NFKC").replace(/[^a-z0-9가-힣]+/g, "");
  const phrases = [...q.matchAll(/"([^"]+)"/g)].map((m) => norm(m[1]!));
  const words = [...new Set(tok(q.replace(/"[^"]+"/g, " ")).filter((w) => !STOP.has(w)))];
  const host = (u: string) => new URL(u).hostname;
  const inList = (h: string, l: string[]) => l.some((d) => h === d || h.endsWith(`.${d}`));
  const hits = WEB.map((p) => {
    const text = `${p.title} ${p.content}`; const t = codeForms(tok(text)); const n = norm(text);
    if (phrases.some((ph) => !n.includes(ph))) return null;
    const s = words.filter((w) => t.has(w)).length;
    if (!phrases.length && s < Math.max(1, Math.ceil(words.length * 0.5))) return null;
    return { p, s };
  }).filter((x): x is { p: WPage; s: number } => !!x && !inList(host(x.p.url), exclude) && (!include.length || inList(host(x.p.url), include)))
    .sort((a, b) => b.s - a.s || a.p.url.localeCompare(b.p.url));
  const max = Math.min(20, Number(body.max_results ?? 10));
  const credits = body.search_depth === "advanced" ? 2 : 1;
  return { query: q, answer: null, images: [], response_time: 0.01, request_id: "req_" + createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 12),
    ...(body.include_usage ? { usage: { credits } } : {}),
    results: hits.slice(0, max).map((h, i) => ({ title: h.p.title, url: h.p.url, content: h.p.content, score: 1 - i * 0.05, ...(body.include_published_date ? { published_date: h.p.published_date ?? null } : {}) })) };
}

export interface Counters { channel3Search: number; channel3Detail: number; channel3Lookup: number; tavilySearch: number; tavilyCredits: number; httpAttempts: number; redirects: number }
export const newCounters = (): Counters => ({ channel3Search: 0, channel3Detail: 0, channel3Lookup: 0, tavilySearch: 0, tavilyCredits: 0, httpAttempts: 0, redirects: 0 });
export function worldFetch(c: Counters): typeof fetch {
  return (async (input: any, init?: any) => {
    const url = new URL(typeof input === "string" ? input : input.url ?? String(input));
    c.httpAttempts++;
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (url.hostname === "api.trychannel3.com" && url.pathname === "/v1/search") { c.channel3Search++; return Response.json(search(body)); }
    if (url.hostname === "api.trychannel3.com" && url.pathname.startsWith("/v1/products/")) { c.channel3Detail++; const d = detail(decodeURIComponent(url.pathname.split("/").pop()!), url.searchParams);
      return d ? Response.json(d) : new Response("not found", { status: 404 }); }
    if (url.hostname === "api.tavily.com" && url.pathname === "/search") { c.tavilySearch++; c.tavilyCredits += body?.search_depth === "advanced" ? 2 : 1; return Response.json(tavily(body)); }
    throw new Error(`CX world: network access refused for ${url.hostname}`);
  }) as typeof fetch;
}
export const worldProduct = (id: string) => WORLD.find((p) => p.id === id);
export const quoteFor = (listingUrl: string | null) => {
  const m = /^https:\/\/([^/]+)\/p\/([a-z0-9-]+)$/.exec(listingUrl ?? ""); if (!m) return null;
  const o = WORLD.find((p) => p.id === m[2])?.offers.find((x) => x.domain === m[1]); return o && o.availability !== "OutOfStock" && o.quote ? { offer: o, rule: o.quote } : null;
};
