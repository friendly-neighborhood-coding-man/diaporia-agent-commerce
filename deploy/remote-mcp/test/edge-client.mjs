// Edge test only: runs the cases for one source address against Caddy and prints one JSON line per case.
//   node edge-client.mjs <cases.json> <source>
import { readFileSync } from "node:fs";
import https from "node:https";
import http from "node:http";
const [file, source] = process.argv.slice(2);
const cases = JSON.parse(readFileSync(file, "utf8")).filter((c) => c.source === source);
const certs = { good: ["/w/certs/cf-client.pem", "/w/certs/cf-client.key"], rogue: ["/w/certs/rogue-client.pem", "/w/certs/rogue-client.key"] };
const one = (c) => new Promise((resolve) => {
  const tls = c.scheme !== "http";
  const opts = { host: c.target ?? "172.31.250.10", port: c.port ?? (tls ? 443 : 80), method: c.method ?? "GET", path: c.path,
    headers: { host: c.host ?? "mcp.diaporia.test", "x-edge-case": c.name, ...(c.headers ?? {}) }, timeout: 5000,
    ...(tls ? { servername: c.sni ?? "mcp.diaporia.test", rejectUnauthorized: false, agent: false } : { agent: false }) };
  if (tls && c.cert) { opts.cert = readFileSync(certs[c.cert][0]); opts.key = readFileSync(certs[c.cert][1]); }
  const req = (tls ? https : http).request(opts, (res) => { let n = 0; res.on("data", (d) => { n += d.length; }); res.on("end", () => resolve({ name: c.name, status: res.statusCode, bytes: n })); });
  req.on("timeout", () => req.destroy(new Error("timeout")));
  req.on("error", (e) => resolve({ name: c.name, error: e.code ?? e.message }));
  req.end();
});
for (const c of cases) process.stdout.write(JSON.stringify(await one(c)) + "\n");
