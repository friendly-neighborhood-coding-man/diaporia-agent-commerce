import type { Condition, IntentMode, ProductIdentity } from "../domain/types.js";
import { isCurrency, parseDecimalToMinor, type Currency } from "../domain/money.js";
import type { IdentityHints } from "../identity/ProductIdentityResolver.js";

export interface PurchaseRequestInput {
  request: string;
  budgetMinor?: number | undefined;
  currency?: string | undefined;
  mustHave?: string[] | undefined;
  niceToHave?: string[] | undefined;
  exactProduct?: Partial<ProductIdentity> | undefined;
}

export interface RoutedIntent {
  mode: IntentMode;
  currency: Currency;
  /** Hard budget for the WHOLE checkout total in minor units, or null if none was given. */
  budgetMinor: number | null;
  budgetSource: "STRUCTURED_INPUT" | "PARSED_FROM_TEXT" | "NONE";
  identityHints: IdentityHints;
  category: string | null;
  mustHave: string[];
  niceToHave: string[];
  objective: "LOWEST_VERIFIED_TOTAL" | "BEST_SUITABILITY";
  assumptions: string[];
}

const BRANDS = ["sony", "bose", "apple", "samsung", "jbl", "sennheiser", "northwind", "lumen", "contoso", "anker", "beats"];
const COLORS = ["black", "white", "blue", "silver", "gray", "grey", "graphite", "red", "green", "pink", "beige", "midnight"];
const CAPABILITY_WORDS: Array<[RegExp, string]> = [
  [/noise[- ]?cancel(?:l)?ing|\banc\b/i, "active_noise_cancellation"],
  [/wireless|bluetooth/i, "wireless"],
  [/multipoint|multi-point/i, "multipoint"],
  [/over[- ]ear/i, "over_ear"],
];
const BUDGET_RE = /(?:under|below|less than|at most|max(?:imum)?(?: of)?|no more than|never (?:go over|exceed)|not exceed|up to|budget(?: of| is)?|within)\s*(?:\$|usd\s*)?\s*(\d[\d,]*(?:\.\d{1,2})?)\s*(usd|dollars?|eur|euros?)?/i;
const MODEL_RE = /\b([A-Z]{1,6}-?[A-Z0-9]*\d[A-Z0-9]*(?:-[A-Z0-9]+)*)\b/;

/**
 * Deterministic intent routing. It does not call an LLM, and nothing it returns
 * authorizes payment: budgets here only filter results. Spending authority comes
 * exclusively from a user-created PurchaseMandate.
 */
export class PurchaseIntentRouter {
  route(input: PurchaseRequestInput): RoutedIntent {
    const text = input.request.slice(0, 2000);
    const assumptions: string[] = [];
    const currency: Currency = isCurrency(input.currency) ? input.currency : /€|\beur/i.test(text) ? "EUR" : "USD";
    if (!input.currency) assumptions.push(`Currency not given; using ${currency}.`);

    let budgetMinor: number | null = null;
    let budgetSource: RoutedIntent["budgetSource"] = "NONE";
    if (input.budgetMinor !== undefined) { budgetMinor = input.budgetMinor; budgetSource = "STRUCTURED_INPUT"; }
    else {
      const m = BUDGET_RE.exec(text);
      if (m) { budgetMinor = parseDecimalToMinor(m[1]!, currency); budgetSource = "PARSED_FROM_TEXT"; }
    }

    const ex = input.exactProduct ?? {};
    const lower = text.toLowerCase();
    const brand = ex.brand ?? BRANDS.find((b) => new RegExp(`\\b${b}\\b`).test(lower)) ?? null;
    const modelMatch = MODEL_RE.exec(text.replace(/\$\s*\d[\d,.]*/g, " "));
    const model = ex.model ?? modelMatch?.[1] ?? null;
    const variant = ex.variant ?? COLORS.find((c) => new RegExp(`\\b${c}\\b`).test(lower)) ?? null;
    const condition: Condition | null = ex.condition ?? (/refurb/i.test(text) ? "refurbished" : /\bused\b|pre-?owned/i.test(text) ? "used" : /\bnew\b/i.test(text) ? "new" : null);
    const identityHints: IdentityHints = {
      brand: brand ? brand.charAt(0).toUpperCase() + brand.slice(1) : null,
      model, variant: variant ? variant.charAt(0).toUpperCase() + variant.slice(1) : null, condition, sku: ex.sku ?? null,
    };

    const buyVerb = /\b(buy|purchase|order|checkout|get me)\b/i.test(text);
    const mode: IntentMode = (ex.model || ex.sku) || (model && (buyVerb || brand)) ? "EXACT_PRODUCT_PURCHASE" : "PRODUCT_DISCOVERY";
    if (mode === "PRODUCT_DISCOVERY" && buyVerb) assumptions.push("Purchase verb found but no exact model; running discovery first.");

    const textCaps = CAPABILITY_WORDS.filter(([re]) => re.test(text)).map(([, cap]) => cap);
    const mustHave = [...new Set([...(input.mustHave ?? []), ...(mode === "PRODUCT_DISCOVERY" ? textCaps : [])])];
    const niceToHave = [...new Set((input.niceToHave ?? []).filter((n) => !mustHave.includes(n)))];
    const category = /headphone|earbud|earphone/i.test(text) || brand ? "headphones" : null;
    const objective = mode === "EXACT_PRODUCT_PURCHASE" || /cheapest|lowest/i.test(text) ? "LOWEST_VERIFIED_TOTAL" : "BEST_SUITABILITY";
    return { mode, currency, budgetMinor, budgetSource, identityHints, category, mustHave, niceToHave, objective, assumptions };
  }
}
