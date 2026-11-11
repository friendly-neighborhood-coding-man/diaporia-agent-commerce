/**
 * V21-04 owner confirmation page for research-hold proposals (Option A).
 *
 *   GET  /research-holds/<rhp_id>                  explains the step and asks for the owner key. Shows no proposal
 *                                                  content and changes nothing.
 *   POST /research-holds/<rhp_id> action=review    owner key (typed by the human) → opens a 10-minute review session
 *                                                  bound to this owner, this proposal and its digest; HttpOnly,
 *                                                  SameSite=Strict cookie on Path=/research-holds; page shows the
 *                                                  original item, the proposed change and the agent's text.
 *   POST /research-holds/<rhp_id> action=confirm   session cookie + CSRF token + acknowledge=yes (+ the budget typed
 *                                                  again for CONFIRM_BUDGET) → owner-confirmed resolution. Single use.
 *   POST /research-holds/<rhp_id> action=reject    session cookie + CSRF token → proposal REJECTED.
 *
 * Every POST must be a same-origin BROWSER form post (sameOriginStrict: an allowed Origin, or Sec-Fetch-Site
 * same-origin; a request with neither is refused), and a request carrying an Authorization header (an AI client's
 * bearer token) is refused outright. The MCP client never receives the owner key, the cookie or the CSRF token: the
 * tool result contains only the page URL.
 *
 * Residual (documented, not solved here): the server cannot tell a human from a process that holds the owner key and
 * forges browser headers. The owner key must therefore be held only by the human, outside the AI host's environment.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { CommerceGateway } from "../engine/CommerceGateway.js";
import { CommerceError } from "../engine/errors.js";
import { formatMinor, MoneyError, parseOwnerAmountToMinor, type Currency } from "../domain/money.js";
import type { ResearchHoldProposal } from "../engine/ResearchHoldProposals.js";
import { esc, page } from "./html.js";

const REVIEW_TTL_MS = 10 * 60_000;
const BANNER = "DIAPORIA owner confirmation — an AI assistant cannot do this step";
const ROUTE = /^\/research-holds\/(rhp_[0-9a-f-]{36})$/;

interface ReviewSession { userId: string; proposalId: string; digest: string; csrf: string; expiresAt: number }

export function createResearchHoldRoutes(o: { gateway: CommerceGateway; verifyOwnerKey: (k: string | undefined) => string | null; now: () => number; secureCookies: boolean;
  /** Strict browser same-origin check for state-changing form posts. */
  sameOriginForm: (req: IncomingMessage) => boolean; readText: (req: IncomingMessage) => Promise<string> }) {
  const sessions = new Map<string, ReviewSession>();
  const fp = (sid: string) => createHash("sha256").update(sid).digest("hex").slice(0, 16);
  const send = (res: ServerResponse, status: number, title: string, body: string) => {
    res.statusCode = status;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    res.end(page(title, body, BANNER));
    return true;
  };
  const sameToken = (a: string | null, b: string) => !!a && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

  return async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const m = ROUTE.exec(url.pathname);
    if (!m) return false;
    const proposalId = m[1]!;
    for (const [k, v] of sessions) if (v.expiresAt <= o.now()) sessions.delete(k);
    if (req.method === "GET") return send(res, 200, "Confirm a change to your purchase research", `<p>An AI assistant asked to change an open item of one of your purchase
      research sessions. Nothing has changed yet. Enter your owner key to see exactly what it proposes; only you can confirm it.</p>
      <form method="post"><input type="hidden" name="action" value="review"><label>Owner key<input name="ownerKey" type="password" autocomplete="off" required></label>
      <p><button>Review the proposal</button></p></form>`);
    if (req.headers.authorization) return send(res, 403, "Forbidden", "<p>AI client credentials cannot be used on the owner page. Nothing was changed.</p>");
    if (req.method !== "POST") { res.statusCode = 405; res.end(); return true; }
    if (!o.sameOriginForm(req)) return send(res, 403, "Forbidden", "<p>This form must be submitted from this page. Nothing was changed.</p>");
    const form = new URLSearchParams(await o.readText(req));
    const action = form.get("action");

    if (action === "review") {
      const userId = o.verifyOwnerKey(form.get("ownerKey") ?? undefined);
      if (!userId) return send(res, 401, "Not authorized", "<p>Owner key not recognized. Nothing was changed.</p>");
      const view = o.gateway.researchHoldForOwner(userId, proposalId);
      if (!view) return send(res, 404, "Not found", "<p>No such proposal for this owner.</p>");
      if (view.proposal.status !== "PENDING") return send(res, 409, "Already decided", `<p class="state">${esc(view.proposal.status)}</p><p>This proposal was already decided. Nothing was changed.</p>`);
      if (!view.decidable) return send(res, 410, "Proposal expired", "<p>This proposal expired. Ask your AI assistant to propose it again. Nothing was changed.</p>");
      const sid = randomBytes(24).toString("base64url"); const csrf = randomBytes(24).toString("base64url");
      sessions.set(sid, { userId, proposalId, digest: view.proposal.digest, csrf, expiresAt: Math.min(o.now() + REVIEW_TTL_MS, view.proposal.expiresAt) });
      res.setHeader("Set-Cookie", `dac_hold=${sid}; HttpOnly; SameSite=Strict; Path=/research-holds; Max-Age=600${o.secureCookies ? "; Secure" : ""}`);
      return send(res, 200, "Review the proposed change", reviewBody(view.proposal, view.session, csrf));
    }

    if (action === "confirm" || action === "reject") {
      const sid = /(?:^|;\s*)dac_hold=([A-Za-z0-9_-]+)/.exec(req.headers.cookie ?? "")?.[1];
      const sess = sid ? sessions.get(sid) : undefined;
      if (!sess || sess.expiresAt <= o.now() || !sameToken(form.get("csrf"), sess.csrf)) return send(res, 401, "Session expired", "<p>Review the proposal again. Nothing was changed.</p>");
      // A session opened for another proposal is refused and NOT consumed.
      if (sess.proposalId !== proposalId) return send(res, 403, "Different proposal", "<p>You reviewed a different proposal. Open this proposal's own link and review it first. Nothing was changed.</p>");
      const view = o.gateway.researchHoldForOwner(sess.userId, proposalId);
      if (!view) return send(res, 404, "Not found", "<p>No such proposal.</p>");
      const currency = view.proposal.currency as Currency;
      let typed: number | null = null;
      if (action === "confirm") {
        if (form.get("acknowledge") !== "yes") return send(res, 400, "Not confirmed", "<p>Tick the box to confirm that you read the change. Nothing was changed.</p>");
        if (view.proposal.kind === "CONFIRM_BUDGET") {
          try { typed = parseOwnerAmountToMinor(form.get("budget") ?? "", currency); }
          catch (e) { return send(res, 400, "Invalid amount", `<p>${esc(e instanceof MoneyError ? e.message : "Invalid amount.")}</p><p>Nothing was changed.</p>`); }
          if (typed !== view.proposal.budgetMinor) return send(res, 409, "Amount differs", "<p>The amount you typed differs from the proposed budget. Nothing was changed. Review the proposal again.</p>");
        }
      }
      sessions.delete(sid!); // single use from here on, whatever the outcome
      try {
        if (action === "reject") {
          o.gateway.rejectResearchHoldAsOwner(sess.userId, proposalId, { shownDigest: sess.digest, ownerSessionFingerprint: fp(sid!) });
          return send(res, 200, "Proposal rejected", "<p>Nothing was changed. The research requirement stays open. You can return to your AI assistant.</p>");
        }
        o.gateway.confirmResearchHoldAsOwner(sess.userId, proposalId, { shownDigest: sess.digest, ownerSessionFingerprint: fp(sid!), typedBudgetMinor: typed });
        return send(res, 200, "Change confirmed", `<p>You confirmed this change. It is recorded in the audit trail next to the original requirement, which is kept.
          It does not create any spending authority: a payment still needs a fresh offer comparison and your own approval of the checkout.</p>`);
      } catch (e) {
        if (e instanceof CommerceError) return send(res, 409, "Not changed", `<p class="state">${esc(e.code)}</p><p>${esc(e.message)}</p><p>Nothing was changed.</p>`);
        throw e;
      }
    }
    return send(res, 400, "Unknown action", "<p>Nothing was changed.</p>");
  };
}

function reviewBody(p: ResearchHoldProposal, s: { requestText: string; currency: string; budgetMinor: number | null }, csrf: string): string {
  const cur = p.currency as Currency;
  const fmt = (minor: number | null) => (minor === null ? "none" : `${formatMinor(minor, cur)} ${cur}`);
  const parts: string[] = [`<p>Your purchase request: <q>${esc(s.requestText)}</q></p>`];
  if (p.kind === "DROP_REQUIREMENT") {
    const contradicted = p.item.code === "MUST_HAVE_CONTRADICTED";
    parts.push(`<h2>Open requirement</h2><table><tr><td>Requirement</td><td><code>${esc(p.requirement)}</code></td></tr><tr><td>Research result</td><td>${esc(p.item.code)}: ${esc(p.item.detail)}</td></tr></table>`);
    parts.push(contradicted
      ? `<p class="state" style="color:#b3261e">Warning: evidence found during research says this product does NOT meet this requirement. If you drop it, the product you buy may lack it.</p>`
      : `<p class="state">This requirement is not verified for this product. If you drop it, the product may not have it.</p>`);
    parts.push(`<h2>Proposed change</h2><p>Drop the requirement <code>${esc(p.requirement)}</code> for this purchase session only.</p>`);
  } else {
    const stated = /(\d+(?:[.,]\d+)?)/.exec(p.item.detail)?.[1];
    const statedMinor = stated ? Math.round(Number(stated.replace(",", "")) * 10 ** (cur === "KRW" || cur === "JPY" ? 0 : 2)) : null;
    const reference = s.budgetMinor ?? statedMinor;
    parts.push(`<h2>Unresolved budget</h2><table><tr><td>From your request</td><td>${esc(p.item.detail)}</td></tr><tr><td>Session budget</td><td>${esc(fmt(s.budgetMinor))}</td></tr></table>`);
    parts.push(`<h2>Proposed change</h2><p>Set the budget for this purchase session to <span class="state">${esc(fmt(p.budgetMinor))}</span>.</p>`);
    if (reference !== null && p.budgetMinor !== null && p.budgetMinor > reference)
      parts.push(`<p class="state" style="color:#b3261e">Warning: this is higher than the amount in your request (${esc(formatMinor(reference, cur))} ${esc(cur)}).</p>`);
  }
  parts.push(`<h2>Written by the AI assistant</h2><p class="muted">This is the assistant's text. It is not verified as your words.</p><blockquote>${esc(p.agentText)}</blockquote>`);
  parts.push(`<form method="post"><input type="hidden" name="action" value="confirm"><input type="hidden" name="csrf" value="${esc(csrf)}">
    ${p.kind === "CONFIRM_BUDGET" ? `<label>Type the budget to confirm it (${esc(cur)})<input name="budget" inputmode="decimal" autocomplete="off" required></label>` : ""}
    <p><label><input type="checkbox" name="acknowledge" value="yes" style="width:auto" required> I read the change above and I want it.</label></p>
    <p><button>Confirm this change</button></p></form>
    <form method="post"><input type="hidden" name="action" value="reject"><input type="hidden" name="csrf" value="${esc(csrf)}"><p><button class="secondary">Reject</button></p></form>
    <p class="muted">Proposal ${esc(p.proposalId)} · digest ${esc(p.digest.slice(0, 16))}… · expires ${esc(new Date(p.expiresAt).toISOString())}</p>`);
  return parts.join("\n");
}
