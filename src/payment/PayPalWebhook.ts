import { createPublicKey, verify as cryptoVerify, type KeyObject } from "node:crypto";
import { crc32 } from "node:zlib";

/**
 * PayPal webhook authentication (documented self-verification scheme):
 *   signed message = `${transmission_id}|${transmission_time}|${webhook_id}|${crc32(raw body)}`
 *   signature      = base64 RSA-SHA256 over that message, verifiable with the certificate at cert_url.
 * The certificate URL must be an HTTPS URL on a PayPal API host. Events are NEVER trusted for state:
 * they only trigger an authoritative capture read (see CommerceGateway.reconcileCapture).
 */
export interface WebhookHeaders {
  transmissionId: string | undefined;
  transmissionTime: string | undefined;
  transmissionSig: string | undefined;
  certUrl: string | undefined;
  authAlgo: string | undefined;
}

export type WebhookVerification = { ok: true } | { ok: false; reason: string };

export interface WebhookSignatureVerifier {
  verify(headers: WebhookHeaders, rawBody: string): Promise<WebhookVerification>;
}

export const PAYPAL_CERT_HOSTS = ["api.paypal.com", "api.sandbox.paypal.com", "api-m.paypal.com", "api-m.sandbox.paypal.com"];

export interface PayPalWebhookVerifierConfig {
  /** The webhook id PayPal assigned when the listener was registered. Required. */
  webhookId: string;
  /** Returns the PEM certificate (or public key) for an allowed cert URL. Defaults to an HTTPS fetch. */
  fetchCertPem?: (url: string) => Promise<string>;
  now?: () => number;
  /** PayPal retries for up to 3 days; older transmissions are rejected. */
  maxAgeSeconds?: number;
}

export class PayPalWebhookSignatureVerifier implements WebhookSignatureVerifier {
  private readonly cache = new Map<string, KeyObject>();
  constructor(private readonly cfg: PayPalWebhookVerifierConfig) {
    if (!cfg.webhookId) throw new Error("PayPal webhook id is required for webhook verification");
  }

  async verify(h: WebhookHeaders, rawBody: string): Promise<WebhookVerification> {
    if (!h.transmissionId || !h.transmissionTime || !h.transmissionSig || !h.certUrl || !h.authAlgo) return { ok: false, reason: "missing PayPal transmission headers" };
    if (h.authAlgo !== "SHA256withRSA") return { ok: false, reason: "unsupported auth algorithm" };
    let url: URL;
    try { url = new URL(h.certUrl); } catch { return { ok: false, reason: "invalid cert url" }; }
    if (url.protocol !== "https:" || !PAYPAL_CERT_HOSTS.includes(url.hostname) || !url.pathname.startsWith("/v1/notifications/certs/"))
      return { ok: false, reason: "cert url is not a PayPal certificate endpoint" };
    const sent = Date.parse(h.transmissionTime);
    const now = (this.cfg.now ?? Date.now)();
    if (!Number.isFinite(sent)) return { ok: false, reason: "invalid transmission time" };
    if (sent > now + 5 * 60_000) return { ok: false, reason: "transmission time is in the future" };
    if (now - sent > (this.cfg.maxAgeSeconds ?? 3 * 86400) * 1000) return { ok: false, reason: "transmission too old" };
    let key = this.cache.get(url.href);
    if (!key) {
      try {
        const pem = await (this.cfg.fetchCertPem ?? defaultFetchCert)(url.href);
        key = createPublicKey(pem);
        this.cache.set(url.href, key);
      } catch { return { ok: false, reason: "certificate could not be loaded" }; }
    }
    const message = `${h.transmissionId}|${h.transmissionTime}|${this.cfg.webhookId}|${crc32(Buffer.from(rawBody, "utf8")) >>> 0}`;
    let valid = false;
    try { valid = cryptoVerify("sha256", Buffer.from(message, "utf8"), key, Buffer.from(h.transmissionSig, "base64")); } catch { valid = false; }
    return valid ? { ok: true } : { ok: false, reason: "signature does not verify" };
  }
}

async function defaultFetchCert(url: string): Promise<string> {
  const r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`cert fetch HTTP ${r.status}`);
  return r.text();
}

export const HANDLED_EVENT_TYPES = ["PAYMENT.CAPTURE.PENDING", "PAYMENT.CAPTURE.COMPLETED", "PAYMENT.CAPTURE.DENIED", "PAYMENT.CAPTURE.REFUNDED", "PAYMENT.CAPTURE.REVERSED"] as const;
export type HandledEventType = (typeof HANDLED_EVENT_TYPES)[number];

export interface ParsedWebhookEvent {
  eventId: string;
  eventType: HandledEventType;
  /** Capture the event is about (for refunds: the refunded capture, from the `up` link). */
  captureId: string;
  /** What the event claims. Informational only: state changes come from an authoritative GET. */
  claimedStatus: string | null;
  payeeMerchantId: string | null;
}

const ID_RE = /^[A-Z0-9]{8,36}$/;
type J = Record<string, unknown>;
const o = (v: unknown): J => (v && typeof v === "object" && !Array.isArray(v) ? (v as J) : {});

/** Strict parsing of the subset of fields DIAPORIA uses. Anything else is ignored, never interpreted. */
export function parseWebhookEvent(body: unknown): ParsedWebhookEvent | { error: string } {
  const e = o(body);
  if (typeof e.id !== "string" || !/^WH-[A-Z0-9-]{8,60}$/.test(e.id)) return { error: "missing or malformed event id" };
  if (typeof e.event_type !== "string") return { error: "missing event type" };
  if (!(HANDLED_EVENT_TYPES as readonly string[]).includes(e.event_type)) return { error: `unhandled event type ${e.event_type.slice(0, 40)}` };
  const r = o(e.resource);
  let captureId: string | null = null;
  if (e.event_type === "PAYMENT.CAPTURE.REFUNDED") {
    const up = (Array.isArray(r.links) ? r.links.map(o) : []).find((l) => l.rel === "up" && typeof l.href === "string");
    const m = up ? /\/v2\/payments\/captures\/([A-Z0-9]{8,36})$/.exec(String(up.href)) : null;
    captureId = m ? m[1]! : null;
  } else if (typeof r.id === "string") captureId = r.id;
  if (!captureId || !ID_RE.test(captureId)) return { error: "missing or malformed capture id" };
  const payee = o(r.payee).merchant_id;
  return { eventId: e.id, eventType: e.event_type as HandledEventType, captureId, claimedStatus: typeof r.status === "string" ? r.status : null,
    payeeMerchantId: typeof payee === "string" ? payee : null };
}
