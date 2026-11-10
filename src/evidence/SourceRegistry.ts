/**
 * Source-domain classification for evidence (research V2). Deterministic and auditable:
 *   MANUFACTURER       the brand's own domain (registrable label equals the brand slug)
 *   EXPERT_REVIEW      a registered independent review / testing publication
 *   RETAILER           a merchant or marketplace, including every domain that sells a candidate in this session
 *   USER_FORUM         user-generated discussion (Reddit, forums, Q&A)
 *   UNKNOWN            anything else (blogs, aggregators, syndicated copies): a search snippet only
 * Only MANUFACTURER and EXPERT_REVIEW can ever establish a fact. The starter registries below are a small, explicit
 * list of well-known publications and stores; a deployment extends them through configuration, and every
 * classification is reported with the evidence so a reviewer can disagree with it.
 */
export type SourceClass = "MANUFACTURER" | "EXPERT_REVIEW" | "RETAILER" | "USER_FORUM" | "UNKNOWN";

export const STARTER_EXPERT_DOMAINS = ["rtings.com", "soundguys.com", "whathifi.com", "techradar.com", "tomsguide.com", "pcmag.com", "cnet.com", "theverge.com",
  "notebookcheck.net", "anandtech.com", "consumerreports.org", "outdoorgearlab.com", "techgearlab.com", "seriouseats.com", "wirecutter.com",
  "digitaltrends.com", "engadget.com", "trustedreviews.com", "expertreviews.co.uk", "which.co.uk", "runrepeat.com", "gsmarena.com", "displayspecifications.com", "tftcentral.co.uk"];
export const STARTER_RETAILER_DOMAINS = ["amazon.com", "amazon.co.uk", "amazon.de", "ebay.com", "walmart.com", "bestbuy.com", "target.com", "aliexpress.com", "temu.com", "costco.com",
  "newegg.com", "bhphotovideo.com", "sweetwater.com", "cdw.com", "crutchfield.com", "rei.com", "zappos.com", "wayfair.com", "homedepot.com", "lowes.com", "kohls.com",
  "macys.com", "coupang.com", "gmarket.co.kr", "11st.co.kr", "rakuten.com", "etsy.com", "shopify.com", "backmarket.com"];
export const STARTER_FORUM_DOMAINS = ["reddit.com", "quora.com", "head-fi.org", "avsforum.com", "stackexchange.com", "community.", "forum.", "forums."];

const host = (u: string) => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; } };
/** Registrable domain (last two labels; common two-label public suffixes handled). */
export function registrableDomain(h: string): string {
  const parts = h.split(".").filter(Boolean);
  return parts.length > 2 && /^(co|com|org|net|ac|gov|or|ne)\.(uk|kr|jp|au|nz|br|in)$/.test(parts.slice(-2).join(".")) ? parts.slice(-3).join(".") : parts.slice(-2).join(".");
}
const inList = (h: string, list: Iterable<string>) => { for (const d of list) { if (d.endsWith(".") ? h.startsWith(d) || h.includes(`.${d}`) : h === d || h.endsWith(`.${d}`)) return true; } return false; };
export const brandSlugs = (brand: string) => { const b = brand.toLowerCase().normalize("NFKC").replace(/[’']s\b/g, "s"); return new Set([b.replace(/[^a-z0-9]+/g, ""), b.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")]); };

/**
 * Official manufacturer domains by brand (review R-02). A domain is MANUFACTURER only if it is (a sub-domain of) a
 * registered official domain of the listing's brand. A domain whose label merely equals the brand ("sony.shop",
 * "nest.org") is UNKNOWN: anyone can register brand.<tld>, and common-word brands map to unrelated sites.
 * Starter data only; deployments extend it with `officialDomains`.
 */
export const STARTER_OFFICIAL_DOMAINS: Record<string, string[]> = {
  sony: ["sony.com"], bose: ["bose.com"], apple: ["apple.com"], samsung: ["samsung.com"], sennheiser: ["sennheiser.com"], jbl: ["jbl.com"],
  anker: ["anker.com"], soundcore: ["soundcore.com"], jabra: ["jabra.com"], beats: ["beatsbydre.com"], google: ["google.com"], dell: ["dell.com"],
  lenovo: ["lenovo.com"], hp: ["hp.com"], asus: ["asus.com"], acer: ["acer.com"], microsoft: ["microsoft.com"], lg: ["lg.com"], dyson: ["dyson.com"],
  irobot: ["irobot.com"], breville: ["breville.com"], cuisinart: ["cuisinart.com"], keurig: ["keurig.com"], nike: ["nike.com"], adidas: ["adidas.com"],
  garmin: ["garmin.com"], logitech: ["logitech.com"],
};

export class SourceRegistry {
  readonly expert: Set<string>; readonly retailer: Set<string>; readonly forum: Set<string>;
  readonly official: Map<string, Set<string>>;
  constructor(cfg: { expertReviewDomains?: string[]; retailerDomains?: string[]; forumDomains?: string[]; officialDomains?: Record<string, string[]>; replaceStarter?: boolean } = {}) {
    const base = cfg.replaceStarter ? { e: [], r: [], f: [] } : { e: STARTER_EXPERT_DOMAINS, r: STARTER_RETAILER_DOMAINS, f: STARTER_FORUM_DOMAINS };
    this.expert = new Set([...base.e, ...(cfg.expertReviewDomains ?? [])].map((d) => d.toLowerCase()));
    this.retailer = new Set([...base.r, ...(cfg.retailerDomains ?? [])].map((d) => d.toLowerCase()));
    this.forum = new Set([...base.f, ...(cfg.forumDomains ?? [])].map((d) => d.toLowerCase()));
    this.official = new Map();
    for (const src of [cfg.replaceStarter ? {} : STARTER_OFFICIAL_DOMAINS, cfg.officialDomains ?? {}])
      for (const [brand, domains] of Object.entries(src)) for (const slug of brandSlugs(brand)) {
        const set = this.official.get(slug) ?? new Set<string>(); domains.forEach((d) => set.add(d.toLowerCase())); this.official.set(slug, set);
      }
  }
  /** True only for a registered official domain (or its sub-domain) of this brand. */
  isOfficial(h: string, brand: string): boolean {
    for (const slug of brandSlugs(brand)) { const set = this.official.get(slug); if (set && inList(h, set)) return true; }
    return false;
  }
  /** `sellers`: domains selling any candidate in this session (merchant-controlled, never independent). */
  classify(url: string, brand: string | null, sellers: Iterable<string> = []): SourceClass {
    const h = host(url);
    if (!h) return "UNKNOWN";
    if (inList(h, sellers) || inList(h, this.retailer)) return "RETAILER";
    if (brand && this.isOfficial(h, brand)) return "MANUFACTURER";
    if (inList(h, this.forum)) return "USER_FORUM";
    if (inList(h, this.expert)) return "EXPERT_REVIEW";
    return "UNKNOWN";
  }
}

/** Word trigram set for near-duplicate (syndicated copy) detection. */
export function shingles(text: string): Set<string> {
  const w = text.toLowerCase().replace(/[^a-z0-9가-힣 ]+/g, " ").split(/\s+/).filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + 2 < w.length; i++) out.add(`${w[i]} ${w[i + 1]} ${w[i + 2]}`);
  return out;
}
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let n = 0; for (const x of a) if (b.has(x)) n++;
  return n / (a.size + b.size - n);
}
export const hostOf = host;
