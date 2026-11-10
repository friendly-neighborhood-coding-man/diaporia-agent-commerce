import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import type { DevAuth } from "../auth/devAuth.js";
import { CommerceError } from "../engine/errors.js";
import { MoneyError, parseOwnerAmountToMinor } from "../domain/money.js";
import { esc, money, page } from "../http/html.js";
import type { BrowserCheckoutHandoff, Handoff } from "./BrowserCheckoutHandoff.js";
import type { HumanView } from "./drivers.js";

/**
 * Owner-authenticated, short-lived handoff page: /handoff/<ho_id>
 *
 *  GET                    → owner-key form (the link alone grants nothing: AI hosts may see the link)
 *  POST action=review     → verifies the owner key belongs to the handoff's user; sets a 10-minute HttpOnly,
 *                           SameSite=Strict cookie scoped to this one handoff path; shows the captured cart
 *  POST action=maximum    → owner sets their maximum (fresh human authority for this handoff)
 *  POST action=takeover   → automation paused, then the live browser view is shown (KERNEL Live View iframe)
 *  POST action=finish     → read-only observation + seller-side check; browser destroyed
 *  POST action=cancel     → only before takeover
 *
 * The KERNEL live-view URL appears ONLY in the HTML of an authenticated takeover response (no-store, Referrer-Policy same-origin: no referrer leaves the origin).
 * It is never returned by MCP, written to the audit log or printed.
 */
export interface HandoffHttpDeps {
  handoff: BrowserCheckoutHandoff;
  auth: DevAuth;
  now: () => number;
  secureCookies: boolean;
  sameOrigin: (req: IncomingMessage) => boolean;
  readText: (req: IncomingMessage) => Promise<string>;
}

interface OwnerSession { userId: string; handoffId: string; csrf: string; expiresAt: number }
const SESSION_MS = 10 * 60_000;
const ID = /^\/handoff\/(ho_[0-9a-f-]{36})$/;

export function createHandoffRoutes(deps: HandoffHttpDeps) {
  const sessions = new Map<string, OwnerSession>();
  const cookieName = (hid: string) => `dac_ho_${hid.slice(3, 11)}`;

  const send = (res: ServerResponse, status: number, body: string, frameOrigins: string[] = []) => {
    res.statusCode = status;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("Content-Security-Policy", `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'${frameOrigins.length ? `; frame-src ${frameOrigins.join(" ")}` : ""}`);
    res.end(body);
  };
  const ownerSession = (req: IncomingMessage, hid: string, csrf: string | null): OwnerSession | null => {
    const sid = new RegExp(`(?:^|;\\s*)${cookieName(hid)}=([A-Za-z0-9_-]+)`).exec(req.headers.cookie ?? "")?.[1];
    const s = sid ? sessions.get(sid) : undefined;
    if (!s || s.handoffId !== hid || s.expiresAt <= deps.now()) return null;
    if (csrf !== null && csrf !== s.csrf) return null;
    return s;
  };

  function summary(h: Handoff): string {
    const c = h.snapshot;
    const row = (k: string, v: string) => `<tr><td>${esc(k)}</td><td>${v}</td></tr>`;
    const cons = h.constraints;
    return `<table>
      ${row("Merchant", `${esc(h.merchantName)} <span class="muted">(${esc(h.merchantDomain)})</span>`)}
      ${row("Product (authorized)", esc(`${h.identity.brand} ${h.identity.model} · ${h.identity.variant ?? "—"} · ${h.identity.condition}`))}
      ${row("Merchant shows", c ? esc(`${c.title ?? "?"} · ${c.variant ?? "variant not shown"} · ${c.condition ?? "condition not shown"} · qty ${c.quantity ?? "?"}`) : "—")}
      ${row("Shipping", c ? esc(money(c.shippingMinor, h.currency)) : "—")}${row("Tax", c ? esc(money(c.taxMinor, h.currency)) : "—")}
      ${row("<b>Displayed total</b>", `<b>${c ? esc(money(c.totalMinor, h.currency)) : "—"}</b>`)}
      ${row("Effective maximum", cons?.effectiveMaximumMinor != null ? esc(money(cons.effectiveMaximumMinor, h.currency)) : "not set")}
      ${row("Unknowns", esc(cons?.unknowns.join(", ") || "none"))}
      ${row("Problems", esc(cons?.violations.join(", ") || "none"))}
      ${row("State", `<span class="state">${esc(h.state)}</span>`)}</table>`;
  }

  function reviewPage(h: Handoff, s: OwnerSession): string {
    const hidden = `<input type="hidden" name="csrf" value="${esc(s.csrf)}">`;
    const canSetMax = ["HUMAN_ACTION_REQUIRED", "HOLD"].includes(h.state) && !!h.snapshot && !!h.constraints;
    const canTakeover = h.state === "HUMAN_ACTION_REQUIRED" && h.ownerMaxMinor !== null;
    return page("Your prepared merchant checkout", `<p>An AI assistant prepared this cart on the merchant's own website. DIAPORIA stopped
      before payment. If it looks right, set your maximum, then take over the browser and use the merchant's own PayPal button yourself.</p>
      ${summary(h)}
      ${canSetMax ? `<form method="post">${hidden}<input type="hidden" name="action" value="maximum">
        <label>Your maximum for this purchase (${esc(h.currency)})<input name="maximum" inputmode="decimal" required placeholder="60.00"></label>
        <p class="muted">DIAPORIA will not hand over a cart above the lowest of your maximum, the assistant's requested limit and any budget. PayPal still asks you to approve.</p>
        <p><button>Set maximum</button></p></form>` : ""}
      ${canTakeover ? `<form method="post">${hidden}<input type="hidden" name="action" value="takeover">
        <p><button>Take over the browser</button></p><p class="muted">Automation stops before you see the browser. DIAPORIA does not record or log the payment step.</p></form>` : ""}
      ${["HUMAN_ACTION_REQUIRED", "HOLD", "CHECKOUT_READY"].includes(h.state) ? `<form method="post">${hidden}<input type="hidden" name="action" value="cancel"><p><button class="secondary">Cancel this handoff</button></p></form>` : ""}`,
      "DIAPORIA browser checkout handoff — you complete the payment step yourself");
  }

  function takeoverPage(h: Handoff, s: OwnerSession, view: HumanView | null): { body: string; frames: string[] } {
    const hidden = `<input type="hidden" name="csrf" value="${esc(s.csrf)}">`;
    const live = view?.kind === "KERNEL_LIVE_VIEW" && view.secretUrl
      ? `<iframe src="${esc(view.secretUrl)}" title="Merchant browser (live)" referrerpolicy="origin" allow="clipboard-read; clipboard-write"
           style="display:block;width:100%;aspect-ratio:16/10;border:1px solid #ccc;border-radius:6px"></iframe>`
      : view?.kind === "LOCAL_FIXTURE_WINDOW"
        ? `<p class="muted">Offline fixture: the merchant browser is a local Chromium window controlled by the fixture harness.</p>`
        : `<p class="state">The live browser view is not available.</p>`;
    return {
      frames: view?.frameOrigins ?? [],
      body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Merchant checkout — your turn</title>
        <style>body{font:15px/1.5 system-ui,sans-serif;max-width:1200px;margin:1rem auto;padding:0 1rem}button{font:inherit;padding:.5rem 1rem}.muted{color:#666;font-size:13px}.state{font-weight:600}</style></head>
        <body><p><b>Your turn.</b> DIAPORIA automation is paused. Use the merchant's own PayPal button below and approve on PayPal yourself.
        If PayPal opens a popup window, it appears inside this same browser view. Takeover ends ${esc(h.takeoverDeadline ? new Date(h.takeoverDeadline).toISOString() : "soon")}.</p>
        ${live}
        <form method="post">${hidden}<input type="hidden" name="action" value="finish"><p><button>I'm done — check the result</button></p></form>
        <p class="muted">A merchant "thank you" page is not treated as proof of payment. DIAPORIA reports the order as confirmed only when the merchant's authenticated order channel confirms it.</p>
        </body></html>`,
    };
  }

  return async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const m = ID.exec(url.pathname);
    if (!m) return false;
    const hid = m[1]!;
    if (req.method === "GET") {
      send(res, 200, page("Open your prepared checkout", `<p>Enter your owner key to review checkout <code>${esc(hid.slice(0, 11))}…</code>.
        This link alone grants nothing; the AI assistant that created it cannot use it.</p>
        <form method="post"><input type="hidden" name="action" value="review"><label>Owner key<input name="ownerKey" type="password" autocomplete="off" required></label><p><button>Review</button></p></form>`,
        "DIAPORIA browser checkout handoff"));
      return true;
    }
    if (req.method !== "POST" || !deps.sameOrigin(req)) { send(res, 403, page("Forbidden", "<p>Forbidden.</p>")); return true; }
    const form = new URLSearchParams(await deps.readText(req));
    const action = form.get("action");
    const notFound = () => send(res, 404, page("Not found", "<p>Handoff not found.</p>"));
    try {
      await deps.handoff.tick();
      if (action === "review") {
        const userId = deps.auth.verifyOwnerKey(form.get("ownerKey") ?? undefined);
        if (!userId) { send(res, 401, page("Not authorized", "<p>Owner key not recognized.</p>")); return true; }
        let h: Handoff;
        try { h = deps.handoff.get(hid, userId); } catch { notFound(); return true; }
        const sid = randomBytes(24).toString("base64url");
        const s: OwnerSession = { userId, handoffId: hid, csrf: randomBytes(24).toString("base64url"), expiresAt: deps.now() + SESSION_MS };
        sessions.set(sid, s);
        for (const [k, v] of sessions) if (v.expiresAt <= deps.now()) sessions.delete(k);
        res.setHeader("Set-Cookie", `${cookieName(hid)}=${sid}; HttpOnly; SameSite=Strict; Path=/handoff/${hid}; Max-Age=${SESSION_MS / 1000}${deps.secureCookies ? "; Secure" : ""}`);
        if (h.state === "HANDOFF_OPENED") { const t = takeoverPage(h, s, deps.handoff.viewFor(userId, hid)); send(res, 200, t.body, t.frames); return true; }
        send(res, 200, reviewPage(h, s));
        return true;
      }
      const s = ownerSession(req, hid, form.get("csrf"));
      if (!s) { send(res, 401, page("Session expired", "<p>Open the link again and re-enter your owner key.</p>")); return true; }
      if (action === "maximum") {
        let h = deps.handoff.get(hid, s.userId);
        let max: number;
        // WP-5 (IR-10): strict human-input parser; the re-rendered review page shows the effective maximum before takeover.
        try { max = parseOwnerAmountToMinor(form.get("maximum") ?? "", h.currency); }
        catch (e) { send(res, 400, page("Invalid amount", `<p>${esc(e instanceof MoneyError ? e.message : "Invalid amount.")}</p>`)); return true; }
        h = deps.handoff.setOwnerMaximum(s.userId, hid, max);
        send(res, 200, reviewPage(h, s));
        return true;
      }
      if (action === "takeover") {
        const { handoff: h, view } = await deps.handoff.takeover(s.userId, hid);
        const t = takeoverPage(h, s, view);
        send(res, 200, t.body, t.frames);
        return true;
      }
      if (action === "finish") {
        const h = await deps.handoff.finish(s.userId, hid);
        send(res, 200, page("Handoff finished", `${summary(h)}
          <p>Outcome: <span class="state">${esc(h.state)}</span>${h.seller ? ` · seller says <b>${esc(h.seller.status)}</b>${h.seller.orderRef ? ` (${esc(h.seller.orderRef)})` : ""}` : " · no authenticated seller confirmation available"}</p>
          ${h.observation?.discrepancies.length ? `<p class="muted">Notes: ${esc(h.observation.discrepancies.join(", "))}</p>` : ""}
          <p>The browser session was closed. Return to your AI assistant.</p>`, "DIAPORIA browser checkout handoff"));
        return true;
      }
      if (action === "cancel") {
        const h = await deps.handoff.cancel(s.userId, hid);
        send(res, 200, page("Handoff cancelled", `<p>State: <span class="state">${esc(h.state)}</span>. The prepared browser was closed; nothing was paid.</p>`));
        return true;
      }
      send(res, 400, page("Unknown action", "<p>Unknown action.</p>"));
      return true;
    } catch (e) {
      if (e instanceof CommerceError) { send(res, e.code === "NOT_FOUND" ? 404 : 409, page("Cannot continue", `<p class="state">${esc(e.code)}</p><p>${esc(e.message)}</p>`)); return true; }
      throw e;
    }
  };
}
