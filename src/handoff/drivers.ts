/**
 * Browser drivers for the checkout handoff. A driver owns ONE isolated browser per handoff and exposes only:
 *   - run(code): execute a DIAPORIA-built Playwright snippet (prepare / observe) — refused while paused
 *   - pause()/resume-for-observation: automation is hard-disabled during human takeover
 *   - humanView(): the human's way into the same browser session (a secret; only the authenticated handoff page sees it)
 *   - close(): destroy the browser (and with it every cookie, popup and the live-view capability)
 *
 * Nothing here returns cookies, CDP/WebDriver endpoints, or the live-view URL to callers other than the handoff page.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { KernelCreationLedger } from "./kernelLedger.js";

export type DriverPhase = "AUTOMATION" | "HUMAN_TAKEOVER" | "OBSERVATION" | "CLOSED";

export interface HumanView {
  kind: "KERNEL_LIVE_VIEW" | "LOCAL_FIXTURE_WINDOW";
  /** Secret capability URL (KERNEL live view). Never logged, audited, or returned through MCP. */
  secretUrl: string | null;
  /** CSP frame-src origins required to embed `secretUrl`. */
  frameOrigins: string[];
}

export interface BrowserSession {
  readonly provider: "LOCAL_FIXTURE" | "KERNEL";
  readonly phase: DriverPhase;
  run<T>(code: string, opts?: { timeoutSec?: number }): Promise<T>;
  /** Stop all automation. After this, run() throws until beginObservation(). */
  pauseForHuman(): void;
  /** Allow READ-ONLY observation snippets after the human has finished. */
  beginObservation(): void;
  humanView(): HumanView;
  close(): Promise<void>;
}

export interface BrowserDriver {
  readonly name: "LOCAL_FIXTURE" | "KERNEL";
  /** Liveness of the provider: live drivers can cost money and need explicit enablement. */
  readonly live: boolean;
  open(opts: { label: string; merchantHost: string; allowedHosts: string[] | null; timeoutSeconds: number }): Promise<BrowserSession>;
}

export class AutomationPausedError extends Error {
  constructor(phase: DriverPhase) { super(`Browser automation is disabled in phase ${phase}`); }
}

abstract class PhasedSession {
  #phase: DriverPhase = "AUTOMATION";
  get phase() { return this.#phase; }
  protected assertRunnable(): void {
    if (this.#phase !== "AUTOMATION" && this.#phase !== "OBSERVATION") throw new AutomationPausedError(this.#phase);
  }
  pauseForHuman(): void { if (this.#phase !== "CLOSED") this.#phase = "HUMAN_TAKEOVER"; }
  beginObservation(): void { if (this.#phase === "HUMAN_TAKEOVER") this.#phase = "OBSERVATION"; }
  protected markClosed(): void { this.#phase = "CLOSED"; }
}

// ---------------------------------------------------------------- Local fixture driver (Phase A, offline)

type PwBrowser = import("playwright-core").Browser;
type PwContext = import("playwright-core").BrowserContext;
type PwPage = import("playwright-core").Page;

const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (...args: string[]) => (...a: unknown[]) => Promise<unknown>;

/**
 * Runs the SAME snippets as KERNEL against a local Chromium (playwright-core, no browser download).
 * Each handoff gets its own BrowserContext (separate cookies/storage), so handoffs are isolated.
 * Offline only: the snippets themselves block navigation off the merchant host during automation.
 */
export class LocalFixtureDriver implements BrowserDriver {
  readonly name = "LOCAL_FIXTURE" as const;
  readonly live = false;
  private browser: Promise<PwBrowser> | null = null;
  constructor(private readonly launch: () => Promise<PwBrowser>) {}

  async open(): Promise<LocalFixtureSession> {
    this.browser ??= this.launch();
    const context = await (await this.browser).newContext();
    const page = await context.newPage();
    return new LocalFixtureSession(context, page);
  }
  async shutdown(): Promise<void> { if (this.browser) await (await this.browser).close().catch(() => undefined); this.browser = null; }
}

export class LocalFixtureSession extends PhasedSession implements BrowserSession {
  readonly provider = "LOCAL_FIXTURE" as const;
  constructor(private readonly context: PwContext, private readonly page: PwPage) { super(); }
  async run<T>(code: string, opts: { timeoutSec?: number } = {}): Promise<T> {
    this.assertRunnable();
    const fn = new AsyncFunction("page", "context", code);
    const timeout = (opts.timeoutSec ?? 30) * 1000;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([fn(this.page, this.context) as Promise<T>,
        new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`execution timed out after ${timeout} ms`)), timeout); })]);
    } finally { clearTimeout(timer); }
  }
  humanView(): HumanView { return { kind: "LOCAL_FIXTURE_WINDOW", secretUrl: null, frameOrigins: [] }; }
  /**
   * TEST/DEMO ONLY: the page a simulated human operates during takeover. Throws outside HUMAN_TAKEOVER,
   * so automation code cannot use it to bypass the pause.
   */
  humanPage(): { page: PwPage; context: PwContext } {
    if (this.phase !== "HUMAN_TAKEOVER") throw new AutomationPausedError(this.phase);
    return { page: this.page, context: this.context };
  }
  async close(): Promise<void> { this.markClosed(); await this.context.close().catch(() => undefined); }
}

/** Finds a local Chromium for the fixture driver: explicit path, playwright's cache, then installed Chrome / Edge. */
export async function launchLocalChromium(opts: { headless?: boolean } = {}): Promise<PwBrowser> {
  const { chromium } = await import("playwright-core");
  const { existsSync } = await import("node:fs");
  const headless = opts.headless ?? true;
  const explicit = process.env.DIAPORIA_FIXTURE_CHROMIUM;
  if (explicit) return chromium.launch({ executablePath: explicit, headless });
  const bundled = chromium.executablePath();
  if (bundled && existsSync(bundled)) return chromium.launch({ headless });
  for (const p of ["/opt/pw-browsers/chromium"]) if (existsSync(p)) return chromium.launch({ executablePath: p, headless });
  let last: unknown;
  for (const channel of ["chrome", "msedge", "chromium"]) {
    try { return await chromium.launch({ channel, headless }); } catch (e) { last = e; }
  }
  throw new Error(`No local Chromium found for the fixture driver (set DIAPORIA_FIXTURE_CHROMIUM). Last error: ${last instanceof Error ? last.message.split("\n")[0] : "unknown"}`);
}

// ---------------------------------------------------------------- KERNEL driver (Phase B, live, BYOK)

export interface KernelDriverOptions {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  /** Hard cap on browsers this process may create. Default 3. Resets on restart: see creationLedger. */
  maxSessions?: number;
  /** Durable per-approval creation cap that survives restarts and is shared by processes on this host. */
  creationLedger?: KernelCreationLedger;
  /** Live backend refuses unrestricted browser sessions. Fake HTTP may opt in for testing. */
  enforceEgressAllowlist?: boolean;
  /** Must be true to construct: KERNEL browsers are billed. Tests use a fake fetch. */
  allowLive: boolean;
  /** Absolute wall-clock bound, independent of the provider idle timeout. Maximum 10 minutes. */
  maxWallMs?: number;
  /** Inject an isolated journal for offline crash/restart tests; otherwise fake HTTP writes no journal. */
  journalDir?: string;
  /** Offline tests can replace the detached process with a spy. */
  watchdog?: (sessionId: string, hardWallMs: number) => Promise<void>;
}

export class KernelBudgetExceeded extends Error { constructor() { super("KERNEL browser cap reached for this process"); } }

/**
 * Fetch-only KERNEL REST client (same approach as the BYOK KernelPageInspector on feature/byok-completion-v1;
 * consolidate the two once both land). Creates a HEADFUL browser so a human can use Live View.
 *
 * Privacy: telemetry is disabled at creation, replays are never started, and cdp_ws_url / webdriver_ws_url /
 * base_url from the create response are discarded immediately. The live-view URL is held in a private field.
 */
export class KernelDriver implements BrowserDriver {
  readonly name = "KERNEL" as const;
  readonly live = true;
  #key: string;
  #created = 0;
  readonly #ledger: KernelCreationLedger | null;
  private readonly o: Required<Omit<KernelDriverOptions, "allowLive" | "creationLedger">>;
  constructor(apiKey: string, opts: KernelDriverOptions) {
    if (!opts.allowLive) throw new Error("KernelDriver needs allowLive: true (billed browser sessions)");
    if (!apiKey || apiKey.length < 10) throw new Error("KERNEL API key missing");
    this.#key = apiKey;
    this.#ledger = opts.creationLedger ?? null;
    this.o = { fetchImpl: opts.fetchImpl ?? fetch, baseUrl: (opts.baseUrl ?? "https://api.onkernel.com").replace(/\/$/, ""), maxSessions: opts.maxSessions ?? 3,
      maxWallMs: Math.min(600_000, Math.max(1_000, Math.floor(opts.maxWallMs ?? 600_000))), watchdog: opts.watchdog ?? (async () => undefined),
      journalDir: opts.journalDir ?? (opts.fetchImpl ? "" : resolve(process.cwd(), ".data/kernel-watchdogs")),
      enforceEgressAllowlist: opts.enforceEgressAllowlist ?? !opts.fetchImpl };
    // Never send a real key to a configurable endpoint outside the official KERNEL API.
    if (!opts.fetchImpl && this.o.baseUrl !== "https://api.onkernel.com") throw new Error("Live KERNEL endpoint must be the official API host");
  }
  get sessionsCreated() { return this.#created; }

  private watchdogDir(): string { return this.o.journalDir; }
  private watchdogFile(id: string): string { return join(this.watchdogDir(), `handoff-${id}.json`); }

  /** Only session ids and lifecycle timestamps go on disk; never tokens or Live View URLs. */
  private markWatchdog(id: string, deadline: number, status: "PENDING" | "VERIFIED_DELETED") {
    if (!this.watchdogDir()) return;
    mkdirSync(this.watchdogDir(), { recursive: true, mode: 0o700 });
    writeFileSync(this.watchdogFile(id), JSON.stringify({
      sessionId: id, deadline, status, checkedAt: Date.now(),
    }), { mode: 0o600 });
  }

  /**
   * After a restart, a prior in-memory human session no longer has an owner and must be killed.
   * The detached watchdog handles ordinary process crashes; this handles machine restarts.
   * If provider cleanup cannot be VERIFIED, refuse to bring up live handoff.
   */
  async recoverOrphanedBrowsers(): Promise<number> {
    if (!this.watchdogDir() || !existsSync(this.watchdogDir())) return 0;
    let recovered = 0;
    for (const name of readdirSync(this.watchdogDir())) {
      if (!/^handoff-[A-Za-z0-9_-]{3,128}\.json$/.test(name)) continue;
      let rec: { sessionId: string; deadline: number; status: string };
      try { rec = JSON.parse(readFileSync(join(this.watchdogDir(), name), "utf8")); }
      catch { throw new Error("KERNEL orphan cleanup journal is unreadable"); }
      const id = rec.sessionId;
      if (name !== `handoff-${id}.json` || !Number.isSafeInteger(rec.deadline))
        throw new Error("KERNEL orphan cleanup journal is malformed");
      if (rec.status === "VERIFIED_DELETED") continue;
      try {
        await this.api("DELETE", `/browsers/${encodeURIComponent(id)}`, undefined, 10_000)
          .catch(async (e: Error) => { if (!/KERNEL HTTP 404/.test(e.message)) throw e; });
        await this.verifyDeleted(id);
        this.markWatchdog(id, rec.deadline, "VERIFIED_DELETED");
      } catch { throw new Error("KERNEL orphan browser cleanup unverified; live handoff refused"); }
      recovered++;
    }
    return recovered;
  }

  /** Mark a session deleted only after the provider confirms it is absent. */
  journalVerifiedDeletion(id: string): void {
    if (!this.watchdogDir() || !existsSync(this.watchdogFile(id))) return;
    let deadline: number;
    try { deadline = JSON.parse(readFileSync(this.watchdogFile(id), "utf8")).deadline; }
    catch { throw new Error("KERNEL watchdog journal corrupted"); }
    if (!Number.isSafeInteger(deadline)) throw new Error("KERNEL watchdog journal malformed");
    this.markWatchdog(id, deadline, "VERIFIED_DELETED");
  }

  /** Detached hard-wall-clock deletion, independent of the MCP server lifetime. */
  private async armWatchdog(id: string): Promise<void> {
    const until = Date.now() + this.o.maxWallMs;
    this.markWatchdog(id, until, "PENDING");
    if (this.o.fetchImpl !== fetch) { await this.o.watchdog(id, this.o.maxWallMs); return; } // fake HTTP, no paid backend
    const file = resolve(process.cwd(), "scripts/kernel-handoff-watchdog.mjs");
    if (!existsSync(file)) throw new Error("KERNEL watchdog missing; refusing live handoff");
    const child = spawn(process.execPath, [file], {
      detached: true, stdio: "ignore", windowsHide: true,
      env: { DIAPORIA_KERNEL_WATCHDOG_SESSION: id, DIAPORIA_KERNEL_WATCHDOG_KEY: this.#key,
        DIAPORIA_KERNEL_WATCHDOG_DEADLINE: String(until),
        DIAPORIA_KERNEL_WATCHDOG_DIR: this.watchdogDir() },
    });
    await new Promise<void>((done, fail) => {
      child.once("spawn", () => done());
      child.once("error", () => fail(new Error("KERNEL watchdog could not start")));
    });
    child.unref();
  }

  /** The provider's list is paginated. A successful DELETE without verification is not sufficient. */
  async verifyDeleted(id: string): Promise<void> {
    if (this.o.fetchImpl !== fetch && !this.watchdogDir()) return; // injectable fake w/o a journal
    for (let offset = 0; offset <= 1000; offset += 100) {
      const res = await this.api("GET", `/browsers?limit=100&offset=${offset}`, undefined, 10_000);
      const rows = Array.isArray(res) ? res : Array.isArray(res?.data) ? res.data : null;
      if (!rows) throw new Error("KERNEL delete cannot be verified (unexpected list response)");
      if (rows.some((b: any) => b?.session_id === id && !b?.deleted_at)) throw new Error("KERNEL browser still active after delete");
      if (rows.length < 100) return;
    }
    throw new Error("KERNEL delete cannot be verified (list incomplete)");
  }

  /** @internal */
  async api(method: string, path: string, body: unknown, timeoutMs: number): Promise<any> {
    const r = await this.o.fetchImpl(`${this.o.baseUrl}${path}`, {
      method, signal: AbortSignal.timeout(timeoutMs),
      headers: { Authorization: `Bearer ${this.#key}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!r.ok) throw new Error(`KERNEL HTTP ${r.status} on ${method} ${path.replace(/\/browsers\/[^/]+/, "/browsers/:id")}`);
    return r.status === 204 ? null : r.json().catch(() => null);
  }

  async open(opts: { label: string; merchantHost: string; allowedHosts: string[] | null; timeoutSeconds: number }): Promise<KernelSession> {
    // Fail BEFORE charging for a browser. An absent list means unrestricted egress.
    if (this.o.enforceEgressAllowlist &&
        (!Array.isArray(opts.allowedHosts) || opts.allowedHosts.length === 0 ||
         !opts.allowedHosts.includes(opts.merchantHost)))
      throw new Error("Live KERNEL handoff requires a reviewed merchant/network egress allowlist");
    if (this.#created >= this.o.maxSessions) throw new KernelBudgetExceeded();
    // Durable slot BEFORE the billed request; an unanswered create still consumes it (throws KernelLedgerExhausted).
    this.#ledger?.reserve(opts.label);
    this.#created++;
    const created = await this.api("POST", "/browsers", {
      headless: false, stealth: false, kiosk_mode: false,
      timeout_seconds: Math.max(60, Math.min(3600, Math.floor(opts.timeoutSeconds))),
      name: opts.label.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 64),
      telemetry: { enabled: false },
      ...(opts.allowedHosts ? { network: { allowed_hosts: opts.allowedHosts } } : {}),
    }, 60_000);
    const id = typeof created?.session_id === "string" ? created.session_id : null;
    const live = typeof created?.browser_live_view_url === "string" ? created.browser_live_view_url : null;
    if (!id) throw new Error("KERNEL returned no session id");
    if (!live) {
      try { await this.api("DELETE", `/browsers/${encodeURIComponent(id)}`, undefined, 10_000); await this.verifyDeleted(id); }
      catch { throw new Error("KERNEL missing Live View; emergency DELETE not verified"); }
      throw new Error("KERNEL returned no live view URL (headful browser required)");
    }
    try { await this.armWatchdog(id); }
    catch {
      try { await this.api("DELETE", `/browsers/${encodeURIComponent(id)}`, undefined, 10_000); await this.verifyDeleted(id); }
      catch { throw new Error("KERNEL watchdog failed AND emergency session deletion is unconfirmed"); }
      throw new Error("KERNEL watchdog failed; session safely deleted; live handoff refused");
    }
    return new KernelSession(this, id, live, this.o.maxWallMs);
  }
}

export class KernelSession extends PhasedSession implements BrowserSession {
  readonly provider = "KERNEL" as const;
  #id: string;
  #live: string;
  #timer: NodeJS.Timeout;
  #closing: Promise<void> | null = null;
  constructor(private readonly driver: KernelDriver, id: string, live: string, hardWallMs = 600_000) {
    super(); this.#id = id; this.#live = live;
    // In-process first line; detached watchdog is the crash-resilient second line.
    this.#timer = setTimeout(() => { void this.close().catch(() => undefined); }, hardWallMs);
    this.#timer.unref();
  }
  async run<T>(code: string, opts: { timeoutSec?: number } = {}): Promise<T> {
    this.assertRunnable();
    const sec = Math.max(5, Math.min(120, opts.timeoutSec ?? 45));
    const out = await this.driver.api("POST", `/browsers/${encodeURIComponent(this.#id)}/playwright/execute`, { code, timeout_sec: sec }, (sec + 15) * 1000);
    if (!out || out.success !== true) throw new Error(`KERNEL execution failed: ${String(out?.error ?? "no result").slice(0, 120)}`);
    return out.result as T;
  }
  humanView(): HumanView {
    if (this.phase === "CLOSED") throw new AutomationPausedError(this.phase);
    let origin: string[] = [];
    try { origin = [new URL(this.#live).origin]; } catch { /* keep empty */ }
    return { kind: "KERNEL_LIVE_VIEW", secretUrl: this.#live, frameOrigins: origin };
  }
  async close(): Promise<void> {
    if (this.#closing) return this.#closing;
    // Fail closed immediately: even when provider deletion fails, no further automation is permitted.
    this.markClosed();
    clearTimeout(this.#timer);
    this.#closing = (async () => {
      await this.driver.api("DELETE", `/browsers/${encodeURIComponent(this.#id)}`, undefined, 10_000);
      await this.driver.verifyDeleted(this.#id);
      this.driver.journalVerifiedDeletion(this.#id);
    })();
    try { await this.#closing; }
    catch (e) { this.#closing = null; throw e; } // caller may retry; detached watchdog also retries
  }
  /** Browser id, for out-of-process cleanup watchdogs only (not a capability: deleting needs the API key). */
  sessionIdForCleanupOnly(): string { return this.#id; }
  toJSON() { return { provider: this.provider, phase: this.phase, liveView: "[SECRET]" }; }
}
