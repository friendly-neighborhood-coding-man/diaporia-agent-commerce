/**
 * Category-agnostic product identity extraction (research V2). Deterministic; no model calls.
 *
 * V1 locked a product only when its title held a mixed letter+digit token of 4–26 characters. That rejected named
 * models ("Trail Runner", "Ergo Pro", "Q5"), took capacities as models ("12-Cup"), and gave accessories the model of
 * the product they fit ("Ear Pads for CX-500" → "CX-500"). This module separates:
 *   - kind:       STANDALONE | BUNDLE (kits, multi-packs, "+ case") | ACCESSORY ("... for <product>")
 *   - model:      the model-number token when there is one, else the named model phrase after the brand
 *   - attributes: colour, memory, storage, capacity, size, pack — each a separate variant axis
 * The identity KEY (brand + model) decides "same product family"; attributes decide the variant; kind is encoded in
 * the variant string, so compareIdentity() can never treat a bundle or accessory as the standalone item.
 * Nothing here invents a SKU: Channel3 has no SKU/GTIN field (docs/research/PROVIDER_CONTRACTS.md).
 */
export type ProductKind = "STANDALONE" | "BUNDLE" | "ACCESSORY";
export type AttributeAxis = "color" | "memory" | "storage" | "capacity" | "size" | "pack" | "year" | "generation";
export type VariantAttributes = Partial<Record<AttributeAxis, string>>;
export const AXES: AttributeAxis[] = ["color", "memory", "storage", "capacity", "size", "pack", "year", "generation"];
/** Version axes (N-02): identity attributes that distinguish releases of one model, independent of the model name. */
export const VERSION_AXES: AttributeAxis[] = ["year", "generation"];

/**
 * Model year (V21-02): "(2025)", "2025 model/edition/version/release", "model year 2025", "2025년형", "'25 model", or a
 * standalone year 2005..2035 that is not money, a limit or a quantity. A year is part of the product identity.
 */
const YEAR_PATTERNS: RegExp[] = [
  /\((20[0-3]\d)\)/, /\bmodel year\s*(20[0-3]\d)\b/i, /\b(20[0-3]\d)\s*(?:model|edition|version|release|ver\.?)\b/i, /(20[0-3]\d)\s*년\s*형/, /'(\d{2})\s*(?:model|edition)\b/i,
  /(?<![\w$€£₩.,-])(20[0-3]\d)(?![\w.,%-]|\s*(?:\$|usd|eur|원|달러|mah|w\b|hours?|시간|년(?!\s*형)))/i,
];
export function modelYear(text: string): string | null {
  const t = text.normalize("NFKC");
  for (const re of YEAR_PATTERNS) {
    const m = re.exec(t);
    if (!m) continue;
    const before = t.slice(0, m.index);
    if (/(?:under|below|max(?:imum)?|up to|budget|less than|within|no more than|\$|€|£|₩)\s*$/i.test(before)) continue;
    const y = m[1]!.length === 2 ? `20${m[1]}` : m[1]!;
    if (Number(y) >= 2005 && Number(y) <= 2035) return y;
  }
  return null;
}
/** The model string without a trailing model-year token ("Drift 15 2024" → "Drift 15"; never "RX-2000" → "RX-"). */
export const stripYear = (model: string | null): string | null => model ? (model.replace(/(?:\s+\(?|\s*\()20[0-3]\d\b\)?(?:\s*(?:model|edition|version|년형))?\s*$/i, "").trim() || model) : model;

/**
 * Product generation (N-02): "(2nd Gen)", "2nd generation", "Gen 2", "second-gen", "2세대". Value is the number ("2").
 * A generation is an identity attribute like the model year, never part of the model name.
 */
const ORDINAL_WORDS: Record<string, string> = { first: "1", second: "2", third: "3", fourth: "4", fifth: "5", sixth: "6" };
const GEN_PATTERNS: RegExp[] = [/\b(\d{1,2})(?:st|nd|rd|th)[- ]?gen(?:eration)?\b/i, /\bgen(?:eration)?[- ]?(\d{1,2})\b/i, /(\d{1,2})\s*세대/,
  /\b(first|second|third|fourth|fifth|sixth)[- ]gen(?:eration)?\b/i];
export function modelGeneration(text: string): string | null {
  const t = text.normalize("NFKC");
  for (const re of GEN_PATTERNS) { const m = re.exec(t); if (m) return ORDINAL_WORDS[m[1]!.toLowerCase()] ?? String(Number(m[1])); }
  return null;
}
/** Every generation a text names (for evidence attribution). */
export function generationsIn(text: string): Set<string> {
  const out = new Set<string>(); const t = text.normalize("NFKC");
  for (const re of GEN_PATTERNS) for (const m of t.matchAll(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"))) out.add(ORDINAL_WORDS[m[1]!.toLowerCase()] ?? String(Number(m[1])));
  return out;
}
/** The model string without a trailing generation marker ("Buds 2nd Gen" → "Buds"). */
export const stripGeneration = (model: string | null): string | null => model
  ? (model.replace(/\s*\(?\s*(?:\d{1,2}(?:st|nd|rd|th)[- ]?gen(?:eration)?|gen(?:eration)?[- ]?\d{1,2}|(?:first|second|third|fourth|fifth|sixth)[- ]gen(?:eration)?|\d{1,2}\s*세대)\s*\)?\s*$/i, "").trim() || model) : model;
const stripVersion = (m: string | null) => stripYear(stripGeneration(stripYear(m)));

/** English colour words plus Korean equivalents (normalized to the English name). */
export const COLOR_WORDS: Record<string, string> = Object.fromEntries([
  ...["black", "white", "blue", "silver", "gray", "grey", "graphite", "red", "green", "pink", "beige", "midnight", "purple", "violet", "lavender", "orange",
    "yellow", "gold", "rose", "navy", "teal", "brown", "cream", "ivory", "sand", "olive", "coral", "champagne", "titanium", "starlight", "moss", "charcoal", "slate", "khaki"]
    .map((c) => [c, c[0]!.toUpperCase() + c.slice(1)]),
  ["블랙", "Black"], ["검정", "Black"], ["검은색", "Black"], ["화이트", "White"], ["흰색", "White"], ["하얀색", "White"], ["블루", "Blue"], ["파란색", "Blue"],
  ["실버", "Silver"], ["은색", "Silver"], ["그레이", "Gray"], ["회색", "Gray"], ["레드", "Red"], ["빨간색", "Red"], ["그린", "Green"], ["초록색", "Green"],
  ["핑크", "Pink"], ["분홍색", "Pink"], ["베이지", "Beige"], ["네이비", "Navy"], ["골드", "Gold"], ["퍼플", "Purple"], ["보라색", "Purple"],
]);
const GREY = (c: string) => (c === "Grey" ? "Gray" : c);

const UNIT_TOKEN = /^\d+(?:\.\d+)?(?:h|hr|hrs|hours?|gb|tb|mb|mm|cm|m|in|inch|ft|w|kw|mah|v|oz|ml|l|cup|cups|qt|lb|lbs|kg|g|k|p|hz|fps|pack|pk|ct|ports?|pcs?|pieces?|count|speeds?|slots?|outlets?|burners?|tiers?|layers?|zones?|person|seater|cups?)$/i;
/** Words that end a named-model phrase: product nouns, descriptors, connectors. */
const GENERIC = new Set(`wireless wired bluetooth noise cancelling canceling noise-cancelling noise-canceling active headphones headphone headset earbuds earbud earphones
  over-ear on-ear in-ear laptop laptops notebook computer smartphone phone cell mobile running shoes shoe sneakers boots boot hiking men's women's mens womens kids
  unisex coffee maker brewer programmable insulated water bottle tumbler flask office chair chairs gaming monitor display screen backpack daypack bag cordless stick
  vacuum cleaner robot with and for the a an in of by from to new used refurbished renewed edition version model series usb-c usb hdmi led lcd oled hd uhd
  replacement spare case cover charger adapter cable strap stand mount filter pads pad cushions cushion carafe protector bundle kit combo set pack lumbar support
  waterproof water-resistant lightweight portable smart premium classic original official stainless steel plastic glass leather mesh ergonomic compact
  e-reader e-readers ereader ereaders reader readers tv tvs television televisions speaker speakers soundbar soundbars kettle kettles blender blenders toaster
  tablet tablets camera cameras router routers keyboard keyboards mouse mice smartwatch smartwatches projector projectors printer printers drone drones
  fan fans heater heaters lamp lamps purifier purifiers humidifier humidifiers cooker cookers fryer fryers microwave dehumidifier webcam microphone mic`.split(/\s+/).filter(Boolean));
/** Generic descriptive and category words (never a model name, never a requirement on their own). */
export const GENERIC_WORDS: ReadonlySet<string> = GENERIC;
/** A word after a model mention that makes it a DIFFERENT model in the same family ("Nova 9" vs "Nova 9 Pro"). */
export const MODEL_EXTENSIONS = new Set(["pro", "max", "plus", "ultra", "mini", "lite", "air", "se", "fe", "neo", "prime", "edge", "go", "xl", "fhd", "elite", "sport", "s", "x", "ii", "iii", "iv", "2", "3", "4", "5"]);

export const ACCESSORY_NOUN = /\b(footprint|ground ?sheet|rain ?fly|brush ?kit|case|cover|sleeve|skin|charger|adapter|power supply|cable|cord|ear ?pads?|ear ?cushions?|ear ?tips|cushions?|carafe|strap|band|screen protector|protector|stand|mount|dock|filter|replacement battery|battery pack|remote|lid|brush head|bag|pouch|parts?|kit for)\b/i;
export const BUNDLE_RE = /\bw\/|\bbundle\b|\bkit\b|\bcombo\b|\b\d+[- ]?(?:pack|pk|count|ct)\b|\bpack of \d+\b|\bset of \d+\b|\btwin[- ]pack\b|\s\+\s|\bwith (?:travel |carrying |charging |protective )?(?:case|charger|stand|dock|bag)\b/i;

export function normalizeKey(s: string): string {
  return s.normalize("NFKC").toUpperCase().replace(/[^A-Z0-9가-힣]/g, "");
}
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Variant attributes stated in a title or a request. Values are canonical ("256GB", "32 oz", "10.5", "12 cup", "2"). */
export function parseAttributes(text: string): VariantAttributes {
  const t = text.normalize("NFKC");
  const out: VariantAttributes = {};
  const lower = t.toLowerCase();
  for (const [w, c] of Object.entries(COLOR_WORDS)) {
    // V2.6: "블랙박스" (dash cam) is not the colour 블랙: a Korean colour word is followed by a particle, 색 or a non-Hangul char.
    const re = /[가-힣]/.test(w) ? new RegExp(`${escapeRe(w)}(?![가-힣])|${escapeRe(w)}(?=(?:색상?|컬러|은|는|이|가|을|를|으로|로|의|도|만)(?![가-힣]))`) : new RegExp(`\\b${escapeRe(w)}\\b`, "i");
    if (re.test(lower)) { out.color = GREY(c); break; }
  }
  for (const m of t.matchAll(/(\d+(?:\.\d+)?)\s?(GB|TB)\b(\s*(?:of\s+)?(RAM|memory|unified memory|SSD|storage|HDD|eMMC))?/gi)) {
    // V2.3: "10 Gb Ethernet", "2.5GbE" are network speeds (gigabits), not memory or storage.
    if (/^[GT]b$/.test(m[2]!) || /^\s*(?:e\b|ethernet|lan|wan|ports?|sfp|bps|it\b|\/s)/i.test(t.slice(m.index! + m[0].length))) continue;
    const val = `${m[1]}${m[2]!.toUpperCase()}`;
    const ctx = (m[4] ?? "").toLowerCase();
    const axis: AttributeAxis = /ram|memory/.test(ctx) ? "memory" : /ssd|storage|hdd|emmc/.test(ctx) ? "storage"
      : m[2]!.toUpperCase() === "TB" || Number(m[1]) >= 64 ? "storage" : "memory";
    if (!out[axis]) out[axis] = val;
  }
  const cap = /(\d+(?:\.\d+)?)\s?-?\s?(fl\.? ?oz|oz|ounces?|ml|l|liters?|litres?|cups?|qt|quarts?)\b/i.exec(t);
  if (cap) {
    const u = cap[2]!.toLowerCase().replace(/\s|\./g, "");
    const unit = /^(floz|oz|ounce|ounces)$/.test(u) ? "oz" : /^ml$/.test(u) ? "ml" : /^(l|liter|liters|litre|litres)$/.test(u) ? "L" : /^cups?$/.test(u) ? "cup" : "qt";
    out.capacity = `${cap[1]} ${unit}`;
  }
  const size = /\b(?:size|sz|사이즈)\s*:?\s*(\d+(?:\.\d+)?|xxs|xs|s|m|l|xl|xxl|xxxl|small|medium|large|x-large)\b/i.exec(t) ?? /사이즈\s*(\d+(?:\.\d+)?)/.exec(t);
  if (size) out.size = size[1]!.toUpperCase().replace(/^SMALL$/, "S").replace(/^MEDIUM$/, "M").replace(/^LARGE$/, "L").replace(/^X-LARGE$/, "XL");
  else {
    const inch = /(?<![\d.])(\d{2}(?:\.\d)?)\s?(?:-?\s?inch(?:es)?\b|"|”|-in\b|인치)/i.exec(t);
    if (inch) out.size = `${inch[1]} in`;
  }
  const year = modelYear(t);
  if (year) out.year = year;
  const gen = modelGeneration(t);
  if (gen) out.generation = gen;
  const pack = /\b(\d+)[- ]?(?:pack|pk|count|ct)\b|\bpack of (\d+)\b|\bset of (\d+)\b|\b(twin)[- ]pack\b|(\d+)\s?개입/i.exec(t);
  if (pack) out.pack = pack[4] ? "2" : (pack[1] ?? pack[2] ?? pack[3] ?? pack[5])!;
  return out;
}

/** Canonical variant string: axes in a fixed order. Colour-only keeps the V1 form ("Black"). */
export function canonicalVariant(attrs: VariantAttributes, kind: ProductKind = "STANDALONE", accessoryNoun?: string | null): string | null {
  const parts = AXES.filter((a) => attrs[a] && a !== "pack").map((a) => (a === "color" ? attrs[a]! : `${a}=${attrs[a]}`));
  if (attrs.pack && attrs.pack !== "1") parts.push(`pack=${attrs.pack}`);
  const base = parts.length ? parts.join(" / ") : null;
  if (kind === "BUNDLE") return `${base ?? "UNSPECIFIED"} BUNDLE`;
  if (kind === "ACCESSORY") return `ACCESSORY ${accessoryNoun ?? "UNSPECIFIED"}${base ? ` / ${base}` : ""}`;
  return base;
}
export function attributesFromVariant(variant: string | null): VariantAttributes {
  const out: VariantAttributes = {};
  if (!variant) return out;
  for (const part of variant.replace(/ BUNDLE$/, "").replace(/^ACCESSORY [^/]*\/?\s*/, "").split(" / ")) {
    const m = /^(memory|storage|capacity|size|pack|year|generation)=(.+)$/.exec(part.trim());
    if (m) out[m[1] as AttributeAxis] = m[2]!; else if (part.trim() && part.trim() !== "UNSPECIFIED") out.color = part.trim();
  }
  return out;
}

/** The model-number token: letters and digits mixed (CX-500, WH-1000XM5, NW-200, Q5, S7), never a unit ("12-Cup", "32GB"). */
export function modelNumberToken(text: string): string | null {
  const tokens = text.normalize("NFKC").match(/\b[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)*\b/g) ?? [];
  const ok = tokens.filter((raw) => {
    const t = raw.replace(/[-_]/g, "");
    if (UNIT_TOKEN.test(t) || UNIT_TOKEN.test(raw)) return false;
    if (raw.split(/[-_]/).some((p) => UNIT_TOKEN.test(p)) && !/[A-Za-z]{2,}\d/.test(t)) return false;
    return t.length >= 2 && t.length <= 26 && /[A-Za-z]/.test(t) && /\d/.test(t) && (t.length >= 4 || /^[A-Za-z]{1,2}\d{1,3}$/.test(t));
  });
  return ok.sort((a, b) => b.replace(/[-_]/g, "").length - a.replace(/[-_]/g, "").length)[0]?.toUpperCase() ?? null;
}

export interface ExtractedIdentity {
  brand: string | null;
  /** Model phrase ("CX-500", "Trail Runner", "Nova 9 Pro"). For accessories: the model of the product it fits. */
  model: string | null;
  modelBasis: "MODEL_NUMBER" | "NAMED_MODEL" | "NONE";
  kind: ProductKind;
  accessoryNoun: string | null;
  attributes: VariantAttributes;
  /** Condition stated by the title itself ("Renewed", "Refurbished", "Used"), else null. */
  titleCondition: "refurbished" | "used" | "open_box" | null;
  /** V2.3: for a third-party accessory, the brand of the product it fits ("Pagewise" in "Foldo Cover for Pagewise Glow"). */
  fitsBrand?: string | null;
}

/**
 * Product nouns, single and multi-word ("air purifier", "power bank", "hiking boots", "drill"). V2.2 WP-3 (H-3): a
 * named-model phrase ends where a product noun phrase starts, so "Ostra AP-400 air purifier" keeps model "AP-400",
 * never "AP-400 air". Also used by requirement extraction (capabilities.ts re-exports it).
 */
export const PRODUCT_NOUN_PHRASES = /\b(?:rain jackets?|rain coats?|shell jackets?|puffer jackets?|coffee grinders?|burr grinders?|wi-?fi routers?|jackets?|coats?|grinders?|tents?|sleeping bags?|duffel bags?|rice cookers?|air conditioners?|air mattress(?:es)?|robot vacuums?|robot mops?|cordless drills?|drill drivers?|impact drivers?|power drills?|stand mixers?|hand mixers?|espresso machines?|dish ?washers?|washing machines?|space heaters?|electric toothbrush(?:es)?|toothbrush(?:es)?|standing desks?|gaming chairs?|smart speakers?|bluetooth speakers?|portable chargers?|wireless chargers?|travel backpacks?|dash ?cams?|baby monitors?|security cameras?|action cameras?|label makers?|sewing machines?|drills?|sanders?|saws?|mixers?|grills?|ovens?|irons?|scales?|thermostats?|doorbells?|pressure cookers?|slow cookers?|electric kettles?|air purifiers?|air fryers?|power banks?|hair dryers?|coffee (?:makers?|machines?|brewers?)|water bottles?|office chairs?|vacuum cleaners?|stick vacuums?|running shoes?|hiking boots?|e-?readers?|smart ?watch(?:es)?|sound ?bars?|head ?phones?|ear ?buds?|ear ?phones?|headsets?|laptops?|notebooks?|smartphones?|phones?|monitors?|displays?|backpacks?|daypacks?|chairs?|vacuums?|bottles?|tumblers?|flasks?|boots?|shoes?|sneakers?|tvs?|televisions?|speakers?|kettles?|blenders?|toasters?|tablets?|cameras?|routers?|keyboards?|mice|mouse|projectors?|printers?|drones?|fans?|heaters?|lamps?|purifiers?|humidifiers?|dehumidifiers?|cookers?|fryers?|microwaves?|webcams?|microphones?|chargers?|cases?|sleeves?|cables?|adapters?|stands?|blankets?|throws?|desks?|tables?|sofas?|bikes?|strollers?|toys?|watch(?:es)?)\b/i;
const NOUN_PHRASE_AT_START = new RegExp(`^(?:(?:charging|replacement|spare|protective|carrying|travel)\\s+)?(?:${PRODUCT_NOUN_PHRASES.source.replace(/^\\b\(\?:/, "").replace(/\)\\b$/, "")}|${ACCESSORY_NOUN.source.replace(/^\\b\(/, "").replace(/\)\\b$/, "")})(?=[^A-Za-z0-9]|$)`, "i");
/** A product noun followed by a model token is part of the model ("Galaxy Watch 6", "Surface Laptop 5"). */
const MODELISH_NEXT = /^(?:\d[\w.-]*|[A-Za-z]{0,3}\d[\w-]*|pro|max|plus|ultra|mini|lite|se|xl|gen\d*|mk\w*|series)$/i;
/** "STOP": a product/accessory noun phrase starts here and ends the model; "MODEL": noun + model token, part of the model. */
const nounPhraseAt = (rest: string[]): "STOP" | "MODEL" | null => {
  const m = NOUN_PHRASE_AT_START.exec(rest.join(" "));
  if (!m) return null;
  const after = (rest.join(" ").slice(m[0].length).trim().split(/\s+/)[0] ?? "").replace(/[,;:()|]+$/, "");
  return MODELISH_NEXT.test(after) && !UNIT_TOKEN.test(after) && !/^\d+[- ]?(?:pack|pk|count|ct)$/i.test(after) && m[0].split(/\s+/).length === 1 ? "MODEL" : "STOP";
};

/**
 * V2.7 (identity fails closed): in a REQUEST, every capitalized or upper-case token right after the model number is
 * part of the name the user gave ("Orbit 90 EQ", "TC-20 LTE", "AF-55 Duo", "P20 GaN"), unless it is provably not a
 * name token: a generic product/feature word written as such, a colour, a unit, an accessory or part noun, or a
 * descriptive adjective ("Mechanical", "Backpacking"). A candidate must then show the whole name; when unsure the
 * candidate is a mismatch, never the base model.
 */
function requestNameToken(w: string): boolean {
  if (!/^[A-Z][A-Za-z0-9+]{0,11}$/.test(w)) return false;
  const lw = w.toLowerCase();
  if (COLOR_WORDS[lw] || UNIT_TOKEN.test(w) || ACCESSORY_NOUN.test(w) || new RegExp(`^(?:${PART_NOUN.source})$`, "i").test(w)) return false;
  if (/^[A-Z][a-z]+$/.test(w) && (GENERIC.has(lw) || /(?:ing|ed|al|ic|ive|ous|less|proof|able|ible|ful|er|est|ly)$/.test(lw))) return false;
  return true;
}
/** V2.5: "Duo" in "AF-55 Duo" / "AF-55 Duo, 5.5 L"; not "Backpacking", "Mechanical", "Footprint", "Black", "Wireless". */
function siblingSuffix(w: string, raw: string, next: string[], request: boolean): boolean {
  // V2.7: an upper-case code after the model number ("Orbit 90 EQ", "TC-20 LTE") is a name token in a listing too:
  // product nouns in titles are capitalized words, never codes. Descriptive codes (IH, GaN, ANC, ...) are trimmed later.
  if (/^[A-Z][A-Z0-9+]{1,4}$/.test(w) && !UNIT_TOKEN.test(w) && !DESCRIPTIVE_CODE.test(w)) return true;
  if (!/^[A-Z][a-z]{1,9}$/.test(w)) return false;
  const lw = w.toLowerCase();
  if (GENERIC.has(lw) || COLOR_WORDS[lw] || UNIT_TOKEN.test(w) || ACCESSORY_NOUN.test(w) || new RegExp(`^(?:${PART_NOUN.source})$`, "i").test(w)
    || /(?:ing|ed|al|ic|ive|ous|less|proof|able|ible|ful|er|est|ly)$/.test(lw)) return false;
  // At the end of a request it is the name's last word ("Cindra AF-55 Duo"); at the end of a listing title it is
  // usually the product noun ("Vista 8x42 Binoculars"), so a title takes it only before punctuation or a lowercase word.
  if (next.length === 0) return request;
  if (/[,;:()|]$/.test(raw)) return true;
  const n = next[0]!;
  if (/^[,;:()|/–—+&-]/.test(n) || /^[a-z가-힣]/.test(n)) return true;
  // A capitalized word before a product noun is ambiguous ("Duo Air Fryer" vs "Pressure Rice Cooker"): not taken.
  return false;
}

/** Named model phrase: words after the brand up to the first generic word, product noun, attribute or punctuation (max 4 words). */
export function namedModelAfter(text: string, brand: string | null, request = false): string | null {
  const t = text.normalize("NFKC");
  let rest = t;
  if (brand) {
    const m = new RegExp(`(?:^|[^A-Za-z0-9])${escapeRe(brand)}(?:'s)?(?=[^A-Za-z0-9]|$)`, "i").exec(t);
    if (!m) return null;
    rest = t.slice(m.index + m[0].length);
  }
  const words: string[] = [];
  const parts = rest.split(/\s+/).filter(Boolean);
  for (const [i, raw] of parts.entries()) {
    if (/^[,;:()|/–—+&-]/.test(raw)) break;
    // V2.2 WP-3: a product noun phrase starting here ends the model ("AP-400 air purifier", "T18 drill").
    const np = nounPhraseAt(parts.slice(i));
    if (words.length && np === "STOP") break;
    // Attribute phrases end the model: "size 10.5", "32 oz", "2-pack", "12 cup" (requests rarely have commas).
    if (/^(size|sz|사이즈)$/i.test(raw) || /^\d+[- ]?(pack|pk|count|ct)$/i.test(raw)) break;
    if (/^\d+(?:\.\d+)?$/.test(raw) && /^(oz|fl|ounces?|cups?|gb|tb|inch|in|ml|l|liters?|qt|pack|pk|-pack|hours?|h)\b/i.test(parts[i + 1] ?? "")) break;
    const w = raw.replace(/[,;:()|]+$/, "");
    const stop = /[,;:()|]$/.test(raw);
    const lw = w.toLowerCase().replace(/[’']s$/, "'s");
    // V2.4: once the name has its number ("Ridge 2", "K75", "RV-8"), only a family extension ("Pro", "Lite", "Gen 2")
    // or another number continues it. A descriptive or accessory word after it ("Ridge 2 Backpacking Tent", "K75 Lite
    // Mechanical Keyboard", "Ridge 2 Footprint") is not part of the model.
    // V2.5: a sibling suffix ("AF-55 Duo", "Hush 2 Trio") is part of the model: one capitalized, non-descriptive word
    // that ends the name (end of text, punctuation or a lowercase word after it).
    if (words.some((x) => /\d/.test(x)) && !/\d/.test(w) && !isModelExtension(lw) && !(request ? requestNameToken(w) : siblingSuffix(w, raw, parts.slice(i + 1), request))) break;
    if (words.length && np === "MODEL") { words.push(w); if (stop || words.length >= 4) break; continue; }
    // V2.3: in a request, an all-lowercase word after a capitalized name ends it ("Nordvik Summit tent" → Summit).
    if (words.length && /^[a-z][a-z-]*$/.test(w) && words.every((x) => /^[A-Z0-9]/.test(x))) break;
    // V2.8: in a request, an upper-case code after the model number ("BM-3 HD", "TC-20 LED") is part of the name the
    // user typed, even when the same word is a generic descriptor elsewhere. Identity then fails closed on it.
    const codeInRequest = request && words.some((x) => /\d/.test(x)) && /^[A-Z][A-Z0-9+]{1,4}$/.test(w) && !UNIT_TOKEN.test(w);
    if (!w || (!codeInRequest && (GENERIC.has(lw) || GENERIC.has(lw.replace(/'s$/, "")))) || UNIT_TOKEN.test(w) || /^\d+(?:\.\d+)?-?(?:cup|oz|inch|in|gb|tb|l|ml)$/i.test(w)
      || COLOR_WORDS[lw] || /[가-힣]/.test(w)) break;
    words.push(w);
    if (stop || words.length >= 4) break;
  }
  // V2.7: a greeting, pronoun or request word is never a model name ("Hi", "I'm", "Please", "Could").
  if (words.length && NOT_A_NAME.test(words[0]!)) return null;
  return words.length ? words.join(" ") : null;
}
const NOT_A_NAME = /^(?:hi|hello|hey|thanks|thank|please|i|i'?m|i’m|i'?d|i’d|i'?ve|we|we'?re|you|my|our|me|us|it|this|that|could|would|can|will|should|looking|get|buy|order|find|need|want|yes|no|ok|okay)$/i;

const DESCRIPTIVE_CODE = /^(?:HD|FHD|UHD|QHD|RGB|TWS|USB|LED|LCD|OLED|ANC|ENC|NFC|BT|DC|AC|UV|HEPA|IPS|HDR|PD)$/;
const TECH_SUFFIX = /^(?:IH|GaN|PD|ANC|ENC|OLED|QLED|IPS|HDR|HDR10|Wi-?Fi|BT|NFC|USB-?C|LED|LCD|DC|AC|UV|HEPA|IPX?\d|IP\d\d)$/;
export function extractIdentity(title: string, brand: string | null, opts: { request?: boolean } = {}): ExtractedIdentity {
  const t = title.normalize("NFKC").replace(/\s+/g, " ").trim();
  const attributes = parseAttributes(t);
  const titleCondition = /\b(renewed|refurbished|reconditioned|refurb)\b/i.test(t) ? "refurbished" : /\bopen[- ]box\b/i.test(t) ? "open_box" : /\b(used|pre-?owned)\b/i.test(t) ? "used" : null;
  // Accessory: "<accessory noun> ... for <product>" or "Replacement ...". The model is the TARGET product's model.
  const forIdx = t.search(/\b(?:for|compatible with|fits)\b/i);
  const head = forIdx > 0 ? t.slice(0, forIdx) : t;
  const nounMatch = ACCESSORY_NOUN.exec(head);
  const isAccessory = forIdx > 0 && (!!nounMatch || /^(replacement|spare)\b/i.test(t));
  if (isAccessory) {
    const target = t.slice(forIdx).replace(/^(?:for|compatible with|fits)\s+(?:the\s+)?/i, "");
    const tb = brand && new RegExp(`\\b${escapeRe(brand)}\\b`, "i").test(target) ? brand : null;
    // V2.2 WP-3: "Kova Pulse watch band for my wife": a "for" phrase without the brand or a model number names a
    // person or use, not the product the accessory fits; the model is then the one before the accessory noun.
    // V2.3 (V22-07 i13): a third-party accessory names the product it fits by that product's own brand and model
    // ("Foldo Cover for Pagewise Glow (3rd Gen)"): two capitalized name words after "for" (not "for my wife").
    const fitsName = !tb && /^([A-Z][A-Za-z0-9&'-]+)\s+(?:[A-Z0-9][\w-]*)/.exec(target);
    const fitsBrand = fitsName && !GENERIC.has(fitsName[1]!.toLowerCase()) ? fitsName[1]! : null;
    const targetNamesProduct = !!tb || !!modelNumberToken(target) || !!fitsBrand;
    const src = targetNamesProduct ? target : head;
    const srcBrand = targetNamesProduct ? (tb ?? fitsBrand) : (brand && new RegExp(`\\b${escapeRe(brand)}\\b`, "i").test(head) ? brand : null);
    const num = modelNumberToken(src);
    const named = namedModelAfter(src, srcBrand, !!opts.request);
    const noun = (nounMatch?.[1] ?? "part").toLowerCase().replace(/\s+/g, " ").replace(/s$/, "");
    const tAttr = parseAttributes(target);
    return { brand, model: stripVersion(num ?? named), modelBasis: num ? "MODEL_NUMBER" : named ? "NAMED_MODEL" : "NONE", kind: "ACCESSORY", accessoryNoun: noun,
      attributes: { ...parseAttributes(head), ...(tAttr.capacity ? { capacity: tAttr.capacity } : {}), ...(tAttr.generation ? { generation: tAttr.generation } : {}) }, titleCondition,
      fitsBrand: targetNamesProduct && fitsBrand && (!brand || fitsBrand.toLowerCase() !== brand.toLowerCase()) ? fitsBrand : null };
  }
  let kind: ProductKind = BUNDLE_RE.test(t) || (attributes.pack !== undefined && attributes.pack !== "1") ? "BUNDLE" : "STANDALONE";
  const num = modelNumberToken(t.replace(/\(.*?\)/g, " "));
  let named = namedModelAfter(t, brand && new RegExp(`\\b${escapeRe(brand)}\\b`, "i").test(t) ? brand : null, !!opts.request);
  // V2.3 (V22-07): a technology acronym written after a model number describes it, it is not part of the model
  // ("HR-6 IH rice cooker" is the HR-6; "P20 GaN charger" is the P20). Family extensions (Pro, Max, Gen 2) still are.
  // V2.7: in a request the user's own name tokens are never trimmed ("P20 GaN" stays; the title check decides).
  if (named && num && !opts.request) {
    const ws = named.split(" ");
    if (normalizeKey(ws[0]!) === normalizeKey(num)) { const k = ws.findIndex((w, i) => i > 0 && TECH_SUFFIX.test(w)); if (k > 0) named = ws.slice(0, k).join(" "); }
  }
  let model: string | null = null; let basis: ExtractedIdentity["modelBasis"] = "NONE";
  if (num) {
    // A model number inside the named phrase keeps the family words ("Sweep S7", "View 27 4K" stays named).
    model = named && normalizeKey(named).includes(normalizeKey(num)) ? named : num; basis = "MODEL_NUMBER";
    if (named && normalizeKey(named).includes(normalizeKey(num)) && named.split(" ").length > 1) basis = "NAMED_MODEL";
  } else if (named) { model = named; basis = "NAMED_MODEL"; }
  const stripped = stripVersion(model);
  // V2.2 WP-3: "AP-400 Gen 2" is model number AP-400 plus generation 2 (an attribute), not a named model.
  if (basis === "NAMED_MODEL" && num && stripped && normalizeKey(stripped) === normalizeKey(num)) basis = "MODEL_NUMBER";
  // V2.4: a part named right after the model ("Hush 2 Replacement Ear Tips", "Ridge 2 Footprint", "P7 Replacement Brush
  // Heads, 4-Pack") is an accessory of that model, never the model itself, even without "for".
  let accessoryNoun: string | null = null;
  if (stripped) {
    const at = t.toLowerCase().indexOf(stripped.toLowerCase());
    const tail = at >= 0 ? t.slice(at + stripped.length).split(/[,(]|\s\+\s|\s+(?:with|for)\s/i)[0]!.trim() : "";
    const part = new RegExp(`(?:^|\\s)(${PART_NOUN.source})s?$`, "i").exec(tail);
    if (tail && (/^(?:replacement|spare)\b/i.test(tail) || part)) { kind = "ACCESSORY"; accessoryNoun = (part?.[1] ?? ACCESSORY_NOUN.exec(tail)?.[1] ?? "part").toLowerCase().replace(/\s+/g, " ").replace(/s$/, ""); }
  }
  return { brand, model: stripped, modelBasis: basis, kind, accessoryNoun, attributes, titleCondition };
}
/** Parts and consumables that only exist for another product (never a standalone product of their own). */
export const PART_NOUN = /footprint|ground ?sheet|rain ?fly|ear ?tips?|ear ?pads?|ear ?cushions?|brush ?heads?|brush ?kit|side ?brush(?:es)?|mop ?pads?|dust ?bags?|filters?|refills?|cartridges?|nozzles?|attachments?|replacement parts?|spare parts?/;

/**
 * Version / generation / tier suffixes that make a different model (V2.1): "Gen 2", "(2nd Gen)", "Mk II", "Mark II",
 * "V2", "2nd generation", and Hangul tiers ("프로", "2세대"). A Hangul particle ("CX-500은") is not a suffix.
 */
const VERSION_SUFFIX = /^(?:gen\d*|generation|mk\d*|mkii+|mark|v\d+|\d+(?:st|nd|rd|th)|(?:\d+세대|세대|프로|맥스|플러스|울트라|미니|라이트|에어|엣지|신형)(?:는|은|의|가|이|를|을|와|과|도|에서|에|로)?)$/;
export const isModelExtension = (token: string) => MODEL_EXTENSIONS.has(token) || VERSION_SUFFIX.test(token);

/** Identity key: brand + model, separator- and case-insensitive. Equal keys = same product family. */
export function familyKey(brand: string | null, model: string | null): string {
  return normalizeKey(`${brand ?? ""}${model ?? ""}`);
}

/**
 * True when `text` mentions exactly this model: separator-tolerant, and not followed by a family extension
 * ("Nova 9" does not match "Nova 9 Pro"; "CX-500" does not match "CX-5000").
 */
export function mentionsExactModel(text: string, model: string, own: { generation?: string | null } = {}): boolean {
  const body = model.replace(/[^A-Za-z0-9]/g, "").split("").map((ch) => escapeRe(ch)).join("[- ]?");
  if (!body) return false;
  const re = new RegExp(`(^|[^A-Za-z0-9])${body}(?=$|[^A-Za-z0-9])`, "gi");
  const ownWords = new Set(model.toLowerCase().split(/[^a-z0-9]+/));
  for (const m of text.matchAll(re)) {
    const after = text.slice((m.index ?? 0) + m[0].length).trimStart();
    const next = /^[-\s(]*([A-Za-z0-9가-힣]+)/.exec(after)?.[1]?.toLowerCase();
    // N-02: this product's own generation marker right after the model ("Buds (2nd Gen)" for generation 2) is not a
    // different model; any other generation marker is.
    if (next && own.generation && modelGeneration(after.slice(0, 24).replace(/^[-\s(]*/, "")) === own.generation && /^[-\s(]*(?:\d{1,2}(?:st|nd|rd|th)|gen|generation|first|second|third|fourth|fifth|sixth|\d{1,2}\s*세대)/i.test(after)) return true;
    // V2.5: "Air" in "AF-55 Duo Air Fryer" starts the product noun, it is not the "Air" model extension.
    if (next && isModelExtension(next) && !ownWords.has(next) && nounPhraseAt(after.split(/\s+/).filter(Boolean)) !== "STOP") continue;
    // V2.7: an upper-case name code right after the model ("Glide 5 GTX", "Orbit 90 EQ") names a sibling model.
    const rawNext = /^[\s(]*([A-Za-z0-9+]+)/.exec(after)?.[1] ?? "";
    if (rawNext && !ownWords.has(rawNext.toLowerCase()) && /^[A-Z][A-Z0-9+]{1,4}$/.test(rawNext) && !UNIT_TOKEN.test(rawNext) && !DESCRIPTIVE_CODE.test(rawNext) && !TECH_SUFFIX.test(rawNext)) continue;
    return true;
  }
  return false;
}
