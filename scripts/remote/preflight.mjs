// Gate A3 preflight, run ON THE SERVER before the first `docker compose up` (and before every redeploy).
// Read-only: inspects files, git and Docker; changes nothing. Exit 0 = all checks pass, 1 = refuse.
//   node scripts/remote/preflight.mjs [--env deploy/remote-mcp/.env] [--redeploy]
// --redeploy allows an existing app-data volume (rollback/upgrade); the first deployment needs a fresh one.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const a = process.argv.slice(2); const arg = (n, d) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : d; };
// Relative paths in the stack env are resolved by compose against deploy/remote-mcp (the compose file's directory).
const base = resolve(dirname(fileURLToPath(import.meta.url)), "../../deploy/remote-mcp");
const envPath = resolve(arg("--env", join(base, ".env")));
const out = []; const check = (name, ok, detail = "") => { out.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  -- ${detail}`}`); };
const parseEnv = (p) => Object.fromEntries(readFileSync(p, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#") && l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const sh = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; } };
const rel = (p) => (isAbsolute(p) ? p : join(base, p));

if (!existsSync(envPath)) { check(`stack env ${envPath} exists`, false); process.exit(1); }
const env = parseEnv(envPath);
const host = env.MCP_HOSTNAME ?? "";
check("MCP_HOSTNAME is a public DNS name (not .test/.local/localhost/IP)", /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(host) && !/\.(test|local|localhost|invalid|example)$/i.test(host) && !/^\d+(\.\d+){3}$/.test(host), host);
check("MCP_HOSTNAME is not one of the existing DIAPORIA hostnames", !["diaporia.com", "www.diaporia.com", "bot.diaporia.com", "phase-c.diaporia.com"].includes(host.toLowerCase()), host);
const edge = env.CADDY_EDGE ?? "";
check("CADDY_EDGE is direct or cloudflare (local is for emulation only)", edge === "direct" || edge === "cloudflare", edge || "(unset)");
if (edge === "direct") check("CADDY_EMAIL set for ACME", /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(env.CADDY_EMAIL ?? "") && !/invalid|example/.test(env.CADDY_EMAIL ?? ""), env.CADDY_EMAIL);
if (edge === "cloudflare") {
  const ips = join(rel(env.CADDY_EDGE_DIR ?? "./edge"), "cloudflare-ips.caddy");
  const txt = existsSync(ips) ? readFileSync(ips, "utf8") : "";
  const when = Date.parse((txt.match(/Retrieved: (\S+)/) ?? [])[1] ?? "");
  check("edge/cloudflare-ips.caddy generated from Cloudflare's official lists within 7 days", !!txt && /^trusted_proxies static /m.test(txt) && Date.now() - when < 7 * 864e5, txt ? "stale or malformed" : "missing");
  const certs = rel(env.ORIGIN_CERT_DIR ?? "./certs");
  for (const f of ["origin.pem", "origin.key", "origin-pull-ca.pem"]) check(`origin certificate file ${f} present`, existsSync(join(certs, f)));
}
for (const k of ["PUBLISH_HTTP", "PUBLISH_HTTPS"]) check(`${k} binds IPv4 0.0.0.0 explicitly (no Docker IPv6 userland proxy)`, /^0\.0\.0\.0:\d+$/.test(env[k] ?? ""), env[k] ?? "(unset: compose default 0.0.0.0)");
check("DIAPORIA_REVOKE_ALL_GRANTS_ON_START is 0", (env.DIAPORIA_REVOKE_ALL_GRANTS_ON_START ?? "0") === "0");

const secrets = rel(env.DIAPORIA_SECRETS_FILE ?? "./secrets/app.env");
if (existsSync(secrets)) {
  const mode = statSync(secrets).mode & 0o777;
  check("secrets file mode is 0600 or stricter", (mode & 0o077) === 0, mode.toString(8));
  const s = parseEnv(secrets);
  check("secrets file holds only DIAPORIA_OWNER_KEYS and DIAPORIA_OAUTH_CLIENTS", Object.keys(s).every((k) => ["DIAPORIA_OWNER_KEYS", "DIAPORIA_OAUTH_CLIENTS"].includes(k)), Object.keys(s).join(","));
  check("every owner key is drk_ + 43 base64url characters", (s.DIAPORIA_OWNER_KEYS ?? "").split(";").filter(Boolean).every((e) => /^drk_[A-Za-z0-9_-]{43}=[a-z0-9][a-z0-9_-]*$/i.test(e.trim())));
  check("OAuth clients registered (hashes only)", (s.DIAPORIA_OAUTH_CLIENTS ?? "").split(";").filter(Boolean).every((e) => /^dcl_[0-9a-f]{32}\|[0-9a-f]{64}\|/.test(e.trim())) && !!s.DIAPORIA_OAUTH_CLIENTS);
} else check(`secrets file ${secrets} exists`, false);

const head = sh("git", ["rev-parse", "HEAD"]); const dirty = sh("git", ["status", "--porcelain", "--untracked-files=no"]);
check("git checkout is clean", dirty === "", dirty ?? "git unavailable");
check("DIAPORIA_IMAGE_TAG equals the checked-out commit", !!head && env.DIAPORIA_IMAGE_TAG === head, `${env.DIAPORIA_IMAGE_TAG} vs ${head}`);
const project = "diaporia-remote-mcp";
const vol = sh("docker", ["volume", "inspect", `${project}_app-data`, "--format", "{{.CreatedAt}}"]);
if (a.includes("--redeploy")) console.log(`INFO  app-data volume ${vol ? `exists (created ${vol})` : "absent"}; --redeploy given`);
else check("app-data volume is absent (first deployment starts from a fresh database; IR-07/Gate R g)", vol === null, `exists, created ${vol}`);
const ports = sh("ss", ["-Htln"]);
if (ports !== null) check("nothing else listens on :80/:443 on this server", !/[:.](80|443)\s/.test(ports.split("\n").filter((l) => !/docker-proxy/.test(l)).join("\n")));
const failed = out.filter((x) => !x.ok).length;
console.log(`${failed ? "REFUSE" : "OK"}: ${out.length - failed}/${out.length} preflight checks`);
process.exit(failed ? 1 : 0);
