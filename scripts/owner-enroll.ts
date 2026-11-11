/**
 * R-A owner enrollment. Run by the HUMAN OWNER as a SEPARATE OS account from the one that runs the DIAPORIA server and
 * the AI host (for example a dedicated `diaporia-owner` user, or an administrator). It writes the owner registry that the
 * server reads through DIAPORIA_OWNER_REGISTRY (src/auth/OwnerConfirmation.ts): owner-key SHA-256 hashes and passkey
 * PUBLIC keys only. The server refuses the registry unless it and every directory above it are outside the server's
 * working tree and data directory, not owned by the server's OS user and not writable by others.
 *
 *   npx tsx scripts/owner-enroll.ts --registry /etc/diaporia/owners.json --user demo-user --new-owner-key
 *       prints a new owner key ONCE (keep it yourself, e.g. in your password manager); only its hash is stored.
 *   npx tsx scripts/owner-enroll.ts --registry /etc/diaporia/owners.json --add-passkey '<JSON from /research-holds/passkey-setup>'
 *       enrolls the passkey you created on that page (public key only).
 *   npx tsx scripts/owner-enroll.ts --registry /etc/diaporia/owners.json --list
 *
 * Never let an AI assistant run this for you, and never paste the owner key into an AI conversation.
 */
import { createHash, createPublicKey } from "node:crypto";
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { randomSecret } from "../src/auth/devAuth.js";
import type { OwnerRegistry } from "../src/auth/OwnerConfirmation.js";

const { values } = parseArgs({ options: { registry: { type: "string" }, user: { type: "string" }, "new-owner-key": { type: "boolean", default: false },
  "add-passkey": { type: "string" }, list: { type: "boolean", default: false }, "repo-root": { type: "string", default: resolve(dirname(new URL(import.meta.url).pathname), "..") } } });
const die = (m: string): never => { console.error(`owner-enroll: ${m}`); process.exit(2); };
const path = values.registry ?? die("--registry <absolute path outside the DIAPORIA folder> is required");
if (!isAbsolute(path)) die("the registry path must be absolute");
const rel = relative(values["repo-root"]!, resolve(path));
if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) die("the registry must be outside the DIAPORIA folder (the AI host can reach that folder)");
const repoOwner = statSync(values["repo-root"]!).uid;
if (typeof process.getuid === "function" && process.getuid() === repoOwner)
  console.warn(`owner-enroll: WARNING you are running as the OS user that owns the DIAPORIA folder (uid ${repoOwner}). If the server also runs as this user, it will refuse this registry. Run this as the separate owner account.`);

const reg: OwnerRegistry = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { schema: "diaporia.owner-registry.v1", owners: [] };
const ownerOf = (userId: string) => reg.owners.find((o) => o.userId === userId) ?? (reg.owners.push({ userId, ownerKeySha256: [], authenticators: [] }), reg.owners[reg.owners.length - 1]!);
const save = () => { writeFileSync(path, JSON.stringify(reg, null, 2) + "\n", { mode: 0o644 }); chmodSync(path, 0o644); };

if (values.list) {
  for (const o of reg.owners) console.log(`${o.userId}: ${(o.ownerKeySha256 ?? []).length} owner key(s), passkeys: ${(o.authenticators ?? []).map((a) => a.label ?? a.credentialId.slice(0, 8)).join(", ") || "none"}`);
} else if (values["new-owner-key"]) {
  const user = values.user ?? die("--user <the DIAPORIA user id, e.g. demo-user> is required");
  const key = randomSecret("dok");
  (ownerOf(user).ownerKeySha256 ??= []).push(createHash("sha256").update(key).digest("hex"));
  save();
  console.log(`New owner key for "${user}" (shown once, not stored anywhere): ${key}`);
  console.log("Keep it yourself. Restart the DIAPORIA server to load the registry.");
} else if (values["add-passkey"]) {
  const p = JSON.parse(values["add-passkey"]) as { userId?: string; credentialId?: string; publicKeySpki?: string; alg?: number };
  const user = values.user ?? p.userId ?? die("--user is required");
  if (p.alg !== -7 || !p.credentialId || !p.publicKeySpki) die("expected {credentialId, publicKeySpki, alg: -7} from the passkey setup page");
  if (createPublicKey({ key: Buffer.from(p.publicKeySpki!, "base64"), format: "der", type: "spki" }).asymmetricKeyType !== "ec") die("only ES256 (P-256) passkeys are supported");
  (ownerOf(user).authenticators ??= []).push({ credentialId: p.credentialId!, publicKeySpki: p.publicKeySpki!, alg: -7, label: `passkey ${new Date().toISOString().slice(0, 10)}` });
  save();
  console.log(`Passkey enrolled for "${user}". Restart the DIAPORIA server to load it.`);
} else die("choose --new-owner-key, --add-passkey or --list");
