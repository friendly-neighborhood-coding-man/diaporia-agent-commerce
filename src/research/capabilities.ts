/**
 * Research V2 lexicon: capabilities and product categories, English and Korean. Deterministic text rules only.
 *
 * A capability id is stable and language-neutral ("waterproof", "battery_40h"). Numeric capabilities carry their
 * threshold in the id ("battery_<N>h", "keeps_cold_<N>h") so the same rule serves every category and value.
 * Request patterns decide what the USER asked for; statement patterns decide what a SOURCE says. They are separate
 * on purpose: a request word is never evidence.
 */

export interface CapabilitySpec {
  id: string;
  /** English phrase used in provider queries (Channel3 has no Korean locale; Tavily works best in English). */
  phrase: string;
  /** Request patterns (English + Korean). */
  request: RegExp;
  /** Statement keyword: a clause must contain this to say anything about the capability. */
  statement: RegExp;
  /** Statement patterns that mean the capability is ABSENT even without a generic negator ("wired only", "1080p"). */
  absent?: RegExp;
}

const NEG = String.raw`(?:no|not|non|never|lacks?|lacking|without|isn't|is not|aren't|are not|doesn't|does not|don't|do not|can't|cannot|won't)`;

export const CAPABILITIES: CapabilitySpec[] = [
  { id: "active_noise_cancellation", phrase: "active noise cancelling", request: /noise[- ]?cancel(?:l)?(?:ing|ation|er)?|\banc\b|노이즈\s*캔슬링|노이즈캔슬링|노캔/i,
    statement: /\b(?:active\s+)?noise[- ]?cancel(?:l)?(?:ing|ation)\b|\banc\b/i, absent: /\bpassive (?:isolation|noise isolation) only\b/i },
  { id: "wireless", phrase: "wireless bluetooth", request: /\bwireless\b|\bbluetooth\b|무선|블루투스/i, statement: /\bwireless\b|\bbluetooth\b/i, absent: /\bwired[- ]only\b|\bwired only\b/i },
  { id: "multipoint", phrase: "multipoint", request: /multi-?point|멀티\s*포인트/i, statement: /\bmulti-?point\b|\btwo devices at once\b/i },
  { id: "over_ear", phrase: "over-ear", request: /over[- ]ear|오버\s*이어/i, statement: /\bover[- ]ear\b/i, absent: /\b(?:on|in)[- ]ear (?:design|only)\b/i },
  { id: "waterproof", phrase: "waterproof", request: /water\s?proof|water[- ]resistant|방수/i, statement: /\bwater\s?proof\b|\bwater[- ]resistant\b|\bip6[78]\b/i },
  { id: "usb_c_charging", phrase: "usb-c charging", request: /usb[- ]?c\s+(?:charging|charge|power)|charg\w*\s+(?:via|over|by)\s+usb[- ]?c|usb[- ]?c\s*충전/i,
    statement: /\busb[- ]?c\b[^.;]{0,40}\b(?:charg\w*|power delivery)\b|\bcharg\w*\b[^.;]{0,30}\busb[- ]?c\b/i },
  { id: "backlit_keyboard", phrase: "backlit keyboard", request: /backlit|keyboard backlight|백라이트/i, statement: /\bbacklit keyboard\b|\bkeyboard backlight(?:ing)?\b/i },
  { id: "programmable", phrase: "programmable timer", request: /\bprogrammable\b|예약\s*기능/i, statement: /\bprogrammable\b/i },
  { id: "thermal_carafe", phrase: "thermal carafe", request: /thermal carafe|보온\s*(?:포트|카라페|서버)/i, statement: /\bthermal carafe\b/i },
  { id: "dishwasher_safe", phrase: "dishwasher safe", request: /dishwasher|식기\s*세척기/i, statement: /\bdishwasher(?:[- ]safe)?\b/i, absent: /\bhand[- ]wash only\b/i },
  { id: "lumbar_support", phrase: "lumbar support", request: /lumbar|요추|허리\s*지지/i, statement: /\blumbar(?: support)?\b/i },
  { id: "adjustable_armrests", phrase: "adjustable armrests", request: /arm\s?rests?|팔걸이/i, statement: /\badjustable arm\s?rests?\b|\b\dd arm\s?rests?\b/i, absent: /\bfixed arm\s?rests\b/i },
  { id: "4k_resolution", phrase: "4K resolution", request: /\b4k\b|\buhd\b|2160p|4k\s*해상도/i, statement: /\b4k\b|\buhd\b|3840\s?x\s?2160|2160p/i, absent: /\b(?:1080p|full hd|fhd)\b(?![^.;]*\b4k\b)/i },
  { id: "cordless", phrase: "cordless", request: /\bcordless\b|무선\s*청소기/i, statement: /\bcordless\b/i, absent: /\bcorded only\b/i },
  { id: "hepa_filter", phrase: "HEPA filter", request: /\bhepa\b|헤파/i, statement: /\bhepa\b/i },
];
const BY_ID = new Map(CAPABILITIES.map((c) => [c.id, c]));

/** Numeric capability families. `<N>` is the user's threshold; a statement value ≥ N satisfies it. */
export const NUMERIC_FAMILIES = [
  { family: "battery", idOf: (n: number) => `battery_${n}h`, phrase: "battery life hours",
    request: [/(\d{1,3})\s*\+?\s*-?\s*(?:hours?|hrs?|h)\b(?:\s+(?:of\s+)?(?:battery|playback|playtime))/i, /battery(?:\s+life)?\s+(?:of\s+)?(?:at\s+least\s+|over\s+|more than\s+)?(\d{1,3})\s*\+?\s*(?:hours?|hrs?|h)\b/i,
      /배터리\s*(\d{1,3})\s*시간/, /(\d{1,3})\s*시간\s*(?:이상\s*)?배터리/],
    statement: /\bbattery\b|\bplayback\b|\bplaytime\b/i, value: /(\d{1,3}(?:\.\d)?)\s*(?:hours?|hrs?|h)\b/i },
  { family: "keeps_cold", idOf: (n: number) => `keeps_cold_${n}h`, phrase: "keeps cold hours",
    request: [/cold\s+(?:for\s+)?(?:up to\s+)?(\d{1,3})\s*(?:hours?|hrs?|h)\b/i, /(\d{1,3})[- ]?(?:hours?|hrs?|h)\s+cold\b/i, /(\d{1,3})\s*시간\s*보냉/],
    statement: /\bcold\b|\bice\b/i, value: /(\d{1,3})\s*(?:hours?|hrs?|h)\b/i },
] as const;

export function numericSpec(id: string): { family: (typeof NUMERIC_FAMILIES)[number]; threshold: number } | null {
  const m = /^(battery|keeps_cold)_(\d{1,3})h$/.exec(id);
  if (!m) return null;
  const family = NUMERIC_FAMILIES.find((f) => f.family === m[1])!;
  return { family, threshold: Number(m[2]) };
}

export function capabilityPhrase(id: string): string {
  const n = numericSpec(id);
  if (n) return n.family.family === "battery" ? `battery life ${n.threshold} hours` : `keeps cold ${n.threshold} hours`;
  return BY_ID.get(id)?.phrase ?? id.replace(/_/g, " ");
}
export function capabilitySpec(id: string): CapabilitySpec | null { return BY_ID.get(id) ?? null; }

/** Capabilities mentioned in a request fragment, with their character spans (so model-name words can be excluded). */
export function requestCapabilities(text: string): Array<{ id: string; index: number; end: number }> {
  const out: Array<{ id: string; index: number; end: number }> = [];
  for (const c of CAPABILITIES) {
    const m = new RegExp(c.request.source, c.request.flags.replace("g", "") + "g").exec(text);
    if (m) out.push({ id: c.id, index: m.index, end: m.index + m[0].length });
  }
  for (const f of NUMERIC_FAMILIES) for (const re of f.request) {
    const m = re.exec(text);
    if (m) { out.push({ id: f.idOf(Number(m[1])), index: m.index, end: m.index + m[0].length }); break; }
  }
  // "cordless vacuum" (Korean 무선 청소기) is cordless, not "wireless".
  if (out.some((x) => x.id === "cordless")) return out.filter((x) => x.id !== "wireless" || !/무선\s*청소기/.test(text));
  return out;
}

/**
 * What one clause of a source says about a capability: true, false, or null (silent). Explicit statements only.
 * Negation must govern the capability phrase ("no HEPA filter", "not 4K", "does not keep drinks cold"), so a
 * comparative ("not as strong as") is not a denial.
 */
export function clauseStatement(clause: string, id: string): boolean | null {
  const n = numericSpec(id);
  if (n) {
    if (!n.family.statement.test(clause)) return null;
    const negated = new RegExp(`\\b${NEG}\\b[^.;]{0,25}(?:${n.family.statement.source})`, "i").test(clause)
      || (n.family.family === "keeps_cold" && /\bnot insulated\b/i.test(clause));
    const m = n.family.value.exec(clause);
    if (negated) return false;
    if (!m) return null;
    return Number(m[1]) >= n.threshold;
  }
  const spec = BY_ID.get(id);
  if (!spec) return null;
  if (spec.absent?.test(clause)) return false;
  const kw = spec.statement.exec(clause);
  if (!kw) return null;
  const before = clause.slice(Math.max(0, kw.index - 40), kw.index);
  // The negator must sit right before the phrase (at most three words between): "has no active noise cancelling",
  // "is 1080p, not 4K", "does not have a backlit keyboard". "not as strong as" after the phrase is not a denial.
  if (new RegExp(`\\b${NEG}\\b(?:\\s+(?:have|has|support|supports|offer|offers|come with|include|includes|a|an|any|the|real|true|active|truly|fully|really|keep|keeps|drinks)){0,3}\\s*$`, "i").test(before)) return false;
  return true;
}

// ------------------------------------------------------------------------------------------------ categories
export interface CategorySpec {
  id: string;
  /** English search noun. */
  noun: string;
  request: RegExp;
  /** Matches a product's category title/slug or title. */
  product: RegExp;
}
/** Main product categories. Accessory categories are recognized separately and never equal a main category. */
export const CATEGORIES: CategorySpec[] = [
  { id: "headphones", noun: "headphones", request: /head\s?phones?|headsets?|earbuds?|earphones?|헤드폰|헤드셋|이어폰|이어버드/i, product: /head\s?phones?|headsets?|earbuds?|earphones?/i },
  { id: "laptops", noun: "laptop", request: /\blaptops?\b|\bnotebooks?\b|노트북/i, product: /\blaptops?\b|\bnotebooks?\b/i },
  { id: "phones", noun: "smartphone", request: /\bphones?\b|smartphones?|cell ?phones?|휴대폰|핸드폰|스마트폰/i, product: /\bphones?\b|smartphones?|cell ?phones?/i },
  { id: "hiking-boots", noun: "hiking boots", request: /hiking boots?|\bboots?\b|등산화|부츠/i, product: /hiking boots?|\bboots?\b/i },
  { id: "running-shoes", noun: "running shoes", request: /running shoes?|sneakers?|trainers|러닝화|운동화/i, product: /running shoes?|sneakers?|trainers/i },
  { id: "coffee-makers", noun: "coffee maker", request: /coffee (?:maker|machine|brewer)s?|커피\s*(?:메이커|머신)/i, product: /coffee (?:maker|machine|brewer)s?/i },
  { id: "water-bottles", noun: "water bottle", request: /(?:water )?bottles?|tumblers?|flasks?|물병|텀블러|보온병/i, product: /bottles?|tumblers?|flasks?/i },
  { id: "office-chairs", noun: "office chair", request: /(?:office |desk |ergonomic )?chairs?|사무용\s*의자|의자/i, product: /chairs?/i },
  { id: "monitors", noun: "monitor", request: /\bmonitors?\b|\bdisplays?\b|모니터/i, product: /\bmonitors?\b|\bdisplays?\b/i },
  { id: "backpacks", noun: "backpack", request: /backpacks?|daypacks?|rucksacks?|백팩|배낭/i, product: /backpacks?|daypacks?|rucksacks?/i },
  { id: "vacuums", noun: "vacuum cleaner", request: /vacuums?|청소기/i, product: /vacuums?/i },
];
const ACCESSORY_CATEGORY = /accessor|\bcases?\b|chargers?|\bparts?\b|replacement|\bpads?\b|cushions?|cables?|adapters?|protectors?|straps?/i;

export function requestCategory(text: string): CategorySpec | null {
  // Most specific first: "hiking boots" before "boots"; "running shoes" before generic shoes.
  for (const c of CATEGORIES) if (c.request.test(text)) return c;
  return null;
}

/**
 * Category of a catalog product: the provider's category title/slug first (it is structured), then the title.
 * Accessory categories return "accessory". Unknown returns null (not a violation by itself).
 */
export function productCategory(p: { category: string; title: string; research?: { categoryTitle: string | null } | undefined }): string | null {
  const structured = `${p.research?.categoryTitle ?? ""} ${p.category ?? ""}`.replace(/[-_]/g, " ");
  if (structured.trim() && structured.trim() !== "unknown") {
    if (ACCESSORY_CATEGORY.test(structured)) return "accessory";
    for (const c of CATEGORIES) if (c.product.test(structured)) return c.id;
  }
  for (const c of CATEGORIES) if (c.product.test(p.title)) return c.id;
  return null;
}
