/**
 * R-A (IW-2 verification of 7d1fe4f): agent-controlled credentials and the human confirmation credential are separated.
 * On 7d1fe4f the default dev startup wrote the AI client token AND the owner key into .data/dev-credentials.json, so an
 * agent on the same host could read the key, forge browser headers and confirm its own research-hold proposal
 * (reproduced: /mnt/project-files/agent-commerce-research-v2/v2.1/remediation/iw2-fix/ra-before-7d1fe4f.txt).
 *
 * Now: (1) no owner credential is ever written where the AI host can read it; (2) confirming a research hold needs a
 * WebAuthn-style assertion with user verification from a passkey enrolled in an owner registry administered by another
 * OS principal (public keys only); (3) without that boundary confirmation is unavailable (fail closed); (4) owner-key
 * attempts are rate limited (R-B). Builder-written scenarios on the fixture catalog only.
 */
import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Stats } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { CA, OWNER, TOKENS, call, mcpClient, startHarness, type Harness } from "./helpers.js";
import { PASSKEYS, SimulatedPasskey, passkeyStep, testRegistry } from "./helpers/humanAuthenticator.js";
import { OwnerConfirmationBoundary, researchHoldBinding } from "../src/auth/OwnerConfirmation.js";
import { DevAuth } from "../src/auth/devAuth.js";

const LUMEN = { brand: "Lumen", model: "Q3", variant: "Black", condition: "new", sku: "LUM-Q3-B" };
let h: Harness | null = null;
afterEach(async () => { await h?.close(); h = null; });

async function held(overrides: Parameters<typeof startHarness>[0] = {}) {
  h = await startHarness(overrides);
  const client = await mcpClient(h.url, TOKENS.alice);
  const r = await call(client, "research_purchase", { request: "Buy Lumen Q3 Black wireless headphones, never exceed $150.", currency: "USD" });
  await call(client, "compare_purchase_offers", { researchSessionId: r.purchaseSessionId, productIdentity: LUMEN, destination: CA });
  const p = await call(client, "resolve_research_hold", { purchaseSessionId: r.purchaseSessionId, kind: "DROP_REQUIREMENT", requirement: "must:wireless", currency: "USD", userStatement: "agent text" });
  const recompare = () => call(client, "compare_purchase_offers", { researchSessionId: r.purchaseSessionId, productIdentity: LUMEN, destination: CA });
  return { client, ps: r.purchaseSessionId as string, url: p.ownerConfirmationUrl as string, proposalId: p.proposalId as string, recompare };
}

/** A browser-like client of the owner page. `who` only labels the actor; the headers it sends are whatever it chooses. */
class Page {
  cookie = ""; csrf = ""; step: ReturnType<typeof passkeyStep> = null; html = "";
  constructor(readonly url: string) {}
  get origin() { return new URL(this.url).origin; }
  async post(form: Record<string, string>, extraHeaders: Record<string, string> = {}) {
    const r = await fetch(this.url, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: this.origin, "Sec-Fetch-Site": "same-origin",
      ...(this.cookie ? { Cookie: this.cookie } : {}), ...extraHeaders }, body: new URLSearchParams(form).toString() });
    const sc = r.headers.get("set-cookie"); if (sc) this.cookie = sc.split(";")[0]!;
    this.html = await r.text();
    const csrf = /name="csrf" value="([^"]+)"/.exec(this.html)?.[1]; if (csrf) this.csrf = csrf;
    const st = passkeyStep(this.html); if (st) this.step = st;
    return r.status;
  }
  review(key: string) { return this.post({ action: "review", ownerKey: key }); }
  confirm(assertion: Record<string, string> = {}) { return this.post({ action: "confirm", csrf: this.csrf, acknowledge: "yes", ...assertion }); }
  sign(pk: SimulatedPasskey, o: Partial<Parameters<SimulatedPasskey["assert"]>[1]> = {}) { return pk.assert(this.step!.challenge, { origin: this.origin, rpId: this.step!.rpId, ...o }); }
}
const confirmedRows = (ps: string) => ((h!.app.gateway.sessions.getPurchaseSession(ps, "alice").research as any).purchaseGate.resolutions as unknown[]).length;

describe("R-A: the agent cannot confirm its own proposal", () => {
  it("control: the human owner (owner key + own passkey with user verification) confirms; the resolution records the verification", async () => {
    const s = await held();
    const human = new Page(s.url);
    expect(await human.review(OWNER.alice)).toBe(200);
    expect(human.step?.credentialIds).toEqual([PASSKEYS.alice.credentialId]);
    expect(await human.confirm(human.sign(PASSKEYS.alice))).toBe(200);
    expect((await s.recompare()).purchaseReadiness.open.join(" ")).not.toContain("must:wireless");
    const gate = (h!.app.gateway.sessions.getPurchaseSession(s.ps, "alice").research as any).purchaseGate;
    expect(gate.resolutions[0]).toMatchObject({ humanVerification: "WEBAUTHN_USER_VERIFIED", credentialFingerprint: expect.stringMatching(/^[0-9a-f]{16}$/) });
    expect(gate.products["prd_lumen_q3"].requirements.map((q: any) => q.key)).toContain("must:wireless"); // original kept
    await s.client.close();
  });

  it("an agent that obtained the owner key and forges same-origin headers (Origin, Sec-Fetch-Site) still cannot confirm", async () => {
    const s = await held();
    const agent = new Page(s.url);
    expect(await agent.review(OWNER.alice)).toBe(200); // the owner key alone still opens a review: it is not sufficient
    expect(await agent.confirm()).toBe(401);
    expect(agent.html).toMatch(/passkey did not verify/);
    expect(confirmedRows(s.ps)).toBe(0);
    expect((await s.recompare()).state).toBe("HOLD");
    await s.client.close();
  });

  it("an agent signing with its own passkey (not enrolled) is refused", async () => {
    const s = await held();
    const agent = new Page(s.url);
    await agent.review(OWNER.alice);
    expect(await agent.confirm(agent.sign(new SimulatedPasskey("alice")))).toBe(401);
    expect(agent.html).toMatch(/unknown authenticator/);
    expect(confirmedRows(s.ps)).toBe(0);
    await s.client.close();
  });

  it("an assertion without user verification, from another origin, for another relying party, cross-origin, or of the wrong type is refused", async () => {
    const s = await held();
    for (const bad of [{ userVerified: false }, { origin: "http://evil.example" }, { rpId: "evil.example" }, { crossOrigin: true }, { type: "webauthn.create" }]) {
      const p = new Page(s.url);
      expect(await p.review(OWNER.alice)).toBe(200);
      expect(await p.confirm(p.sign(PASSKEYS.alice, bad))).toBe(401);
    }
    expect(confirmedRows(s.ps)).toBe(0);
    expect((await s.recompare()).state).toBe("HOLD");
    await s.client.close();
  });

  it("a stolen browser session (cookie + CSRF) without the human's passkey cannot confirm, and is consumed", async () => {
    const s = await held();
    const human = new Page(s.url);
    await human.review(OWNER.alice);
    const agent = new Page(s.url); agent.cookie = human.cookie; agent.csrf = human.csrf; agent.step = human.step;
    expect(await agent.confirm()).toBe(401);
    expect(await human.confirm(human.sign(PASSKEYS.alice))).toBe(401); // single use: the session is gone
    expect(confirmedRows(s.ps)).toBe(0);
    await s.client.close();
  });

  it("the human's assertion cannot be replayed: not twice, not in another review session, not for another proposal", async () => {
    const s = await held();
    const human = new Page(s.url);
    await human.review(OWNER.alice);
    const assertion = human.sign(PASSKEYS.alice);
    // The agent opens its own review session (it holds the owner key) and submits the human's assertion there first.
    const agent = new Page(s.url);
    await agent.review(OWNER.alice);
    expect(await agent.confirm(assertion)).toBe(401); // bound to the human's review session, not the agent's
    // Another proposal of the same session: a fresh link, a fresh challenge.
    const p2 = await call(s.client, "resolve_research_hold", { purchaseSessionId: s.ps, kind: "DROP_REQUIREMENT", requirement: "must:wireless", currency: "USD", userStatement: "second" });
    const other = new Page(p2.ownerConfirmationUrl);
    await other.review(OWNER.alice);
    expect(await other.confirm(assertion)).toBe(401);
    expect(confirmedRows(s.ps)).toBe(0);
    await s.client.close();
  });

  it("an authenticator counter that does not increase is refused (cloned passkey)", async () => {
    const s = await held();
    const a = new Page(s.url); await a.review(OWNER.alice);
    const p2 = await call(s.client, "resolve_research_hold", { purchaseSessionId: s.ps, kind: "DROP_REQUIREMENT", requirement: "must:wireless", currency: "USD", userStatement: "second" });
    const b = new Page(p2.ownerConfirmationUrl); await b.review(OWNER.alice);
    const high = PASSKEYS.alice.counter + 1000;
    expect(await a.confirm(a.sign(PASSKEYS.alice, { counter: high }))).toBe(200);
    expect(await b.confirm(b.sign(PASSKEYS.alice, { counter: high }))).toBe(401);
    expect(b.html).toMatch(/counter/);
    PASSKEYS.alice.counter = high;
    await s.client.close();
  });

  it("bypassing the page: the gateway refuses a forged proof object and audits the refusal", async () => {
    const s = await held();
    const gw = h!.app.gateway;
    const p = gw.holdProposals.get(s.proposalId, "alice")!;
    const forged = Object.freeze({ userId: "alice", binding: researchHoldBinding(p.proposalId, p.digest, "0123456789abcdef"), credentialFingerprint: "0011223344556677", method: "WEBAUTHN_USER_VERIFIED" as const });
    for (const humanProof of [undefined, forged, { ...forged }])
      expect(() => gw.confirmResearchHoldAsOwner("alice", s.proposalId, { shownDigest: p.digest, ownerSessionFingerprint: "0123456789abcdef", typedBudgetMinor: null, humanProof }))
        .toThrow(/verified human assertion/);
    expect(gw.audit.timeline([s.ps], "alice").filter((e) => e.type === "RESEARCH_HOLD_CONFIRMATION_REFUSED")).toHaveLength(3);
    expect(confirmedRows(s.ps)).toBe(0);
    expect(gw.holdProposals.get(s.proposalId, "alice")!.status).toBe("PENDING");
    await s.client.close();
  });

  it("no MCP tool can confirm: the agent's tools only propose", async () => {
    const s = await held();
    const names = (await s.client.listTools()).tools.map((t) => t.name);
    expect(names.filter((n) => /confirm|owner|approve/i.test(n))).toEqual([]);
    await s.client.close();
  });
});

describe("R-A: fail closed when the boundary cannot be established", () => {
  it("a server without a configured boundary shows no confirm step and refuses confirmation (503); reject still works", async () => {
    const s = await held({ ownerConfirmation: undefined as any });
    const human = new Page(s.url);
    expect(await human.review(OWNER.alice)).toBe(200);
    expect(human.step).toBeNull();
    expect(human.html).toMatch(/Confirming is unavailable/);
    expect(await human.confirm(PASSKEYS.alice.assert("x", { origin: human.origin, rpId: "127.0.0.1" }))).toBe(503);
    expect(confirmedRows(s.ps)).toBe(0);
    const again = new Page(s.url); await again.review(OWNER.alice);
    expect(await again.post({ action: "reject", csrf: again.csrf })).toBe(200);
    await s.client.close();
  });

  it("an owner with no enrolled passkey cannot confirm", async () => {
    const u = "http://127.0.0.1:1";
    const s = await held({ ownerConfirmation: OwnerConfirmationBoundary.testOnlyInProcess(testRegistry([PASSKEYS.bob]), "127.0.0.1", [u]) });
    const p = new Page(s.url);
    await p.review(OWNER.alice);
    expect(p.html).toMatch(/no passkey is enrolled/);
    expect(await p.confirm()).toBe(503);
    await s.client.close();
  });

  describe("fromRegistryFile (the production loader) refuses anything the server's own OS user could have written", () => {
    const SERVER_UID = 1000, OTHER = 0;
    const reg = JSON.stringify(testRegistry([PASSKEYS.alice]));
    const st = (uid: number, mode: number, file = false) => ({ uid, mode, isFile: () => file }) as unknown as Stats;
    const fs = (over: Record<string, Stats | null> = {}) => (p: string) => {
      const v = p in over ? over[p] : (p === "/etc/diaporia/owners.json" ? st(OTHER, 0o100644, true) : st(OTHER, 0o40755));
      if (!v) throw new Error("ENOENT"); return v;
    };
    const load = (path: string | undefined, o: { stat?: (p: string) => Stats; read?: (p: string) => string; uid?: number | null } = {}) => OwnerConfirmationBoundary.fromRegistryFile(path,
      { cwd: "/srv/app", dataDir: "/srv/app/.data", rpId: "localhost", origins: ["http://localhost:8790"], uid: o.uid === undefined ? SERVER_UID : o.uid, stat: o.stat ?? fs(), read: o.read ?? (() => reg) });
    it.each([
      ["unset", undefined, {}, /not set/],
      ["relative", "owners.json", {}, /absolute/],
      ["inside the working tree", "/srv/app/owners.json", {}, /working tree/],
      ["inside the data directory", "/srv/app/.data/owners.json", {}, /working tree or data directory/],
      ["missing", "/etc/diaporia/owners.json", { stat: fs({ "/etc/diaporia/owners.json": null }) }, /does not exist/],
      ["a symbolic link", "/etc/diaporia/owners.json", { stat: fs({ "/etc/diaporia/owners.json": st(OTHER, 0o120777, false) }) }, /regular file/],
      ["owned by the server's user", "/etc/diaporia/owners.json", { stat: fs({ "/etc/diaporia/owners.json": st(SERVER_UID, 0o100600, true) }) }, /owned by the server's own OS user/],
      ["group-writable", "/etc/diaporia/owners.json", { stat: fs({ "/etc/diaporia/owners.json": st(OTHER, 0o100664, true) }) }, /writable/],
      ["in a directory the server's user owns", "/etc/diaporia/owners.json", { stat: fs({ "/etc/diaporia": st(SERVER_UID, 0o40755) }) }, /directory \/etc\/diaporia is owned/],
      ["below a directory the server's user owns", "/etc/diaporia/owners.json", { stat: fs({ "/etc": st(SERVER_UID, 0o40755) }) }, /directory \/etc is owned/],
      ["in a world-writable directory without the sticky bit", "/etc/diaporia/owners.json", { stat: fs({ "/etc/diaporia": st(OTHER, 0o40777) }) }, /writable/],
      ["unparseable", "/etc/diaporia/owners.json", { read: () => "{" }, /invalid/],
      ["not a registry", "/etc/diaporia/owners.json", { read: () => JSON.stringify({ owners: [] }) }, /invalid/],
      ["on a platform without uids", "/etc/diaporia/owners.json", { uid: null }, /cannot report file ownership/],
    ])("%s → unavailable", (_n, path, o, reason) => {
      const b = load(path as string | undefined, o as any);
      expect(b.status.established).toBe(false);
      expect(b.status.reason).toMatch(reason);
      expect(b.canConfirm("alice")).toBe(false);
      expect(b.ownerKeyVerifiers()).toEqual([]);
    });
    it("control: a registry administered by another OS principal is accepted", () => {
      const b = load("/etc/diaporia/owners.json");
      expect(b.status).toMatchObject({ established: true, source: "REGISTRY_FILE" });
      expect(b.canConfirm("alice")).toBe(true);
    });
    it("the registry holds public keys and hashes only: nothing in it can sign", () => {
      const r = JSON.parse(reg);
      expect(reg).not.toMatch(/PRIVATE|"d"\s*:/);
      expect(Object.keys(r.owners[0].authenticators[0]).sort()).toEqual(["alg", "credentialId", "label", "publicKeySpki"]);
      // A private key is refused as a registry entry.
      const priv = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
      const bad = JSON.stringify({ schema: "diaporia.owner-registry.v1", owners: [{ userId: "alice", authenticators: [{ credentialId: "x", publicKeySpki: priv, alg: -7 }] }] });
      expect(load("/etc/diaporia/owners.json", { read: () => bad }).status.established).toBe(false);
    });
  });
});

describe("R-B: owner-key attempts are rate limited", () => {
  it("after 10 wrong keys from a client every key is refused (429 on the page) until the window passes", async () => {
    const s = await held();
    for (let i = 0; i < DevAuth.OWNER_KEY_MAX_FAILURES; i++) expect(await new Page(s.url).review(`dok_wrong_guess_${String(i).padStart(12, "0")}`)).toBe(401);
    const p = new Page(s.url);
    expect(await p.review(OWNER.alice)).toBe(429);
    h!.app.auth.clock = () => Date.now() + DevAuth.OWNER_KEY_WINDOW_MS + 1;
    expect(await p.review(OWNER.alice)).toBe(200);
    await s.client.close();
  });
  it("unit: limits per client and across all clients", () => {
    const a = new DevAuth(); a.addOwnerKey(OWNER.alice, "alice");
    for (let i = 0; i < 10; i++) a.verifyOwnerKey("x".repeat(30), "c1");
    expect(a.verifyOwnerKey(OWNER.alice, "c1")).toBeNull();
    expect(a.verifyOwnerKey(OWNER.alice, "c2")).toBe("alice");
    for (let c = 0; c < 4; c++) for (let i = 0; i < 10; i++) a.verifyOwnerKey("x".repeat(30), `d${c}`);
    expect(a.verifyOwnerKey(OWNER.alice, "fresh")).toBeNull(); // 50 failures across clients
  });
});

describe("R-A: the default dev startup writes no owner credential the AI host can read", () => {
  const root = new URL("..", import.meta.url).pathname;
  async function boot(cwd: string) {
    const port = 19000 + Math.floor(Math.random() * 900);
    const srv = spawn(process.execPath, ["--import", "file://" + join(root, "node_modules/tsx/dist/esm/index.mjs"), join(root, "src/main.ts")],
      { cwd, env: { PATH: process.env.PATH!, HOME: process.env.HOME ?? cwd, PORT: String(port), HOST: "127.0.0.1", DIAPORIA_DB_PATH: join(cwd, ".data", "diaporia.sqlite") }, stdio: ["ignore", "pipe", "pipe"] });
    let out = ""; srv.stdout.on("data", (d) => (out += d)); srv.stderr.on("data", (d) => (out += d));
    for (let i = 0; i < 150 && !/MCP endpoint/.test(out); i++) await new Promise((r) => setTimeout(r, 100));
    return { url: `http://127.0.0.1:${port}`, out: () => out, stop: () => srv.kill("SIGKILL") };
  }
  it("fresh start: the file has the AI client token only; owner confirmation is reported unavailable", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "ra-dev-"));
    const s = await boot(cwd);
    try {
      expect(s.out()).toMatch(/MCP endpoint/);
      const creds = JSON.parse(readFileSync(join(cwd, ".data/dev-credentials.json"), "utf8"));
      expect(Object.keys(creds).sort()).toEqual(["clientToken", "userId"]);
      expect(s.out()).toMatch(/owner confirmation UNAVAILABLE: DIAPORIA_OWNER_REGISTRY is not set/);
      expect(s.out()).not.toMatch(/dok_/);
    } finally { s.stop(); }
  }, 30_000);
  it("an owner key left in the file by 7d1fe4f is discarded and no longer accepted", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "ra-dev-"));
    mkdirSync(join(cwd, ".data"));
    const old = { clientToken: "dct_old_agent_token_0000000000000000", ownerKey: "dok_old_owner_key_00000000000000000", userId: "demo-user" };
    writeFileSync(join(cwd, ".data/dev-credentials.json"), JSON.stringify(old));
    const s = await boot(cwd);
    try {
      expect(s.out()).toMatch(/contained an owner key written by an earlier version/);
      expect(JSON.parse(readFileSync(join(cwd, ".data/dev-credentials.json"), "utf8"))).toEqual({ clientToken: old.clientToken, userId: "demo-user" });
      const r = await fetch(`${s.url}/authorize/cs_00000000-0000-0000-0000-000000000000`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: s.url, "Sec-Fetch-Site": "same-origin" },
        body: new URLSearchParams({ action: "review", ownerKey: old.ownerKey }).toString() });
      expect(r.status).toBe(401);
      expect(existsSync(join(cwd, ".data/dev-credentials.json"))).toBe(true);
    } finally { s.stop(); }
  }, 30_000);
});
