import type { Currency } from "../domain/money.js";
import { parseDecimalToMinor } from "../domain/money.js";

/**
 * A DIAPORIA-authored, per-merchant cart-preparation recipe. Recipes are trusted configuration (never built from
 * page text or model output). A merchant without a recipe is not an "authorized merchant" for browser handoff.
 *
 * Step values are symbolic ("variant" | "quantity") and resolved from the LOCKED product identity and the
 * requested quantity, so a recipe can never be used to pick a different product.
 */
export type RecipeStep =
  | { action: "select"; selector: string; value: "variant" }
  | { action: "fill"; selector: string; value: "quantity" }
  | { action: "click"; selector: string }
  | { action: "waitFor"; selector: string };

export interface MerchantCheckoutRecipe {
  recipeId: string;
  /** Must equal the verified offer's merchantDomain. */
  merchantDomain: string;
  /** Origin the browser opens. Public https for KERNEL; loopback http only for the offline fixture driver. */
  origin: string;
  /** Product page path; `{offerId}` is substituted (URL-encoded). */
  productPath: string;
  steps: RecipeStep[];
  cartPath: string;
  /** CSS selectors read as text from the cart page. Missing fields become explicit unknowns. */
  extract: {
    title: string; variant?: string; condition?: string; quantity: string;
    subtotal?: string; shipping?: string; tax?: string; total: string; currency?: string;
    /** Element whose `data-cart-ref` attribute holds the merchant's cart reference (used for seller-side lookup). */
    cartRef?: string;
  };
  /** Page-level signal of an order confirmation. Informative only: never sufficient for ORDER_CONFIRMED. */
  confirmationSelector: string;
  /** Hosts the merchant's own PayPal button legitimately opens (popup or redirect) during human takeover. */
  paymentHosts: string[];
  /** Optional KERNEL egress allowlist (merchant + payment + CDN hosts). Unset = no egress restriction requested. */
  networkAllowedHosts?: string[];
}

/** Text that marks a payment-authorization or order-submission control. Automation must never activate one. */
export const PAYMENT_CONTROL = /(pay\s*pal|paypal|pay\s+now|pay\s+with|place\s+(your\s+)?order|complete\s+(the\s+)?(purchase|order)|submit\s+order|confirm\s+(and\s+)?pay|confirm\s+order|buy\s+now|checkout\s+with|authorize\s+payment|data-payment)/i;

const SELECTOR = /^[#.\[\]a-zA-Z0-9_\-=:"' >()*]{1,200}$/;

export function validateRecipe(r: MerchantCheckoutRecipe, opts: { allowLoopbackOrigin: boolean }): string | null {
  let o: URL;
  try { o = new URL(r.origin); } catch { return "RECIPE_ORIGIN_INVALID"; }
  if (o.pathname !== "/" || o.search || o.hash || o.username || o.password) return "RECIPE_ORIGIN_NOT_BARE";
  const loopback = /^(127\.0\.0\.1|localhost|\[::1\])$/.test(o.hostname);
  if (loopback ? !(opts.allowLoopbackOrigin && o.protocol === "http:") : o.protocol !== "https:") return "RECIPE_ORIGIN_NOT_ALLOWED";
  if (!/^[a-z0-9.-]{3,253}$/.test(r.merchantDomain)) return "RECIPE_DOMAIN_INVALID";
  if (!r.productPath.startsWith("/") || !r.cartPath.startsWith("/")) return "RECIPE_PATH_INVALID";
  const sels = [...r.steps.map((s) => s.selector), r.confirmationSelector, ...Object.values(r.extract).filter((v): v is string => typeof v === "string")];
  if (sels.some((s) => !SELECTOR.test(s))) return "RECIPE_SELECTOR_INVALID";
  // A recipe step may never target a payment / order-submission control, even by id.
  if (r.steps.some((s) => s.action === "click" && PAYMENT_CONTROL.test(s.selector))) return "RECIPE_TARGETS_PAYMENT_CONTROL";
  if (r.paymentHosts.some((h) => !/^[a-z0-9.-]{3,253}(:\d{1,5})?$/.test(h))) return "RECIPE_PAYMENT_HOST_INVALID";
  // Real KERNEL merchant sessions require an explicit, reviewed egress allowlist.
  // Only exact public DNS hostnames: no wildcards, raw IPs or CIDRs in Phase C.
  if (!opts.allowLoopbackOrigin) {
    const allowed = r.networkAllowedHosts;
    if (!Array.isArray(allowed) || allowed.length === 0 || allowed.length > 100)
      return "RECIPE_EGRESS_ALLOWLIST_REQUIRED";
    const validHost = (h: string): boolean => typeof h === "string" &&
      /^(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(h) &&
      !/(^|\.)(localhost|local|internal|lan|home|corp|test|example|invalid)$/.test(h);
    if (allowed.some(h => !validHost(h)) || new Set(allowed).size !== allowed.length)
      return "RECIPE_EGRESS_HOST_INVALID";
    if (!allowed.includes(o.hostname.toLowerCase()) ||
        r.paymentHosts.some(h => !allowed.includes(h)))
      return "RECIPE_EGRESS_REQUIRED_HOST_MISSING";
  }
  return null;
}

export class MerchantRecipeRegistry {
  private readonly byDomain = new Map<string, MerchantCheckoutRecipe>();
  constructor(recipes: MerchantCheckoutRecipe[], private readonly opts: { allowLoopbackOrigin: boolean }) {
    for (const r of recipes) {
      const bad = validateRecipe(r, opts);
      if (bad) throw new Error(`Recipe ${r.recipeId} rejected: ${bad}`);
      this.byDomain.set(r.merchantDomain, r);
    }
  }
  get(merchantDomain: string): MerchantCheckoutRecipe | null { return this.byDomain.get(merchantDomain) ?? null; }
  get allowLoopbackOrigin() { return this.opts.allowLoopbackOrigin; }
}

/** Raw strings read from the cart page (untrusted, length-bounded by the script). */
export interface RawCartRead {
  finalHost: string; finalPath: string;
  title: string | null; variant: string | null; condition: string | null; quantity: string | null;
  subtotal: string | null; shipping: string | null; tax: string | null; total: string | null; currency: string | null; cartRef: string | null;
}
export interface PrepareScriptResult { ok: true; cart: RawCartRead; popupsClosed: number; navigationsBlocked: number }
export interface PrepareScriptRefusal { ok: false; refused: string; detail?: string }

const MAX_FIELD = 200;

/**
 * Remote/local Playwright snippet that prepares the cart. It runs with `page` and `context` in scope (the same
 * contract as KERNEL's /playwright/execute). Only JSON literals built here enter the code.
 *
 * Guards active while it runs: main-frame navigation off the merchant host is aborted, every popup / new tab is
 * closed, and each step target is inspected and refused if it looks like a payment or order-submission control.
 */
export function buildPrepareScript(r: MerchantCheckoutRecipe, input: { offerId: string; variant: string | null; quantity: number }, navMs = 15_000): string {
  const spec = {
    origin: r.origin, productUrl: r.origin.replace(/\/$/, "") + r.productPath.replace("{offerId}", encodeURIComponent(input.offerId)),
    cartUrl: r.origin.replace(/\/$/, "") + r.cartPath, steps: r.steps, extract: r.extract, navMs: Math.floor(navMs),
    values: { variant: input.variant ?? "", quantity: String(input.quantity) }, forbidden: PAYMENT_CONTROL.source, max: MAX_FIELD,
  };
  return `const R = ${JSON.stringify(spec)};
const FORBIDDEN = new RegExp(R.forbidden, "i");
const allowedHost = new URL(R.origin).host;
let popupsClosed = 0, navigationsBlocked = 0;
const onPage = (p) => { if (p !== page) { popupsClosed++; p.close().catch(() => {}); } };
context.on("page", onPage);
const guard = (route) => {
  const req = route.request(); let u;
  try { u = new URL(req.url()); } catch { return route.abort(); }
  let main = false; try { main = req.isNavigationRequest() && req.frame() === page.mainFrame(); } catch { main = req.isNavigationRequest(); }
  if (main && u.host !== allowedHost) { navigationsBlocked++; return route.abort(); }
  return route.continue();
};
await page.route("**/*", guard);
try {
  await page.goto(R.productUrl, { waitUntil: "domcontentloaded", timeout: R.navMs });
  for (const s of R.steps) {
    const loc = page.locator(s.selector).first();
    if (s.action === "waitFor") { await loc.waitFor({ timeout: R.navMs }); continue; }
    await loc.waitFor({ timeout: R.navMs });
    const info = await loc.evaluate((e) => [e.innerText || "", e.value || "", e.getAttribute("aria-label") || "", e.id || "", e.getAttribute("name") || "",
      e.getAttribute("formaction") || "", e.form ? (e.form.getAttribute("action") || "") : "", e.hasAttribute("data-payment") ? "data-payment" : "", e.className || ""].join(" "));
    if (FORBIDDEN.test(info)) return { ok: false, refused: "PAYMENT_CONTROL_REFUSED", detail: s.selector };
    if (s.action === "select") await loc.selectOption({ label: R.values[s.value] }, { timeout: R.navMs });
    else if (s.action === "fill") await loc.fill(R.values[s.value], { timeout: R.navMs });
    else if (s.action === "click") { await loc.click({ timeout: R.navMs }); await page.waitForLoadState("domcontentloaded", { timeout: R.navMs }); }
  }
  await page.goto(R.cartUrl, { waitUntil: "domcontentloaded", timeout: R.navMs });
  const cart = await page.evaluate(({ ex, max }) => {
    const t = (sel) => { if (!sel) return null; const el = document.querySelector(sel); if (!el) return null; const v = (el.innerText || el.textContent || "").trim(); return v ? v.slice(0, max) : null; };
    const refEl = ex.cartRef ? document.querySelector(ex.cartRef) : null;
    return { title: t(ex.title), variant: t(ex.variant), condition: t(ex.condition), quantity: t(ex.quantity), subtotal: t(ex.subtotal),
      shipping: t(ex.shipping), tax: t(ex.tax), total: t(ex.total), currency: t(ex.currency),
      cartRef: refEl ? (refEl.getAttribute("data-cart-ref") || "").slice(0, 80) || null : null };
  }, { ex: R.extract, max: R.max });
  const f = new URL(page.url());
  return { ok: true, popupsClosed, navigationsBlocked, cart: { finalHost: f.host, finalPath: f.pathname.slice(0, 200), ...cart } };
} catch (e) {
  return { ok: false, refused: "PREPARATION_FAILED", detail: String(e && e.message || e).slice(0, 160) };
} finally {
  context.off("page", onPage);
  await page.unroute("**/*", guard).catch(() => {});
}`;
}

export interface ObservedPage { host: string; path: string; title: string; confirmationText: string | null }
export interface ObservationResult { pages: ObservedPage[] }

/**
 * READ-ONLY observation snippet: lists open pages (host + path only: query strings and fragments are dropped
 * because payment providers put tokens there), titles, and the merchant confirmation element's text.
 * It never clicks, types, navigates, routes or screenshots.
 */
export function buildObserveScript(r: MerchantCheckoutRecipe): string {
  const spec = { sel: r.confirmationSelector, max: MAX_FIELD };
  return `const R = ${JSON.stringify(spec)};
const out = [];
for (const p of context.pages()) {
  let u; try { u = new URL(p.url()); } catch { continue; }
  let title = "", confirmationText = null;
  try { title = (await p.title()).slice(0, 120); } catch {}
  try { confirmationText = await p.evaluate(({ sel, max }) => { const e = document.querySelector(sel); return e ? (e.innerText || e.textContent || "").trim().slice(0, max) : null; }, R); } catch {}
  out.push({ host: u.host, path: u.pathname.slice(0, 200), title, confirmationText });
}
return { pages: out.slice(0, 10) };`;
}

/** Parses a displayed amount like "$59.17", "USD 1,059.00" or "59.17". Returns null when not exactly parseable. */
export function parseDisplayedMoney(text: string | null, currency: Currency): number | null {
  if (!text) return null;
  if (/free/i.test(text) && !/\d/.test(text)) return 0;
  const m = /(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?/.exec(text);
  if (!m) return null;
  const digits = m[0]!;
  // Reject strings with several amounts (ambiguous), e.g. "$59.17 was $79.17".
  if ((text.match(/\d+(?:[.,]\d+)*/g) ?? []).length > 1) return null;
  try { return parseDecimalToMinor(digits, currency); } catch { return null; }
}

export function parseDisplayedQuantity(text: string | null): number | null {
  if (!text) return null;
  const m = /^\D*(\d{1,3})\D*$/.exec(text.trim());
  return m ? Number(m[1]) : null;
}
