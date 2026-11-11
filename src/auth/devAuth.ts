import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const SCOPES = {
  RESEARCH: "purchase.research",
  READ: "purchase.read",
  PREPARE: "purchase.prepare",
} as const;
export type Scope = (typeof SCOPES)[keyof typeof SCOPES];
export const ALL_CLIENT_SCOPES: Scope[] = [SCOPES.RESEARCH, SCOPES.READ, SCOPES.PREPARE];

export interface Principal { userId: string; scopes: ReadonlySet<string>; kind: "DEV_TOKEN" | "ANONYMOUS_PUBLIC_DEMO" | "OAUTH_ACCESS_TOKEN"; tokenFingerprint: string; clientId?: string }

const sha = (s: string) => createHash("sha256").update(s).digest();

/**
 * DEVELOPMENT-ONLY bearer tokens, one per user. This is not OAuth: tokens are static,
 * local, and must never be shared or used on a public deployment for payment tools.
 * Owner keys are a separate secret held by the human; AI-client tokens can never
 * create purchase mandates.
 */
export class DevAuth {
  private readonly clients: Array<{ hash: Buffer; userId: string; scopes: Set<string> }> = [];
  private readonly owners: Array<{ hash: Buffer; userId: string }> = [];
  /** R-B: failed owner-key attempts per client (and overall), in a sliding window. */
  private readonly ownerFailures = new Map<string, number[]>();
  static readonly OWNER_KEY_MAX_FAILURES = 10;
  static readonly OWNER_KEY_MAX_FAILURES_ALL_CLIENTS = 50;
  static readonly OWNER_KEY_WINDOW_MS = 15 * 60_000;
  /** Clock for the attempt limiter (tests). */
  clock: () => number = Date.now;

  addClientToken(token: string, userId: string, scopes: string[]) {
    if (token.length < 24) throw new Error("Dev client tokens must be at least 24 characters");
    this.clients.push({ hash: sha(token), userId, scopes: new Set(scopes) });
  }
  addOwnerKey(key: string, userId: string) {
    if (key.length < 24) throw new Error("Owner keys must be at least 24 characters");
    this.owners.push({ hash: sha(key), userId });
  }

  /** R-A: an owner key known only by its SHA-256 (from the protected owner registry); the server never sees the key. */
  addOwnerKeyHash(sha256Hex: string, userId: string) {
    if (!/^[0-9a-f]{64}$/i.test(sha256Hex)) throw new Error("Owner key hashes must be SHA-256 hex");
    this.owners.push({ hash: Buffer.from(sha256Hex, "hex"), userId });
  }
  get hasOwnerKeys() { return this.owners.length > 0; }

  verifyBearer(header: string | undefined): Principal | null {
    const m = /^Bearer ([A-Za-z0-9._~-]{24,200})$/.exec(header ?? "");
    if (!m) return null;
    const h = sha(m[1]!);
    const hit = this.clients.find((c) => timingSafeEqual(c.hash, h));
    return hit ? { userId: hit.userId, scopes: hit.scopes, kind: "DEV_TOKEN", tokenFingerprint: h.toString("hex").slice(0, 12) } : null;
  }

  /** R-B: true while `client` (or all clients together) made too many failed owner-key attempts. */
  ownerKeyLimited(client = "unknown"): boolean {
    const since = this.clock() - DevAuth.OWNER_KEY_WINDOW_MS;
    const recent = (k: string) => { const a = (this.ownerFailures.get(k) ?? []).filter((t) => t > since); if (a.length) this.ownerFailures.set(k, a); else this.ownerFailures.delete(k); return a.length; };
    return recent(`client:${client}`) >= DevAuth.OWNER_KEY_MAX_FAILURES || recent("all") >= DevAuth.OWNER_KEY_MAX_FAILURES_ALL_CLIENTS;
  }

  /**
   * The owner's user id for a correct owner key, else null. R-B: while the caller is rate limited every key is refused
   * (even a correct one), and each failure counts against the client and against all clients together.
   */
  verifyOwnerKey(key: string | undefined, client = "unknown"): string | null {
    if (this.ownerKeyLimited(client)) return null;
    const h = key && key.length >= 24 && key.length <= 200 ? sha(key) : null;
    const userId = h ? this.owners.find((o) => timingSafeEqual(o.hash, h))?.userId ?? null : null;
    if (!userId) for (const k of [`client:${client}`, "all"]) this.ownerFailures.set(k, [...(this.ownerFailures.get(k) ?? []), this.clock()]);
    return userId;
  }

  static fromEnv(env: NodeJS.ProcessEnv): DevAuth {
    const auth = new DevAuth();
    for (const entry of (env.DIAPORIA_DEV_TOKENS ?? "").split(";").map((s) => s.trim()).filter(Boolean)) {
      const [token, rest] = entry.split("=");
      const [userId, scopes] = (rest ?? "").split(":");
      if (!token || !userId) throw new Error("DIAPORIA_DEV_TOKENS entries must look like token=userId:scope1,scope2");
      auth.addClientToken(token, userId, scopes ? scopes.split(",") : ALL_CLIENT_SCOPES);
    }
    for (const entry of (env.DIAPORIA_OWNER_KEYS ?? "").split(";").map((s) => s.trim()).filter(Boolean)) {
      const [key, userId] = entry.split("=");
      if (!key || !userId) throw new Error("DIAPORIA_OWNER_KEYS entries must look like key=userId");
      auth.addOwnerKey(key, userId);
    }
    return auth;
  }

  get empty() { return this.clients.length === 0; }
}

export function randomSecret(prefix: string): string { return `${prefix}_${randomBytes(24).toString("base64url")}`; }
