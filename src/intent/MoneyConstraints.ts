/**
 * V2.2 WP-1 (H-1): explicit money constraints parsed from the request text.
 *
 * Every amount the request states is represented, never dropped: a constraint with currency, lower and upper bound
 * (integer minor units), inclusive/exclusive semantics, the original text span and its provenance. Anything that looks
 * like money but cannot be read safely (no currency, an unsupported currency, an approximate amount, two currencies,
 * an inconsistent range, "pounds" that may be weight) becomes an explicit ambiguity, which HOLDs the decision and
 * blocks payment preparation until the human owner confirms a budget.
 *
 * Nothing is ever converted between currencies: no verified conversion policy exists in this product.
 * Deterministic, no network, no LLM.
 */
import { CURRENCY_EXPONENT, MAX_MINOR, isCurrency, type Currency } from "../domain/money.js";

export type MoneyProvenance = "REQUEST_TEXT" | "REQUEST_TEXT_STRUCTURED_CURRENCY" | "STRUCTURED_INPUT";
export interface MoneyConstraint {
  currency: Currency;
  lowerMinor: number | null; lowerInclusive: boolean;
  upperMinor: number | null; upperInclusive: boolean;
  /** The words of the request this constraint was read from (or "structured budgetMinor"). */
  text: string;
  span: [number, number] | null;
  provenance: MoneyProvenance;
  /** How the bound was read: an explicit limit word, a range, or an amount with no limit word (read as a maximum). */
  basis: "LIMIT_WORD" | "RANGE" | "UNQUALIFIED_AMOUNT_AS_MAXIMUM" | "APPROXIMATE_AMOUNT_AS_MAXIMUM" | "STRUCTURED";
}
export type MoneyAmbiguityKind = "NO_CURRENCY" | "UNSUPPORTED_CURRENCY" | "CURRENCY_CONFLICT" | "MULTIPLE_CURRENCIES" | "APPROXIMATE_AMOUNT"
  | "INCONSISTENT_RANGE" | "WEIGHT_OR_CURRENCY" | "NOT_A_TOTAL" | "UNPARSEABLE_AMOUNT";
export interface MoneyAmbiguity {
  kind: MoneyAmbiguityKind;
  text: string;
  span: [number, number] | null;
  reason: string;
  /** A bare number (no currency) the owner page may show as a reference in a currency the owner picks. */
  bareAmount?: { amount: string; multiplier: number };
}
/** Amounts that are clearly not a price limit ("$20 off", "a $50 gift card"); kept for the record, never applied. */
export interface MoneyNote { text: string; span: [number, number]; reason: string }

export interface MoneyParse {
  currency: Currency;
  currencySource: "STRUCTURED_INPUT" | "PARSED_FROM_TEXT" | "DEFAULT_USD";
  constraints: MoneyConstraint[];
  ambiguities: MoneyAmbiguity[];
  notes: MoneyNote[];
  /**
   * The combined constraint in `currency`: the lowest upper bound and the highest lower bound of all constraints.
   * null when there is none, or when a conflict makes any combination unsafe.
   */
  combined: { upperMinor: number | null; upperInclusive: boolean; lowerMinor: number | null; lowerInclusive: boolean } | null;
  /** Masked copy of the text: every money span replaced by spaces (same length), for requirement extraction. */
  masked: string;
}

// ------------------------------------------------------------------ lexicon
const PREFIX_CUR: Array<[RegExp, Currency | null, string]> = [
  [/^(?:US|U\.S\.)\s?\$$/i, "USD", "US$"], [/^USD$/i, "USD", "USD"], [/^\$$/, "USD", "$"],
  [/^€$/, "EUR", "€"], [/^EUR$/i, "EUR", "EUR"], [/^£$/, "GBP", "£"], [/^GBP$/i, "GBP", "GBP"],
  [/^₩$/, "KRW", "₩"], [/^KRW$/i, "KRW", "KRW"], [/^JPY$/i, "JPY", "JPY"],
];
const PREFIX = String.raw`(?<![A-Za-z0-9])(US\s?\$|U\.S\.\s?\$|USD\s?|C\$|CA\$|CAD\s?|A\$|AU\$|AUD\s?|NZ\$|NZD\s?|HK\$|HKD\s?|S\$|SGD\s?|MX\$|R\$|\$|€|EUR\s?|£|GBP\s?|₩|KRW\s?|¥|JPY\s?|CNY\s?|RMB\s?|CHF\s?|₹|INR\s?)`;
const NUM = String.raw`(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)`;
const MAG = String.raw`(?:\s?(k)(?![A-Za-z])|\s+(thousand)\b|\s*(만|천))?`;
const SUFFIX = String.raw`(?:\s*(us\s?dollars?|u\.s\.\s?dollars?|usd|dollars?|bucks|euros?|eur|gbp|pounds?\s+sterling|pounds?|quid|won|krw|원|달러|불|유로|파운드|엔|yen|jpy|cad|canadian\s+dollars?|aud|australian\s+dollars?|yuan|rmb|cny|chf|swiss\s+francs?|rupees?|inr)(?![A-Za-z]))?`;
const SUFFIX_CUR = (s: string): Currency | null | "POUNDS" => {
  const x = s.toLowerCase().replace(/\s+/g, " ");
  if (/^(?:us ?dollars?|u\.s\. ?dollars?|usd|dollars?|bucks|달러|불)$/.test(x)) return "USD";
  if (/^(?:euros?|eur|유로)$/.test(x)) return "EUR";
  if (/^(?:gbp|pounds? sterling|quid|파운드)$/.test(x)) return "GBP";
  if (/^pounds?$/.test(x)) return "POUNDS";
  if (/^(?:won|krw|원)$/.test(x)) return "KRW";
  if (/^(?:엔|yen|jpy)$/.test(x)) return "JPY";
  return null; // a currency this product does not support
};
const prefixCur = (p: string): Currency | null => { const t = p.trim(); for (const [re, cur] of PREFIX_CUR) if (re.test(t)) return cur; return null; };

const MENTION = new RegExp(String.raw`${PREFIX}?\s*${NUM}${MAG}${SUFFIX}`, "gi");

/** Limit words before an amount. Order matters: approximate words are checked first. */
const BEFORE: Array<[RegExp, "UPPER_EX" | "UPPER_IN" | "LOWER_IN" | "LOWER_EX" | "APPROX" | "BETWEEN" | "FROM"]> = [
  [/(?:around|about|approx(?:imately|\.)?|roughly|circa|close to|near|~|약)\s*$/i, "APPROX"],
  [/\bbetween\s*$/i, "BETWEEN"],
  [/\bfrom\s*$/i, "FROM"],
  [/(?:\bunder|\bbelow|\bless than|\bcheaper than|\blower than|\bbeneath|<)\s*$/i, "UPPER_EX"],
  [/(?:\bup to|\bat most|\bmax(?:imum)?\.?(?:\s+of)?|\bno more than|\bnot (?:more than|over|above|to exceed|exceeding)|\bnever (?:go over|exceed|spend more than)|\bwithin|\bdon'?t (?:exceed|go over|spend more than)|\bbudget(?:\s+(?:of|is|at|limit(?: of| is)?))?|\bbudget\s*[:=]|\bspend(?:ing)?(?:\s+(?:at most|up to|no more than|max(?:imum)?))?|\bcap(?:ped)?(?:\s+at)?|\blimit(?:\s+(?:of|is))?|\bceiling(?:\s+of)?|≤|<=|예산(?:은|는|이|:)?|최대|상한|최고)\s*[:=]?\s*$/i, "UPPER_IN"],
  [/(?:\bat least|\bmin(?:imum)?\.?(?:\s+of)?|\bno less than|\bstarting at|≥|>=|최소|최저)\s*[:=]?\s*$/i, "LOWER_IN"],
  [/(?:\bover|\babove|\bmore than|\bgreater than|>)\s*$/i, "LOWER_EX"],
];
/** Limit words after an amount. */
const AFTER: Array<[RegExp, "UPPER_EX" | "UPPER_IN" | "LOWER_IN" | "LOWER_EX" | "APPROX" | "BAND" | "NOT_TOTAL" | "IGNORE"]> = [
  [/^\s*(?:or so|-?ish\b|give or take|정도|쯤|내외|전후|안팎|가량)/i, "APPROX"],
  [/^\s*(?:off|discount|coupon|rebate|cash\s?back|savings?|credit|gift\s?card|voucher|할인|쿠폰|적립)/i, "IGNORE"],
  [/^\s*(?:\/\s*(?:mo|month|yr|year|wk|week)\b|(?:per|a|an|each)\s+(?:month|year|week|day)\b|monthly|yearly|annually|weekly|subscription|shipping|delivery|fee|deposit|tip|월\s|매월|월정액|배송비)/i, "NOT_TOTAL"],
  [/^\s*(?:or less|or under|or below|or cheaper|max(?:imum)?\b|tops\b|at most|at the most|budget\b|limit\b|ceiling\b|이하|까지|이내|안쪽|선에서|안으로|한도)/i, "UPPER_IN"],
  [/^\s*(?:미만|아래|보다\s*(?:싼|저렴|적게|낮))/i, "UPPER_EX"],
  [/^\s*(?:or more|or above|or over|and up\b|and above|plus\b|\+|minimum\b|at least|이상)/i, "LOWER_IN"],
  [/^\s*(?:초과|넘는|넘게|보다\s*(?:비싼|많이|높))/i, "LOWER_EX"],
  [/^\s*대(?![가-힣])/, "BAND"],
];
const RANGE_SEP = /^\s*(?:-|–|—|~|to|and|부터|에서)\s*/i;
const RANGE_TAIL = /^\s*(?:사이|사이에서|사이의|까지|정도|선)?/;

/** Units that make a bare number a quantity, never money. */
const QUANTITY_UNIT = String.raw`(?:\+|-?\s*(?:hours?|hrs?|h|cups?|oz|ounces?|weeks?|wks?|days?|months?|years?|yrs?|minutes?|mins?|watts?|w|wh|kwh|lumens?|lm|pa|kpa|nits?|gb|tb|mb|mah|inch(?:es)?|in|ft|feet|lbs?|pounds?|kg|kilograms?|grams?|g|mm|cm|m|l|liters?|litres?|ml|%|x|pack|pcs|pieces|items?|people|persons?|devices?|ports?|db|hz|khz|mph|km|miles?|steps?|users?|seats?|players?|keys?|buttons?|v|volts?|amps?|a|rpm|psi|bar|qt|quarts?|gallons?|cu|sq|°|degrees?|fps|d|p\b|k\b)\b|\s*["”'%°]|\d|\.\d)`;
const LIMIT_EN = new RegExp(String.raw`(?:^|[^A-Za-z])(under|below|less than|at most|max(?:imum)?(?: of)?|no more than|never (?:go over|exceed)|not exceed|up to|budget(?: of| is)?|within|cheaper than|cap(?:ped)? at|spend(?:ing)? (?:at most|up to)?|between|from) ?[:=]? ?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?:\s?(k)\b|\s+(thousand)\b)?(?!${QUANTITY_UNIT})`, "gi");
const LIMIT_KO = /(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?) ?(천|만|백)? ?(이하|미만|까지|이내|안쪽|아래|선에서)|(예산|최대|상한) ?[:은는이가]? ?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?) ?(천|만)?(?!\s*(?:시간|개|대|명|인치|와트|분|일|주|개월|년|%|mAh|W|kg|g|GB|TB))/g;
const KO_UNIT_BEFORE_LIMIT = /(?:시간|개|대|명|인치|와트|분|일|주|개월|년|%|mah|w|kg|g|gb|tb|원|달러|유로|파운드)\s*$/i;

// ------------------------------------------------------------------ helpers
/** Converts "1.5" × 10,000 (만) into minor units of `cur` without float error. null when not an exact minor amount or too big. */
export function amountToMinor(num: string, multiplier: number, cur: Currency): number | null {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(num.replace(/,/g, ""));
  if (!m) return null;
  const frac = m[2] ?? "";
  const scaled = BigInt(m[1]! + frac) * BigInt(multiplier) * 10n ** BigInt(CURRENCY_EXPONENT[cur]);
  const div = 10n ** BigInt(frac.length);
  if (scaled % div !== 0n) return null;
  const v = scaled / div;
  if (v > BigInt(MAX_MINOR)) return null;
  return Number(v);
}

interface Mention { start: number; end: number; text: string; num: string; mult: number; cur: Currency | null; unsupported: string | null; pounds: boolean; magnitudeKo: boolean }

function readMention(m: RegExpMatchArray): Mention | null {
  const [whole, pre, num, k, thousand, ko, suf] = m as unknown as [string, string | undefined, string, string | undefined, string | undefined, string | undefined, string | undefined];
  if (!pre && !suf) return null;
  let cur: Currency | null = null; let unsupported: string | null = null; let pounds = false;
  const curs: Array<Currency | "POUNDS" | null> = [];
  if (pre) { const c = prefixCur(pre); if (c) curs.push(c); else unsupported = pre.trim(); }
  if (suf) { const c = SUFFIX_CUR(suf); if (c) curs.push(c); else unsupported = suf.trim(); }
  if (curs.includes("POUNDS")) { if (curs.includes("GBP")) curs.splice(curs.indexOf("POUNDS"), 1); else pounds = true; }
  const real = [...new Set(curs.filter((c): c is Currency => c !== "POUNDS" && c !== null))];
  if (real.length > 1) unsupported = `${pre?.trim() ?? ""} … ${suf?.trim() ?? ""}`.trim();
  else cur = real[0] ?? null;
  const mult = k || thousand ? 1000 : ko === "만" ? 10_000 : ko === "천" ? 1000 : 1;
  const lead = whole.length - whole.trimStart().length;
  return { start: m.index! + lead, end: m.index! + whole.length, text: whole.trim(), num, mult, cur, unsupported, pounds, magnitudeKo: !!ko };
}

type Bound = "UPPER_EX" | "UPPER_IN" | "LOWER_IN" | "LOWER_EX";

/**
 * Parses every money statement of `text`. `structured` is the caller's currency (structured input). Structured
 * budgetMinor is combined by the caller (parseResearchIntent) as one more constraint: it can only tighten.
 */
export function parseMoneyConstraints(text: string, structured?: string, opts: { structuredBudget?: boolean } = {}): MoneyParse {
  const t = text.normalize("NFKC");
  const structuredCur: Currency | null = isCurrency(structured) ? structured : null;
  const constraints: MoneyConstraint[] = []; const ambiguities: MoneyAmbiguity[] = []; const notes: MoneyNote[] = [];
  const used: Array<[number, number]> = [];
  const overlaps = (a: number, b: number) => used.some(([x, y]) => a < y && b > x);

  const mentions = [...t.matchAll(MENTION)].map(readMention).filter((x): x is Mention => !!x);
  const bareAt = (s: number): { num: string; mult: number; end: number; ko: boolean } | null => {
    const r = new RegExp(String.raw`^\s*(?:${PREFIX})?\s*${NUM}${MAG}`, "i").exec(t.slice(s));
    if (!r) return null;
    return { num: r[2]!, mult: r[3] || r[4] ? 1000 : r[5] === "만" ? 10_000 : r[5] === "천" ? 1000 : 1, end: s + r[0].length, ko: !!r[5] };
  };

  for (let i = 0; i < mentions.length; i++) {
    const m = mentions[i]!;
    if (overlaps(m.start, m.end)) continue;
    const before = t.slice(Math.max(0, m.start - 40), m.start);
    let start = m.start; let end = m.end;
    let lo: { num: string; mult: number } | null = null; let hi: { num: string; mult: number } | null = null;
    let rangeCur = m.cur;
    const n = (x: string) => Number(x.replace(/,/g, ""));
    // (a) A range written with the currency only on the second end ("100-150 dollars", "10~20만원"): the first end is bare.
    const bareFirst = /(?<![\d.,$€£₩])(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*(만|천|k)?\s*(?:-|–|—|~|to|부터|에서)\s*$/i.exec(before);
    if (bareFirst) {
      const firstMult = bareFirst[2] ? (bareFirst[2] === "만" ? 10_000 : 1000) : m.mult > 1 && n(bareFirst[1]!) < n(m.num) ? m.mult : 1;
      lo = { num: bareFirst[1]!, mult: firstMult }; hi = { num: m.num, mult: m.mult };
      start = m.start - before.length + bareFirst.index!;
    } else {
      // (b) A range with the second end after this amount ("$100-$150", "$100 to 150", "between $100 and $150").
      const sep = RANGE_SEP.exec(t.slice(m.end));
      const sepOk = !!sep && (!/^\s*and\s*$/i.test(sep[0]) || /\bbetween\s*$/i.test(before));
      const b = sepOk ? new RegExp(String.raw`^(?:${PREFIX})?\s*${NUM}${MAG}`, "i").exec(t.slice(m.end + sep![0].length)) : null;
      if (b && !QUANTITY_RE.test(t.slice(m.end + sep![0].length + b[0].length))) {
        const bStart = m.end + sep![0].length;
        const next = mentions[i + 1];
        const nextIsMention = !!next && next.start >= m.end && next.start <= bStart + 1;
        if (nextIsMention && (next!.unsupported || (next!.cur && m.cur && next!.cur !== m.cur))) {
          ambiguities.push({ kind: next!.unsupported ? "UNSUPPORTED_CURRENCY" : "MULTIPLE_CURRENCIES", text: t.slice(m.start, next!.end), span: [m.start, next!.end], reason: "the two ends of the range are in different or unsupported currencies" });
          used.push([m.start, next!.end]); i++; continue;
        }
        const bMult = b[3] || b[4] ? 1000 : b[5] === "만" ? 10_000 : b[5] === "천" ? 1000 : 1;
        rangeCur = m.cur ?? (nextIsMention ? next!.cur : null);
        lo = { num: m.num, mult: m.mult === 1 && bMult > 1 && n(m.num) < n(b[2]!) ? bMult : m.mult };
        hi = { num: b[2]!, mult: bMult };
        end = nextIsMention ? Math.max(next!.end, bStart + b[0].length) : bStart + b[0].length;
        if (nextIsMention) i++;
      }
    }
    const tail = RANGE_TAIL.exec(t.slice(end))!;
    const span: [number, number] = [start, end];
    const spanText = t.slice(start, end).trim();
    used.push(span);
    const head = t.slice(Math.max(0, start - 40), start);
    const after = t.slice(end);
    if (m.unsupported) { ambiguities.push({ kind: "UNSUPPORTED_CURRENCY", text: spanText, span, reason: `"${m.unsupported}" is not a supported currency; amounts are never converted` }); continue; }
    if (m.pounds && !rangeCur) { ambiguities.push({ kind: "WEIGHT_OR_CURRENCY", text: spanText, span, reason: `"pounds" may be a weight or British pounds` }); continue; }
    const cur = rangeCur!;
    if (!cur) { ambiguities.push({ kind: "UNPARSEABLE_AMOUNT", text: spanText, span, reason: "no currency could be read" }); continue; }

    if (lo && hi) {
      const l = amountToMinor(lo.num, lo.mult, cur); const h = amountToMinor(hi.num, hi.mult, cur);
      if (l === null || h === null) { ambiguities.push({ kind: "UNPARSEABLE_AMOUNT", text: spanText, span, reason: `the amount cannot be represented in ${cur}` }); continue; }
      if (l > h) { ambiguities.push({ kind: "INCONSISTENT_RANGE", text: spanText, span, reason: "the lower end of the range is above the upper end" }); continue; }
      // V2.2: an approximate range ("10~15만원 정도") is applied conservatively: its upper end is the maximum, and no lower
      // bound is enforced. The approximation is recorded in the constraint's basis and as an assumption.
      if (/^\s*(?:정도|선)/.test(tail[0]) || BEFORE[0]![0].test(head)) { constraints.push({ currency: cur, lowerMinor: null, lowerInclusive: true, upperMinor: h, upperInclusive: true, text: spanText, span, provenance: "REQUEST_TEXT", basis: "APPROXIMATE_AMOUNT_AS_MAXIMUM" }); continue; }
      constraints.push({ currency: cur, lowerMinor: l, lowerInclusive: true, upperMinor: h, upperInclusive: true, text: (/\b(between|from)\s*$/i.exec(head)?.[1] ? /\b(between|from)\s*$/i.exec(head)![1] + " " : "") + spanText, span, provenance: "REQUEST_TEXT", basis: "RANGE" });
      continue;
    }
    const minor = amountToMinor(m.num, m.mult, cur);
    if (minor === null) { ambiguities.push({ kind: "UNPARSEABLE_AMOUNT", text: spanText, span, reason: `the amount cannot be represented in ${cur}` }); continue; }
    let kind: string | null = null;
    for (const [re, k] of BEFORE) if (re.test(head)) { kind = k; break; }
    let afterKind: string | null = null;
    for (const [re, k] of AFTER) if (re.test(after)) { afterKind = k; break; }
    if (afterKind === "IGNORE" || /(?:\bsave|\bgift\s?card(?:\s+(?:of|for|worth))?|\bcoupon(?:\s+(?:of|for))?|\bvoucher(?:\s+(?:of|for))?)\s*$/i.test(head)) {
      notes.push({ text: spanText, span, reason: "a discount, coupon or credit amount, not a price limit" }); continue;
    }
    if (afterKind === "NOT_TOTAL") { ambiguities.push({ kind: "NOT_A_TOTAL", text: spanText + after.slice(0, 16).trimEnd(), span, reason: "the amount is a recurring, shipping or fee amount, not a purchase total" }); continue; }
    // V2.2: "around $250" / "20만원 정도" is applied conservatively as the maximum (never exceeded), with an assumption.
    if (kind === "APPROX" || afterKind === "APPROX") { constraints.push({ currency: cur, lowerMinor: null, lowerInclusive: true, upperMinor: minor, upperInclusive: true, text: spanText, span, provenance: "REQUEST_TEXT", basis: "APPROXIMATE_AMOUNT_AS_MAXIMUM" }); continue; }
    if (afterKind === "BAND") {
      // "20만원대": the band from 200,000 up to (not including) the next unit of the leading digit.
      const step = amountToMinor("1", m.mult, cur)!;
      const lead = Number(m.num.replace(/,/g, ""));
      const unit = 10 ** Math.max(0, String(Math.trunc(lead)).length - 1);
      constraints.push({ currency: cur, lowerMinor: minor, lowerInclusive: true, upperMinor: minor + unit * step, upperInclusive: false, text: spanText + "대", span: [start, end + 1], provenance: "REQUEST_TEXT", basis: "RANGE" });
      continue;
    }
    if (afterKind && afterKind !== "BAND") { const w = AFTER.find(([, k]) => k === afterKind)![0].exec(after); if (w) { span[1] = end + w[0].length; used[used.length - 1] = span; } }
    const bound: Bound | null = (["UPPER_EX", "UPPER_IN", "LOWER_IN", "LOWER_EX"] as const).find((b) => b === kind) ?? (["UPPER_EX", "UPPER_IN", "LOWER_IN", "LOWER_EX"] as const).find((b) => b === afterKind) ?? null;
    if (kind === "BETWEEN" || kind === "FROM") { ambiguities.push({ kind: "UNPARSEABLE_AMOUNT", text: head.trim().split(/\s+/).pop() + " " + spanText, span, reason: "a range with only one end" }); continue; }
    if (!bound) {
      constraints.push({ currency: cur, lowerMinor: null, lowerInclusive: true, upperMinor: minor, upperInclusive: true, text: spanText, span, provenance: "REQUEST_TEXT", basis: "UNQUALIFIED_AMOUNT_AS_MAXIMUM" });
      continue;
    }
    const upper = bound.startsWith("UPPER");
    constraints.push({ currency: cur, lowerMinor: upper ? null : minor, lowerInclusive: bound === "LOWER_IN", upperMinor: upper ? minor : null, upperInclusive: bound === "UPPER_IN",
      text: [kind ? (BEFORE.find(([, k]) => k === kind)![0].exec(head)?.[0].trim() ?? "") : "", spanText, !kind && afterKind ? (AFTER.find(([, k]) => k === afterKind)![0].exec(after)?.[0].trim() ?? "") : ""].filter(Boolean).join(" "),
      span, provenance: "REQUEST_TEXT", basis: "LIMIT_WORD" });
  }

  // Bare limits with no currency marker ("max 80", "150 이하", "between 100 and 150"). With a structured currency the
  // caller stated, the number is read in that currency; otherwise it stays unresolved (never assumed to be USD).
  const masked0 = maskSpans(t, used);
  for (const m of masked0.matchAll(LIMIT_EN)) {
    const word = m[1]!;
    const at = m.index! + m[0].indexOf(word);
    if (/^Max/.test(word) && /[A-Za-z0-9]\s+$/.test(t.slice(0, at))) continue; // "AirPods Max 2", "K2 Max 3D" are model names
    const numStart = m.index! + m[0].lastIndexOf(m[2]!);
    let end = m.index! + m[0].length;
    const mult = m[3] || m[4] ? 1000 : 1;
    let hiNum: string | null = null;
    if (/^(?:between|from)$/i.test(word)) {
      const r = /^\s*(?:and|to|-|–)\s*(\d[\d,]*(?:\.\d+)?)/i.exec(masked0.slice(end));
      if (!r || new RegExp(`^${QUANTITY_UNIT}`, "i").test(masked0.slice(end + r[0].length))) continue;
      hiNum = r[1]!; end += r[0].length;
    } else {
      const r = /^\s*(?:-|–|to)\s*(\d[\d,]*(?:\.\d+)?)/i.exec(masked0.slice(end));
      if (r && new RegExp(`^${QUANTITY_UNIT}`, "i").test(masked0.slice(end + r[0].length))) continue;
    }
    const span: [number, number] = [at, end]; used.push(span);
    const spanText = t.slice(at, end).trim();
    // "up to / max / within N" names a limit of anything (minutes, devices): with only a structured currency it stays
    // unresolved. With a structured budget it is read in that currency, so it can only tighten that budget.
    if (!structuredCur || (/^(?:up to|max(?:imum)?(?: of)?|within|between|from)$/i.test(word) && !opts.structuredBudget)) {
      ambiguities.push({ kind: "NO_CURRENCY", text: spanText, span, reason: `"${spanText}" has no currency (not recognised as an amount with a currency)`, bareAmount: { amount: m[2]!.replace(/,/g, ""), multiplier: mult } });
      continue;
    }
    const v = amountToMinor(m[2]!, mult, structuredCur);
    const h = hiNum ? amountToMinor(hiNum, mult, structuredCur) : null;
    if (v === null || (hiNum && h === null)) { ambiguities.push({ kind: "UNPARSEABLE_AMOUNT", text: spanText, span, reason: `the amount cannot be represented in ${structuredCur}` }); continue; }
    if (hiNum) {
      if (v > h!) { ambiguities.push({ kind: "INCONSISTENT_RANGE", text: spanText, span, reason: "the lower end of the range is above the upper end" }); continue; }
      constraints.push({ currency: structuredCur, lowerMinor: v, lowerInclusive: true, upperMinor: h, upperInclusive: true, text: spanText, span, provenance: "REQUEST_TEXT_STRUCTURED_CURRENCY", basis: "RANGE" });
    } else {
      const ex = /^(?:under|below|less than|cheaper than)$/i.test(word);
      constraints.push({ currency: structuredCur, lowerMinor: null, lowerInclusive: true, upperMinor: v, upperInclusive: !ex, text: spanText, span, provenance: "REQUEST_TEXT_STRUCTURED_CURRENCY", basis: "LIMIT_WORD" });
    }
  }
  const masked1 = maskSpans(t, used);
  for (const m of masked1.matchAll(LIMIT_KO)) {
    if (m[1] !== undefined) {
      const between = m[0].replace(/^\d[\d,]*(?:\.\d+)?/, "");
      if (KO_UNIT_BEFORE_LIMIT.test(between.replace(/\s*(이하|미만|까지|이내|안쪽|아래|선에서)$/, ""))) continue;
    }
    const num = (m[1] ?? m[5])!; const mag = m[2] ?? m[6]; const mult = mag === "만" ? 10_000 : mag === "천" ? 1000 : mag === "백" ? 100 : 1;
    const span: [number, number] = [m.index!, m.index! + m[0].length]; used.push(span);
    const spanText = m[0].trim();
    if (!structuredCur) { ambiguities.push({ kind: "NO_CURRENCY", text: spanText, span, reason: `"${spanText}" has no currency (not recognised as an amount with a currency)`, bareAmount: { amount: num.replace(/,/g, ""), multiplier: mult } }); continue; }
    const v = amountToMinor(num, mult, structuredCur);
    if (v === null) { ambiguities.push({ kind: "UNPARSEABLE_AMOUNT", text: spanText, span, reason: `the amount cannot be represented in ${structuredCur}` }); continue; }
    constraints.push({ currency: structuredCur, lowerMinor: null, lowerInclusive: true, upperMinor: v, upperInclusive: !/(미만|아래)$/.test(spanText), text: spanText, span, provenance: "REQUEST_TEXT_STRUCTURED_CURRENCY", basis: "LIMIT_WORD" });
  }

  // Currency of the session: structured, else the one currency the constraints use, else a marker in the text, else USD.
  const textCurs = [...new Set(constraints.filter((c) => c.provenance === "REQUEST_TEXT").map((c) => c.currency))];
  let currency: Currency; let currencySource: MoneyParse["currencySource"];
  if (structuredCur) { currency = structuredCur; currencySource = "STRUCTURED_INPUT"; }
  else if (textCurs.length) { currency = textCurs[0]!; currencySource = "PARSED_FROM_TEXT"; }
  else if (/€|\beur\b|euro|유로/i.test(t)) { currency = "EUR"; currencySource = "PARSED_FROM_TEXT"; }
  else if (/£|\bgbp\b/i.test(t)) { currency = "GBP"; currencySource = "PARSED_FROM_TEXT"; }
  else if (/₩|만\s*원|\bkrw\b|\d\s*원/i.test(t)) { currency = "KRW"; currencySource = "PARSED_FROM_TEXT"; }
  else { currency = "USD"; currencySource = /\$|달러|\busd\b|dollars?/i.test(t) ? "PARSED_FROM_TEXT" : "DEFAULT_USD"; }

  for (const c of constraints) if (c.currency !== currency) {
    ambiguities.push({ kind: structuredCur ? "CURRENCY_CONFLICT" : "MULTIPLE_CURRENCIES", text: c.text, span: c.span,
      reason: `${c.text} is in ${c.currency}, but the ${structuredCur ? "requested" : "other stated"} currency is ${currency}` });
  }
  const same = constraints.filter((c) => c.currency === currency);
  let combined: MoneyParse["combined"] = null;
  if (same.length) {
    let upper: { v: number; inc: boolean } | null = null; let lower: { v: number; inc: boolean } | null = null;
    for (const c of same) {
      if (c.upperMinor !== null) { const eff = c.upperMinor - (c.upperInclusive ? 0 : 1); if (!upper || eff < upper.v - (upper.inc ? 0 : 1)) upper = { v: c.upperMinor, inc: c.upperInclusive }; }
      if (c.lowerMinor !== null) { const eff = c.lowerMinor + (c.lowerInclusive ? 0 : 1); if (!lower || eff > lower.v + (lower.inc ? 0 : 1)) lower = { v: c.lowerMinor, inc: c.lowerInclusive }; }
    }
    combined = { upperMinor: upper?.v ?? null, upperInclusive: upper?.inc ?? true, lowerMinor: lower?.v ?? null, lowerInclusive: lower?.inc ?? true };
    if (upper && lower && lower.v + (lower.inc ? 0 : 1) > upper.v - (upper.inc ? 0 : 1)) {
      ambiguities.push({ kind: "INCONSISTENT_RANGE", text: same.map((c) => c.text).join("; "), span: null, reason: "the stated minimum is above the stated maximum" });
    }
  }
  return { currency, currencySource, constraints, ambiguities, notes, combined, masked: maskSpans(t, used) };
}
const QUANTITY_RE = new RegExp(String.raw`^\s*(?:hours?|hrs?|cups?|oz|ounces?|weeks?|days?|months?|years?|minutes?|watts?|wh|kwh|lumens?|pa|nits?|gb|tb|mah|inch(?:es)?|lbs?|kg|mm|cm|liters?|litres?|ml|pack|pcs|pieces|items?|people|devices?|ports?|miles?|km|steps?|v|volts?)\b`, "i");

function maskSpans(t: string, spans: Array<[number, number]>): string {
  let out = t;
  for (const [a, b] of spans) out = out.slice(0, a) + " ".repeat(Math.max(0, b - a)) + out.slice(b);
  return out;
}

/** The highest total (inclusive, minor units) a constraint allows. */
export const inclusiveMax = (upperMinor: number | null, inclusive: boolean): number | null => upperMinor === null ? null : inclusive ? upperMinor : Math.max(0, upperMinor - 1);
export const inclusiveMin = (lowerMinor: number | null, inclusive: boolean): number | null => lowerMinor === null ? null : inclusive ? lowerMinor : lowerMinor + 1;
