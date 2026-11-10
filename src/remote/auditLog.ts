import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { clientIp } from "../http/server.js";

/**
 * One JSON line per HTTP request. Logs the path only (never the query string, headers, bodies,
 * tokens, codes or owner keys). Client addresses are salted hashes; the salt is per process.
 */
export interface AuditEvent { ts: string; event: "http"; method: string; route: string; status: number; ms: number; client: string; mcpAuth?: "bearer" | "none" }

const ROUTES: [RegExp, string][] = [
  [/^\/mcp$/, "/mcp"], [/^\/healthz$/, "/healthz"],
  [/^\/\.well-known\/oauth-protected-resource(\/mcp)?$/, "/.well-known/oauth-protected-resource"],
  [/^\/\.well-known\/oauth-authorization-server$/, "/.well-known/oauth-authorization-server"],
  [/^\/oauth\/(register|authorize|token|revoke)$/, "/oauth/$1"],
];
/** Map a path to a fixed route label, so ids or attacker-chosen paths never reach the log verbatim. */
export function routeLabel(pathname: string): string {
  for (const [re, label] of ROUTES) { const m = re.exec(pathname); if (m) return label.replace("$1", m[1] ?? ""); }
  return "other";
}

export function attachAuditLog(server: Server, trustedProxies: ReadonlySet<string>, write: (line: string) => void = (l) => process.stdout.write(l + "\n")) {
  const salt = randomBytes(16);
  server.on("request", (req: IncomingMessage, res: ServerResponse) => {
    const start = process.hrtime.bigint();
    res.on("finish", () => {
      let path = "/";
      try { path = new URL(req.url ?? "/", "http://x").pathname; } catch { /* keep "/" */ }
      const route = routeLabel(path);
      const ev: AuditEvent = {
        ts: new Date().toISOString(), event: "http", method: (req.method ?? "?").slice(0, 8), route, status: res.statusCode,
        ms: Number((process.hrtime.bigint() - start) / 1_000_000n),
        client: createHash("sha256").update(salt).update(clientIp(req, trustedProxies)).digest("hex").slice(0, 12),
      };
      if (route === "/mcp") ev.mcpAuth = req.headers.authorization ? "bearer" : "none";
      write(JSON.stringify(ev));
    });
  });
}
