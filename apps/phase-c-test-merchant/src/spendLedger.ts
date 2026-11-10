import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

/**
 * Durable, cross-process spending controls for one Sandbox approval run.
 *
 * Every limit is an exclusive-create file (O_CREAT|O_EXCL, fsync'd). Two processes on the same filesystem cannot both
 * create slot N, and a restart cannot forget a slot, because slots are never deleted or decremented. An attempt whose
 * outcome is unknown still consumes its slot.
 *
 * Layout of MERCHANT_DATA_DIR (bound into the approval digest):
 *   approval.json            digest this data dir belongs to (written once; another digest is refused)
 *   instance.lease           the single running instance (removed on clean stop; a stale one needs the operator)
 *   run-<digest>/order-slot-0, capture-slot-0, capture-retry-slot-0
 *
 * Limits: this protects one filesystem. Two hosts that each mount a different disk at the same path are NOT detected
 * here (the docs require one host); PayPal-Request-Id bound to the approval is a second, provider-side backstop.
 */

export type SlotKind = "order" | "capture" | "capture-retry";

export class LedgerRefusedError extends Error {
  constructor(readonly code: "INSTANCE_LEASE_HELD" | "DATA_DIR_BOUND_TO_OTHER_APPROVAL" | "LEDGER_UNREADABLE", message: string) { super(message); }
}

/** true = created; false = already existed. Any other error propagates (fail closed). */
export function createExclusive(file: string, content: string): boolean {
  let fd: number;
  try { fd = openSync(file, "wx", 0o600); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST") return false; throw e; }
  try { writeSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
  return true;
}

export class SpendLedger {
  private readonly runDir: string;
  private readonly leaseFile: string;
  private readonly leaseToken = randomBytes(12).toString("hex");
  private released = false;

  private constructor(readonly dataDir: string, readonly runId: string) {
    this.runDir = join(dataDir, `run-${runId}`);
    this.leaseFile = join(dataDir, "instance.lease");
  }

  /**
   * Binds the data dir to this approval and takes the single-instance lease. Refuses if another process holds the
   * lease (live or crashed: a stale lease is never taken over automatically, the operator removes it after checking).
   */
  static open(dataDir: string, runId: string): SpendLedger {
    if (!/^[a-f0-9]{64}$/.test(runId)) throw new Error("run id must be the approval digest");
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const l = new SpendLedger(dataDir, runId);
    const bindFile = join(dataDir, "approval.json");
    if (!createExclusive(bindFile, JSON.stringify({ v: 1, approvalDigest: runId, boundAt: new Date().toISOString() }))) {
      let bound: unknown;
      try { bound = JSON.parse(readFileSync(bindFile, "utf8"))?.approvalDigest; }
      catch { throw new LedgerRefusedError("LEDGER_UNREADABLE", "approval.json in MERCHANT_DATA_DIR is unreadable"); }
      if (bound !== runId) throw new LedgerRefusedError("DATA_DIR_BOUND_TO_OTHER_APPROVAL", "this MERCHANT_DATA_DIR belongs to another approval; use a new, empty data dir");
    }
    const lease = JSON.stringify({ v: 1, token: l.leaseToken, runId, pid: process.pid, host: hostname(), startedAt: new Date().toISOString() });
    if (!createExclusive(l.leaseFile, lease)) {
      let holder = "unreadable";
      try { const h = JSON.parse(readFileSync(l.leaseFile, "utf8")); holder = `pid ${h.pid} on ${h.host} since ${h.startedAt}`; } catch { /* keep "unreadable" */ }
      throw new LedgerRefusedError("INSTANCE_LEASE_HELD", `another merchant instance holds ${l.leaseFile} (${holder}). If you verified that process is gone, delete the file yourself.`);
    }
    mkdirSync(l.runDir, { recursive: true, mode: 0o700 });
    return l;
  }

  /** Reserves the first free slot below max. null = cap reached. The slot is consumed even if the call that follows fails. */
  reserve(kind: SlotKind, max: number, note: Record<string, string>): number | null {
    this.assertHeld();
    for (let i = 0; i < max; i++)
      if (createExclusive(join(this.runDir, `${kind}-slot-${i}`), JSON.stringify({ ...note, kind, slot: i, pid: process.pid, at: new Date().toISOString() }))) return i;
    return null;
  }

  used(kind: SlotKind): number {
    return readdirSync(this.runDir).filter((n) => n.startsWith(`${kind}-slot-`)).length;
  }

  /** Releases the lease only if it is still ours. Slots and the approval binding stay forever. */
  release(): void {
    if (this.released) return;
    this.released = true;
    try { if (JSON.parse(readFileSync(this.leaseFile, "utf8")).token === this.leaseToken) unlinkSync(this.leaseFile); } catch { /* already gone */ }
  }

  private assertHeld() {
    if (this.released) throw new LedgerRefusedError("INSTANCE_LEASE_HELD", "lease released");
    let token: unknown;
    try { token = JSON.parse(readFileSync(this.leaseFile, "utf8")).token; } catch { token = null; }
    if (token !== this.leaseToken) throw new LedgerRefusedError("INSTANCE_LEASE_HELD", "this process no longer holds the instance lease; refusing to spend");
  }
}
