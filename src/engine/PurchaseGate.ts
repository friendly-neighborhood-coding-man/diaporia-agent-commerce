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
 *
 * V21-04: a resolution exists only when the human owner confirmed an agent's proposal on the owner confirmation page
 * (`confirmation: "CONFIRMED_BY_OWNER"`, ResearchHoldProposals). gateReadiness ignores any other resolution (fail
 * closed), and resolveGate refuses one. R-A: an owner confirmation counts only with a verified human assertion
 * (humanVerification), never from the owner key alone.
 */
import type { Decision } from "../decision/DecisionEngine.js";
import type { StatedRequirement } from "../intent/Requirements.js";
import type { StoredAssertion } from "../auth/OwnerConfirmation.js";

export const GATE_VERSION = "purchase-gate-v1";
const REQUIREMENT_CODES = new Set(["REQUEST_UNINTERPRETED", "MUST_HAVE_UNRECOGNIZED", "MUST_NOT_UNVERIFIABLE", "MUST_HAVE_UNVERIFIED", "MUST_HAVE_CONTRADICTED", "VERIFICATION_LIMIT_REACHED", "ATTRIBUTE_UNKNOWN"]);

export interface GateItem { key: string; code: string; detail: string }
/**
 * V2.2 WP-4: owner resolutions. CONFIRM_BUDGET settles a budget conflict. For an open requirement the owner either
 * WAIVES it (DROP_REQUIREMENT: buy without it being verified; ledger OWNER_WAIVED) or ATTESTS it from firsthand knowledge
 * (ATTEST_REQUIREMENT; ledger OWNER_ATTESTED). Neither is ever reported as independently verified evidence.
 */
export type HoldKind = "CONFIRM_BUDGET" | "DROP_REQUIREMENT" | "ATTEST_REQUIREMENT";
export interface GateResolution {
  kind: HoldKind; requirement: string | null; budgetMinor: number | null; currency: string; at: string;
  /** OWNER_SESSION:<fingerprint of the owner confirmation session>. */
  actor: string;
  confirmation: "CONFIRMED_BY_OWNER";
  proposalId: string;
  /** The digest of the proposal the owner saw and confirmed. */
  proposalDigest: string;
  /** The AI agent's explanation from the proposal: agent-provided, never the owner's words. */
  agentText: string;
  /**
   * R-A: how the human was verified. Only a WebAuthn-style assertion with user verification, made by an authenticator
   * enrolled in the protected owner registry, counts (src/auth/OwnerConfirmation.ts). A resolution recorded without it
   * (for example by an earlier owner-key-only version) stays in the audit trail but is ignored by the gate.
   */
  humanVerification?: "WEBAUTHN_USER_VERIFIED";
  /** Short fingerprint of the authenticator credential that made the assertion. */
  credentialFingerprint?: string;
  /** V2.2 WP-2: the assertion itself, re-verified against the registry public key at every gate check. */
  assertion?: StoredAssertion;
}
/**
 * V2.2 WP-2 (H-2): decides whether a stored owner resolution is genuine. The gateway passes one that re-verifies the
 * stored passkey assertion against the protected registry. Strings alone never suffice in production.
 */
export type ResolutionVerifier = (r: GateResolution) => boolean;
const ownerConfirmed = (r: GateResolution) => r.confirmation === "CONFIRMED_BY_OWNER" && typeof r.proposalId === "string" && /^OWNER_SESSION:/.test(r.actor ?? "")
  && r.humanVerification === "WEBAUTHN_USER_VERIFIED" && typeof r.credentialFingerprint === "string" && r.credentialFingerprint.length > 0;
export interface PurchaseGate {
  version: typeof GATE_VERSION;
  decisionState: Decision["state"];
  budgetConflict: string | null;
  products: Record<string, { hard: GateItem[]; requirements: GateItem[]; verified?: Array<{ key: string; basis: string; sources: string[] }> }>;
  resolutions: GateResolution[];
  /** N-01: every requirement the user stated (recognized or not), with spans and provenance. */
  stated?: StatedRequirement[];
}

/** Stable key for an open requirement, used by DROP_REQUIREMENT. */
export function requirementKey(code: string, detail: string): string {
  const cap = /must-have "([^"]+)"/.exec(detail)?.[1];
  if (cap) return `must:${cap}`;
  if (code === "ATTRIBUTE_UNKNOWN") return `attribute:${detail.split(" ")[0]}`;
  return `${code.toLowerCase()}`;
}

export function gateFromDecision(decision: Decision, budgetConflict: string | null, stated: StatedRequirement[] = []): PurchaseGate {
  const products: PurchaseGate["products"] = {};
  for (const r of decision.ranking) products[r.productId] = {
    hard: r.disqualifiers.map((d) => ({ key: d.code.toLowerCase(), code: d.code, detail: d.detail })),
    requirements: r.blockers.filter((b) => REQUIREMENT_CODES.has(b.code)).map((b) => ({ key: requirementKey(b.code, b.detail), code: b.code, detail: b.detail })),
    verified: (r.satisfied ?? []).map((x) => ({ key: x.key, basis: x.basis, sources: x.sources })),
  };
  return { version: GATE_VERSION, decisionState: decision.state, budgetConflict, products, resolutions: [], stated };
}

export interface GateReadiness { ready: boolean; open: string[]; effectiveBudgetMinor: number | null; budgetSource: "SESSION" | "USER_CONFIRMED" }

/**
 * Whether `productId` may proceed to a payment preparation. A missing gate on a V2 session, or a product the research
 * never assessed, is NOT ready (fail closed). `legacy` = a V1-engine session (no decision exists; V1 rules apply).
 */
export function gateReadiness(gate: PurchaseGate | null | undefined, productId: string | null, sessionBudgetMinor: number | null, legacy: boolean, verify?: ResolutionVerifier): GateReadiness {
  if (legacy) return { ready: true, open: [], effectiveBudgetMinor: sessionBudgetMinor, budgetSource: "SESSION" };
  const owned = (gate?.resolutions ?? []).filter((r) => ownerConfirmed(r) && (!verify || verify(r)));
  const confirmed = [...owned].reverse().find((r) => r.kind === "CONFIRM_BUDGET");
  const effectiveBudgetMinor = confirmed ? confirmed.budgetMinor : sessionBudgetMinor;
  const budgetSource = confirmed ? "USER_CONFIRMED" as const : "SESSION" as const;
  if (!gate || gate.version !== GATE_VERSION) return { ready: false, open: ["The research decision for this session is missing; research again."], effectiveBudgetMinor, budgetSource };
  const open: string[] = [];
  if (gate.budgetConflict && !confirmed) open.push(`Budget unresolved: ${gate.budgetConflict}. Confirm a budget in the session currency.`);
  const p = productId ? gate.products[productId] : undefined;
  if (!p) open.push("This product was not assessed by the research decision.");
  else {
    for (const h of p.hard) open.push(`Known violation (start a new research session): ${h.detail}`);
    const dropped = new Set(owned.filter((r) => r.kind === "DROP_REQUIREMENT" || r.kind === "ATTEST_REQUIREMENT").map((r) => r.requirement));
    for (const q of p.requirements) if (!dropped.has(q.key)) open.push(`Unresolved requirement ${q.key}: ${q.detail}`);
  }
  return { ready: open.length === 0, open, effectiveBudgetMinor, budgetSource };
}

/** Appends an audited resolution. Throws on anything that is not a resolvable open item. */
export function resolveGate(gate: PurchaseGate, r: Omit<GateResolution, "at"> & { at?: string }, now: number, sessionCurrency: string, verify?: ResolutionVerifier): PurchaseGate {
  if (!ownerConfirmed({ ...r, at: "" } as GateResolution)) throw new Error("Only an owner-confirmed proposal can resolve a research hold.");
  if (r.currency !== sessionCurrency) throw new Error(`Resolution currency ${r.currency} does not match the session currency ${sessionCurrency}`);
  if (r.kind === "CONFIRM_BUDGET") {
    if (!gate.budgetConflict) throw new Error("There is no unresolved budget in this session; research again to change the budget.");
    if (r.budgetMinor === null || !Number.isSafeInteger(r.budgetMinor) || r.budgetMinor <= 0) throw new Error("budgetMinor must be a positive integer of minor units");
  } else {
    const dropped = new Set(gate.resolutions.filter((x) => ownerConfirmed(x) && (!verify || verify(x))).filter((x) => x.kind === "DROP_REQUIREMENT" || x.kind === "ATTEST_REQUIREMENT").map((x) => x.requirement));
    const open = new Set(Object.values(gate.products).flatMap((p) => p.requirements.map((q) => q.key)).filter((k) => !dropped.has(k)));
    if (!r.requirement || !open.has(r.requirement)) throw new Error(`No open requirement ${r.requirement ?? "(none)"} in this session`);
  }
  return { ...gate, resolutions: [...gate.resolutions, { ...r, at: r.at ?? new Date(now).toISOString() }] };
}

export type RequirementStatus = "VERIFIED" | "VIOLATED" | "CONTRADICTED" | "UNVERIFIED" | "UNRECOGNIZED" | "UNVERIFIABLE" | "REMOVED_BY_OWNER" | "ATTESTED_BY_OWNER" | "OPTIONAL" | "NOT_ASSESSED";
/**
 * V2.2 WP-4 verification state (one of five for a MUST requirement): VERIFIED (evidence or catalog identity, with its
 * basis), CONTRADICTED (evidence shows this product fails it: a known violation), UNVERIFIED (open, including sources
 * that disagree), OWNER_ATTESTED, OWNER_WAIVED. Optional and category words are NOT_REQUIRED; no product: NOT_ASSESSED.
 */
export type VerificationState = "VERIFIED" | "CONTRADICTED" | "UNVERIFIED" | "OWNER_ATTESTED" | "OWNER_WAIVED" | "NOT_REQUIRED" | "NOT_ASSESSED";
/**
 * N-01 requirement ledger for one product: each stated requirement with its span, whether it was recognized, and its
 * current status (verified, contradicted, still open, or explicitly removed by the human owner).
 */
export function requirementLedger(gate: PurchaseGate | null | undefined, productId: string | null, verify?: ResolutionVerifier) {
  const p = gate && productId ? gate.products[productId] : undefined;
  const owned = (gate?.resolutions ?? []).filter((r) => ownerConfirmed(r) && (!verify || verify(r)));
  const removed = new Set(owned.filter((r) => r.kind === "DROP_REQUIREMENT").map((r) => r.requirement));
  const attested = new Set(owned.filter((r) => r.kind === "ATTEST_REQUIREMENT").map((r) => r.requirement));
  return (gate?.stated ?? []).map((r) => {
    const key = `must:${r.key}`;
    let status: RequirementStatus;
    if (r.strength === "NICE") status = "OPTIONAL";
    else if (!p) status = "NOT_ASSESSED";
    else if (attested.has(key)) status = "ATTESTED_BY_OWNER";
    else if (removed.has(key)) status = "REMOVED_BY_OWNER";
    else if (p.hard.some((h) => h.code === "MUST_HAVE_FALSE" && h.detail.includes(`"${r.key}"`))) status = "VIOLATED";
    else {
      const open = p.requirements.find((q) => q.key === key);
      status = !open ? "VERIFIED" : open.code === "MUST_HAVE_CONTRADICTED" ? "CONTRADICTED" : open.code === "MUST_HAVE_UNRECOGNIZED" || open.code === "REQUEST_UNINTERPRETED" ? "UNRECOGNIZED"
        : open.code === "MUST_NOT_UNVERIFIABLE" ? "UNVERIFIABLE" : "UNVERIFIED";
    }
    const verification: VerificationState = status === "OPTIONAL" ? "NOT_REQUIRED" : status === "NOT_ASSESSED" ? "NOT_ASSESSED" : status === "VERIFIED" ? "VERIFIED"
      : status === "VIOLATED" ? "CONTRADICTED" : status === "ATTESTED_BY_OWNER" ? "OWNER_ATTESTED" : status === "REMOVED_BY_OWNER" ? "OWNER_WAIVED" : "UNVERIFIED";
    const how = verification === "VERIFIED" ? p?.verified?.find((x) => x.key === r.key) ?? null : null;
    return { key, text: r.text, span: r.span, recognized: r.recognized, polarity: r.polarity, strength: r.strength, source: r.source, status, verification,
      proposition: r.proposition ?? null, claimType: r.claimType ?? null, note: r.note ?? null,
      // Identity binding: the product this state belongs to, and how it was established (never the owner's word).
      binding: productId ? { productId } : null, evidence: how ? { basis: how.basis, sources: how.sources } : null,
      ...(verification === "OWNER_ATTESTED" ? { caution: "Attested by the owner from their own knowledge; not independently verified." } : {}),
      ...(verification === "OWNER_WAIVED" ? { caution: "Waived by the owner; nobody verified that the product meets it." } : {}) };
  });
}
