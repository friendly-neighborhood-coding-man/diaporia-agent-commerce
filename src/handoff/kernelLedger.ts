import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Durable per-approval KERNEL browser-CREATION ledger.
 *
 * `KernelDriver.maxSessions` is per process and resets on restart. This ledger is not: before every POST /browsers the
 * driver must create `attempt-<n>` (O_CREAT|O_EXCL, fsync'd) in `<dir>/<runId>/`. Slots are never deleted, so a restart,
 * a crash or a second DIAPORIA process on the same host cannot create more than `maxBrowsers` browsers for one approval.
 * A failed or unanswered create still consumes its slot.
 *
 * What it is NOT: a monetary circuit breaker. It caps creations, not provider billing; the KERNEL watchdog caps wall
 * time; anything else (provider pricing, a second host with its own home dir) needs the owner's account-side limit and
 * supervision of the run.
 */
export const DEFAULT_KERNEL_LEDGER_DIR = resolve(homedir(), ".diaporia", "kernel-browser-ledger");

export class KernelLedgerExhausted extends Error {
  constructor(readonly runId: string, readonly maxBrowsers: number) {
    super(`KERNEL browser creations for approval ${runId.slice(0, 12)}… are used up (${maxBrowsers}); a new approval is required`);
  }
}

export class KernelCreationLedger {
  readonly runDir: string;
  constructor(readonly o: { runId: string; maxBrowsers: number; dir?: string }) {
    if (!/^[a-f0-9]{64}$/.test(o.runId)) throw new Error("KERNEL ledger run id must be the owner-approved SHA-256 digest");
    if (!Number.isInteger(o.maxBrowsers) || o.maxBrowsers < 1 || o.maxBrowsers > 3) throw new Error("KERNEL ledger maxBrowsers must be 1..3");
    this.runDir = join(o.dir ?? DEFAULT_KERNEL_LEDGER_DIR, o.runId);
    mkdirSync(this.runDir, { recursive: true, mode: 0o700 });
  }

  used(): number { return readdirSync(this.runDir).filter((n) => /^attempt-\d+$/.test(n)).length; }

  /** Consumes one creation slot or throws KernelLedgerExhausted. Call BEFORE the provider request. */
  reserve(label: string): number {
    for (let i = 0; i < this.o.maxBrowsers; i++) {
      let fd: number;
      try { fd = openSync(join(this.runDir, `attempt-${i}`), "wx", 0o600); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST") continue; throw e; }
      try { writeSync(fd, JSON.stringify({ slot: i, label: label.slice(0, 64), pid: process.pid, at: new Date().toISOString() })); fsyncSync(fd); }
      finally { closeSync(fd); }
      return i;
    }
    throw new KernelLedgerExhausted(this.o.runId, this.o.maxBrowsers);
  }
}
