import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { MerchantCheckoutRecipe } from "./recipes.js";

/**
 * DIAPORIA-side check of a Phase C owner approval before any KERNEL browser can exist.
 * Kept independent of apps/phase-c-test-merchant (DIAPORIA's build only contains src/); tests prove the canonical form,
 * tree hash and signed message are identical on both sides.
 *
 * Verifies: the statement file hashes to PHASE_C_APPROVED_DIGEST; the owner's Ed25519 signature over that digest; THIS
 * process's code (diaporiaArtifactSha256), host and OS user; the recipe's origin and exact egress list; expiry.
 */
export const DIAPORIA_SRC_ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // src/ (tsx) or dist/src/ (built)

export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}
const sha256 = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");

export function hashTree(roots: Record<string, string>): string {
  const lines: string[] = [];
  for (const label of Object.keys(roots).sort()) {
    const root = roots[label]!;
    const walk = (d: string) => {
      for (const n of readdirSync(d).sort()) {
        const f = join(d, n);
        if (statSync(f).isDirectory()) walk(f);
        else lines.push(`${label}/${relative(root, f).split("\\").join("/")}\0${sha256(readFileSync(f))}`);
      }
    };
    walk(root);
  }
  lines.sort();
  return sha256(lines.join("\n"));
}
export const diaporiaArtifactSha256 = (root = DIAPORIA_SRC_ROOT): string => hashTree({ src: root });

export interface VerifiedPhaseCApproval { digest: string; gate: string; maxWallMs: number; expiresAtMs: number; kernelBrowsers: number }

export function verifyPhaseCApproval(env: NodeJS.ProcessEnv, recipe: MerchantCheckoutRecipe,
  o: { now?: number; artifactSha256?: string; host?: string; user?: string } = {}): VerifiedPhaseCApproval {
  const fail = (m: string): never => { throw new Error(`Phase C KERNEL approval refused: ${m}`); };
  const digest = (env.PHASE_C_APPROVED_DIGEST ?? "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(digest)) fail("PHASE_C_APPROVED_DIGEST (the owner-approved C1/C2 digest) is required");
  if (!env.PHASE_C_APPROVAL_STATEMENT_FILE) fail("PHASE_C_APPROVAL_STATEMENT_FILE (the statement printed by npm run phase-c:approval) is required");
  if (!env.PHASE_C_OWNER_PUBLIC_KEY_FILE) fail("PHASE_C_OWNER_PUBLIC_KEY_FILE is required");
  let st: any;
  try { const j = JSON.parse(readFileSync(env.PHASE_C_APPROVAL_STATEMENT_FILE!, "utf8")); st = j?.statement ?? j; } catch { fail("statement file unreadable"); }
  if (st?.schema !== "diaporia.phase-c.approval.v3" || (st.gate !== "C1" && st.gate !== "C2")) fail("unknown statement schema or gate");
  if (sha256(canonicalJson(st)) !== digest) fail("statement does not hash to PHASE_C_APPROVED_DIGEST");
  let key;
  try { key = createPublicKey(readFileSync(env.PHASE_C_OWNER_PUBLIC_KEY_FILE!, "utf8")); } catch { fail("owner public key unreadable"); }
  if (key!.asymmetricKeyType !== "ed25519" || sha256(key!.export({ type: "spki", format: "der" })) !== st.ownerPublicKeySha256) fail("owner public key does not match the statement");
  const sig = (env.PHASE_C_APPROVAL_SIGNATURE ?? "").trim();
  let ok = false;
  try { ok = /^[A-Za-z0-9+/]{86}==$/.test(sig) && verify(null, Buffer.from(`diaporia.phase-c.approval.v3:${digest}`), key!, Buffer.from(sig, "base64")); } catch { ok = false; }
  if (!ok) fail("PHASE_C_APPROVAL_SIGNATURE is not the owner's signature of this digest");
  const now = o.now ?? Date.now();
  const expiresAtMs = Date.parse(st.expiresAt);
  if (!(expiresAtMs > now)) fail("approval expired");
  if ((o.artifactSha256 ?? diaporiaArtifactSha256()) !== st.diaporiaArtifactSha256) fail("this DIAPORIA build is not the approved artifact (diaporiaArtifactSha256)");
  if ((o.host ?? hostname()) !== st.diaporiaHost) fail(`this host is not the approved DIAPORIA host (${st.diaporiaHost})`);
  if ((o.user ?? userInfo().username) !== st.diaporiaServiceUser) fail(`this OS user is not the approved DIAPORIA service user (${st.diaporiaServiceUser})`);
  if (new URL(recipe.origin).origin !== st.merchantOrigin) fail("recipe origin differs from the approved merchant origin");
  if (canonicalJson(recipe.networkAllowedHosts ?? null) !== canonicalJson(st.kernelEgressHosts)) fail("recipe egress hosts differ from the approved kernelEgressHosts");
  if (st.kernelBrowsers !== 1 || !Number.isInteger(st.maxMinutes) || st.maxMinutes < 1 || st.maxMinutes > 10) fail("browser count or minutes out of bounds");
  return { digest, gate: st.gate, maxWallMs: st.maxMinutes * 60_000, expiresAtMs, kernelBrowsers: 1 };
}
