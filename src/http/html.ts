import { formatMinor, type Currency } from "../domain/money.js";

export function esc(v: unknown): string {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function money(minor: number | null, currency: Currency): string {
  return minor === null ? "unknown" : `${formatMinor(minor, currency)} ${currency}`;
}

export function page(title: string, body: string, banner = "PayPal Sandbox / mock demonstration — no real money moves"): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>
body{font:15px/1.5 system-ui,sans-serif;max-width:640px;margin:2rem auto;padding:0 1rem;color:#1b1f24}
.banner{background:#fff4ce;border:1px solid #e0b400;padding:.5rem .75rem;border-radius:6px;font-size:13px}
table{border-collapse:collapse;width:100%;margin:1rem 0}td{border-bottom:1px solid #ddd;padding:.35rem .25rem}td:first-child{color:#555;width:40%}
button{font:inherit;padding:.5rem 1rem;border-radius:6px;border:1px solid #0b57d0;background:#0b57d0;color:#fff;cursor:pointer}
button.secondary{background:#fff;color:#0b57d0}input{font:inherit;padding:.35rem;width:100%;box-sizing:border-box}
.state{font-weight:600}.muted{color:#666;font-size:13px}</style></head>
<body><p class="banner">${esc(banner)}</p><h1>${esc(title)}</h1>${body}</body></html>`;
}
