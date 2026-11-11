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
  gift present someone friend wife husband mom dad son daughter kid kids child children family home office work me myself
  use using used new condition sealed unopened standalone bundle bundles bundled no not without but so then also too
  pair pairs set sets pack packs unit units piece pieces single one two three four five six seven eight nine ten
  usd eur gbp jpy krw dollar dollars euro euros won yen pound pounds bucks
  life keep keeps drinks drink safe adjustable built-in builtin setting lowest highest
  around near close range between ish dot com money object nothing else come comes came tool only travel
  never exceed exceeds exceeding spend spending pay paying cap capped ceiling within tops go going wins win winner matters matter important priority day days week weeks business
  size sz oz fl inch inches in cm mm gen generation colour color edition 사이즈 인치 세대 색상 컬러
  추천 추천해줘 추천해 추천해주세요 사줘 사주세요 사고 사고싶어 구매 구매해줘 구매할 주문 주문해줘 찾아줘 찾아 찾고 찾는 원해 원합니다 필요 필요해 필요해요
  좋은 괜찮은 싼 저렴한 가성비 최저가 가장 제일 새 새것 정품 신품 하나 개 제품 상품 것 이하 이상 정도 짜리 용 대 쓸 쓸만한 있는 없는 되는 해줘 주세요
  그리고 하지만 또는 및 꼭 반드시 무조건 가능하면 이면 으로 로 에 에서 를 을 이 가 은 는 의 도 만 와 과 랑 하고 예산 가격 원 달러 만원`.split(/\s+/).filter(Boolean));

export interface UninterpretedWord { text: string; span: [number, number] }

export function uninterpretedWords(text: string, covered: Array<[number, number]>, identityWords: string[] = []): UninterpretedWord[] {
  const ident = new Set(identityWords.flatMap((w) => w.toLowerCase().split(/[\s-]+/)).filter(Boolean));
  const inCovered = (a: number, b: number) => covered.some(([s, e]) => a >= s && b <= e);
  // Spans of product nouns and category words anywhere in the text.
  const nounSpans: Array<[number, number]> = [];
  for (const m of text.matchAll(new RegExp(PRODUCT_NOUN_PHRASES.source, "gi"))) nounSpans.push([m.index!, m.index! + m[0].length]);
  for (const [re] of KO_QUERY_NOUNS) for (const m of text.matchAll(new RegExp(re.source, re.flags.replace("g", "") + "g"))) nounSpans.push([m.index!, m.index! + m[0].length]);
  for (const c of CATEGORIES) for (const m of text.matchAll(new RegExp(c.request.source, c.request.flags.replace("g", "") + "g"))) nounSpans.push([m.index!, m.index! + m[0].length]);
  for (const c of requestCapabilities(text)) nounSpans.push([c.index, c.end]);
  const out: UninterpretedWord[] = [];
  for (const m of text.matchAll(/[\p{L}\p{N}][\p{L}\p{N}'’+.-]*/gu)) {
    const raw = m[0].replace(/[.'’-]+$/, "");
    const a = m.index!, b = a + raw.length;
    const w = raw.toLowerCase().replace(/[’']s$/, "");
    const bare = w.replace(/(?:은|는|이|가|을|를|의|도|에|로|으로|와|과|만|이나|나|이랑|랑|에서|까지|부터|보다|처럼|용)$/u, "");
    if (!w || /^\d/.test(w) && !/[a-z가-힣]/i.test(w)) continue; // bare numbers belong to money/attributes
    if (inCovered(a, b) || covered.some(([s, e]) => a >= s && a < e) || nounSpans.some(([s, e]) => a >= s && a < e) || nounSpans.some(([s, e]) => a >= s && b <= e)) continue;
    if (/^\d+(?:st|nd|rd|th)$/.test(w) || /^\d+(?:인분|인용|구|세대)$/.test(w) || DECORATIVE.test(w)) continue;
    if (STOP.has(w) || STOP.has(bare) || ident.has(w) || ident.has(bare) || GENERIC_WORDS.has(w) || COLOR_WORDS[w] || COLOR_WORDS[bare]) continue;
    if (Object.keys(parseAttributes(raw)).length || /^\d+(?:\.\d+)?[a-z]{1,4}$/i.test(w) && Object.keys(parseAttributes(raw.replace(/(\d)([a-z])/i, "$1 $2"))).length) continue;
    if (/^(?:refurb(?:ished)?|renewed|reconditioned|used|pre-?owned|second-hand|open-box|리퍼|중고|미개봉|새것)$/i.test(w)) continue;
    if (w.length < 2 && !/[가-힣]/.test(w)) continue;
    out.push({ text: raw, span: [a, b] });
  }
  return out;
}

/** Gate key (without "must:") for an uninterpreted word. */
export const uninterpretedKey = (text: string) => `uninterpreted:${slugOf(text)}`;

/** Ledger rows for uninterpreted words: MUST, unrecognized, from the request text. */
export function uninterpretedStated(words: UninterpretedWord[] | undefined): StatedRequirement[] {
  return (words ?? []).map((u) => ({ key: uninterpretedKey(u.text), text: u.text, span: u.span, recognized: false, capability: null, polarity: "REQUIRED", strength: "MUST", source: "REQUEST_TEXT" }));
}
