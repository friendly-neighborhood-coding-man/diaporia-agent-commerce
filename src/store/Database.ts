import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS purchase_sessions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, state TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0,
  mode TEXT NOT NULL, request_text TEXT NOT NULL, intent_json TEXT NOT NULL,
  locked_identity_json TEXT, product_id TEXT, research_json TEXT NOT NULL,
  comparison_json TEXT, destination_json TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mandates (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, identity_json TEXT NOT NULL, currency TEXT NOT NULL,
  max_total_minor INTEGER NOT NULL CHECK (max_total_minor > 0),
  max_quantity INTEGER NOT NULL CHECK (max_quantity > 0),
  max_transactions INTEGER NOT NULL CHECK (max_transactions > 0),
  expires_at INTEGER NOT NULL, merchant_constraints_json TEXT NOT NULL,
  status TEXT NOT NULL, checkout_session_id TEXT, revoked_at INTEGER,
  reserved_minor INTEGER NOT NULL DEFAULT 0 CHECK (reserved_minor >= 0),
  consumed_minor INTEGER NOT NULL DEFAULT 0 CHECK (consumed_minor >= 0),
  transactions_used INTEGER NOT NULL DEFAULT 0,
  created_via TEXT NOT NULL, created_at INTEGER NOT NULL,
  CHECK (reserved_minor + consumed_minor <= max_total_minor),
  CHECK (transactions_used <= max_transactions)
);
CREATE TABLE IF NOT EXISTS checkout_sessions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, purchase_session_id TEXT NOT NULL REFERENCES purchase_sessions(id),
  offer_id TEXT NOT NULL, merchant_id TEXT NOT NULL, quote_id TEXT NOT NULL, identity_json TEXT NOT NULL,
  quantity INTEGER NOT NULL, currency TEXT NOT NULL, cost_json TEXT NOT NULL, total_minor INTEGER NOT NULL,
  client_max_minor INTEGER NOT NULL, summary_json TEXT NOT NULL, summary_hash TEXT NOT NULL,
  state TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0,
  mandate_id TEXT REFERENCES mandates(id), reserved_minor INTEGER NOT NULL DEFAULT 0,
  provider TEXT NOT NULL, provider_order_id TEXT UNIQUE, approval_url TEXT,
  capture_id TEXT UNIQUE, capture_status TEXT, create_key TEXT NOT NULL UNIQUE, capture_key TEXT NOT NULL UNIQUE,
  failure_code TEXT, failure_reason TEXT,
  expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS checkout_by_purchase ON checkout_sessions(purchase_session_id, offer_id);
CREATE TABLE IF NOT EXISTS audit_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, subject_id TEXT NOT NULL, user_id TEXT NOT NULL,
  type TEXT NOT NULL, data_json TEXT NOT NULL, at INTEGER NOT NULL, prev_hash TEXT NOT NULL, hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_by_subject ON audit_events(subject_id, seq);
`;

/** Durable store. `transaction` uses BEGIN IMMEDIATE, so concurrent writers serialize. */
export class Store {
  readonly db: DatabaseSync;
  constructor(path = ":memory:") {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /** Additive, idempotent column migrations (older local databases keep working). */
  private migrate(): void {
    const cols = new Set((this.db.prepare("PRAGMA table_info(checkout_sessions)").all() as Array<{ name: string }>).map((c) => c.name));
    const add: Array<[string, string]> = [
      ["merchant_identity_json", "TEXT"], ["intended_payee_id", "TEXT"], ["payee_relationship", "TEXT"],
      ["attestation_id", "TEXT"], ["attestation_expires_at", "INTEGER"], ["actual_recipient_id", "TEXT"],
      ["provider_verified_at", "INTEGER"], ["provider_pending_reason", "TEXT"],
      // Expiry hardening: set once, durably, BEFORE the first capture request reaches the provider.
      ["capture_requested_at", "INTEGER"],
    ];
    for (const [name, type] of add) if (!cols.has(name)) this.db.exec(`ALTER TABLE checkout_sessions ADD COLUMN ${name} ${type}`);
    // DF-4: a mandate created on the owner page is bound to exactly one checkout. At most one live
    // (non-revoked) bound mandate per checkout, enforced by the database across processes.
    const mcols = new Set((this.db.prepare("PRAGMA table_info(mandates)").all() as Array<{ name: string }>).map((c) => c.name));
    if (!mcols.has("bound_checkout_session_id")) this.db.exec("ALTER TABLE mandates ADD COLUMN bound_checkout_session_id TEXT");
    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS mandates_one_live_per_bound_checkout ON mandates(bound_checkout_session_id)
      WHERE bound_checkout_session_id IS NOT NULL AND status <> 'REVOKED'`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS checkout_by_capture ON checkout_sessions(capture_id);
      CREATE TABLE IF NOT EXISTS webhook_events (
        event_id TEXT PRIMARY KEY, event_type TEXT NOT NULL, capture_id TEXT, checkout_session_id TEXT,
        received_at INTEGER NOT NULL, outcome TEXT NOT NULL
      );`);
  }

  private depth = 0;
  /** Synchronous only: no await inside, so no other request can interleave. Re-entrant. */
  transaction<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this.depth++;
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    } finally {
      this.depth--;
    }
  }

  close(): void { this.db.close(); }
}

export type Row = Record<string, string | number | null>;
