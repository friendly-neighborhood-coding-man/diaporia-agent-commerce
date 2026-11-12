/**
 * V2.3 structural guard (independent review of V2.2, recommendation 7). Every content word of a request must be
 * interpreted as identity (brand, model), a requirement, the product category, money, an attribute, the condition,
 * or a known function/intent word. A word that became none of these is reported. The decision engine treats it as an
 * open MUST item: research may still rank and compare, but never RECOMMENDs or prepares until evidence, a new
 * request, or the owner (attest or waive) settles it. This turns a whole class of extraction misses into a
 * fail-closed INVESTIGATE instead of an unsafe purchase.
 */
import { COLOR_WORDS, GENERIC_WORDS, PRODUCT_NOUN_PHRASES, parseAttributes } from "../identity/ProductIdentityExtractor.js";
import { CATEGORIES, KO_QUERY_NOUNS, requestCapabilities } from "../research/capabilities.js";
import { DECORATIVE, slugOf, type StatedRequirement } from "./Requirements.js";

/** Function words, purchase and search intent, price/objective words, quantity and politeness. Not product properties. */
const STOP = new Set(`a an the of to for with and or in on at by from into onto as is are be been being it its it's this that these those
  i me my we our us you your he she they them their his her one ones some any all each every both either neither other another such
  buy buying purchase order get getting find finding want wanting need needs needed looking look search show recommend recommendation
  suggest suggestion pick choose help please can could would should will shall may might must do does did have has had am was were
  me something anything thing things item items product products model models version versions brand brands kind type sort
  new brand-new cheap cheapest cheaper lowest low price prices priced pricing cost costs total budget max maximum min minimum limit
  under below over above less more than at most least up around about approximately roughly only just also too very really quite
  best better good great nice decent top quality reliable popular simple basic standard regular normal genuine original authentic
  deal deals value affordable inexpensive premium option options alternative alternatives same similar exact exactly specific
  if possible ideally preferably prefer preferred would like love bonus plus nice-to-have optional optionally required mandatory
  essential non-negotiable necessary needed requirement requirements must-have
  today now asap soon quickly fast shipping ship ships shipped delivery deliver delivered arrive arrives free returns return
  i'd i’d i'm i’m i've like thanks thank cheers hi hello hey gift present someone friend wife husband mom dad son daughter kid kids child children family home office work me myself
  use using used new condition unopened standalone bundle bundles bundled no not without but so then also too
  pair pairs set sets pack packs unit units piece pieces single one two three four five six seven eight nine ten
  usd eur gbp jpy krw dollar dollars euro euros won yen pound pounds bucks
  life keep keeps drinks drink safe adjustable built-in builtin setting lowest highest
  around near close range between ish dot com money object nothing else come comes came tool only travel
  isn't aren't doesn't don't won't wasn't weren't hasn't haven't cannot can't shouldn't
  weighs weigh weighing measures outputs rated draws draw uses consumes powered runs operated everyday daily
  싶어요 싶어 싶다 싶습니다 싶은데 싶네요 해요 할래 할래요 사려고 살래 좀 요
  never exceed exceeds exceeding spend spending pay paying cap capped ceiling within tops go going wins win winner matters matter important priority day days week weeks business
  size sz oz fl inch inches in cm mm gen generation colour color edition 사이즈 인치 세대 색상 컬러
  추천 추천해줘 추천해 추천해주세요 사줘 사주세요 사고 사고싶어 구매 구매해줘 구매할 주문 주문해 주문해요 주문할 주문해줘 구매해 구매해요 찾아줘 찾아 찾고 찾는 원해 원합니다 필요 필요해 필요해요
  좋은 괜찮은 싼 저렴한 가성비 최저가 가장 제일 새 새것 정품 신품 하나 개 제품 상품 것 이하 이상 정도 짜리 용 대 쓸 쓸만한 있는 없는 되는 해줘 주세요
  그리고 하지만 또는 및 꼭 반드시 무조건 가능하면 이면 으로 로 에 에서 를 을 이 가 은 는 의 도 만 와 과 랑 하고 예산 가격 원 달러 만원`.split(/\s+/).filter(Boolean));

const CONVERSATIONAL = /^(?:lol|lmao|tbh|honestly|ngl|btw|fyi|imo|basically|actually|literally|anyway|anyways|okay|ok|yeah|yep|hmm|um|uh|roommate|roommates|flatmate|neighbor|neighbour|coworker|colleague|partner|boyfriend|girlfriend|borrow|borrows|borrowing|borrowed|own|mine|keeps|keep|happy|glad|fine|died|dead|broke|broken|old|team|quick|question|questions|wondering|curious|night|weekend|morning|evening|finally|already|still|again|since|because|cause|cuz|before|after|pile|piles)$/i;
const KO_CONVERSATIONAL = /^(?:안녕하세요|안녕|감사합니다|고맙습니다|수고하세요|혹시|그냥|요즘|이번|다음|올해|(?:장마|장마철|여름|겨울|봄|가을|연말|명절|추석|설|설날|휴가|이사)(?:철)?(?:이라서요|이라서|이라|이니까|이어서|에는|엔|에|이라고|이에요|이네요|이고)?|주실|수|있나요|있을까요|될까요|부탁드려요|부탁드립니다|부탁해요)$/u;

/** V2.15 (IW-15 d04): materials ("stainless steel", "glass") describe what the product is made of: never dropped as generic. */
const MATERIAL_WORD = /^(?:stainless|steel|plastic|glass|leather|mesh|aluminium|aluminum|wood|wooden|bamboo|ceramic|titanium|carbon|cast|iron|copper|brass|silicone|cotton|wool|linen|nylon|canvas)$/i;
export interface UninterpretedWord { text: string; span: [number, number] }

/**
 * The product-type words the last call accepted only because they name the product ("power station"). The decision
 * engine requires them in a candidate's title, so they are checked, not trusted.
 */
export const productType: string[] = [];
export function uninterpretedWords(text: string, covered: Array<[number, number]>, identityWords: string[] = []): UninterpretedWord[] {
  const ident = new Set(identityWords.flatMap((w) => w.toLowerCase().split(/[\s-]+/)).filter(Boolean));
  const inCovered = (a: number, b: number) => covered.some(([s, e]) => a >= s && b <= e);
  // Spans of product nouns and category words anywhere in the text.
  const nounSpans: Array<[number, number]> = [];
  for (const m of text.matchAll(new RegExp(PRODUCT_NOUN_PHRASES.source, "gi"))) nounSpans.push([m.index!, m.index! + m[0].length]);
  for (const [re] of KO_QUERY_NOUNS) for (const m of text.matchAll(new RegExp(re.source, re.flags.replace("g", "") + "g"))) nounSpans.push([m.index!, m.index! + m[0].length]);
  for (const c of CATEGORIES) for (const m of text.matchAll(new RegExp(c.request.source, c.request.flags.replace("g", "") + "g"))) nounSpans.push([m.index!, m.index! + m[0].length]);
  for (const c of requestCapabilities(text)) nounSpans.push([c.index, c.end]);
  // V2.4: the product the request names ("portable power station", "replacement ear tips", "파워스테이션") is what the
  // catalog search and the category/identity checks are about: the last one or two words of the leading noun phrase
  // are the product type, not an unchecked requirement. Adjective-like words in it stay subject to the guard.
  const known = [...nounSpans];
  for (const np of leadingNounPhrases(text, covered)) nounSpans.push(np);
  productType.length = 0;
  for (const [a, b] of nounSpans.slice(known.length)) if (!known.some(([s, e]) => a >= s && a < e) && !covered.some(([s, e]) => a >= s && a < e)) productType.push(text.slice(a, b));
  const out: UninterpretedWord[] = [];
  // V2.13 (IW-13 d01): a signed number ("-10") or a temperature ("-10 °C", "20 degrees") that nothing interpreted is a
  // stated requirement research cannot check: it is reported (and blocks) instead of being dropped with its sign.
  for (const m of text.normalize("NFKC").matchAll(/(?<![\p{L}\p{N}.])(?:[-\u2212]\d+(?:\.\d+)?(?:\s*(?:°\s*[CF]?|℃|℉|degrees?(?:\s+(?:celsius|fahrenheit|[CF]))?)(?![\p{L}]))?|\d+(?:\.\d+)?\s*(?:°\s*[CF]?|℃|℉|degrees?(?:\s+(?:celsius|fahrenheit|[CF]))?)(?![\p{L}]))/gu)) {
    const a = m.index!, b = a + m[0].length;
    if (!covered.some(([s, e]) => a >= s && a < e) && !(/^[-\u2212]\d+$/.test(m[0]) && ident.has(m[0].replace("\u2212", "-").toLowerCase()))) out.push({ text: m[0].trim(), span: [a, b] });
  }
  const tokens = [...text.matchAll(/[\p{L}\p{N}][\p{L}\p{N}'’+.-]*/gu)];
  for (const [ti, m] of tokens.entries()) {
    // "sleek design", "modern look": the noun of a decorative phrase is decorative too.
    if (/^(?:design|look|looks|style|styling|finish|aesthetic)$/i.test(m[0]) && ti > 0 && DECORATIVE.test(tokens[ti - 1]![0])) continue;
    const raw = m[0].replace(/[.'’-]+$/, "");
    const a = m.index!, b = a + raw.length;
    const w = raw.toLowerCase().replace(/[’']s$/, "");
    const bare = w.replace(/(?:은|는|이|가|을|를|의|도|에|로|으로|와|과|만|이나|나|이랑|랑|에서|까지|부터|보다|처럼|용)$/u, "");
    if (!w || /^\d/.test(w) && !/[a-z가-힣]/i.test(w)) {
      // V2.14 (IW-14 i05): a bare number right after a name word, with no unit after it ("ostrevo sight 600"), may be a
      // model number that no identity parse claimed: it blocks instead of vanishing.
      const prev = tokens[ti - 1]?.[0] ?? ""; const next = tokens[ti + 1]?.[0] ?? "";
      const prevEnd = ti > 0 ? tokens[ti - 1]!.index! + prev.length : -1;
      const adjacent = prevEnd >= 0 && /^\s+$/.test(text.slice(prevEnd, a));
      if (w && /^\d+$/.test(w) && adjacent && /^[A-Za-z][a-z]+$/i.test(prev) && !STOP.has(prev.toLowerCase()) && !/^(?:size|sz|gen|generation|series|mark|mk|version|v|no|number|top|under|over|for|of|than|least|most|about|around|to|from|between|and|or|at|by|x)$/i.test(prev)
        && !(next && (Object.keys(parseAttributes(`${w} ${next}`)).length || /^(?:[a-z]{1,4}|%|°.*|x|-)$/i.test(next) && next.toLowerCase() !== "or"))
        && !covered.some(([s0, e]) => a >= s0 && a < e) && !ident.has(w)) out.push({ text: raw, span: [a, b] });
      continue;
    }
    if (inCovered(a, b) || covered.some(([s, e]) => a >= s && a < e) || nounSpans.some(([s, e]) => a >= s && a < e) || nounSpans.some(([s, e]) => a >= s && b <= e)) continue;
    if (/^\d+(?:st|nd|rd|th)$/.test(w) || /^\d+(?:인분|인용|구|세대)$/.test(w) || DECORATIVE.test(w)) continue;
    if (STOP.has(w) || STOP.has(bare) || ident.has(w) || ident.has(bare) || (GENERIC_WORDS.has(w) && !MATERIAL_WORD.test(w)) || COLOR_WORDS[w] || COLOR_WORDS[bare]) continue;
    if (Object.keys(parseAttributes(raw)).length || /^\d+(?:\.\d+)?[a-z]{1,4}$/i.test(w) && Object.keys(parseAttributes(raw.replace(/(\d)([a-z])/i, "$1 $2"))).length) continue;
    // V2.16 (IW-16 d03): "sealed" is the condition only next to a condition word ("factory sealed", "new sealed",
    // "sealed box"); otherwise it describes the product ("saltwater sealed") and is checked.
    if (w === "sealed" && (/(?:factory|new|unopened|still|brand-new|in)\s*[,]?\s*$/i.test(text.slice(0, a)) || /^\s*(?:box|boxed|package|packaging|pack|in\s+(?:box|package))\b/i.test(text.slice(b)))) continue;
    if (/^(?:refurb(?:ished)?|renewed|reconditioned|used|pre-?owned|second-hand|open-box|리퍼|중고|미개봉|새것)$/i.test(w)) continue;
    if (w.length < 2 && !/[가-힣]/.test(w)) continue;
    // V2.11 (IW-11 fix order item 7): conversation around the request ("tbh", "my roommate keeps borrowing", "Hi … team,
    // quick question", "안녕하세요", "장마철이라서요") says why or how the person asks, never what the product must be.
    if (CONVERSATIONAL.test(w) || CONVERSATIONAL.test(bare) || KO_CONVERSATIONAL.test(w)) continue;
    out.push({ text: raw, span: [a, b] });
  }
  return out;
}

const ADJ_LIKE = /(?:ing|able|ible|ful|less|proof|ous|ive|al|ic|ish|ed|y)$/i;
/** Spans of the product-type words: the last one or two words before the first function word, number or punctuation. */
function leadingNounPhrases(text: string, covered: Array<[number, number]>): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const words = [...text.matchAll(/[\p{L}\p{N}][\p{L}\p{N}'’+.-]*/gu)];
  let run: RegExpMatchArray[] = [];
  const flush = () => {
    const content = run.filter((w) => !STOP.has(w[0].toLowerCase()));
    // Only a phrase of ordinary nouns: the head (last word) and one noun before it ("power station", "ear tips").
    const tail = content.slice(-2).filter((w, i, a) => i === a.length - 1 || !ADJ_LIKE.test(w[0]));
    for (const w of tail) if (!/\d/.test(w[0]) && !ADJ_LIKE.test(w[0]) && !/[가-힣]/.test(w[0])) out.push([w.index!, w.index! + w[0].length]);
  };
  for (const w of words) {
    const lw = w[0].toLowerCase();
    const inCov = covered.some(([s, e]) => w.index! >= s && w.index! < e);
    const fn = /^(?:with|without|that|which|for|under|below|over|above|at|and|or|but|in|on|to|from|by|than|is|are|can|must|should|ideally|preferably|max|budget|less|more)$/.test(lw);
    if (fn || /^\d/.test(lw)) { if (run.length) { flush(); return out; } continue; }
    // V2.5: a covered capability before the noun ("a USB-C rechargeable lantern") does not end an article-only run.
    if (inCov) { if (run.some((x) => !STOP.has(x[0].toLowerCase()))) { flush(); return out; } run = []; continue; }
    run.push(w);
    const after = text.slice(w.index! + w[0].length, w.index! + w[0].length + 1);
    if (/[,;.!?()]/.test(after)) { flush(); return out; }
  }
  if (run.length) flush();
  return out;
}

/** Gate key (without "must:") for an uninterpreted word. */
export const uninterpretedKey = (text: string) => `uninterpreted:${slugOf(text)}`;

/** Ledger rows for uninterpreted words: MUST, unrecognized, from the request text. */
export function uninterpretedStated(words: UninterpretedWord[] | undefined): StatedRequirement[] {
  return (words ?? []).map((u) => ({ key: uninterpretedKey(u.text), text: u.text, span: u.span, recognized: false, capability: null, polarity: "REQUIRED", strength: "MUST", source: "REQUEST_TEXT" }));
}
