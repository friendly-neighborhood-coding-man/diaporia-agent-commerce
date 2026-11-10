// Writes deploy/remote-mcp/edge/cloudflare-ips.caddy (Caddy "trusted_proxies static" line) from
// Cloudflare's official published lists. Run by the owner at gate A2 option B, never in CI:
//   node scripts/remote/cloudflare-ips.mjs > deploy/remote-mcp/edge/cloudflare-ips.caddy
//   node scripts/remote/cloudflare-ips.mjs --from ips-v4.txt ips-v6.txt > ...   (files saved from the same URLs)
// Refuses anything that is not a plain IPv4/IPv6 CIDR, and lists that look truncated.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { isIPv4, isIPv6 } from "node:net";
const SOURCES = ["https://www.cloudflare.com/ips-v4", "https://www.cloudflare.com/ips-v6"];
const a = process.argv.slice(2);
const texts = a[0] === "--from" ? a.slice(1, 3).map((f) => readFileSync(f, "utf8"))
  : await Promise.all(SOURCES.map(async (u) => { const r = await fetch(u); if (!r.ok) throw new Error(`${u}: HTTP ${r.status}`); return r.text(); }));
const parse = (text, v) => text.split(/\s+/).filter(Boolean).map((c) => {
  const [ip, len, extra] = c.split("/"); const n = Number(len);
  const ok = extra === undefined && /^\d+$/.test(len ?? "") && (v === 4 ? isIPv4(ip) && n >= 8 && n <= 32 : isIPv6(ip) && n >= 16 && n <= 128);
  if (!ok) throw new Error(`not a plain IPv${v} CIDR: ${JSON.stringify(c)}`);
  return c;
});
const v4 = parse(texts[0], 4); const v6 = parse(texts[1], 6);
if (v4.length < 10 || v6.length < 5) throw new Error(`lists look truncated (${v4.length} IPv4, ${v6.length} IPv6)`);
const all = [...v4, ...v6];
const digest = createHash("sha256").update(all.join("\n")).digest("hex");
process.stdout.write(`# Cloudflare edge ranges. Source: ${SOURCES.join(" ")}\n# Retrieved: ${new Date().toISOString()}  sha256(ranges): ${digest}\n# Re-generate and diff before every deployment in cloudflare mode.\ntrusted_proxies static ${all.join(" ")}\n`);
