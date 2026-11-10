import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { FIXED_TOTAL_MINOR, MERCHANT_DOMAIN, PRODUCT } from "./catalog.js";

/**
 * Checkout modes. Only MOCK works without an owner approval digest.
 *
 *  MOCK                   default; in-process fake PayPal; no network at all.
 *  SANDBOX_POPUP_TEST     (gate C1) real PayPal JS SDK v6 Sandbox + Sandbox order creation, capped; capture is DISABLED.
 *  SANDBOX_APPROVAL_TEST  (gate C2) like C1 plus ONE seller-side capture of the fixed $107.60 order.
 *
 * Modes are chosen at process start from the environment only. No HTTP route can change the mode.
 */
export type CheckoutMode = "MOCK" | "SANDBOX_POPUP_TEST" | "SANDBOX_APPROVAL_TEST";
export type Gate = "C1" | "C2";

/** The only PayPal API origin this app can call. Live (api-m.paypal.com) is unreachable by construction. */
export const PAYPAL_SANDBOX_API_ORIGIN = "https://api-m.sandbox.paypal.com";
/** PayPal JS SDK v6 Sandbox core script, as used by paypal-examples/v6-web-sdk-sample-integration. */
export const PAYPAL_V6_SANDBOX_SDK_URL = "https://www.sandbox.paypal.com/web-sdk/v6/core";

export class ConfigRefusedError extends Error {
  constructor(readonly code: string, message: string) { super(`${code}: ${message}`); }
}

export interface Allowlist { browserHosts: string[]; sha256: string }

export interface ApprovalStatement {
  schema: "diaporia.phase-c.approval.v2";
  gate: Gate;
  mode: Exclude<CheckoutMode, "MOCK">;
  merchantDomain: string;
  merchantOrigin: string;
  networkAllowlistSha256: string;
  kernelEgressHosts: string[];
  product: { sku: string; variant: string; quantity: number; currency: string; fixedTotalMinor: number };
  maxSandboxOrders: number;
  capture: boolean;
  maxCaptures: number;
  sellerMerchantIdSha256: string;
  /** Enforced by DIAPORIA's durable per-approval KERNEL creation ledger (src/handoff/kernelLedger.ts), not by the provider. */
  kernelBrowsers: 1;
  maxMinutes: number;
  /**
   * An ESTIMATE the owner accepts. Nothing in this repository can stop KERNEL from billing past it: it is not a
   * monetary circuit breaker. Spending control = kernelBrowsers via the ledger + maxMinutes watchdog + the owner's
   * own account-side limits and supervision.
   */
  kernelUsdEstimateNotEnforced: string;
  /** Absolute merchant data directory. A data dir is bound to exactly one approval (one run); see spendLedger.ts. */
  merchantDataDir: string;
  /** One merchant process per approval: an exclusive lease file in merchantDataDir. Replicas are refused. */
  merchantInstances: 1;
  expiresAt: string;
}

/** Owner approval for ONE capture retry of ONE C2 cart after a read-only reconciliation. Separate digest. */
export interface CaptureRetryStatement {
  schema: "diaporia.phase-c.capture-retry.v1";
  gate: "C2_CAPTURE_RETRY";
  c2ApprovalDigest: string;
  cartRef: string;
  merchantOrderRef: string;
  maxRetries: 1;
  sameRequestId: true;
}

export interface MerchantConfig {
  mode: CheckoutMode;
  listenHost: string;
  listenPort: number;
  /** Externally visible origin (https in Sandbox modes). Null in MOCK until the server learns its own port. */
  publicOrigin: string | null;
  statusSecret: string | null;
  operatorKey: string | null;
  dataDir: string | null;
  allowlist: Allowlist;
  paypal: { clientId: string; clientSecret: string; payeeMerchantId: string } | null;
  approval: { statement: ApprovalStatement; digest: string; expiresAtMs: number } | null;
}

export const DEFAULT_ALLOWLIST_PATH = [new URL("../config/network-allowlist.json", import.meta.url), new URL("../../../../apps/phase-c-test-merchant/config/network-allowlist.json", import.meta.url)]
  .map((u) => fileURLToPath(u)).find((f) => existsSync(f)) ?? fileURLToPath(new URL("../config/network-allowlist.json", import.meta.url));

const EXACT_HOST = /^(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const PRIVATE_SUFFIX = /(^|\.)(localhost|local|internal|lan|home|corp|test|example|invalid)$/;

export function isExactPublicHost(h: unknown): h is string {
  return typeof h === "string" && EXACT_HOST.test(h) && !PRIVATE_SUFFIX.test(h);
}

/** Parses and validates the reviewed allowlist file. Any wildcard, IP, port, duplicate or private name is refused. */
export function loadAllowlist(text: string): Allowlist {
  let j: any;
  try { j = JSON.parse(text); } catch { throw new ConfigRefusedError("ALLOWLIST_INVALID", "network allowlist is not JSON"); }
  if (j?.schema !== "diaporia.phase-c.network-allowlist.v1" || !Array.isArray(j.browserHosts) || j.browserHosts.length === 0)
    throw new ConfigRefusedError("ALLOWLIST_INVALID", "network allowlist schema or browserHosts missing");
  const hosts: string[] = j.browserHosts.map((e: any) => e?.host);
  if (hosts.some((h) => !isExactPublicHost(h))) throw new ConfigRefusedError("ALLOWLIST_HOST_INVALID", "allowlist hosts must be exact public DNS names (no wildcard, IP, port)");
  if (new Set(hosts).size !== hosts.length) throw new ConfigRefusedError("ALLOWLIST_HOST_INVALID", "duplicate allowlist host");
  if (hosts.some((h) => h === "www.paypal.com" || h === "api-m.paypal.com" || h === "api.paypal.com"))
    throw new ConfigRefusedError("ALLOWLIST_LIVE_PAYPAL", "production PayPal hosts are never allowed in the test merchant");
  if (!hosts.includes("www.sandbox.paypal.com")) throw new ConfigRefusedError("ALLOWLIST_HOST_MISSING", "www.sandbox.paypal.com is required for the SDK v6 Sandbox script");
  return { browserHosts: hosts, sha256: sha256Hex(canonicalJson({ browserHosts: [...hosts].sort() })) };
}

export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((v as any)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}
export const sha256Hex = (s: string): string => createHash("sha256").update(s).digest("hex");

/** Validates a bare https origin on a public host (Sandbox modes). */
export function parsePublicOrigin(raw: string | undefined): string {
  if (!raw) throw new ConfigRefusedError("ORIGIN_REQUIRED", "MERCHANT_PUBLIC_ORIGIN is required in Sandbox modes");
  let u: URL;
  try { u = new URL(raw); } catch { throw new ConfigRefusedError("ORIGIN_INVALID", "MERCHANT_PUBLIC_ORIGIN is not a URL"); }
  if (u.protocol !== "https:") throw new ConfigRefusedError("ORIGIN_NOT_HTTPS", "PayPal Sandbox modes require an https origin");
  if (u.pathname !== "/" || u.search || u.hash || u.username || u.password || u.port) throw new ConfigRefusedError("ORIGIN_NOT_BARE", "origin must be scheme://host with no path, port or credentials");
  if (!isExactPublicHost(u.hostname)) throw new ConfigRefusedError("ORIGIN_NOT_PUBLIC", "origin host must be a public DNS name controlled by the operator");
  return u.origin;
}

/** KERNEL egress list for this merchant: its own host plus the reviewed browser hosts. */
export function kernelEgressHosts(origin: string, allowlist: Allowlist): string[] {
  return [new URL(origin).hostname, ...allowlist.browserHosts];
}

export function buildApprovalStatement(p: {
  gate: Gate; merchantOrigin: string; allowlist: Allowlist; sellerMerchantId: string | null;
  maxMinutes: number; kernelUsdEstimate: string; merchantDataDir: string; expiresAt: string;
}): ApprovalStatement {
  if (!Number.isInteger(p.maxMinutes) || p.maxMinutes < 1 || p.maxMinutes > 10) throw new ConfigRefusedError("APPROVAL_INVALID", "maxMinutes must be 1..10 (KERNEL watchdog ceiling)");
  if (!/^\d{1,2}\.\d{2}$/.test(p.kernelUsdEstimate)) throw new ConfigRefusedError("APPROVAL_INVALID", "the KERNEL USD estimate must look like 0.50");
  const dataDir = parseDataDir(p.merchantDataDir);
  if (Number.isNaN(Date.parse(p.expiresAt))) throw new ConfigRefusedError("APPROVAL_INVALID", "expiresAt must be an ISO-8601 time");
  const c2 = p.gate === "C2";
  if (!p.sellerMerchantId) throw new ConfigRefusedError("APPROVAL_INVALID", "the Sandbox seller (business) merchant id is part of every approval");
  return {
    schema: "diaporia.phase-c.approval.v2", gate: p.gate, mode: c2 ? "SANDBOX_APPROVAL_TEST" : "SANDBOX_POPUP_TEST",
    merchantDomain: MERCHANT_DOMAIN, merchantOrigin: p.merchantOrigin, networkAllowlistSha256: p.allowlist.sha256,
    kernelEgressHosts: kernelEgressHosts(p.merchantOrigin, p.allowlist),
    product: { sku: PRODUCT.sku, variant: PRODUCT.variant, quantity: PRODUCT.quantity, currency: PRODUCT.currency, fixedTotalMinor: FIXED_TOTAL_MINOR },
    maxSandboxOrders: 1, capture: c2, maxCaptures: c2 ? 1 : 0,
    sellerMerchantIdSha256: sha256Hex(p.sellerMerchantId),
    kernelBrowsers: 1, maxMinutes: p.maxMinutes, kernelUsdEstimateNotEnforced: p.kernelUsdEstimate,
    merchantDataDir: dataDir, merchantInstances: 1, expiresAt: new Date(p.expiresAt).toISOString(),
  };
}

export const approvalDigest = (s: ApprovalStatement | CaptureRetryStatement): string => sha256Hex(canonicalJson(s));

/** The data dir is part of the approval, so a second instance with another data dir cannot reuse the digest. */
export function parseDataDir(raw: string | undefined): string {
  if (!raw || !isAbsolute(raw)) throw new ConfigRefusedError("DATA_DIR_REQUIRED", "MERCHANT_DATA_DIR must be an absolute path (it is part of the approval)");
  const n = normalize(raw).replace(/[\\/]+$/, "");
  if (!n || n.length > 300) throw new ConfigRefusedError("DATA_DIR_INVALID", "MERCHANT_DATA_DIR is not usable");
  return n;
}

export function buildCaptureRetryStatement(p: { c2ApprovalDigest: string; cartRef: string; merchantOrderRef: string }): CaptureRetryStatement {
  if (!/^([a-f0-9]{64}|MOCK)$/.test(p.c2ApprovalDigest)) throw new ConfigRefusedError("APPROVAL_INVALID", "c2ApprovalDigest must be the C2 digest");
  if (!/^cart_[a-f0-9]{24}$/.test(p.cartRef) || !/^PHC-[A-F0-9]{12}$/.test(p.merchantOrderRef)) throw new ConfigRefusedError("APPROVAL_INVALID", "cartRef / merchantOrderRef malformed");
  return { schema: "diaporia.phase-c.capture-retry.v1", gate: "C2_CAPTURE_RETRY", c2ApprovalDigest: p.c2ApprovalDigest, cartRef: p.cartRef,
    merchantOrderRef: p.merchantOrderRef, maxRetries: 1, sameRequestId: true };
}

const FORBIDDEN_OVERRIDES = ["PAYPAL_API_BASE", "MERCHANT_PAYPAL_API_BASE", "MERCHANT_PAYPAL_SDK_URL", "PAYPAL_SDK_URL"];

/**
 * Loads configuration from the environment. Sandbox modes are refused unless every one of these holds:
 * https public origin, reviewed allowlist, server-side Sandbox credentials, a seller merchant id, a persistent data dir,
 * a status-signing secret, an unexpired approval window of at most 24 h, and PHASE_C_APPROVED_DIGEST equal to the
 * digest of the statement rebuilt from THIS configuration for THIS mode's gate.
 */
export function loadMerchantConfig(env: NodeJS.ProcessEnv, now: number = Date.now(), allowlistText?: string): MerchantConfig {
  const mode = (env.MERCHANT_CHECKOUT_MODE ?? "MOCK").trim().toUpperCase();
  if (mode !== "MOCK" && mode !== "SANDBOX_POPUP_TEST" && mode !== "SANDBOX_APPROVAL_TEST") throw new ConfigRefusedError("MODE_UNKNOWN", `unknown MERCHANT_CHECKOUT_MODE ${mode}`);
  for (const k of FORBIDDEN_OVERRIDES) if (env[k]) throw new ConfigRefusedError("ENDPOINT_OVERRIDE_REFUSED", `${k} must not be set: PayPal endpoints are fixed to Sandbox`);
  if (env.MERCHANT_PAYPAL_ENV && env.MERCHANT_PAYPAL_ENV.toUpperCase() !== "SANDBOX") throw new ConfigRefusedError("LIVE_REFUSED", "MERCHANT_PAYPAL_ENV may only be SANDBOX");
  const allowlist = loadAllowlist(allowlistText ?? readFileSync(env.MERCHANT_ALLOWLIST_FILE || DEFAULT_ALLOWLIST_PATH, "utf8"));
  const listenHost = env.MERCHANT_LISTEN_HOST || "127.0.0.1";
  const listenPort = Number(env.MERCHANT_LISTEN_PORT ?? 8791);
  if (!Number.isInteger(listenPort) || listenPort < 0 || listenPort > 65535) throw new ConfigRefusedError("PORT_INVALID", "MERCHANT_LISTEN_PORT invalid");
  const secret = (k: string, min: number): string | null => {
    const v = env[k];
    if (!v) return null;
    if (v.length < min) throw new ConfigRefusedError("SECRET_TOO_SHORT", `${k} must be at least ${min} characters`);
    return v;
  };
  const statusSecret = secret("MERCHANT_STATUS_SECRET", 32);
  const operatorKey = secret("MERCHANT_OPERATOR_KEY", 32);

  if (mode === "MOCK") {
    // MOCK never needs or reads PayPal credentials; refuse them so a real secret is not left in a demo process.
    if (env.MERCHANT_PAYPAL_CLIENT_SECRET) throw new ConfigRefusedError("CREDENTIALS_IN_MOCK", "unset MERCHANT_PAYPAL_CLIENT_SECRET for MOCK mode");
    if (env.PHASE_C_APPROVED_DIGEST) throw new ConfigRefusedError("APPROVAL_IN_MOCK", "an approval digest is meaningless in MOCK mode; unset it");
    const origin = env.MERCHANT_PUBLIC_ORIGIN ? new URL(env.MERCHANT_PUBLIC_ORIGIN).origin : null;
    return { mode, listenHost, listenPort, publicOrigin: origin, statusSecret, operatorKey, dataDir: env.MERCHANT_DATA_DIR || null, allowlist, paypal: null, approval: null };
  }

  const gate: Gate = mode === "SANDBOX_APPROVAL_TEST" ? "C2" : "C1";
  const publicOrigin = parsePublicOrigin(env.MERCHANT_PUBLIC_ORIGIN);
  const clientId = env.MERCHANT_PAYPAL_CLIENT_ID ?? "";
  const clientSecret = env.MERCHANT_PAYPAL_CLIENT_SECRET ?? "";
  const payeeMerchantId = env.MERCHANT_PAYPAL_SELLER_MERCHANT_ID ?? "";
  if (!clientId || !clientSecret) throw new ConfigRefusedError("CREDENTIALS_MISSING", "MERCHANT_PAYPAL_CLIENT_ID / MERCHANT_PAYPAL_CLIENT_SECRET (Sandbox app of the seller) are required");
  if (!/^[A-Z0-9]{8,20}$/.test(payeeMerchantId)) throw new ConfigRefusedError("SELLER_ID_INVALID", "MERCHANT_PAYPAL_SELLER_MERCHANT_ID must be the Sandbox BUSINESS account merchant id");
  const dataDir = parseDataDir(env.MERCHANT_DATA_DIR);
  if (!statusSecret) throw new ConfigRefusedError("STATUS_SECRET_REQUIRED", "MERCHANT_STATUS_SECRET is required so seller status can be authenticated");
  if (!env.PHASE_C_APPROVED_DIGEST) throw new ConfigRefusedError("APPROVAL_REQUIRED", `${mode} requires owner approval (PHASE_C_APPROVED_DIGEST for gate ${gate})`);
  const expiresAt = env.PHASE_C_APPROVAL_EXPIRES_AT ?? "";
  const expiresAtMs = Date.parse(expiresAt);
  if (Number.isNaN(expiresAtMs) || expiresAtMs <= now) throw new ConfigRefusedError("APPROVAL_EXPIRED", "PHASE_C_APPROVAL_EXPIRES_AT is missing or in the past");
  if (expiresAtMs - now > 24 * 3600_000) throw new ConfigRefusedError("APPROVAL_WINDOW_TOO_LONG", "approval windows are at most 24 hours");
  const statement = buildApprovalStatement({ gate, merchantOrigin: publicOrigin, allowlist, sellerMerchantId: payeeMerchantId,
    maxMinutes: Number(env.PHASE_C_MAX_MINUTES ?? 10), kernelUsdEstimate: env.PHASE_C_KERNEL_USD_ESTIMATE ?? "0.50", merchantDataDir: dataDir, expiresAt });
  const digest = approvalDigest(statement);
  if (env.PHASE_C_APPROVED_DIGEST.trim().toLowerCase() !== digest)
    throw new ConfigRefusedError("APPROVAL_DIGEST_MISMATCH", `PHASE_C_APPROVED_DIGEST does not match the ${gate} statement for this configuration`);
  return { mode, listenHost, listenPort, publicOrigin, statusSecret, operatorKey, dataDir, allowlist,
    paypal: { clientId, clientSecret, payeeMerchantId }, approval: { statement, digest, expiresAtMs } };
}
