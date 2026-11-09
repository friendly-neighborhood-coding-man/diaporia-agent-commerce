#!/usr/bin/env node
/**
 * Four-host interoperability AUDIT PROXY (test tooling only; no commerce logic).
 *
 * A transparent loopback HTTP proxy in front of the unchanged DIAPORIA MCP server. It forwards every
 * byte unchanged and appends one JSON line per request to an audit file:
 * time, host label (looked up from a SHA-256 fingerprint of the bearer token; the token itself is never
 * written), User-Agent, JSON-RPC method, tool name and arguments, HTTP status, and the response body.
 *
 *   node scripts/interop/audit-proxy.mjs --listen 18790 --target 18791 --out .data/interop/audit.jsonl \
 *        --labels .data/interop/token-labels.json
 *
 * token-labels.json maps token fingerprints (first 12 hex chars of sha256(token)) to host labels.
 * Both ports are bound to 127.0.0.1 only.
 */
import { createServer, request as httpRequest } from "node:http";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const listen = Number(arg("listen", 18790));
const target = Number(arg("target", 18791));
const out = arg("out", ".data/interop/audit.jsonl");
const labels = JSON.parse(readFileSync(arg("labels", ".data/interop/token-labels.json"), "utf8"));
mkdirSync(dirname(out), { recursive: true });

const fp = (auth) => {
  const m = /^Bearer (.+)$/.exec(auth ?? "");
  return m ? createHash("sha256").update(m[1]).digest("hex").slice(0, 12) : null;
};
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };
/** Streamable HTTP may answer with JSON or an SSE stream; collect the JSON-RPC messages from either. */
const messages = (body, type) => {
  if ((type ?? "").includes("text/event-stream")) {
    return body.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => parse(l.slice(5).trim())).filter(Boolean);
  }
  const j = parse(body);
  return j == null ? [] : Array.isArray(j) ? j : [j];
};

createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const reqBody = Buffer.concat(chunks);
    const started = new Date().toISOString();
    const fingerprint = fp(req.headers.authorization);
    const rpc = messages(reqBody.toString("utf8"), "application/json");
    const headers = { ...req.headers, host: `127.0.0.1:${target}` };
    const up = httpRequest({ host: "127.0.0.1", port: target, method: req.method, path: req.url, headers }, (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, upRes.headers);
      const rchunks = [];
      upRes.on("data", (c) => { rchunks.push(c); res.write(c); });
      upRes.on("end", () => {
        res.end();
        const resBody = Buffer.concat(rchunks).toString("utf8");
        const record = {
          time: started,
          host: fingerprint ? (labels[fingerprint] ?? `UNKNOWN_TOKEN(${fingerprint})`) : "NO_TOKEN",
          tokenFingerprint: fingerprint,
          userAgent: req.headers["user-agent"] ?? null,
          mcpProtocolVersion: req.headers["mcp-protocol-version"] ?? null,
          httpMethod: req.method, path: req.url, status: upRes.statusCode,
          requests: rpc.map((m) => ({ id: m.id ?? null, method: m.method, tool: m.params?.name ?? null, arguments: m.params?.arguments ?? null,
            clientInfo: m.params?.clientInfo ?? null, protocolVersion: m.params?.protocolVersion ?? null })),
          responses: messages(resBody, upRes.headers["content-type"]),
        };
        appendFileSync(out, JSON.stringify(record) + "\n");
      });
    });
    up.on("error", (e) => { res.writeHead(502); res.end(); appendFileSync(out, JSON.stringify({ time: started, proxyError: String(e) }) + "\n"); });
    up.end(reqBody);
  });
}).listen(listen, "127.0.0.1", () => console.log(`[interop-proxy] 127.0.0.1:${listen} -> 127.0.0.1:${target}, audit ${out}`));
