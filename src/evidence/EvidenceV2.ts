import type { CatalogProduct, EvidenceKind } from "../domain/types.js";
import { generationsIn, mentionsExactModel, normalizeKey, parseAttributes, type AttributeAxis } from "../identity/ProductIdentityExtractor.js";
import { factsOf } from "../identity/ProductResolverV2.js";
import { canon, mentionsOtherVariant, modelCode, namesOtherVariant, namesVariantRun } from "../identity/VariantTail.js";
import { clauseStatement, FIT_PREFIX, isPerformanceClaim, PROPOSITION_PREFIX } from "../research/capabilities.js";
import { jaccard, registrableDomain, shingles, hostOf, type SourceClass, type SourceRegistry } from "./SourceRegistry.js";

/**
 * Evidence statements and the V2 sufficiency rule (research V2). Pure functions; the router does I/O and metering.
 *
 * STATEMENT RULE: a search result yields a statement about (product, capability) only when (see statementFrom for attribution)
 *   (a) its title+snippet names the exact model (separator-tolerant; a family extension such as "Pro" is a different model),
 *   (b) one clause of the snippet states the capability explicitly (negation must govern the phrase),
 *   (c) that clause does not name a different value of an attribute the product has ("the 8-cup model" ≠ 12-cup),
 *   (d) it is not a comparison-table row (pipe-separated cells cannot be attributed to one product).
 * SUFFICIENCY RULE (V2), per capability:
 *   VERIFIED  ← the manufacturer's own domain states it, or ≥ 2 independent expert groups agree; an expert group is a
 *               registrable domain, and near-identical text on several domains (syndication, Jaccard ≥ 0.6) is ONE group.
 *   CONTRADICTED ← counted sources disagree (manufacturer vs expert, or expert vs expert). Never resolved automatically.
 *   UNVERIFIED ← anything else. Retailer pages, forums, unknown sites, stale pages (> 4 years) and catalog key features
 *               are reported but never counted: a snippet never becomes verified except through this rule.
 */
export type EvidenceStatus = "VERIFIED_TRUE" | "VERIFIED_FALSE" | "CONTRADICTED" | "UNVERIFIED";
export interface EvidenceItem {
  url: string; domain: string; sourceClass: SourceClass; value: boolean; quote: string; publishedDate: string | null;
  provider: string; requestId: string | null; observedAt: string;
  counts: boolean; whyNotCounted: string | null;
}
export interface CapabilityVerdict {
  capability: string; status: EvidenceStatus;
  basis: "MANUFACTURER" | "TWO_EXPERT_GROUPS" | "CONFLICT" | "INSUFFICIENT";
  evidence: EvidenceItem[];
  independentGroups: number;
}
export const STALE_AFTER_DAYS = 4 * 365;

export const evidenceKindOf = (c: SourceClass): EvidenceKind =>
  c === "MANUFACTURER" ? "MANUFACTURER" : c === "EXPERT_REVIEW" ? "INDEPENDENT_REVIEW" : c === "RETAILER" ? "RETAILER_ASSERTION" : c === "USER_FORUM" ? "USER_FORUM" : "SEARCH_SNIPPET";

/**
 * Known product brands that are NOT the candidate's (attribution guard, review R-01). Starter data, not exhaustive: a
 * clause that names any of these, or another model code, is about another product and never counts for this one.
 */
export const OTHER_BRAND_WORDS = ["sony", "bose", "apple", "airpods", "beats", "sennheiser", "jbl", "anker", "soundcore", "jabra", "samsung", "google",
  "skullcandy", "audio-technica", "marshall", "shure", "philips", "panasonic", "lg", "dell", "lenovo", "asus", "acer", "microsoft", "macbook", "iphone", "ipad", "dyson", "irobot", "roomba", "breville", "cuisinart", "keurig", "nike", "adidas", "brooks", "hoka", "salomon", "merrell",
  "yeti", "garmin", "fitbit", "xiaomi", "huawei", "oneplus", "logitech", "razer", "corsair", "steelcase", "nespresso", "hydro flask",
  "herman miller", "bang & olufsen", "sonos", "edifier", "1more", "tozo", "jlab", "soundpeats"];
/** Titles of pages that discuss several products. Their statements never count unless the clause names only this model. */
const COMPARISON_TITLE = /\b(?:vs\.?|versus|compared?|comparison|alternatives?|best\b.*\b(?:of|for|under|20\d\d)|top \d+|round-?up|buying guide|which (?:is|should))\b|비교|대결|추천|순위|vs/i;
/** Model-code tokens: letters and digits with a hyphen (WH-1000XM5), 2+ capitals then 2+ digits (QC45), or one capital + 2+ digits (Q20). */
const MODEL_CODE = /(?<![A-Za-z0-9])(?:[A-Z][A-Za-z]*-[A-Z0-9]*\d[A-Z0-9-]*|[A-Z]{2,}\d{2,}[A-Za-z0-9]*|[A-Z]\d{2,}[A-Za-z]?)(?![A-Za-z0-9])/g;
/** Standards and ratings that look like model codes (IP68, MIL-STD-810, USB-C, HDMI-2). */
const NOT_A_MODEL = /^(?:IP[X\d]\d.*|MIL-STD.*|USB.*|HDMI.*|WI-?FI.*|BT\d.*|IEEE.*|ISO.*|ANSI.*|DDR\d.*|PCIE.*|LPDDR.*|UHS.*|RTX\d.*|GTX\d.*)$/i;
const keyOf = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Korean names of known brands (V2.1). `own` maps a Latin brand to its Hangul name so a Sony candidate is not "another
 * product" because the clause says 소니. A Hangul name only counts as a word when a particle, space or punctuation
 * follows ("보스턴" is not 보스).
 */
const KOREAN_BRANDS: Record<string, string> = { sony: "소니", bose: "보스", apple: "애플", airpods: "에어팟", beats: "비츠", sennheiser: "젠하이저", samsung: "삼성", galaxy: "갤럭시",
  google: "구글", pixel: "픽셀", anker: "앤커", soundcore: "사운드코어", jabra: "자브라", jbl: "제이비엘", lg: "엘지", xiaomi: "샤오미", huawei: "화웨이", logitech: "로지텍",
  dyson: "다이슨", marshall: "마샬", shure: "슈어", philips: "필립스", panasonic: "파나소닉", "audio-technica": "오디오테크니카", "bang & olufsen": "뱅앤올룹슨", sonos: "소노스",
  edifier: "에디파이어", qcy: "큐씨와이", skullcandy: "스컬캔디", nothing: "낫싱" };
const KO_FOLLOW = "(?=$|[\\s.,!?·:;)\\]]|(?:는|은|의|가|이|를|을|와|과|도|에서|에|랑|보다|처럼|만|제품|헤드폰|이어폰|버즈))";
/** Capitalized words that are features, services, units or review headings, never a product (V2.1 entity detection). */
const NOT_ENTITY = new Set(("the a an it its it's this that these those they their we our i i'm you my he she his her in on at for with and but or both unlike like compared " +
  "also however overall yes no not ok update note pros cons verdict review reviews rating score editor editor's choice best bottom line key summary conclusion overview specs " +
  "specifications price value performance sound quality battery life design comfort build fit controls features feature connectivity call calls microphone mic noise " +
  "cancellation cancelling canceling active transparency ambient mode modes wireless wired bluetooth multipoint charging charge case app apps audio hi-res hi res " +
  "ldac aac aptx sbc lc3 dolby atmos spatial spotify connect alexa siri assistant ios android windows macos wi-fi wifi usb usb-c type-c anc enc eq ip qi magsafe " +
  "tv pc hz khz db mah mm am pm january february march april may june july august september october november december jan feb mar apr jun jul aug sep sept oct nov dec " +
  "monday tuesday wednesday thursday friday saturday sunday english korean us uk eu " +
  "uhd hdr hdr10 oled qled lcd led ips va tn hdmi dp displayport pd rgb ssd hdd ram cpu gpu os ai bt nfc gps hepa bpa uv ac dc lb lbs oz ml kg cm ft fps " +
  "4k 8k fhd qhd wqhd ppi nits srgb dci-p3 vesa thunderbolt kvm ethernet lan wpa ghz mhz w v power delivery gan quick charge fast charging pps french turkish italian american european japanese celsius fahrenheit gb tb mb kb gbe gbps mbps kbps mesh").split(/\s+/));
const isEntityToken = (tok: string, own: Set<string>) => {
  const t = tok.replace(/[’']s$/, "");
  const l = t.toLowerCase();
  if (!/^[A-Z]/.test(t) || t.length === 1 || own.has(l) || NOT_ENTITY.has(l) || /^ip[x\d]\d$/i.test(t) || NOT_A_MODEL.test(t)) return false;
  return true;
};
/**
 * True if `text` names a product or brand that is not this one and is not in any list (V2.1, generalizing R-01):
 * a capitalized word mid-clause that is not this product's own word and not a feature/service/heading word, or a run
 * of two capitalized words at the start of a clause ("Zorvex Aero has ..."). Used on snippets, never on page titles
 * (titles are Title Case). A single capitalized word that only starts a sentence is not detected (residual).
 */
export function namesUnknownEntity(text: string, product: CatalogProduct, asked: string[] = []): boolean {
  const own = new Set([product.identity.brand, product.identity.model, product.identity.variant, product.title, ...asked].filter(Boolean).join(" ").toLowerCase().split(/[^a-z0-9&'-]+/).filter(Boolean));
  for (const sentence of text.split(/(?<=[.!?])\s+|;\s*|:\s+|\s+—\s+|\n+/)) {
    const toks = sentence.split(/[\s,()"“”]+/).map((t) => t.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9’']+$/g, "")).filter(Boolean);
    for (let i = 0; i < toks.length; i++) {
      if (!isEntityToken(toks[i]!, own)) continue;
      // V2.4: a unit right after a number ("4,000 Pa", "2,000 ANSI lumens") and a component named by its type
      // ("a LiFePO4 battery", "Cherry switches") describe this product; they are not another product.
      if (i > 0 && /^\d[\d,.]*$/.test(toks[i - 1]!)) continue;
      // V2.7: a paper or media size before the thing it sizes ("A3 posters", "A4 pouches", "B5 notebooks") is a size.
      if (/^[AB][0-6]$/.test(toks[i]!) && /^[a-z]/.test(toks[i + 1] ?? "")) continue;
      if (COMPONENT_NOUN.test(toks[i + 1] ?? "") || (/^[A-Z]{2,6}$/.test(toks[i]!) && COMPONENT_NOUN.test(toks[i + 2] ?? "") && /^[a-z]/.test(toks[i + 1] ?? ""))) continue;
      if (i > 0) return true;
      const next = toks[1];
      if (next && (/^[A-Z0-9]/.test(next)) && !NOT_ENTITY.has(next.toLowerCase())) return true;
    }
  }
  return false;
}
/** Parts and materials of a product: a capitalized word before one of these names a component or chemistry. */
const COMPONENT_NOUN = /^(?:batter(?:y|ies)|cells?|chemistry|inverters?|switch(?:es)?|keycaps?|panels?|chips?|chipsets?|processors?|sensors?|motors?|drivers?|displays?|screens?|filters?|lens(?:es)?|lumens|codecs?|coatings?|fabric|leather|steel|aluminum|aluminium|glass|plastic|foam|membrane|stabilizers?|mounts?)$/i;
/** Reported or second-hand speech: a review quoting another source, or a brand's claim, is not independent evidence. */
const REPORTED = /\bper\s+(?:[a-z0-9-]+\.[a-z]{2,}|the\s+(?:manufacturer|brand|maker|company|vendor|seller))\b|\b(?:according to|via|says|said|claims?|claimed|reports?|reported|states?|stated|advertis(?:es|ed)|market(?:s|ed) as|touts?|touted|promises?)\b|^\s*source\s*:|(?:에 따르면|라고 (?:한다|밝혔|주장)|주장한다|광고한다)/i;

/** True if `text` names a product other than this one (another brand, another model code, or a family extension). */
export function namesOtherProduct(text: string, product: CatalogProduct): boolean {
  const lower = ` ${text.toLowerCase()} `;
  const own = new Set([product.identity.brand, product.identity.model, product.title].filter(Boolean).join(" ").toLowerCase().split(/[^a-z0-9&-]+/).filter(Boolean));
  const ownBrand = (product.identity.brand ?? "").toLowerCase();
  for (const b of OTHER_BRAND_WORDS) {
    if (b === ownBrand || own.has(b) || ownBrand.includes(b) || b.includes(ownBrand) && ownBrand.length > 2) continue;
    if (new RegExp(`(^|[^a-z0-9])${b.replace(/[.*+?^${}()|[\]\\&]/g, "\\$&")}(?=$|[^a-z0-9])`).test(lower)) return true;
  }
  const ownKo = KOREAN_BRANDS[ownBrand];
  for (const [latin, ko] of Object.entries(KOREAN_BRANDS)) {
    if (ko === ownKo || latin === ownBrand || own.has(latin)) continue;
    if (new RegExp(`${ko}${KO_FOLLOW}`).test(text)) return true;
  }
  const model = product.identity.model;
  const ownKey = model ? keyOf(model) : null;
  for (const m of text.matchAll(MODEL_CODE)) {
    const k = keyOf(m[0]);
    if (ownKey && (k === ownKey || ownKey.includes(k))) continue;
    if (own.has(m[0].toLowerCase()) || NOT_A_MODEL.test(m[0])) continue;
    return true;
  }
  // A family extension of this model ("Nova 9 Pro" for "Nova 9"): the loose name is present but the exact model is not.
  const gen = factsOf(product).attributes.generation;
  if (model && keyOf(text).includes(keyOf(model)) && !mentionsExactModel(text, model, { generation: gen && gen !== "CONFLICT" ? gen : null })) return true;
  return false;
}


/**
 * Post-submission cycle 5, invariant I1: a statement verifies only the product it is about. Among the products this
 * research listed, a mention of this product's model that a longer listed name covers ("Crucible 18 Glass" beside the
 * Crucible 18, "Kerfmaster 14in Riser Block" beside the Kerfmaster 14in) is a mention of that other product.
 * Returns, for each other listed product whose title contains this model, the first word it has after the model where
 * this product's title has a different one.
 */
function extensionWords(product: CatalogProduct, listed: CatalogProduct[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const model = product.identity.model;
  if (!model) return out;
  const esc = model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "[\\s-]+");
  const re = new RegExp(`(?<![A-Za-z0-9])${esc}(?![A-Za-z0-9])`, "i");
  const after = (title: string) => { const m = re.exec(title.normalize("NFKC")); return m ? title.normalize("NFKC").slice(m.index + m[0].length).split(/[\s,;:()|/–—]+/).map(canon).filter(Boolean) : null; };
  const own = after(product.title) ?? [];
  const brand = (product.identity.brand ?? "").toLowerCase();
  for (const q of listed) {
    if (q.productId === product.productId || (q.identity.brand ?? "").toLowerCase() !== brand) continue;
    const a = after(q.title);
    if (!a?.length || a[0] === own[0]) continue;
    // Words this product's own title also has after the model ("Electric", "Kiln") never mark another product.
    const distinct = a.filter((w) => !own.includes(w));
    if (distinct.length && distinct[0] === a[0]) out.set(q.productId, distinct);
  }
  return out;
}
const PAGE_WORD = /^(?:specifications?|specs?|review|reviews|reviewed|manual|manuals|guide|faq|support|overview|vs|versus|comparison|compared|price|prices|deal|deals|our|setup|instructions?|warranty|owners?|user|product|page|official|buy|sale|details?|features?|hands|test|tested|first|long|full|quick|video|accessories|parts|and|or|with|the|a|an|is|in|for|at|by|from|on|of|to|model|models|series|edition)$/i;
/** I1: the distinguishing words a page title writes right after this model, if they are not this product's own. */
function titleContinuation(title: string, product: CatalogProduct): string[] | null {
  const model = product.identity.model!;
  const esc = model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "[\\s-]+");
  const re = new RegExp(`(?<![A-Za-z0-9])${esc}(?![A-Za-z0-9])`, "i");
  const rest = (t: string) => { const n = t.normalize("NFKC"); const m = re.exec(n); return m ? n.slice(m.index + m[0].length) : null; };
  const after = (t: string) => { const r = rest(t); return r === null ? null : r.trim().split(/[\s,;:()|/–—]+/).filter(Boolean); };
  const r0 = rest(title);
  // Punctuation right after the model ("Kerfmaster 14in: our pick") ends the name.
  if (r0 === null || !/^\s+[\p{L}]/u.test(r0)) return null;
  const raw = after(title)!;
  const own = new Set((after(product.title) ?? []).map(canon).filter(Boolean));
  const words = raw.map(canon).filter(Boolean);
  const first = words[0];
  // Only a Latin-script word continues an English product name; a Hangul word after the model ("CX-500 리뷰") is a page word
  // or particle, so Korean titles keep the earlier attribution rules.
  if (!first || !/^[a-z]/.test(first) || own.has(first) || PAGE_WORD.test(first)) return null;
  const distinct = words.filter((w) => !own.has(w) && !PAGE_WORD.test(w));
  return distinct.length && distinct[0] === first ? distinct : null;
}
const tokensOf = (t: string) => new Set(t.normalize("NFKC").split(/[\s,;:()|/–—.]+/).map(canon).filter(Boolean));
/** I1: the distinguishing words of the listed product that the first covered mention of this model in `text` belongs to. */
function nextNamed(text: string, model: string, ext: Map<string, string[]>): string[] | null {
  const esc = model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "[\\s-]+");
  const t = text.normalize("NFKC");
  const m = new RegExp(`(?<![A-Za-z0-9])${esc}(?![A-Za-z0-9])`, "i").exec(t);
  if (!m) return null;
  const next = canon(/^[\s-]*([\p{L}\p{N}][\p{L}\p{N}'’+.-]*)/u.exec(t.slice(m.index + m[0].length))?.[1] ?? "");
  return [...ext.values()].find((x) => x[0] === next) ?? null;
}
/** I1: true if `text` names this model at least once where no listed longer name covers the mention. */
function namesUnconsumed(text: string, model: string, ext: Map<string, string[]>): boolean {
  if (!ext.size) return true;
  const firsts = new Set([...ext.values()].map((x) => x[0]!));
  const esc = model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "[\\s-]+");
  const t = text.normalize("NFKC");
  let any = false;
  for (const m of t.matchAll(new RegExp(`(?<![A-Za-z0-9])${esc}(?![A-Za-z0-9])`, "gi"))) {
    any = true;
    const next = canon(/^[\s-]*([\p{L}\p{N}][\p{L}\p{N}'’+.-]*)/u.exec(t.slice(m.index! + m[0].length))?.[1] ?? "");
    if (!firsts.has(next)) return true;
  }
  return !any;
}
/**
 * Statements one search hit makes about a capability (first attributable clause), or null.
 * ATTRIBUTION (review R-01, generalized in V2.1): a clause counts only if
 *  (a) it names this exact model (a word-like model such as "Aero" only together with its brand) and no other
 *      product, listed or not, or
 *  (b) it names no product at all AND the snippet names no other product (listed or not) AND the title names no listed
 *      other product AND the page is not a comparison page (a pronoun clause in a single-product review).
 * Questions, table rows and reported or second-hand speech ("according to", "via", "X says") never count.
 */
const PART_TITLE_WORD = /\b(?:spare|replacement|batter(?:y|ies)|chargers?|mounts?|sleeves?|filters?|covers?|blades?|remotes?|nozzles?|pans?|housings?|straps?|attachments?|adapters?|guards?|pedals?|rollers?|peels?|cases?)\b/i;
export function statementFrom(hit: { title: string; snippet: string }, product: CatalogProduct, capability: string, listed: CatalogProduct[] = []): { value: boolean; quote: string } | null {
  const model = product.identity.model;
  const text = `${hit.title}. ${hit.snippet}`;
  const genAttr = factsOf(product).attributes.generation;
  const generation = genAttr && genAttr !== "CONFLICT" ? genAttr : null;
  const ext = extensionWords(product, listed);
  // I1: the page title is a product name too. When it continues this model with words this product's title does not have
  // there ("Kerfmaster 14in Riser Block" read for the Kerfmaster 14in Band Saw), the page is about that other product,
  // listed or not. Page words ("specifications", "review", "manual") are not a continuation.
  if (model) {
    const t = titleContinuation(hit.title, product);
    if (t && !ext.has("page")) ext.set("page", t);
  }
  const namesThis = (t: string) => !!model && mentionsExactModel(t, model, { generation }) && (/\d/.test(model) || brandWithModel(t, product)) && namesUnconsumed(t, model, ext);
  // I1: the listed product this page's title is about, when it is another one (its distinguishing words).
  const titleOther = model && mentionsExactModel(hit.title, model, { generation }) && !namesUnconsumed(hit.title, model, ext) ? nextNamed(hit.title, model, ext) : null;
  if (model) {
    if (!namesThis(text)) return null;
    // V2.9: a page that names this code only as another variant ("Kestra A5 4K" for the A5) is about that variant.
    const vcode = modelCode(model);
    if (vcode && namesOtherVariant(text, product.title, vcode)) return null;
    // A listing whose title names a variant after the code that a listed sibling lacks ("Kestra A5 4K" beside the A5)
    // counts only pages that name that variant.
    const vrun = product.research?.variantRun;
    if (vcode && vrun?.length && !namesVariantRun(text, vcode, vrun)) return null;
  } else {
    // No model: the brand plus at least two title words must appear (weak attribution; still needs a counted source).
    const words = product.title.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
    if (!product.identity.brand || !text.toLowerCase().includes(product.identity.brand.toLowerCase()) || words.filter((w) => text.toLowerCase().includes(w)).length < 3) return null;
    // V2.3: a spec the title names ("100W", "20000mAh", "1.7L") is part of what the product is. A page that never states
    // it is about a sibling ("Voltaro 65W GaN charger" is not the 100W one), so it is not attributed.
    const squash = (t: string) => t.normalize("NFKC").toLowerCase().replace(/(\d)\s*-?\s*(?=[a-z])/g, "$1");
    const specs = squash(product.title).match(/(?<![a-z0-9.])\d+(?:\.\d+)?(?:w|kw|mah|wh|v|l|qt|oz|ml|gb|tb|hz|mm|cm)(?![a-z])/g) ?? [];
    if (specs.some((x) => !new RegExp(`(?<![a-z0-9.])${x.replace(/\./g, "\\.")}(?![a-z])`).test(squash(text)))) return null;
  }
  const comparisonPage = COMPARISON_TITLE.test(hit.title);
  const facts = factsOf(product);
  // V2.10 (IW-11 d06): a page about a part of this model ("Pedalto C1 Spare Battery": "it fits the C1 ...; it does not
  // fit the C1 Long Range") describes the part, so it never states anything about the product itself.
  if (facts.kind === "STANDALONE" && model) {
    const at = hit.title.toLowerCase().indexOf(model.toLowerCase());
    const after = at >= 0 ? hit.title.slice(at + model.length) : "";
    const own = new Set(product.title.toLowerCase().split(/[^a-z]+/));
    const part = PART_TITLE_WORD.exec(after);
    if (part && !own.has(part[0].toLowerCase())) return null;
  }
  // V2.10: a fit statement names other products by design ("fits the C1 and C1 Step-Through"). It counts only on a page
  // about this part: every word of the part's own name (its title without brand, model and numbers) is on the page.
  const fit = capability.startsWith(FIT_PREFIX);
  if (fit) {
    const strip = [product.identity.brand, product.identity.model].filter((x): x is string => !!x).reduce((t, n) => t.replace(new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "[\\s-]*"), "gi"), " "), product.title);
    let partWords = strip.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 3 && !/^(?:for|the|and|with|new)$/.test(w));
    // Post-submission cycle 3 (F3): a family-titled part's parsed model can hold its whole name ("Pacer Snowshoe Tails").
    // Its own words are then the title words that are neither the brand nor the host named in the fit key.
    if (!partWords.length) {
      const host = new Set(capability.slice(FIT_PREFIX.length).split("-"));
      const brand = (product.identity.brand ?? "").toLowerCase();
      partWords = product.title.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 3 && w !== brand && !host.has(w) && !/^(?:for|the|and|with|new)$/.test(w));
    }
    const low = text.toLowerCase();
    if (!partWords.length || partWords.some((w) => !new RegExp(`(?<![a-z])${w}`).test(low))) return null;
  }
  // Model year (V21-03). A dated product counts only a page that names its year; a page naming another year counts only
  // a clause that names this year and no other. An undated product never counts a year-qualified page (fail closed).
  const year = facts.attributes.year && facts.attributes.year !== "CONFLICT" ? facts.attributes.year : null;
  if (facts.attributes.year === "CONFLICT") return null;
  const hitYears = modelYearsIn(text, model);
  if (year ? !hitYears.has(year) : hitYears.size > 0) return null;
  // N-02: generations follow the same rules as model years.
  if (genAttr === "CONFLICT") return null;
  const hitGens = generationsIn(text);
  if (generation ? !hitGens.has(generation) : hitGens.size > 0) return null;
  const otherGenInHit = !!generation && [...hitGens].some((g) => g !== generation);
  const otherYearInHit = (!!year && [...hitYears].some((y) => y !== year)) || otherGenInHit;
  const asked = capability.startsWith(PROPOSITION_PREFIX) ? [capability.slice(PROPOSITION_PREFIX.length).replace(/-/g, " ")] : [];
  const vc = modelCode(model);
  // V2.9: a page that also names another variant of this model ("the Kestra A5 4K" on a page read for the A5) names
  // another product: only clauses that name this exact product count, never a pronoun clause.
  // V2.15 (IW-15 d02): a page whose title names this brand but not this product is about another product (a part, a
  // sibling): only clauses that name this product themselves count, never a pronoun clause.
  const titleAboutOther = !!titleOther || (!!model && !namesThis(hit.title) && !!product.identity.brand && hit.title.toLowerCase().includes(product.identity.brand.toLowerCase()));
  const hitNamesOther = titleAboutOther || namesOtherProduct(text, product) || namesUnknownEntity(hit.snippet, product, asked) || otherYearInHit || (!!vc && mentionsOtherVariant(text, product.title, vc));
  // Reported or second-hand speech disqualifies its whole sentence ("Via rtings.com: it supports ...").
  // Post-submission cycle 6c, invariant I8: a spec line "<label>: <value>" is read whole when the value is short (at most
  // four words): "온도 조절: 없음" is a denial, never the bare label "온도 조절".
  const clauses = hit.snippet.split(/(?<=[.!?])\s+/).filter((sentence) => !REPORTED.test(sentence)).flatMap((sentence) => sentence.split(/;\s*|\s+—\s+|:\s+(?!(?:yes|no|none|n\/a|not\s+(?:included|available|supported))\b|(?:[^\s.;:!?]+\s*){1,4}[.!?]?\s*$)|,\s+(?:and|but|while|whereas)\s+(?=(?:the|a|an|its|this|that)\s+[A-Z])/i));
  // V2.19 (IW-19 failure 1): a page that both states and denies a requirement denies it. Every clause is read, and a
  // denial wins over an earlier match ("Above Ground Pool Pump ... it is not for in-ground pools").
  let firstTrue: { value: boolean; quote: string } | null = null;
  for (const clause of clauses) {
    if (/\|/.test(clause) || /\?\s*$/.test(clause)) continue; // table rows and questions are not statements
    if (OTHER_GENERATION.test(clause)) continue;
    const clauseYears = modelYearsIn(clause, model);
    if ([...clauseYears].some((y) => y !== year)) continue;
    const clauseGens = generationsIn(clause);
    if ([...clauseGens].some((g) => g !== generation)) continue;
    const clauseNamesThis = namesThis(clause) && (!otherYearInHit || (!!year && clauseYears.has(year)) || (!!generation && clauseGens.has(generation)));
    if (fit) {
      if (comparisonPage) continue;
      const v = clauseStatement(clause, capability);
      if (v === false) return { value: v, quote: clause.trim().slice(0, 300) };
      if (v === true) firstTrue ??= { value: v, quote: clause.trim().slice(0, 300) };
      continue;
    }
    if (namesOtherProduct(clause, product) || namesUnknownEntity(clause, product, asked)) continue;
    if (vc && mentionsOtherVariant(clause, product.title, vc)) continue;
    // I1: on a page about another listed product, a clause that names this product together with that product's own
    // words ("With the riser block, the Kerfmaster 14in resaws up to 12 in") describes the two together, not this one.
    if (titleOther && titleOther.some((w) => tokensOf(clause).has(w))) continue;
    // V2.10: a spec line ("Built-in pump: yes") on a page whose title names only this product is about this product,
    // even when the page body compares it with a sibling.
    const specLine = /^\s*[A-Z][A-Za-z0-9 /-]{1,30}:\s*[^:]{1,40}$/.test(clause.replace(/\.\s*$/, "")) && !comparisonPage && namesThis(hit.title)
      && !namesOtherProduct(hit.title, product) && !(vc && mentionsOtherVariant(hit.title, product.title, vc));
    if (!clauseNamesThis && (comparisonPage || hitNamesOther) && !specLine) continue;
    // V2.7: "Like the TI-5, it is cordless" on another product's page: this model is only the comparison, the subject is
    // the other product. Attribution fails closed: the clause is not a statement about this model.
    if (model && hitNamesOther && /^\s*(?:like|unlike|as with|similar to|compared (?:to|with)|just like)\s/i.test(clause)) {
      const lead = /^[^,]*,/.exec(clause)?.[0] ?? "";
      if (lead && namesThis(lead) && !namesThis(clause.slice(lead.length))) continue;
    }
    // V2.2 WP-4: a clause about a kit, bundle or combo describes another configuration than a standalone product
    // ("the kit includes two batteries" says nothing about the tool-only listing).
    if (facts.kind === "STANDALONE" && /\b(?:kits?|bundles?|combos?|combo pack|set includes|package includes|bundled with)\b|세트|번들|패키지/i.test(clause)) continue;
    const said = parseAttributes(clause);
    const clash = (Object.keys(said) as AttributeAxis[]).some((a) => a !== "color" && facts.attributes[a] && normalizeKey(said[a]!) !== normalizeKey(facts.attributes[a]!));
    if (clash) continue;
    // V2.2 WP-4: a proposition word that is part of the product's own name ("Alder" in "Alder 30L Travel Backpack") is
    // not a statement about the product, so the product's brand and model are removed before a proposition is matched.
    const own = capability.startsWith(PROPOSITION_PREFIX)
      ? [product.identity.brand, product.identity.model].filter((x): x is string => !!x).reduce((t, n) => t.replace(new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "[\\s-]*"), "gi"), " "), clause)
      : clause;
    // V2.19 (IW-19 d26): a name word of this model that is still on the clause after its own name was removed belongs to
    // a sibling ("Unlike the Vanta 1000W, the Vanta 2000W delivers 2,000 W"): the clause is about that sibling.
    // A leading contrast ("Unlike the Wicket 40in, the Wicket 40in Hardmount is ...") names the sibling on purpose: the
    // rest of the clause is the statement, and it must name this product.
    const lead = /^\s*(?:unlike|compared (?:to|with)|in contrast to|versus|vs\.?)\s[^,]*,\s*/i.exec(clause)?.[0] ?? "";
    const restOwn = lead && capability.startsWith(PROPOSITION_PREFIX)
      ? [product.identity.brand, product.identity.model].filter((x): x is string => !!x).reduce((t, n) => t.replace(new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "[\\s-]*"), "gi"), " "), clause.slice(lead.length))
      : own;
    if (lead && model && !namesThis(clause.slice(lead.length))) continue;
    if (restOwn !== (lead ? clause.slice(lead.length) : clause) && model && model.split(/\s+/).some((w) => /^[a-z]{3,}$/i.test(w) && new RegExp(`(?<![\\p{L}])${w}(?![\\p{L}])`, "iu").test(restOwn))) continue;
    const v = clauseStatement(own, capability);
    if (v === false) return { value: v, quote: clause.trim().slice(0, 300) };
    if (v === true) firstTrue ??= { value: v, quote: clause.trim().slice(0, 300) };
  }
  return firstTrue;
}

/**
 * Model years a text attributes to a model (V21-03): "(2025)", "2025 model/edition", "model year 2025", "2025년형",
 * "'25 model", or a year written right next to the model name ("Quill 13 2024", "the 2024 Quill 13"). A calendar date
 * ("updated March 2025") is not a model year.
 */
export function modelYearsIn(text: string, model: string | null): Set<string> {
  const t = text.normalize("NFKC");
  const out = new Set<string>();
  const add = (y: string) => { const v = y.length === 2 ? `20${y}` : y; if (Number(v) >= 2005 && Number(v) <= 2035) out.add(v); };
  for (const re of [/\((20[0-3]\d)\)/g, /\bmodel year\s*(20[0-3]\d)\b/gi, /\b(20[0-3]\d)\s*(?:model|edition|version|release)\b/gi, /(20[0-3]\d)\s*년\s*형/g, /'(\d{2})\s*(?:model|edition)\b/gi])
    for (const m of t.matchAll(re)) add(m[1]!);
  if (model) {
    const esc = model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "[\\s-]*");
    for (const m of t.matchAll(new RegExp(`${esc}[\\s,-]*(?:'(\\d{2})|(20[0-3]\\d))(?![\\d.,%]|\\s*(?:\\$|usd|원|mah|w\\b|hours?))`, "gi"))) add((m[1] ?? m[2])!);
    for (const m of t.matchAll(new RegExp(`(?<![\\w$.,])(20[0-3]\\d)\\s+(?:[A-Z][\\w&-]*\\s+)?${esc}(?=$|[^A-Za-z0-9])`, "gi"))) add(m[1]!);
  }
  return out;
}
/** Phrases that point at another generation or year of the same model ("last year's model", "the predecessor"). */
const OTHER_GENERATION = /\b(?:last year'?s|previous(?:[- ]gen(?:eration)?| model| version| year)|prior (?:model|generation|version)|older (?:model|version)|predecessor|outgoing model|earlier model|next[- ]gen(?:eration)?|successor|upcoming model|(?:newer|older|later|earlier|recent|some|select|certain|other|premium|higher[- ]end|future)\s+(?:editions?|versions?|models?|generations?|variants?|trims?|revisions?))\b|작년\s*(?:모델|형)|전작|구형|이전\s*(?:세대|모델)|후속\s*(?:작|모델)|신형/i;

/** The brand immediately before the model ("Northwind Aero"), separator- and case-tolerant. */
function brandWithModel(text: string, product: CatalogProduct): boolean {
  const b = product.identity.brand, m = product.identity.model;
  if (!b || !m) return false;
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "[\\s-]*");
  return new RegExp(`(^|[^A-Za-z0-9])${esc(b)}[\\s-]*${esc(m)}(?=$|[^A-Za-z0-9])`, "i").test(text);
}

export function classifyItem(i: Omit<EvidenceItem, "counts" | "whyNotCounted">, now: number): EvidenceItem {
  let why: string | null = null;
  if (i.sourceClass === "RETAILER") why = "retailer/marketplace page (merchant-controlled)";
  else if (i.sourceClass === "USER_FORUM") why = "user forum (anecdotal)";
  else if (i.sourceClass === "UNKNOWN") why = "unregistered site (search snippet only)";
  else if (i.publishedDate && Number.isFinite(Date.parse(i.publishedDate)) && now - Date.parse(i.publishedDate) > STALE_AFTER_DAYS * 86400_000) why = "stale (published more than 4 years ago)";
  return { ...i, counts: why === null, whyNotCounted: why };
}

/** Near-duplicate print: word trigrams, or the whole normalized text when it is too short for trigrams (V2.1). */
function printOf(quote: string): Set<string> {
  const sh = shingles(quote);
  return sh.size ? sh : new Set([`=${quote.toLowerCase().replace(/[^a-z0-9가-힣]+/g, " ").trim()}`]);
}

export function judgeV2(capability: string, rawItems: EvidenceItem[]): CapabilityVerdict {
  // V2.2 WP-4: manufacturer text can establish a manufacturer-stated property, never a performance judgement ("quiet",
  // "comfortable", "durable"): for those only independent expert groups count.
  const performance = isPerformanceClaim(capability);
  const items = performance ? rawItems.map((x) => x.sourceClass === "MANUFACTURER" && x.counts ? { ...x, counts: false, whyNotCounted: "manufacturer claim; a performance claim needs independent evidence" } : x) : rawItems;
  const counted = items.filter((x) => x.counts);
  const manu = counted.filter((x) => x.sourceClass === "MANUFACTURER");
  const expert = counted.filter((x) => x.sourceClass === "EXPERT_REVIEW");
  // Expert groups: one per registrable domain; near-identical text across domains merges groups (syndication).
  const groups: Array<{ domains: Set<string>; prints: Array<Set<string>>; values: Set<boolean> }> = [];
  for (const e of expert) {
    const d = registrableDomain(e.domain); const sh = printOf(e.quote);
    const g = groups.find((x) => x.domains.has(d) || x.prints.some((p) => jaccard(p, sh) >= 0.6));
    if (g) { g.domains.add(d); g.prints.push(sh); g.values.add(e.value); } else groups.push({ domains: new Set([d]), prints: [sh], values: new Set([e.value]) });
  }
  const values = new Set([...manu.map((m) => m.value), ...groups.flatMap((g) => [...g.values])]);
  if (values.size > 1) return { capability, status: "CONTRADICTED", basis: "CONFLICT", evidence: items, independentGroups: groups.length };
  if (manu.length) return { capability, status: manu[0]!.value ? "VERIFIED_TRUE" : "VERIFIED_FALSE", basis: "MANUFACTURER", evidence: items, independentGroups: groups.length };
  if (groups.length >= 2) { const v = [...groups[0]!.values][0]!; return { capability, status: v ? "VERIFIED_TRUE" : "VERIFIED_FALSE", basis: "TWO_EXPERT_GROUPS", evidence: items, independentGroups: groups.length }; }
  return { capability, status: "UNVERIFIED", basis: "INSUFFICIENT", evidence: items, independentGroups: groups.length };
}

export { hostOf };
