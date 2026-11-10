// Edge test only: stands in for the app on the backend network and records every request Caddy
// forwards (one JSON line per request on stdout). Never part of a deployment.
import { createServer } from "node:http";
createServer((req, res) => {
  const rec = { stub: "upstream", method: req.method, url: req.url, host: req.headers.host ?? null, peer: req.socket.remoteAddress,
    xff: req.headers["x-forwarded-for"] ?? null, xfh: req.headers["x-forwarded-host"] ?? null, xfp: req.headers["x-forwarded-proto"] ?? null,
    case: req.headers["x-edge-case"] ?? null, headerNames: Object.keys(req.headers).sort() };
  if (req.url !== "/healthz") process.stdout.write(JSON.stringify(rec) + "\n");
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ upstream: true }));
}).listen(8080, "0.0.0.0");
