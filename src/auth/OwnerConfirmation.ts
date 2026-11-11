/**
 * R-A (IW-2 verification of 7d1fe4f): the human-confirmation boundary for research-hold proposals.
 *
 * A research-hold resolution is confirmed only by a WebAuthn-style assertion with USER VERIFICATION, made by a
 * public-key authenticator enrolled for that owner (a passkey / platform or security-key authenticator). The server
 * holds PUBLIC keys only, so nothing the server process, its data directory or the AI host can read lets anyone sign.
 *
 * The enrolled public keys (and optional owner-key verifiers, SHA-256 only) live in an owner registry file that must be
 * administered by a DIFFERENT OS principal than the one running the server: if the server's own user could write it, an
 * agent running as that user could enroll its own key. `fromRegistryFile` therefore fails closed unless the file
 *  - exists, parses, and lies outside the server's working tree and data directory, and
 *  - is a regular file owned by another OS user than the server process and not group/world writable, and every
 *    directory above it is likewise not owned by the server's user and not writable by others (sticky dirs excepted).
 * When the boundary cannot be established, research-hold confirmation is UNAVAILABLE (nothing can clear a hold).
 *
 * Headers such as Origin or Sec-Fetch-Site are never treated as proof of a human; the assertion is.
 */
import { createHash, createPublicKey, randomBytes, verify as verifySig } from "node:crypto";
import { lstatSync, readFileSync, type Stats } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export interface OwnerAuthenticator { credentialId: string; publicKeySpki: string; alg: -7; label?: string }
export interface OwnerRegistryEntry { userId: string; ownerKeySha256?: string[]; authenticators?: OwnerAuthenticator[] }
export interface OwnerRegistry { schema: "diaporia.owner-registry.v1"; owners: OwnerRegistryEntry[] }
export interface BoundaryStatus { established: boolean; source: "REGISTRY_FILE" | "TEST_ONLY_IN_PROCESS" | "NONE"; reason: string }

const b64u = (b: Buffer) => b.toString("base64url");
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest();
const VERIFIED = new WeakSet<object>();
/**
 * V2.2 WP-2 (H-2): the assertion as the authenticator produced it, stored with the resolution so that every later
 * gate check can verify the signature again against the registry's public key. A database row alone (strings such
 * as CONFIRMED_BY_OWNER) is never trusted: without a signature over a challenge derived from exactly this
 * resolution's content, the resolution does not count.
 */
export interface StoredAssertion { credentialId: string; clientDataJSON: string; authenticatorData: string; signature: string; nonce: string }
/** Proof object that only this module can mint: a verified, user-verified assertion bound to one challenge. */
export interface VerifiedHumanAssertion { readonly userId: string; readonly binding: string; readonly credentialFingerprint: string; readonly method: "WEBAUTHN_USER_VERIFIED"; readonly stored: StoredAssertion }
/**
 * The challenge binding of a research-hold confirmation (V2.2): the owner, the purchase session, the proposal and its
 * digest, the exact change (kind, requirement, budget, currency) and the owner review session. The gate recomputes it
 * from the stored resolution, so a valid assertion cannot be copied onto another session, requirement or amount.
 */
export interface ResearchHoldBindingInput { userId: string; purchaseSessionId: string; proposalId: string; digest: string; kind: string; requirement: string | null; budgetMinor: number | null; currency: string }
export const researchHoldBinding = (p: ResearchHoldBindingInput, reviewSessionFingerprint: string) =>
  `research-hold-v2|${createHash("sha256").update(JSON.stringify([p.userId, p.purchaseSessionId, p.proposalId, p.digest, p.kind, p.requirement, p.budgetMinor, p.currency, reviewSessionFingerprint])).digest("hex")}`;
/** The challenge an authenticator signs: derived from the binding and a server nonce, so it can be recomputed later. */
const challengeFor = (binding: string, nonce: string) => b64u(sha(`${binding}|${nonce}`));
export const isVerifiedHumanAssertion = (x: unknown): x is VerifiedHumanAssertion => typeof x === "object" && x !== null && VERIFIED.has(x);

export class OwnerConfirmationBoundary {
  private readonly challenges = new Map<string, { userId: string; binding: string; nonce: string; expiresAt: number }>();
  private readonly counters = new Map<string, number>();
  private constructor(readonly status: BoundaryStatus, private readonly registry: OwnerRegistry | null, readonly rpId: string, private readonly origins: string[], private readonly now: () => number) {}

  static unavailable(reason: string, rpId = "localhost", origins: string[] = [], now: () => number = Date.now) {
    return new OwnerConfirmationBoundary({ established: false, source: "NONE", reason }, null, rpId, origins, now);
  }

  /**
   * For tests and offline harnesses only: an in-process registry whose private keys are held by a simulated human in
   * the test process (never by the AI client under test). Production startup (src/main.ts) never calls this.
   */
  static testOnlyInProcess(registry: OwnerRegistry, rpId: string, origins: string[], now: () => number = Date.now) {
    return new OwnerConfirmationBoundary({ established: true, source: "TEST_ONLY_IN_PROCESS", reason: "test-only in-process registry" }, validate(registry), rpId, origins, now);
  }

  /** Production: the registry file administered by another OS principal. Fails closed with the reason. */
  static fromRegistryFile(path: string | undefined, o: { cwd: string; dataDir: string; rpId: string; origins: string[]; uid?: number | null; untrustedUids?: number[]; stat?: (p: string) => Stats; read?: (p: string) => string; now?: () => number }) {
    const fail = (reason: string) => OwnerConfirmationBoundary.unavailable(reason, o.rpId, o.origins, o.now);
    if (!path) return fail("DIAPORIA_OWNER_REGISTRY is not set: no protected human authenticator is configured");
    if (!isAbsolute(path)) return fail("the owner registry path must be absolute");
    const abs = resolve(path);
    const inside = (root: string) => { const r = relative(resolve(root), abs); return r === "" || (!r.startsWith("..") && !isAbsolute(r)); };
    if (inside(o.cwd) || inside(o.dataDir)) return fail("the owner registry is inside the server's working tree or data directory, where the AI host can reach it");
    const stat = o.stat ?? lstatSync; const uid = o.uid === undefined ? (typeof process.getuid === "function" ? process.getuid() : null) : o.uid;
    if (uid === null) return fail("this platform cannot report file ownership, so the OS-principal boundary cannot be checked");
    let st: Stats;
    try { st = stat(abs); } catch { return fail("the owner registry file does not exist"); }
    if (!st.isFile()) return fail("the owner registry must be a regular file (not a symbolic link)");
    if (st.uid === uid) return fail("the owner registry file is owned by the server's own OS user; it must be administered by a separate OS principal");
    if ((st.mode & 0o022) !== 0) return fail("the owner registry file is group- or world-writable");
    // V2.2 WP-2: the AI host's own account must not administer it either (it could enroll its own passkey).
    const untrusted = o.untrustedUids ?? [];
    if (untrusted.includes(st.uid)) return fail("the owner registry file is owned by an AI host account; it must be administered by a separate OS principal (for example root)");
    // Every directory above it too: a directory the server's user owns (or anyone can write without the sticky bit)
    // would let an agent running as that user rename it and put its own registry in place.
    for (let d = dirname(abs); ; d = dirname(d)) {
      let ds: Stats;
      try { ds = stat(d); } catch { return fail(`cannot inspect the owner registry directory ${d}`); }
      if (ds.uid === uid) return fail(`the owner registry directory ${d} is owned by the server's own OS user; it must be administered by a separate OS principal`);
      if (untrusted.includes(ds.uid)) return fail(`the owner registry directory ${d} is owned by an AI host account`);
      if ((ds.mode & 0o022) !== 0 && (ds.mode & 0o1000) === 0) return fail(`the owner registry directory ${d} is group- or world-writable`);
      if (dirname(d) === d) break;
    }
    let reg: OwnerRegistry;
    try { reg = validate(JSON.parse((o.read ?? ((p: string) => readFileSync(p, "utf8")))(abs))); } catch (e) { return fail(`the owner registry is invalid (${e instanceof Error ? e.message : "parse error"})`); }
    return new OwnerConfirmationBoundary({ established: true, source: "REGISTRY_FILE", reason: `registry ${abs} (owner uid ${st.uid}, server uid ${uid})` }, reg, o.rpId, o.origins, o.now ?? Date.now);
  }

  /** SHA-256 owner-key verifiers from the registry (for the review step; never sufficient to confirm). */
  ownerKeyVerifiers(): Array<{ sha256: string; userId: string }> {
    return (this.registry?.owners ?? []).flatMap((o) => (o.ownerKeySha256 ?? []).map((h) => ({ sha256: h.toLowerCase(), userId: o.userId })));
  }
  authenticatorsFor(userId: string): OwnerAuthenticator[] {
    if (!this.status.established) return [];
    return this.registry?.owners.find((o) => o.userId === userId)?.authenticators ?? [];
  }
  canConfirm(userId: string): boolean { return this.status.established && this.authenticatorsFor(userId).length > 0; }

  /** A single-use challenge bound to `binding` (e.g. proposal id + digest + review session). */
  newChallenge(userId: string, binding: string, ttlMs = 10 * 60_000): string {
    for (const [k, v] of this.challenges) if (v.expiresAt <= this.now()) this.challenges.delete(k);
    const nonce = b64u(randomBytes(32));
    const c = challengeFor(binding, nonce);
    this.challenges.set(c, { userId, binding, nonce, expiresAt: this.now() + ttlMs });
    return c;
  }

  /** Verifies a WebAuthn assertion (ES256) with user presence AND user verification. Consumes the challenge. */
  verifyAssertion(userId: string, binding: string, a: { credentialId: string; clientDataJSON: string; authenticatorData: string; signature: string }):
    { ok: true; proof: VerifiedHumanAssertion } | { ok: false; reason: string } {
    if (!this.status.established) return { ok: false, reason: `human confirmation unavailable: ${this.status.reason}` };
    const cred = this.authenticatorsFor(userId).find((c) => c.credentialId === a.credentialId);
    if (!cred) return { ok: false, reason: "unknown authenticator for this owner" };
    let client: { type?: string; challenge?: string; origin?: string; crossOrigin?: boolean };
    let cdj: Buffer, ad: Buffer, sig: Buffer;
    try { cdj = Buffer.from(a.clientDataJSON, "base64url"); ad = Buffer.from(a.authenticatorData, "base64url"); sig = Buffer.from(a.signature, "base64url"); client = JSON.parse(cdj.toString("utf8")); }
    catch { return { ok: false, reason: "malformed assertion" }; }
    if (client.type !== "webauthn.get") return { ok: false, reason: "not an assertion" };
    const ch = client.challenge ? this.challenges.get(client.challenge) : undefined;
    if (!ch || ch.expiresAt <= this.now() || ch.userId !== userId || ch.binding !== binding) return { ok: false, reason: "unknown, expired or differently bound challenge" };
    this.challenges.delete(client.challenge!); // single use, whatever the outcome below
    if (!client.origin || !this.origins.includes(client.origin) || client.crossOrigin) return { ok: false, reason: "assertion origin not allowed" };
    if (ad.length < 37 || !ad.subarray(0, 32).equals(sha(this.rpId))) return { ok: false, reason: "wrong relying party" };
    const flags = ad[32]!;
    if ((flags & 0x01) === 0 || (flags & 0x04) === 0) return { ok: false, reason: "user presence and user verification are both required" };
    const count = ad.readUInt32BE(33);
    const prev = this.counters.get(cred.credentialId) ?? 0;
    if (prev > 0 && count <= prev) return { ok: false, reason: "authenticator counter did not increase (possible clone or replay)" };
    let good = false;
    try { good = verifySig("sha256", Buffer.concat([ad, sha(cdj)]), createPublicKey({ key: Buffer.from(cred.publicKeySpki, "base64"), format: "der", type: "spki" }), sig); } catch { good = false; }
    if (!good) return { ok: false, reason: "signature does not verify" };
    if (count > 0) this.counters.set(cred.credentialId, count);
    const stored: StoredAssertion = Object.freeze({ credentialId: a.credentialId, clientDataJSON: a.clientDataJSON, authenticatorData: a.authenticatorData, signature: a.signature, nonce: ch.nonce });
    const proof: VerifiedHumanAssertion = Object.freeze({ userId, binding, credentialFingerprint: sha(cred.credentialId).toString("hex").slice(0, 16), method: "WEBAUTHN_USER_VERIFIED" as const, stored });
    VERIFIED.add(proof);
    return { ok: true, proof };
  }

  /**
   * V2.2 WP-2: re-verifies a stored assertion at gate time (no challenge consumption, no counter: the assertion is
   * historical). It must be a user-verified ES256 assertion by an authenticator enrolled for `userId` in the protected
   * registry, over the challenge derived from `binding` and the stored nonce, for an allowed origin and this rpId.
   */
  verifyStored(userId: string, binding: string, s: StoredAssertion | undefined | null): { ok: true; credentialFingerprint: string } | { ok: false; reason: string } {
    if (!this.status.established) return { ok: false, reason: `human confirmation unavailable: ${this.status.reason}` };
    if (!s || typeof s !== "object" || [s.credentialId, s.clientDataJSON, s.authenticatorData, s.signature, s.nonce].some((x) => typeof x !== "string" || !x)) return { ok: false, reason: "no stored assertion" };
    const cred = this.authenticatorsFor(userId).find((c) => c.credentialId === s.credentialId);
    if (!cred) return { ok: false, reason: "unknown authenticator for this owner" };
    let client: { type?: string; challenge?: string; origin?: string; crossOrigin?: boolean }; let cdj: Buffer, ad: Buffer, sig: Buffer;
    try { cdj = Buffer.from(s.clientDataJSON, "base64url"); ad = Buffer.from(s.authenticatorData, "base64url"); sig = Buffer.from(s.signature, "base64url"); client = JSON.parse(cdj.toString("utf8")); }
    catch { return { ok: false, reason: "malformed stored assertion" }; }
    if (client.type !== "webauthn.get" || client.challenge !== challengeFor(binding, s.nonce)) return { ok: false, reason: "the stored assertion is not bound to this resolution" };
    if (!client.origin || !this.origins.includes(client.origin) || client.crossOrigin) return { ok: false, reason: "assertion origin not allowed" };
    if (ad.length < 37 || !ad.subarray(0, 32).equals(sha(this.rpId))) return { ok: false, reason: "wrong relying party" };
    if ((ad[32]! & 0x01) === 0 || (ad[32]! & 0x04) === 0) return { ok: false, reason: "user presence and user verification are both required" };
    let good = false;
    try { good = verifySig("sha256", Buffer.concat([ad, sha(cdj)]), createPublicKey({ key: Buffer.from(cred.publicKeySpki, "base64"), format: "der", type: "spki" }), sig); } catch { good = false; }
    return good ? { ok: true, credentialFingerprint: sha(cred.credentialId).toString("hex").slice(0, 16) } : { ok: false, reason: "signature does not verify" };
  }
}

function validate(r: unknown): OwnerRegistry {
  const reg = r as OwnerRegistry;
  if (!reg || reg.schema !== "diaporia.owner-registry.v1" || !Array.isArray(reg.owners)) throw new Error("schema");
  for (const o of reg.owners) {
    if (typeof o.userId !== "string" || !o.userId) throw new Error("userId");
    for (const h of o.ownerKeySha256 ?? []) if (!/^[0-9a-f]{64}$/i.test(h)) throw new Error("ownerKeySha256");
    for (const a of o.authenticators ?? []) {
      if (a.alg !== -7 || typeof a.credentialId !== "string" || typeof a.publicKeySpki !== "string") throw new Error("authenticator");
      const k = createPublicKey({ key: Buffer.from(a.publicKeySpki, "base64"), format: "der", type: "spki" });
      if (k.asymmetricKeyType !== "ec") throw new Error("authenticator key type");
    }
  }
  return reg;
}
