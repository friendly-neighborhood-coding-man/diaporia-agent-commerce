// Container health check: GET /healthz with the public Host header (the service refuses any other Host),
// and fail unless the service reports itself read-only.
import http from "node:http";
const host = new URL(process.env.PUBLIC_BASE_URL).host;
const req = http.get({ host: "127.0.0.1", port: Number(process.env.PORT ?? 8080), path: "/healthz", headers: { host }, timeout: 4000 }, (res) => {
  let b = ""; res.on("data", (d) => (b += d)); res.on("end", () => {
    try { const j = JSON.parse(b); process.exit(res.statusCode === 200 && j.paymentExecutionEnabled === false && j.authMode === "oauth" ? 0 : 1); } catch { process.exit(1); }
  });
});
req.on("error", () => process.exit(1)); req.on("timeout", () => { req.destroy(); process.exit(1); });
