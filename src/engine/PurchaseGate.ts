/**
 * Research-to-purchase decision binding (V2.1 Phase 1).
 *
 * The research decision is stored on the purchase session as a PurchaseGate. Later steps read it instead of trusting
 * the session state alone:
 *  - compare_purchase_offers stays available (read-only), but a session whose chosen product has an unresolved research
 *    requirement can never reach OFFER_VERIFIED: it ends in HOLD with the open items listed.
 *  - prepare_checkout re-checks the gate (defense in depth) before any quote, mandate or provider call.
 *
 * What blocks, per product:
 *  - HARD: a known violation found by research (disqualifiers: wrong category, accessory, bundle, attribute or
 *    condition mismatch, over budget, unavailable, a must-have verified false, not the locked identity). Never
 *    resolvable in this session: scoring or quoting cannot make it eligible. A new research session is required.
 *  - REQUIREMENT: a must-have that is unverified, contradicted or not checked, or a requested attribute the listing does
 *    not confirm. Stays open until evidence verifies it (a new research session) or the user explicitly drops that
 *    requirement (an audited resolution). Quoting never resolves it.
 *  - BUDGET_CONFLICT: the request stated a budget in another currency than the session currency. Open until the user
 *    confirms a budget in the session currency (audited resolution).
 * Blockers that a verified merchant quote does resolve (price currency, budget headroom, stock, condition) are not
 * gated here: the offer verifier enforces them against the quote.
 *
 * A resolution never deletes the original uncertainty: the gate keeps the original items and appends the resolution
 * (who, when, what) so the audit trail shows both.
 */
import type { Decision } from "../decision/DecisionEngine.js";

export const GATE_VERSION = "purchase-gate-v1";
const REQUIREMENT_CODES = new Set(["MUST_HAVE_UNVERIFIED", "MUST_HAVE_CONTRADICTED", "VERIFICATION_LIMIT_REACHED", "ATTRIBUTE_UNKNOWN"]);

export interface GateItem { key: string; code: string; detail: string }
export interface GateResolution { kind: "CONFIRM_BUDGET" | "DROP_REQUIREMENT"; requirement: string | null; budgetMinor: number | null; currency: string; at: string; actor: string; note: string }
export interface PurchaseGate {
  version: typeof GATE_VERSION;
  decisionState: Decision["state"];
  budgetConflict: string | null;
  products: Record<string, { hard: GateItem[]; requirements: GateItem[] }>;
  resolutions: GateResolution[];
}

/** Stable key for an open requirement, used by DROP_REQUIREMENT. */
export function requirementKey(code: string, detail: string): string {
  const cap = /must-have "([^"]+)"/.exec(detail)?.[1];
  if (cap) return `must:${cap}`;
  if (code === "ATTRIBUTE_UNKNOWN") return `attribute:${detail.split(" ")[0]}`;
  return `${code.toLowerCase()}`;
}

export function gateFromDecision(decision: Decision, budgetConflict: string | null): PurchaseGate {
  const products: PurchaseGate["products"] = {};
  for (const r of decision.ranking) products[r.productId] = {
    hard: r.disqualifiers.map((d) => ({ key: d.code.toLowerCase(), code: d.code, detail: d.detail })),
    requirements: r.blockers.filter((b) => REQUIREMENT_CODES.has(b.code)).map((b) => ({ key: requirementKey(b.code, b.detail), code: b.code, detail: b.detail })),
  };
  return { version: GATE_VERSION, decisionState: decision.state, budgetConflict, products, resolutions: [] };
}

export interface GateReadiness { ready: boolean; open: string[]; effectiveBudgetMinor: number | null; budgetSource: "SESSION" | "USER_CONFIRMED" }

/**
 * Whether `productId` may proceed to a payment preparation. A missing gate on a V2 session, or a product the research
 * never assessed, is NOT ready (fail closed). `legacy` = a V1-engine session (no decision exists; V1 rules apply).
 */
export function gateReadiness(gate: PurchaseGate | null | undefined, productId: string | null, sessionBudgetMinor: number | null, legacy: boolean): GateReadiness {
  if (legacy) return { ready: true, open: [], effectiveBudgetMinor: sessionBudgetMinor, budgetSource: "SESSION" };
  const confirmed = [...(gate?.resolutions ?? [])].reverse().find((r) => r.kind === "CONFIRM_BUDGET");
  const effectiveBudgetMinor = confirmed ? confirmed.budgetMinor : sessionBudgetMinor;
  const budgetSource = confirmed ? "USER_CONFIRMED" as const : "SESSION" as const;
  if (!gate || gate.version !== GATE_VERSION) return { ready: false, open: ["The research decision for this session is missing; research again."], effectiveBudgetMinor, budgetSource };
  const open: string[] = [];
  if (gate.budgetConflict && !confirmed) open.push(`Budget unresolved: ${gate.budgetConflict}. Confirm a budget in the session currency.`);
  const p = productId ? gate.products[productId] : undefined;
  if (!p) open.push("This product was not assessed by the research decision.");
  else {
    for (const h of p.hard) open.push(`Known violation (start a new research session): ${h.detail}`);
    const dropped = new Set(gate.resolutions.filter((r) => r.kind === "DROP_REQUIREMENT").map((r) => r.requirement));
    for (const q of p.requirements) if (!dropped.has(q.key)) open.push(`Unresolved requirement ${q.key}: ${q.detail}`);
  }
  return { ready: open.length === 0, open, effectiveBudgetMinor, budgetSource };
}

/** Appends an audited resolution. Throws on anything that is not a resolvable open item. */
export function resolveGate(gate: PurchaseGate, r: Omit<GateResolution, "at"> & { at?: string }, now: number, sessionCurrency: string): PurchaseGate {
  if (r.currency !== sessionCurrency) throw new Error(`Resolution currency ${r.currency} does not match the session currency ${sessionCurrency}`);
  if (r.kind === "CONFIRM_BUDGET") {
    if (!gate.budgetConflict) throw new Error("There is no budget conflict to resolve in this session; research again to change the budget.");
    if (r.budgetMinor === null || !Number.isSafeInteger(r.budgetMinor) || r.budgetMinor <= 0) throw new Error("budgetMinor must be a positive integer of minor units");
  } else {
    const open = new Set(Object.values(gate.products).flatMap((p) => p.requirements.map((q) => q.key)));
    if (!r.requirement || !open.has(r.requirement)) throw new Error(`No open requirement ${r.requirement ?? "(none)"} in this session`);
  }
  return { ...gate, resolutions: [...gate.resolutions, { ...r, at: r.at ?? new Date(now).toISOString() }] };
}
