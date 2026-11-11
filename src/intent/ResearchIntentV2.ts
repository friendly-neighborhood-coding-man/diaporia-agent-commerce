import type { Condition, IntentMode } from "../domain/types.js";
import { isCurrency, parseDecimalToMinor, type Currency } from "../domain/money.js";
import { extractIdentity, parseAttributes, type ProductKind, type VariantAttributes } from "../identity/ProductIdentityExtractor.js";
import { capabilityPhrase, requestCapabilities, requestCategory } from "../research/capabilities.js";
import type { PurchaseRequestInput } from "./PurchaseIntentRouter.js";

/**
 * Research V2 intent: everything the discovery, identity and decision stages need, parsed deterministically from
 * the request (English and Korean). No LLM, no network. Nothing here authorizes payment: a budget is a research
 * filter only; spending authority comes exclusively from a user-created PurchaseMandate.
 */
export interface ResearchIntentV2 {
  version: "intent-v2.0.0";
  mode: IntentMode;
  language: "en" | "ko";
  currency: Currency;
  currencySource: "STRUCTURED_INPUT" | "PARSED_FROM_TEXT" | "DEFAULT_USD";
  budgetMinor: number | null;
  budgetSource: "STRUCTURED_INPUT" | "PARSED_FROM_TEXT" | "NONE";
  /** A budget stated in the text in a different currency than the structured one (review R-07). Never converted silently. */
  budgetConflict: string | null;
  /**
   * A limit phrase with a number that did not become a budget (V21-01): "max 80" with no currency, "150 이하", "예산 200".
   * Never dropped silently: the decision HOLDs and payment preparation stays blocked until the owner confirms an amount
   * and currency.
   */
  budgetUnresolved: string | null;
  /** Exact-product target (exact mode) or family hint (discovery with a named model). */
  target: { brand: string | null; model: string | null; modelBasis: "MODEL_NUMBER" | "NAMED_MODEL" | "NONE"; kind: ProductKind; accessoryNoun: string | null; sku?: string | null } | null;
  /** Variant attributes the user stated (colour, size, capacity, storage, memory, pack). */
  attributes: VariantAttributes;
  /** Requested condition; `conditionStated` false means "new" was assumed. */
  condition: Condition;
  conditionStated: boolean;
  /** Canonical category id (capabilities.ts) or null. */
  category: string | null;
  categoryNoun: string | null;
  mustHave: string[];
  niceToHave: string[];
  /** The user asked to exclude bundles/kits ("standalone", "no bundles"). */
  excludeBundles: boolean;
  objective: "LOWEST_VERIFIED_TOTAL" | "BEST_SUITABILITY";
  /** Provider query plan: primary query and a broader fallback (discovery). */
  queries: { primary: string; fallback: string | null };
  assumptions: string[];
}

const BUY_EN = /\b(buy|purchase|order|checkout|get me|i want to buy|pick up)\b/i;
const BUY_KO = /구매|구입|사줘|사 줘|주문|결제/;
const NICE = /\b(ideally|would be nice|nice to have|nice-to-have|preferably|prefer(?:red)?|bonus|if possible|optional(?:ly)?|a plus)\b|있으면 좋|선호|가능하면/i;
/** Common words that are capitalized only because they start a sentence: never a brand. */
const NOT_BRAND = new Set(`i buy purchase order get please need want looking find cheapest cheap best the a an my noise wireless laptop laptops headphones headphone
  over-ear over office waterproof water programmable cordless insulated money phone smartphone shoes boots hiking running coffee monitor 4k backpack daypack chair vacuum
  bottle system note ignore new used refurbished renewed replacement standalone under budget with and for in on of`.split(/\s+/).filter(Boolean));

/** Units that make a number a quantity, not money (shared by the budget parser and the unresolved-limit scan). */
const QUANTITY_UNIT = String.raw`(?:\+|-?\s*(?:hours?|hrs?|h|cups?|oz|ounces?|weeks?|wks?|days?|months?|years?|yrs?|minutes?|mins?|watts?|w|gb|tb|mb|mah|inch(?:es)?|in|ft|feet|lbs?|pounds? of|kg|g|mm|cm|m|l|liters?|litres?|ml|%|x|pack|pcs|pieces|items?|people|persons?|devices?|ports?|db|hz|khz|mph|km|miles?|steps?|users?|seats?|players?|keys?|buttons?)\b|\s*["”'%]|\d|\.\d)`;
const LIMIT_EN = new RegExp(String.raw`(?:^|[^A-Za-z])(under|below|less than|at most|max(?:imum)?(?: of)?|no more than|never (?:go over|exceed)|not exceed|up to|budget(?: of| is)?|within|cheaper than|cap(?:ped)? at|spend(?:ing)? (?:at most|up to)?)\s*[:=]?\s*(\d[\d,]*(?:\.\d+)?)(?!${QUANTITY_UNIT})`, "gi");
const LIMIT_KO = /(\d[\d,]*(?:\.\d+)?)\s*(?:천|만|백)?\s*(이하|미만|까지|이내|안쪽|아래|선에서)|(예산|최대|상한)\s*[:은는이가]?\s*(\d[\d,]*(?:\.\d+)?)(?!\s*(?:시간|개|대|명|인치|와트|분|일|주|개월|년|%|mAh|W|kg|g|GB|TB))/g;
const KO_UNIT_BEFORE_LIMIT = /(?:시간|개|대|명|인치|와트|분|일|주|개월|년|%|mah|w|kg|g|gb|tb|원|달러|유로|파운드)\s*$/i;

/**
 * Limit phrases with a number that are not a recognised budget (V21-01). "Max" capitalised after a word is a model name
 * ("AirPods Max 2"), not a limit. Returns the phrase, or null.
 */
function unresolvedLimit(t: string): string | null {
  for (const m of t.matchAll(LIMIT_EN)) {
    const word = m[1]!;
    if (/^Max/.test(word) && /[A-Za-z]\s+$/.test(t.slice(0, m.index! + m[0].indexOf(word)))) continue;
    return m[0].replace(/^[^A-Za-z]/, "").trim();
  }
  for (const m of t.matchAll(LIMIT_KO)) {
    if (m[1] !== undefined) {
      const between = t.slice(m.index!, m.index! + m[0].length).replace(/^\d[\d,]*(?:\.\d+)?/, "");
      if (KO_UNIT_BEFORE_LIMIT.test(between.replace(/\s*(이하|미만|까지|이내|안쪽|아래|선에서)$/, ""))) continue;
    }
    return m[0].trim();
  }
  return null;
}

function parseMoney(text: string, structured: string | undefined): { currency: Currency; currencySource: ResearchIntentV2["currencySource"]; budget: number | null; conflict: string | null; unresolved: string | null } {
  const t = text.normalize("NFKC");
  let currency: Currency | null = isCurrency(structured) ? structured : null;
  const source: ResearchIntentV2["currencySource"] = currency ? "STRUCTURED_INPUT" : "PARSED_FROM_TEXT";
  let budget: number | null = null;
  let conflict: string | null = null;
  let unresolved: string | null = null;
  // Korean won: "30만원", "20만 원", "150,000원", "₩150000". Korean dollars: "150달러".
  const man = /(\d+(?:\.\d+)?)\s*만\s*원/.exec(t);
  const won = /(?:₩\s*(\d[\d,]*)|(\d[\d,]*)\s*원)/.exec(t);
  const dollarsKo = /(\d[\d,]*(?:\.\d{1,2})?)\s*달러/.exec(t);
  const eurKo = /(\d[\d,]*(?:\.\d{1,2})?)\s*유로/.exec(t);
  // English budget (review R-04): every match is considered. A number followed by a unit (hours, cups, oz, weeks…) is a
  // quantity, never money. "up to / max / within N" needs a currency marker; a match with a marker wins.
  const BUDGET_EN = /\b(under|below|less than|at most|max(?:imum)?(?: of)?|no more than|never (?:go over|exceed)|not exceed|up to|budget(?: of| is)?|within|cheaper than)\s*(?:(\$|€|£|usd|eur|gbp)\s*)?(\d[\d,]*(?:\.\d{1,2})?)(?!\s*(?:\+|-?\s*(?:hours?|hrs?|h|cups?|oz|ounces?|weeks?|wks?|days?|months?|years?|yrs?|minutes?|mins?|watts?|w|gb|tb|mb|mah|inch(?:es)?|ft|feet|lbs?|pounds? of|kg|g|mm|cm|m|l|liters?|litres?|ml|%|x|pack|pcs|pieces|items?|people|persons?|devices?|ports?|db|hz|khz|mph|km|miles?|steps?)\b|\s*["”'%]|\d|\.\d))\s*(usd|dollars?|bucks|eur|euros?|gbp|pounds?|€|\$)?/gi;
  const NEEDS_MARKER = /^(?:up to|max(?:imum)?(?: of)?|within)$/i;
  const enAll = [...t.matchAll(BUDGET_EN)].filter((m) => m[2] || m[4] || !NEEDS_MARKER.test(m[1]!.trim()));
  const en = enAll.find((m) => m[2] || m[4]) ?? enAll[0] ?? null;
  const en1 = en ? [en[0], en[2], en[3], en[4]] as const : null;
  const clash = (found: string, cur: Currency) => { conflict = `${found.trim()} is in ${cur}, but the requested currency is ${currency}`; };
  if (man) { currency ??= "KRW"; if (currency === "KRW") budget = Math.round(Number(man[1]) * 10_000); else clash(man[0], "KRW"); }
  else if (won && /원|₩/.test(won[0])) { currency ??= "KRW"; if (currency === "KRW") budget = Number((won[1] ?? won[2])!.replace(/,/g, "")); else clash(won[0], "KRW"); }
  else if (dollarsKo) { currency ??= "USD"; if (currency === "USD") budget = parseDecimalToMinor(dollarsKo[1]!.replace(/,/g, ""), "USD"); else clash(dollarsKo[0], "USD"); }
  else if (eurKo) { currency ??= "EUR"; if (currency === "EUR") budget = parseDecimalToMinor(eurKo[1]!.replace(/,/g, ""), "EUR"); else clash(eurKo[0], "EUR"); }
  else if (en1) {
    const sym = `${en1[1] ?? ""}${en1[3] ?? ""}`.toLowerCase();
    if (!sym && !currency) {
      // V21-01: a bare number with no currency anywhere is ambiguous. It is not assumed to be USD.
      unresolved = `"${en1[0].trim()}" has no currency`;
    } else {
      const cur: Currency = !sym ? currency! : /€|eur/.test(sym) ? "EUR" : /£|gbp|pound/.test(sym) ? "GBP" : "USD";
      currency ??= cur;
      if (currency === cur) budget = parseDecimalToMinor(en1[2]!.replace(/,/g, ""), cur);
      else conflict = `${en1[0].trim()} is in ${cur}, but the requested currency is ${currency}`;
    }
  }
  if (budget === null && conflict === null && unresolved === null) {
    const u = unresolvedLimit(t);
    if (u) unresolved = `"${u}" was not recognised as an amount with a currency`;
  }
  if (!currency) currency = /€|\beur\b|euro/i.test(t) ? "EUR" : /£|\bgbp\b/i.test(t) ? "GBP" : /₩|만\s*원|\bkrw\b/i.test(t) ? "KRW" : "USD";
  return { currency, currencySource: isCurrency(structured) ? "STRUCTURED_INPUT" : budget !== null || /€|£|₩|eur|gbp|krw|원|달러|유로/i.test(t) ? source : "DEFAULT_USD", budget, conflict, unresolved };
}

/** Brand = first capitalized Latin word (not a sentence word) that is followed by a model token or another capitalized word. */
function findBrand(text: string): { brand: string; index: number } | null {
  const re = /(?<![A-Za-z0-9])([A-Z][A-Za-z0-9&'’]+)(?=\s+([A-Z0-9][A-Za-z0-9-]*))/g;
  for (const m of text.matchAll(re)) {
    const word = m[1]!.replace(/[’']s$/, "");
    if (NOT_BRAND.has(word.toLowerCase())) continue;
    if (/^[A-Z]{2,}$/.test(word) && !/\d/.test(m[2]!)) continue; // "HEPA filter", "SYSTEM: ..."
    const next = m[2]!;
    if (/^(?:SYSTEM|NOTE|IGNORE)\b/.test(next)) continue;
    return { brand: word, index: m.index! };
  }
  return null;
}

export function parseResearchIntent(input: PurchaseRequestInput): ResearchIntentV2 {
  const raw = input.request.slice(0, 2000).normalize("NFKC");
  // Instructions embedded in a request ("SYSTEM: ...", "ignore the budget") are content, not commands: cut them off.
  const text = raw.split(/\b(?:SYSTEM|ASSISTANT|DEVELOPER)\s*:|\bignore (?:all |the |previous )/i)[0]!.trim() || raw;
  const assumptions: string[] = [];
  if (text !== raw) assumptions.push("Instruction-like text in the request was ignored (it cannot change budgets, approvals or verification).");
  const language: "en" | "ko" = /[가-힣]/.test(text) ? "ko" : "en";

  const money = parseMoney(text, input.currency);
  let budgetMinor: number | null = null; let budgetSource: ResearchIntentV2["budgetSource"] = "NONE";
  if (input.budgetMinor !== undefined) { budgetMinor = input.budgetMinor; budgetSource = "STRUCTURED_INPUT"; }
  else if (money.budget !== null) { budgetMinor = money.budget; budgetSource = "PARSED_FROM_TEXT"; }
  if (money.currencySource === "DEFAULT_USD") assumptions.push("Currency not given; using USD.");
  const budgetConflict = budgetSource === "NONE" ? money.conflict : null;
  if (budgetConflict) assumptions.push(`Budget not applied: ${budgetConflict}. Confirm the budget in ${money.currency}.`);
  const budgetUnresolved = budgetSource === "NONE" && !budgetConflict ? money.unresolved : null;
  if (budgetUnresolved) assumptions.push(`Budget not applied: ${budgetUnresolved}. Confirm the amount and currency.`);
  if (/no object|no budget|any price|price doesn'?t matter|가격 상관/i.test(text)) assumptions.push("User stated no budget limit.");

  // Exact target: a buy verb plus a brand followed by a model (or an explicit exactProduct).
  const buy = BUY_EN.exec(text) ?? BUY_KO.exec(text);
  const brandHit = input.exactProduct?.brand ? { brand: input.exactProduct.brand, index: Math.max(0, text.toLowerCase().indexOf(input.exactProduct.brand.toLowerCase())) } : findBrand(text);
  let target: ResearchIntentV2["target"] = null;
  let targetSpan: [number, number] | null = null;
  if (brandHit) {
    // The product phrase: from the buy verb (or brand) to the end of the clause.
    const from = buy && buy.index < brandHit.index && language === "en" ? buy.index + buy[0].length : 0;
    const clause = text.slice(from).split(/,\s*(?:but|and|only|if|under|budget|ideally|must|with)\b|[.!?](?:\s|$)|\s+(?:but|only if|under|below|less than|budget|with(?:out)?|money)\b|\s+\d[\d,]*\s*(?:달러|만\s*원|원)/i)[0]!;
    const ex = extractIdentity(clause.replace(/\b(?:the|a|an|used|new|refurbished|renewed|standalone)\b/gi, " ").replace(/\s+/g, " ").trim(), brandHit.brand);
    const model = input.exactProduct?.model ?? ex.model;
    if (model) {
      target = { brand: brandHit.brand, model, modelBasis: input.exactProduct?.model ? "MODEL_NUMBER" : ex.modelBasis, kind: ex.kind, accessoryNoun: ex.accessoryNoun };
      const mi = text.toLowerCase().indexOf(model.toLowerCase());
      targetSpan = mi >= 0 ? [Math.min(brandHit.index, mi), mi + model.length] : [brandHit.index, brandHit.index + brandHit.brand.length];
    }
  }
  // Structured exact input wins over text parsing (brand/model/SKU given by the caller).
  if (input.exactProduct?.model || input.exactProduct?.sku) {
    target = { brand: input.exactProduct.brand ?? target?.brand ?? null, model: input.exactProduct.model ?? target?.model ?? null, modelBasis: "MODEL_NUMBER",
      kind: target?.kind ?? "STANDALONE", accessoryNoun: target?.accessoryNoun ?? null, sku: input.exactProduct.sku ?? null };
  }
  const exact = !!(input.exactProduct?.model || input.exactProduct?.sku) || (!!target && !!buy);
  const mode: IntentMode = exact ? "EXACT_PRODUCT_PURCHASE" : "PRODUCT_DISCOVERY";
  if (!exact && buy) assumptions.push("Purchase verb found but no exact model; running discovery first.");

  // Attributes: the user's own words; Korean colour words included. Pack sizes mark a bundle request.
  const attrText = target && targetSpan ? text.slice(targetSpan[0]) : text;
  const attributes: VariantAttributes = { ...parseAttributes(attrText.split(/\s+(?:under|below|budget|less than)\b/i)[0]!) };
  if (input.exactProduct?.variant) attributes.color = input.exactProduct.variant;
  // A capacity of the TARGET product the accessory fits ("carafe for the Brewmaster 12-cup") is an attribute of the accessory.
  const excludeBundles = /\bstandalone\b|\bno bundles?\b|\bwithout (?:a )?bundle\b|\bnot (?:a )?bundle\b|번들 제외|단품/i.test(text);

  // Condition: explicit words only. Default NEW (stated as an assumption).
  let condition: Condition = "new"; let conditionStated = false;
  if (input.exactProduct?.condition) { condition = input.exactProduct.condition; conditionStated = true; }
  else if (/\b(refurb(?:ished)?|renewed|reconditioned)\b|리퍼/i.test(text)) { condition = "refurbished"; conditionStated = true; }
  else if (/\b(used|pre-?owned|second[- ]hand)\b|중고/i.test(text)) { condition = "used"; conditionStated = true; }
  else if (/\bnew\b|새\s*제품|새것|미개봉/i.test(text)) { condition = "new"; conditionStated = true; }
  if (!conditionStated) assumptions.push("Condition not stated; only NEW offers are eligible.");

  // Capabilities: per clause, so "ideally X" is a nice-to-have. Words inside the model name are not requirements
  // ("Tailspin Studio ANC Pro" does not ask for ANC).
  const must = new Set<string>(input.mustHave ?? []); const nice = new Set<string>(input.niceToHave ?? []);
  let offset = 0;
  for (const clause of text.split(/(?<=[,;])\s*|\s+(?=but\b)|\s+and\s+(?=(?:a|an|the)\s|ideally|it would)/i)) {
    const at = text.indexOf(clause, offset); offset = at >= 0 ? at + clause.length : offset;
    const isNice = NICE.test(clause);
    for (const c of requestCapabilities(clause)) {
      const abs = (at >= 0 ? at : 0) + c.index;
      if (targetSpan && abs >= targetSpan[0] && abs < targetSpan[1]) continue;
      (isNice ? nice : must).add(c.id);
    }
  }
  for (const n of nice) if (must.has(n) && !(input.mustHave ?? []).includes(n)) must.delete(n);
  for (const m of must) nice.delete(m);

  const cat = requestCategory(target && targetSpan ? text : text);
  const category = target?.kind === "ACCESSORY" ? null : cat?.id ?? null;
  const objective = mode === "EXACT_PRODUCT_PURCHASE" || /cheapest|lowest price|가장 싼|최저가/i.test(text) ? "LOWEST_VERIFIED_TOTAL" : "BEST_SUITABILITY";

  // Query plan. Exact: brand + model (+ accessory noun). Discovery: up to two must-have phrases + category noun,
  // with the bare category noun (plus brand/model hint) as the broader fallback. Always English (provider locale).
  let primary: string; let fallback: string | null = null;
  if (mode === "EXACT_PRODUCT_PURCHASE" && target) {
    primary = [target.brand, target.model, target.kind === "ACCESSORY" ? target.accessoryNoun : null].filter(Boolean).join(" ");
  } else {
    const hint = target ? `${target.brand} ${target.model}` : null;
    const phrases = [...must].slice(0, 2).map(capabilityPhrase);
    const noun = cat?.noun ?? null;
    if (noun || hint) {
      primary = [...phrases, hint, noun].filter(Boolean).join(" ");
      fallback = [hint, noun].filter(Boolean).join(" ");
      if (fallback === primary) fallback = null;
    } else {
      primary = text.replace(/(?:under|below|less than|budget(?: of)?)\s*[$€£]?\s*\d[\d,.]*\s*\w*/gi, " ").replace(/[^\p{L}\p{N}\s-]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, 120);
      fallback = null;
    }
  }
  if (language === "ko") assumptions.push("Korean request: provider queries are sent in English (Channel3 has no Korean locale).");
  if (money.currency === "KRW") assumptions.push("Channel3 cannot price in KRW: listing prices will not be in the requested currency.");

  return { version: "intent-v2.0.0", mode, language, currency: money.currency, currencySource: money.currencySource, budgetMinor, budgetSource, budgetConflict, budgetUnresolved, target,
    attributes, condition, conditionStated, category, categoryNoun: cat?.noun ?? null, mustHave: [...must], niceToHave: [...nice], excludeBundles, objective,
    queries: { primary, fallback }, assumptions };
}
