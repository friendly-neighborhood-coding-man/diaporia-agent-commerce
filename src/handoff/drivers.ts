/**
 * Browser drivers for the checkout handoff. A driver owns ONE isolated browser per handoff and exposes only:
 *   - run(code): execute a DIAPORIA-built Playwright snippet (prepare / observe) — refused while paused
 *   - pause()/resume-for-observation: automation is hard-disabled during human takeover
 *   - humanView(): the human's way into the same browser session (a secret; only the authenticated handoff page sees it)
 *   - close(): destroy the browser (and with it every cookie, popup and the live-view capability)
 *
 * Nothing here returns cookies, CDP/WebDriver endpoints, or the live-view URL to callers other than the handoff page.
 */
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
  /** Hard cap on browsers this process may create. Default 3. */
  maxSessions?: number;
  /** Must be true to construct: KERNEL browsers are billed. Tests use a fake fetch. */
  allowLive: boolean;
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
  private readonly o: Required<Omit<KernelDriverOptions, "allowLive">>;
  constructor(apiKey: string, opts: KernelDriverOptions) {
    if (!opts.allowLive) throw new Error("KernelDriver needs allowLive: true (billed browser sessions)");
    if (!apiKey || apiKey.length < 10) throw new Error("KERNEL API key missing");
    this.#key = apiKey;
    this.o = { fetchImpl: opts.fetchImpl ?? fetch, baseUrl: (opts.baseUrl ?? "https://api.onkernel.com").replace(/\/$/, ""), maxSessions: opts.maxSessions ?? 3 };
  }
  get sessionsCreated() { return this.#created; }

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
    if (this.#created >= this.o.maxSessions) throw new KernelBudgetExceeded();
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
      await this.api("DELETE", `/browsers/${encodeURIComponent(id)}`, undefined, 10_000).catch(() => undefined);
      throw new Error("KERNEL returned no live view URL (headful browser required)");
    }
    return new KernelSession(this, id, live);
  }
}

export class KernelSession extends PhasedSession implements BrowserSession {
  readonly provider = "KERNEL" as const;
  #id: string;
  #live: string;
  constructor(private readonly driver: KernelDriver, id: string, live: string) { super(); this.#id = id; this.#live = live; }
  async run<T>(code: string, opts: { timeoutSec?: number } = {}): Promise<T> {
    this.assertRunnable();
    const sec = Math.max(5, Math.min(120, opts.timeoutSec ?? 45));
    const out = await this.driver.api("POST", `/browsers/${encodeURIComponent(this.#id)}/playwright/execute`, { code, timeout_sec: sec }, (sec + 15) * 1000);
    if (!out || out.success !== true) throw new Error(`KERNEL execution failed: ${String(out?.error ?? "no result").slice(0, 120)}`);
    return out.result as T;
  }
  humanView(): HumanView {
    let origin: string[] = [];
    try { origin = [new URL(this.#live).origin]; } catch { /* keep empty */ }
    return { kind: "KERNEL_LIVE_VIEW", secretUrl: this.#live, frameOrigins: origin };
  }
  async close(): Promise<void> {
    if (this.phase === "CLOSED") return;
    this.markClosed();
    await this.driver.api("DELETE", `/browsers/${encodeURIComponent(this.#id)}`, undefined, 10_000).catch(() => undefined);
  }
  /** Browser id, for out-of-process cleanup watchdogs only (not a capability: deleting needs the API key). */
  sessionIdForCleanupOnly(): string { return this.#id; }
  toJSON() { return { provider: this.provider, phase: this.phase, liveView: "[SECRET]" }; }
}
