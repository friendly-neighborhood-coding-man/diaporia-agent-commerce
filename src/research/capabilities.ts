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
  { id: "usb_c_charging", phrase: "usb-c charging", request: /usb[- ]?c\s+(?:charging|charge|power|rechargeable)|charg\w*\s+(?:via|over|by)\s+usb[- ]?c|usb[- ]?c\s*충전/i,
    statement: /\busb[- ]?c\b[^.;]{0,40}\b(?:(?:re)?charg\w*|power delivery)\b|\b(?:re)?charg\w*\b[^.;]{0,30}\busb[- ]?c\b/i },
  { id: "backlit_keyboard", phrase: "backlit keyboard", request: /backlit|keyboard backlight|백라이트/i, statement: /\bbacklit keyboard\b|\bkeyboard backlight(?:ing)?\b/i },
  { id: "programmable", phrase: "programmable timer", request: /\bprogrammable\b|예약\s*기능/i, statement: /\bprogrammable\b/i },
  { id: "thermal_carafe", phrase: "thermal carafe", request: /thermal carafe|보온\s*(?:포트|카라페|서버)/i, statement: /\bthermal carafe\b/i },
  { id: "dishwasher_safe", phrase: "dishwasher safe", request: /dishwasher[- ]?(?:safe|proof)|(?:safe|ok|fine)\s+(?:in|for)\s+(?:the\s+)?dishwasher|in\s+the\s+dishwasher|식기\s*세척기\s*(?:에\s*)?(?:사용\s*)?(?:가능|세척\s*가능|넣어도|OK|겸용)/i, /* V2.16 (IW-16 d13): a dishwasher is a product; only "dishwasher safe" is the feature */ statement: /\bdishwasher(?:[- ]safe)?\b/i, absent: /\bhand[- ]wash only\b/i },
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
    request: [/(\d{1,3})\s*\+?\s*-?\s*(?:hours?|hrs?|h)\b(?:\s+(?:of\s+)?(?:battery|playback|playtime))/i, /battery(?:\s+life)?\s+(?:of\s+)?(?:at\s+least\s+|over\s+|more than\s+|up to\s+|of up to\s+)?(\d{1,3})\s*\+?\s*(?:hours?|hrs?|h)\b/i,
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

/**
 * V2.2 WP-4 (M-1/M-2): generic propositions. A stated requirement the vocabulary does not know keeps its key
 * `unrecognized:<slug>` and is ALSO an evidence capability with that id: the proposition is "the product has <words>".
 * Evidence verifies it with the same statement and sufficiency rules as a known capability (exact model named in the
 * clause, all proposition words in one clause, negation governing them). The vocabulary is not extended.
 */
export const PROPOSITION_PREFIX = "unrecognized:";
const PROP_STOP = new Set("a an the of to for with and or in on at by it its be is are has have that which this very really".split(" "));
export function propositionWords(id: string): string[] {
  return id.slice(PROPOSITION_PREFIX.length).split("-").map((w) => w.trim()).filter((w) => w && !PROP_STOP.has(w));
}
/**
 * A performance or quality judgement ("quiet", "comfortable for long flights", "durable", "튼튼한") rather than a
 * manufacturer-statable property ("lanyard loop", "HDMI 2.1", "warm light"). Manufacturer text alone never verifies it;
 * independent evidence (two expert groups) is required.
 */
const PERFORMANCE_WORDS = /^(?:quiet(?:er|est)?|silent|comfortable|comfy|durable|sturdy|reliable|fast(?:er)?|quick|powerful|strong|accurate|precise|loud(?:er)?|clear(?:er)?|crisp|easy|simple|intuitive|good|great|excellent|best|better|long[- ]?lasting|lasting|efficient|effective|stable|smooth|responsive|bright(?:er)?|sharp|rich|warm-sounding|deep|punchy|light-?weight|portable|safe|healthy|kid[- ]?friendly|beginner[- ]?friendly|ergonomic|premium|high[- ]?quality|well[- ]?made|performs?|performance|조용|조용한|편안|편안한|편한|튼튼|튼튼한|내구성|빠른|강력|강력한|정확|정확한|좋은|가벼운|부드러운|선명한)$/i;
export function isPerformanceClaim(id: string): boolean {
  if (!id.startsWith(PROPOSITION_PREFIX)) return false;
  const ws = propositionWords(id);
  // "warm" alone is a sound judgement; "warm light" / "warm white" is a stated property (V2.3).
  return ws.some((w) => PERFORMANCE_WORDS.test(w)) || (ws.length === 1 && /^warm$/i.test(ws[0]!));
}
/** The evidence capability behind a requirement key: `not:<cap>` asks for the absence of <cap> (a known capability or a proposition). */
export function evidenceCapabilityOf(key: string): string {
  if (!key.startsWith("not:")) return key;
  const x = key.slice(4);
  return BY_ID.has(x) || numericSpec(x) ? x : `${PROPOSITION_PREFIX}${x}`;
}
const escRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** What one clause says about a proposition: all of its words in order (at most three words apart), negation governing them. */
const NUMBER_WORDS: Record<string, string> = { one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10" };
/** V2.4: "two-person tent" states the same capacity as "2-person". */
export const digitsForCounts = (s: string) => s.replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten)(?=[- ]?(?:persons?|people|man|seaters?|seats?|slices?|burners?|ports?|doors?|bays?)\b)/gi, (w) => NUMBER_WORDS[w.toLowerCase()]!);
/** V2.5: "single USB-C cable" is stated as "one USB-C cable"; "dual" as "two". */
const COUNT_SYNONYMS: Record<string, string> = { single: "(?:single|one|1)", one: "(?:single|one|1)", dual: "(?:dual|two|2)", two: "(?:dual|two|2)", twin: "(?:twin|two|2|dual)", triple: "(?:triple|three|3)" };
function propositionStatement(rawClause: string, id: string): boolean | null {
  const clause = digitsForCounts(rawClause);
  const words = propositionWords(id);
  if (!words.length) return null;
  const num = numericProposition(id);
  // Cycle 2: a "for <quantity>" phrase is first compared with a stated limit or range; when no bounded statement speaks to it,
  // a literal restatement can still verify it ("for 20 lb propane tanks": the number names a class of compatible object).
  if (num) { const v = numericStatement(clause, num); if (v !== null || num.dir !== "WITHIN") return v; }
  const ev = evaluativeStatement(clause, id);
  if (ev !== undefined) return ev;
  const gap = "(?:[^\\p{L}\\p{N}]+[\\p{L}\\p{N}][\\p{L}\\p{N}'’-]*){0,3}?[^\\p{L}\\p{N}]*";
  // V2.5: a long word matches its other forms by stem ("oscillates" / "oscillation" / "oscillating").
  const tok = (w: string) => {
    if (/^\d+(?:\.\d+)?[a-z]+$/i.test(w)) return w.replace(/^(\d+(?:\.\d+)?)([a-z]+)$/i, (_, n: string, u: string) => `${escRe(n)}\\s?-?${escRe(u)}`);
    if (/[가-힣]/.test(w)) return escRe(w).replace(/(?<=.)(?=.)/gu, "\\s*");
    const same = COUNT_SYNONYMS[w.toLowerCase()];
    if (same) return same;
    const stem = /^[a-z]{6,}$/i.test(w) ? w.replace(/(?:ations?|ions?|ings?|ers?|es|ed|s|e)$/i, "") : "";
    if (stem.length >= 6) return `${escRe(stem)}[a-z]{0,5}`;
    return /^[a-z]{4,}$/i.test(w) ? `${escRe(w.replace(/(?:es|s)$/i, ""))}(?:s|es|ed|ing)?` : escRe(w);
  };
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${words.map(tok).join(gap)}(?![A-Za-z0-9])`, "iu");
  let m = re.exec(clause.normalize("NFKC"));
  // V2.5: "removable battery" is also stated as "the battery is removable" / "battery: removable".
  if (!m && words.length === 2 && /(?:able|ible|ful|less|proof|ive|al|ed|ing)$/i.test(words[0]!))
  {
    const alt = new RegExp(`(?<![\\p{L}\\p{N}])${tok(words[1]!)}\\s*(?:(?:is|are)\\s+(not\\s+|n['’]t\\s+)?(?:fully\\s+|easily\\s+|also\\s+)?|(?:is|are)n['’]t\\s+|:\\s*)${tok(words[0]!)}(?![A-Za-z0-9])`, "iu").exec(clause.normalize("NFKC"));
    if (alt && (alt[1] || /n['’]t\s/i.test(alt[0]))) return false;
    m = alt;
  }
  if (!m) return null;
  const before = clause.normalize("NFKC").slice(Math.max(0, m.index - 40), m.index);
  const after = clause.normalize("NFKC").slice(m.index + m[0].length, m.index + m[0].length + 12);
  if (new RegExp(`\\b${NEG}\\b(?:\\s+(?:have|has|support|supports|offer|offers|come with|comes with|include|includes|a|an|any|the|real|true|built-in|dedicated)){0,3}\\s*$`, "i").test(before)) return false;
  if (/^\s*[-–]?\s*free\b/i.test(after)) return false;
  // V2.10: a spec line "Built-in pump: no" / "Pump: none" answers the phrase directly.
  if (/^\s*[:=]\s*(?:no|none|n\/a|not\s+(?:included|available|supported)|without|absent|false)\b/i.test(after)) return false;
  if (/^\s*[:=]\s*(?:yes|included|standard|built[- ]in)\b/i.test(after)) return true;
  // Negation after the phrase. Korean is verb-final: "자동 배수(연속 배수) 기능은 없습니다" denies it; English too:
  // "two batteries are not included", "sold separately". A denial in the predicate that governs the phrase (only a
  // parenthetical, a feature noun and a particle between) is false; any other negation later in the clause makes the
  // clause ambiguous (no statement), never true.
  const rest = clause.normalize("NFKC").slice(m.index + m[0].length).replace(/\([^)]*\)/g, " ");
  if (/^\s*(?:기능|옵션|모드|장치)?\s*(?:이|가|은|는|도)?\s*(?:없|미지원|미탑재|불가|지원(?:하지|되지)\s*않|되지\s*않|안\s*(?:되|됨))/.test(rest)) return false;
  if (/^\s*(?:is|are|was|were)\s+(?:not|n't)\s+(?:included|supported|available|provided|offered)\b|^\s*(?:aren't|isn't)\s+(?:included|supported|available)\b|^[^.;]{0,30}\b(?:sold separately|not included|optional extra|purchased separately)\b/i.test(rest)) return false;
  // V2.4: a negation in a separate predicate joined by "and"/"but" ("has soldered switches and is not hot-swappable")
  // denies that other thing, not this one.
  const sep = /^([^.;]*?)\s(?:and|but|while|whereas)\s/i.exec(rest);
  const governed = sep ? sep[1]! : rest;
  if (/없|않|미지원|불가|\b(?:not|no|never|without|lacks?|isn't|aren't|doesn't|don't|cannot|can't)\b/i.test(governed)) return null;
  return true;
}

/**
 * V2.4: an evaluative claim about a topic ("good with pet hair", "great for travel") is a judgement, so its wording
 * varies: the clause must name the topic and judge it. A positive judgement ("excellent for pet hair", "handled pet hair
 * very well") states it, a negative one ("struggled with pet hair", "poor on pet hair") denies it, and a negated
 * positive ("not good with pet hair") denies it. Returns undefined when the proposition is not evaluative.
 */
const EVAL_POS = /\b(?:good|great|excellent|superb|outstanding|impressive|ideal|perfect|best|effective|strong|(?:very|really|extremely|remarkably)\s+well|well)\b/i;
const EVAL_NEG = /\b(?:poor(?:ly)?|bad(?:ly)?|weak|mediocre|disappointing|terrible|awful|struggled|struggles|struggling|failed|fails|worst|ineffective)\b/i;
function evaluativeStatement(clause: string, id: string): boolean | null | undefined {
  const ws = id.slice(PROPOSITION_PREFIX.length).split("-");
  if (!/^(?:good|great|excellent|ideal|perfect|best|effective)$/i.test(ws[0] ?? "") || !/^(?:with|for|at|on|against)$/i.test(ws[1] ?? "")) return undefined;
  const topic = ws.slice(2).filter((w) => w && !PROP_STOP.has(w));
  if (!topic.length) return null;
  const c = clause.normalize("NFKC");
  const tre = new RegExp(`(?<![\\p{L}\\p{N}])${topic.map((w) => escRe(w.replace(/s$/i, "")) + "s?").join("\\s+")}(?![\\p{L}\\p{N}])`, "iu");
  const t = tre.exec(c);
  if (!t) return null;
  const win = c.slice(Math.max(0, t.index - 60), t.index + t[0].length + 40);
  const pos = EVAL_POS.exec(win);
  if (EVAL_NEG.test(win)) return pos ? null : false;
  if (!pos) return null;
  if (new RegExp(`\\b${NEG}\\b(?:\\s+\\S+){0,2}\\s*$`, "i").test(win.slice(0, pos.index))) return false;
  return true;
}

/**
 * V2.3: a proposition with a number ("at least 65 W USB-C power delivery", "100W", "90W USB-C charging", "at most 30 dB")
 * is a threshold, never a word match: the clause must state a value for the same unit and words, and the value decides.
 * A bare spec of a capacity-like unit (W, mAh, Wh, Hz, Mbps, Gbps, nits) is a minimum ("100W" accepts 140 W, not 65 W);
 * any other bare number must match exactly.
 */
interface NumericProposition { dir: "AT_LEAST" | "AT_MOST" | "EXACT" | "WITHIN"; n: number; unit: string; rest: string[] }
const MIN_UNITS = /^(?:w|watts?|mah|wh|hz|mbps|gbps|nits|tb|gb)$/i;
/**
 * Post-submission cycle 2 (F4): one dimension, many spellings. A page that says "10 A", "7 kW", "150 ft" or "450 L" states the
 * same unit as a request for "8 amps", "5 kilowatts", "120 feet" or "400 liters". Unknown units match only themselves.
 */
const UNIT_DIMENSIONS: string[][] = [
  ["ft", "foot", "feet"], ["in", "inch", "inches", '"'], ["cm", "centimeter", "centimeters", "centimetre", "centimetres"], ["mm", "millimeter", "millimeters"],
  ["m", "meter", "meters", "metre", "metres"], ["a", "amp", "amps", "ampere", "amperes"], ["kw", "kilowatt", "kilowatts"], ["v", "volt", "volts"],
  ["l", "liter", "liters", "litre", "litres"], ["gal", "gallon", "gallons"], ["lb", "lbs", "pound", "pounds"], ["kg", "kilogram", "kilograms"],
  ["sq-ft", "sqft", "square-feet", "square-foot", "sq ft", "square feet", "square foot", "ft2"], ["people", "person", "persons"], ["ah", "amp-hours"],
];
const unitForms = (unit: string): string[] | null => UNIT_DIMENSIONS.find((g) => g.includes(unit.toLowerCase())) ?? null;
/** Count nouns: a spelled or digit count may stand a measurement away from the noun ("three 10,000 BTU burners"). */
const COUNT_UNIT = /^(?:burners?|seats?|bikes?|zones?|people|persons?|ports?|outlets?|tanks?|doors?|wheels?|shelves|shelf|slots?|speeds?|settings?|blades?|drawers?)$/i;
const WORDNUM = "one|two|three|four|five|six|seven|eight|nine|ten";
export function numericProposition(id: string): NumericProposition | null {
  if (!id.startsWith(PROPOSITION_PREFIX)) return null;
  const body = id.slice(PROPOSITION_PREFIX.length);
  // Post-submission cycle 2 (F2/F4): "for <a quantity> [noun]" ("for my 45 lb son", "for a 57 cm head", "for a family of 5",
  // "for use at 3,800 m", "for a 650 sq ft garage") names a value the product must accommodate: it is inside the limit or
  // range the manufacturer states. The person or object noun is context for the number, not a word the page must repeat.
  const f = /^for-(?:(?:a|an|the|my|our|his|her|their|use|at|up|of|family|household|home)-)*(\d{1,3}(?:-\d{3})+|\d+(?:\.\d+)?)-?([a-z]+(?:-ft|-feet)?)?(?:-(.+))?$/i.exec(body)
    ?? /^for-(?:a|an|the|my|our)-(?:family|household|home|group)-of-(\d+)(?:-(people|persons?))?$/i.exec(body);
  if (f && /^for-/i.test(body)) {
    const raw = f[1]!; const n = Number(/^\d{1,3}(?:-\d{3})+$/.test(raw) ? raw.replace(/-/g, "") : raw);
    let unit = (f[2] ?? "").toLowerCase();
    if (/^(?:sq|square)$/.test(unit) && /^(?:ft|feet|foot)\b/.test(f[3] ?? "")) unit = "sq-ft";
    if (!unit && /(?:family|household|home|group)-of-/i.test(body)) unit = "people";
    if (unit === "sq-ft" || unit === "square-feet") unit = "sq-ft";
    if (unitForms(unit)) return { dir: "WITHIN", n, unit, rest: [] };
  }
  // V2.10: "up-to" is a bound of unclear direction (Requirements.ts): only the exact value meets it (fail closed).
  const m = /^(?:(at-least|at-most|up-to)-)?(\d+(?:\.\d+)?)(?:-?([a-z%]+))?(?:-(.+))?$/i.exec(body);
  if (!m) return null;
  const rest = (m[4] ?? "").split("-").filter((w) => w && !PROP_STOP.has(w));
  let unit = (m[3] ?? "").toLowerCase();
  // "at least 600 square feet" / "sq ft": one area unit.
  if (/^(?:sq|square)$/.test(unit) && /^(?:ft|feet|foot)$/.test(rest[0] ?? "")) { unit = "sq-ft"; rest.shift(); }
  const dir = m[1] === "at-least" ? "AT_LEAST" : m[1] === "at-most" ? "AT_MOST" : m[1] === "up-to" ? "EXACT" : MIN_UNITS.test(unit) ? "AT_LEAST" : "EXACT";
  if (!unit && !rest.length) return null;
  return { dir, n: Number(m[2]), unit, rest };
}
const num = (s: string) => Number((NUMBER_WORDS[s.toLowerCase()] ?? s).replace(/,/g, ""));
function unitPattern(unit: string): string {
  const forms = unitForms(unit);
  if (forms) return `(?:${forms.map((x) => escRe(x).replace(/[\s-]/g, "[\\s-]?")).sort((a, b) => b.length - a.length).join("|")})`;
  return /^watts?$|^w$/.test(unit) ? "(?:w|watts?)" : /^percent$/.test(unit) ? "(?:%|percent|per ?cent)" : /^[a-z]{3,}$/.test(unit) ? `${escRe(unit.replace(/e?s$/, ""))}(?:e?s)?` : escRe(unit);
}
function numericStatement(clause: string, p: NumericProposition): boolean | null {
  const c = clause.normalize("NFKC");
  // V2.7: a word unit is matched in its plural ("13 inches", "40 lumens").
  const unitRe0 = p.unit ? unitPattern(p.unit) : "";
  // V2.11: a rating qualifier between the number and the unit ("3,200 ANSI lumens", "500 W peak") is the same unit.
  const unitRe = unitRe0 ? `(?:(?:ANSI|ISO|LED|rated|nominal|continuous|usable|effective)\\s+)?${unitRe0}` : "";
  const NUM = "\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?";
  if (p.dir === "WITHIN") {
    // Only a bounded statement decides: "up to N u", "N to M u" / "N-M u", "maximum N u", "not above/over N u".
    const after = `\\s?-?${unitRe}(?![A-Za-z])`;
    let verdict = null as boolean | null;
    const vote = (ok: boolean) => { verdict = verdict === null ? ok : verdict === ok ? ok : null; };
    let conflict = false;
    for (const m of c.matchAll(new RegExp(`(?<![\\p{L}\\p{N}.,])(${NUM})\\s*(?:to|-|–)\\s*(${NUM})${after}`, "giu"))) {
      const lo = num(m[1]!), hi = num(m[2]!); const before = c.slice(Math.max(0, m.index! - 40), m.index!);
      if (new RegExp(`\\b${NEG}\\b(?:\\s+\\S+){0,3}\\s*$`, "i").test(before)) continue;
      const ok = p.n >= lo && p.n <= hi; if (verdict !== null && verdict !== ok) conflict = true; vote(ok);
    }
    for (const m of c.matchAll(new RegExp(`\\b(up to|maximum(?: of)?|max\\.?|at most|no more than|(?:not|never)\\s+(?:\\w+\\s+){0,3}?(?:above|over|beyond|more than))\\s+(${NUM})${after}`, "giu"))) {
      const before = c.slice(Math.max(0, m.index! - 30), m.index!);
      const negLimit = /^(?:not|never)\b/i.test(m[1]!);
      if (!negLimit && new RegExp(`\\b${NEG}\\b(?:\\s+\\S+){0,3}\\s*$`, "i").test(before)) continue;
      const hi = num(m[2]!); const ok = p.n <= hi;
      // "not suitable above 3,000 m" says what is NOT allowed: a value inside it is still not affirmed (no statement for it).
      if (negLimit) { if (!ok) { if (verdict === true) conflict = true; verdict = false; } continue; }
      if (verdict !== null && verdict !== ok) conflict = true; vote(ok);
    }
    return conflict ? null : verdict;
  }
  const tok = (w: string) => /^[a-z]{4,}$/i.test(w) ? `${escRe(w.replace(/(?:es|s)$/i, ""))}(?:s|es|ed|ing)?` : escRe(w);
  // The other words ("USB-C power delivery") must be stated next to the number, before or after it ("USB-C with 90 W
  // power delivery", "90W USB-C charging"): within 40 characters on either side.
  const restRe = p.rest.map((w) => new RegExp(`(?<![\\p{L}\\p{N}])${tok(w)}(?![A-Za-z0-9])`, "iu"));
  // V2.4: "4,000 Pa" and "2,000 ANSI lumens" are thousands, never "000".
  // Cycle 2: a count noun may follow its count word with one measurement in between ("three 10,000 BTU burners").
  const countGap = COUNT_UNIT.test(p.unit) ? `(?:\\s+(?:${NUM})\\s?[A-Za-z]{1,4})?\\s+` : "";
  const numAlt = COUNT_UNIT.test(p.unit) ? `${NUM}|${WORDNUM}` : NUM;
  const re = new RegExp(`(?<![\\p{L}\\p{N}.,])(${numAlt})${countGap ? `(?:${countGap}|\\s?-?)` : "\\s?-?"}${unitRe}${p.unit ? "(?![A-Za-z])" : ""}`, "giu");
  let verdict: boolean | null = null;
  for (const m of c.matchAll(re)) {
    const win = c.slice(Math.max(0, m.index! - 40), m.index! + m[0].length + 40);
    if (!restRe.every((r) => r.test(win))) continue;
    const before = c.slice(Math.max(0, m.index! - 40), m.index!);
    if (new RegExp(`\\b${NEG}\\b(?:\\s+\\S+){0,3}\\s*$`, "i").test(before)) return null;
    const v = num(m[1]!);
    const ok = p.dir === "AT_LEAST" ? v >= p.n : p.dir === "AT_MOST" ? v <= p.n : v === p.n;
    if (verdict === null) verdict = ok; else if (verdict !== ok) return null;
  }
  return verdict;
}

/** V2.5: search words for a capability: a threshold is searched by its unit and words, not "least 20000". */
export function capabilityQueryPhrase(id: string): string {
  const n = numericProposition(id);
  if (n) return [n.unit === "w" ? "watts" : n.unit, ...n.rest].filter(Boolean).join(" ");
  return capabilityPhrase(id);
}
export function capabilityPhrase(id: string): string {
  if (id.startsWith(PROPOSITION_PREFIX)) return propositionWords(id).join(" ");
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
/**
 * V2.10 (IW-11 fix order item 2): "this part fits <host model>". The key names the full requested host model; a clause
 * states it when a fit verb ("fits", "compatible with", "works with", "designed for", "for use with") lists that exact
 * model, optionally after its brand and followed only by the product noun ("fits the Pedalto C1 and C1 Step-Through
 * Electric Bikes"). A listed sibling ("C1 Long Range", "Note 7" for "Note 7 Colour") never matches; a negated verb
 * ("does not fit the P7 Go") states that it does not fit.
 */
export const FIT_PREFIX = `${PROPOSITION_PREFIX}fits-model-`;
export const fitKey = (model: string) => `${FIT_PREFIX}${model.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
const FIT_VERB = /\b(?:(does\s+not|doesn['’]t|do\s+not|don['’]t|will\s+not|won['’]t|is\s+not|isn['’]t|are\s+not|aren['’]t|not|never)\s+)?(?:fits?|fitting|(?:is\s+|are\s+)?compatible\s+with|works?\s+with|(?:is\s+)?designed\s+for|(?:is\s+)?made\s+for|for\s+use\s+with|clips?\s+(?:on)?to|attach(?:es)?\s+to|mounts?\s+(?:on|to))\s+/gi;
const FIT_TAIL_OK = /^(?:electric|smart|cordless|robotic|robot|digital|stand|pizza|portable|wireless|3d|action|bread|maker|machine|models?|series|only|versions?|[a-z-]*[a-z]s)$/i;
const FIT_NOT_TAIL = /^(?:plus|max|mini|lite|pro|ultra|duo|dual|go|se|xl|xs|long|range|colou?r|gen|edition|kids?)$/i;
const fitNorm = (x: string) => x.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]/g, "");
function fitItem(item: string, want: string): boolean {
  const ws = item.trim().replace(/^(?:the|all|both|a|an)\s+/i, "").split(/\s+/).filter(Boolean);
  for (let start = 0; start <= Math.min(2, ws.length - 1); start++) {
    if (start > 0 && /\d/.test(ws[start - 1]!)) break;
    for (let k = start + 1; k <= ws.length; k++) {
      if (fitNorm(ws.slice(start, k).join("")) !== want) continue;
      const rest = ws.slice(k);
      if (rest.length <= 4 && rest.every((w) => !/\d/.test(w) && FIT_TAIL_OK.test(w) && !FIT_NOT_TAIL.test(w))) return true;
    }
  }
  return false;
}
export function fitStatement(clause: string, id: string): boolean | null {
  const want = id.slice(FIT_PREFIX.length).replace(/-/g, "");
  if (!want) return null;
  const c = clause.normalize("NFKC");
  let out: boolean | null = null;
  for (const m of c.matchAll(FIT_VERB)) {
    // Post-submission cycle 6b: "fits every Spindra lathe: the Spindra 12, Spindra 16 and Spindra 16 VS" lists the hosts
    // after a colon; the list is read, and each item must still name the exact host.
    let raw = c.slice(m.index! + m[0].length);
    const colon = /^[^.;:!?()]{0,40}:\s*/.exec(raw);
    if (colon) raw = raw.slice(colon[0].length);
    const rest = raw.split(/[.;:!?()]|,\s*(?:which|whose|but|so|while)\b|\s+(?:which|whose|because|but|except|unlike|not)\b/i)[0]!;
    const items = rest.split(/\s*,\s*(?:and\s+|or\s+)?|\s+(?:and|or|&)\s+|\s*\/\s*/);
    if (items.some((it) => fitItem(it, want))) { if (m[1]) return false; out = true; }
  }
  return out;
}
/**
 * V2.19 (IW-19 failure 1, fail-closed): a clause that says something positive about the requirement but also carries a
 * negation, exclusion or "sold separately" ("It is not for the top of stairs.", "A lid is not included.") never
 * verifies it. The specific matchers below still turn a clear denial into FALSE; anything else becomes unverified.
 */
const ANY_NEGATION = /\b(?:not|no|never|none|neither|nor|without|except|excluding|excluded|isn['’]t|aren['’]t|doesn['’]t|don['’]t|didn['’]t|won['’]t|wasn['’]t|weren['’]t|cannot|can['’]t|unable|incompatible|unsuitable|unsafe|unsafely|unfit|lacks?|lacking|only|needs?|requires?|required|needed|adapter|avoid|warning|caution|dangerous|hazard)\b|sold\s+separately|purchased?\s+separately|available\s+separately|\bnot\s+included\b|않|없|불가|미지원|미포함|별매|별도\s*구매|안\s*(?:함|됨|돼|되)|아니[오요]/i;
export function clauseStatement(clause: string, id: string): boolean | null {
  const v = clauseStatementInner(clause, id);
  // Known capabilities have their own scoped negation rules ("not as strong as" is not a denial); free-text
  // propositions and fit statements have none, so any negation there blocks verification.
  if (v !== true || !(id.startsWith(FIT_PREFIX) || id.startsWith(PROPOSITION_PREFIX))) return v;
  // The negation counts in the predicate that states the requirement: the part of the clause, between "and" / "but" /
  // commas, that holds its words ("has a steel boiler and is not programmable" still states the steel boiler).
  const words = id.slice(id.indexOf(":") + 1).split("-").filter((w) => w.length > 2 && !/^(?:the|and|for|with|least|most)$/.test(w));
  // A prefix word of a compound ("in-ground", "non-stick", "self-cleaning") must be on the clause with its word:
  // "Above Ground Pool" never states "in-ground pool".
  const all = id.slice(id.indexOf(":") + 1).split("-");
  for (let i = 0; i + 1 < all.length; i++)
    if (/^(?:in|on|off|non|un|over|under|out|self|all|no|top|side|rear|front)$/.test(all[i]!) && !new RegExp(`(?<![\\p{L}])${all[i]}[\\s-]?${all[i + 1]}`, "iu").test(clause)) return null;
  const parts = clause.split(/\s+(?:and|but|while|whereas)\s+|[,;]\s*/i);
  const own = parts.filter((p) => words.some((w) => new RegExp(`(?<![\\p{L}])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "iu").test(p)));
  const negated = (own.length ? own : [clause]).filter((p) => ANY_NEGATION.test(p));
  if (!negated.length) return v;
  // A plain denial right before the requirement's words ("it is not for in-ground pools", "unsafe at the top of
  // stairs") states the opposite: FALSE. Any other negation in that predicate leaves it unverified.
  const first = new RegExp(`(?<![\\p{L}])(?:${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "iu");
  const denies = negated.some((p) => {
    const m = first.exec(p);
    return !!m && /\b(?:not|never|isn['’]t|aren['’]t|doesn['’]t|don['’]t|won['’]t|cannot|can['’]t|incompatible|unsuitable|unsafe|unfit)\b(?:[\s-]+[^\s-]+){0,3}[\s-]*$/i.test(p.slice(0, m.index));
  });
  return denies ? false : null;
}
function clauseStatementInner(clause: string, id: string): boolean | null {
  if (id.startsWith(FIT_PREFIX)) return fitStatement(clause, id);
  if (id.startsWith(PROPOSITION_PREFIX)) return propositionStatement(clause, id);
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
  if (!kw) return koreanStatement(clause, id);
  const before = clause.slice(Math.max(0, kw.index - 40), kw.index);
  // The negator must sit right before the phrase (at most three words between): "has no active noise cancelling",
  // "is 1080p, not 4K", "does not have a backlit keyboard". "not as strong as" after the phrase is not a denial.
  if (new RegExp(`\\b${NEG}\\b(?:\\s+(?:have|has|support|supports|offer|offers|come with|include|includes|a|an|any|the|real|true|active|truly|fully|really|keep|keeps|drinks)){0,3}\\s*$`, "i").test(before)) return false;
  // V2.5: a contrast right before the phrase ("micro-USB rather than USB-C"), a negator inside a phrase that spans two
  // anchors ("charges over micro-USB, not USB-C", "via micro-USB (no USB-C)"), or a denial right after it
  // ("USB-C charging is not supported") all deny the capability. Ambiguous cases fail closed (contradicted).
  if (/\b(?:rather than|instead of|in place of|other than|unlike|versus|vs\.?)\s*$/i.test(before)) return false;
  if (new RegExp(`\\b(?:${NEG}|rather than|instead of|in place of|other than|unlike)\\b`, "i").test(kw[0].slice(1))) return false;
  const after = clause.slice(kw.index + kw[0].length, kw.index + kw[0].length + 40);
  if (/^[\s,]*(?:(?:is|are|was|were)\s+(?:not|never)\s+|(?:is|are|was|were)n['’]t\s+|not\s+|un)(?:supported|available|included|offered|present|provided|possible)\b/i.test(after)) return false;
  return true;
}

/**
 * Korean statements (V2.1). The negation must follow the phrase directly, with at most a feature noun and a particle
 * between ("노이즈 캔슬링 기능이 없습니다", "멀티포인트를 지원하지 않습니다", "멀티포인트 미지원"), or be a 비/미 prefix
 * ("비방수"). Anything looser ("소음 걱정 없이") is not a denial.
 */
const KO_STATEMENT: Record<string, RegExp> = {
  active_noise_cancellation: /노이즈\s*캔슬링|노이즈\s*캔슬레이션|노캔|액티브\s*노이즈\s*캔슬링/, wireless: /무선|블루투스/, multipoint: /멀티\s*포인트|두\s*기기\s*동시\s*연결/,
  over_ear: /오버\s*이어/, waterproof: /방수/, usb_c_charging: /(?:USB[- ]?C|C\s*타입|타입\s*C)\s*(?:포트\s*)?(?:로\s*)?충전/i, backlit_keyboard: /키보드\s*백라이트|백라이트\s*키보드/,
  programmable: /예약\s*기능/, thermal_carafe: /보온\s*(?:포트|카라페|서버)/, dishwasher_safe: /식기\s*세척기/, lumbar_support: /요추\s*지지|허리\s*지지/,
  adjustable_armrests: /팔걸이\s*(?:높이\s*)?조절|조절\s*(?:식|가능한)\s*팔걸이/,
};
const KO_NEG_AFTER = /^\s*(?:기능|모드|지원|성능)?\s*(?:은|는|이|가|을|를|도)?\s*(?:지원\s*(?:하지|되지|을\s*하지)\s*않|지원\s*안|미지원|없|불가|안\s*(?:됨|된|되|돼)|되지\s*않|하지\s*않)/;
export function koreanStatement(clause: string, id: string): boolean | null {
  const re = KO_STATEMENT[id];
  if (!re) return null;
  const m = re.exec(clause);
  if (!m) return null;
  if (/(?:비|미|무)$/.test(clause.slice(0, m.index))) return false;
  return !KO_NEG_AFTER.test(clause.slice(m.index + m[0].length));
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
  // V2.10 (IW-11 fix order item 6): everyday names of product categories ("e-bike", "robotic lawnmower", "ebook reader").
  { id: "electric-bikes", noun: "electric bike", request: /\be-?bikes?\b|\belectric (?:bikes?|bicycles?)\b|전기\s*자전거/i, product: /\be-?bikes?\b|\belectric (?:bikes?|bicycles?)\b/i },
  { id: "robot-lawn-mowers", noun: "robot lawn mower", request: /\brobot(?:ic)? (?:lawn ?)?mowers?\b|\brobot(?:ic)? lawnmowers?\b|로봇\s*잔디\s*깎이/i, product: /\brobot(?:ic)? (?:lawn ?)?mowers?\b|\brobot(?:ic)? lawnmowers?\b/i },
  { id: "e-readers", noun: "e-reader", request: /\be-?readers?\b|\be-?book readers?\b|전자책\s*리더기?/i, product: /\be-?readers?\b|\be-?book readers?\b/i },
  { id: "3d-printers", noun: "3D printer", request: /\b3d printers?\b|3D\s*프린터/i, product: /\b3d printers?\b/i },
  { id: "dehumidifiers", noun: "dehumidifier", request: /\bdehumidifiers?\b|제습기/i, product: /\bdehumidifiers?\b/i },
  { id: "pizza-ovens", noun: "pizza oven", request: /\bpizza ovens?\b|피자\s*오븐/i, product: /\bpizza ovens?\b/i },
  { id: "smart-scales", noun: "smart scale", request: /\bsmart scales?\b|\bbody (?:fat|composition) scales?\b|\bbathroom scales?\b|체중계|체지방계/i, product: /\bsmart scales?\b|\bbody (?:fat|composition) scales?\b|\bbathroom scales?\b/i },
];
const ACCESSORY_CATEGORY = /accessor|\bcases?\b|chargers?|\bparts?\b|replacement|\bpads?\b|cushions?|cables?|adapters?|protectors?|straps?/i;

/** The category a request names even when it asks for an accessory of it ("노트북 충전기" → laptops). Query building only. */
export function mentionedCategory(text: string): CategorySpec | null {
  return CATEGORIES.find((c) => [...text.matchAll(new RegExp(c.request.source, c.request.flags.replace("g", "") + "g"))].some((h) => !/^[a-z]/i.test(text.slice(h.index! + h[0].length, h.index! + h[0].length + 1)) || /[가-힣]/.test(h[0]))) ?? null;
}
/** N-07: an accessory noun right after a category noun ("laptop charger", "노트북 충전기") names the accessory, not the category. */
const ACCESSORY_AFTER = /^\s*(?:chargers?|charging|cases?|sleeves?|bags?|stands?|cables?|cords?|adapters?|docks?|covers?|mounts?|pads?|cushions?|batter(?:y|ies)|straps?|skins?|protectors?|replacement|parts?|충전기|케이스|파우치|가방|거치대|케이블|어댑터|커버|배터리|보호\s*필름)(?![a-z])/i;
/** "a sleeve for a 14 inch laptop", "case that fits my tablet": the category is what the accessory is FOR. */
const ACCESSORY_FOR = /\b(?:for|fits?|compatible with)\s+(?:an?\s+|the\s+|my\s+)?(?:[\w.-]+\s+){0,3}$/i;
export function requestCategory(text: string): CategorySpec | null {
  // Most specific first: "hiking boots" before "boots"; "running shoes" before generic shoes.
  for (const c of CATEGORIES) {
    const m = new RegExp(c.request.source, c.request.flags.replace("g", "") + "g");
    // V2.4: a category word inside a longer word is not the category ("backpacking tent" is not a backpack).
    const hits = [...text.matchAll(m)].filter((h) => !/^[a-z]/i.test(text.slice(h.index! + h[0].length, h.index! + h[0].length + 1)) || /[가-힣]/.test(h[0]));
    const accessoryOf = (h: RegExpMatchArray) => ACCESSORY_AFTER.test(text.slice(h.index! + h[0].length)) || ACCESSORY_FOR.test(text.slice(0, h.index!));
    if (hits.length && !hits.some(accessoryOf)) return c;
    if (hits.length) return null; // "laptop charger", "a sleeve for a laptop charger…": an accessory request, not the category
  }
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

/**
 * N-07: English search nouns for Korean product words (query building only; never a category or a requirement, so
 * nothing here can widen or narrow what counts as the right product).
 */
export const KO_QUERY_NOUNS: Array<[RegExp, string]> = [
  // V2.3: more product nouns (the structural guard needs to know them; queries gain English nouns).
  [/로봇\s*청소기/, "robot vacuum"], [/(?:전자책\s*)?리더기/, "e-reader"], [/스탠딩\s*(?:책상|데스크)/, "standing desk"], [/책상|데스크/, "desk"],
  [/여행\s*(?:배낭|가방)/, "travel backpack"], [/배낭|백팩/, "backpack"], [/필터/, "filter"], [/그라인더|분쇄기/, "coffee grinder"], [/등산화/, "hiking boots"],
  [/커피\s*메이커|커피메이커/, "coffee maker"], [/청소기/, "vacuum"], [/노트북|랩탑/, "laptop"], [/이어폰|이어버드/, "earbuds"], [/헤드폰|헤드셋/, "headphones"], [/모니터/, "monitor"], [/재킷|자켓|우비|바람막이/, "jacket"],
  [/전자책|이북\s*리더|e-?북/i, "e-reader"], [/밥솥/, "rice cooker"], [/전기\s*(?:포트|주전자)|커피\s*포트/, "electric kettle"], [/태블릿/, "tablet"],
  [/스피커/, "speaker"], [/키보드/, "keyboard"], [/마우스/, "mouse"], [/공기\s*청정기/, "air purifier"], [/가습기/, "humidifier"], [/제습기/, "dehumidifier"],
  [/선풍기/, "fan"], [/에어\s*프라이어/, "air fryer"], [/전자\s*레인지/, "microwave"], [/보조\s*배터리/, "power bank"], [/충전기/, "charger"], [/케이스/, "case"], [/파우치/, "pouch"], [/거치대/, "stand"], [/케이블/, "cable"],
  [/카메라/, "camera"], [/프로젝터/, "projector"], [/믹서기|블렌더/, "blender"], [/토스터/, "toaster"], [/스마트\s*워치/, "smartwatch"], [/드라이기|헤어\s*드라이어/, "hair dryer"],
];

/** English product nouns (the head of a product noun phrase); multi-word ones first. Used to find what modifies them. */
/** V2.2 WP-3: defined next to the identity extractor (which must stop a model name at a product noun). */
export { PRODUCT_NOUN_PHRASES } from "../identity/ProductIdentityExtractor.js";
