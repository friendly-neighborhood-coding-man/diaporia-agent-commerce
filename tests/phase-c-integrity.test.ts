/**
 * PR #6 re-review (offline): code pinning, owner signatures and host/user binding, on both the merchant and DIAPORIA.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { hostname, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { ConfigRefusedError, approvalDigest, buildApprovalStatement, canonicalJson as merchantCanonical, loadAllowlist, loadMerchantConfig, type Gate } from "../apps/phase-c-test-merchant/src/config.js";
import { hashTree as merchantHashTree, loadOwnerPublicKey, merchantArtifactSha256 } from "../apps/phase-c-test-merchant/src/integrity.js";
import { canonicalJson as diaporiaCanonical, diaporiaArtifactSha256, hashTree as diaporiaHashTree, verifyPhaseCApproval } from "../src/handoff/phaseCApproval.js";
import { phaseCBrowserHosts, phaseCRecipe } from "../src/handoff/phaseCMerchant.js";
import { OWNER_PUBLIC_KEY_FILE, OWNER_PUBLIC_KEY_PEM, ORIGIN, SELLER_ID, SOURCE_COMMIT, allowlistText, otherSign, ownerSign, sandboxEnv } from "./phase-c-helpers.js";

const refusedCode = (f: () => unknown): string => { try { f(); } catch (e) { expect(e).toBeInstanceOf(ConfigRefusedError); return (e as ConfigRefusedError).code; } throw new Error("expected refusal"); };

describe("merchant startup: pinned code, host and owner signature", () => {
  it("the matching, owner-signed configuration starts", () => {
    const cfg = loadMerchantConfig(sandboxEnv("C1"));
    expect(cfg.approval!.statement).toMatchObject({ schema: "diaporia.phase-c.approval.v3", merchantArtifactSha256: merchantArtifactSha256(), merchantHost: hostname(), sourceCommit: SOURCE_COMMIT });
  });
  it("refuses without the owner's signature, with another key's signature, or a signature for another purpose", () => {
    const env = sandboxEnv("C1");
    expect(refusedCode(() => loadMerchantConfig({ ...env, PHASE_C_APPROVAL_SIGNATURE: "" }))).toBe("APPROVAL_SIGNATURE_INVALID");
    expect(refusedCode(() => loadMerchantConfig({ ...env, PHASE_C_APPROVAL_SIGNATURE: otherSign("approval", env.PHASE_C_APPROVED_DIGEST!) }))).toBe("APPROVAL_SIGNATURE_INVALID");
    expect(refusedCode(() => loadMerchantConfig({ ...env, PHASE_C_APPROVAL_SIGNATURE: ownerSign("capture-retry", env.PHASE_C_APPROVED_DIGEST!) }))).toBe("APPROVAL_SIGNATURE_INVALID");
    expect(refusedCode(() => loadMerchantConfig({ ...env, PHASE_C_OWNER_PUBLIC_KEY_FILE: "" }))).toBe("OWNER_KEY_REQUIRED");
  });
  it("refuses when the running code, host, commit or DIAPORIA binding differs from what the owner signed", () => {
    // A statement the owner signed for OTHER code / another host: the merchant rebuilds the statement from what it really is.
    const env = sandboxEnv("C1");
    const st = loadMerchantConfig(env).approval!.statement;
    for (const over of [{ merchantArtifactSha256: "e".repeat(64) }, { merchantHost: "some-other-host" }]) {
      const digest = approvalDigest({ ...st, ...over });
      expect(refusedCode(() => loadMerchantConfig({ ...env, PHASE_C_APPROVED_DIGEST: digest, PHASE_C_APPROVAL_SIGNATURE: ownerSign("approval", digest) }))).toBe("APPROVAL_DIGEST_MISMATCH");
    }
    expect(refusedCode(() => loadMerchantConfig({ ...env, PHASE_C_SOURCE_COMMIT: "f".repeat(40) }))).toBe("APPROVAL_DIGEST_MISMATCH");
    expect(refusedCode(() => loadMerchantConfig({ ...env, PHASE_C_DIAPORIA_SERVICE_USER: "someone-else" }))).toBe("APPROVAL_DIGEST_MISMATCH");
    expect(refusedCode(() => loadMerchantConfig({ ...env, PHASE_C_SOURCE_COMMIT: "abc" }))).toBe("APPROVAL_INVALID");
  });
  it("the artifact hash changes with any file in the merchant's code or public dir", () => {
    const d = mkdtempSync(join(tmpdir(), "phc-art-"));
    mkdirSync(join(d, "src")); mkdirSync(join(d, "public"));
    writeFileSync(join(d, "src", "a.js"), "1"); writeFileSync(join(d, "public", "checkout.js"), "x");
    const h1 = merchantArtifactSha256(join(d, "src"), join(d, "public"));
    writeFileSync(join(d, "public", "checkout.js"), "y");
    expect(merchantArtifactSha256(join(d, "src"), join(d, "public"))).not.toBe(h1);
  });
});

describe("DIAPORIA: verifies the signed statement before any KERNEL browser", () => {
  const DIAP = "c".repeat(64);
  const recipe = phaseCRecipe(ORIGIN, phaseCBrowserHosts(allowlistText()));
  function signedStatement(over: Record<string, unknown> = {}, gate: Gate = "C1") {
    const st = { ...buildApprovalStatement({ gate, merchantOrigin: ORIGIN, allowlist: loadAllowlist(allowlistText()), sellerMerchantId: SELLER_ID, maxMinutes: 7,
      kernelUsdEstimate: "0.50", merchantDataDir: "/srv/phc/c1", expiresAt: new Date(Date.now() + 3600_000).toISOString(), sourceCommit: SOURCE_COMMIT,
      merchantArtifactSha256: "a".repeat(64), diaporiaArtifactSha256: DIAP, merchantHost: "merchant-box", diaporiaHost: hostname(), diaporiaServiceUser: userInfo().username,
      ownerPublicKeySha256: loadOwnerPublicKey(OWNER_PUBLIC_KEY_PEM).sha256 }), ...over };
    const digest = approvalDigest(st as any);
    const file = join(mkdtempSync(join(tmpdir(), "phc-st-")), "statement.json");
    writeFileSync(file, JSON.stringify({ statement: st, digest }));
    return { digest, env: { PHASE_C_APPROVED_DIGEST: digest, PHASE_C_APPROVAL_STATEMENT_FILE: file, PHASE_C_OWNER_PUBLIC_KEY_FILE: OWNER_PUBLIC_KEY_FILE, PHASE_C_APPROVAL_SIGNATURE: ownerSign("approval", digest) } };
  }
  const ok = { artifactSha256: DIAP };

  it("accepts the owner-signed statement for this build, host and user; minutes become the watchdog wall clock", () => {
    const { env, digest } = signedStatement();
    expect(verifyPhaseCApproval(env, recipe, ok)).toMatchObject({ digest, gate: "C1", maxWallMs: 7 * 60_000, kernelBrowsers: 1 });
  });
  it.each([
    ["no signature", (e: any) => ({ ...e, PHASE_C_APPROVAL_SIGNATURE: "" }), /signature/],
    ["another key", (e: any) => ({ ...e, PHASE_C_APPROVAL_SIGNATURE: otherSign("approval", e.PHASE_C_APPROVED_DIGEST) }), /signature/],
    ["a different digest", (e: any) => ({ ...e, PHASE_C_APPROVED_DIGEST: "1".repeat(64) }), /does not hash/],
  ])("refuses %s", (_n, mutate, re) => {
    expect(() => verifyPhaseCApproval(mutate(signedStatement().env), recipe, ok)).toThrow(re);
  });
  it("refuses another build, host, OS user, origin, egress list or an expired approval", () => {
    const { env } = signedStatement();
    expect(() => verifyPhaseCApproval(env, recipe, { artifactSha256: "9".repeat(64) })).toThrow(/approved artifact/);
    expect(() => verifyPhaseCApproval(env, recipe, { ...ok, host: "laptop-2" })).toThrow(/approved DIAPORIA host/);
    expect(() => verifyPhaseCApproval(env, recipe, { ...ok, user: "root2" })).toThrow(/service user/);
    expect(() => verifyPhaseCApproval(env, phaseCRecipe("https://other-shop.com", ["other-shop.com", "www.sandbox.paypal.com"]), ok)).toThrow(/origin/);
    expect(() => verifyPhaseCApproval(env, { ...recipe, networkAllowedHosts: [...recipe.networkAllowedHosts!, "www.paypalobjects.com"] }, ok)).toThrow(/egress/);
    expect(() => verifyPhaseCApproval(env, recipe, { ...ok, now: Date.now() + 2 * 3600_000 })).toThrow(/expired/);
  });
  it("DIAPORIA and the merchant compute the same canonical form and tree hash", () => {
    const v = { b: [1, { z: "x", a: null }], a: "é" };
    expect(diaporiaCanonical(v)).toBe(merchantCanonical(v));
    const d = mkdtempSync(join(tmpdir(), "phc-tree-"));
    mkdirSync(join(d, "x")); writeFileSync(join(d, "x", "f.js"), "1"); writeFileSync(join(d, "g.js"), "2");
    expect(diaporiaHashTree({ src: d })).toBe(merchantHashTree({ src: d }));
    expect(diaporiaArtifactSha256(d)).toBe(merchantHashTree({ src: d }));
  });
});
