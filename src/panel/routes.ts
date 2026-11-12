import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { CommerceError } from "../engine/errors.js";
import { RateLimiter } from "../http/rateLimit.js";
import type { BuyPanel, PanelRun } from "./BuyPanel.js";

/**
 * HTTP surface of the DIAPORIA Buy panel (docs/BUY_PANEL.md).
 *   GET  /buy/                                  the single-page panel (no secret in it; the link's #fragment carries the capability)
 *   GET  /buy/panel.js, /buy/panel.css          static assets (same origin; CSP script-src 'self')
 *   GET  /buy/api/runs/:run                     purchase-session view (server records only)
 *   GET  /buy/api/runs/:run/events              live view: text/event-stream of full snapshots
 *   GET  /buy/api/runs/:run/candidates/:pid     detail of one researched candidate
 *   POST /buy/api/runs/:run/select              { productId }
 *   POST /buy/api/runs/:run/compare             { destination?: { country, region?, postalCode? } }
 *   POST /buy/api/runs/:run/prepare             { offerId }
 * Every API call needs `Authorization: Bearer dpl_…` (the panel capability). A header credential is never sent by a
 * cross-site form, so these routes are not CSRF-able; a present Origin must still be this server's own.
 */
export interface PanelRouteDeps {
  panel: BuyPanel;
  allowedOrigins: string[];
  readText: (req: IncomingMessage) => Promise<string>;
  now?: () => number;
}

const STATIC_DIRS = (() => {
  const here = dirname(fileURLToPath(import.meta.url));
  // tsx runs src/panel; the build runs dist/src/panel, whose static files stay in the source tree.
  return [join(here, "static"), join(here, "..", "..", "..", "src", "panel", "static")];
})();
function asset(name: string): string {
  for (const d of STATIC_DIRS) { const p = join(d, name); if (existsSync(p)) return readFileSync(p, "utf8"); }
  throw new Error(`panel asset missing: ${name}`);
}
const TYPES: Record<string, string> = { "panel.js": "text/javascript; charset=utf-8", "panel.css": "text/css; charset=utf-8", "index.html": "text/html; charset=utf-8" };
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

const MAX_STREAMS_PER_RUN = 4;
const STREAM_MAX_MS = 10 * 60_000;

export function createPanelRoutes(d: PanelRouteDeps) {
  const limiter = new RateLimiter(240, 60_000);
  const streams = new Map<string, number>();
  const cache = new Map<string, string>();
  const file = (name: string) => { let v = cache.get(name); if (v === undefined) { v = asset(name); cache.set(name, v); } return v; };

  return async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const p = url.pathname;
    if (p === "/buy") { res.statusCode = 308; res.setHeader("Location", "/buy/"); res.end(); return true; }
    if (!p.startsWith("/buy/")) return false;

    if (req.method === "GET" && (p === "/buy/" || p === "/buy/index.html" || p === "/buy/panel.js" || p === "/buy/panel.css")) {
      const name = p === "/buy/" ? "index.html" : p.slice(5);
      res.statusCode = 200; res.setHeader("Content-Type", TYPES[name]!); res.setHeader("Content-Security-Policy", CSP);
      res.setHeader("Referrer-Policy", "no-referrer");
      res.end(file(name)); return true;
    }

    const m = /^\/buy\/api\/runs\/(br_[0-9a-f-]{36})(?:\/(events|select|compare|prepare|candidates\/([A-Za-z0-9_.:%\-]{1,240})))?$/.exec(p);
    if (!m) return json(res, 404, { error: { code: "NOT_FOUND", message: "Not found" } });
    const site = header(req, "sec-fetch-site");
    const origin = header(req, "origin");
    if ((site !== undefined && site !== "same-origin" && site !== "none") || (origin !== undefined && !d.allowedOrigins.includes(origin)))
      return json(res, 403, { error: { code: "ORIGIN_NOT_ALLOWED", message: "Origin not allowed" } });
    const run = d.panel.authenticate(header(req, "authorization"), m[1]!);
    if (!run) return json(res, 401, { error: { code: "PANEL_LINK_INVALID", message: "This panel link is not valid (expired, revoked or wrong). Ask the assistant for a new panel link." } });
    if (!limiter.take(run.runId)) return json(res, 429, { error: { code: "RATE_LIMITED", message: "Too many requests; slow down." } });

    try {
      const action = m[2];
      if (!action && req.method === "GET") return json(res, 200, d.panel.view(run));
      if (action === "events" && req.method === "GET") return stream(req, res, run);
      if (m[3] && req.method === "GET") {
        let pid: string;
        try { pid = decodeURIComponent(m[3]); } catch { return json(res, 400, { error: { code: "INVALID_INPUT", message: "Bad product id" } }); }
        return json(res, 200, d.panel.detail(run, pid));
      }
      if (req.method !== "POST" || !action || m[3]) return json(res, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed" } });
      if (!/^application\/json\b/.test(header(req, "content-type") ?? "")) return json(res, 415, { error: { code: "UNSUPPORTED_MEDIA_TYPE", message: "Send application/json" } });
      let body: Record<string, unknown>;
      try { const t = await d.readText(req); body = t ? JSON.parse(t) : {}; } catch { return json(res, 400, { error: { code: "INVALID_JSON", message: "Invalid JSON" } }); }
      if (!body || typeof body !== "object" || Array.isArray(body)) return json(res, 400, { error: { code: "INVALID_INPUT", message: "Body must be an object" } });
      if (action === "select") {
        if (typeof body.productId !== "string" || body.productId.length > 120) return json(res, 400, { error: { code: "INVALID_INPUT", message: "productId is required" } });
        return json(res, 200, d.panel.select(run, body.productId));
      }
      if (action === "compare") {
        const dst = body.destination as Record<string, unknown> | undefined | null;
        let destination: { country: string; region?: string; postalCode?: string } | null = null;
        if (dst !== undefined && dst !== null) {
          if (typeof dst !== "object" || typeof dst.country !== "string" || !/^[A-Za-z]{2}$/.test(dst.country)) return json(res, 400, { error: { code: "INVALID_INPUT", message: "destination.country must be a 2-letter code" } });
          destination = { country: dst.country.toUpperCase(), ...(typeof dst.region === "string" && dst.region ? { region: dst.region.slice(0, 10) } : {}), ...(typeof dst.postalCode === "string" && dst.postalCode ? { postalCode: dst.postalCode.slice(0, 10) } : {}) };
        }
        return json(res, 200, await d.panel.compare(run, destination));
      }
      if (action === "prepare") {
        if (typeof body.offerId !== "string" || !body.offerId || body.offerId.length > 80) return json(res, 400, { error: { code: "INVALID_INPUT", message: "offerId is required" } });
        // Only an offer id crosses from the browser. Price, identity, quantity and the limit come from the server's records.
        return json(res, 200, await d.panel.prepare(run, body.offerId));
      }
      return json(res, 404, { error: { code: "NOT_FOUND", message: "Not found" } });
    } catch (e) {
      if (e instanceof CommerceError) {
        const status = e.code === "NOT_FOUND" ? 404 : e.code === "FORBIDDEN" || e.code === "PAYMENT_DISABLED" ? 403 : e.code === "INVALID_STATE" || e.code === "SESSION_EXPIRED" ? 409 : 400;
        return json(res, status, { error: { code: e.code, message: e.message, details: e.details ?? null } });
      }
      if (e instanceof Error && /not found/i.test(e.message)) return json(res, 404, { error: { code: "NOT_FOUND", message: "Not found" } });
      console.error("[diaporia] buy panel error:", e instanceof Error ? e.message : "unknown");
      return json(res, 500, { error: { code: "INTERNAL_ERROR", message: "Internal error" } });
    }
  };

  function stream(req: IncomingMessage, res: ServerResponse, run: PanelRun): true {
    const open = streams.get(run.runId) ?? 0;
    if (open >= MAX_STREAMS_PER_RUN) { json(res, 429, { error: { code: "TOO_MANY_STREAMS", message: "Too many open panels for this session" } }); return true; }
    streams.set(run.runId, open + 1);
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no", Connection: "keep-alive" });
    let last = ""; let seq = 0; let pending: NodeJS.Timeout | null = null; let closed = false;
    const push = () => {
      if (closed) return;
      let body: string;
      try { body = JSON.stringify(d.panel.view(run)); } catch (e) { body = JSON.stringify({ error: { code: e instanceof CommerceError ? e.code : "VIEW_FAILED", message: e instanceof Error ? e.message : "view failed" } }); }
      if (body === last) return;
      last = body; seq += 1;
      res.write(`id: ${seq}\nevent: snapshot\ndata: ${body}\n\n`);
    };
    const soon = () => { if (!pending) pending = setTimeout(() => { pending = null; push(); }, 80); };
    const unsub = d.panel.subscribe(run.runId, soon);
    // Checkout state also changes on other routes (owner page, payment return, reconcile): re-read periodically.
    const tick = setInterval(push, 1500);
    const ping = setInterval(() => { if (!closed) res.write(": ping\n\n"); }, 15_000);
    const end = setTimeout(() => { res.write("event: rotate\ndata: {}\n\n"); res.end(); }, STREAM_MAX_MS);
    const done = () => {
      if (closed) return; closed = true;
      unsub(); clearInterval(tick); clearInterval(ping); clearTimeout(end); if (pending) clearTimeout(pending);
      streams.set(run.runId, Math.max(0, (streams.get(run.runId) ?? 1) - 1));
    };
    res.write("retry: 2000\n\n");
    push();
    req.on("close", done); res.on("close", done);
    return true;
  }
}

function header(req: IncomingMessage, name: string): string | undefined { const v = req.headers[name]; return Array.isArray(v) ? v[0] : v; }
function json(res: ServerResponse, status: number, body: unknown): true {
  res.statusCode = status; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(body)); return true;
}
