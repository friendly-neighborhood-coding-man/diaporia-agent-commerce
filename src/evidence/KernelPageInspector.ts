import { lookup } from "node:dns/promises";
import type { PageInspectionProvider, PageInspectionResult } from "./EvidenceRouter.js";
import { CAPABILITY_KEYWORDS, CAPABILITY_NEGATED, modelPattern } from "./capabilityText.js";

/**
 * BYOK KERNEL original-page inspection (https://www.kernel.sh, REST API at api.onkernel.com).
 *
 * One inspect() = one remote browser session: create → run one bounded Playwright snippet that loads the
 * page and returns its visible text → delete. No SDK dependency: three plain HTTPS requests.
 *
 * Safety and honesty rules:
 *  - Only public https URLs whose host resolves to public addresses. The remote browser may navigate only
 *    within the same host; images, media and fonts are blocked. No stealth, no CAPTCHA solving, no sign-in.
 *  - Page text is untrusted data. It is never executed or followed; statements are extracted locally and
 *    deterministically (keyword + negation rules shared with the Evidence Router).
 *  - A page yields statements only if its title/heading names the exact model. An empty, blocked, redirected
 *    or off-model page yields ZERO statements, so missing evidence can never become verified.
 *  - Hard per-process session cap, total deadline, and the browser session is always deleted (best effort).
 *  - browserSeconds is measured from session creation to deletion and reported to the Usage Ledger
 *    (unit browser_second). The supplier price is not assumed here.
 *  - The API key is held privately and never returned, logged or sent anywhere except api.onkernel.com.
 */
export interface KernelOptions {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  /** Deadline for the whole inspection (create + execute + read). Default 45 s. */
  totalTimeoutMs?: number;
  /** Navigation timeout inside the remote browser. Default 15 s. */
  navigationTimeoutMs?: number;
  /** Hard cap on browser sessions this adapter instance may create. Default 20. */
  maxSessions?: number;
  /** DNS resolver (injectable for tests). Must return every address for the host. */
  resolve?: (host: string) => Promise<Array<{ address: string; family: number }>>;
  now?: () => number;
}

export class KernelBudgetError extends Error { constructor() { super("KERNEL session cap reached for this process"); } }

const MAX_TEXT = 110_000;
const MAX_STATEMENTS = 3;
const CHALLENGE = /\b(captcha|verify you are (a )?human|are you a robot|access denied|attention required|enable javascript and cookies|request blocked|just a moment)\b/i;

export function publicAddress(address: string, family: number): boolean {
  if (family === 4) {
    const v = address.split(".").map(Number);
    if (v.length !== 4 || v.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
    const [a, b, c] = v as [number, number, number, number];
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) || (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  return family === 6 && /^[23][0-9a-f]{3}:/i.test(address) && !/^2001:0?db8:/i.test(address);
}
const bareHost = (h: string) => h.toLowerCase().replace(/^www\./, "");

/** Validates a candidate URL before any paid call. Returns the reason it is refused, or null. */
export function refuseUrl(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return "URL_INVALID"; }
  if (u.protocol !== "https:") return "URL_NOT_HTTPS";
  if (u.username || u.password) return "URL_HAS_CREDENTIALS";
  if (u.port && u.port !== "443") return "URL_NON_STANDARD_PORT";
  const h = u.hostname;
  if (/^\[|^\d+\.\d+\.\d+\.\d+$/.test(h)) return "URL_IP_LITERAL";
  if (!h.includes(".") || /(^|\.)(localhost|local|internal|lan|home|corp|test|example|invalid)$/i.test(h)) return "URL_NOT_PUBLIC_HOST";
  return null;
}

/** Remote snippet. `target`/`nav` are injected as JSON literals; nothing else from untrusted input enters the code. */
function remoteCode(target: string, navMs: number): string {
  return `const target = ${JSON.stringify(target)};
const allowed = new URL(target).hostname.toLowerCase().replace(/^www\\./, "");
await page.route("**/*", (route) => {
  const req = route.request(); let u;
  try { u = new URL(req.url()); } catch { return route.abort(); }
  if (u.protocol !== "https:") return route.abort();
  if (["image", "media", "font"].includes(req.resourceType())) return route.abort();
  let mainNav = false; try { mainNav = req.isNavigationRequest() && req.frame() === page.mainFrame(); } catch { mainNav = req.isNavigationRequest(); }
  if (mainNav && u.hostname.toLowerCase().replace(/^www\\./, "") !== allowed) return route.abort();
  return route.continue();
});
let status = null;
try { const resp = await page.goto(target, { waitUntil: "domcontentloaded", timeout: ${Math.floor(navMs)} }); status = resp ? resp.status() : null; }
catch (e) { return { navigationError: String(e && e.message || e).slice(0, 200), finalUrl: page.url(), status }; }
const read = () => page.evaluate(() => {
  const pick = (sel) => { const el = document.querySelector(sel); return el ? el.innerText || "" : ""; };
  const regions = [["article", pick("article")], ["main", pick("main")], ["body", document.body ? document.body.innerText || "" : ""]];
  const chosen = regions.find((r) => r[1].trim().length >= 600) || regions.find((r) => r[1].trim().length > 0) || ["none", ""];
  return { title: document.title || "", heading: (document.querySelector("h1") && document.querySelector("h1").textContent || "").trim(), region: chosen[0], text: chosen[1].slice(0, ${MAX_TEXT}) };
});
let c = await read();
if (c.text.trim().length < 500) { await page.waitForTimeout(800); c = await read(); }
return { finalUrl: page.url(), status, ...c };`;
}

interface RemotePage { finalUrl?: unknown; status?: unknown; title?: unknown; heading?: unknown; region?: unknown; text?: unknown; navigationError?: unknown }

/** Pure, deterministic extraction of explicit statements from one page snapshot. Exported for tests. */
export function extractStatements(requestedUrl: string, page: RemotePage, capability: string, modelToken: string): PageInspectionResult {
  const s = (v: unknown, max: number) => (typeof v === "string" ? v : "").slice(0, max);
  const none = (outcome: string) => ({ statements: [], browserSeconds: 0, outcome });
  if (page.navigationError) return none("NAVIGATION_FAILED");
  let finalHost = "";
  try { const f = new URL(s(page.finalUrl, 2000)); if (f.protocol !== "https:") return none("REDIRECT_REJECTED"); finalHost = bareHost(f.hostname); } catch { return none("REDIRECT_REJECTED"); }
  if (finalHost !== bareHost(new URL(requestedUrl).hostname)) return none("REDIRECT_REJECTED");
  if (typeof page.status === "number" && page.status >= 400) return none(`HTTP_${page.status}`);
  const title = s(page.title, 300), heading = s(page.heading, 300), text = s(page.text, MAX_TEXT);
  if (CHALLENGE.test(`${title} ${heading} ${text.slice(0, 2000)}`) && text.length < 4000) return none("ACCESS_CHALLENGE_NOT_BYPASSED");
  if (text.trim().length < 120) return none("EMPTY_DOCUMENT");
  if (!modelPattern(modelToken).test(`${title} ${heading}`)) return none("MODEL_NOT_IN_PAGE_HEADING");
  const kw = CAPABILITY_KEYWORDS[capability];
  if (!kw) return none("CAPABILITY_HAS_NO_DETERMINISTIC_RULE");
  const statements: Array<{ value: boolean; quote: string }> = [];
  for (const sentence of text.replace(/\s+/g, " ").split(/(?<=[.!?])\s+/)) {
    if (sentence.length < 20 || sentence.length > 400 || !kw.test(sentence)) continue;
    statements.push({ value: !(CAPABILITY_NEGATED[capability]?.test(sentence) ?? false), quote: sentence.trim() });
    if (statements.length >= MAX_STATEMENTS) break;
  }
  return { statements, browserSeconds: 0, outcome: statements.length ? "EXPLICIT_STATEMENTS_FOUND" : "NO_EXPLICIT_STATEMENT" };
}

export class KernelPageInspector implements PageInspectionProvider {
  readonly name = "kernel";
  readonly provenance: "BYOK_LIVE" | "MANAGED_LIVE";
  #key: string;
  #sessions = 0;
  private readonly o: Required<Omit<KernelOptions, "resolve" | "now">> & Pick<KernelOptions, "resolve" | "now">;
  constructor(apiKey: string, mode: "community" | "managed", opts: KernelOptions = {}) {
    if (!apiKey || apiKey.length < 10) throw new Error("KERNEL API key missing");
    this.#key = apiKey;
    this.provenance = mode === "managed" ? "MANAGED_LIVE" : "BYOK_LIVE";
    this.o = { fetchImpl: opts.fetchImpl ?? fetch, baseUrl: (opts.baseUrl ?? "https://api.onkernel.com").replace(/\/$/, ""),
      totalTimeoutMs: opts.totalTimeoutMs ?? 45_000, navigationTimeoutMs: opts.navigationTimeoutMs ?? 15_000, maxSessions: opts.maxSessions ?? 20,
      resolve: opts.resolve, now: opts.now };
  }
  get sessionsCreated() { return this.#sessions; }

  private async api(method: string, path: string, body: unknown, signal: AbortSignal): Promise<any> {
    const r = await this.o.fetchImpl(`${this.o.baseUrl}${path}`, {
      method, signal, headers: { Authorization: `Bearer ${this.#key}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!r.ok) throw new Error(`KERNEL HTTP ${r.status} on ${method} ${path.replace(/\/browsers\/[^/]+/, "/browsers/:id")}`);
    return r.status === 204 ? null : r.json().catch(() => null);
  }

  /** Free pre-check run by the Evidence Router before metering: URL syntax policy, then public DNS. */
  async refuse(url: string): Promise<string | null> {
    const refused = refuseUrl(url);
    if (refused) return refused;
    const resolve = this.o.resolve ?? ((h: string) => lookup(h, { all: true, verbatim: true }));
    const addrs = await resolve(new URL(url).hostname).catch(() => []);
    return addrs.length && addrs.every((a) => publicAddress(a.address, a.family)) ? null : "DNS_NOT_PUBLIC";
  }

  async inspect(url: string, capability: string, modelToken: string): Promise<PageInspectionResult> {
    // Re-checked here too, so a direct caller can never bypass the policy.
    const refused = await this.refuse(url);
    if (refused) return { statements: [], browserSeconds: 0, outcome: refused };
    if (this.#sessions >= this.o.maxSessions) throw new KernelBudgetError();

    const now = this.o.now ?? Date.now;
    const deadline = AbortSignal.timeout(this.o.totalTimeoutMs);
    const execSec = Math.max(5, Math.floor((this.o.totalTimeoutMs - 5_000) / 1000));
    this.#sessions++;
    const started = now();
    let id: string | null = null;
    try {
      const created = await this.api("POST", "/browsers", { headless: true, stealth: false, timeout_seconds: Math.max(30, execSec + 15) }, deadline);
      id = typeof created?.session_id === "string" ? created.session_id : null;
      if (!id) throw new Error("KERNEL returned no session id");
      const out = await this.api("POST", `/browsers/${encodeURIComponent(id)}/playwright/execute`,
        { code: remoteCode(url, Math.min(this.o.navigationTimeoutMs, execSec * 1000 - 2_000)), timeout_sec: execSec }, deadline);
      if (!out || out.success !== true) throw new Error(`KERNEL execution failed: ${String(out?.error ?? "no result").slice(0, 100)}`);
      const res = extractStatements(url, (out.result ?? {}) as RemotePage, capability, modelToken);
      return { ...res, browserSeconds: Math.max(1, Math.ceil((now() - started) / 1000)) };
    } catch (e) {
      if (deadline.aborted) throw new Error(`KERNEL inspection timed out after ${this.o.totalTimeoutMs} ms`);
      throw e;
    } finally {
      if (id) await this.api("DELETE", `/browsers/${encodeURIComponent(id)}`, undefined, AbortSignal.timeout(10_000)).catch(() => undefined);
    }
  }
  toJSON() { return { name: this.name, provenance: this.provenance, key: "[REDACTED]" }; }
}
