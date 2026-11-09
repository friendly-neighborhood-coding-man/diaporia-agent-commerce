import { createHash } from "node:crypto";
import type { Store } from "../store/Database.js";
import { redact } from "../security/redact.js";

export interface AuditEvent { seq: number; subjectId: string; type: string; data: unknown; at: string; hash: string }

/** Append-only, hash-chained, redacted audit journal stored in the same database. */
export class PurchaseAuditJournal {
  constructor(private readonly store: Store, private readonly now: () => number = Date.now) {}

  append(subjectId: string, userId: string, type: string, data: unknown = {}): void {
    const json = JSON.stringify(redact(data));
    const at = this.now();
    this.store.transaction(() => {
      const last = this.store.db.prepare("SELECT hash FROM audit_events ORDER BY seq DESC LIMIT 1").get() as { hash: string } | undefined;
      const prev = last?.hash ?? "GENESIS";
      const hash = createHash("sha256").update(`${prev}|${subjectId}|${userId}|${type}|${json}|${at}`).digest("hex");
      this.store.db.prepare("INSERT INTO audit_events(subject_id,user_id,type,data_json,at,prev_hash,hash) VALUES (?,?,?,?,?,?,?)")
        .run(subjectId, userId, type, json, at, prev, hash);
    });
  }

  timeline(subjectIds: string[], userId: string): AuditEvent[] {
    if (subjectIds.length === 0) return [];
    const rows = this.store.db.prepare(
      `SELECT seq, subject_id, type, data_json, at, hash FROM audit_events WHERE user_id = ? AND subject_id IN (${subjectIds.map(() => "?").join(",")}) ORDER BY seq`,
    ).all(userId, ...subjectIds) as Array<{ seq: number; subject_id: string; type: string; data_json: string; at: number; hash: string }>;
    return rows.map((r) => ({ seq: r.seq, subjectId: r.subject_id, type: r.type, data: JSON.parse(r.data_json), at: new Date(r.at).toISOString(), hash: r.hash }));
  }

  /** Recomputes the chain; returns the first broken sequence number or null. */
  verifyChain(): number | null {
    const rows = this.store.db.prepare("SELECT * FROM audit_events ORDER BY seq").all() as Array<Record<string, string | number>>;
    let prev = "GENESIS";
    for (const r of rows) {
      const hash = createHash("sha256").update(`${prev}|${r.subject_id}|${r.user_id}|${r.type}|${r.data_json}|${r.at}`).digest("hex");
      if (r.prev_hash !== prev || r.hash !== hash) return Number(r.seq);
      prev = hash;
    }
    return null;
  }
}
