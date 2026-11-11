import type { CatalogProduct, Condition, MerchantOffer, ProductIdentity } from "../domain/types.js";
import { AXES, VERSION_AXES, attributesFromVariant, extractIdentity, familyKey, normalizeKey, type AttributeAxis, type ProductKind, type VariantAttributes } from "./ProductIdentityExtractor.js";
import type { ResearchIntentV2 } from "../intent/ResearchIntentV2.js";

/**
 * Research V2 exact-identity resolution (variant-aware, multi-category).
 *
 * Rules (fail closed, never substitute):
 *  1. Family: brand + model key must be equal ("Nova 9" ≠ "Nova 9 Pro"; separators and case ignored).
 *  2. Kind: a standalone request never locks a bundle, multi-pack or accessory, and vice versa; an accessory request
 *     must name the same accessory noun.
 *  3. Attributes: every attribute the user stated must equal the listing's attribute. A listing whose attribute is
 *     unknown or conflicting (title vs structured variant) is excluded for that axis: never assumed to match.
 *  4. Condition: a listing whose title states a condition must match; otherwise at least one offer in the requested
 *     condition must exist. Offers with unknown condition are reported, never treated as new.
 *  5. Availability: at least one offer not known to be out of stock.
 *  6. Several remaining listings that differ on an unstated attribute → AMBIGUOUS (ask). Identical listings → one item.
 */
export interface ProductFacts {
  product: CatalogProduct;
  kind: ProductKind;
  accessoryNoun: string | null;
  attributes: VariantAttributes;
  conflictingAxes: string[];
  titleCondition: Condition | null;
  family: string;
}

export function factsOf(p: CatalogProduct): ProductFacts {
  const r = p.research;
  if (r) {
    const accessoryNoun = r.kind === "ACCESSORY" ? (/^ACCESSORY ([^/]+)/.exec(p.identity.variant ?? "")?.[1]?.trim() ?? null) : null;
    return { product: p, kind: r.kind, accessoryNoun, attributes: r.attributes, conflictingAxes: r.conflictingAxes, titleCondition: (r.titleCondition === "open_box" ? "used" : r.titleCondition) as Condition | null,
      family: familyKey(r.kind === "ACCESSORY" && r.fitsBrand ? r.fitsBrand : p.identity.brand, p.identity.model) };
  }
  // Products without research metadata (fixtures, other adapters): derive from the title and the identity variant.
  const ex = extractIdentity(p.title, p.identity.brand || null);
  return { product: p, kind: ex.kind, accessoryNoun: ex.accessoryNoun, attributes: { ...ex.attributes, ...attributesFromVariant(p.identity.variant) }, conflictingAxes: [],
    titleCondition: p.identity.condition !== "new" ? p.identity.condition : null, family: familyKey(ex.kind === "ACCESSORY" && ex.fitsBrand ? ex.fitsBrand : p.identity.brand, p.identity.model) };
}

const eqAttr = (axis: AttributeAxis, a: string, b: string) => normalizeKey(axis === "color" && /^gr[ae]y$/i.test(a) ? "gray" : a) === normalizeKey(axis === "color" && /^gr[ae]y$/i.test(b) ? "gray" : b);
const nounKey = (n: string | null) => (n ?? "").toLowerCase().replace(/\s+/g, "").replace(/s$/, "");

export type ResolutionV2 =
  | { status: "LOCKED"; productId: string; identity: ProductIdentity; facts: ProductFacts; conditionConfirmed: boolean; duplicates: string[]; assumptions: string[]; excluded: Exclusion[] }
  | { status: "AMBIGUOUS"; options: Array<{ productId: string; identity: ProductIdentity; differing: Partial<Record<AttributeAxis, string>> }>; differingAxes: AttributeAxis[]; question: string; excluded: Exclusion[] }
  | { status: "NOT_FOUND"; code: "NO_MODEL" | "NO_FAMILY_MATCH" | "KIND_MISMATCH" | "ATTRIBUTE_NOT_FOUND" | "CONDITION_NOT_OFFERED" | "UNAVAILABLE"; reason: string;
      /** A sibling variant (product detail) that may match the stated attributes but was not in the search results. */
      siblingToCheck: { productId: string; providerProductId: string; axis: string; label: string } | null; excluded: Exclusion[] };
export interface Exclusion { productId: string; title: string; reason: string }

export function resolveExactV2(intent: Pick<ResearchIntentV2, "target" | "attributes" | "condition" | "conditionStated">, products: CatalogProduct[],
  offersOf: (productId: string) => MerchantOffer[]): ResolutionV2 {
  const t = intent.target;
  const excluded: Exclusion[] = [];
  if (!t?.model && !t?.sku) return { status: "NOT_FOUND", code: "NO_MODEL", reason: "No model was given, so no exact product can be locked.", siblingToCheck: null, excluded };
  const want = familyKey(t!.brand, t!.model);
  const wantNoBrand = normalizeKey(t!.model ?? "");
  let all = products.map(factsOf);
  // An explicit SKU is the strongest identity: only listings with that SKU can be the product.
  if (t.sku) {
    const bySku = all.filter((f) => f.product.identity.sku && normalizeKey(f.product.identity.sku) === normalizeKey(t.sku!));
    for (const f of all) if (!bySku.includes(f)) excluded.push({ productId: f.product.productId, title: f.product.title, reason: f.product.identity.sku ? `SKU ${f.product.identity.sku}, requested ${t.sku}` : "listing has no SKU" });
    all = bySku;
  }
  // A brandless listing can match only a request that names no brand (review R-06): "Sony WH-1000XM5" is never locked
  // to an unbranded "WH-1000XM5 (compatible)" listing.
  // V2.5: a listing whose own model stops before the requested sibling suffix ("AF-55" from "Cindra AF-55 Duo Air
  // Fryer", request "AF-55 Duo") is that model when its title names brand and the full requested model contiguously.
  const suffixMatch = (f: ProductFacts) => {
    const lm = normalizeKey(f.product.identity.model ?? "");
    if (!t!.brand || !t!.model || !lm || !wantNoBrand.startsWith(lm) || wantNoBrand === lm || familyKey(f.product.identity.brand, f.product.identity.model) !== familyKey(t!.brand, f.product.identity.model)) return false;
    const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    return new RegExp(`(?:^|[^A-Za-z0-9])${esc(t!.brand)}\\s+${esc(t!.model)}(?![A-Za-z0-9])`, "i").test(f.product.title.normalize("NFKC"));
  };
  const family = !t!.model ? all : all.filter((f) => f.family === want || suffixMatch(f) || (!t!.brand && !f.product.identity.brand && normalizeKey(f.product.identity.model) === wantNoBrand));
  for (const f of all) if (!family.includes(f)) excluded.push({ productId: f.product.productId, title: f.product.title,
    reason: t!.brand && !f.product.identity.brand && normalizeKey(f.product.identity.model) === wantNoBrand ? `listing states no brand; requested ${t!.brand}` : `different model (${f.product.identity.brand} ${f.product.identity.model || "unknown"})` });
  if (!family.length) return { status: "NOT_FOUND", code: "NO_FAMILY_MATCH", reason: `No listing is the ${t!.brand ?? ""} ${t!.model ?? t!.sku} itself.`.replace(/\s+/g, " "), siblingToCheck: null, excluded };

  const kindOk = family.filter((f) => {
    const ok = f.kind === t.kind && (t.kind !== "ACCESSORY" || nounKey(f.accessoryNoun) === nounKey(t.accessoryNoun));
    if (!ok) excluded.push({ productId: f.product.productId, title: f.product.title, reason: f.kind === "STANDALONE" ? `standalone product, not the requested ${t.kind.toLowerCase()}` : `${f.kind.toLowerCase()}${f.accessoryNoun ? ` (${f.accessoryNoun})` : ""}, not the requested ${t.kind === "ACCESSORY" ? t.accessoryNoun ?? "accessory" : "standalone product"}` });
    return ok;
  });
  if (!kindOk.length) return { status: "NOT_FOUND", code: "KIND_MISMATCH", reason: `Only ${[...new Set(family.map((f) => f.kind.toLowerCase()))].join("/")} listings of this model were found; DIAPORIA never substitutes a bundle, kit or accessory for the product (or the reverse).`, siblingToCheck: null, excluded };

  const stated = AXES.filter((a) => intent.attributes[a] && !(a === "pack" && t.kind === "STANDALONE"));
  const attrOk = kindOk.filter((f) => {
    for (const a of stated) {
      const v = f.attributes[a];
      if (!v || v === "CONFLICT") { excluded.push({ productId: f.product.productId, title: f.product.title, reason: v === "CONFLICT" ? `${a} is contradictory (title vs structured variant)` : `${a} is not stated by the listing` }); return false; }
      if (!eqAttr(a, v, intent.attributes[a]!)) { excluded.push({ productId: f.product.productId, title: f.product.title, reason: `${a} is ${v}, not ${intent.attributes[a]}` }); return false; }
    }
    return true;
  });
  if (!attrOk.length) {
    // Maybe the requested variant exists but was filtered out of search (e.g. out of stock): check one sibling.
    let sibling: { productId: string; providerProductId: string; axis: string; label: string } | null = null;
    for (const f of kindOk) for (const s of f.product.research?.siblingVariants ?? []) {
      const axis = (["color", "size", "storage", "memory", "capacity", "pack"] as AttributeAxis[]).find((a) => a === s.axis.toLowerCase() || (a === "color" && /colou?r/i.test(s.axis)));
      if (axis && intent.attributes[axis] && eqAttr(axis, s.label.replace(/\s+/g, ""), intent.attributes[axis]!.replace(/\s+/g, "")) && !sibling) sibling = { productId: f.product.productId, providerProductId: String(s.providerProductId ?? ""), axis: s.axis, label: s.label };
    }
    const asked = stated.map((a) => `${a} ${intent.attributes[a]}`).join(", ");
    return { status: "NOT_FOUND", code: "ATTRIBUTE_NOT_FOUND", reason: `No listing of this model has ${asked}. Available: ${[...new Set(kindOk.map((f) => f.product.identity.variant ?? "unspecified"))].join("; ")}.`, siblingToCheck: sibling, excluded };
  }

  // N-02: several known versions (model years or generations) of this model and the request names none → ask. A listing
  // that states no version counts as a distinct, unknown version: it never resolves the ambiguity by itself.
  for (const axis of VERSION_AXES) {
    if (intent.attributes[axis]) continue;
    const values = new Map<string, ProductFacts>();
    for (const f of attrOk) { const v = f.attributes[axis] ?? "unknown"; if (!values.has(v)) values.set(v, f); }
    if (values.size > 1) {
      const label = axis === "year" ? "model years" : "generations";
      const shown = [...values.keys()].map((v) => (v === "unknown" ? `a listing that states no ${axis === "year" ? "year" : "generation"}` : axis === "year" ? v : `generation ${v}`));
      return { status: "AMBIGUOUS", differingAxes: [axis], excluded,
        options: [...values.entries()].map(([v, f]) => ({ productId: f.product.productId, identity: { ...f.product.identity, condition: intent.condition }, differing: { [axis]: v } })),
        question: `Several ${label} of this model are listed (${shown.join(", ")}). Which ${axis === "year" ? "model year" : "generation"} should be purchased?` };
    }
  }

  // Condition and availability.
  const condOk: Array<{ f: ProductFacts; confirmed: boolean }> = [];
  for (const f of attrOk) {
    if (f.titleCondition && f.titleCondition !== intent.condition) { excluded.push({ productId: f.product.productId, title: f.product.title, reason: `listing is ${f.titleCondition}, requested ${intent.condition}` }); continue; }
    const offers = offersOf(f.product.productId).filter((o) => o.availability !== "OUT_OF_STOCK");
    if (!offers.length) { excluded.push({ productId: f.product.productId, title: f.product.title, reason: "no offer is in stock" }); continue; }
    const exact = offers.some((o) => o.listedIdentity.condition === intent.condition);
    const unknown = offers.some((o) => o.listedIdentity.condition === "unknown");
    if (exact) condOk.push({ f, confirmed: true });
    else if (unknown && intent.condition === "new") condOk.push({ f, confirmed: false });
    else excluded.push({ productId: f.product.productId, title: f.product.title, reason: `no ${intent.condition} offer (offers: ${[...new Set(offers.map((o) => o.listedIdentity.condition))].join(", ")})` });
  }
  if (!condOk.length) {
    const anyStock = attrOk.some((f) => offersOf(f.product.productId).some((o) => o.availability !== "OUT_OF_STOCK"));
    return anyStock ? { status: "NOT_FOUND", code: "CONDITION_NOT_OFFERED", reason: `The product exists but no ${intent.condition} offer was found.`, siblingToCheck: null, excluded }
      : { status: "NOT_FOUND", code: "UNAVAILABLE", reason: "The requested variant exists but no offer is in stock.", siblingToCheck: null, excluded };
  }

  // Group by full variant identity; listings with identical identity are the same item.
  const groups = new Map<string, Array<{ f: ProductFacts; confirmed: boolean }>>();
  for (const x of condOk) { const k = x.f.product.identity.variant ?? ""; groups.set(k, [...(groups.get(k) ?? []), x]); }
  if (groups.size > 1) {
    const reps = [...groups.values()].map((g) => g[0]!);
    const differingAxes = AXES.filter((a) => new Set(reps.map((r) => r.f.attributes[a] ?? "∅")).size > 1);
    return { status: "AMBIGUOUS", differingAxes, excluded,
      options: reps.map((r) => ({ productId: r.f.product.productId, identity: { ...r.f.product.identity, condition: intent.condition }, differing: Object.fromEntries(differingAxes.map((a) => [a, r.f.attributes[a] ?? "unknown"])) })),
      question: `Several variants match (${reps.map((r) => r.f.product.identity.variant ?? "unspecified").join(", ")}). Which ${differingAxes.join("/") || "variant"} should be purchased?` };
  }
  const g = [...groups.values()][0]!;
  // A listing that IS the requested condition (e.g. a "refurbished" product with its own SKU) beats a new listing that
  // merely carries one offer in that condition.
  g.sort((a, b) => Number(b.f.titleCondition === intent.condition) - Number(a.f.titleCondition === intent.condition) || Number(b.confirmed) - Number(a.confirmed) || offersOf(b.f.product.productId).length - offersOf(a.f.product.productId).length);
  const pick = g[0]!;
  const assumptions: string[] = [];
  if (!intent.conditionStated) assumptions.push("Condition not stated; locked to NEW. Refurbished or used offers will be rejected.");
  if (!pick.confirmed) assumptions.push("No offer states its condition; NEW is not confirmed and must be verified at the merchant.");
  return { status: "LOCKED", productId: pick.f.product.productId, identity: { ...pick.f.product.identity, condition: intent.condition }, facts: pick.f, conditionConfirmed: pick.confirmed,
    duplicates: g.slice(1).map((x) => x.f.product.productId), assumptions, excluded };
}
