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

  addClientToken(token: string, userId: string, scopes: string[]) {
    if (token.length < 24) throw new Error("Dev client tokens must be at least 24 characters");
    this.clients.push({ hash: sha(token), userId, scopes: new Set(scopes) });
  }
  addOwnerKey(key: string, userId: string) {
    if (key.length < 24) throw new Error("Owner keys must be at least 24 characters");
    this.owners.push({ hash: sha(key), userId });
  }

  verifyBearer(header: string | undefined): Principal | null {
    const m = /^Bearer ([A-Za-z0-9._~-]{24,200})$/.exec(header ?? "");
    if (!m) return null;
    const h = sha(m[1]!);
    const hit = this.clients.find((c) => timingSafeEqual(c.hash, h));
    return hit ? { userId: hit.userId, scopes: hit.scopes, kind: "DEV_TOKEN", tokenFingerprint: h.toString("hex").slice(0, 12) } : null;
  }

  verifyOwnerKey(key: string | undefined): string | null {
    if (!key || key.length < 24 || key.length > 200) return null;
    const h = sha(key);
    return this.owners.find((o) => timingSafeEqual(o.hash, h))?.userId ?? null;
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
