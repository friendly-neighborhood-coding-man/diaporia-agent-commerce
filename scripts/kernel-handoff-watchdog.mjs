/**
 * Independent wall-clock cleanup for a DIAPORIA-owned KERNEL handoff browser.
 * Launched detached by KernelDriver. This process does not depend on the MCP server staying alive.
 * Never print the API key, bearer live-view URL, or browser contents.
 *
 * IMPORTANT: not a monetary cap. If the machine is powered off, cleanup resumes only after the
 * next service start / a separate operator cleanup, and provider standby timeout remains a fallback.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const env = process.env;
const id = env.DIAPORIA_KERNEL_WATCHDOG_SESSION ?? "";
const key = env.DIAPORIA_KERNEL_WATCHDOG_KEY ?? "";
const deadline = Number(env.DIAPORIA_KERNEL_WATCHDOG_DEADLINE);
const reportDir = env.DIAPORIA_KERNEL_WATCHDOG_DIR ?? "";
const endpoint = "https://api.onkernel.com";
if (!/^[A-Za-z0-9_-]{3,128}$/.test(id) || key.length < 10 ||
    !Number.isSafeInteger(deadline) || !reportDir || deadline < Date.now() - 60_000) process.exit(2);

mkdirSync(reportDir, { recursive: true, mode: 0o700 });
const file = join(reportDir, `handoff-${id}.json`);
const record = (status, attempts = 0) => {
  writeFileSync(file, JSON.stringify({ sessionId: id, deadline, status, attempts, checkedAt: Date.now() }), { mode: 0o600 });
};
record("PENDING");

/** Listing is paginated. Never assume absence from the first page means deletion. */
async function isGone() {
  for (let offset = 0; offset <= 1000; offset += 100) {
    const res = await fetch(`${endpoint}/browsers?limit=100&offset=${offset}`, {
      headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error("LIST_FAILED");
    const json = await res.json();
    const rows = Array.isArray(json) ? json : Array.isArray(json?.data) ? json.data : null;
    if (!rows) throw new Error("LIST_MALFORMED");
    if (rows.some(b => b?.session_id === id && !b?.deleted_at)) return false;
    if (rows.length < 100) return true;
  }
  throw new Error("LIST_INCOMPLETE");
}

async function destroy() {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(`${endpoint}/browsers/${encodeURIComponent(id)}`, {
        method: "DELETE", headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10000),
      });
      if (!res.ok && res.status !== 404) throw new Error("DELETE_FAILED");
      if (await isGone()) { record("VERIFIED_DELETED", attempt); return; }
    } catch { /* Retry without leaking remote error or secret-bearing URLs. */ }
    record("DELETE_RETRY", attempt);
    await new Promise(resolve => setTimeout(resolve, 1500 * attempt));
  }
  record("DELETE_UNCONFIRMED", 4);
  process.exitCode = 1;
}
const delay = Math.max(0, deadline - Date.now());
setTimeout(() => { void destroy(); }, delay);
