// Registers (offline) one confidential OAuth client for one AI host and one user of the remote read-only service.
//   npm run remote:oauth-client -- --user eric-remote --name "Claude (Eric)" --redirect https://claude.ai/api/mcp/auth_callback
// Prints the client id and secret ONCE (give them to that user for the host's "own OAuth client" fields)
// and the DIAPORIA_OAUTH_CLIENTS entry, which holds only the secret's sha256.
import { createHash, randomBytes } from "node:crypto";
const a = process.argv.slice(2); const get = (n) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : undefined; };
const user = get("--user"); const name = get("--name");
const redirects = a.flatMap((x, i) => (x === "--redirect" ? [a[i + 1]] : [])).filter(Boolean);
if (!user || !name || !redirects.length || /[|;]/.test(name + user + redirects.join(""))) {
  console.error('usage: --user <userId> --name "<display name>" --redirect <uri> [--redirect <uri>]   (no | or ; characters)'); process.exit(2);
}
const clientId = `dcl_${randomBytes(16).toString("hex")}`;
const secret = `dcs_${randomBytes(32).toString("base64url")}`;
const hash = createHash("sha256").update(secret).digest("hex");
const methods = ["client_secret_basic", "client_secret_post"]; // either is accepted
process.stdout.write(JSON.stringify({ client_id: clientId, client_secret: secret, accepted_auth_methods: methods,
  env_entry: `${clientId}|${hash}|${user}|${redirects.join(",")}|${name}` }, null, 2) + "\n");
