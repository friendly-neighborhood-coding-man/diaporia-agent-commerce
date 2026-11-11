/**
 * R-A test support: a SIMULATED HUMAN'S passkey (a P-256 platform authenticator with user verification). Its private key
 * lives only in this object, which the tests hand to the simulated human, never to the simulated AI client. The server
 * side sees only the public key (OwnerRegistry entry), exactly as with a real authenticator.
 */
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { OwnerConfirmationBoundary, type OwnerRegistry, type OwnerAuthenticator } from "../../src/auth/OwnerConfirmation.js";

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest();

export class SimulatedPasskey {
  readonly credentialId = randomBytes(16).toString("base64url");
  readonly publicKeySpki: string;
  private readonly privateKey: KeyObject;
  counter = 0;
  constructor(readonly userId: string) {
    const kp = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.privateKey = kp.privateKey;
    this.publicKeySpki = kp.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  }
  entry(): OwnerAuthenticator { return { credentialId: this.credentialId, publicKeySpki: this.publicKeySpki, alg: -7, label: `${this.userId} test passkey` }; }

  /** What navigator.credentials.get() returns after the human verifies (flags UP|UV unless overridden). */
  assert(challenge: string, o: { origin: string; rpId: string; userVerified?: boolean; type?: string; counter?: number; crossOrigin?: boolean }) {
    const clientDataJSON = Buffer.from(JSON.stringify({ type: o.type ?? "webauthn.get", challenge, origin: o.origin, ...(o.crossOrigin ? { crossOrigin: true } : {}) }));
    const count = o.counter ?? ++this.counter;
    const ad = Buffer.alloc(37);
    sha(o.rpId).copy(ad, 0);
    ad[32] = 0x01 | (o.userVerified === false ? 0 : 0x04);
    ad.writeUInt32BE(count, 33);
    const signature = sign("sha256", Buffer.concat([ad, sha(clientDataJSON)]), this.privateKey);
    return { credentialId: this.credentialId, clientDataJSON: clientDataJSON.toString("base64url"), authenticatorData: ad.toString("base64url"), signature: signature.toString("base64url") };
  }
}

/** One passkey per test user, created once per test process. */
export const PASSKEYS = { alice: new SimulatedPasskey("alice"), bob: new SimulatedPasskey("bob") };

export function testRegistry(passkeys: SimulatedPasskey[] = Object.values(PASSKEYS), ownerKeySha256: Record<string, string[]> = {}): OwnerRegistry {
  const users = [...new Set(passkeys.map((p) => p.userId))];
  return { schema: "diaporia.owner-registry.v1", owners: users.map((userId) => ({ userId, ownerKeySha256: ownerKeySha256[userId] ?? [], authenticators: passkeys.filter((p) => p.userId === userId).map((p) => p.entry()) })) };
}

/** The test-only in-process boundary for a harness on `baseUrl` (the private keys stay with the simulated humans). */
export function testBoundary(baseUrl: string, now?: () => number, passkeys?: SimulatedPasskey[]) {
  const u = new URL(baseUrl);
  return OwnerConfirmationBoundary.testOnlyInProcess(testRegistry(passkeys), u.hostname, [u.origin], now);
}

/** Reads the passkey step out of the owner review page (what the page's script reads). */
export function passkeyStep(reviewHtml: string) {
  const m = /<form method="post" id="confirm" data-challenge="([^"]+)" data-rpid="([^"]+)" data-credentials="([^"]*)">/.exec(reviewHtml);
  return m ? { challenge: m[1]!, rpId: m[2]!, credentialIds: m[3]!.split(",").filter(Boolean) } : null;
}

/**
 * In-process tests of the gateway's owner method: the simulated human's passkey answers a challenge from a test-only
 * boundary, and the boundary returns the proof object that confirmResearchHoldAsOwner requires.
 */
export function inProcessHumanProof(userId: "alice" | "bob", binding: string) {
  const b = testBoundary("http://127.0.0.1:1");
  const challenge = b.newChallenge(userId, binding);
  const v = b.verifyAssertion(userId, binding, PASSKEYS[userId].assert(challenge, { origin: "http://127.0.0.1:1", rpId: "127.0.0.1" }));
  if (!v.ok) throw new Error(v.reason);
  return v.proof;
}
