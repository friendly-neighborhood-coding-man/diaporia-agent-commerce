// Deployment manifest, run ON THE SERVER right after `docker compose up` at gate A3 (and after every
// redeploy or rollback). Read-only. Prints JSON with no secrets: owner keys and client secrets never
// appear, only user ids, client ids, redirect URIs and digests.
//   node scripts/remote/manifest.mjs --window-end 2026-11-20T12:00:00Z [--env deploy/remote-mcp/.env] > manifest.json
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const a = process.argv.slice(2); const arg = (n, d) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : d; };
const base = resolve(dirname(fileURLToPath(import.meta.url)), "../../deploy/remote-mcp");
const envPath = resolve(arg("--env", join(base, ".env")));
const windowEnd = arg("--window-end");
if (!windowEnd || Number.isNaN(Date.parse(windowEnd))) { console.error("--window-end <ISO-8601 UTC> is required"); process.exit(2); }
const parseEnv = (p) => Object.fromEntries(readFileSync(p, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#") && l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const sh = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; } };
const sha = (p) => (existsSync(p) ? createHash("sha256").update(readFileSync(p)).digest("hex") : null);
const rel = (p) => (isAbsolute(p) ? p : join(base, p));
const env = parseEnv(envPath); const project = "diaporia-remote-mcp";
const secrets = parseEnv(rel(env.DIAPORIA_SECRETS_FILE ?? "./secrets/app.env"));
const edgeDir = rel(env.CADDY_EDGE_DIR ?? "./edge");
const dc = ["compose", "-f", join(base, "compose.yaml"), "--env-file", envPath];
const startup = (sh("docker", [...dc, "logs", "--no-color", "app"]) ?? "").split("\n").map((l) => l.slice(l.indexOf("{"))).filter((l) => l.includes('"event":"startup"')).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).at(-1) ?? null;
const container = (svc) => sh("docker", [...dc, "ps", "-q", svc]);
const imageOf = (svc) => { const id = container(svc); return id ? sh("docker", ["inspect", id, "--format", "{{.Image}}"]) : null; };
const manifest = {
  kind: "diaporia-remote-mcp-readonly-deployment", generatedAt: new Date().toISOString(), windowEnd: new Date(windowEnd).toISOString(),
  git: { commit: sh("git", ["rev-parse", "HEAD"]), clean: sh("git", ["status", "--porcelain", "--untracked-files=no"]) === "" },
  hostname: env.MCP_HOSTNAME, resource: `https://${env.MCP_HOSTNAME}/mcp`, edgeMode: env.CADDY_EDGE,
  images: { app: { tag: `diaporia-remote-mcp:${env.DIAPORIA_IMAGE_TAG}`, id: imageOf("app") }, caddy: { id: imageOf("caddy") } },
  files: Object.fromEntries([["compose.yaml", join(base, "compose.yaml")], ["Caddyfile", join(base, "Caddyfile")],
    ...readdirSync(edgeDir).filter((f) => f.endsWith(".caddy")).map((f) => [`edge/${f}`, join(edgeDir, f)])].map(([k, p]) => [k, sha(p)])),
  startup: startup && { configDigest: startup.configDigest, paymentExecutionEnabled: startup.paymentExecutionEnabled, research: startup.research, scopes: startup.scopes,
    registration: startup.registration, grantsBoundToOwnerKey: startup.grantsBoundToOwnerKey, housekeeping: startup.housekeeping },
  users: (secrets.DIAPORIA_OWNER_KEYS ?? "").split(";").filter(Boolean).map((e) => e.slice(e.lastIndexOf("=") + 1)),
  clients: (secrets.DIAPORIA_OAUTH_CLIENTS ?? "").split(";").filter(Boolean).map((e) => { const [id, , user, redirects, ...n] = e.split("|"); return { id, user, redirects: redirects.split(","), name: n.join("|") }; }),
  limits: Object.fromEntries(Object.entries(env).filter(([k]) => /^DIAPORIA_(WEB|MCP)_RATE|^DIAPORIA_GRANT_MAX_AGE|^DIAPORIA_REVOKE_ALL/.test(k))),
  appDataVolumeCreatedAt: sh("docker", ["volume", "inspect", `${project}_app-data`, "--format", "{{.CreatedAt}}"]),
};
const problems = [];
if (!manifest.git.clean) problems.push("git checkout not clean");
if (env.DIAPORIA_IMAGE_TAG !== manifest.git.commit) problems.push("image tag differs from commit");
if (!startup) problems.push("no startup line in app log");
else if (startup.paymentExecutionEnabled !== false || startup.registration !== "closed" || startup.grantsBoundToOwnerKey !== true) problems.push("startup line does not show the read-only profile");
manifest.problems = problems;
process.stdout.write(JSON.stringify(manifest, null, 2) + "\n");
process.exit(problems.length ? 1 : 0);
