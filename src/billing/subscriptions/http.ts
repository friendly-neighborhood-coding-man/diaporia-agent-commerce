import type { IncomingMessage, ServerResponse } from "node:http";
import type { DevAuth } from "../../auth/devAuth.js";
import { esc, page } from "../../http/html.js";
import { ProviderError, ProviderTimeoutError } from "../../payment/PaymentProvider.js";
import { ManagedSubscriptionBilling, SubscriptionError } from "./ManagedSubscriptionBilling.js";

/**
 * HTTP surface of managed subscription billing. Subscribing and cancelling are OWNER actions (human-held
 * owner key); AI client tokens cannot reach them, and no MCP tool can subscribe, cancel or charge.
 * Server.ts only delegates here; the merchandise checkout routes are untouched.
 */
export interface SubscriptionRouteContext {
  billing: unknown;
  auth: DevAuth;
  allowedOrigins: string[];
  send(res: ServerResponse, status: number, body: unknown): void;
  html(res: ServerResponse, status: number, body: string): void;
  readJson(req: IncomingMessage): Promise<unknown>;
  header(req: IncomingMessage, name: string): string | undefined;
  sameOrigin(req: IncomingMessage, allowed: string[]): boolean;
  readText(req: IncomingMessage): Promise<string>;
}

const SUB = "(sub_[0-9a-f-]{36})";

export async function handleSubscriptionRoutes(req: IncomingMessage, res: ServerResponse, url: URL, c: SubscriptionRouteContext): Promise<boolean> {
  const p = url.pathname;
  const ours = p === "/billing/plans" || p.startsWith("/owner/billing/") || p === "/owner/billing" || p.startsWith("/billing/subscription/") || p === "/billing/paypal/webhook";
  if (!ours) return false;
  const billing = c.billing instanceof ManagedSubscriptionBilling ? c.billing : null;
  if (!billing) { c.send(res, 404, { error: "Subscription billing is not configured (community mode has no DIAPORIA billing)" }); return true; }

  const owner = (): string | null => {
    if (!c.sameOrigin(req, c.allowedOrigins)) { c.send(res, 403, { error: "Origin not allowed" }); return null; }
    const userId = c.auth.verifyOwnerKey(c.header(req, "x-owner-key"));
    if (!userId) { c.send(res, 401, { error: "Owner key required" }); return null; }
    return userId;
  };
  const fail = (e: unknown) => {
    if (e instanceof SubscriptionError) return c.send(res, e.code === "NOT_FOUND" ? 404 : e.code === "PROVIDER_UNCERTAIN" ? 503 : 409, { error: e.code, message: e.message });
    if (e instanceof ProviderTimeoutError || e instanceof ProviderError) return c.send(res, 503, { error: "BILLING_PROVIDER_UNAVAILABLE", message: "Billing provider did not answer; nothing was assumed." });
    throw e;
  };

  if (p === "/billing/plans" && req.method === "GET") { c.send(res, 200, { plans: billing.listPlans(), environment: billing.provider.name }); return true; }

  if (p === "/owner/billing/subscriptions" && req.method === "POST") {
    const userId = owner(); if (!userId) return true;
    const b = ((await c.readJson(req)) ?? {}) as Record<string, unknown>;
    try {
      const out = await billing.subscribe(userId, String(b.planKey ?? ""), String(b.acceptTermsDigest ?? ""));
      c.send(res, 201, { subscriptionId: out.subscription.id, state: out.subscription.state, approvalUrl: out.approvalUrl, environment: billing.provider.name,
        note: "Approve on PayPal. DIAPORIA treats the subscription as active only after it reads ACTIVE and a paid period from PayPal itself." });
    } catch (e) { fail(e); }
    return true;
  }
  if (p === "/owner/billing/subscriptions" && req.method === "GET") {
    const userId = owner(); if (!userId) return true;
    c.send(res, 200, { subscriptions: billing.forUser(userId).map((s) => ({ id: s.id, state: s.state, planKey: s.planKey, termsDigest: s.termsDigest, holdReason: s.holdReason })),
      authorization: await billing.getAuthorization(userId), statement: billing.statement(userId) });
    return true;
  }
  const act = new RegExp(`^/owner/billing/subscriptions/${SUB}/(refresh|cancel)$`).exec(p);
  if (act && req.method === "POST") {
    const userId = owner(); if (!userId) return true;
    try {
      const sub = billing.byId(act[1]!);
      if (!sub || sub.userId !== userId) throw new SubscriptionError("NOT_FOUND", "Unknown subscription");
      const out = act[2] === "refresh" ? await billing.refresh(sub.id, "STATUS_CHECK") : await billing.cancel(userId, sub.id, "Cancelled by subscriber");
      c.send(res, 200, { subscriptionId: out.id, state: out.state, holdReason: out.holdReason, lastError: out.lastError, authorization: await billing.getAuthorization(userId) });
    } catch (e) { fail(e); }
    return true;
  }

  if (p === "/billing/subscription/return" && req.method === "GET") {
    const id = url.searchParams.get("subscription") ?? "";
    const ppId = url.searchParams.get("subscription_id");
    if (!/^sub_[0-9a-f-]{36}$/.test(id) || (ppId !== null && !/^I-[A-Z0-9]{6,40}$/.test(ppId))) { c.html(res, 400, page("Invalid return", "<p>Malformed return parameters.</p>")); return true; }
    try {
      const sub = await billing.handleBuyerReturn(id, ppId);
      const ent = billing.entitlementFor(sub.userId);
      c.html(res, 200, page("Subscription status", `<p>Server-verified subscription state: <span class="state">${esc(sub.state)}</span></p>
        <p>Managed usage entitled now: <b>${ent.entitled ? "yes" : "no"}</b>${ent.reason ? ` <span class="muted">(${esc(ent.reason)})</span>` : ""}</p>
        <p class="muted">This page was produced by DIAPORIA reading PayPal directly. Returning here does not by itself activate anything.</p>`));
    } catch (e) {
      if (e instanceof SubscriptionError) { c.html(res, e.code === "NOT_FOUND" ? 404 : 400, page("Not verified", `<p>${esc(e.message)}</p>`)); return true; }
      c.html(res, 503, page("Status unknown", "<p>PayPal could not be reached. The subscription is not treated as active. Try again later.</p>"));
    }
    return true;
  }
  if (p === "/billing/subscription/cancel" && req.method === "GET") {
    c.html(res, 200, page("Subscription not started", "<p>You left PayPal without approving. Nothing was activated and nothing will be charged.</p>"));
    return true;
  }

  if (p === "/billing/paypal/webhook") {
    if (req.method !== "POST") { c.send(res, 405, { error: "Method not allowed" }); return true; }
    const raw = await c.readText(req);
    const out = await billing.handlePayPalWebhook({
      transmissionId: c.header(req, "paypal-transmission-id"), transmissionTime: c.header(req, "paypal-transmission-time"),
      transmissionSig: c.header(req, "paypal-transmission-sig"), certUrl: c.header(req, "paypal-cert-url"), authAlgo: c.header(req, "paypal-auth-algo"),
    }, raw);
    c.send(res, out.http, { outcome: out.outcome });
    return true;
  }
  c.send(res, 404, { error: "Not found" });
  return true;
}
