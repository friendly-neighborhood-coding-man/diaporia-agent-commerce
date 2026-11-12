import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp, type App, type AppConfig } from "../src/http/server.js";
import { ALL_CLIENT_SCOPES, DevAuth } from "../src/auth/devAuth.js";
import { MockPayPalProvider } from "../src/payment/MockPayPalProvider.js";
import type { ProductIdentity } from "../src/domain/types.js";
import { PASSKEYS, passkeyStep, testBoundary, type SimulatedPasskey } from "./helpers/humanAuthenticator.js";
export { PASSKEYS } from "./helpers/humanAuthenticator.js";

export const TOKENS = {
  alice: "dct_alice_test_token_000000000000",
  bob: "dct_bob_test_token_00000000000000",
  aliceReadOnly: "dct_alice_readonly_token_00000000",
};
export const OWNER = { alice: "dok_alice_owner_key_000000000000", bob: "dok_bob_owner_key_00000000000000" };
export const SONY_BLACK: ProductIdentity = { brand: "Sony", model: "WH-CH720N", variant: "Black", condition: "new", sku: "WHCH720N/B" };
export const CA = { country: "US", region: "CA" };

export interface Harness { app: App; url: string; clock: { offsetMs: number }; mock: MockPayPalProvider; close(): Promise<void> }

export async function startHarness(overrides: Partial<AppConfig> = {}): Promise<Harness> {
  const auth = new DevAuth();
  auth.addClientToken(TOKENS.alice, "alice", ALL_CLIENT_SCOPES);
  auth.addClientToken(TOKENS.bob, "bob", ALL_CLIENT_SCOPES);
  auth.addClientToken(TOKENS.aliceReadOnly, "alice", ["purchase.read"]);
  auth.addOwnerKey(OWNER.alice, "alice");
  auth.addOwnerKey(OWNER.bob, "bob");
  const clock = { offsetMs: 0 };
  const now = () => Date.now() + clock.offsetMs;
  // Bind first to learn the port, then build the app with the correct base URL.
  const probe = (await import("node:http")).createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((r) => probe.close(() => r()));
  const baseUrl = overrides.baseUrl ?? `http://127.0.0.1:${port}`;
  // R-A: the simulated humans' passkeys (public keys only on the server side) form the test-only owner boundary.
  const app = createApp({ host: "127.0.0.1", port, baseUrl, authMode: "dev", dbPath: ":memory:", auth, now, ownerConfirmation: testBoundary(baseUrl, now), ...overrides });
  await new Promise<void>((r) => app.server.listen(port, "127.0.0.1", r));
  return { app, url: `http://127.0.0.1:${port}`, clock, mock: app.mockPayPal!, close: () => new Promise((r) => app.server.close(() => r())) };
}

export async function mcpClient(url: string, token?: string): Promise<Client> {
  const client = new Client({ name: "diaporia-test-client", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), token ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } } : {});
  await client.connect(transport);
  // Real hosts list tools first; this also makes the client validate structuredContent against outputSchema.
  await client.listTools();
  return client;
}

/** Calls a tool and returns structuredContent, or throws with the tool error text. */
export async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) throw new Error((r.content as Array<{ text: string }>)[0]!.text);
  return r.structuredContent;
}
export async function callError(client: Client, name: string, args: Record<string, unknown>): Promise<{ code: string; message: string; details?: any }> {
  const r = await client.callTool({ name, arguments: args });
  if (!r.isError) throw new Error(`Expected ${name} to fail, got ${JSON.stringify(r.structuredContent)}`);
  const text = (r.content as Array<{ text: string }>)[0]!.text;
  try { return JSON.parse(text).error; } catch { return { code: "PROTOCOL", message: text }; }
}

/**
 * Creates an owner-API (REUSABLE) mandate. WP-1 (IR-01): automatic use by prepare_checkout is now an explicit
 * owner opt-in (autoUse, default false on the server). The suites written before WP-1 exercise the automatic
 * flow, so this helper opts in unless the body says otherwise; tests/security-fixes.test.ts covers the default.
 */
export async function createMandate(url: string, ownerKey: string, body: Record<string, unknown>) {
  const r = await fetch(`${url}/owner/mandates`, { method: "POST", headers: { "Content-Type": "application/json", "X-Owner-Key": ownerKey }, body: JSON.stringify({ autoUse: true, ...body }) });
  return { status: r.status, body: await r.json() as any };
}

/**
 * Plays the human buyer on the mock hosted page: approve (or cancel) then follow the return redirect.
 * WP-1 (IR-01): the mock buyer step needs the checkout owner's key on a same-origin browser POST.
 */
export async function buyer(h: Harness, approvalUrl: string, action: "approve" | "cancel" = "approve", ownerKey: string = OWNER.alice) {
  const orderId = new URL(approvalUrl).pathname.split("/").pop()!;
  const r1 = await fetch(`${h.url}/mock-paypal/checkout/${orderId}/${action}`, { method: "POST", redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: h.url }, body: new URLSearchParams({ owner_key: ownerKey }).toString() });
  const location = r1.headers.get("location")!;
  const r2 = await fetch(location, { redirect: "manual" });
  return { orderId, returnStatus: r2.status, returnHtml: await r2.text(), returnUrl: location };
}

/** research → compare for Sony WH-CH720N Black with an optional client-claimed budget. */
export async function researchAndCompare(client: Client, request = "Buy Sony WH-CH720N Black for the lowest total price, but never exceed $60.", extra: Record<string, unknown> = {}) {
  const research = await call(client, "research_purchase", { request, currency: "USD", ...extra });
  const compare = await call(client, "compare_purchase_offers", { researchSessionId: research.purchaseSessionId, productIdentity: SONY_BLACK, destination: CA });
  return { research, compare };
}

/**
 * V21-04: plays the HUMAN owner on the research-hold confirmation page (owner key → review session cookie + CSRF →
 * explicit confirmation), like a browser would. The MCP client never holds the owner key; only this simulated human does.
 */
export async function ownerConfirmsHold(ownerConfirmationUrl: string, ownerKey: string, form: Record<string, string> = {}, o: { passkey?: SimulatedPasskey | null } = {}) {
  const origin = new URL(ownerConfirmationUrl).origin;
  const post = (body: Record<string, string>, cookie = "") => fetch(ownerConfirmationUrl, { method: "POST", redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: origin, ...(cookie ? { Cookie: cookie } : {}) }, body: new URLSearchParams(body).toString() });
  const review = await post({ action: "review", ownerKey });
  const reviewHtml = await review.text();
  if (review.status !== 200) return { status: review.status, reviewHtml, html: reviewHtml };
  const cookie = (review.headers.get("set-cookie") ?? "").split(";")[0]!;
  const csrf = /name="csrf" value="([^"]+)"/.exec(reviewHtml)?.[1] ?? "";
  // R-A: the human verifies with their passkey (user verification) on the challenge the page shows.
  const passkey = o.passkey === undefined ? (ownerKey === OWNER.bob ? PASSKEYS.bob : PASSKEYS.alice) : o.passkey;
  const step = passkeyStep(reviewHtml);
  const assertion = passkey && step ? passkey.assert(step.challenge, { origin, rpId: step.rpId }) : {};
  const r = await post({ action: "confirm", csrf, acknowledge: "yes", ...assertion, ...form }, cookie);
  return { status: r.status, reviewHtml, html: await r.text() };
}
