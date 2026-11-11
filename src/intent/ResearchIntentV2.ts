import type { Condition, IntentMode } from "../domain/types.js";
import { parseDecimalToMinor, type Currency } from "../domain/money.js";
import { ACCESSORY_NOUN, PART_NOUN, PRODUCT_NOUN_PHRASES, extractIdentity, modelNumberToken, parseAttributes, type ProductKind, type VariantAttributes } from "../identity/ProductIdentityExtractor.js";
import { capabilityPhrase, requestCapabilities, requestCategory, mentionedCategory, KO_QUERY_NOUNS } from "../research/capabilities.js";
import type { PurchaseRequestInput } from "./PurchaseIntentRouter.js";
import { extractRequirements, type StatedRequirement } from "./Requirements.js";
import { productType, uninterpretedWords, type UninterpretedWord } from "./Uninterpreted.js";
import { inclusiveMax, inclusiveMin, parseMoneyConstraints, type MoneyAmbiguity, type MoneyConstraint, type MoneyParse } from "./MoneyConstraints.js";

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
  /**
   * V2.2 WP-1: the stated upper bound's semantics and the enforceable inclusive limits (integer minor units, session
   * currency). `budgetMaxMinor` is what every eligibility and payment check uses ("under $120" allows at most $119.99).
   * `budgetLowerMinor` is the lowest allowed listing price of a stated range ("between $100 and $150"), or null.
   */
  budgetUpperInclusive: boolean;
  budgetMaxMinor: number | null;
  budgetLowerMinor: number | null;
  /** Every money statement of the request, with spans and provenance, and every amount that could not be read safely. */
  moneyConstraints: MoneyConstraint[];
  moneyAmbiguities: MoneyAmbiguity[];
  /** Exact-product target (exact mode) or family hint (discovery with a named model). */
  target: { brand: string | null; model: string | null; modelBasis: "MODEL_NUMBER" | "NAMED_MODEL" | "NONE"; kind: ProductKind; accessoryNoun: string | null; sku?: string | null } | null;
  /**
   * V2.2 WP-3 (H-3): the model number the user asked for, when the request names one (the exact target's model number,
   * or a model token written right before a product noun: "AP-400 air purifier", "AP-400 공기청정기"). A listing that does
   * not mention exactly this model is never eligible, in discovery as well as in exact mode.
   */
  requestedModel?: string | null;
  /** V2.3 structural guard: content words that became neither identity, requirement, category, money nor attribute. */
  uninterpreted?: UninterpretedWord[];
  /** V2.4: product-type words not in the category vocabulary ("power station"); a candidate's title must contain them. */
  productTypeWords?: string[];
  /** V2.4: why the request is exact. NAMED (brand + model, no buy verb) falls back to discovery among the named model's
   * variants when the variant is not stated, instead of holding. */
  lockBasis?: "STRUCTURED" | "BUY" | "NAMED" | null;
  /** Variant attributes the user stated (colour, size, capacity, storage, memory, pack). */
  attributes: VariantAttributes;
  /** Requested condition; `conditionStated` false means "new" was assumed. */
  condition: Condition;
  conditionStated: boolean;
  /** Canonical category id (capabilities.ts) or null. */
  category: string | null;
  categoryNoun: string | null;
  /** Recognized, verifiable must-have capability ids. */
  mustHave: string[];
  niceToHave: string[];
  /**
   * N-01: every requirement the user stated, recognized or not, with its span and polarity (lossless).
   * `unresolvedMust` lists the keys of stated MUST requirements that the evidence engine cannot verify (unrecognized
   * or negative). Each is a blocking gate item `must:<key>`; only the owner can remove one.
   */
  requirements: StatedRequirement[];
  unresolvedMust: string[];
  /** The user asked to exclude bundles/kits ("standalone", "no bundles"). */
  excludeBundles: boolean;
  objective: "LOWEST_VERIFIED_TOTAL" | "BEST_SUITABILITY";
  /** Provider query plan: primary query and a broader fallback (discovery). */
  queries: { primary: string; fallback: string | null };
  assumptions: string[];
}

const BUY_EN = /\b(buy|purchase|order|checkout|get me|i want to buy|pick up)\b/i;
const BUY_KO = /구매|구입|사줘|사 줘|주문|결제|사고\s*싶|살래|사려고/;
/** V2.4: words that compare or substitute a named product ("like the X", "X or Y", "cheaper than X"): no exact lock. */
const COMPARE_WORDS = /\b(?:like|similar|alternatives?|instead|vs\.?|versus|compar\w*|than|except|rather|upgrade|successor|or|비슷한|대신|대체)\b/i;
const ACC_LEAD = new RegExp(`(?:^|\\s)((?:replacement\\s+|spare\\s+)?(?:${PART_NOUN.source}|${ACCESSORY_NOUN.source.replace(/^\\b|\\b$/g, "")}))s?\\s+(?:for|that fits?|compatible with|to fit)\\s+(?:(?:my|the|a|an|our|your)\\s+)?$`, "i");
const NICE = /\b(ideally|would be nice|nice to have|nice-to-have|preferably|prefer(?:red)?|bonus|if possible|optional(?:ly)?|a plus)\b|있으면 좋|선호|가능하면/i;
/** Common words that are capitalized only because they start a sentence: never a brand. */
const NOT_BRAND = new Set(`usd eur gbp jpy krw won dollars max min budget i buy purchase order get please need want looking find cheapest cheap best the a an my noise wireless laptop laptops headphones headphone
  over-ear over office waterproof water programmable cordless insulated money phone smartphone shoes boots hiking running coffee monitor 4k backpack daypack chair vacuum
  bottle system note ignore new used refurbished renewed replacement standalone under budget with and for in on of`.split(/\s+/).filter(Boolean));

function parseMoney(text: string, structured: string | undefined, structuredBudget = false): { currency: Currency; currencySource: ResearchIntentV2["currencySource"]; budget: number | null; conflict: string | null; unresolved: string | null;
  bareAmount: { amount: string; multiplier: number } | null; parse: MoneyParse } {
  // V2.2 WP-1: every stated amount is an explicit constraint or an explicit ambiguity (MoneyConstraints.ts).
  const parse = parseMoneyConstraints(text, structured, { structuredBudget });
  const CONFLICT = new Set(["CURRENCY_CONFLICT", "MULTIPLE_CURRENCIES", "INCONSISTENT_RANGE"]);
  const conflictA = parse.ambiguities.find((a) => CONFLICT.has(a.kind)) ?? null;
  const otherA = parse.ambiguities.find((a) => !CONFLICT.has(a.kind)) ?? null;
  const conflict = conflictA ? conflictA.reason : null;
  const unresolved = otherA ? (otherA.kind === "NO_CURRENCY" ? otherA.reason : `"${otherA.text}": ${otherA.reason}`) : null;
  const budget = conflict ? null : parse.combined?.upperMinor ?? null;
  return { currency: parse.currency, currencySource: parse.currencySource, budget, conflict, unresolved, bareAmount: parse.ambiguities.find((a) => a.bareAmount)?.bareAmount ?? null, parse };
}

/**
 * R-C: the budget the request text itself states, read by the same parser as research (no structured currency):
 * its currency and amount in that currency's minor units, or a bare number that had no currency. Display only.
 */
export function statedBudget(text: string): { currency: Currency; budgetMinor: number | null; bareAmountMinor: (cur: Currency) => number | null } {
  const m = parseMoney(text, undefined);
  return { currency: m.currency, budgetMinor: m.budget,
    bareAmountMinor: (cur) => { if (!m.bareAmount) return null; try { return parseDecimalToMinor(m.bareAmount.amount, cur) * m.bareAmount.multiplier; } catch { return null; } } };
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
  const text = raw.split(/\b(?:SYSTEM|ASSISTANT|DEVELOPER)(?:\s+(?:NOTE|MESSAGE|PROMPT|INSTRUCTIONS?))?\s*:|\bignore (?:all |the |previous )/i)[0]!.trim() || raw;
  const assumptions: string[] = [];
  if (text !== raw) assumptions.push("Instruction-like text in the request was ignored (it cannot change budgets, approvals or verification).");
  const language: "en" | "ko" = /[가-힣]/.test(text) ? "ko" : "en";

  let money = parseMoney(text, input.currency, input.budgetMinor !== undefined);
  // A structured budget without a structured currency is in the session currency: read bare amounts in that currency too.
  if (input.budgetMinor !== undefined && input.currency === undefined) money = parseMoney(text, money.currency, true);
  let budgetMinor: number | null = null; let budgetSource: ResearchIntentV2["budgetSource"] = "NONE";
  let budgetUpperInclusive = money.parse.combined?.upperInclusive ?? true;
  const textMax = money.budget === null ? null : inclusiveMax(money.budget, budgetUpperInclusive);
  if (input.budgetMinor !== undefined) {
    // A structured budget can only TIGHTEN a budget stated in the text, never loosen it (an agent cannot raise the
    // user's own limit by passing a larger budgetMinor).
    if (textMax !== null && textMax < input.budgetMinor) { budgetMinor = money.budget; budgetSource = "PARSED_FROM_TEXT"; assumptions.push("The structured budget is higher than the budget in the request text; the lower (text) budget applies."); }
    else { budgetMinor = input.budgetMinor; budgetSource = "STRUCTURED_INPUT"; budgetUpperInclusive = true; }
  }
  else if (money.budget !== null) { budgetMinor = money.budget; budgetSource = "PARSED_FROM_TEXT"; }
  const budgetMaxMinor = budgetMinor === null ? null : budgetSource === "STRUCTURED_INPUT" ? budgetMinor : inclusiveMax(budgetMinor, budgetUpperInclusive);
  const budgetLowerMinor = money.budget === null && budgetSource !== "STRUCTURED_INPUT" ? null : inclusiveMin(money.parse.combined?.lowerMinor ?? null, money.parse.combined?.lowerInclusive ?? true);
  if (money.currencySource === "DEFAULT_USD") assumptions.push("Currency not given; using USD.");
  const budgetConflict = money.conflict;
  if (budgetConflict) assumptions.push(`Budget not applied: ${budgetConflict}. Confirm the budget in ${money.currency}.`);
  const budgetUnresolved = !budgetConflict ? money.unresolved : null;
  if (budgetUnresolved) assumptions.push(`Budget ${budgetMinor === null ? "not applied" : "needs confirmation"}: ${budgetUnresolved}. Confirm the amount and currency.`);
  for (const c of money.parse.constraints) if (c.basis === "APPROXIMATE_AMOUNT_AS_MAXIMUM") assumptions.push(`"${c.text}" is approximate; it is applied as the maximum price (never exceeded). Confirm a different maximum if you want one.`);
  for (const c of money.parse.constraints) if (c.basis === "UNQUALIFIED_AMOUNT_AS_MAXIMUM") assumptions.push(`"${c.text}" has no limit word; it is applied as the maximum price.`);
  for (const n of money.parse.notes) assumptions.push(`"${n.text}" is ${n.reason}; it is not applied.`);
  if (/no object|no budget|any price|price doesn'?t matter|가격 상관/i.test(text)) assumptions.push("User stated no budget limit.");

  // Exact target: a buy verb plus a brand followed by a model (or an explicit exactProduct).
  const buy = BUY_EN.exec(text) ?? BUY_KO.exec(text);
  const brandHit = input.exactProduct?.brand ? { brand: input.exactProduct.brand, index: Math.max(0, text.toLowerCase().indexOf(input.exactProduct.brand.toLowerCase())) } : findBrand(money.parse.masked.length === text.length ? money.parse.masked : text);
  let target: ResearchIntentV2["target"] = null;
  let targetSpan: [number, number] | null = null;
  if (brandHit) {
    // The product phrase: from the buy verb (or brand) to the end of the clause.
    const from = buy && buy.index < brandHit.index && language === "en" ? buy.index + buy[0].length : 0;
    const clause = text.slice(from).split(/,\s*(?:but|and|only|if|under|budget|ideally|must|with)\b|[.!?](?:\s|$)|\s+(?:but|only if|under|below|less than|budget|with(?:out)?|money)\b|\s+\d[\d,]*\s*(?:달러|만\s*원|원)/i)[0]!;
    const ex = extractIdentity(clause.replace(/\b(?:the|a|an|used|new|refurbished|renewed|standalone)\b/gi, " ").replace(/\s+/g, " ").trim(), brandHit.brand);
    const model = input.exactProduct?.model ?? ex.model;
    if (model) {
      // V2.2 WP-3: "Ostra AP-400 replacement filter" asks for the filter, not the purifier. An accessory noun that ends
      // the product phrase after the model (or "replacement"/"spare" right after it) makes the request an accessory.
      let kind = ex.kind; let accessoryNoun = ex.accessoryNoun;
      if (kind === "STANDALONE" && ex.model) {
        const at = clause.toLowerCase().indexOf(ex.model.toLowerCase());
        const tail = at >= 0 ? clause.slice(at + ex.model.length).split(/[,;]|\s+(?:with|for|that|which|it|must|should|needs?|has|have)\b/i)[0]!.trim() : "";
        const end = new RegExp(`(?:^|\\s)(${ACCESSORY_NOUN.source.replace(/^\\b\(|\)\\b$/g, "")})e?s?\\s*$`, "i").exec(tail);
        if (tail && (end || /^(?:replacement|spare)\b/i.test(tail))) { kind = "ACCESSORY"; accessoryNoun = (end?.[1] ?? ACCESSORY_NOUN.exec(tail)?.[1] ?? "part").toLowerCase().replace(/\s+/g, " "); }
      }
      // V2.4: "replacement ear tips for my Sonara Hush 2" asks for the part, named before the product it fits.
      const lead = ACC_LEAD.exec(text.slice(0, brandHit.index));
      if (kind === "STANDALONE" && lead) { kind = "ACCESSORY"; accessoryNoun = lead[1]!.toLowerCase().replace(/^(?:replacement|spare)\s+/, "").replace(/\s+/g, " ").replace(/s$/, ""); }
      // V2.4: "the Volteq PS-500 bundle with the 100W solar panel" asks for the bundle itself.
      if (kind === "STANDALONE" && ex.model && /^\s*(?:bundle|kit|combo)\b/i.test(clause.slice(Math.max(0, clause.toLowerCase().indexOf(ex.model.toLowerCase())) + ex.model.length)) && !/\b(?:no|not|without)\s+(?:a\s+)?bundle/i.test(text)) kind = "BUNDLE";
      target = { brand: brandHit.brand, model, modelBasis: input.exactProduct?.model ? "MODEL_NUMBER" : ex.modelBasis, kind, accessoryNoun };
      const mi = text.toLowerCase().indexOf(model.toLowerCase());
      targetSpan = mi >= 0 ? [Math.min(brandHit.index, mi), mi + model.length] : [brandHit.index, brandHit.index + brandHit.brand.length];
    }
  }
  // Structured exact input wins over text parsing (brand/model/SKU given by the caller).
  if (input.exactProduct?.model || input.exactProduct?.sku) {
    target = { brand: input.exactProduct.brand ?? target?.brand ?? null, model: input.exactProduct.model ?? target?.model ?? null, modelBasis: "MODEL_NUMBER",
      kind: target?.kind ?? "STANDALONE", accessoryNoun: target?.accessoryNoun ?? null, sku: input.exactProduct.sku ?? null };
  }
  // V2.4: a request that names one product by brand and model ("Brisk RV-8 Pro", "Talus Ridge 2 tent", "I want the
  // Lumora LP-1 projector") asks for that product, with or without a buy verb, unless it compares or substitutes.
  const named = !!target && /^[A-Za-z][A-Za-z&'’-]+$/.test(target.brand ?? "") && !requestCapabilities(target.brand ?? "").length && !COMPARE_WORDS.test(text.replace(/\b(?:at least|at most|no more than|more than|less than)\b/gi, " "));
  const structuredExact = !!(input.exactProduct?.model || input.exactProduct?.sku);
  const exact = structuredExact || (!!target && (!!buy || named));
  const lockBasis = structuredExact ? "STRUCTURED" as const : target && buy ? "BUY" as const : exact ? "NAMED" as const : null;
  const mode: IntentMode = exact ? "EXACT_PRODUCT_PURCHASE" : "PRODUCT_DISCOVERY";
  if (!exact && buy) assumptions.push("Purchase verb found but no exact model; running discovery first.");

  // Attributes: the user's own words; Korean colour words included. Pack sizes mark a bundle request.
  const attrText = target && targetSpan ? text.slice(targetSpan[0]) : text;
  const attributes: VariantAttributes = { ...parseAttributes(attrText.split(/\s+(?:under|below|budget|less than)\b/i)[0]!) };
  if (input.exactProduct?.variant) attributes.color = input.exactProduct.variant;
  // N-04: a model year or generation written right before the brand ("a 2023 Pagewell Lumen 7", "2nd gen Arden Buds").
  if (target && targetSpan) {
    const lead = text.slice(Math.max(0, targetSpan[0] - 24), targetSpan[0]);
    const y = /(?<![\d$€£₩.,])(20[0-3]\d)(?:\s*(?:model|edition|년형))?\s+$/i.exec(lead);
    if (!attributes.year && y && Number(y[1]) >= 2005) attributes.year = y[1]!;
    const g = /(?:\b(\d{1,2})(?:st|nd|rd|th)[- ]?gen(?:eration)?|\b(first|second|third|fourth|fifth|sixth)[- ]gen(?:eration)?|(\d{1,2})\s*세대)\s+$/i.exec(lead);
    if (!attributes.generation && g) attributes.generation = g[1] ? String(Number(g[1])) : g[3] ? String(Number(g[3])) : ({ first: "1", second: "2", third: "3", fourth: "4", fifth: "5", sixth: "6" } as Record<string, string>)[g[2]!.toLowerCase()]!;
  }
  // A capacity of the TARGET product the accessory fits ("carafe for the Brewmaster 12-cup") is an attribute of the accessory.
  const excludeBundles = /\bstandalone\b|\bno bundles?\b|\bwithout (?:a )?bundle\b|\bnot (?:a )?bundle\b|번들 제외|단품/i.test(text);

  // Condition: explicit words only. Default NEW (stated as an assumption).
  let condition: Condition = "new"; let conditionStated = false;
  if (input.exactProduct?.condition) { condition = input.exactProduct.condition; conditionStated = true; }
  else if (/\b(refurb(?:ished)?|renewed|reconditioned)\b|리퍼/i.test(text)) { condition = "refurbished"; conditionStated = true; }
  else if (/\b(used|pre-?owned|second[- ]hand)\b|중고/i.test(text)) { condition = "used"; conditionStated = true; }
  else if (/\bnew\b|새\s*제품|새것|미개봉/i.test(text)) { condition = "new"; conditionStated = true; }
  if (!conditionStated) assumptions.push("Condition not stated; only NEW offers are eligible.");

  // Requirements (N-01): lossless, per clause, with spans. "ideally X" is a nice-to-have; words inside the model name
  // are not requirements ("Tailspin Studio ANC Pro" does not ask for ANC). Structured input can only ADD requirements:
  // a structured niceToHave never softens a must-have stated in the text.
  const requirements = extractRequirements(money.parse.masked, targetSpan, [target?.brand ?? "", target?.model ?? ""].filter(Boolean), { mustHave: input.mustHave ?? [], niceToHave: input.niceToHave ?? [] });
  const must = new Set<string>(requirements.filter((r) => r.recognized && r.polarity === "REQUIRED" && r.strength === "MUST").map((r) => r.capability!));
  const nice = new Set<string>(requirements.filter((r) => r.recognized && r.polarity === "REQUIRED" && r.strength === "NICE").map((r) => r.capability!).filter((c) => !must.has(c)));
  const unresolvedMust = requirements.filter((r) => r.strength === "MUST" && (!r.recognized || r.polarity === "EXCLUDED")).map((r) => r.key);
  for (const r of requirements.filter((x) => x.strength === "MUST" && (!x.recognized || x.polarity === "EXCLUDED")))
    assumptions.push(`Requirement "${r.text}" (${r.polarity === "EXCLUDED" ? "must NOT have" : "must have"}) cannot be verified automatically; it stays open until evidence or the owner settles it.`);

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
    } else if (language === "ko") {
      // N-07: the provider has no Korean locale, so Korean text is never sent as the query. Latin tokens the user wrote
      // (brand names, "IH", "USB-C") and known product nouns are kept in English; if nothing remains, no catalog
      // search is made (research then finds nothing and asks, instead of searching for untranslated text).
      const latin = (text.match(/[A-Za-z][A-Za-z0-9+.-]*/g) ?? []).filter((w) => !/^(?:usd|krw|won)$/i.test(w));
      // V2.3: Korean is head-final, so the product noun is the LAST one ("노트북 충전기" = a charger); longest match wins.
      const nouns = KO_QUERY_NOUNS.flatMap(([re, en]) => { const m = re.exec(text); return m ? [{ en, end: m.index + m[0].length, len: m[0].length }] : []; })
        .sort((a, b) => b.end - a.end || b.len - a.len).map((x) => x.en).filter((x, i, a) => a.indexOf(x) === i);
      const of = mentionedCategory(text)?.noun ?? null;
      primary = [...phrases, ...latin, of, ...nouns.slice(0, 1)].filter(Boolean).join(" ").replace(/\s+/g, " ").trim().slice(0, 120);
      fallback = nouns.length && primary !== nouns[0] ? nouns[0]! : null;
      if (!primary) assumptions.push("No English search could be formed from this Korean request; name the product type (for example in English) to search the catalog.");
    } else {
      primary = money.parse.masked.replace(/\b(?:under|below|less than|between|from|at least|at most|up to|max(?:imum)?|budget(?: of| is)?|around|about|for|or less|or more)\s*(?=\s|$)/gi, " ").replace(/[^\p{L}\p{N}\s-]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, 120);
      fallback = null;
    }
  }
  // V2.2 WP-3: the requested model number (see the field). A model token right before a product noun counts too.
  let requestedModel: string | null = target?.modelBasis === "MODEL_NUMBER" && target.model && modelNumberToken(target.model) ? target.model : null;
  // V2.3 (V22-03): a named model-less product ("Nordvik Summit backpack") binds the identity like a model number does.
  if (!requestedModel && target?.modelBasis === "NAMED_MODEL" && target.model && target.model.split(/\s+/).every((x) => /^[A-Z0-9]/.test(x))) {
    requestedModel = target.model; assumptions.push(`"${target.brand} ${target.model}" is named in the request: only listings of that product are eligible.`);
  }
  if (!requestedModel && !input.exactProduct?.sku) {
    const nouns = [PRODUCT_NOUN_PHRASES.source.replace(/^\\b/, ""), ...KO_QUERY_NOUNS.map(([re]) => re.source)].join("|");
    const m = new RegExp(`(?:^|[\\s(])([A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)*)\\s*(?:${nouns})`, "i").exec(money.parse.masked);
    const tok = m ? modelNumberToken(m[1]!) : null;
    if (tok && tok === m![1]!.toUpperCase()) { requestedModel = m![1]!; assumptions.push(`Model ${m![1]} is named in the request: only listings of exactly that model are eligible.`); }
  }
  // V2.3 structural guard (see Uninterpreted.ts).
  const covered: Array<[number, number]> = [...requirements.filter((r) => r.source === "REQUEST_TEXT").map((r) => r.span),
    ...[...money.parse.constraints.map((c) => c.span), ...money.parse.ambiguities.map((c) => c.span), ...money.parse.notes.map((c) => c.span)].filter((x): x is [number, number] => !!x), ...(targetSpan ? [targetSpan] : [])];
  const uninterpreted = uninterpretedWords(text, covered, [target?.brand ?? "", target?.model ?? "", target?.accessoryNoun ?? "", input.exactProduct?.brand ?? "", input.exactProduct?.model ?? "", input.exactProduct?.variant ?? ""]);
  const productTypeWords = target ? [] : [...productType];
  if (uninterpreted.length) assumptions.push(`Words not interpreted: ${uninterpreted.map((u) => `"${u.text}"`).join(", ")}. Research will not recommend or prepare a purchase until they are settled (rephrase the request, or the owner can confirm).`);
  if (language === "ko") assumptions.push("Korean request: provider queries are sent in English (Channel3 has no Korean locale).");
  if (money.currency === "KRW") assumptions.push("Channel3 cannot price in KRW: listing prices will not be in the requested currency.");

  return { version: "intent-v2.0.0", mode, language, currency: money.currency, currencySource: money.currencySource, budgetMinor, budgetSource, budgetConflict, budgetUnresolved, budgetUpperInclusive, budgetMaxMinor, budgetLowerMinor,
    moneyConstraints: money.parse.constraints, moneyAmbiguities: money.parse.ambiguities, target, requestedModel, uninterpreted, productTypeWords, lockBasis,
    attributes, condition, conditionStated, category, categoryNoun: cat?.noun ?? null, mustHave: [...must], niceToHave: [...nice], requirements, unresolvedMust, excludeBundles, objective,
    queries: { primary, fallback }, assumptions };
}
