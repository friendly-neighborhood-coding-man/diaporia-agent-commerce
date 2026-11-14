/**
 * OWNER-SIDE, offline. Run on the owner's own machine; the private key never goes to the operator host.
 *
 *   npm run phase-c:sign -- --gen-key <dir>                    # writes owner-ed25519.pem (0600) + owner-ed25519.pub.pem
 *   npm run phase-c:sign -- --key <owner-ed25519.pem> --purpose approval --digest <64 hex>
 *   npm run phase-c:sign -- --key <owner-ed25519.pem> --purpose capture-retry --digest <64 hex>
 *
 * Read the printed statement before signing: the signature is the owner's approval of exactly that digest.
 */
import { generateKeyPairSync, createPrivateKey, sign } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { signedMessage, type SignedPurpose } from "../apps/phase-c-test-merchant/src/integrity.js";

const arg = (k: string): string | undefined => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
const fail = (m: string): never => { console.error(m); process.exit(2); };
const genDir = arg("gen-key");
if (genDir) {
  const priv = join(genDir, "owner-ed25519.pem"), pub = join(genDir, "owner-ed25519.pub.pem");
  if (existsSync(priv)) fail(`${priv} exists; refusing to overwrite`);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  writeFileSync(priv, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  writeFileSync(pub, publicKey.export({ type: "spki", format: "pem" }));
  console.log(`wrote ${priv} (keep it private) and ${pub} (give this one to the operator)`);
  process.exit(0);
}
const purpose = arg("purpose") as SignedPurpose;
if (purpose !== "approval" && purpose !== "capture-retry") fail("--purpose approval|capture-retry is required");
const digest = (arg("digest") ?? "").toLowerCase();
if (!/^[a-f0-9]{64}$/.test(digest)) fail("--digest <64 hex> is required");
const key = createPrivateKey(readFileSync(arg("key") ?? fail("--key <owner-ed25519.pem> is required"), "utf8"));
console.log(sign(null, Buffer.from(signedMessage(purpose, digest)), key).toString("base64"));
