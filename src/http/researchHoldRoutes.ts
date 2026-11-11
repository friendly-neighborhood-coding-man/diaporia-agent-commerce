/**
 * V21-04 / R-A owner confirmation page for research-hold proposals (Option A).
 *
 *   GET  /research-holds/<rhp_id>                  explains the step and asks for the owner key. Shows no proposal
 *                                                  content and changes nothing.
 *   POST /research-holds/<rhp_id> action=review    owner key (typed by the human) → opens a 10-minute review session
 *                                                  bound to this owner, this proposal and its digest; HttpOnly,
 *                                                  SameSite=Strict cookie on Path=/research-holds; page shows the
 *                                                  original item, the proposed change and the agent's text, and a
 *                                                  single-use passkey challenge bound to proposal + digest + session.
 *   POST /research-holds/<rhp_id> action=confirm   session cookie + CSRF token + acknowledge=yes (+ the budget typed
 *                                                  again for CONFIRM_BUDGET) + a WebAuthn-style assertion WITH USER
 *                                                  VERIFICATION from an authenticator enrolled in the protected owner
 *                                                  registry (R-A) → owner-confirmed resolution. Single use.
 *   POST /research-holds/<rhp_id> action=reject    session cookie + CSRF token → proposal REJECTED (rejecting only
 *                                                  keeps the gate closed, so it needs no assertion).
 *
 * Every POST must be a same-origin BROWSER form post (sameOriginStrict), and a request carrying an Authorization header
 * (an AI client's bearer token) is refused outright. These header checks are hygiene, NOT proof of a human: a process
 * that holds the owner key can forge them. R-A: the proof of a human is the assertion, signed by a private key that
 * only the owner's authenticator holds; the server and the AI host hold public keys only. When the owner registry
 * boundary is not established (src/auth/OwnerConfirmation.ts), confirming is UNAVAILABLE (503) and the gate stays closed.
 *
 * R-B: failed owner-key attempts are rate limited per client (429).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { CommerceGateway } from "../engine/CommerceGateway.js";
import { CommerceError } from "../engine/errors.js";
import { formatMinor, MoneyError, parseOwnerAmountToMinor, type Currency } from "../domain/money.js";
import type { ResearchHoldProposal } from "../engine/ResearchHoldProposals.js";
import { researchHoldBinding, type OwnerConfirmationBoundary } from "../auth/OwnerConfirmation.js";
import { statedBudget } from "../intent/ResearchIntentV2.js";
import { esc, page } from "./html.js";

const REVIEW_TTL_MS = 10 * 60_000;
const BANNER = "DIAPORIA owner confirmation — an AI assistant cannot do this step";
const ROUTE = /^\/research-holds\/(rhp_[0-9a-f-]{36})$/;
/** R-A: passkey creation for the owner registry (GET only; the server stores nothing). */
export const SETUP_PATH = "/research-holds/passkey-setup";

interface ReviewSession { userId: string; proposalId: string; digest: string; csrf: string; expiresAt: number }

export function createResearchHoldRoutes(o: { gateway: CommerceGateway; verifyOwnerKey: (k: string | undefined, client: string) => string | null; ownerKeyLimited: (client: string) => boolean;
  confirmation: OwnerConfirmationBoundary; now: () => number; secureCookies: boolean;
  /** Strict browser same-origin check for state-changing form posts. */
  sameOriginForm: (req: IncomingMessage) => boolean; readText: (req: IncomingMessage) => Promise<string> }) {
  const sessions = new Map<string, ReviewSession>();
  const fp = (sid: string) => createHash("sha256").update(sid).digest("hex").slice(0, 16);
  const send = (res: ServerResponse, status: number, title: string, body: string, nonce?: string) => {
    res.statusCode = status;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Content-Security-Policy", `default-src 'none'; style-src 'unsafe-inline'; ${nonce ? `script-src 'nonce-${nonce}'; ` : ""}form-action 'self'; frame-ancestors 'none'; base-uri 'none'`);
    res.end(page(title, body, BANNER));
    return true;
  };
  const sameToken = (a: string | null, b: string) => !!a && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

  return async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (url.pathname === SETUP_PATH) {
      if (req.method !== "GET") { res.statusCode = 405; res.end(); return true; }
      const nonce = randomBytes(16).toString("base64url");
      return send(res, 200, "Set up your owner passkey", `<p>This page creates a passkey on <b>your</b> device for confirming changes to your purchase research.
        It stores nothing on the server. Copy the result into the owner registry with <code>scripts/owner-enroll.ts</code>, run as the separate owner OS account
        (docs/SETUP.md, "Owner confirmation"). Never give the result to an AI assistant to install for you.</p>
        <form id="setup" data-rpid="${esc(o.confirmation.rpId)}"><label>Owner user id<input name="userId" autocomplete="off" required></label><p><button>Create passkey</button></p></form>
        <pre id="out" class="muted"></pre><script nonce="${nonce}">${SETUP_SCRIPT}</script>`, nonce);
    }
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

    const client = req.socket.remoteAddress ?? "unknown";
    if (action === "review") {
      if (o.ownerKeyLimited(client)) return send(res, 429, "Too many attempts", "<p>Too many wrong owner keys. Wait 15 minutes and try again. Nothing was changed.</p>");
      const userId = o.verifyOwnerKey(form.get("ownerKey") ?? undefined, client);
      if (!userId) return send(res, 401, "Not authorized", "<p>Owner key not recognized. Nothing was changed.</p>");
      const view = o.gateway.researchHoldForOwner(userId, proposalId);
      if (!view) return send(res, 404, "Not found", "<p>No such proposal for this owner.</p>");
      if (view.proposal.status !== "PENDING") return send(res, 409, "Already decided", `<p class="state">${esc(view.proposal.status)}</p><p>This proposal was already decided. Nothing was changed.</p>`);
      if (!view.decidable) return send(res, 410, "Proposal expired", "<p>This proposal expired. Ask your AI assistant to propose it again. Nothing was changed.</p>");
      const sid = randomBytes(24).toString("base64url"); const csrf = randomBytes(24).toString("base64url");
      sessions.set(sid, { userId, proposalId, digest: view.proposal.digest, csrf, expiresAt: Math.min(o.now() + REVIEW_TTL_MS, view.proposal.expiresAt) });
      res.setHeader("Set-Cookie", `dac_hold=${sid}; HttpOnly; SameSite=Strict; Path=/research-holds; Max-Age=600${o.secureCookies ? "; Secure" : ""}`);
      const human = o.confirmation.canConfirm(userId)
        ? { challenge: o.confirmation.newChallenge(userId, researchHoldBinding({ userId, purchaseSessionId: view.proposal.purchaseSessionId, proposalId, digest: view.proposal.digest, kind: view.proposal.kind,
            requirement: view.proposal.requirement, budgetMinor: view.proposal.budgetMinor, currency: view.proposal.currency }, fp(sid)), REVIEW_TTL_MS), rpId: o.confirmation.rpId,
            credentialIds: o.confirmation.authenticatorsFor(userId).map((a) => a.credentialId), nonce: randomBytes(16).toString("base64url") }
        : { unavailable: o.confirmation.status.established ? "no passkey is enrolled for this owner in the owner registry" : o.confirmation.status.reason };
      return send(res, 200, "Review the proposed change", reviewBody(view.proposal, view.session, csrf, human), "nonce" in human ? human.nonce : undefined);
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
      if (action === "confirm" && !o.confirmation.canConfirm(sess.userId))
        return send(res, 503, "Confirmation unavailable", `<p>Owner confirmation is unavailable on this server: ${esc(o.confirmation.status.established ? "no passkey is enrolled for this owner" : o.confirmation.status.reason)}.</p>
          <p>Nothing was changed. The requirement stays open. See docs/SETUP.md, "Owner confirmation".</p>`);
      sessions.delete(sid!); // single use from here on, whatever the outcome
      try {
        if (action === "reject") {
          o.gateway.rejectResearchHoldAsOwner(sess.userId, proposalId, { shownDigest: sess.digest, ownerSessionFingerprint: fp(sid!) });
          return send(res, 200, "Proposal rejected", "<p>Nothing was changed. The research requirement stays open. You can return to your AI assistant.</p>");
        }
        const v = o.confirmation.verifyAssertion(sess.userId, researchHoldBinding({ userId: sess.userId, purchaseSessionId: view.proposal.purchaseSessionId, proposalId, digest: sess.digest,
          kind: view.proposal.kind, requirement: view.proposal.requirement, budgetMinor: view.proposal.budgetMinor, currency: view.proposal.currency }, fp(sid!)), {
          credentialId: form.get("credentialId") ?? "", clientDataJSON: form.get("clientDataJSON") ?? "", authenticatorData: form.get("authenticatorData") ?? "", signature: form.get("signature") ?? "" });
        if (!v.ok) return send(res, 401, "Not verified", `<p>Your passkey did not verify (${esc(v.reason)}). Nothing was changed. Review the proposal again.</p>`);
        o.gateway.confirmResearchHoldAsOwner(sess.userId, proposalId, { shownDigest: sess.digest, ownerSessionFingerprint: fp(sid!), typedBudgetMinor: typed, humanProof: v.proof });
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

type HumanStep = { challenge: string; rpId: string; credentialIds: string[]; nonce: string } | { unavailable: string };

function reviewBody(p: ResearchHoldProposal, s: { requestText: string; currency: string; budgetMinor: number | null }, csrf: string, human: HumanStep): string {
  const cur = p.currency as Currency;
  const fmt = (minor: number | null) => (minor === null ? "none" : `${formatMinor(minor, cur)} ${cur}`);
  const parts: string[] = [`<p>Your purchase request: <q>${esc(s.requestText)}</q></p>`];
  if (p.kind === "DROP_REQUIREMENT") {
    const contradicted = p.item.code === "MUST_HAVE_CONTRADICTED";
    parts.push(`<h2>Open requirement</h2><table><tr><td>Requirement</td><td><code>${esc(p.requirement)}</code></td></tr><tr><td>Research result</td><td>${esc(p.item.code)}: ${esc(p.item.detail)}</td></tr></table>`);
    const unrecognized = p.item.code === "MUST_HAVE_UNRECOGNIZED" || p.item.code === "MUST_NOT_UNVERIFIABLE";
    if (unrecognized) parts.push(`<p class="state" style="color:#b3261e">Warning: DIAPORIA cannot check this requirement automatically, and nothing has verified it. If you drop it, nobody has checked that the product meets it.</p>`);
    else parts.push(contradicted
      ? `<p class="state" style="color:#b3261e">Warning: evidence found during research says this product does NOT meet this requirement. If you drop it, the product you buy may lack it.</p>`
      : `<p class="state">This requirement is not verified for this product. If you drop it, the product may not have it.</p>`);
    parts.push(`<h2>Proposed change</h2><p>Drop the requirement <code>${esc(p.requirement)}</code> for this purchase session only.</p>`);
  } else {
    // R-C: the stated amount is read by the research parser itself (currency and magnitude included), never by a regex
    // over the item text. An amount in another currency is shown as such and never converted.
    const st = statedBudget(s.requestText);
    const sameCur = st.budgetMinor !== null && st.currency === cur ? st.budgetMinor : null;
    const bare = st.budgetMinor === null ? st.bareAmountMinor(cur) : null;
    const reference = s.budgetMinor ?? sameCur ?? bare;
    parts.push(`<h2>Unresolved budget</h2><table><tr><td>From your request</td><td>${esc(p.item.detail)}</td></tr><tr><td>Session budget</td><td>${esc(fmt(s.budgetMinor))}</td></tr></table>`);
    parts.push(`<h2>Proposed change</h2><p>Set the budget for this purchase session to <span class="state">${esc(fmt(p.budgetMinor))}</span>.</p>`);
    if (st.budgetMinor !== null && st.currency !== cur)
      parts.push(`<p class="state" style="color:#b3261e">Warning: your request states ${esc(formatMinor(st.budgetMinor, st.currency))} ${esc(st.currency)}, a different currency. DIAPORIA does not convert currencies; check that ${esc(fmt(p.budgetMinor))} is what you mean.</p>`);
    else if (reference !== null && p.budgetMinor !== null && p.budgetMinor > reference)
      parts.push(`<p class="state" style="color:#b3261e">Warning: this is higher than the amount in your request (${esc(formatMinor(reference, cur))} ${esc(cur)}${s.budgetMinor === null && sameCur === null ? ", which had no currency" : ""}).</p>`);
  }
  parts.push(`<h2>Written by the AI assistant</h2><p class="muted">This is the assistant's text. It is not verified as your words.</p><blockquote>${esc(p.agentText)}</blockquote>`);
  if ("unavailable" in human) parts.push(`<p class="state" style="color:#b3261e">Confirming is unavailable on this server: ${esc(human.unavailable)}.</p>
    <p>Owner confirmation needs a passkey enrolled in the protected owner registry (docs/SETUP.md, "Owner confirmation"). The requirement stays open; you can still reject the proposal.</p>`);
  else parts.push(`<form method="post" id="confirm" data-challenge="${esc(human.challenge)}" data-rpid="${esc(human.rpId)}" data-credentials="${esc(human.credentialIds.join(","))}">
    <input type="hidden" name="action" value="confirm"><input type="hidden" name="csrf" value="${esc(csrf)}">
    <input type="hidden" name="credentialId"><input type="hidden" name="clientDataJSON"><input type="hidden" name="authenticatorData"><input type="hidden" name="signature">
    ${p.kind === "CONFIRM_BUDGET" ? `<label>Type the budget to confirm it (${esc(cur)})<input name="budget" inputmode="decimal" autocomplete="off" required></label>` : ""}
    <p><label><input type="checkbox" name="acknowledge" value="yes" style="width:auto" required> I read the change above and I want it.</label></p>
    <p><button>Confirm with your passkey</button></p><p class="muted">Your device will ask you to verify yourself (fingerprint, face or PIN).</p></form>
    <script nonce="${esc(human.nonce)}">${PASSKEY_SCRIPT}</script>`);
  parts.push(`
<form method="post"><input type="hidden" name="action" value="reject"><input type="hidden" name="csrf" value="${esc(csrf)}"><p><button class="secondary">Reject</button></p></form>
    <p class="muted">Proposal ${esc(p.proposalId)} · digest ${esc(p.digest.slice(0, 16))}… · expires ${esc(new Date(p.expiresAt).toISOString())}</p>`);
  return parts.join("\n");
}

/** Browser side of the confirm step: a WebAuthn get() with user verification required, bound to the server challenge. */
const PASSKEY_SCRIPT = `(function(){var f=document.getElementById("confirm");if(!f)return;
var b=function(s){s=s.replace(/-/g,"+").replace(/_/g,"/");while(s.length%4)s+="=";return Uint8Array.from(atob(s),function(c){return c.charCodeAt(0)})};
var u=function(a){var s="";new Uint8Array(a).forEach(function(x){s+=String.fromCharCode(x)});return btoa(s).replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/,"")};
f.addEventListener("submit",function(e){if(f.elements.signature.value)return;e.preventDefault();
if(!window.PublicKeyCredential){alert("This browser has no passkey support. Nothing was changed.");return}
navigator.credentials.get({publicKey:{challenge:b(f.dataset.challenge),rpId:f.dataset.rpid,userVerification:"required",timeout:120000,
allowCredentials:f.dataset.credentials.split(",").filter(Boolean).map(function(id){return{type:"public-key",id:b(id)}})}}).then(function(c){
f.elements.credentialId.value=u(c.rawId);f.elements.clientDataJSON.value=u(c.response.clientDataJSON);
f.elements.authenticatorData.value=u(c.response.authenticatorData);f.elements.signature.value=u(c.response.signature);f.submit()},
function(){alert("Passkey verification was cancelled. Nothing was changed.")})})})();`;

/** Browser side of passkey setup: create() with user verification required; prints the PUBLIC key for the registry. */
const SETUP_SCRIPT = `(function(){var f=document.getElementById("setup");
var u=function(a){var s="";new Uint8Array(a).forEach(function(x){s+=String.fromCharCode(x)});return btoa(s).replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/,"")};
f.addEventListener("submit",function(e){e.preventDefault();var id=f.elements.userId.value;
navigator.credentials.create({publicKey:{challenge:crypto.getRandomValues(new Uint8Array(32)),rp:{id:f.dataset.rpid,name:"DIAPORIA owner confirmation"},
user:{id:new TextEncoder().encode(id),name:id,displayName:id},pubKeyCredParams:[{type:"public-key",alg:-7}],
authenticatorSelection:{userVerification:"required",residentKey:"preferred"},attestation:"none",timeout:120000}}).then(function(c){
var k=c.response.getPublicKey&&c.response.getPublicKey();if(!k){document.getElementById("out").textContent="This browser cannot export the public key.";return}
document.getElementById("out").textContent=JSON.stringify({userId:id,credentialId:u(c.rawId),publicKeySpki:btoa(String.fromCharCode.apply(null,new Uint8Array(k))),alg:c.response.getPublicKeyAlgorithm()})},
function(err){document.getElementById("out").textContent="Passkey creation failed or was cancelled: "+err})})})();`;
