import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CommerceGateway } from "../engine/CommerceGateway.js";
import { CommerceError } from "../engine/errors.js";
import { Store } from "../store/Database.js";
import { MockCommerceResearchAdapter, type CommerceResearchAdapter } from "../research/CommerceResearchAdapter.js";
import { MockPayPalProvider } from "../payment/MockPayPalProvider.js";
import type { PaymentProvider } from "../payment/PaymentProvider.js";
import { DevAuth, SCOPES, type Principal } from "../auth/devAuth.js";
import { createCommerceMcpServer } from "../mcp/MCPCommerceAdapter.js";
import { handleSubscriptionRoutes } from "../billing/subscriptions/http.js";
import { parseDecimalToMinor } from "../domain/money.js";
import { NotFoundError } from "../checkout/CheckoutSessionManager.js";
import { esc, money, page } from "./html.js";
import { RateLimiter } from "./rateLimit.js";
import { BrowserCheckoutHandoff } from "../handoff/BrowserCheckoutHandoff.js";
import { createHandoffRoutes } from "../handoff/http.js";
import { OAuthAuthority, type PendingAuthorization } from "../auth/oauth.js";

export interface AppConfig {
  host: string;
  port: number;
  /** Externally visible origin, e.g. http://127.0.0.1:8790 */
  baseUrl: string;
  /**
   * dev: static per-user dev tokens (local only).
   * oauth: OAuth 2.1 (PKCE, DCR, RFC 8707/9728) for remote MCP clients. Payment execution and the
   *   payment-preparation tools exist only when the server is loopback-bound; on any public host an
   *   OAuth deployment is research/read only until an independent security review says otherwise.
   * public-readonly-demo: anonymous research/read.
   */
  authMode: "dev" | "public-readonly-demo" | "oauth";
  /** OAuth token lifetimes (tests). */
  oauth?: { accessTokenTtlSec?: number; refreshTokenTtlSec?: number; codeTtlSec?: number; maxClients?: number };
  dbPath: string;
  auth: DevAuth;
  research?: CommerceResearchAdapter;
  /** Factory so the mock provider can learn the base URL. */
  payments?: (baseUrl: string) => PaymentProvider;
  now?: () => number;
  /** Override the default MOCK merchant identity verifier (tests, future real providers). */
  merchantIdentity?: import("../merchant-identity/MerchantIdentityVerifier.js").MerchantIdentityVerifier;
  /** PayPal Sandbox only: DIAPORIA's own Sandbox merchant id, the real recipient of Sandbox demo payments. */
  sandboxPlatformPayeeId?: string | null;
  sandboxPlatformPayeeEmail?: string | null;
  webhookVerifier?: import("../payment/PayPalWebhook.js").WebhookSignatureVerifier | null;
  readRetry?: { attempts: number; baseDelayMs: number };
  /** Metering, evidence routing, community/managed mode and service billing. */
  service?: import("../engine/ServicePlane.js").ServicePlane | null;
  /** Browser checkout handoff (separate path; absent = disabled). */
  handoff?: Omit<import("../handoff/BrowserCheckoutHandoff.js").HandoffConfig, "baseUrl" | "enabled"> | null;
}

export const MAX_BODY_BYTES = 64 * 1024;
const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\])$/;

export function isLoopbackUrl(u: string): boolean {
  try { return LOOPBACK.test(new URL(u).hostname); } catch { return false; }
}

export interface App { server: Server; gateway: CommerceGateway; store: Store; auth: DevAuth; mockPayPal: MockPayPalProvider | null; paymentExecutionEnabled: boolean; handoff: BrowserCheckoutHandoff | null; oauth: OAuthAuthority | null }

export function createApp(cfg: AppConfig): App {
  const now = cfg.now ?? Date.now;
  const store = new Store(cfg.dbPath);
  const payments = cfg.payments ? cfg.payments(cfg.baseUrl) : new MockPayPalProvider(cfg.baseUrl);
  const mockPayPal = payments instanceof MockPayPalProvider ? payments : null;
  // Payment flows run only with per-user dev tokens on a loopback-only deployment.
  const paymentExecutionEnabled = (cfg.authMode === "dev" || cfg.authMode === "oauth") && LOOPBACK.test(cfg.host) && isLoopbackUrl(cfg.baseUrl);
  // Managed mode needs production authentication, which does not exist yet. Only an explicit loopback simulation may run it.
  if (cfg.service?.mode === "managed" && !(cfg.service.managedSimulation === true && LOOPBACK.test(cfg.host) && isLoopbackUrl(cfg.baseUrl)))
    throw new Error("Managed mode requires production authentication (not implemented). Only managedSimulation on loopback is allowed.");
  const gateway = new CommerceGateway(store, cfg.research ?? new MockCommerceResearchAdapter(now), payments, { baseUrl: cfg.baseUrl, paymentExecutionEnabled,
    ...(cfg.merchantIdentity ? { merchantIdentity: cfg.merchantIdentity } : {}), sandboxPlatformPayeeId: cfg.sandboxPlatformPayeeId ?? null,
    sandboxPlatformPayeeEmail: cfg.sandboxPlatformPayeeEmail ?? null, webhookVerifier: cfg.webhookVerifier ?? null,
    ...(cfg.readRetry ? { readRetry: cfg.readRetry } : {}), service: cfg.service ?? null }, now);
  const base = new URL(cfg.baseUrl);
  // Every human-facing page names the real payment environment. MOCK is never labelled Sandbox.
  const envBanner = payments.name === "PAYPAL_SANDBOX" ? "PayPal Sandbox: test accounts and test money only. No real money moves."
    : "MOCK environment: simulated payment, no PayPal call, no money moves.";
  const envPage = (title: string, body: string) => page(title, body, envBanner);
  const oauth = cfg.authMode === "oauth" ? new OAuthAuthority(store, cfg.auth, { issuer: base.origin, resource: `${base.origin}/mcp`,
    offeredScopes: paymentExecutionEnabled ? [SCOPES.RESEARCH, SCOPES.READ, SCOPES.PREPARE] : [SCOPES.RESEARCH, SCOPES.READ], ...(cfg.oauth ?? {}) }, now) : null;
  if (oauth && base.protocol !== "https:" && !isLoopbackUrl(cfg.baseUrl)) throw new Error("OAuth mode requires an https PUBLIC_BASE_URL unless it is loopback");
  const allowedHosts = [...new Set([base.host, `127.0.0.1:${cfg.port}`, `localhost:${cfg.port}`])];
  const allowedOrigins = [...new Set([base.origin, `http://127.0.0.1:${cfg.port}`, `http://localhost:${cfg.port}`])];
  const mcpLimiter = new RateLimiter(120, 60_000);
  const webLimiter = new RateLimiter(30, 60_000);
  // IR-09 (WP-4): an owner review session is bound to the checkout it reviewed (csId) and to the summary shown.
  const ownerSessions = new Map<string, { userId: string; csrf: string; expiresAt: number; csId: string; summaryHash: string }>();
  const handoff = cfg.handoff ? new BrowserCheckoutHandoff(store, gateway, { ...cfg.handoff, baseUrl: cfg.baseUrl, enabled: paymentExecutionEnabled }, now) : null;
  const handoffRoutes = handoff ? createHandoffRoutes({ handoff, auth: cfg.auth, now, secureCookies: base.protocol === "https:",
    sameOrigin: (req) => sameOriginStrict(req, allowedOrigins), readText }) : null;
  const handoffTimer = handoff ? setInterval(() => { void handoff.tick(); }, 15_000) : null;
  handoffTimer?.unref();

  const server = createServer(async (req, res) => {
    try {
      securityHeaders(res);
      const url = new URL(req.url ?? "/", cfg.baseUrl);
      const ip = req.socket.remoteAddress ?? "unknown";
      if (!allowedHosts.includes(req.headers.host ?? "")) return send(res, 421, { error: "Host not allowed" });

      if (url.pathname === "/healthz") return send(res, 200, { ok: true, paymentExecutionEnabled, paymentEnvironment: payments.name === "PAYPAL_SANDBOX" ? "PAYPAL_SANDBOX" : "MOCK", liveMerchantCheckout: false, authMode: cfg.authMode, paymentProvider: payments.name, researchAdapter: gateway.research.name });

      if (url.pathname === "/mcp") {
        if (req.method !== "POST") { res.setHeader("Allow", "POST"); return send(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server)" }, id: null }); }
        const origin = req.headers.origin;
        if (origin && !allowedOrigins.includes(origin)) return send(res, 403, { error: "Origin not allowed" });
        let principal: Principal | null;
        if (cfg.authMode === "public-readonly-demo") principal = { userId: "anonymous-demo", scopes: new Set([SCOPES.RESEARCH, SCOPES.READ]), kind: "ANONYMOUS_PUBLIC_DEMO", tokenFingerprint: "anon" };
        else if (oauth) principal = oauth.verifyAccessToken(req.headers.authorization);
        else principal = cfg.auth.verifyBearer(req.headers.authorization);
        if (!principal) {
          res.setHeader("WWW-Authenticate", oauth ? oauth.challenge(req.headers.authorization ? "invalid_token" : undefined) : 'Bearer realm="diaporia-dev", error="invalid_token"');
          return send(res, 401, { error: "Missing or invalid bearer token" });
        }
        if (!mcpLimiter.take(`${principal.tokenFingerprint}|${ip}`)) return send(res, 429, { error: "Rate limit exceeded" });
        const body = await readJson(req);
        // OAuth on a public host never offers payment-preparation tools (they would only return HOLD anyway).
        const exposePaymentTools = (cfg.authMode === "dev" || (cfg.authMode === "oauth" && paymentExecutionEnabled)) && principal.scopes.has(SCOPES.PREPARE);
        const mcp = createCommerceMcpServer(gateway, principal, { exposePaymentTools, handoff });
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, enableDnsRebindingProtection: true, allowedHosts, allowedOrigins });
        res.on("close", () => { void transport.close(); void mcp.close(); });
        await mcp.connect(transport);
        await transport.handleRequest(req, res, body);
        return;
      }

      if (!webLimiter.take(ip)) return send(res, 429, { error: "Rate limit exceeded" });

      // ---- OAuth 2.1 authorization server + RFC 9728 resource metadata (oauth mode only) ----
      if (oauth) {
        const p = url.pathname;
        if (req.method === "GET" && (p === "/.well-known/oauth-protected-resource" || p === "/.well-known/oauth-protected-resource/mcp"))
          return sendPublic(res, 200, oauth.protectedResourceMetadata());
        if (req.method === "GET" && p === "/.well-known/oauth-authorization-server") return sendPublic(res, 200, oauth.authorizationServerMetadata());
        if (p === "/oauth/register" && req.method === "POST") { const out = oauth.register(await readJson(req)); return send(res, out.status, out.body); }
        if (p === "/oauth/token" && req.method === "POST") { const out = oauth.token(new URLSearchParams(await readText(req)), header(req, "authorization")); return send(res, out.status, out.body); }
        if (p === "/oauth/revoke" && req.method === "POST") { const out = oauth.revoke(new URLSearchParams(await readText(req)), header(req, "authorization")); return send(res, out.status, out.body); }
        if (p === "/oauth/authorize" && req.method === "GET") {
          const r = oauth.beginAuthorization(url.searchParams);
          if (!r.ok) {
            if (r.redirect) { res.statusCode = 302; res.setHeader("Location", r.redirect); return res.end(); }
            return html(res, 400, page("Authorization request refused", `<p class="state">${esc(r.error.error)}</p><p>${esc(r.error.description)}</p>`, AUTH_BANNER));
          }
          return html(res, 200, consentPage(r.pending, paymentExecutionEnabled), formActionFor(r.pending.redirectUri));
        }
        if (p === "/oauth/authorize" && req.method === "POST") {
          if (!sameOriginStrict(req, allowedOrigins)) return send(res, 403, { error: "Origin not allowed" });
          const form = new URLSearchParams(await readText(req));
          const pend = oauth.getPending(form.get("request_id"));
          const out = oauth.completeAuthorization(form);
          if ("redirect" in out) { res.statusCode = 303; res.setHeader("Location", out.redirect); return res.end(); }
          if (pend && out.error.status === 401) return html(res, 401, consentPage(pend, paymentExecutionEnabled, "Owner key not recognized."), formActionFor(pend.redirectUri));
          return html(res, out.error.status, page("Authorization failed", `<p class="state">${esc(out.error.error)}</p><p>${esc(out.error.description)}</p>`, AUTH_BANNER));
        }
      }
      // Without payment execution (public deployments), no owner, authorization, return or mock-payment route exists.
      if (!paymentExecutionEnabled && /^\/(owner|authorize|paypal|mock-paypal|billing|handoff)(\/|$)/.test(url.pathname)) return send(res, 403, { error: "Payment routes are disabled on this deployment" });

      // ---- Owner API (human-held owner key; AI client tokens cannot reach this) ----
      if (url.pathname === "/owner/mandates" && req.method === "POST") {
        if (!sameOrigin(req, allowedOrigins)) return send(res, 403, { error: "Origin not allowed" });
        const userId = cfg.auth.verifyOwnerKey(header(req, "x-owner-key"));
        if (!userId) return send(res, 401, { error: "Owner key required" });
        if (!paymentExecutionEnabled) return send(res, 403, { error: "Payment execution disabled on this deployment" });
        const b = ((await readJson(req)) ?? {}) as Record<string, unknown>;
        let m;
        try { m = gateway.mandates.create({ userId, productIdentity: b.productIdentity as never, currency: String(b.currency), maximumTotalMinor: Number(b.maximumTotalMinor),
          maximumQuantity: b.maximumQuantity === undefined ? 1 : Number(b.maximumQuantity), maximumTransactions: b.maximumTransactions === undefined ? 1 : Number(b.maximumTransactions),
          ttlSeconds: b.ttlSeconds === undefined ? 3600 : Number(b.ttlSeconds), allowedMerchantIds: Array.isArray(b.allowedMerchantIds) ? b.allowedMerchantIds.map(String) : null, createdVia: "OWNER_API",
          autoUse: b.autoUse === undefined ? false : (b.autoUse as boolean) }); }
        catch (e) { return send(res, 400, { error: e instanceof Error ? e.message : "Invalid mandate" }); }
        gateway.audit.append(m.mandateId, userId, "MANDATE_CREATED_BY_OWNER_API", { maximumTotalMinor: m.maximumTotalMinor, autoUse: m.autoUse, actor: `OWNER_SESSION:${userId}` });
        return send(res, 201, m);
      }
      const revoke = /^\/owner\/mandates\/(mdt_[0-9a-f-]{36})\/revoke$/.exec(url.pathname);
      if (revoke && req.method === "POST") {
        if (!sameOrigin(req, allowedOrigins)) return send(res, 403, { error: "Origin not allowed" });
        const userId = cfg.auth.verifyOwnerKey(header(req, "x-owner-key"));
        if (!userId) return send(res, 401, { error: "Owner key required" });
        const m = gateway.mandates.revoke(revoke[1]!, userId);
        gateway.audit.append(m.mandateId, userId, "MANDATE_REVOKED", {});
        return send(res, 200, m);
      }

      const rec = /^\/owner\/checkouts\/(cs_[0-9a-f-]{36})\/reconcile$/.exec(url.pathname);
      if (rec && req.method === "POST") {
        if (!sameOrigin(req, allowedOrigins)) return send(res, 403, { error: "Origin not allowed" });
        const userId = cfg.auth.verifyOwnerKey(header(req, "x-owner-key"));
        if (!userId) return send(res, 401, { error: "Owner key required" });
        const cs = await gateway.reconcile(userId, rec[1]!);
        return send(res, 200, gateway.getCheckoutStatus(userId, cs.checkoutSessionId));
      }

      const cancel = /^\/owner\/checkouts\/(cs_[0-9a-f-]{36})\/cancel$/.exec(url.pathname);
      if (cancel && req.method === "POST") {
        if (!sameOrigin(req, allowedOrigins)) return send(res, 403, { error: "Origin not allowed" });
        const userId = cfg.auth.verifyOwnerKey(header(req, "x-owner-key"));
        if (!userId) return send(res, 401, { error: "Owner key required" });
        const out = await gateway.cancelCheckoutAsOwner(userId, cancel[1]!);
        return send(res, out.cancelled ? 200 : 409, { cancelled: out.cancelled, reason: out.reason, status: gateway.getCheckoutStatus(userId, out.checkout.checkoutSessionId) });
      }

      // ---- Owner authorization page for a prepared checkout ----
      const auth = /^\/authorize\/(cs_[0-9a-f-]{36})$/.exec(url.pathname);
      if (auth) {
        const csId = auth[1]!;
        if (req.method === "GET") return html(res, 200, envPage("Authorize a DIAPORIA checkout", `<p>An AI assistant prepared checkout <code>${esc(csId)}</code>. Enter your owner key to review it.
          The AI client cannot do this step: its token cannot create spending authority.</p>
          <form method="post"><input type="hidden" name="action" value="review"><label>Owner key<input name="ownerKey" type="password" autocomplete="off" required></label><p><button>Review checkout</button></p></form>`));
        if (req.method !== "POST" || !sameOriginForm(req, allowedOrigins)) return send(res, 403, { error: "Forbidden" });
        const form = new URLSearchParams(await readText(req));
        if (form.get("action") === "review") {
          const userId = cfg.auth.verifyOwnerKey(form.get("ownerKey") ?? undefined);
          if (!userId) return html(res, 401, envPage("Not authorized", "<p>Owner key not recognized.</p>"));
          let cs;
          try { cs = gateway.sessions.getCheckout(csId, userId); } catch { return html(res, 404, envPage("Not found", "<p>Checkout not found.</p>")); }
          const sid = randomBytes(24).toString("base64url"); const csrf = randomBytes(24).toString("base64url");
          ownerSessions.set(sid, { userId, csrf, expiresAt: now() + 10 * 60_000, csId, summaryHash: cs.summaryHash });
          for (const [k, v] of ownerSessions) if (v.expiresAt <= now()) ownerSessions.delete(k);
          res.setHeader("Set-Cookie", `dac_owner=${sid}; HttpOnly; SameSite=Strict; Path=/authorize; Max-Age=600${base.protocol === "https:" ? "; Secure" : ""}`);
          return html(res, 200, envPage("Review and set your spending limit", reviewBody(cs, csrf, payments.name, cs.mandateId ? gateway.mandates.get(cs.mandateId, userId) : null)));
        }
        if (form.get("action") === "cancel") {
          const sid = /(?:^|;\s*)dac_owner=([A-Za-z0-9_-]+)/.exec(req.headers.cookie ?? "")?.[1];
          const sess = sid ? ownerSessions.get(sid) : undefined;
          if (!sess || sess.expiresAt <= now() || form.get("csrf") !== sess.csrf) return html(res, 401, envPage("Session expired", "<p>Review the checkout again.</p>"));
          // IR-09 (WP-4): a session opened for another checkout is refused and NOT consumed.
          if (sess.csId !== csId) return html(res, 403, envPage("Different checkout", "<p>You reviewed a different checkout. Open this checkout's own link and review it first. Nothing was changed.</p>"));
          ownerSessions.delete(sid!);
          let out;
          try { out = await gateway.cancelCheckoutAsOwner(sess.userId, csId); } catch { return html(res, 404, envPage("Not found", "<p>Checkout not found.</p>")); }
          return html(res, out.cancelled ? 200 : 409, envPage(out.cancelled ? "Checkout cancelled" : "Checkout not cancelled", out.cancelled
            ? "<p>Nothing was paid. Any reserved spending limit was released. You can return to your AI assistant.</p>"
            : `<p class="state">${esc(out.reason)}</p><p>The checkout was left unchanged because cancelling now could race a payment. Ask your AI assistant to check the checkout status.</p>`));
        }
        if (form.get("action") === "authorize") {
          const sid = /(?:^|;\s*)dac_owner=([A-Za-z0-9_-]+)/.exec(req.headers.cookie ?? "")?.[1];
          const sess = sid ? ownerSessions.get(sid) : undefined;
          if (!sess || sess.expiresAt <= now() || form.get("csrf") !== sess.csrf) return html(res, 401, envPage("Session expired", "<p>Review the checkout again.</p>"));
          // IR-09 (WP-4): a session opened for another checkout is refused and NOT consumed; no authority is created.
          if (sess.csId !== csId) return html(res, 403, envPage("Different checkout", "<p>You reviewed a different checkout. Open this checkout's own link and review it first. No spending limit was created.</p>"));
          ownerSessions.delete(sid!);
          let cs;
          try { cs = gateway.sessions.getCheckout(csId, sess.userId); } catch { return html(res, 404, envPage("Not found", "<p>Checkout not found.</p>")); }
          // The human must have seen exactly this summary.
          if (cs.summaryHash !== sess.summaryHash) return html(res, 409, envPage("Checkout changed", "<p>The checkout changed since you reviewed it. Review it again. No spending limit was created.</p>"));
          let maximum: number;
          try { maximum = parseDecimalToMinor(form.get("maximum") ?? "", cs.currency); } catch { return html(res, 400, envPage("Invalid amount", "<p>Enter an amount like 60.00.</p>")); }
          let out;
          try { out = await gateway.authorizeCheckoutAsOwner(sess.userId, csId, maximum); }
          catch (e) {
            if (e instanceof CommerceError && e.code === "INVALID_STATE") return html(res, 409, envPage("Already authorized", `<p class="state">${esc(gateway.sessions.getCheckout(csId, sess.userId).state)}</p><p>This checkout was already authorized or can no longer be paid. No new spending limit was created. Ask your AI assistant to check the checkout status.</p>`));
            throw e;
          }
          if (out.decision.allowed && out.checkout.approvalUrl) { res.statusCode = 303; res.setHeader("Location", out.checkout.approvalUrl); return res.end(); }
          return html(res, 403, envPage("Checkout not authorized", `<p class="state">${esc(out.decision.code)}</p><p>${esc(out.decision.detail)}</p><p>No payment was started.</p>`));
        }
        return send(res, 400, { error: "Unknown action" });
      }

      // ---- Managed subscription billing (owner subscribe/cancel, buyer return, verified PayPal billing webhook) ----
      if (await handleSubscriptionRoutes(req, res, url, { billing: cfg.service?.billing ?? null, auth: cfg.auth, allowedOrigins, send, html, readJson, readText, header, sameOrigin })) return;

      // ---- Mock service-billing webhook (simulation only; HMAC-signed) ----
      if (url.pathname === "/billing/webhook/mock" && req.method === "POST") {
        const billing = cfg.service?.billing as { handleWebhook?: (raw: string, sig: string | undefined) => { accepted: boolean; outcome: string } } | null | undefined;
        if (!billing?.handleWebhook) return send(res, 503, { outcome: "BILLING_WEBHOOKS_NOT_CONFIGURED" });
        const out = billing.handleWebhook(await readText(req), header(req, "x-mock-billing-signature"));
        return send(res, out.accepted ? 200 : 401, { outcome: out.outcome });
      }

      // ---- PayPal webhook (signature-verified; only triggers an authoritative capture read) ----
      if (url.pathname === "/paypal/webhook") {
        if (req.method !== "POST") return send(res, 405, { error: "Method not allowed" });
        const raw = await readText(req);
        const out = await gateway.handlePayPalWebhook({
          transmissionId: header(req, "paypal-transmission-id"), transmissionTime: header(req, "paypal-transmission-time"),
          transmissionSig: header(req, "paypal-transmission-sig"), certUrl: header(req, "paypal-cert-url"), authAlgo: header(req, "paypal-auth-algo"),
        }, raw);
        return send(res, out.http, { outcome: out.outcome });
      }

      // ---- PayPal (or mock) buyer return / cancel ----
      if ((url.pathname === "/paypal/return" || url.pathname === "/paypal/cancel") && req.method === "GET") {
        const csId = url.searchParams.get("checkout") ?? ""; const orderId = url.searchParams.get("token") ?? "";
        if (!/^cs_[0-9a-f-]{36}$/.test(csId) || !/^[A-Z0-9]{8,40}$/.test(orderId)) return html(res, 400, envPage("Invalid return", "<p>Malformed return parameters.</p>"));
        try {
          const cs = url.pathname === "/paypal/return" ? await gateway.handleBuyerReturn(csId, orderId) : await gateway.handleBuyerCancel(csId, orderId);
          return html(res, 200, envPage("Payment status", `<p>Server-verified state: <span class="state">${esc(cs.state)}</span></p>
            ${cs.failureCode ? `<p class="muted">${esc(cs.failureCode)}: ${esc(cs.failureReason)}</p>` : ""}
            <p>Return to your AI assistant and ask it to check the checkout status. This page does not itself prove payment.</p>
            <p class="muted">Even a COMPLETED payment is only the payment step: no merchant order confirmation or shipment is verified by DIAPORIA.</p>`));
        } catch (e) {
          if (e instanceof NotFoundError) return html(res, 404, envPage("Not found", "<p>Unknown checkout.</p>"));
          throw e;
        }
      }

      // ---- Mock PayPal hosted page (only when the mock provider is active) ----
      // IR-01 (WP-1). The mock buyer step stands in for PayPal's own buyer login, so it needs a human credential:
      // the owner key of the checkout's user, on a strict same-origin browser POST. An AI client holding only its
      // MCP token cannot approve. The PayPal Sandbox path is unchanged (PayPal's buyer login is the human step).
      const mock = /^\/mock-paypal\/checkout\/(MOCK[A-F0-9]{16})(?:\/(approve|cancel))?$/.exec(url.pathname);
      if (mock && mockPayPal) {
        const orderId = mock[1]!; const order = mockPayPal.describe(orderId);
        if (!order) return html(res, 404, page("Unknown order", "<p>No such mock order.</p>", "MOCK PayPal"));
        const ownerField = '<label>Owner key (MOCK buyer login)<input name="owner_key" type="password" autocomplete="off" required></label>';
        if (!mock[2] && req.method === "GET") return html(res, 200, page("MOCK PayPal checkout", `<p>This is a local <b>mock</b> of PayPal's hosted approval page. No PayPal API is called.</p>
          <table><tr><td>Order</td><td>${esc(orderId)}</td></tr><tr><td>Amount</td><td>${esc(order.amount ? money(order.amount.amountMinor, order.amount.currency) : "?")}</td></tr></table>
          <p class="muted">MOCK only: the owner key stands in for the buyer's own PayPal login. The AI assistant cannot do this step.</p>
          <form method="post" action="/mock-paypal/checkout/${esc(orderId)}/approve">${ownerField}<p><button>Approve (mock buyer)</button></p></form>
          <form method="post" action="/mock-paypal/checkout/${esc(orderId)}/cancel">${ownerField}<p><button class="secondary">Cancel</button></p></form>`, "MOCK PayPal — not real, not Sandbox"));
        if (mock[2] && req.method === "POST") {
          if (!sameOriginStrict(req, allowedOrigins)) return send(res, 403, { error: "Origin not allowed" });
          const ownerUserId = cfg.auth.verifyOwnerKey(new URLSearchParams(await readText(req)).get("owner_key") ?? undefined);
          if (!ownerUserId) return html(res, 401, page("Not authorized", "<p>Owner key required (MOCK buyer login). Nothing was approved.</p>", "MOCK PayPal — not real, not Sandbox"));
          // The mock order carries its checkout id (PayPal custom_id); the owner must be that checkout's user.
          const row = store.db.prepare("SELECT user_id FROM checkout_sessions WHERE id = ?").get(String(order.customId)) as { user_id: string } | undefined;
          const checkoutUserId = row ? String(row.user_id) : null;
          if (checkoutUserId !== ownerUserId) return html(res, 403, page("Not authorized", "<p>This order does not belong to that owner. Nothing was approved.</p>", "MOCK PayPal — not real, not Sandbox"));
          gateway.audit.append(String(order.customId), ownerUserId, mock[2] === "approve" ? "MOCK_BUYER_APPROVED" : "MOCK_BUYER_CANCELLED", { orderId, actor: `OWNER_SESSION:${ownerUserId}` });
          res.statusCode = 303;
          res.setHeader("Location", mock[2] === "approve" ? mockPayPal.buyerApprove(orderId) : mockPayPal.buyerCancel(orderId));
          return res.end();
        }
        return send(res, 405, { error: "Method not allowed" });
      }

      // ---- Browser checkout handoff page (owner-authenticated; separate from the PayPal Sandbox path) ----
      if (handoffRoutes && await handoffRoutes(req, res, url)) return;

      return send(res, 404, { error: "Not found" });
    } catch (e) {
      if (e instanceof BodyTooLarge) return send(res, 413, { error: "Request body too large" });
      if (e instanceof BadJson) return send(res, 400, { error: "Invalid JSON" });
      if (e instanceof CommerceError) return send(res, 400, { error: { code: e.code, message: e.message } });
      if (e instanceof Error && /not found|not revocable/i.test(e.message)) return send(res, 404, { error: "Not found" });
      console.error("[diaporia] unhandled request error:", e instanceof Error ? e.message : "unknown");
      if (!res.headersSent) send(res, 500, { error: "Internal error" });
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.on("close", () => { if (handoffTimer) clearInterval(handoffTimer); void handoff?.shutdown(); store.close(); });
  return { server, gateway, store, auth: cfg.auth, mockPayPal, paymentExecutionEnabled, handoff, oauth };
}

class BodyTooLarge extends Error {}
class BadJson extends Error {}

async function readText(req: IncomingMessage): Promise<string> {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > MAX_BODY_BYTES) throw new BodyTooLarge();
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new BodyTooLarge();
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
async function readJson(req: IncomingMessage): Promise<unknown> {
  const t = await readText(req);
  if (!t) return undefined;
  try { return JSON.parse(t); } catch { throw new BadJson(); }
}
function header(req: IncomingMessage, name: string): string | undefined { const v = req.headers[name]; return Array.isArray(v) ? v[0] : v; }
/**
 * Lenient origin check for header-authenticated API routes (X-Owner-Key / bearer). Non-browser clients
 * (curl, scripts, the owner CLI) send no Origin; a present Origin must be allowed.
 */
function sameOrigin(req: IncomingMessage, allowed: string[]): boolean { const o = req.headers.origin; return o === undefined || allowed.includes(o); }
/**
 * IR-01 (WP-1). Strict check for state-changing BROWSER form routes: a missing Origin is NOT same-origin. Origin
 * must be present and allowed ("null" never is), or, when a browser omits Origin, Sec-Fetch-Site must say
 * same-origin. A cross-site Sec-Fetch-Site always refuses, even next to an allowed Origin.
 */
export function sameOriginStrict(req: IncomingMessage, allowed: string[]): boolean {
  const site = header(req, "sec-fetch-site");
  if (site !== undefined && site !== "same-origin") return false;
  const o = header(req, "origin");
  if (o !== undefined) return o !== "null" && allowed.includes(o);
  return site === "same-origin";
}
/**
 * Browser-form check for the owner review page (/authorize). Refuses any request a browser marks as cross-site
 * (an Origin that is not allowed, or Sec-Fetch-Site other than same-origin). A request with neither header is not
 * a browser request, so an origin check cannot stop it anyway (Origin is forgeable outside a browser); that route
 * is authenticated by the owner key (review) or by the checkout-bound SameSite=Strict session cookie plus CSRF
 * token (authorize, cancel).
 */
export function sameOriginForm(req: IncomingMessage, allowed: string[]): boolean {
  const site = header(req, "sec-fetch-site");
  if (site !== undefined && site !== "same-origin") return false;
  const o = header(req, "origin");
  return o === undefined || (o !== "null" && allowed.includes(o));
}
function securityHeaders(res: ServerResponse) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Cache-Control", "no-store");
}
function send(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(body));
}
type CheckoutView = import("../checkout/CheckoutSessionManager.js").CheckoutSession;
type MandateView = import("../policy/PurchaseMandate.js").PurchaseMandate;
/**
 * Owner review page: everything the human needs to decide, with nothing implied. Unknown charges are
 * listed as unknown (never zero), the payee is named with its provenance, and the payment
 * environment is explicit. Approving here creates a DIAPORIA spending limit; it moves no money.
 */
export function reviewBody(cs: CheckoutView, csrf: string, provider: string, mandate: MandateView | null): string {
  const c = cs.cost; const cur = cs.currency;
  const env = provider === "PAYPAL_SANDBOX" ? "PayPal Sandbox (test money only)" : "MOCK (simulated; no PayPal call, no money)";
  const mi = cs.summary.merchantIdentity;
  const payee = mi
    ? `${esc(mi.verifiedLegalName)} · payee <code>${esc(mi.intendedPayeeId)}</code>${mi.payeeRelationship === "DIAPORIA_SANDBOX_PLATFORM_ACCOUNT"
      ? ' <span class="muted">(DIAPORIA\'s own Sandbox platform account receives this test payment, not the merchant)</span>' : ' <span class="muted">(merchant-attested payee)</span>'}`
    : '<span class="state">UNKNOWN</span> <span class="muted">(no verified merchant identity; payment will not start)</span>';
  const unknown = c.unknownComponents.length ? `<span class="state">${esc(c.unknownComponents.join(", "))}</span> <span class="muted">(unknown is not zero; the total cannot be verified)</span>` : "none";
  const limit = mandate
    ? `${esc(money(mandate.maximumTotalMinor, mandate.currency))} (${esc(mandate.authorizationStatus)}, expires ${esc(mandate.expiresAt)}; reserved ${esc(money(mandate.reservedMinor, mandate.currency))}, used ${esc(money(mandate.consumedMinor, mandate.currency))})`
    : "none yet: you set it below";
  return `<table>
    <tr><td>Payment environment</td><td data-field="payment-environment"><b>${esc(env)}</b></td></tr>
    <tr><td>Product</td><td>${esc(`${cs.identity.brand} ${cs.identity.model} · ${cs.identity.variant ?? "—"} · ${cs.identity.condition}${cs.identity.sku ? ` · SKU ${cs.identity.sku}` : ""}`)}</td></tr>
    <tr><td>Merchant</td><td>${esc(cs.summary.merchant.name)} (${esc(cs.summary.merchant.domain)}) <span class="muted">(fictional demo merchant)</span></td></tr>
    <tr><td>Funds go to</td><td data-field="payee">${payee}</td></tr>
    <tr><td>Quantity</td><td>${cs.quantity}</td></tr><tr><td>Item</td><td>${esc(money(c.itemMinor, cur))}</td></tr>
    <tr><td>Shipping</td><td>${esc(money(c.shippingMinor, cur))}</td></tr><tr><td>Tax</td><td>${esc(money(c.taxMinor, cur))}</td></tr>
    <tr><td>Fees</td><td>${esc(money(c.feesMinor, cur))}</td></tr><tr><td>Discount</td><td>${esc(money(c.discountMinor, cur))}</td></tr>
    <tr><td>Unknown charges</td><td data-field="unknown-charges">${unknown}</td></tr>
    <tr><td><b>Total payable</b></td><td data-field="total"><b>${esc(money(cs.totalMinor, cur))}</b></td></tr>
    <tr><td>AI assistant's requested maximum</td><td>${esc(money(cs.clientMaxMinor, cur))} <span class="muted">(narrows only; grants nothing)</span></td></tr>
    <tr><td>Your current spending limit</td><td data-field="spending-limit">${limit}</td></tr>
    <tr><td>Quote expires</td><td>${esc(new Date(cs.expiresAt).toISOString())}</td></tr>
    <tr><td>State</td><td class="state">${esc(cs.state)}</td></tr></table>
    <form method="post"><input type="hidden" name="action" value="authorize"><input type="hidden" name="csrf" value="${esc(csrf)}">
    <label>Maximum you authorize (${esc(cur)})<input name="maximum" inputmode="decimal" required placeholder="60.00"></label>
    <p class="muted">This is a DIAPORIA spending limit for this one checkout. It is not a PayPal-enforced cap; PayPal will still ask you to approve. Approving moves no money by itself.</p>
    <p><button>Authorize and continue to payment approval</button></p></form>
    <form method="post"><input type="hidden" name="action" value="cancel"><input type="hidden" name="csrf" value="${esc(csrf)}">
    <p><button class="secondary">Cancel this checkout</button></p></form>
    <p class="muted">Afterwards, return to your AI assistant and ask it for the checkout status. A browser redirect is never proof of payment.</p>`;
}
/** Metadata documents may be fetched cross-origin by browser-based MCP clients. */
function sendPublic(res: ServerResponse, status: number, body: unknown) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  send(res, status, body);
}
const AUTH_BANNER = "Connecting an AI assistant to DIAPORIA. This grants tool access, never spending authority.";
const SCOPE_TEXT: Record<string, string> = {
  [SCOPES.RESEARCH]: "Research products and compare merchant offers (no payment effect)",
  [SCOPES.READ]: "Read checkout status, receipts and usage for your account (read-only)",
  [SCOPES.PREPARE]: "Prepare checkouts for you to approve. It cannot create a spending limit or capture money: you still set the limit and approve the payment yourself.",
};
function consentPage(p: PendingAuthorization, paymentToolsAvailable: boolean, error?: string): string {
  const redirectHost = new URL(p.redirectUri).host;
  const items = p.scopes.map((s) => `<p><label><input type="checkbox" name="scope" value="${esc(s)}" checked style="width:auto"> <code>${esc(s)}</code>: ${esc(SCOPE_TEXT[s] ?? s)}${
    s === SCOPES.PREPARE && !paymentToolsAvailable ? ' <span class="muted">(not offered on this deployment: payment tools are disabled here)</span>' : ""}</label></p>`).join("");
  return page("Allow an AI client to use DIAPORIA?", `${error ? `<p class="state">${esc(error)}</p>` : ""}
    <p>The client <b>${esc(p.clientName)}</b> (self-registered; name not verified) wants to use DIAPORIA on your behalf. After you allow it, your browser returns to <code>${esc(redirectHost)}</code>.</p>
    <form method="post" action="/oauth/authorize"><input type="hidden" name="request_id" value="${esc(p.id)}"><input type="hidden" name="csrf" value="${esc(p.csrf)}">
    ${items}
    <label>Owner key (proves you are the account owner)<input name="owner_key" type="password" autocomplete="off"></label>
    <p class="muted">The client gets a token valid for this server only. Revoke it any time; it never lets the client set a spending limit.</p>
    <p><button name="decision" value="approve">Allow</button> <button class="secondary" name="decision" value="deny">Deny</button></p></form>`, AUTH_BANNER);
}
/** The consent POST redirects to the client's redirect URI, which CSP form-action must allow. */
function formActionFor(redirectUri: string): string { return new URL(redirectUri).origin; }
function html(res: ServerResponse, status: number, body: string, extraFormAction?: string) {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Content-Security-Policy", `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://www.sandbox.paypal.com${extraFormAction ? ` ${extraFormAction}` : ""}; frame-ancestors 'none'; base-uri 'none'`);
  res.end(body);
}
