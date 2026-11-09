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
import { parseDecimalToMinor } from "../domain/money.js";
import { NotFoundError } from "../checkout/CheckoutSessionManager.js";
import { esc, money, page } from "./html.js";
import { RateLimiter } from "./rateLimit.js";

export interface AppConfig {
  host: string;
  port: number;
  /** Externally visible origin, e.g. http://127.0.0.1:8790 */
  baseUrl: string;
  authMode: "dev" | "public-readonly-demo";
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
}

export const MAX_BODY_BYTES = 64 * 1024;
const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\])$/;

export function isLoopbackUrl(u: string): boolean {
  try { return LOOPBACK.test(new URL(u).hostname); } catch { return false; }
}

export interface App { server: Server; gateway: CommerceGateway; store: Store; auth: DevAuth; mockPayPal: MockPayPalProvider | null; paymentExecutionEnabled: boolean }

export function createApp(cfg: AppConfig): App {
  const now = cfg.now ?? Date.now;
  const store = new Store(cfg.dbPath);
  const payments = cfg.payments ? cfg.payments(cfg.baseUrl) : new MockPayPalProvider(cfg.baseUrl);
  const mockPayPal = payments instanceof MockPayPalProvider ? payments : null;
  // Payment flows run only with per-user dev tokens on a loopback-only deployment.
  const paymentExecutionEnabled = cfg.authMode === "dev" && LOOPBACK.test(cfg.host) && isLoopbackUrl(cfg.baseUrl);
  const gateway = new CommerceGateway(store, cfg.research ?? new MockCommerceResearchAdapter(now), payments, { baseUrl: cfg.baseUrl, paymentExecutionEnabled,
    ...(cfg.merchantIdentity ? { merchantIdentity: cfg.merchantIdentity } : {}), sandboxPlatformPayeeId: cfg.sandboxPlatformPayeeId ?? null,
    sandboxPlatformPayeeEmail: cfg.sandboxPlatformPayeeEmail ?? null, webhookVerifier: cfg.webhookVerifier ?? null,
    ...(cfg.readRetry ? { readRetry: cfg.readRetry } : {}) }, now);
  const base = new URL(cfg.baseUrl);
  const allowedHosts = [...new Set([base.host, `127.0.0.1:${cfg.port}`, `localhost:${cfg.port}`])];
  const allowedOrigins = [...new Set([base.origin, `http://127.0.0.1:${cfg.port}`, `http://localhost:${cfg.port}`])];
  const mcpLimiter = new RateLimiter(120, 60_000);
  const webLimiter = new RateLimiter(30, 60_000);
  const ownerSessions = new Map<string, { userId: string; csrf: string; expiresAt: number }>();

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
        else principal = cfg.auth.verifyBearer(req.headers.authorization);
        if (!principal) { res.setHeader("WWW-Authenticate", 'Bearer realm="diaporia-dev", error="invalid_token"'); return send(res, 401, { error: "Missing or invalid bearer token" }); }
        if (!mcpLimiter.take(`${principal.tokenFingerprint}|${ip}`)) return send(res, 429, { error: "Rate limit exceeded" });
        const body = await readJson(req);
        const mcp = createCommerceMcpServer(gateway, principal, { exposePaymentTools: cfg.authMode === "dev" && principal.scopes.has(SCOPES.PREPARE) });
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, enableDnsRebindingProtection: true, allowedHosts, allowedOrigins });
        res.on("close", () => { void transport.close(); void mcp.close(); });
        await mcp.connect(transport);
        await transport.handleRequest(req, res, body);
        return;
      }

      if (!webLimiter.take(ip)) return send(res, 429, { error: "Rate limit exceeded" });
      // Without payment execution (public deployments), no owner, authorization, return or mock-payment route exists.
      if (!paymentExecutionEnabled && /^\/(owner|authorize|paypal|mock-paypal)(\/|$)/.test(url.pathname)) return send(res, 403, { error: "Payment routes are disabled on this deployment" });

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
          ttlSeconds: b.ttlSeconds === undefined ? 3600 : Number(b.ttlSeconds), allowedMerchantIds: Array.isArray(b.allowedMerchantIds) ? b.allowedMerchantIds.map(String) : null, createdVia: "OWNER_API" }); }
        catch (e) { return send(res, 400, { error: e instanceof Error ? e.message : "Invalid mandate" }); }
        gateway.audit.append(m.mandateId, userId, "MANDATE_CREATED_BY_OWNER_API", { maximumTotalMinor: m.maximumTotalMinor });
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

      // ---- Owner authorization page for a prepared checkout ----
      const auth = /^\/authorize\/(cs_[0-9a-f-]{36})$/.exec(url.pathname);
      if (auth) {
        const csId = auth[1]!;
        if (req.method === "GET") return html(res, 200, page("Authorize a DIAPORIA checkout", `<p>An AI assistant prepared checkout <code>${esc(csId)}</code>. Enter your owner key to review it.
          The AI client cannot do this step: its token cannot create spending authority.</p>
          <form method="post"><input type="hidden" name="action" value="review"><label>Owner key<input name="ownerKey" type="password" autocomplete="off" required></label><p><button>Review checkout</button></p></form>`));
        if (req.method !== "POST" || !sameOrigin(req, allowedOrigins)) return send(res, 403, { error: "Forbidden" });
        const form = new URLSearchParams(await readText(req));
        if (form.get("action") === "review") {
          const userId = cfg.auth.verifyOwnerKey(form.get("ownerKey") ?? undefined);
          if (!userId) return html(res, 401, page("Not authorized", "<p>Owner key not recognized.</p>"));
          let cs;
          try { cs = gateway.sessions.getCheckout(csId, userId); } catch { return html(res, 404, page("Not found", "<p>Checkout not found.</p>")); }
          const sid = randomBytes(24).toString("base64url"); const csrf = randomBytes(24).toString("base64url");
          ownerSessions.set(sid, { userId, csrf, expiresAt: now() + 10 * 60_000 });
          res.setHeader("Set-Cookie", `dac_owner=${sid}; HttpOnly; SameSite=Strict; Path=/authorize; Max-Age=600${base.protocol === "https:" ? "; Secure" : ""}`);
          const c = cs.cost;
          return html(res, 200, page("Review and set your spending limit", `<table>
            <tr><td>Product</td><td>${esc(`${cs.identity.brand} ${cs.identity.model} · ${cs.identity.variant ?? "—"} · ${cs.identity.condition}`)}</td></tr>
            <tr><td>Merchant</td><td>${esc(cs.summary.merchant.name)} <span class="muted">(fictional demo merchant)</span></td></tr>
            <tr><td>Quantity</td><td>${cs.quantity}</td></tr><tr><td>Item</td><td>${esc(money(c.itemMinor, cs.currency))}</td></tr>
            <tr><td>Shipping</td><td>${esc(money(c.shippingMinor, cs.currency))}</td></tr><tr><td>Tax</td><td>${esc(money(c.taxMinor, cs.currency))}</td></tr>
            <tr><td><b>Total</b></td><td><b>${esc(money(cs.totalMinor, cs.currency))}</b></td></tr><tr><td>State</td><td class="state">${esc(cs.state)}</td></tr></table>
            <form method="post"><input type="hidden" name="action" value="authorize"><input type="hidden" name="csrf" value="${esc(csrf)}">
            <label>Maximum you authorize (${esc(cs.currency)})<input name="maximum" inputmode="decimal" required placeholder="60.00"></label>
            <p class="muted">This is a DIAPORIA spending limit for this one checkout. It is not a PayPal-enforced cap; PayPal will still ask you to approve.</p>
            <p><button>Authorize and continue to PayPal</button></p></form>`));
        }
        if (form.get("action") === "authorize") {
          const sid = /(?:^|;\s*)dac_owner=([A-Za-z0-9_-]+)/.exec(req.headers.cookie ?? "")?.[1];
          const sess = sid ? ownerSessions.get(sid) : undefined;
          if (!sess || sess.expiresAt <= now() || form.get("csrf") !== sess.csrf) return html(res, 401, page("Session expired", "<p>Review the checkout again.</p>"));
          ownerSessions.delete(sid!);
          let cs;
          try { cs = gateway.sessions.getCheckout(csId, sess.userId); } catch { return html(res, 404, page("Not found", "<p>Checkout not found.</p>")); }
          let maximum: number;
          try { maximum = parseDecimalToMinor(form.get("maximum") ?? "", cs.currency); } catch { return html(res, 400, page("Invalid amount", "<p>Enter an amount like 60.00.</p>")); }
          const out = await gateway.authorizeCheckoutAsOwner(sess.userId, csId, maximum);
          if (out.decision.allowed && out.checkout.approvalUrl) { res.statusCode = 303; res.setHeader("Location", out.checkout.approvalUrl); return res.end(); }
          return html(res, 403, page("Checkout not authorized", `<p class="state">${esc(out.decision.code)}</p><p>${esc(out.decision.detail)}</p><p>No payment was started.</p>`));
        }
        return send(res, 400, { error: "Unknown action" });
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
        if (!/^cs_[0-9a-f-]{36}$/.test(csId) || !/^[A-Z0-9]{8,40}$/.test(orderId)) return html(res, 400, page("Invalid return", "<p>Malformed return parameters.</p>"));
        try {
          const cs = url.pathname === "/paypal/return" ? await gateway.handleBuyerReturn(csId, orderId) : await gateway.handleBuyerCancel(csId, orderId);
          return html(res, 200, page("Payment status", `<p>Server-verified state: <span class="state">${esc(cs.state)}</span></p>
            ${cs.failureCode ? `<p class="muted">${esc(cs.failureCode)}: ${esc(cs.failureReason)}</p>` : ""}
            <p>Return to your AI assistant and ask it to check the checkout status. This page does not itself prove payment.</p>`));
        } catch (e) {
          if (e instanceof NotFoundError) return html(res, 404, page("Not found", "<p>Unknown checkout.</p>"));
          throw e;
        }
      }

      // ---- Mock PayPal hosted page (only when the mock provider is active) ----
      const mock = /^\/mock-paypal\/checkout\/(MOCK[A-F0-9]{16})(?:\/(approve|cancel))?$/.exec(url.pathname);
      if (mock && mockPayPal) {
        const orderId = mock[1]!; const order = mockPayPal.describe(orderId);
        if (!order) return html(res, 404, page("Unknown order", "<p>No such mock order.</p>", "MOCK PayPal"));
        if (!mock[2] && req.method === "GET") return html(res, 200, page("MOCK PayPal checkout", `<p>This is a local <b>mock</b> of PayPal's hosted approval page. No PayPal API is called.</p>
          <table><tr><td>Order</td><td>${esc(orderId)}</td></tr><tr><td>Amount</td><td>${esc(order.amount ? money(order.amount.amountMinor, order.amount.currency) : "?")}</td></tr></table>
          <form method="post" action="/mock-paypal/checkout/${esc(orderId)}/approve" style="display:inline"><button>Approve (mock buyer)</button></form>
          <form method="post" action="/mock-paypal/checkout/${esc(orderId)}/cancel" style="display:inline"><button class="secondary">Cancel</button></form>`, "MOCK PayPal — not real, not Sandbox"));
        if (mock[2] && req.method === "POST" && sameOrigin(req, allowedOrigins)) {
          res.statusCode = 303;
          res.setHeader("Location", mock[2] === "approve" ? mockPayPal.buyerApprove(orderId) : mockPayPal.buyerCancel(orderId));
          return res.end();
        }
        return send(res, 405, { error: "Method not allowed" });
      }

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
  server.on("close", () => store.close());
  return { server, gateway, store, auth: cfg.auth, mockPayPal, paymentExecutionEnabled };
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
function sameOrigin(req: IncomingMessage, allowed: string[]): boolean { const o = req.headers.origin; return o === undefined || allowed.includes(o); }
function securityHeaders(res: ServerResponse) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store");
}
function send(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(body));
}
function html(res: ServerResponse, status: number, body: string) {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://www.sandbox.paypal.com; frame-ancestors 'none'; base-uri 'none'");
  res.end(body);
}
