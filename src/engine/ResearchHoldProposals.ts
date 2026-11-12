/**
 * V21-04 (independent review of V2.1, Option A): an AI agent can only PROPOSE a research-hold resolution.
 *
 * A proposal records exactly what would change (user, purchase session, requirement or budget, currency) together with
 * the item it would resolve and the agent's text, labelled as the agent's. It clears nothing. Only the human owner, on
 * the owner confirmation page (/research-holds/<id>, owner key + HttpOnly SameSite=Strict session cookie + CSRF token),
 * can confirm it. A proposal is single use (PENDING → CONFIRMED | REJECTED), expires, and is bound by a SHA-256 digest
 * of its exact content: the page shows that content and the confirmation re-checks the digest.
 */
import { createHash, randomUUID } from "node:crypto";
import type { Store } from "../store/Database.js";
import type { HoldKind } from "./PurchaseGate.js";

export const PROPOSAL_TTL_MS = 30 * 60_000;
export type ProposalStatus = "PENDING" | "CONFIRMED" | "REJECTED";
export interface ResearchHoldProposal {
  proposalId: string;
  userId: string;
  purchaseSessionId: string;
  kind: HoldKind;
  requirement: string | null;
  budgetMinor: number | null;
  currency: string;
  /** What is being resolved, copied from the gate at proposal time (shown to the owner). */
  item: { code: string; detail: string; productId: string | null; sessionBudgetMinor: number | null };
  /** Text written by the AI agent. Never treated as the owner's words. */
  agentText: string;
  proposedBy: string;
  digest: string;
  status: ProposalStatus;
  createdAt: number;
  expiresAt: number;
  decidedAt: number | null;
  decidedBy: string | null;
}

export const SCHEMA_RESEARCH_HOLD_PROPOSALS = `CREATE TABLE IF NOT EXISTS research_hold_proposals (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, purchase_session_id TEXT NOT NULL, kind TEXT NOT NULL, requirement TEXT,
  budget_minor INTEGER, currency TEXT NOT NULL, item_json TEXT NOT NULL, agent_text TEXT NOT NULL, proposed_by TEXT NOT NULL,
  digest TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, decided_at INTEGER, decided_by TEXT
);
CREATE INDEX IF NOT EXISTS rhp_by_session ON research_hold_proposals(purchase_session_id);`;

/** Digest over everything the owner is asked to confirm. */
export function proposalDigest(p: Pick<ResearchHoldProposal, "proposalId" | "userId" | "purchaseSessionId" | "kind" | "requirement" | "budgetMinor" | "currency" | "item" | "agentText">): string {
  const canon = JSON.stringify([p.proposalId, p.userId, p.purchaseSessionId, p.kind, p.requirement, p.budgetMinor, p.currency, p.item.code, p.item.detail, p.item.productId, p.item.sessionBudgetMinor, p.agentText]);
  return createHash("sha256").update(canon).digest("hex");
}

export class ResearchHoldProposals {
  constructor(private readonly store: Store, private readonly now: () => number) {
    store.db.exec(SCHEMA_RESEARCH_HOLD_PROPOSALS);
  }

  create(p: Omit<ResearchHoldProposal, "proposalId" | "digest" | "status" | "createdAt" | "expiresAt" | "decidedAt" | "decidedBy">): ResearchHoldProposal {
    const proposalId = `rhp_${randomUUID()}`;
    const createdAt = this.now();
    const full: ResearchHoldProposal = { ...p, proposalId, digest: "", status: "PENDING", createdAt, expiresAt: createdAt + PROPOSAL_TTL_MS, decidedAt: null, decidedBy: null };
    full.digest = proposalDigest(full);
    this.store.db.prepare(`INSERT INTO research_hold_proposals(id,user_id,purchase_session_id,kind,requirement,budget_minor,currency,item_json,agent_text,proposed_by,digest,status,created_at,expires_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(proposalId, p.userId, p.purchaseSessionId, p.kind, p.requirement, p.budgetMinor, p.currency, JSON.stringify(p.item), p.agentText, p.proposedBy,
      full.digest, "PENDING", createdAt, full.expiresAt);
    return full;
  }

  /** The proposal, only for its own user. */
  get(proposalId: string, userId: string): ResearchHoldProposal | null {
    const r = this.store.db.prepare("SELECT * FROM research_hold_proposals WHERE id = ? AND user_id = ?").get(proposalId, userId) as Record<string, any> | undefined;
    if (!r) return null;
    return { proposalId: r.id, userId: r.user_id, purchaseSessionId: r.purchase_session_id, kind: r.kind, requirement: r.requirement ?? null, budgetMinor: r.budget_minor ?? null,
      currency: r.currency, item: JSON.parse(r.item_json), agentText: r.agent_text, proposedBy: r.proposed_by, digest: r.digest, status: r.status, createdAt: Number(r.created_at),
      expiresAt: Number(r.expires_at), decidedAt: r.decided_at ?? null, decidedBy: r.decided_by ?? null };
  }

  /** PENDING → CONFIRMED | REJECTED exactly once. Returns false if it was not PENDING or had expired. Call inside a transaction. */
  decide(proposalId: string, userId: string, status: "CONFIRMED" | "REJECTED", decidedBy: string): boolean {
    const r = this.store.db.prepare("UPDATE research_hold_proposals SET status = ?, decided_at = ?, decided_by = ? WHERE id = ? AND user_id = ? AND status = 'PENDING' AND expires_at > ?")
      .run(status, this.now(), decidedBy, proposalId, userId, this.now());
    return Number(r.changes) === 1;
  }
}
