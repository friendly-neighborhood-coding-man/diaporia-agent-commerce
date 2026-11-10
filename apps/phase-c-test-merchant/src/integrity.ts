import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Code pinning and owner authentication for Phase C approvals.
 *
 * - Artifact hash: SHA-256 over every file the merchant process serves or executes from its own code (src dir it runs
 *   from, the public dir). It is part of the approval digest, so a merchant built from other code refuses to start.
 * - Owner signature: an Ed25519 signature by the OWNER's key over a purpose-tagged digest. A SHA-256 digest alone is a
 *   checksum anyone can recompute; the signature is what shows the owner approved it. The private key never reaches the
 *   operator host; only the public key (its SPKI SHA-256 is in the statement) is configured there.
 */

export const SRC_DIR = fileURLToPath(new URL("./", import.meta.url));
// Source run (tsx): ../public. Built run (dist-merchant/apps/phase-c-test-merchant/src): the repo's public dir.
export const PUBLIC_DIR = [new URL("../public/", import.meta.url), new URL("../../../../apps/phase-c-test-merchant/public/", import.meta.url)]
  .map((u) => fileURLToPath(u)).find((d) => existsSync(`${d}checkout.js`)) ?? fileURLToPath(new URL("../public/", import.meta.url));

/** Deterministic tree hash: sorted "label/relative-path NUL sha256(content)" lines. Same function on both sides. */
export function hashTree(roots: Record<string, string>): string {
  const lines: string[] = [];
  for (const label of Object.keys(roots).sort()) {
    const root = roots[label]!;
    const walk = (d: string) => {
      for (const n of readdirSync(d).sort()) {
        const f = join(d, n);
        if (statSync(f).isDirectory()) walk(f);
        else lines.push(`${label}/${relative(root, f).split("\\").join("/")}\0${createHash("sha256").update(readFileSync(f)).digest("hex")}`);
      }
    };
    walk(root);
  }
  lines.sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

export const merchantArtifactSha256 = (srcDir = SRC_DIR, publicDir = PUBLIC_DIR): string => hashTree({ src: srcDir, public: publicDir });

export type SignedPurpose = "approval" | "capture-retry";
export const signedMessage = (purpose: SignedPurpose, digest: string): string =>
  purpose === "approval" ? `diaporia.phase-c.approval.v3:${digest}` : `diaporia.phase-c.capture-retry.v1:${digest}`;

export function loadOwnerPublicKey(pem: string): { key: KeyObject; sha256: string } {
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("owner key must be Ed25519");
  return { key, sha256: createHash("sha256").update(key.export({ type: "spki", format: "der" })).digest("hex") };
}

export function ownerSignatureValid(key: KeyObject, purpose: SignedPurpose, digest: string, signatureB64: unknown): boolean {
  if (typeof signatureB64 !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(signatureB64.trim())) return false;
  try { return verify(null, Buffer.from(signedMessage(purpose, digest)), key, Buffer.from(signatureB64.trim(), "base64")); } catch { return false; }
}
