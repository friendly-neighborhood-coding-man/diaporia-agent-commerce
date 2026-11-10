// Edge test only: case list and assertions for test/edge-check.sh.
//   node edge-cases.mjs cases <direct|cloudflare>                 -> JSON case list
//   node edge-cases.mjs assert <mode> <results.jsonl> <upstream.jsonl> <report.json>
import { readFileSync, writeFileSync } from "node:fs";
const SPOOF = { "x-forwarded-for": "6.6.6.6", "cf-connecting-ip": "7.7.7.7", "true-client-ip": "8.8.8.8", "x-real-ip": "9.9.9.9", forwarded: "for=10.10.10.10", "x-forwarded-host": "127.0.0.1:8080" };
const ALLOWED = ["/mcp", "/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-authorization-server", "/oauth/authorize", "/oauth/token", "/oauth/revoke"];
const FORBIDDEN_PATHS = ["/owner/mandates", "/OWNER/mandates", "/%6Fwner/mandates", "//owner/mandates", "/./owner/mandates", "/mcp/../owner/mandates",
  "/oauth/../owner/mandates", "/owner%2Fmandates", "/mcp%2F..%2Fowner%2Fmandates", "/.well-known/../owner/mandates", "/paypal/webhook", "/mock-paypal/approve",
  "/healthz", "/authorize", "/billing/subscriptions", "/handoff/start", "/operator", "/oauth/register", "/mcp/extra", "/mcpx", "/oauth/token/../../owner/mandates"];
const FOREIGN_HOSTS = ["127.0.0.1:8080", "app:8080", "app", "localhost", "172.31.251.20:8080", "mcp.diaporia.test.evil.example", "phase-c.diaporia.com", "diaporia.com"];
const PRM = "/.well-known/oauth-protected-resource";

export function cases(mode) {
  const cf = mode === "cloudflare";
  const cert = cf ? "good" : undefined; // in cloudflare mode every connection must present an origin-pull client certificate
  const c = [];
  const add = (x) => c.push({ cert, ...x });
  // Distinct client identities; spoofed address headers from untrusted peers are ignored.
  add({ name: "untrusted-a-spoofed", source: "a", path: PRM, headers: SPOOF, expect: { status: 200, upstreamXff: "172.31.250.61" } });
  add({ name: "untrusted-b-spoofed", source: "b", path: PRM, headers: SPOOF, expect: { status: 200, upstreamXff: "172.31.250.62" } });
  add({ name: "untrusted-a-plain", source: "a", path: "/mcp", method: "POST", expect: { status: 200, upstreamXff: "172.31.250.61" } });
  if (cf) {
    // The "Cloudflare" peer (inside the trusted ranges, with the origin-pull certificate).
    add({ name: "cf-client-1", source: "cf", path: PRM, headers: { "cf-connecting-ip": "198.51.100.7" }, expect: { status: 200, upstreamXff: "198.51.100.7" } });
    add({ name: "cf-client-2", source: "cf", path: PRM, headers: { "cf-connecting-ip": "198.51.100.8" }, expect: { status: 200, upstreamXff: "198.51.100.8" } });
    add({ name: "cf-client-ipv6", source: "cf", path: PRM, headers: { "cf-connecting-ip": "2001:db8:1::7" }, expect: { status: 200, upstreamXff: "2001:db8:1::7" } });
    add({ name: "cf-xff-only-is-ignored", source: "cf", path: PRM, headers: { "x-forwarded-for": "203.0.113.9" }, expect: { status: 200, upstreamXff: "172.31.250.50" } });
    add({ name: "cf-spoof-others-stripped", source: "cf", path: PRM, headers: { ...SPOOF, "cf-connecting-ip": "198.51.100.9" }, expect: { status: 200, upstreamXff: "198.51.100.9" } });
    add({ name: "cf-garbage-header", source: "cf", path: PRM, headers: { "cf-connecting-ip": "not-an-ip" }, expect: { status: 200, upstreamXffOneOf: ["172.31.250.50"] } });
    // Real Cloudflare overwrites CF-Connecting-IP with one address; a list can only come from a peer that
    // already passed the range and certificate checks. Caddy then keeps one address (the right-most).
    add({ name: "cf-list-header", source: "cf", path: PRM, headers: { "cf-connecting-ip": "198.51.100.10, 198.51.100.11" }, expect: { status: 200, upstreamXffSingle: true } });
    // An attacker inside nothing but holding a valid origin-pull certificate (e.g. the shared zone certificate):
    add({ name: "untrusted-with-cert-cf-header", source: "a", path: PRM, headers: { "cf-connecting-ip": "198.51.100.66" }, expect: { status: 200, upstreamXff: "172.31.250.61" } });
    // Direct origin access around Cloudflare: no client certificate or a certificate from another CA.
    add({ name: "no-client-cert", source: "a", cert: null, path: PRM, expect: { tlsFail: true } });
    add({ name: "no-client-cert-from-cf-range", source: "cf", cert: null, path: PRM, headers: { "cf-connecting-ip": "198.51.100.11" }, expect: { tlsFail: true } });
    add({ name: "rogue-ca-client-cert", source: "cf", cert: "rogue", path: PRM, headers: { "cf-connecting-ip": "198.51.100.12" }, expect: { tlsFail: true } });
  } else {
    add({ name: "cf-header-in-direct-mode-ignored", source: "cf", path: PRM, headers: { "cf-connecting-ip": "198.51.100.7" }, expect: { status: 200, upstreamXff: "172.31.250.50" } });
  }
  // Path allowlist and Host handling: none of these may reach the upstream.
  for (const p of FORBIDDEN_PATHS) add({ name: `path ${p}`, source: cf ? "cf" : "a", path: p, method: p.startsWith("/mock-paypal") || p.startsWith("/paypal") ? "POST" : "GET", expect: { upstream: false } });
  for (const h of FOREIGN_HOSTS) for (const p of ["/mcp", "/owner/mandates", "/paypal/webhook"]) add({ name: `host ${h} ${p}`, source: cf ? "cf" : "a", host: h, path: p, expect: { upstream: false } });
  add({ name: "absolute-form target to app", source: cf ? "cf" : "a", path: "http://app:8080/owner/mandates", expect: { upstream: false } });
  add({ name: "absolute-form target to app, allowed path", source: cf ? "cf" : "a", path: "http://127.0.0.1:8080/mcp", expect: { upstream: false } });
  add({ name: "sni other host", source: cf ? "cf" : "a", sni: "127.0.0.1", host: "127.0.0.1:8080", path: "/owner/mandates", expect: { upstream: false } });
  add({ name: "plain http redirects only", source: cf ? "cf" : "a", scheme: "http", path: "/owner/mandates", expect: { upstream: false } });
  add({ name: "plain http allowed path redirects only", source: cf ? "cf" : "a", scheme: "http", path: "/mcp", expect: { upstream: false } });
  add({ name: "backend address unreachable from clients", source: "a", scheme: "http", target: "172.31.251.20", port: 8080, path: "/owner/mandates", expect: { connectFail: true, upstream: false } });
  return c;
}

const readLines = (f) => readFileSync(f, "utf8").split("\n").map((l) => l.slice(l.indexOf("{"))).filter((l) => l.startsWith("{")).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

function assert(mode, resultsFile, upstreamFile, reportFile) {
  const list = cases(mode); const results = new Map(readLines(resultsFile).map((r) => [r.name, r]));
  const ups = readLines(upstreamFile).filter((r) => r.stub === "upstream");
  const out = []; const check = (name, ok, detail) => { out.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  [${mode}] ${name}${ok ? "" : `  -- ${JSON.stringify(detail)}`}`); };
  for (const c of list) {
    const r = results.get(c.name); const seen = ups.filter((u) => u.case === c.name);
    if (!r) { check(c.name, false, "no result"); continue; }
    const e = c.expect; let ok = true; const why = { result: r, upstream: seen.map((u) => ({ url: u.url, xff: u.xff, host: u.host })) };
    if (e.tlsFail) ok &&= !!r.error && seen.length === 0;
    if (e.connectFail) ok &&= !!r.error;
    if (e.status !== undefined) ok &&= r.status === e.status;
    if (e.upstream === false) ok &&= seen.length === 0;
    if (e.upstreamXff || e.upstreamXffOneOf || e.upstreamXffSingle) {
      ok &&= seen.length === 1;
      const u = seen[0] ?? {};
      if (e.upstreamXff) ok &&= u.xff === e.upstreamXff;
      if (e.upstreamXffOneOf) ok &&= e.upstreamXffOneOf.includes(u.xff);
      if (e.upstreamXffSingle) ok &&= typeof u.xff === "string" && !u.xff.includes(",");
      ok &&= !["cf-connecting-ip", "true-client-ip", "x-real-ip", "forwarded"].some((h) => (u.headerNames ?? []).includes(h));
      ok &&= u.xfh === "mcp.diaporia.test" && u.peer?.endsWith("172.31.251.10");
    }
    check(c.name, ok, why);
  }
  // Global invariant: every request that reached the upstream had an allowlisted path and the right Host.
  const bad = ups.filter((u) => u.case !== "observe-loopback").filter((u) => { const p = (u.url ?? "").split("?")[0]; return !ALLOWED.includes(p) || u.host !== "mcp.diaporia.test"; });
  check("upstream received only allowlisted paths with Host mcp.diaporia.test", bad.length === 0, bad.slice(0, 5));
  const failed = out.filter((x) => !x.ok).length;
  writeFileSync(reportFile, JSON.stringify({ mode, total: out.length, failed, checks: out }, null, 2));
  console.log(`${failed ? "FAIL" : "PASS"}: ${out.length - failed}/${out.length} checks (edge mode ${mode})`);
  process.exitCode = failed ? 1 : 0;
}

const [cmd, mode, ...rest] = process.argv.slice(2);
if (cmd === "cases") process.stdout.write(JSON.stringify(cases(mode)));
else if (cmd === "assert") assert(mode, ...rest);
