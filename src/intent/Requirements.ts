/**
 * N-01 (IW-2 verification of 7d1fe4f): lossless hard-requirement extraction.
 *
 * Every requirement the user states is kept with its span in the request, whether or not the capability vocabulary
 * (research/capabilities.ts) knows it:
 *  - RECOGNIZED: maps to a capability id the evidence router can verify (e.g. "wireless").
 *  - UNRECOGNIZED: a requirement phrase the vocabulary does not cover ("a warm light", "HDMI 2.1", "온도 조절").
 *    It is never dropped: it becomes an open blocking item (gate key `must:unrecognized:<slug>`) that only evidence
 *    (a future vocabulary) or the human owner (V21-04 confirmation page) can settle.
 *  - EXCLUDED (negative): "without ads", "no ANC", "must not have a touchscreen", "광고 없는". Not verifiable by the
 *    current evidence engine, so also an open blocking item (`must:not:<slug>`), fail closed.
 * Optional preferences ("ideally", "if possible", "있으면 좋") are NICE and never block.
 *
 * The extraction is lexical and conservative: a phrase that only restates the category, a colour/size/storage
 * attribute (parsed separately), the brand/model, a price or a condition is not a requirement.
 */
import { parseAttributes } from "../identity/ProductIdentityExtractor.js";
import { KO_QUERY_NOUNS, PRODUCT_NOUN_PHRASES, capabilityPhrase, digitsForCounts, evidenceCapabilityOf, isPerformanceClaim, requestCapabilities, requestCategory } from "../research/capabilities.js";
import { GENERIC_WORDS } from "../identity/ProductIdentityExtractor.js";

export type RequirementPolarity = "REQUIRED" | "EXCLUDED";
export type RequirementStrength = "MUST" | "NICE";
export interface StatedRequirement {
  /** Gate/requirement key without the "must:" prefix: a capability id, `unrecognized:<slug>` or `not:<slug>`. */
  key: string;
  /** The user's words for it, as written. */
  text: string;
  /** [start, end) in the original request. */
  span: [number, number];
  recognized: boolean;
  capability: string | null;
  polarity: RequirementPolarity;
  strength: RequirementStrength;
  source: "REQUEST_TEXT" | "STRUCTURED_INPUT";
  /**
   * V2.2 WP-4 generic representation. `proposition`: the normalized claim the product must make true ("has lanyard
   * loop", "has no ads"); `evidenceCapability`: the capability id evidence verifies (a known capability, or the
   * proposition itself as `unrecognized:<slug>`); `claimType`: PROPERTY (manufacturer-statable) or PERFORMANCE (needs
   * independent evidence). `note`: DECORATIVE (a style adjective, kept as optional) or CATEGORY_WORD (part of the
   * product's category name in an exact-product request, never a capability).
   */
  proposition?: string;
  evidenceCapability?: string | null;
  claimType?: "PROPERTY" | "PERFORMANCE";
  note?: "DECORATIVE" | "CATEGORY_WORD" | "CONTEXT" | "TYPE_MODIFIER";
}

const NICE = /\b(ideally|would be nice|nice to have|nice-to-have|preferably|prefer(?:red|ably)?|bonus|if possible|if available|optional(?:ly)?|a plus|would love|bonus points)\b|있으면 좋|선호|가능하면|되면 좋/i;
/** English triggers whose following words state a requirement. Group 1 = the requirement phrase. */
const EN_MUST = [
  /\b(?:must|has to|have to|needs? to|got to|should)\s+(?:have|has|support|include|come with|offer|feature|provide|be|use|work with|do)\s+(.+)/i,
  // V2.3: any other verb after must/has to/needs to states a requirement ("it must fold flat into a slim case").
  /\b(?:must|has to|have to|needs to|need to|got to)\s+(?!(?:have|has|support|include|come|offer|feature|provide|be|use|work|do|not|never|cost|ship|arrive)\b)([a-z][a-z-]*\s+.+)/i,
  /\b(?<!(?:n't|not|never|no longer)\s+)(?:i\s+)?(?:need|require)s?\s+(?:it\s+to\s+(?:have|support|be)\s+)?(?!to\b|no\b)(.+)/i,
  /\b(?:only if it|as long as it)\s+(?:has|supports|includes|is|comes with)\s+(.+)/i,
  /\b(?:with|featuring|that has|that have|which has|that supports?|which supports?|that comes with|that includes)\s+(.+)/i,
  // V2.3 (V22-02): any other relative clause states a requirement ("that packs into its own pocket", "which folds flat").
  /\b(?:that|which)\s+(?!(?:has|have|supports?|comes|includes|i|you|we|they|it'?s|is a|are a|costs?|will|would|can i|ships?|arrives?|must|should|needs?|has to|have to|got to|does(?:n't| not)|do(?:n't| not)|won't|will not|never)\b)((?:is|are|can|will)?\s*[a-z].+)/i,
  // V2.4: "ideally dimmable", "preferably foldable": an optional preference (NICE, never blocks), never an uninterpreted word.
  /\b(?:ideally|preferably)\s+(?!with\b|a\b|an\b|the\b|under\b|below\b|around\b|less\b|in\s+(?:black|white))([a-z].+)/i,
  // V2.5: "powered by a single USB-C cable", "runs on AA batteries": the power source is a requirement.
  /\b(?:powered|charged|operated)\s+(?:by|via|over|from)\s+(.+)/i,
  /\bruns?\s+(?:on|off)\s+(.+)/i,
  /\b(?:required|essential|mandatory|non-negotiable)\s*:\s*(.+)/i,
  /(.+?)\s+(?:is|are)\s+(?:a must|required|essential|mandatory|non-negotiable)\b/i,
  /^(?:\s*(?:and|also)\s+)?(.+?)\s+(?:would be nice|would be a plus|would be great|is a plus|is a bonus|is optional|is nice to have)\b/i,
];
const EN_NOT = [
  /\b(?:without|free of)\s+(?:an?\s+|any\s+)?(.+)/i,
  /\b(?:must|should|can)\s*(?:not|n't)\s+(?:have|include|use|come with|be)\s+(.+)/i,
  /\bno\s+(.+)/i,
  // V2.10 (IW-11): "doesn't need an app subscription", "won't require a boundary wire" exclude the thing named.
  /\b(?:does(?:n't| not)|do(?:n't| not)|won't|will not|should(?:n't| not)|never)\s+(?:need|require|use|rely on)s?\s+(?:an?\s+|any\s+|the\s+)?(.+)/i,
  /\b([a-z][a-z0-9 -]{1,30})-free\b/i,
  // V2.13 (IW-13 q07): "not the one with a grill", "not a model that has a timer" exclude the feature named.
  /\bnot\s+(?:(?:the|a|an|any)\s+)?(?:one|ones|kind|model|models|version|type|variant)\s+(?:with|that\s+(?:has|have|comes\s+with|includes?))\s+(?:an?\s+|the\s+|any\s+)?(.+)/i,
];
/** Korean: "<X> 있어야/돼야/필수/꼭", adjectival "<X> 되는/지원되는/가능한/있는/달린/탑재된", negative "<X> 없는/없어야/제외". */
const KO_MUST = [/([가-힣A-Za-z0-9.+\- ]{1,24}?)\s*(?:이|가)?\s*있으면\s*좋/, /([가-힣A-Za-z0-9.+\- ]{1,24}?)\s*(?:이|가|은|는)?\s*(?:꼭\s*)?(?:있어야|되어야|돼야|지원해야|필수|반드시)/, /([가-힣A-Za-z0-9.+\-]{1,16}(?:\s[가-힣A-Za-z0-9.+\-]{1,16})?)\s*(?:기능\s*)?(?:이|가)?\s*(?:되는|지원되는|지원하는|가능한|있는|달린|탑재된|탑재)\s/];
const KO_NOT = [/([가-힣A-Za-z0-9.+\-]{1,16}(?:\s[가-힣A-Za-z0-9.+\-]{1,16})?)\s*(?:이|가)?\s*(?:없는|없어야|없이)/, /([가-힣A-Za-z0-9.+\-]{1,16})\s*제외/];

/** Phrase ends: budget, price, conditions, the next requirement, punctuation. */
const CUT = /\s+(?:with(?:out)?|that|which|featuring|under|below|less than|at most|max(?:imum)?|up to \$|budget|for (?:less|under|about|around)|and (?:it |also |under|ideally|preferably)|but|so|please|if possible|ideally|preferably|in (?:black|white|any colou?r)|from|at|by|ships?|delivered|within|for(?!\s+(?:\d|one|two|three|four|five|six|seven|eight|nine|ten)\b)|who)\b|\s+\$|[,.](?!\d)|[;!?()]|\s+\d[\d,.]*\s*(?:usd|eur|krw|dollars?|원|달러|만\s*원)\b/i;
const FILLER = /^(?:has|have|is|are|can|also|a|an|the|some|any|good|great|decent|real|proper|built-in|builtin|an? built-in|it|that|which|to have|to)\s+/i;
/** Phrases that are never a product requirement on their own. */
const NOT_REQUIREMENT = /^(?:something|anything|everything|stuff|things?|it|this|that|them|me|my|you|one|ones|more than|more|less|budget|bundles?|bundle|kit|rush|preference|returns?|refurb(?:ished)?|used|new|warranty card|price|money|cost|tax|shipping cost|one of these|limit|cap|object|issues?|problems?|questions?|doubt|matter)$/i;
const NOT_REQUIREMENT_START = /^(?:no (?:bundles?|kits?|more than|budget|rush|preference)|more than|less than|later than|earlier than|longer than|budget|price|money|cost|i |me |my |you |we |us |our |to buy|to order|to get|to pay|to spend|to know|to check|it (?:by|before|for)|bundle|bundles|kit|kits|rush|preference)\b/i;
const negatedSpec = (clause: string, idx: number) => /\b(?:without|no|not|never)\s+(?:an?\s+)?$/i.test(clause.slice(Math.max(0, idx - 20), idx));
const NUMBERISH = /^[\d\s.,$€£₩%+-]*$/;

export const slugOf = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[^a-z0-9가-힣.+]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);

function clean(raw: string): string {
  let p = raw.split(CUT)[0] ?? "";
  for (let i = 0; i < 3; i++) p = p.trim().replace(FILLER, "").replace(/\s*(?:기능)?(?:이|가|은|는|을|를|도)?$/, "");
  // V2.3: a phrase never ends in a conjunction ("burrs and" → "burrs").
  return p.replace(/\s+/g, " ").trim().split(" ").slice(0, 7).join(" ").replace(/\s+(?:and|or|plus|with|but)$/i, "").trim();
}

/** True if the phrase only restates things parsed elsewhere (category noun, attributes, brand/model, numbers). */
function onlyRestates(phrase: string, targetWords: Set<string>): boolean {
  if (!phrase || NUMBERISH.test(phrase) || phrase.length < 2) return true;
  if (NOT_REQUIREMENT.test(phrase) || NOT_REQUIREMENT_START.test(phrase)) return true;
  let rest = phrase;
  const attrs = parseAttributes(phrase);
  if (Object.keys(attrs).length) rest = rest.replace(/\b\d+(?:\.\d+)?\s?(?:gb|tb|oz|ml|l|cups?|qt|inch(?:es)?|in|")\b|\b(?:20[0-3]\d)\b/gi, " ").replace(/\b(?:of\s+)?(?:ram|memory|ssd|storage|capacity|colou?r|size)\b/gi, " ");
  const cat = requestCategory(rest);
  if (cat) rest = rest.replace(cat.request, " ");
  rest = rest.split(/\s+/).filter((w) => w && !targetWords.has(w.toLowerCase()) && !/^(?:a|an|the|of|in|and|or|for|to|one|color|colour|version|model|edition|screen|display|storage|memory|ram|capacity|size|finish)$/i.test(w)).join(" ");
  if (Object.keys(attrs).length && attrs.color) rest = rest.replace(new RegExp(`\\b${attrs.color}\\b`, "i"), " ").trim();
  return !rest.trim() || NUMBERISH.test(rest);
}

/** V2.5: words before a capability that do not narrow it (function words, quantity and intent words, negators). */
const CAP_MOD_STOP = /^(?:a|an|the|with|without|and|or|has|have|having|had|that|which|is|are|be|it|its|any|some|no|not|never|must|should|needs?|need|want|wants|require|requires|good|great|decent|nice|real|proper|built-in|builtin|also|plus|both|full|fully|supports?|offers?|includes?|features?|comes|come|got|get|buy|find|me|my|for|of|in|on|to|by|via|over|from|at|but|so|ideally|preferably|very|really|quite|reliable|solid|strong|best|better|cheap|cheapest|affordable|new|single|dual|one|two|rated|proper|charges|charge|charging|that's|it's|i|we|you|please|recommend|suggest|show|looking|look|ones?|like|such|as|than|more|less|least|most|quality|excellent|working|functional|powerful|fast|quick|rapid)$/i;
/** V2.5: parts a property applies to ("dishwasher-safe basket", "removable lid"). */
const CAP_PART = /baskets?|lids?|jars?|bowls?|trays?|carafes?|parts|pots?|blades?|cups?|containers?|tanks?|bins?|pans?|inserts?|accessories|attachments|components|cases?|shells?|housings?|body/;
/** V2.5: spans of context (lead-in before a colon, purpose phrases, relative clauses about a person). */
/** V2.10: verbs after which "up to N" is a rating the product must reach (a minimum). */
const CAPACITY_VERB = /\b(?:supports?|supporting|holds?|holding|carr(?:y|ies)|carrying|covers?|covering|seats?|seating|fits?|fitting|handles?|handling|takes?|accommodates?|lifts?|loads?|rated(?: for)?|capacity(?: of)?|runs?|lasts?|reaches|reach|charges?|stores?|serves?|cleans?|cools?|heats?|prints?|records?|mows?|tows?|pulls?|plays?|goes|go|travels?|ranges?|range of|brews?|makes?|cooks?|connects?|pairs?|users?|people|persons?|riders?)\s+(?:\w+\s+){0,2}$/i;
/** V2.11: a capacity verb right before a threshold ("removes at least 16 L a day") belongs to the threshold. */
const THRESHOLD_VERB = /^(?:supports?|holds?|carr(?:y|ies)|covers?|handles?|takes?|lifts?|runs?|lasts?|reaches|removes?|extracts?|dehumidifies|climbs?|bakes?|cooks?|mows?|prints?|serves?|stores?|charges?)$/i;
/** V2.10: words after which "up to N" is a maximum ("weighs up to 2 kg", "noise up to 40 dB"). */
const MAX_CONTEXT = /\b(?:weighs?|weighing|weight|measures?|noise|loud|loudness|costs?|thick|thickness|tall|height|wide|width|deep|depth|long|length|sized?|draws?|uses?|consumes?)\s+(?:\w+\s+){0,2}$/i;

export const PURPOSE_FOR = /^for\s+(?:(?:the\s+|a\s+)?(?:lowest|cheapest|best|least|lower|cheaper|lowest-priced|good|great|fair|reasonable|decent|total)\b|(?:\$|usd|eur|£|€|₩)|\d|(?:my|our|your|his|her|their|me|us|him|them|myself|ourselves|yourself|someone|somebody|everyone)\b|(?:the\s+|a\s+)?[\p{L}]+['’]s?\s+(?:room|bedroom|nursery|kitchen|office|house|home|apartment|flat|dorm|place|playroom)\b|(?:a|an|the|this|that|next|our|my)?\s*(?:(?:ski|beach|camping|road|business|family|weekend|holiday|summer|winter|spring|fall|autumn|christmas|birthday|wedding|anniversary|graduation|house|school|work)\s+)?(?:gift|gifts|present|presents|friend|change|while|bit|start|treat|living|price|reason|day|days|week|weeks|month|months|year|years|trip|trips|vacation|vacations|holiday|holidays|travel|traveling|travelling|commute|commuting|work|working|home|office|school|college|university|dorm|study|studying|fun|hobby|hobbies|everyday|daily|personal|occasional|regular|general|casual|light|heavy|long|short|now|later|today|tonight|tomorrow|christmas|birthday|birthdays|wedding|anniversary|graduation|party|parties|season|winter|summer|spring|fall|autumn|weekend|weekends|weekdays|mornings|evenings|nights|backup|emergencies|emergency|beginners?|learning|practice|training|exercise|fitness|gaming|streaming|reading|cooking|baking|camping|hiking|fishing|hunting|cycling|running|walking|picnics?|tailgating|events?|guests?|visitors?|family|families|kids|children|household|couple|me|use|using|sale|less|under|about|around)\b)/iu;
const CHAT_FILLER = /^(?:honestly|ugh+|lol|lmao|mostly|mainly|asap|pls|plz|kinda|sorta|probably|maybe|finally|literally|basically|actually|tbh|ngl|btw|anyway|anyways|whatever|fine|quit|died|broke|broken)$/i;
export function contextSpans(text: string, targetSpan: [number, number] | null): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const colon = /^([^:;.!?]{1,80}):\s/.exec(text);
  // V2.18: a delivery date before the colon ("Need it before the 4th of July:") is timing, not a product property.
  const dateLead = !!colon && /^(?:need(?:ed)?\s+(?:it|this|them)\s+)?(?:by|before|until|for)\s+(?:the\s+)?(?:\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?)?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|christmas|thanksgiving|easter|new year|the weekend|next week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)[a-z]*(?:\s+\d{1,2}(?:st|nd|rd|th)?)?$/i.test(colon[1]!.trim());
  if (colon && !PRODUCT_NOUN_PHRASES.test(colon[1]!) && !requestCategory(colon[1]!) && !requestCapabilities(colon[1]!).length && (!/\d/.test(colon[1]!) || dateLead)
    && !(targetSpan && targetSpan[0] < colon[1]!.length)) out.push([0, colon[0].length - 1]);
  for (const m of text.matchAll(/\bfor\s+(?:my|our|your|his|her|their|the|a|an|some)?\s*[^,;:.!?()]*/gi)) {
    let ph = m[0];
    const cut = /\s+(?:with(?:out)?|that|which|under|below|at least|at most|less than|more than|and (?:a|an|the|it|has|is)|but|max(?:imum)?|budget|ideally|preferably|please|if possible)\b/i.exec(ph);
    if (cut) ph = ph.slice(0, cut.index);
    const a = m.index!, b = a + ph.replace(/\s+$/, "").length;
    const body = ph.replace(/^for\s+/i, "");
    if (/^(?:less|under|about|around|up to|no more|at most|below|over|above|\$)/i.test(body) || /\d/.test(body) || /\b[A-Z][A-Za-z0-9]/.test(body.replace(/^(?:My|Our|Your|His|Her|Their|The|A|An)\b/, ""))) continue;
    if (/^(?:one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:people|persons?|adults|campers|users|players)\b/i.test(body) || /[$€£₩원]/.test(body) || !body.trim()) continue;
    if (targetSpan && a < targetSpan[1] && b > targetSpan[0]) continue;
    out.push([a, b]);
  }
  for (const m of text.matchAll(/\bwho\s+[^,;:.!?()]*/gi)) {
    const cut = /\s+(?:with(?:out)?|that|which|under|below|and (?:a|an|the|it)|but)\b/i.exec(m[0]);
    const ph = cut ? m[0].slice(0, cut.index) : m[0];
    out.push([m.index!, m.index! + ph.replace(/\s+$/, "").length]);
  }
  return out;
}

/** V2.2 WP-4: style adjectives. Kept as OPTIONAL preferences (never mandatory capabilities, never dropped). */
export const DECORATIVE = /^(?:stylish|sleek|beautiful|pretty|cute|elegant|modern|classic|fancy|cool|gorgeous|attractive|trendy|minimalist|minimal|aesthetic|chic|lovely|nice-looking|good-looking|fashionable|예쁜|이쁜|세련된|귀여운|멋진|깔끔한|심플한|고급스러운)$/i;
const isDecorative = (phrase: string) => phrase.split(/\s+/).filter((w) => !/^(?:and|or|very|really|a|an|the|look(?:s|ing)?|design)$/i.test(w)).every((w) => DECORATIVE.test(w));

/** Words that describe intent, price or quality, never a product property. */
const MODIFIER_STOP = new Set(`i'd i’d i'm i’m id like love would could gift birthday present thanks thank hi hello buy purchase order get find me i we want need looking look for please recommend suggest show a an the some any my our new brand-new cheap cheapest cheaper
  inexpensive affordable budget best better good great nice decent top quality reliable popular simple basic standard regular normal real genuine original authentic
  one pair two single lowest price priced total under below around about only just also very really most least it its this that these
  추천 추천해줘 추천해 사줘 사고 구매 주문 찾아줘 찾아 좋은 괜찮은 싼 저렴한 가성비 최저가 가장 제일 새 새것 정품 신품 하나 개 제품 상품 것 되는 있는 없는 이하 이상 정도 짜리 용 대 쓸 쓸만한`.split(/\s+/).filter(Boolean));

/**
 * N-01 (IW-2 regression): the words before the head product noun of the request's noun phrase ("IH pressure rice
 * cooker" → IH, pressure; "IH 압력 밥솥" → IH, 압력). Only words before a recognized product noun are returned; the caller
 * drops anything already interpreted (capabilities, attributes, the exact product, brand).
 */
function productModifiers(clause: string): Array<{ word: string; index: number }> {
  const np = clause.split(CUT)[0] ?? "";
  let head = -1;
  const en = PRODUCT_NOUN_PHRASES.exec(np);
  if (en) head = en.index;
  for (const [re] of KO_QUERY_NOUNS) { const k = re.exec(np); if (k && (head < 0 || k.index < head)) head = k.index; }
  const cat = requestCategory(np);
  if (cat) { const c = new RegExp(cat.request.source, cat.request.flags.replace("g", "")).exec(np); if (c && (head < 0 || c.index < head)) head = c.index; }
  if (head <= 0) return [];
  const out: Array<{ word: string; index: number }> = [];
  for (const t of np.slice(0, head).matchAll(/[가-힣A-Za-z0-9][가-힣A-Za-z0-9.+'’-]*/g)) {
    const word = t[0].replace(/(?:이|가|은|는|을|를|의|도)$/, "").replace(/[’']s$/, "");
    const lw = word.toLowerCase();
    if (word.length < 2 && !/[가-힣]/.test(word)) continue;
    if (MODIFIER_STOP.has(lw) || GENERIC_WORDS.has(lw) || NUMBERISH.test(word) || /\d/.test(word)) continue;
    if (/^(?:oz|fl|gb|tb|mb|inch(?:es)?|in|ml|l|liters?|litres?|qt|cups?|pack|pk|w|watts?|mah|hz|mm|cm|kg|g|lbs?|ft|인치|리터|인분|구|와트)$/i.test(word)) continue; // units of an attribute
    out.push({ word, index: t.index! });
  }
  return out;
}

/**
 * All requirements stated in `text`. `targetSpan` is the exact product phrase (its words are the product, not a
 * requirement). Structured must-haves from the caller are added as recognized MUST items (they can only add).
 */
/** V2.7: "for 13-inch posters" after a named standalone product sizes the object it is for, not the product itself. */
export const OBJECT_SIZE = /\bfor\s+(?:(?:my|our|the|a|an|some)\s+)?(\d+(?:\.\d+)?)\s?-?\s?(inch(?:es)?|in\b|"|cm|mm)\s*([a-z]{3,}(?:\s+[a-z]{3,})?)/gi;
export function extractRequirements(text: string, targetSpan: [number, number] | null, targetWords: string[] = [], structured: { mustHave?: string[]; niceToHave?: string[] } = {}, opts: { objectSizes?: boolean } = {}): StatedRequirement[] {
  const out: StatedRequirement[] = [];
  const tw = new Set(targetWords.flatMap((w) => w.toLowerCase().split(/\s+/)).filter(Boolean));
  const inTarget = (abs: number) => !!targetSpan && abs >= targetSpan[0] && abs < targetSpan[1];
  // V2.5: context the user gives about the purchase is not a product requirement: a lead-in before a colon ("gift for
  // my dad who commutes by bike:", "something simple:"), a purpose phrase ("for my studio apartment", "for video calls
  // from home", "for travel") and a relative clause about a person ("who commutes by bike"). It is kept as an optional
  // CONTEXT row (shown, never verified, never blocking). A "for" phrase with a number or a capitalized name ("for 2
  // people", "for a 15-inch laptop", "for my Wynd Beacon") is a requirement or an accessory target, not context.
  // V2.19: a "for" phrase that is not a person's own use or a listed occasion is a requirement, not context: its words
  // are never hidden as context (they are checked below and by the word accounting).
  const allCtx = contextSpans(text, targetSpan);
  const ctx = allCtx.filter(([a, b]) => !(/^for\s+\S/i.test(text.slice(a, b)) && !PURPOSE_FOR.test(text.slice(a, b))));
  const fitFor = allCtx.filter((x) => !ctx.includes(x));
  const inCtx = (s: [number, number]) => ctx.some(([a, b]) => s[0] >= a && s[1] <= b);
  const add = (r: StatedRequirement) => {
    if (r.source === "REQUEST_TEXT" && r.note !== "CONTEXT" && inCtx(r.span)) return;
    const same = out.find((x) => x.key === r.key);
    if (!same) { out.push(r); return; }
    if (same.strength === "NICE" && r.strength === "MUST") Object.assign(same, r); // MUST wins over NICE for the same item
  };
  // V2.18 (IW-18 d06/q07/d30): "for a/an/the <thing>" names what the product must fit or suit ("for an in-ground
  // pool", "for a 7 year old"): a must-have research has to confirm, never background. Only a person's own
  // ("for my dad", "for our studio") or an article-less use ("for travel", "for video calls") stays context.
  for (const [a, b] of fitFor) { const t = text.slice(a, b); out.push({ key: `unrecognized:${slugOf(t)}`, text: t, span: [a, b], recognized: false, capability: null, polarity: "REQUIRED", strength: "MUST", source: "REQUEST_TEXT" }); }
  for (const [a, b] of ctx) {
    const t = text.slice(a, b);
    // V2.19 (IW-19 d06/q02/d08): with or without an article, "for <thing>" is a fitment or audience requirement
    // ("for bare roof rails", "for e-bikes"); only a person's own use and a closed list of occasions and uses stay context.
    if (/^for\s+\S/i.test(t) && !PURPOSE_FOR.test(t))
      add({ key: `unrecognized:${slugOf(t)}`, text: t, span: [a, b], recognized: false, capability: null, polarity: "REQUIRED", strength: "MUST", source: "REQUEST_TEXT" });
    else add({ key: `context:${slugOf(t)}`, text: t, span: [a, b], recognized: false, capability: null, polarity: "REQUIRED", strength: "NICE", source: "REQUEST_TEXT", note: "CONTEXT" });
  }
  let offset = 0;
  let prevTriggered = false;
  for (const clause of text.split(/(?<=[;!?])\s*|(?<=:)\s+|(?<=\.)(?!\d)\s*|(?<=,)(?!\d{3}(?!\d))\s*|\s+(?=but\b)|\s+and\s+(?=(?:a|an|the|it|ideally|preferably|must|should|with|without|no|has|have|supports?|includes?|comes with|offers?|features?)\b)|\s+(?=(?:그리고|하지만)\s)/i)) {
    if (!clause.trim()) continue;
    const at = Math.max(0, text.indexOf(clause, offset)); offset = at + clause.length;
    const strength: RequirementStrength = NICE.test(clause) ? "NICE" : "MUST";
    // 1. Recognized capabilities, with negation governing them ("without noise cancelling", "no ANC", "노캔 없는").
    const recognizedSpans: Array<[number, number]> = [];
    for (const c of requestCapabilities(clause)) {
      const abs = at + c.index;
      recognizedSpans.push([c.index, c.end]);
      if (inTarget(abs)) continue;
      // V2.2 WP-4: in an exact-product request, a capability word inside the category noun right after the product
      // ("Brix T18 cordless drill") names the category, not a requirement: the exact model fixes the product.
      if (targetSpan && abs >= targetSpan[1]) {
        const np = new RegExp(`^\\s*(?:${PRODUCT_NOUN_PHRASES.source})`, "i").exec(text.slice(targetSpan[1]));
        if (np && abs < targetSpan[1] + np[0].length && /^\s*$/.test(text.slice(targetSpan[1], abs).replace(/\S+$/, "").replace(/^\s+/, ""))) {
          add({ key: `category:${slugOf(clause.slice(c.index, c.end))}`, text: clause.slice(c.index, c.end), span: [abs, at + c.end], recognized: false, capability: null, polarity: "REQUIRED", strength: "NICE", source: "REQUEST_TEXT", note: "CATEGORY_WORD" });
          continue;
        }
      }
      const before = clause.slice(Math.max(0, c.index - 30), c.index);
      const after = clause.slice(c.end, c.end + 8);
      const negated = /\b(?:[a-z]+n['’]t|without|no|not|never|free of|must not have|mustn't have|doesn't need|don't need|do not need)\s+(?:an?\s+|any\s+)?(?:\w+\s+){0,1}$/i.test(before) || /^\s*(?:이|가)?\s*(?:없는|없어야|없이|제외)/.test(after);
      const words = clause.slice(c.index, c.end);
      // V2.3 (V22-01): a spec number written right before a capability ("90W USB-C charging", "4000 mAh battery")
      // narrows it. The number is never dropped: the numbered phrase is its own MUST proposition (the capability alone
      // would accept a 65 W product).
      const spec = /(\d+(?:\.\d+)?\s?-?(?:w|watts?|mah|wh|hz|mbps|gbps|inch(?:es)?|in|"|v|a|mm|cm|kg|lbs?|ml|l|oz|k|p|fps|db|nits))\s*-?\s*$/i.exec(clause.slice(Math.max(0, c.index - 14), c.index));
      if (spec && !/^(?:battery|keeps_cold)_/.test(c.id)) {
        const phrase = `${spec[1]!.replace(/\s+/g, "")} ${words}`;
        const sAbs = at + c.index - spec[0].length;
        add({ key: `unrecognized:${slugOf(phrase)}`, text: phrase, span: [sAbs, at + c.end], recognized: false, capability: null, polarity: negatedSpec(clause, c.index - spec[0].length) ? "EXCLUDED" : "REQUIRED", strength, source: "REQUEST_TEXT" });
      }
      // V2.5: an adjective right before the capability narrows it ("native 4K", "true wireless"): the phrase is its own
      // MUST proposition (the capability alone would accept upscaled 4K). A part noun right after it ("dishwasher-safe
      // basket", "waterproof case") says where the property applies; it is part of the requirement's words.
      const adj = /(?:^|[\s(])([a-z][a-z-]{2,})\s+$/i.exec(clause.slice(Math.max(0, c.index - 24), c.index));
      if (adj && !negated && !spec && !/^(?:battery|keeps_cold)_/.test(c.id) && /(?:ive|al|ic|able|ible|ful|less|proof|ous|ary|ent|ant)$/i.test(adj[1]!) && !CAP_MOD_STOP.test(adj[1]!) && !parseAttributes(adj[1]!).color && !/^[A-Z]/.test(adj[1]!) && !GENERIC_WORDS.has(adj[1]!.toLowerCase()) && !requestCapabilities(adj[1]!).length && !requestCategory(adj[1]!) && !isDecorative(adj[1]!)) {
        const phrase = `${adj[1]} ${words}`;
        const s0 = at + clause.lastIndexOf(adj[1]!, c.index);
        if (!inTarget(s0)) add({ key: `unrecognized:${slugOf(phrase)}`, text: phrase, span: [s0, at + c.end], recognized: false, capability: null, polarity: "REQUIRED", strength, source: "REQUEST_TEXT" });
      }
      const part = new RegExp(`^(?:[- ]?safe)?\\s+(${CAP_PART.source})\\b`, "i").exec(clause.slice(c.end));
      const cEnd = part ? c.end + part[0].length : c.end;
      if (negated) add({ key: `not:${c.id}`, text: words, span: [abs, at + cEnd], recognized: true, capability: c.id, polarity: "EXCLUDED", strength, source: "REQUEST_TEXT" });
      else add({ key: c.id, text: words, span: [abs, at + cEnd], recognized: true, capability: c.id, polarity: "REQUIRED", strength, source: "REQUEST_TEXT" });
    }
    // 2. Requirement phrases the vocabulary does not cover.
    const tryPhrase = (m: RegExpExecArray | null, polarity: RequirementPolarity) => {
      if (!m || m[1] === undefined) return;
      const rawStart = m.index + Math.max(0, m[0].indexOf(m[1]));
      const phrase = clean(m[1]);
      if (!phrase) return;
      const pIdx = clause.indexOf(phrase, Math.max(0, rawStart - 1));
      const relStart = pIdx >= 0 ? pIdx : rawStart;
      const abs = at + relStart;
      if (inTarget(abs)) return;
      // V2.3: "Wi-Fi 7 and 10 Gb Ethernet", "multipoint and a lanyard loop" state several requirements; each is handled
      // on its own (a recognized capability in one part never swallows an unfamiliar requirement in another, and a page
      // stating one part must not verify a joined phrase).
      const parts: Array<{ text: string; at: number }> = [];
      for (const m of phrase.matchAll(/(?:[^,]|,(?=\d{3}))+?(?=\s+(?:and|plus|&)\s+|,(?!\d{3})\s*|$)/g)) {
        const tx = clean(m[0].replace(/^\s*(?:and|plus|&)\s+/i, "").trim());
        if (tx) parts.push({ text: tx, at: phrase.indexOf(tx, m.index!) });
      }
      const pieces = parts.length > 1 && parts.every((x) => x.text.split(/\s+/).length <= 5) ? parts : [{ text: phrase, at: 0 }];
      for (const piece of pieces) {
        const rel = relStart + piece.at;
        // Covered by a recognized capability inside the piece → already handled above.
        if (recognizedSpans.some(([s, e]) => s < rel + piece.text.length && e > rel)) continue;
        if (requestCapabilities(piece.text).length) continue;
        if (onlyRestates(piece.text, tw)) continue;
        // V2.4: a numeric threshold is extracted on its own (number, unit and direction); a verb that only introduces a
        // measurement ("weighs less than 1.2 kg", "outputs at least 500 W") is not a requirement by itself.
        if (/^(?:at least|at most|no less than|no more than|more than|less than|over|above|under|below|up to|minimum|maximum)\b/i.test(piece.text)) continue;
        if (/\d[^]*\bor\s+(?:more|higher|greater|above|better|less|lower|fewer|below|under)$/i.test(piece.text)) continue;
        if (/^(?:weighs?|weighing|measures?|outputs?|delivers?|offers?|runs?|lasts?|holds?|stores?|draws?|produces?|rated|reaches|reach|gets?|has|have|is|are|be)$/i.test(piece.text)) continue;
        const a = abs + piece.at;
        // V2.4: "empties itself" / "cleans itself" is how a spec sheet says "self-emptying" / "self-cleaning".
        const said = piece.text.replace(/\b([a-z]+?)(ies|es|s) itself\b/gi, (_, st: string, suf: string) => `self-${suf.toLowerCase() === "ies" ? `${st}y` : st}ing`);
        const key = `${polarity === "EXCLUDED" ? "not" : "unrecognized"}:${slugOf(said)}`;
        const decorative = polarity === "REQUIRED" && isDecorative(piece.text);
        add({ key, text: piece.text, span: [a, a + piece.text.length], recognized: false, capability: null, polarity, strength: decorative ? "NICE" : strength, source: "REQUEST_TEXT", ...(decorative ? { note: "DECORATIVE" as const } : {}) });
      }
    };
    // V2.3: numeric thresholds ("at least 30 grind settings", "quieter than 30 dB", "over 300 m3/h") are their own
    // MUST propositions; the number and its direction are never dropped (see thresholdStatement in capabilities.ts).
    for (const t of clause.matchAll(/\b(at least|minimum(?: of)?|no less than|more than|over|above|at most|no more than|less than|under|below|up to|maximum(?: of)?|(?:quiet|light|small|thin|short)er than|(?:big|bigg|long|larg|bright|fast|strong|high)er than)\s+(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*([a-z%][a-z0-9/%]*(?:\s+(?!(?:and|or|under|with|that|which|who|for|to|can|could|is|are|it|and|but|so|from|at|in|on|of)\b)[a-z]+){0,2})/gi)) {
      if (recognizedSpans.some(([s, e]) => s <= t.index! + t[0].length && e >= t.index!)) continue;
      let dir: "at-most" | "at-least" | "up-to" = /^(?:at most|no more than|less than|under|below|up to|maximum|(?:quiet|light|small|thin|short)er than)/i.test(t[1]!) ? "at-most" : "at-least";
      // V2.10 (IW-11): "up to N" states a bound whose direction comes from the verb before it. After a capacity or
      // ability verb ("supports up to 180 kg", "covers up to 1,200 m²", "runs up to 60 minutes") it is the rating the
      // product must reach: a minimum. After a size, weight or noise word ("weighs up to 2 kg") it is a maximum. With
      // neither, the direction is unclear and the bound must be met exactly (fail closed: never read as a maximum).
      if (/^up to$/i.test(t[1]!)) {
        const before = clause.slice(Math.max(0, t.index! - 40), t.index!);
        if (CAPACITY_VERB.test(before)) dir = "at-least";
        else if (!MAX_CONTEXT.test(before)) dir = "up-to";
      }
      const unit = t[3]!.trim().replace(/\s*(?:\s(?:a|per|each)\s|\/)\s*(day|hour|week|month)$/i, " $1").replace(/\s+(?:a|per|each|on|in|at|its|of|the)$/i, "").replace(/%/g, "percent");
      const phrase = `${dir === "at-most" ? "at most" : dir === "at-least" ? "at least" : "up to"} ${t[2]!.replace(/,/g, "")} ${unit}`;
      const abs = at + t.index!;
      if (inTarget(abs)) continue;
      add({ key: `unrecognized:${slugOf(phrase)}`, text: t[0], span: [abs, abs + t[0].length], recognized: false, capability: null, polarity: "REQUIRED", strength, source: "REQUEST_TEXT" });
    }
    // V2.5: "20,000 mAh or more", "100 W or higher", "40 dB or less" are thresholds too.
    for (const t of clause.matchAll(/(?<![\w.,$€£₩])(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*([a-z%][a-z0-9/%]*(?:\s+(?!or\b)[a-z]+)?)\s+or\s+(more|higher|greater|above|better|less|lower|fewer|below|under)\b/gi)) {
      if (recognizedSpans.some(([s, e]) => s <= t.index! + t[0].length && e >= t.index!)) continue;
      const dir = /^(?:less|lower|fewer|below|under)$/i.test(t[3]!) ? "at-most" : "at-least";
      const phrase = `${dir === "at-most" ? "at most" : "at least"} ${t[1]!.replace(/,/g, "")} ${t[2]!.trim()}`;
      const abs = at + t.index!;
      if (inTarget(abs)) continue;
      add({ key: `unrecognized:${slugOf(phrase)}`, text: t[0], span: [abs, abs + t[0].length], recognized: false, capability: null, polarity: "REQUIRED", strength, source: "REQUEST_TEXT" });
    }
    // V2.11 (IW-11 fix order item 5): a capacity verb with a number ("handles 45% slopes", "removes 16 L a day",
    // "covers 1,000 m² lawns") states a rating the product must reach: a minimum, with the measured noun kept.
    for (const t of clause.matchAll(/\b(handles?|removes?|extracts?|dehumidifies|climbs?|covers?|supports?|holds?|carr(?:y|ies)|lifts?|bakes?|cooks?|mows?|serves?)\s+(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*(%|[a-z][a-z0-9²³]*)(?:(?:\s+(?:a|per|each)\s+|\s*\/\s*)(day|hour|week))?(?:\s+(?!(?:and|or|but|with|for|under|that|which|of)\b)([a-z]+))?/gi)) {
      const abs = at + t.index!;
      if (inTarget(abs) || recognizedSpans.some(([s, e]) => s <= t.index! + t[0].length && e >= t.index!) || out.some((r) => r.span[0] <= abs && abs < r.span[1])) continue;
      const unit = t[3] === "%" ? "percent" : t[3]!.toLowerCase();
      if (!/^(?:percent|l|liters?|litres?|kg|lbs?|m2|m²|sq|km|mi|miles?|cups?|qt|oz|lb|people|persons?|riders?|users?|loaves|slices?)$/.test(unit)) continue;
      const phrase = ["at least", t[2]!.replace(/,/g, ""), unit.replace("m²", "m2"), t[4] ?? "", t[5] ?? ""].filter(Boolean).join(" ");
      add({ key: `unrecognized:${slugOf(phrase)}`, text: t[0], span: [abs, abs + t[0].length], recognized: false, capability: null, polarity: "REQUIRED", strength, source: "REQUEST_TEXT" });
    }
    // "for a lawn of 1,000 m²", "for a room up to 40 m²": the area the product must cover (a minimum).
    for (const t of clause.matchAll(/\bfor\s+(?:a|an|my|our|the)?\s*(lawns?|gardens?|yards?|rooms?|spaces?|areas?|basements?|homes?)\s+(?:of|up to|around|about)\s+(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(m2|sq\s?ft|sqft|square (?:meters|metres|feet))/gi)) {
      const abs = at + t.index!;
      if (inTarget(abs) || out.some((r) => r.span[0] <= abs && abs < r.span[1])) continue;
      const phrase = `at least ${t[2]!.replace(/,/g, "")} ${t[3]!.replace(/\s+/g, "").toLowerCase()} ${t[1]!.toLowerCase()}`;
      add({ key: `unrecognized:${slugOf(phrase)}`, text: t[0], span: [abs, abs + t[0].length], recognized: false, capability: null, polarity: "REQUIRED", strength, source: "REQUEST_TEXT" });
    }
    // V2.5: an ingress rating ("IPX7", "IP68") is a stated property, verified by the same rating on the page.
    for (const t of clause.matchAll(/(?<![\w-])(IPX?\d{1,2})(?![\w-])/gi)) {
      const abs = at + t.index!;
      if (inTarget(abs) || recognizedSpans.some(([s, e]) => s <= t.index! && e >= t.index! + t[0].length)) continue;
      add({ key: `unrecognized:${t[1]!.toLowerCase()}`, text: t[0], span: [abs, abs + t[0].length], recognized: false, capability: null, polarity: negatedSpec(clause, t.index!) ? "EXCLUDED" : "REQUIRED", strength, source: "REQUEST_TEXT" });
    }
    // V2.3: a spec token before a product noun ("100W charger", "4000mAh power bank") is a MUST proposition.
    for (const t of clause.matchAll(/(?<![\w.,$€£₩])(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s?(w|watts?|mah|wh|hz|mbps|gbps|nits|db)\b/gi)) {
      const abs = at + t.index!;
      if (inTarget(abs) || recognizedSpans.some(([s, e]) => s <= t.index! + t[0].length && e >= t.index!) || out.some((r) => r.span[0] <= abs && abs < r.span[1])) continue;
      const phrase = `${t[1]!.replace(/,/g, "")}${t[2]!.toLowerCase()}`;
      add({ key: `unrecognized:${slugOf(phrase)}`, text: t[0]!, span: [abs, abs + t[0].length], recognized: false, capability: null, polarity: "REQUIRED", strength, source: "REQUEST_TEXT" });
    }
    // V2.4: a stated capacity ("for two people", "for 4 persons") is a requirement ("2-person"), never dropped.
    for (const t of clause.matchAll(/\bfor\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:people|persons?|adults|campers|users|players)\b/gi)) {
      const abs = at + t.index!;
      if (inTarget(abs)) continue;
      const n = digitsForCounts(`${t[1]} person`).split(" ")[0];
      add({ key: `unrecognized:${n}-person`, text: t[0], span: [abs, abs + t[0].length], recognized: false, capability: null, polarity: "REQUIRED", strength, source: "REQUEST_TEXT" });
    }
    // V2.7: a size of the object a named product is for ("LM-13 laminator for 13-inch posters") is a verifiable
    // proposition about the product ("13-inch posters"), never a size attribute the listing must carry.
    if (opts.objectSizes) for (const t of clause.matchAll(OBJECT_SIZE)) {
      const abs = at + t.index!;
      if (inTarget(abs) || !targetSpan || abs < targetSpan[1]) continue;
      const unit = /^in/i.test(t[2]!) || t[2] === '"' ? "inch" : t[2]!.toLowerCase();
      const noun = t[3]!.split(/\s+/).filter((w) => !/^(?:and|with|under|below|that|which|but|for)$/i.test(w))[0] ?? "";
      if (!noun) continue;
      const len = t[0].indexOf(noun) + noun.length;
      add({ key: `unrecognized:${slugOf(`at-least-${t[1]}-${unit}-${noun}`)}`, text: t[0].slice(0, len), span: [abs, abs + len], recognized: false, capability: null, polarity: "REQUIRED", strength, source: "REQUEST_TEXT" });
    }
    for (const re of EN_NOT) tryPhrase(re.exec(clause), "EXCLUDED");
    for (const re of EN_MUST) tryPhrase(re.exec(clause), "REQUIRED");
    // V2.3: "with multipoint and a lanyard loop" is split before "and a"; the second part continues the requirement
    // list of the clause before it, so it is a requirement too (never silently dropped).
    const triggered = EN_MUST.some((re) => re.test(clause));
    // V2.6: "... that fits a standard deadbolt and has a keypad": a clause opening with a feature verb continues the list.
    if (!triggered && prevTriggered && /^\s*(?:(?:a|an|the)\s+[a-z]|(?:has|have|supports?|includes?|comes with|offers?|features?)\s+\S)/i.test(clause)) {
      const fake = Object.assign([clause, clause.replace(/[,;.!?]\s*$/, "")], { index: 0, input: clause }) as unknown as RegExpExecArray;
      tryPhrase(fake, "REQUIRED");
    }
    prevTriggered = triggered || (prevTriggered && /^\s*(?:a|an|the|has|have|supports?|includes?|comes with|offers?|features?)\s/i.test(clause));
    for (const re of KO_NOT) tryPhrase(re.exec(clause + " "), "EXCLUDED");
    for (const re of KO_MUST) tryPhrase(re.exec(clause + " "), "REQUIRED");
    // 3. Modifiers of the product noun that nothing above interpreted ("IH 압력 밥솥": 압력, "pressure rice cooker":
    //    pressure). A word that narrows the product is a stated requirement; it is kept as unrecognized, never dropped.
    for (const m of productModifiers(clause)) {
      const abs = at + m.index;
      // Words after the start of an exact product phrase name that product ("+ Travel Case Bundle"), not a requirement.
      if (inTarget(abs) || (targetSpan && abs >= targetSpan[0])) continue;
      if (recognizedSpans.some(([s, e]) => s < m.index + m.word.length && e > m.index)) continue;
      if (out.some((r) => r.source === "REQUEST_TEXT" && r.span[0] <= abs && abs < r.span[1])) continue;
      if (tw.has(m.word.toLowerCase()) || onlyRestates(m.word, tw) || requestCapabilities(m.word).length) continue;
      // V2.18 (IW-18 failure 8): conversation is never a product property (closed list).
      if (CHAT_FILLER.test(m.word) || (/^old$/i.test(m.word) && /\b(?:my|our|his|her|their)\s+$/i.test(clause.slice(0, m.index)))) continue;
      const decorative = DECORATIVE.test(m.word);
      add({ key: `unrecognized:${slugOf(m.word)}`, text: m.word, span: [abs, abs + m.word.length], recognized: false, capability: null, polarity: "REQUIRED", strength: decorative ? "NICE" : strength, source: "REQUEST_TEXT", ...(decorative ? { note: "DECORATIVE" as const } : {}) });
    }
  }
  // V2.4: a bare spec ("100W") inside a longer stated requirement ("the 100W solar panel") is that requirement's number,
  // not a second claim about the whole product (a 60 W fridge on the same page must not contradict it).
  for (const r of [...out]) {
    if (!/^unrecognized:\d+(?:\.\d+)?[a-z]+$/.test(r.key) || r.source !== "REQUEST_TEXT") continue;
    if (out.some((q) => q !== r && q.source === "REQUEST_TEXT" && q.note !== "CONTEXT" && (q.key.startsWith(`${r.key}-`) || /^unrecognized:at-(?:least|most)-/.test(q.key)) && q.span[0] <= r.span[0] && q.span[1] >= r.span[1])) out.splice(out.indexOf(r), 1);
  }
  // V2.10: "a range of at least 100 km": the noun before a threshold ("range of", "capacity of") names the measured
  // quantity; the threshold requirement right after it states it, so the dangling noun is not a requirement of its own.
  // V2.11: the measured noun is kept as the threshold's words ("at least 100 km" + "range"), so a page number counts
  // only next to that noun; a capacity verb before it ("removes", "handles") is part of the threshold too.
  for (const r of [...out]) {
    const tx = r.text.trim();
    const dangling = /\s(?:of|for)$/i.test(tx);
    if (r.source !== "REQUEST_TEXT" || r.recognized || !(dangling || THRESHOLD_VERB.test(tx))) continue;
    const next = out.find((q) => q !== r && q.source === "REQUEST_TEXT" && /^unrecognized:(?:at-(?:least|most)|up-to)-/.test(q.key) && q.span[0] >= r.span[1] && /^\s*$/.test(text.slice(r.span[1], q.span[0])));
    if (!next) continue;
    const noun = dangling ? tx.split(/\s+/).filter((w) => !/^(?:of|for|a|an|the|top|max|maximum|minimum|total|its|with|that|has|have)$/i.test(w)) : [];
    next.span = [r.span[0], next.span[1]];
    if (noun.length) next.key = `${next.key}-${slugOf(noun.join(" "))}`;
    out.splice(out.indexOf(r), 1);
  }
  // V2.11: a free-text phrase that only restates a threshold ("removes 16 L a day" beside "at least 16 L day") is the
  // threshold itself, not a second requirement.
  for (const r of [...out]) {
    if (r.source !== "REQUEST_TEXT" || r.recognized || /^unrecognized:(?:at-(?:least|most)|up-to)-/.test(r.key) || !/^(?:unrecognized|not):/.test(r.key)) continue;
    const num = /(\d[\d,.]*)/.exec(r.text)?.[1]?.replace(/,/g, "");
    if (!num) continue;
    if (out.some((q) => q !== r && /^unrecognized:(?:at-(?:least|most)|up-to)-/.test(q.key) && q.key.includes(`-${num}-`) && q.span[0] < r.span[1] && r.span[0] < q.span[1])) out.splice(out.indexOf(r), 1);
  }
  // V2.4: "that is good with pet hair" is one performance claim ("good with pet hair"), not "is good" plus "pet hair".
  for (const r of [...out]) {
    const ev = /^(?:(?:is|are)\s+)?((?:very\s+|really\s+)?(?:good|great|excellent|ideal|perfect|better|best|effective|great))$/i.exec(r.text);
    if (!ev || r.source !== "REQUEST_TEXT") continue;
    const next = out.filter((q) => q !== r && q.source === "REQUEST_TEXT" && q.span[0] >= r.span[1]).sort((a, b) => a.span[0] - b.span[0])[0];
    const between = next ? text.slice(r.span[1], next.span[0]) : "";
    const prep = /^\s*(with|for|at|on|against)\s+(?:a\s+|an\s+|the\s+|all\s+)?$/i.exec(between);
    out.splice(out.indexOf(r), 1);
    if (!next || !prep) continue; // a bare "is good" states nothing checkable
    out.splice(out.indexOf(next), 1);
    const phrase = `${ev[1]} ${prep[1]} ${next.text}`;
    add({ key: `unrecognized:${slugOf(phrase)}`, text: phrase, span: [r.span[0] + r.text.indexOf(ev[1]!), next.span[1]], recognized: false, capability: null, polarity: "REQUIRED", strength: next.strength === "MUST" || r.strength === "MUST" ? "MUST" : "NICE", source: "REQUEST_TEXT" });
  }
  // Structured input can ADD requirements; it can never remove or soften one stated in the text.
  for (const id of structured.mustHave ?? []) add({ key: id, text: id, span: [0, 0], recognized: true, capability: id, polarity: "REQUIRED", strength: "MUST", source: "STRUCTURED_INPUT" });
  for (const id of structured.niceToHave ?? []) if (!out.some((x) => x.key === id)) out.push({ key: id, text: id, span: [0, 0], recognized: true, capability: id, polarity: "REQUIRED", strength: "NICE", source: "STRUCTURED_INPUT" });
  // An excluded item supersedes the same capability as required ("no ANC" never asks for ANC).
  for (const x of out.filter((r) => r.polarity === "EXCLUDED" && r.capability)) {
    const i = out.findIndex((r) => r.key === x.capability && r.source === "REQUEST_TEXT");
    if (i >= 0) out.splice(i, 1);
  }
  // V2.13 (IW-13 q07): an excluded phrase supersedes the same words read as required ("not the one with a grill" never
  // asks for a grill): a stated requirement and its negation never both stand.
  for (const x of out.filter((r) => r.polarity === "EXCLUDED" && !r.capability && r.source === "REQUEST_TEXT")) {
    const i = out.findIndex((r) => r !== x && r.polarity === "REQUIRED" && r.source === "REQUEST_TEXT" && r.key === `unrecognized:${x.key.slice(4)}`);
    if (i >= 0) out.splice(i, 1);
  }
  // V2.2 WP-4: the generic proposition of each requirement.
  for (const r of out) {
    if (r.note === "CATEGORY_WORD" || r.note === "CONTEXT") { r.evidenceCapability = null; continue; }
    const cap = r.recognized && r.polarity === "REQUIRED" ? r.capability! : evidenceCapabilityOf(r.key);
    r.evidenceCapability = cap;
    r.claimType = isPerformanceClaim(cap) ? "PERFORMANCE" : "PROPERTY";
    r.proposition = `${r.polarity === "EXCLUDED" ? "has no" : "has"} ${capabilityPhrase(cap)}`;
  }
  return out;
}
