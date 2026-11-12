import type { CatalogProduct, Condition, MerchantOffer, ProductIdentity } from "../domain/types.js";
import { AXES, VERSION_AXES, PRODUCT_NOUN_PHRASES, attributesFromVariant, extractIdentity, familyKey, normalizeKey, type AttributeAxis, type ProductKind, type VariantAttributes } from "./ProductIdentityExtractor.js";
import type { ResearchIntentV2 } from "../intent/ResearchIntentV2.js";
import { productCategory, requestCategory } from "../research/capabilities.js";
import { canon, missingNameWords, modelCode, pickVariant, requestNameWord } from "./VariantTail.js";

/**
 * Research V2 exact-identity resolution (variant-aware, multi-category).
 *
 * Rules (fail closed, never substitute):
 *  1. Family: brand + model key must be equal ("Nova 9" ≠ "Nova 9 Pro"; separators and case ignored).
 *  2. Kind: a standalone request never locks a bundle, multi-pack or accessory, and vice versa; an accessory request
 *     must name the same accessory noun.
 *  3. Attributes: every attribute the user stated must equal the listing's attribute. A listing whose attribute is
 *     unknown or conflicting (title vs structured variant) is excluded for that axis: never assumed to match.
 *  4. Condition: a listing whose title states a condition must match; otherwise at least one offer in the requested
 *     condition must exist. Offers with unknown condition are reported, never treated as new.
 *  5. Availability: at least one offer not known to be out of stock.
 *  6. Several remaining listings that differ on an unstated attribute → AMBIGUOUS (ask). Identical listings → one item.
 */
export interface ProductFacts {
  product: CatalogProduct;
  kind: ProductKind;
  accessoryNoun: string | null;
  attributes: VariantAttributes;
  conflictingAxes: string[];
  titleCondition: Condition | null;
  family: string;
}

export function factsOf(p: CatalogProduct): ProductFacts {
  const r = p.research;
  if (r) {
    const accessoryNoun = r.kind === "ACCESSORY" ? (/^ACCESSORY ([^/]+)/.exec(p.identity.variant ?? "")?.[1]?.trim() ?? null) : null;
    return { product: p, kind: r.kind, accessoryNoun, attributes: r.attributes, conflictingAxes: r.conflictingAxes, titleCondition: (r.titleCondition === "open_box" ? "used" : r.titleCondition) as Condition | null,
      family: familyKey(r.kind === "ACCESSORY" && r.fitsBrand ? r.fitsBrand : p.identity.brand, p.identity.model) };
  }
  // Products without research metadata (fixtures, other adapters): derive from the title and the identity variant.
  const ex = extractIdentity(p.title, p.identity.brand || null);
  return { product: p, kind: ex.kind, accessoryNoun: ex.accessoryNoun, attributes: { ...ex.attributes, ...attributesFromVariant(p.identity.variant) }, conflictingAxes: [],
    titleCondition: p.identity.condition !== "new" ? p.identity.condition : null, family: familyKey(ex.kind === "ACCESSORY" && ex.fitsBrand ? ex.fitsBrand : p.identity.brand, p.identity.model) };
}

const eqAttr = (axis: AttributeAxis, a: string, b: string) => normalizeKey(axis === "color" && /^gr[ae]y$/i.test(a) ? "gray" : a) === normalizeKey(axis === "color" && /^gr[ae]y$/i.test(b) ? "gray" : b);
const nounKey = (n: string | null) => (n ?? "").toLowerCase().replace(/\s+/g, "").replace(/s$/, "");
/**
 * The listing is the accessory asked for: same accessory noun, or (V2.9) a listing the parse only knows as an
 * accessory/part whose title states the requested noun ("Spinlo T3 Replacement Belt" for "T3 belt").
 */
function accessoryNounMatches(f: ProductFacts, want: string | null): boolean {
  if (nounKey(f.accessoryNoun) === nounKey(want)) return true;
  if (!want) return false;
  const head = want.trim().split(/\s+/).at(-1)!;
  if (f.accessoryNoun && nounKey(f.accessoryNoun.trim().split(/\s+/).at(-1)!) === nounKey(head)) return true;
  if (f.accessoryNoun && !/^(?:accessory|part|parts)$/i.test(f.accessoryNoun)) return false;
  return nounRe(head).test(f.product.title.normalize("NFKC"));
}

function partNamedAfterModel(p: CatalogProduct, noun: string): boolean {
  const title = p.title.normalize("NFKC");
  const m = p.identity.model;
  const at = m ? title.toLowerCase().indexOf(m.toLowerCase()) : -1;
  if (at < 0) return false;
  const head = noun.trim().split(/\s+/).at(-1)!;
  const after = title.slice(at + m!.length);
  // Post-submission cycle 1 (F3): the part noun must be the head of the noun phrase after the model, never a modifier
  // inside the host's own product noun: "Hose Reel" after the model is a reel (the host), not a "leader hose".
  const phrase = after.split(/[,;(|–—]|\s-\s|\s+(?:with|for|and|in|by|includes?)\s/i)[0]!;
  const lastWord = (phrase.match(/[A-Za-z][A-Za-z-]*/g) ?? []).at(-1) ?? "";
  if (!nounRe(head).test(lastWord)) return false;
  return nounRe(head).test(after) && !(after.match(KIND_NOUN) ?? []).some((k) => nounKey(k) !== nounKey(head));
}
/** Cycle 4: the title, after its model, ends with the requested part noun ("Tessel 4000 Pre-Filter" for "pre-filter"). */
function titleEndsWithPart(p: CatalogProduct, noun: string): boolean {
  const m = p.identity.model; const title = p.title.normalize("NFKC");
  const at = m ? title.toLowerCase().indexOf(m.toLowerCase()) : -1;
  if (at < 0) return false;
  const k = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const after = k(title.slice(at + m!.length)), want = k(noun);
  return want.length >= 3 && after.endsWith(want) && (after === want || after.length - want.length <= 12);
}
export type ResolutionV2 =
  | { status: "LOCKED"; productId: string; identity: ProductIdentity; facts: ProductFacts; conditionConfirmed: boolean; duplicates: string[]; assumptions: string[]; excluded: Exclusion[];
      /** V2.10: the part is locked through its base model; it must be shown to fit this full requested model. */
      fitModel?: string }
  | { status: "AMBIGUOUS"; options: Array<{ productId: string; identity: ProductIdentity; differing: Partial<Record<AttributeAxis, string>> }>; differingAxes: AttributeAxis[]; question: string; excluded: Exclusion[]; productTypeAmbiguous?: boolean }
  | { status: "NOT_FOUND"; code: "NO_MODEL" | "NO_FAMILY_MATCH" | "KIND_MISMATCH" | "ATTRIBUTE_NOT_FOUND" | "CONDITION_NOT_OFFERED" | "UNAVAILABLE"; reason: string;
      /** A sibling variant (product detail) that may match the stated attributes but was not in the search results. */
      siblingToCheck: { productId: string; providerProductId: string; axis: string; label: string } | null; excluded: Exclusion[] };
export interface Exclusion { productId: string; title: string; reason: string }

/** V2.8: everyday synonyms for a product noun (the title may use either). */
const NOUN_SYNONYMS: string[][] = [["walkie talkie", "walkie-talkie", "two-way radio", "radio"], ["earbuds", "earphones"], ["headphones", "headset"],
  ["laptop", "notebook"], ["tv", "television"], ["fridge", "refrigerator"], ["couch", "sofa"], ["vacuum", "vacuum cleaner"], ["cellphone", "smartphone", "phone"],
  // V2.9 (IW-10 fix order item 4): synonyms of product nouns.
  ["record player", "turntable"], ["quadcopter", "drone"], ["digital piano", "keyboard", "piano"], ["action camera", "action cam", "camera"],
  ["e-scooter", "electric scooter", "scooter"], ["bread maker", "bread machine"], ["electric blanket", "heated blanket"]];
/**
 * V2.9: nouns that name what a product IS. When the request names one ("Kestra A5 drone") and the listing's title names
 * another ("Kestra A5 Action Camera"), the listing is not the requested product even if no category is known.
 */
const KIND_NOUN = /(?<![a-z])(?:headphones?|headsets?|earbuds?|earphones?|speakers?|soundbars?|laptops?|notebooks?|tablets?|smartphones?|phones?|cameras?|camcorders?|drones?|quadcopters?|scooters?|bikes?|bicycles?|monitors?|tvs?|televisions?|projectors?|printers?|routers?|keyboards?|pianos?|turntables?|record players?|mice|mouse|smartwatch(?:es)?|watch(?:es)?|kettles?|blenders?|toasters?|fryers?|cookers?|microwaves?|vacuums?|flossers?|toothbrush(?:es)?|heaters?|fans?|lamps?|purifiers?|humidifiers?|dehumidifiers?|blankets?|chairs?|desks?|tents?|backpacks?|bottles?|batter(?:y|ies)|chargers?|belts?|pans?|housings?|cases?|covers?|cables?|straps?|filters?|tips|binoculars|telescopes?|detectors?|radios?|e-?readers?|ereaders?|mowers?|lawnmowers?|e-?bikes?|scales?|kayaks?|canoes?|paddle ?boards?|air conditioners?|ovens?|grills?|printers?|bread (?:makers?|machines?))(?![a-z])/gi;
const nounRe = (n: string) => new RegExp(`(?<![a-z])${n.split(/[\s-]+/).map((w) => w.replace(/(?:es|s)$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[\\s-]*")}e?s?(?![a-z])`, "i");
/**
 * V2.8: is a listing the product noun the request wrote after the model? YES when its title states the noun (or a
 * synonym) or its category is the noun's category; NO when the noun has a known category and the listing is not in it
 * ("MD-7 Headphones" vs a metal detector); otherwise UNKNOWN (kept, but never recommended without the noun).
 */
export function targetNounMatch(p: CatalogProduct, noun: string | null | undefined): "YES" | "NO" | "UNKNOWN" {
  if (!noun) return "YES";
  const title = p.title.normalize("NFKC");
  const head = noun.split(/\s+/).at(-1)!;
  const forms = [noun, head, ...NOUN_SYNONYMS.filter((g) => g.some((x) => nounRe(x).test(noun))).flat()];
  if (forms.some((x) => nounRe(x).test(title))) return "YES";
  const rc = requestCategory(noun); const pc = productCategory(p);
  if (rc && pc && rc.id === pc) return "YES";
  if (rc) return "NO";
  if (new RegExp(`^(?:${KIND_NOUN.source})$`, "i").test(head)) {
    const named = [p.identity.brand, p.identity.model].filter((x): x is string => !!x).reduce((t, n) => t.replace(new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "[\\s-]*"), "gi"), " "), title);
    if ((named.match(KIND_NOUN) ?? []).length) return "NO";
  }
  return "UNKNOWN";
}
type ResolveIntent = Pick<ResearchIntentV2, "target" | "attributes" | "condition" | "conditionStated"> & { targetNoun?: string | null; requestTail?: string[] };
/**
 * V2.10 (IW-11 fix order item 2): a part is often listed under the base model of the family it fits ("Pedalto C1 Spare
 * Battery" fits the C1 and the C1 Step-Through). When no part listing names the full requested host model, a same-brand
 * part listing whose model is the requested model minus its trailing name words ("C1" for "C1 Step-Through", "SD-16"
 * for "SD-16P") is locked with fitModel set: the planner then requires the manufacturer's fit statement for the full
 * model (capabilities.fitStatement), and a page that says it does not fit, or says nothing, never recommends it.
 */
export function resolveExactV2(intent: ResolveIntent, products: CatalogProduct[], offersOf: (productId: string) => MerchantOffer[]): ResolutionV2 {
  const t0 = intent.target;
  // Post-submission cycle 4 (IW-21 a04/a07): a part noun the parser does not know ("Tessel 4000 pre-filter") leaves the
  // request STANDALONE with the part as its tail. When a listed same-brand ACCESSORY's title has that tail as the head
  // noun after its model, and the requested model is that model or extends it, the request names the part. The part
  // path decides; if it does not lock, the original reading stands.
  if (t0?.kind === "STANDALONE" && t0.brand && t0.model && !t0.sku && intent.targetNoun && (intent.requestTail?.length ?? 0) > 0) {
    const noun = intent.targetNoun;
    const want = normalizeKey(t0.model);
    const parts = products.map(factsOf).filter((f) => f.kind === "ACCESSORY" && f.product.identity.model && familyKey(f.product.identity.brand, f.product.identity.model) === familyKey(t0.brand, f.product.identity.model)
      && want.startsWith(normalizeKey(f.product.identity.model)) && titleEndsWithPart(f.product, noun));
    if (parts.length) {
      const asPart = resolveExactV2({ ...intent, target: { ...t0, kind: "ACCESSORY", accessoryNoun: noun } }, products, offersOf);
      if (asPart.status === "LOCKED" && factsOf(products.find((p) => p.productId === asPart.productId)!).kind === "ACCESSORY") return asPart;
    }
  }
  const r = resolveCore(intent, products, offersOf);
  const t = intent.target;
  if (r.status !== "NOT_FOUND" || t?.kind !== "ACCESSORY" || !t.brand || !t.model || t.sku) return r;
  // The full host name: the model plus the name words the request wrote right after it ("R9" + "Dual").
  const inModel = new Set(t.model.split(/\s+/).map((w) => w.toLowerCase()));
  const extra: string[] = [];
  for (const w of intent.requestTail ?? []) { if (!requestNameWord(w)) break; if (!inModel.has(w.toLowerCase())) extra.push(w); }
  const host = [t.model, ...extra].join(" ");
  const want = normalizeKey(host);
  const words = host.split(/\s+/);
  const base = (m: string) => {
    const k = normalizeKey(m);
    if (!k || k === want || !want.startsWith(k)) return false;
    if (words.some((_, i) => i > 0 && normalizeKey(words.slice(0, i).join(" ")) === k)) return true;
    return /\d$/.test(k) && /^[a-z]{1,2}$/i.test(want.slice(k.length));
  };
  const bases = [...new Set(products.map(factsOf).filter((f) => (f.kind === "ACCESSORY" || (f.kind === "STANDALONE" && !!t.accessoryNoun && partNamedAfterModel(f.product, t.accessoryNoun))) && f.product.identity.model && familyKey(f.product.identity.brand, f.product.identity.model) === familyKey(t.brand, f.product.identity.model) && base(f.product.identity.model))
    .map((f) => f.product.identity.model!))].sort((a, b) => normalizeKey(b).length - normalizeKey(a).length);
  for (const m of bases) {
    const r2 = resolveCore({ ...intent, target: { ...t, model: m }, requestTail: [], targetNoun: null }, products, offersOf);
    if (r2.status === "LOCKED") return { ...r2, fitModel: host, excluded: [...r.excluded, ...r2.excluded.filter((e) => !r.excluded.some((x) => x.productId === e.productId))],
      assumptions: [...r2.assumptions, `No ${t.accessoryNoun ?? "part"} listing names the ${t.brand} ${host}; the ${t.brand} ${m} listing is checked against the manufacturer's statement that it fits the ${host}.`] };
  }
  // Post-submission cycle 3 (F3): a part is often titled with the family name only ("Corvan Tide Seat Pad" for a pad that fits
  // the Tide 1-Seat and Tide 2-Seat). A same-brand listing whose title names the brand, the host's family word and the
  // requested part noun as its head noun, and names no other number token than the host's, is the part candidate; it is
  // locked only with fitModel, so the manufacturer must state that it fits the full requested host. The host itself
  // (whose title's head noun is its own product noun) is never such a candidate.
  if (t.accessoryNoun) {
    const fam = t.model.split(/\s+/)[0]!;
    const hostNums = new Set((host.match(/\d[\w./-]*/g) ?? []).map((x) => normalizeKey(x)));
    const noun = t.accessoryNoun.trim();
    const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const famRe = new RegExp(`(?:^|[^A-Za-z0-9])${esc(t.brand)}\\s+${esc(fam)}(?![A-Za-z0-9])`, "i");
    const cands = products.map(factsOf).filter((f) => {
      const title = f.product.title.normalize("NFKC");
      if (f.kind === "BUNDLE" || !famRe.test(title) || (f.product.identity.brand ?? "").toLowerCase() !== t.brand!.toLowerCase()) return false;
      const head = (title.split(/[,;(|–—]|\s-\s/)[0]!.match(/[A-Za-z][A-Za-z-]*/g) ?? []).at(-1) ?? "";
      if (!nounRe(noun.split(/\s+/).at(-1)!).test(head) || !nounRe(noun).test(title)) return false;
      const nums = (title.match(/\d[\w./-]*/g) ?? []).map((x) => normalizeKey(x));
      return nums.every((n) => hostNums.has(n));
    });
    if (cands.length === 1) {
      const f = cands[0]!; const m = f.product.identity.model ?? fam;
      const r3 = resolveCore({ ...intent, target: { ...t, model: m, kind: f.kind, accessoryNoun: f.accessoryNoun }, requestTail: [], targetNoun: null }, [f.product], offersOf);
      if (r3.status === "LOCKED") return { ...r3, fitModel: host, excluded: [...r.excluded, ...r3.excluded.filter((e) => !r.excluded.some((x) => x.productId === e.productId))],
        assumptions: [...r3.assumptions, `The ${t.brand} ${noun} is listed for the ${t.brand} ${fam} family; it is checked against the manufacturer's statement that it fits the ${host}.`] };
    }
  }
  return r;
}
function resolveCore(intent: ResolveIntent, products: CatalogProduct[], offersOf: (productId: string) => MerchantOffer[]): ResolutionV2 {
  const t = intent.target;
  const excluded: Exclusion[] = [];
  if (!t?.model && !t?.sku) return { status: "NOT_FOUND", code: "NO_MODEL", reason: "No model was given, so no exact product can be locked.", siblingToCheck: null, excluded };
  const want = familyKey(t!.brand, t!.model);
  const wantNoBrand = normalizeKey(t!.model ?? "");
  let all = products.map(factsOf);
  // An explicit SKU is the strongest identity: only listings with that SKU can be the product.
  if (t.sku) {
    const bySku = all.filter((f) => f.product.identity.sku && normalizeKey(f.product.identity.sku) === normalizeKey(t.sku!));
    for (const f of all) if (!bySku.includes(f)) excluded.push({ productId: f.product.productId, title: f.product.title, reason: f.product.identity.sku ? `SKU ${f.product.identity.sku}, requested ${t.sku}` : "listing has no SKU" });
    all = bySku;
  }
  // A brandless listing can match only a request that names no brand (review R-06): "Sony WH-1000XM5" is never locked
  // to an unbranded "WH-1000XM5 (compatible)" listing.
  // V2.5: a listing whose own model stops before the requested sibling suffix ("AF-55" from "Cindra AF-55 Duo Air
  // Fryer", request "AF-55 Duo") is that model when its title names brand and the full requested model contiguously.
  const suffixMatch = (f: ProductFacts) => {
    const lm = normalizeKey(f.product.identity.model ?? "");
    if (!t!.brand || !t!.model || !lm || !wantNoBrand.startsWith(lm) || wantNoBrand === lm || familyKey(f.product.identity.brand, f.product.identity.model) !== familyKey(t!.brand, f.product.identity.model)) return false;
    const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    // V2.8: a space or hyphen inside the code is the same code ("BM 3 HD" is "BM-3 HD").
    const code = t!.model.split(/[\s-]+/).map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[-\\s]*");
    return new RegExp(`(?:^|[^A-Za-z0-9])${esc(t!.brand)}\\s+${code}(?![A-Za-z0-9])`, "i").test(f.product.title.normalize("NFKC"));
  };
  const family = !t!.model ? all : all.filter((f) => f.family === want || suffixMatch(f) || (!t!.brand && !f.product.identity.brand && normalizeKey(f.product.identity.model) === wantNoBrand));
  for (const f of all) if (!family.includes(f)) excluded.push({ productId: f.product.productId, title: f.product.title,
    reason: t!.brand && !f.product.identity.brand && normalizeKey(f.product.identity.model) === wantNoBrand ? `listing states no brand; requested ${t!.brand}` : `different model (${f.product.identity.brand} ${f.product.identity.model || "unknown"})` });
  if (!family.length) return { status: "NOT_FOUND", code: "NO_FAMILY_MATCH", reason: `No listing is the ${t!.brand ?? ""} ${t!.model ?? t!.sku} itself.`.replace(/\s+/g, " "), siblingToCheck: null, excluded };

  // V2.8: the product noun after the model ("MD-7 Headphones") must be what the listing is: a metal detector is never
  // the "MD-7 Headphones". A listing that does not state the noun (and is not of its category) is excluded.
  const tn = intent.targetNoun ?? null;
  const typed = family.filter((f) => {
    if (targetNounMatch(f.product, tn) !== "NO") return true;
    excluded.push({ productId: f.product.productId, title: f.product.title, reason: `not a ${tn}: the listing is another kind of product` });
    return false;
  });
  if (!typed.length) return { status: "NOT_FOUND", code: "NO_FAMILY_MATCH", reason: `No listing of the ${t!.brand ?? ""} ${t!.model ?? t!.sku} is a ${tn}.`.replace(/\s+/g, " "), siblingToCheck: null, excluded };
  // V2.13 (IW-13 token invariant): every product noun the request wrote after the model of a standalone product is
  // accounted for by the listing ("Mikra 25L Grill microwave" is never the Mikra 25L without a grill).
  if (t.kind === "STANDALONE" && t.model) for (let i = typed.length - 1; i >= 0; i--) {
    const lost = productWordsLost(typed[i]!.product, intent.requestTail ?? []);
    if (lost.length) { excluded.push({ productId: typed[i]!.product.productId, title: typed[i]!.product.title, reason: `the listing does not account for "${lost.join(" ")}" from the requested product` }); typed.splice(i, 1); }
  }
  if (!typed.length) return { status: "NOT_FOUND", code: "NO_FAMILY_MATCH", reason: `No listing accounts for every product word of the ${t!.brand ?? ""} ${t!.model} request.`.replace(/\s+/g, " "), siblingToCheck: null, excluded };
  // V2.18 (IW-18 b03/q04): one model name on products of different types ("Brace 3T" floor jack and jack stands). A
  // request that names no product type cannot say which one it means: ask, never pick the one that parses best.
  const famCats = new Set(typed.filter((f) => f.kind === "STANDALONE").map((f) => (f.product.category ?? "").toLowerCase()).filter(Boolean));
  // V2.9: compare the whole name after the model code (VariantTail.ts): every name word the request wrote must be in the
  // title, and among listings that parse to the same model, the one whose extra words the request named is the product.
  const code = modelCode(t!.model);
  if (code) {
    const reqWords = [...t!.model!.split(/\s+/).slice(code.split(/\s+/).length), ...(intent.requestTail ?? [])];
    for (let i = typed.length - 1; i >= 0; i--) {
      const miss = missingNameWords(typed[i]!.product.title, reqWords);
      if (miss.length) { excluded.push({ productId: typed[i]!.product.productId, title: typed[i]!.product.title, reason: `different model: the title does not name "${miss.join(" ")}"` }); typed.splice(i, 1); }
    }
    for (const kind of ["STANDALONE", "ACCESSORY", "BUNDLE"] as const) {
      // V2.12: a part listing the title parse took as standalone groups with the parts, not with the product it fits.
      const kindOf = (f: ProductFacts) => t.kind === "ACCESSORY" && f.kind === "STANDALONE" && !!t.accessoryNoun && partNamedAfterModel(f.product, t.accessoryNoun) ? "ACCESSORY" : f.kind;
      const group = typed.filter((f) => kindOf(f) === kind);
      const pick = pickVariant(group, (f) => f.product.title, t!.brand, code, reqWords);
      for (const d of pick.drop) { excluded.push({ productId: d.item.product.productId, title: d.item.product.title, reason: d.reason }); typed.splice(typed.indexOf(d.item), 1); }
    }
    if (!typed.length) return { status: "NOT_FOUND", code: "NO_FAMILY_MATCH", reason: `No listing is exactly the ${t!.brand ?? ""} ${t!.model}.`.replace(/\s+/g, " "), siblingToCheck: null, excluded };
  }
  // The noun names an accessory of the model when only accessory listings state it ("Delvix MD-7 Headphones").
  const nounIsAccessory = !!tn && t.kind === "STANDALONE" && typed.every((f) => f.kind === "ACCESSORY") && typed.some((f) => targetNounMatch(f.product, tn) === "YES");
  const kindOk = typed.filter((f) => {
    // V2.12: a listing the title parse took as standalone is the part when its title names the requested part noun
    // after the model ("Paddlix Tern 1 Spray Skirt" for "spray skirt for the Tern 1"); the model itself never is.
    const partTitled = t.kind === "ACCESSORY" && f.kind === "STANDALONE" && !!t.accessoryNoun && partNamedAfterModel(f.product, t.accessoryNoun);
    const ok = (f.kind === t.kind || partTitled || (nounIsAccessory && f.kind === "ACCESSORY")) && (t.kind !== "ACCESSORY" || partTitled || accessoryNounMatches(f, t.accessoryNoun));
    if (!ok) excluded.push({ productId: f.product.productId, title: f.product.title, reason: f.kind === "STANDALONE" ? `standalone product, not the requested ${t.kind.toLowerCase()}` : `${f.kind.toLowerCase()}${f.accessoryNoun ? ` (${f.accessoryNoun})` : ""}, not the requested ${t.kind === "ACCESSORY" ? t.accessoryNoun ?? "accessory" : "standalone product"}` });
    return ok;
  });
  if (!kindOk.length) return { status: "NOT_FOUND", code: "KIND_MISMATCH", reason: `Only ${[...new Set(typed.map((f) => f.kind.toLowerCase()))].join("/")} listings of this model were found; DIAPORIA never substitutes a bundle, kit or accessory for the product (or the reverse).`, siblingToCheck: null, excluded };

  const stated = AXES.filter((a) => intent.attributes[a] && !(a === "pack" && t.kind === "STANDALONE"));
  const attrOk = kindOk.filter((f) => {
    for (const a of stated) {
      const v = f.attributes[a];
      if (!v || v === "CONFLICT") { excluded.push({ productId: f.product.productId, title: f.product.title, reason: v === "CONFLICT" ? `${a} is contradictory (title vs structured variant)` : `${a} is not stated by the listing` }); return false; }
      if (!eqAttr(a, v, intent.attributes[a]!)) { excluded.push({ productId: f.product.productId, title: f.product.title, reason: `${a} is ${v}, not ${intent.attributes[a]}` }); return false; }
    }
    return true;
  });
  if (!attrOk.length) {
    // Maybe the requested variant exists but was filtered out of search (e.g. out of stock): check one sibling.
    let sibling: { productId: string; providerProductId: string; axis: string; label: string } | null = null;
    for (const f of kindOk) for (const s of f.product.research?.siblingVariants ?? []) {
      const axis = (["color", "size", "storage", "memory", "capacity", "pack"] as AttributeAxis[]).find((a) => a === s.axis.toLowerCase() || (a === "color" && /colou?r/i.test(s.axis)));
      if (axis && intent.attributes[axis] && eqAttr(axis, s.label.replace(/\s+/g, ""), intent.attributes[axis]!.replace(/\s+/g, "")) && !sibling) sibling = { productId: f.product.productId, providerProductId: String(s.providerProductId ?? ""), axis: s.axis, label: s.label };
    }
    const asked = stated.map((a) => `${a} ${intent.attributes[a]}`).join(", ");
    return { status: "NOT_FOUND", code: "ATTRIBUTE_NOT_FOUND", reason: `No listing of this model has ${asked}. Available: ${[...new Set(kindOk.map((f) => f.product.identity.variant ?? "unspecified"))].join("; ")}.`, siblingToCheck: sibling, excluded };
  }

  // N-02: several known versions (model years or generations) of this model and the request names none → ask. A listing
  // that states no version counts as a distinct, unknown version: it never resolves the ambiguity by itself.
  for (const axis of VERSION_AXES) {
    if (intent.attributes[axis]) continue;
    const values = new Map<string, ProductFacts>();
    for (const f of attrOk) { const v = f.attributes[axis] ?? "unknown"; if (!values.has(v)) values.set(v, f); }
    if (values.size > 1) {
      const label = axis === "year" ? "model years" : "generations";
      const shown = [...values.keys()].map((v) => (v === "unknown" ? `a listing that states no ${axis === "year" ? "year" : "generation"}` : axis === "year" ? v : `generation ${v}`));
      return { status: "AMBIGUOUS", differingAxes: [axis], excluded,
        options: [...values.entries()].map(([v, f]) => ({ productId: f.product.productId, identity: { ...f.product.identity, condition: intent.condition }, differing: { [axis]: v } })),
        question: `Several ${label} of this model are listed (${shown.join(", ")}). Which ${axis === "year" ? "model year" : "generation"} should be purchased?` };
    }
  }

  if (t.kind === "STANDALONE" && !tn && famCats.size > 1) {
    const reps = new Map<string, ProductFacts>(); for (const f of [...attrOk, ...typed]) { const c = (f.product.category ?? "").toLowerCase(); if (c && !reps.has(c)) reps.set(c, f); }
    return { status: "AMBIGUOUS", differingAxes: [], excluded, productTypeAmbiguous: true,
      options: [...reps.values()].map((f) => ({ productId: f.product.productId, identity: { ...f.product.identity, condition: intent.condition }, differing: {} })),
      question: `The ${t.brand ?? ""} ${t.model} name is used for different kinds of product (${[...reps.values()].map((f) => f.product.title).join("; ")}). Which one should be purchased? Name the product type.`.replace(/\s+/g, " ") };
  }
  // Condition and availability.
  const condOk: Array<{ f: ProductFacts; confirmed: boolean }> = [];
  for (const f of attrOk) {
    if (f.titleCondition && f.titleCondition !== intent.condition) { excluded.push({ productId: f.product.productId, title: f.product.title, reason: `listing is ${f.titleCondition}, requested ${intent.condition}` }); continue; }
    const offers = offersOf(f.product.productId).filter((o) => o.availability !== "OUT_OF_STOCK");
    if (!offers.length) { excluded.push({ productId: f.product.productId, title: f.product.title, reason: "no offer is in stock" }); continue; }
    const exact = offers.some((o) => o.listedIdentity.condition === intent.condition);
    const unknown = offers.some((o) => o.listedIdentity.condition === "unknown");
    if (exact) condOk.push({ f, confirmed: true });
    else if (unknown && intent.condition === "new") condOk.push({ f, confirmed: false });
    else excluded.push({ productId: f.product.productId, title: f.product.title, reason: `no ${intent.condition} offer (offers: ${[...new Set(offers.map((o) => o.listedIdentity.condition))].join(", ")})` });
  }
  if (!condOk.length) {
    const anyStock = attrOk.some((f) => offersOf(f.product.productId).some((o) => o.availability !== "OUT_OF_STOCK"));
    return anyStock ? { status: "NOT_FOUND", code: "CONDITION_NOT_OFFERED", reason: `The product exists but no ${intent.condition} offer was found.`, siblingToCheck: null, excluded }
      : { status: "NOT_FOUND", code: "UNAVAILABLE", reason: "The requested variant exists but no offer is in stock.", siblingToCheck: null, excluded };
  }

  // Group by full variant identity; listings with identical identity are the same item.
  const groups = new Map<string, Array<{ f: ProductFacts; confirmed: boolean }>>();
  for (const x of condOk) { const k = x.f.product.identity.variant ?? ""; groups.set(k, [...(groups.get(k) ?? []), x]); }
  if (groups.size > 1) {
    const reps = [...groups.values()].map((g) => g[0]!);
    const differingAxes = AXES.filter((a) => new Set(reps.map((r) => r.f.attributes[a] ?? "∅")).size > 1);
    return { status: "AMBIGUOUS", differingAxes, excluded,
      options: reps.map((r) => ({ productId: r.f.product.productId, identity: { ...r.f.product.identity, condition: intent.condition }, differing: Object.fromEntries(differingAxes.map((a) => [a, r.f.attributes[a] ?? "unknown"])) })),
      question: `Several variants match (${reps.map((r) => r.f.product.identity.variant ?? "unspecified").join(", ")}). Which ${differingAxes.join("/") || "variant"} should be purchased?` };
  }
  const g = [...groups.values()][0]!;
  // A listing that IS the requested condition (e.g. a "refurbished" product with its own SKU) beats a new listing that
  // merely carries one offer in that condition.
  g.sort((a, b) => Number(b.f.titleCondition === intent.condition) - Number(a.f.titleCondition === intent.condition) || Number(b.confirmed) - Number(a.confirmed) || offersOf(b.f.product.productId).length - offersOf(a.f.product.productId).length);
  const pick = g[0]!;
  const assumptions: string[] = [];
  if (!intent.conditionStated) assumptions.push("Condition not stated; locked to NEW. Refurbished or used offers will be rejected.");
  if (!pick.confirmed) assumptions.push("No offer states its condition; NEW is not confirmed and must be verified at the merchant.");
  // V2.8: a listing locked through the full requested name ("BM-3 HD") carries that name, so offers and quotes are
  // looked up for the requested model and never for the shorter sibling the listing's own parse produced.
  // V2.9: the same for name words the request wrote after the model ("R9 Dual") that the locked title shows after the code.
  let lockedModel = suffixMatch(pick.f) && t!.model ? t!.model : pick.f.product.identity.model;
  if (code && t!.model && t!.brand) {
    const extra: string[] = [];
    const inModel = new Set(t!.model.split(/\s+/).map((w) => w.toLowerCase()));
    for (const w of intent.requestTail ?? []) { if (!requestNameWord(w)) break; if (!inModel.has(w.toLowerCase())) extra.push(w); }
    const full = [t!.model, ...extra].join(" ");
    const fullRe = new RegExp(`(?:^|[^A-Za-z0-9])${t!.brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+${full.split(/[\s-]+/).map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[-\\s]*")}(?![A-Za-z0-9])`, "i");
    if (extra.length && fullRe.test(pick.f.product.title.normalize("NFKC"))) lockedModel = full;
  }
  return { status: "LOCKED", productId: pick.f.product.productId, identity: { ...pick.f.product.identity, model: lockedModel, condition: intent.condition }, facts: pick.f, conditionConfirmed: pick.confirmed,
    duplicates: g.slice(1).map((x) => x.f.product.productId), assumptions, excluded };
}

const PRODUCT_NOUN_WORD = new RegExp(`^(?:${PRODUCT_NOUN_PHRASES.source})$`, "i");
/** V2.13: a single word that is a product noun or names a category ("grill", "microwave", "kettle"). */
function productNoun(w: string): boolean {
  const lw = w.toLowerCase().replace(/[^a-z-]/g, "");
  return lw.length >= 3 && (PRODUCT_NOUN_WORD.test(lw) || !!requestCategory(lw));
}
/** V2.13: the word is in the title (case, plural and joined forms tolerated: "grills", "Smartwatch" for "watch"). */
function inTitle(title: string, w: string): boolean {
  const c = canon(w); if (!c) return true;
  const stems = [c, c.replace(/(?:es|s)$/, "")];
  const have = title.normalize("NFKC").split(/[\s,;:()|/–—-]+/).map(canon).filter(Boolean);
  return have.some((h) => stems.includes(h) || stems.includes(h.replace(/(?:es|s)$/, ""))) || (c.length >= 4 && canon(title).includes(stems[1]!));
}
/** V2.13 (IW-13 token invariant): the product nouns the request wrote after the model that this listing does not account for. */
export function productWordsLost(p: CatalogProduct, tail: string[]): string[] {
  return tail.filter((w) => productNoun(w) && !inTitle(p.title, w) && targetNounMatch(p, w.toLowerCase()) !== "YES");
}
