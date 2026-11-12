/**
 * RESEARCH (research/semantic-category-count-v1). Not wired into any default path.
 *
 * Category-count experiment: the same atomic span-unit representation is classified into K = 3..7 mandatory
 * semantic categories (plus K3F = the K3 core with an optional fine sub-type). The category count and grouping are the
 * only independent variables. Every arm shares:
 *   - the atomic unit fields (span, facet, status, attribute, operator, value, unit, target, component, resolution,
 *     English statement, Latin brand spelling),
 *   - the top-level item kind, language and the `unresolved` list (never a category, never counted in K),
 *   - one deterministic projection into diaporia.semantic-intent.v1.1 (CategoryProjection.ts), so the downstream
 *     adapter (typed adapter v0.2), engine, evidence, gates and payment code are byte-identical across arms.
 *
 * The seven fine categories (K7) are a nested refinement chain: K3 -> K4 -> K5 -> K6 -> K7, each step splits exactly
 * one category of the previous level. The fine category of a unit is a pure function of its atomic facet and status
 * (fineOf), so a unit whose category label disagrees with its own atomic fields is a measurable classification error.
 */

export const ARMS = ["K3", "K4", "K5", "K6", "K7", "K3F"] as const;
export type Arm = (typeof ARMS)[number];

/** The seven fine semantic categories (the K7 taxonomy, numbered as in the experiment brief). */
export const FINE = ["IDENTITY", "REQUIREMENT", "EXCLUSION", "RELATION", "PURCHASE", "PREFERENCE", "CONTEXT"] as const;
export type Fine = (typeof FINE)[number];

/** Shared atomic vocabularies (identical in every arm). */
export const IDENTITY_FACETS = ["product_type", "brand", "model", "host", "kind_marker"] as const;
export const PRODUCT_FACETS = ["feature", "measure"] as const;
export const RELATION_FACETS = ["compatibility", "suitability", "includes"] as const;
export const PURCHASE_FACETS = ["budget", "condition", "quantity", "delivery", "seller"] as const;
export const FACETS = [...IDENTITY_FACETS, ...PRODUCT_FACETS, ...RELATION_FACETS, ...PURCHASE_FACETS, "background"] as const;
export type Facet = (typeof FACETS)[number];
export const STATUSES = ["mandatory", "forbidden", "preferred", "context"] as const;
export type Status = (typeof STATUSES)[number];
export const OPERATORS = ["is", "has", ">=", "<=", ">", "<", "=", "fits", "for", "includes"] as const;
export const TARGETS = ["item", "component", "host", "user", "load", "purchase", "other"] as const;
export const RESOLUTIONS = ["resolved", "ambiguous"] as const;

const isIn = <T extends readonly string[]>(xs: T, v: string): v is T[number] => (xs as readonly string[]).includes(v);

/**
 * The fine category implied by a unit's atomic fields, or null when the combination has no meaning
 * (a background facet stated as mandatory/forbidden, or an identity facet stated as preferred is allowed -> PREFERENCE).
 */
export function fineOf(facet: Facet, status: Status): Fine | null {
  if (status === "context") return facet === "background" || isIn(RELATION_FACETS, facet) ? "CONTEXT" : null;
  if (facet === "background") return null;
  if (status === "preferred") return "PREFERENCE";
  if (isIn(PURCHASE_FACETS, facet)) return "PURCHASE"; // mandatory or forbidden purchase terms ("not refurbished")
  if (status === "forbidden") return "EXCLUSION";
  if (isIn(IDENTITY_FACETS, facet)) return "IDENTITY";
  if (isIn(RELATION_FACETS, facet)) return "RELATION";
  return "REQUIREMENT";
}

export interface CategoryDef { name: string; fine: Fine[]; definition: string }

/** Exact grouping of the seven fine categories for every arm (documented in research/category-count/TAXONOMIES.md). */
export const TAXONOMY: Record<Exclude<Arm, "K3F">, CategoryDef[]> = {
  K7: [
    { name: "IDENTITY", fine: ["IDENTITY"], definition: "what the item to buy is: product type, brand, model/variant words, the host product of an accessory, and kind markers (bundle, kit, replacement part)" },
    { name: "REQUIREMENT", fine: ["REQUIREMENT"], definition: "a feature or measurable property the item itself must have" },
    { name: "EXCLUSION", fine: ["EXCLUSION"], definition: "a feature, property, variant, model or kind the user does not want" },
    { name: "RELATION", fine: ["RELATION"], definition: "what the item must fit, work with, carry, hold, serve or include (compatibility, capacity for a load or user, bundle contents)" },
    { name: "PURCHASE", fine: ["PURCHASE"], definition: "terms of the purchase rather than the product: price limit, condition (new/used/refurbished), quantity, delivery, seller" },
    { name: "PREFERENCE", fine: ["PREFERENCE"], definition: "a nice-to-have the user would like but does not require" },
    { name: "CONTEXT", fine: ["CONTEXT"], definition: "background only (occasion, story, who it is for when no product condition follows); never a product condition" },
  ],
  K6: [
    { name: "IDENTITY", fine: ["IDENTITY"], definition: "what the item to buy is: product type, brand, model/variant words, the host product of an accessory, and kind markers (bundle, kit, replacement part)" },
    { name: "PRODUCT_CONDITION", fine: ["REQUIREMENT", "EXCLUSION"], definition: "a feature or measurable property the item itself must have (status mandatory) or must not have, including unwanted variants, models or kinds (status forbidden)" },
    { name: "RELATION", fine: ["RELATION"], definition: "what the item must fit, work with, carry, hold, serve or include (compatibility, capacity for a load or user, bundle contents)" },
    { name: "PURCHASE", fine: ["PURCHASE"], definition: "terms of the purchase rather than the product: price limit, condition (new/used/refurbished), quantity, delivery, seller" },
    { name: "PREFERENCE", fine: ["PREFERENCE"], definition: "a nice-to-have the user would like but does not require" },
    { name: "CONTEXT", fine: ["CONTEXT"], definition: "background only (occasion, story, who it is for when no product condition follows); never a product condition" },
  ],
  K5: [
    { name: "IDENTITY", fine: ["IDENTITY"], definition: "what the item to buy is: product type, brand, model/variant words, the host product of an accessory, and kind markers (bundle, kit, replacement part)" },
    { name: "PRODUCT_CONDITION", fine: ["REQUIREMENT", "EXCLUSION", "RELATION"], definition: "any condition on the product that the user requires: a feature or measurable property it must have (mandatory) or must not have, including unwanted variants, models or kinds (forbidden), and what it must fit, work with, carry, hold, serve or include (mandatory)" },
    { name: "PURCHASE", fine: ["PURCHASE"], definition: "terms of the purchase rather than the product: price limit, condition (new/used/refurbished), quantity, delivery, seller" },
    { name: "PREFERENCE", fine: ["PREFERENCE"], definition: "a nice-to-have the user would like but does not require" },
    { name: "CONTEXT", fine: ["CONTEXT"], definition: "background only (occasion, story, who it is for when no product condition follows); never a product condition" },
  ],
  K4: [
    { name: "IDENTITY", fine: ["IDENTITY"], definition: "what the item to buy is: product type, brand, model/variant words, the host product of an accessory, and kind markers (bundle, kit, replacement part)" },
    { name: "PRODUCT_CONDITION", fine: ["REQUIREMENT", "EXCLUSION", "RELATION"], definition: "any condition on the product that the user requires: a feature or measurable property it must have (mandatory) or must not have, including unwanted variants, models or kinds (forbidden), and what it must fit, work with, carry, hold, serve or include (mandatory)" },
    { name: "PURCHASE", fine: ["PURCHASE"], definition: "terms of the purchase rather than the product: price limit, condition (new/used/refurbished), quantity, delivery, seller" },
    { name: "NON_BINDING", fine: ["PREFERENCE", "CONTEXT"], definition: "anything that must not restrict the choice: a nice-to-have preference (status preferred) or background such as occasion, story or who it is for when no product condition follows (status context)" },
  ],
  K3: [
    { name: "IDENTITY", fine: ["IDENTITY"], definition: "what the item to buy is: product type, brand, model/variant words, the host product of an accessory, and kind markers (bundle, kit, replacement part)" },
    { name: "BINDING", fine: ["REQUIREMENT", "EXCLUSION", "RELATION", "PURCHASE"], definition: "every condition the choice must satisfy: a feature or measurable property the item must have (mandatory) or must not have, including unwanted variants, models or kinds (forbidden); what it must fit, work with, carry, hold, serve or include (mandatory); and purchase terms such as price limit, condition, quantity, delivery or seller" },
    { name: "NON_BINDING", fine: ["PREFERENCE", "CONTEXT"], definition: "anything that must not restrict the choice: a nice-to-have preference (status preferred) or background such as occasion, story or who it is for when no product condition follows (status context)" },
  ],
};

export const categoriesOf = (arm: Arm): string[] => TAXONOMY[arm === "K3F" ? "K3" : arm].map((c) => c.name);
/** The arm category that contains a fine category (the nested grouping). */
export function groupOf(arm: Arm, fine: Fine): string {
  const t = TAXONOMY[arm === "K3F" ? "K3" : arm];
  return t.find((c) => c.fine.includes(fine))!.name;
}
