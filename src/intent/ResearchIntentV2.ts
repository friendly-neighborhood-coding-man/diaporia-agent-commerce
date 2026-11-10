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

function parseMoney(text: string, structured: string | undefined): { currency: Currency; currencySource: ResearchIntentV2["currencySource"]; budget: number | null; } {
  const t = text.normalize("NFKC");
  let currency: Currency | null = isCurrency(structured) ? structured : null;
  const source: ResearchIntentV2["currencySource"] = currency ? "STRUCTURED_INPUT" : "PARSED_FROM_TEXT";
  let budget: number | null = null;
  // Korean won: "30만원", "20만 원", "150,000원", "₩150000". Korean dollars: "150달러".
  const man = /(\d+(?:\.\d+)?)\s*만\s*원/.exec(t);
  const won = /(?:₩\s*(\d[\d,]*)|(\d[\d,]*)\s*원)/.exec(t);
  const dollarsKo = /(\d[\d,]*(?:\.\d{1,2})?)\s*달러/.exec(t);
  const eurKo = /(\d[\d,]*(?:\.\d{1,2})?)\s*유로/.exec(t);
  const BUDGET_EN = /(?:under|below|less than|at most|max(?:imum)?(?: of)?|no more than|never (?:go over|exceed)|not exceed|up to|budget(?: of| is)?|within|cheaper than)\s*(?:(\$|€|£|usd|eur|gbp)\s*)?(\d[\d,]*(?:\.\d{1,2})?)\s*(usd|dollars?|eur|euros?|gbp|pounds?|€|\$)?/i;
  const en = BUDGET_EN.exec(t);
  if (man) { currency ??= "KRW"; if (currency === "KRW") budget = Math.round(Number(man[1]) * 10_000); }
  else if (won && /원|₩/.test(won[0])) { currency ??= "KRW"; if (currency === "KRW") budget = Number((won[1] ?? won[2])!.replace(/,/g, "")); }
  else if (dollarsKo) { currency ??= "USD"; if (currency === "USD") budget = parseDecimalToMinor(dollarsKo[1]!.replace(/,/g, ""), "USD"); }
  else if (eurKo) { currency ??= "EUR"; if (currency === "EUR") budget = parseDecimalToMinor(eurKo[1]!.replace(/,/g, ""), "EUR"); }
  else if (en) {
    const sym = `${en[1] ?? ""}${en[3] ?? ""}`.toLowerCase();
    const cur: Currency = /€|eur/.test(sym) ? "EUR" : /£|gbp|pound/.test(sym) ? "GBP" : "USD";
    currency ??= cur;
    if (currency === cur) budget = parseDecimalToMinor(en[2]!.replace(/,/g, ""), cur);
  }
  if (!currency) currency = /€|\beur\b|euro/i.test(t) ? "EUR" : /£|\bgbp\b/i.test(t) ? "GBP" : /₩|만\s*원|\bkrw\b/i.test(t) ? "KRW" : "USD";
  return { currency, currencySource: isCurrency(structured) ? "STRUCTURED_INPUT" : budget !== null || /€|£|₩|eur|gbp|krw|원|달러|유로/i.test(t) ? source : "DEFAULT_USD", budget };
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

  return { version: "intent-v2.0.0", mode, language, currency: money.currency, currencySource: money.currencySource, budgetMinor, budgetSource, target,
    attributes, condition, conditionStated, category, categoryNoun: cat?.noun ?? null, mustHave: [...must], niceToHave: [...nice], excludeBundles, objective,
    queries: { primary, fallback }, assumptions };
}
