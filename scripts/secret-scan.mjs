// Minimal tracked-file secret scan (CI also runs gitleaks). Exits 1 on findings.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
const RULES = [
  ["PayPal access token", /A21AA[A-Za-z0-9_-]{40,}/],
  ["PayPal client id/secret assignment", /PAYPAL_CLIENT_(?:ID|SECRET)[ \t]*=[ \t]*[A-Za-z0-9_-]{20,}/],
  ["Generic API key assignment", /(?:API_KEY|SECRET|TOKEN)[ \t]*=[ \t]*["']?[A-Za-z0-9_\-]{24,}/],
  ["Private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["OpenAI/Anthropic-style key", /\bsk-(?:ant-)?[A-Za-z0-9_-]{24,}/],
  ["Generated DIAPORIA dev credential", /\bd(?:ct|ok)_[A-Za-z0-9_-]{32}\b/],
  ["Generated DIAPORIA remote owner key", /\bdrk_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/],
];
const findings = [];
for (const f of files) {
  if (/^(package-lock\.json|.*\.(png|jpg|pdf|zip))$/.test(f)) continue;
  if (/^\.env($|\.)/.test(f) && f !== ".env.example") findings.push(`${f}: env file must not be tracked`);
  let text; try { text = readFileSync(f, "utf8"); } catch { continue; }
  for (const [name, re] of RULES) if (re.test(text)) findings.push(`${f}: ${name}`);
}
if (findings.length) { console.error("Secret scan findings:\n" + findings.join("\n")); process.exit(1); }
console.log(`Secret scan: ${files.length} tracked files, no findings.`);
