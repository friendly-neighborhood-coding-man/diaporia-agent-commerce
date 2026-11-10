/**
 * Read-only KERNEL account check used before and after C1/C2: prints ONLY the number of running browsers.
 * It makes one GET to the official KERNEL API with the owner's local KERNEL_API_KEY and needs an explicit flag.
 * It never prints ids, live-view URLs or the key.
 *
 *   KERNEL_API_KEY=… npm run phase-c:kernel-check -- --read-only-kernel-call
 */
if (!process.argv.includes("--read-only-kernel-call")) { console.error("Refusing: pass --read-only-kernel-call to make one read-only KERNEL API request"); process.exit(2); }
const key = process.env.KERNEL_API_KEY;
if (!key) { console.error("KERNEL_API_KEY is not set (load it from the private environment, never from git)"); process.exit(2); }
const r = await fetch("https://api.onkernel.com/browsers", { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) }).catch(() => null);
if (!r || !r.ok) { console.log(JSON.stringify({ result: "KERNEL_CHECK_FAILED", http: r?.status ?? null })); process.exit(3); }
const body: any = await r.json().catch(() => null);
const list = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : null;
if (!list) { console.log(JSON.stringify({ result: "KERNEL_CHECK_UNPARSEABLE" })); process.exit(3); }
const running = list.filter((b: any) => !b?.deleted_at).length;
console.log(JSON.stringify({ result: running === 0 ? "NO_KERNEL_BROWSER_RUNNING" : "KERNEL_BROWSERS_RUNNING", running }));
process.exit(running === 0 ? 0 : 4);
