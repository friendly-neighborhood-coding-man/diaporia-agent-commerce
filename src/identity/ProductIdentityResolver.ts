import type { CatalogProduct, Condition, ProductIdentity } from "../domain/types.js";

export function normalizeModel(model: string): string {
  return model.toUpperCase().replace(/[^A-Z0-9]/g, "");
}
const norm = (v: string | null | undefined) => (v ?? "").trim().toLowerCase();

export interface IdentityHints {
  brand: string | null;
  model: string | null;
  variant: string | null;
  condition: Condition | null;
  sku: string | null;
}

export type IdentityResolution =
  | { status: "LOCKED"; identity: ProductIdentity; productId: string; assumptions: string[] }
  | { status: "AMBIGUOUS"; options: Array<{ productId: string; identity: ProductIdentity }>; question: string }
  | { status: "NOT_FOUND"; reason: string };

/**
 * Resolves an exact product identity from catalog candidates. Never picks a variant the
 * user did not ask for: several matching variants without a stated variant is AMBIGUOUS.
 */
export class ProductIdentityResolver {
  resolve(hints: IdentityHints, candidates: CatalogProduct[]): IdentityResolution {
    if (!hints.model && !hints.sku) return { status: "NOT_FOUND", reason: "No model number or SKU was given, so no exact product can be locked." };
    const assumptions: string[] = [];
    let matches = candidates.filter((c) =>
      (hints.sku ? norm(c.identity.sku) === norm(hints.sku) : true) &&
      (hints.model ? normalizeModel(c.identity.model) === normalizeModel(hints.model) : true) &&
      (hints.brand ? norm(c.identity.brand) === norm(hints.brand) : true));
    if (hints.variant) matches = matches.filter((c) => norm(c.identity.variant) === norm(hints.variant));
    const condition: Condition = hints.condition ?? "new";
    if (!hints.condition) assumptions.push("Condition not stated; locked to NEW. Refurbished or used offers will be rejected.");
    matches = matches.filter((c) => c.identity.condition === condition);
    if (matches.length === 0) return { status: "NOT_FOUND", reason: "No catalog product matches the requested brand, model, variant and condition exactly." };
    if (matches.length > 1) return {
      status: "AMBIGUOUS",
      options: matches.map((m) => ({ productId: m.productId, identity: m.identity })),
      question: `Several variants match (${matches.map((m) => m.identity.variant ?? "unspecified").join(", ")}). Which one should be purchased?`,
    };
    const m = matches[0]!;
    return { status: "LOCKED", productId: m.productId, identity: { ...m.identity }, assumptions };
  }
}

export type IdentityMismatch = "BRAND" | "MODEL" | "VARIANT" | "CONDITION" | "SKU";

/** Strict comparison of a locked identity against a listing. SKU only compared when both are known. */
export function compareIdentity(locked: ProductIdentity, listed: ProductIdentity): IdentityMismatch[] {
  const out: IdentityMismatch[] = [];
  if (norm(locked.brand) !== norm(listed.brand)) out.push("BRAND");
  if (normalizeModel(locked.model) !== normalizeModel(listed.model)) out.push("MODEL");
  if (norm(locked.variant) !== norm(listed.variant)) out.push("VARIANT");
  if (locked.condition !== listed.condition) out.push("CONDITION");
  if (locked.sku && listed.sku && norm(locked.sku) !== norm(listed.sku)) out.push("SKU");
  return out;
}

export function identityEquals(a: ProductIdentity, b: ProductIdentity): boolean {
  return compareIdentity(a, b).length === 0 && norm(a.sku) === norm(b.sku);
}
