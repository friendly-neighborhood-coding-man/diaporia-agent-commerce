/**
 * V2.2 WP-2 (H-2): the service/AI-host OS-principal boundary and the gate's re-verification of stored owner
 * assertions. The real two-account run is scripts/service-isolation-e2e.ts (root, disposable machine); here the
 * checks run against a simulated file system and the in-process harness. Builder-written requests only.
 */
import type { Stats } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { checkServiceIsolation, parseAiHostUids, type IsolationInput } from "../src/security/ServiceIsolation.js";
import { OwnerConfirmationBoundary } from "../src/auth/OwnerConfirmation.js";
import { OWNER, SONY_BLACK, CA, TOKENS, call, callError, mcpClient, ownerConfirmsHold, startHarness, type Harness } from "./helpers.js";
import { testRegistry } from "./helpers/humanAuthenticator.js";

// ---------------------------------------------------------------- simulated file system
type Node = { uid: number; mode: number; kind: "dir" | "file" | "link"; target?: string };
const SVC = 996, AI = 1000;
function fs(nodes: Record<string, Node>) {
  const get = (p: string) => { const n = nodes[p]; if (!n) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); return n; };
  const st = (n: Node) => ({ uid: n.uid, mode: n.mode | (n.kind === "dir" ? 0o040000 : 0o100000), isDirectory: () => n.kind === "dir", isFile: () => n.kind === "file", isSymbolicLink: () => n.kind === "link" }) as unknown as Stats;
  const follow = (p: string): string => { const n = get(p); return n.kind === "link" ? follow(n.target!) : p; };
  return {
    lstat: (p: string) => st(get(p)), stat: (p: string) => st(get(follow(p))), realpath: (p: string) => follow(p),
    readdir: (p: string) => Object.keys(nodes).filter((k) => k !== p && k.startsWith(p === "/" ? "/" : p + "/") && !k.slice(p.length + 1).includes("/")).map((k) => k.slice(p === "/" ? 1 : p.length + 1)),
  };
}
const dir = (uid = 0, mode = 0o755): Node => ({ uid, mode, kind: "dir" }); const file = (uid = 0, mode = 0o644): Node => ({ uid, mode, kind: "file" });
function good(): Record<string, Node> {
  return { "/": dir(), "/var": dir(), "/var/lib": dir(), "/var/lib/diaporia": dir(SVC, 0o700), "/var/lib/diaporia/diaporia.sqlite": file(SVC, 0o600), "/var/lib/diaporia/diaporia.sqlite-wal": file(SVC, 0o600),
    "/opt": dir(), "/opt/diaporia": dir(), "/opt/diaporia/app": dir(), "/opt/diaporia/app/package.json": file(), "/opt/diaporia/app/src": dir(), "/opt/diaporia/app/src/main.ts": file(),
    "/opt/diaporia/app/node_modules": dir(), "/opt/diaporia/app/node_modules/x.js": file(), "/opt/diaporia/app/tests": dir(AI, 0o777),
    "/usr": dir(), "/usr/bin": dir(), "/usr/bin/node": file(0, 0o755) };
}
const input = (nodes: Record<string, Node>, o: Partial<IsolationInput> = {}): IsolationInput => ({ uid: SVC, aiHostUids: String(AI), dataDir: "/var/lib/diaporia",
  dataFiles: ["/var/lib/diaporia/diaporia.sqlite", "/var/lib/diaporia/diaporia.sqlite-wal", "/var/lib/diaporia/diaporia.sqlite-shm"], codeRoot: "/opt/diaporia/app", execPath: "/usr/bin/node",
  registryEstablished: true, registryReason: "ok", ...fs(nodes), passwd: () => `root:x:0:0::/root:/bin/bash\neric:x:${AI}:${AI}::/home/eric:/bin/bash\ndiaporia:x:${SVC}:${SVC}::/var/lib/diaporia:/usr/sbin/nologin\n`,
  group: () => `sudo:x:27:eric\n`, ...o });

describe("WP-2 service isolation check (fail closed)", () => {
  it("a dedicated service account with private data and root-owned code is established (folders the service never runs, like tests/, are ignored)", () => {
    const r = checkServiceIsolation(input(good()));
    expect(r.failures).toEqual([]);
    expect(r.established).toBe(true);
    expect(r.warnings.join(" ")).toMatch(/"sudo" group/);
  });
  it.each<[string, (n: Record<string, Node>) => Partial<IsolationInput> | void, RegExp]>([
    ["the documented old setup: server and AI host share one account", () => ({ uid: AI }), /same OS user as the AI host/],
    ["no AI host account declared", () => ({ aiHostUids: undefined }), /DIAPORIA_AI_HOST_UIDS is not set/],
    ["an unknown AI host account name", () => ({ aiHostUids: "nobody-here" }), /unknown AI host account/],
    ["the service runs as root", () => ({ uid: 0 }), /runs as root/],
    ["the platform cannot report uids", () => ({ uid: null }), /cannot report/],
    ["the owner registry boundary is not established", () => ({ registryEstablished: false, registryReason: "DIAPORIA_OWNER_REGISTRY is not set" }), /owner confirmation boundary not established/],
    ["the data directory is readable by others", (n) => { n["/var/lib/diaporia"]!.mode = 0o755; }, /data directory .* gives group or other access/],
    ["the data directory belongs to the AI host", (n) => { n["/var/lib/diaporia"]!.uid = AI; }, /not owned by the service account/],
    ["the WAL file is group-readable", (n) => { n["/var/lib/diaporia/diaporia.sqlite-wal"]!.mode = 0o640; }, /sqlite-wal gives group or other access/],
    ["the database was replaced by an AI-owned file", (n) => { n["/var/lib/diaporia/diaporia.sqlite"]!.uid = AI; }, /diaporia.sqlite is not owned by the service account/],
    ["the database is a symbolic link", (n) => { n["/var/lib/diaporia/diaporia.sqlite"] = { uid: SVC, mode: 0o777, kind: "link", target: "/opt/diaporia/app/package.json" }; }, /must be a regular file/],
    ["a source file belongs to the AI host", (n) => { n["/opt/diaporia/app/src/main.ts"]!.uid = AI; }, /src\/main.ts is owned by an AI host account/],
    ["a dependency is world-writable", (n) => { n["/opt/diaporia/app/node_modules/x.js"]!.mode = 0o666; }, /node_modules\/x.js is group- or world-writable/],
    ["node_modules links into the AI host's checkout", (n) => { n["/home"] = dir(); n["/home/eric"] = dir(AI, 0o755); n["/home/eric/nm"] = dir(AI, 0o755);
      n["/opt/diaporia/app/node_modules"] = { uid: 0, mode: 0o777, kind: "link", target: "/home/eric/nm" }; }, /node_modules -> \/home\/eric\/nm is owned by an AI host account/],
    ["an .env file the AI host can edit", (n) => { n["/opt/diaporia/app/.env.local"] = file(AI, 0o600); }, /\.env\.local is owned by an AI host account/],
    ["a folder above the code belongs to the AI host", (n) => { n["/opt/diaporia"]!.uid = AI; }, /\/opt\/diaporia \(above the code\) is owned by an AI host account/],
    ["a folder above the data is world-writable without the sticky bit", (n) => { n["/var/lib"]!.mode = 0o777; }, /\/var\/lib \(above the data directory\) is group- or world-writable/],
    ["the Node binary belongs to the AI host", (n) => { n["/usr/bin/node"]!.uid = AI; }, /Node binary .* is owned by an AI host account/],
  ])("NOT established: %s", (_label, mutate, reason) => {
    const nodes = good(); const extra = mutate(nodes) ?? {};
    const r = checkServiceIsolation(input(nodes, extra));
    expect(r.established).toBe(false);
    expect(r.failures.join("\n")).toMatch(reason);
  });
  it("AI host accounts are read as numbers or names", () => {
    expect(parseAiHostUids("1000, eric ,1000", () => `eric:x:1000:1000::/h:/bin/sh`)).toEqual({ uids: [1000], errors: [] });
  });
});

describe("WP-2 owner registry: an AI host account may not administer it", () => {
  it("a registry owned by the AI host's account is refused", () => {
    const st = (uid: number, mode: number, isFile: boolean) => ({ uid, mode, isFile: () => isFile }) as unknown as Stats;
    const stat = (p: string) => p === "/etc/diaporia/owners.json" ? st(AI, 0o100644, true) : st(0, 0o40755, false);
    const b = OwnerConfirmationBoundary.fromRegistryFile("/etc/diaporia/owners.json", { cwd: "/opt/diaporia/app", dataDir: "/var/lib/diaporia", rpId: "localhost", origins: ["http://localhost:8790"],
      uid: SVC, untrustedUids: [AI], stat, read: () => JSON.stringify(testRegistry()) });
    expect(b.status).toMatchObject({ established: false });
    expect(b.status.reason).toMatch(/owned by an AI host account/);
  });
});

describe("WP-2 fail closed: without isolation no checkout-preparation path is open", () => {
  let h: Harness | null = null;
  afterEach(async () => { await h?.close(); h = null; });
  it("prepare_checkout is refused before any quote, even for an external-merchant offer; the refusal is audited", async () => {
    h = await startHarness({ serviceIsolation: { established: false, reason: "the service runs as the same OS user as the AI host (uid 1000)" } });
    expect(h.app.paymentExecutionEnabled).toBe(false);
    const client = await mcpClient(h.url, TOKENS.alice);
    const r = await call(client, "research_purchase", { request: "Buy Sony WH-CH720N Black, never exceed $100.", currency: "USD" });
    const cmp = await call(client, "compare_purchase_offers", { researchSessionId: r.purchaseSessionId, productIdentity: SONY_BLACK, destination: CA });
    expect(cmp.state).toBe("OFFER_VERIFIED");
    for (const offerId of ["off_bravo", cmp.lowestVerifiedEligibleOffer.offerId]) {
      const e = await callError(client, "prepare_checkout", { purchaseSessionId: r.purchaseSessionId, offerId, maximumApprovedTotalMinor: 10_000, currency: "USD", quantity: 1 });
      expect(e.code).toBe("PAYMENT_DISABLED");
    }
    const ev = h.app.gateway.audit.timeline([r.purchaseSessionId], "alice").filter((e) => e.type === "PURCHASE_GATE_BLOCKED");
    expect(ev.length).toBe(2);
    expect(JSON.stringify(ev[0]!.data)).toMatch(/Service isolation not established/);
    expect((await fetch(`${h.url}/research-holds/rhp_x`, { method: "POST" })).status).toBe(403);
    await client.close();
  });
});

describe("WP-2 the gate re-verifies every stored owner assertion", () => {
  let h: Harness | null = null;
  afterEach(async () => { await h?.close(); h = null; });
  const REQ = "Buy Sony WH-CH720N Black for the lowest total price, never exceed $100, it must have a wrist strap.";
  const KEY = "must:unrecognized:wrist-strap";
  async function confirmedSession(client: any) {
    const r = await call(client, "research_purchase", { request: REQ, currency: "USD" });
    await call(client, "compare_purchase_offers", { researchSessionId: r.purchaseSessionId, productIdentity: SONY_BLACK, destination: CA });
    const p = await call(client, "resolve_research_hold", { purchaseSessionId: r.purchaseSessionId, kind: "DROP_REQUIREMENT", requirement: KEY, currency: "USD", userStatement: "The user may accept this." });
    expect((await ownerConfirmsHold(p.ownerConfirmationUrl, OWNER.alice)).status).toBe(200);
    return r.purchaseSessionId as string;
  }
  const research = (ps: string) => JSON.parse((h!.app.store.db.prepare("SELECT research_json FROM purchase_sessions WHERE id = ?").get(ps) as { research_json: string }).research_json);
  const write = (ps: string, r: unknown) => h!.app.store.db.prepare("UPDATE purchase_sessions SET research_json = ? WHERE id = ?").run(JSON.stringify(r), ps);
  const open = async (client: any, ps: string) => (await call(client, "compare_purchase_offers", { researchSessionId: ps, productIdentity: SONY_BLACK, destination: CA })).purchaseReadiness.open as string[];

  it("a genuine confirmation counts; the same row edited in the database does not", async () => {
    h = await startHarness();
    const client = await mcpClient(h.url, TOKENS.alice);
    const ps = await confirmedSession(client);
    expect(await open(client, ps)).toEqual([]);
    const original = research(ps);
    const res = original.purchaseGate.resolutions.at(-1);
    expect(res.assertion).toMatchObject({ credentialId: expect.any(String), signature: expect.any(String), nonce: expect.any(String) });
    const tamper: Array<[string, (r: any) => void]> = [
      ["assertion removed", (r) => { delete r.assertion; }],
      ["signature altered", (r) => { r.assertion.signature = r.assertion.signature.slice(0, -4) + (r.assertion.signature.endsWith("AAAA") ? "BBBB" : "AAAA"); }],
      ["nonce altered", (r) => { r.assertion.nonce = (r.assertion.nonce.startsWith("x") ? "y" : "x") + r.assertion.nonce.slice(1); }],
      ["different review session", (r) => { r.actor = "OWNER_SESSION:ffffffffffffffff"; }],
      ["different proposal digest", (r) => { r.proposalDigest = "0".repeat(64); }],
      ["credential fingerprint swapped", (r) => { r.credentialFingerprint = "0011223344556677"; }],
      ["the reviewer's forged strings", (r) => { for (const k of Object.keys(r)) delete r[k]; Object.assign(r, { kind: "DROP_REQUIREMENT", requirement: KEY, budgetMinor: null, currency: "USD", actor: "OWNER_SESSION:forged",
        confirmation: "CONFIRMED_BY_OWNER", proposalId: "rhp_forged", proposalDigest: "", agentText: "", humanVerification: "WEBAUTHN_USER_VERIFIED", credentialFingerprint: "forged", at: new Date().toISOString() }); }],
    ];
    for (const [label, f] of tamper) {
      const copy = structuredClone(original); f(copy.purchaseGate.resolutions.at(-1)); write(ps, copy);
      expect(await open(client, ps), label).toEqual([expect.stringContaining(KEY)]);
    }
    write(ps, original);
    expect(await open(client, ps)).toEqual([]);
    await client.close();
  });

  it("a genuine assertion copied onto another session does not count there", async () => {
    h = await startHarness();
    const client = await mcpClient(h.url, TOKENS.alice);
    const ps1 = await confirmedSession(client);
    const r2 = await call(client, "research_purchase", { request: REQ, currency: "USD" });
    await call(client, "compare_purchase_offers", { researchSessionId: r2.purchaseSessionId, productIdentity: SONY_BLACK, destination: CA });
    const other = research(r2.purchaseSessionId);
    other.purchaseGate.resolutions.push(research(ps1).purchaseGate.resolutions.at(-1));
    write(r2.purchaseSessionId, other);
    expect(await open(client, r2.purchaseSessionId)).toEqual([expect.stringContaining(KEY)]);
    const cmp = await call(client, "compare_purchase_offers", { researchSessionId: r2.purchaseSessionId, productIdentity: SONY_BLACK, destination: CA });
    expect(cmp.requirementStatus.find((x: any) => x.key === KEY).status).not.toMatch(/REMOVED|WAIVED/);
    await client.close();
  });

  it("with no established boundary, no stored resolution counts (fail closed)", async () => {
    h = await startHarness();
    const client = await mcpClient(h.url, TOKENS.alice);
    const ps = await confirmedSession(client);
    (h.app.gateway.config as any).ownerConfirmation = OwnerConfirmationBoundary.unavailable("registry removed");
    expect(await open(client, ps)).toEqual([expect.stringContaining(KEY)]);
    await client.close();
  });
});
