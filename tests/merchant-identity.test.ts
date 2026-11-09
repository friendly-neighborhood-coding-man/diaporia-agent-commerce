import { afterEach, describe, expect, it, vi } from "vitest";
import { MerchantIdentityVerifier } from "../src/merchant-identity/MerchantIdentityVerifier.js";
import {
  CompositeBusinessRegistry, MockKoreanBusinessRegistry, MockPayPalRecipientAttestationProvider, MockUSBusinessRegistry, type MockAttestationEntry,
} from "../src/merchant-identity/providers.js";
import { ATTESTATIONS, KR_REGISTRY, MERCHANT_CLAIMS, US_REGISTRY } from "../src/merchant-identity/fixtures.js";
import { krBrnChecksumValid, normalizeIdentifier } from "../src/merchant-identity/identifiers.js";
import { MockPayPalProvider } from "../src/payment/MockPayPalProvider.js";
import { buyer, CA, call, callError, createMandate, mcpClient, OWNER, researchAndCompare, SONY_BLACK, startHarness, TOKENS, type Harness } from "./helpers.js";

function world() {
  const kr = new MockKoreanBusinessRegistry(structuredClone(KR_REGISTRY));
  const us = new MockUSBusinessRegistry(structuredClone(US_REGISTRY));
  const attEntries: MockAttestationEntry[] = structuredClone(ATTESTATIONS);
  const att = new MockPayPalRecipientAttestationProvider(attEntries);
  return { kr, us, attEntries, att, verifier: new MerchantIdentityVerifier(new CompositeBusinessRegistry([kr, us]), att) };
}
const alphaOffer = { merchantId: "mer_alpha_audio", merchantDomain: "alpha-audio.example" };
const alphaClaim = () => structuredClone(MERCHANT_CLAIMS["alpha-audio.example"]!);
const check = (a: { checks: Array<{ check: string; result: string }> }, name: string) => a.checks.filter((c) => c.check === name).map((c) => c.result);

describe("identifier normalization", () => {
  it("normalizes separators and validates the KR check digit; format validity is not identity", async () => {
    expect(normalizeIdentifier("KR_BRN", "101-81-00001")).toEqual({ ok: true, identifier: { scheme: "KR_BRN", value: "1018100001" } });
    expect(krBrnChecksumValid("1018100002")).toBe(false);
    expect(normalizeIdentifier("US_EIN", "00-1000001")).toEqual({ ok: true, identifier: { scheme: "US_EIN", value: "001000001" } });
    expect(normalizeIdentifier("US_EIN", "12-345")).toMatchObject({ ok: false });
    // A well-formed number with a valid checksum, but nothing else attested, is NOT a match.
    const { verifier, attEntries } = world();
    attEntries.splice(0, attEntries.length);
    const a = await verifier.verify({ offer: alphaOffer, claim: alphaClaim() });
    expect(a.legalEntity).toBe("MATCH");
    expect(a.overall).toBe("UNKNOWN");
  });
});

describe("MerchantIdentityVerifier semantics", () => {
  it("valid merchant: both layers MATCH, evidence labelled MOCK, identifier masked", async () => {
    const a = await world().verifier.verify({ offer: alphaOffer, claim: alphaClaim() });
    expect(a).toMatchObject({ legalEntity: "MATCH", paymentRelationship: "MATCH", overall: "MATCH", identifierMasked: "101-81-*****", intendedPayeeAccountId: "MOCKPAYEE-ALPHA" });
    expect(new Set(a.checks.map((c) => c.provenance))).toEqual(new Set(["MOCK"]));
    expect(JSON.stringify(a)).not.toContain("1018100001");
  });

  it("stolen business-registration details: the registry matches, the payee does not", async () => {
    const a = await world().verifier.verify({ offer: { merchantId: "mer_alpha_audi0", merchantDomain: "alpha-audi0.example" }, claim: MERCHANT_CLAIMS["alpha-audi0.example"]! });
    expect(a.legalEntity).toBe("MATCH");
    expect(a.paymentRelationship).toBe("MISMATCH");
    expect(a.overall).toBe("MISMATCH");
    expect(check(a, "PAYEE_LEGAL_ENTITY")).toEqual(["MISMATCH"]);
    expect(check(a, "PAYEE_MERCHANT_AUTHORIZATION")).toEqual(["MISMATCH"]);
  });

  it("inconsistent legal entity: wrong legal name, wrong jurisdiction, unknown or closed registration", async () => {
    const { verifier } = world();
    const name = await verifier.verify({ offer: alphaOffer, claim: { ...alphaClaim(), legalName: "Alpha Audio Holdings Ltd." } });
    expect(check(name, "LEGAL_NAME")).toEqual(["MISMATCH"]);
    expect(name.overall).toBe("MISMATCH");
    const juris = await verifier.verify({ offer: alphaOffer, claim: { ...alphaClaim(), jurisdiction: "US-DE" } });
    expect(check(juris, "JURISDICTION")).toEqual(["MISMATCH"]);
    const missing = await verifier.verify({ offer: alphaOffer, claim: { ...alphaClaim(), identifier: { scheme: "KR_BRN", value: "220-81-11116" } } });
    expect(check(missing, "IDENTIFIER_FORMAT")).toEqual(["MISMATCH"]); // checksum fails
    const closed = await verifier.verify({ offer: { merchantId: "mer_foxtrot_shop", merchantDomain: "foxtrot-shop.example" }, claim: MERCHANT_CLAIMS["foxtrot-shop.example"]! });
    expect(check(closed, "REGISTRY_STATUS")).toEqual(["MISMATCH"]);
    // Payee attested to a different entity than the one claimed.
    const otherEntity = await verifier.verify({ offer: alphaOffer, claim: { ...alphaClaim(), payeeAccountId: "MOCKPAYEE-CHARLIE" } });
    expect(check(otherEntity, "PAYEE_LEGAL_ENTITY")).toEqual(["MISMATCH"]);
  });

  it("altered merchant id: the attestation does not authorize the payee for it", async () => {
    const a = await world().verifier.verify({ offer: { merchantId: "mer_alpha_audio_2", merchantDomain: "alpha-audio.example" }, claim: alphaClaim() });
    expect(check(a, "PAYEE_MERCHANT_AUTHORIZATION")).toEqual(["MISMATCH"]);
    expect(a.overall).toBe("MISMATCH");
  });

  it("stale attestation is UNKNOWN (never MATCH); revoked is MISMATCH; registry outage is UNKNOWN", async () => {
    const w = world();
    w.att.ageSeconds = 3600; // TTL is 1800 s
    const stale = await w.verifier.verify({ offer: alphaOffer, claim: alphaClaim() });
    expect(check(stale, "PAYEE_ATTESTATION")).toEqual(["UNKNOWN"]);
    expect(stale.overall).toBe("UNKNOWN");
    const w2 = world();
    w2.attEntries.find((e) => e.payeeAccountId === "MOCKPAYEE-ALPHA")!.status = "REVOKED";
    expect((await w2.verifier.verify({ offer: alphaOffer, claim: alphaClaim() })).overall).toBe("MISMATCH");
    const w3 = world();
    (w3.kr as unknown as { available: boolean }).available = false;
    const down = await w3.verifier.verify({ offer: alphaOffer, claim: alphaClaim() });
    expect(down.legalEntity).toBe("UNKNOWN");
    expect(down.overall).toBe("UNKNOWN");
    expect((await w3.verifier.verify({ offer: alphaOffer, claim: null })).overall).toBe("UNKNOWN");
  });

  it("an attestation bound to another checkout or payee does not match a re-check", async () => {
    const { verifier } = world();
    const a = await verifier.verify({ offer: alphaOffer, claim: alphaClaim(), checkoutSessionId: "cs_x", expected: { payeeAccountId: "MOCKPAYEE-ZULU", identifierValue: "1018100001" } });
    expect(check(a, "ATTESTATION_BINDING")).toEqual(["MISMATCH"]);
    const b = await verifier.verify({ offer: alphaOffer, claim: alphaClaim(), checkoutSessionId: "cs_x", expected: { payeeAccountId: "MOCKPAYEE-ALPHA", identifierValue: "2208111115" } });
    expect(b.overall).toBe("MISMATCH");
  });
});

describe("checkout-time merchant identity binding (MCP, mock payments)", () => {
  const hs: Harness[] = [];
  afterEach(async () => { vi.restoreAllMocks(); for (const h of hs.splice(0)) await h.close(); });
  async function setup(over: Parameters<typeof startHarness>[0] = {}) {
    const h = await startHarness(over); hs.push(h);
    const client = await mcpClient(h.url, TOKENS.alice);
    await createMandate(h.url, OWNER.alice, { productIdentity: SONY_BLACK, currency: "USD", maximumTotalMinor: 6000 });
    const rc = await researchAndCompare(client);
    const args = { purchaseSessionId: rc.research.purchaseSessionId, offerId: "off_alpha", maximumApprovedTotalMinor: 6000, currency: "USD", quantity: 1 };
    return { h, client, ...rc, args };
  }

  it("compare: the cheaper impersonator is rejected; the valid merchant carries MATCH evidence", async () => {
    const { client, compare } = await setup();
    const imp = compare.ineligibleOffers.find((o: any) => o.offerId === "off_imposter");
    expect(imp.issues).toEqual(["MERCHANT_IDENTITY_MISMATCH"]);
    expect(imp.cost.totalMinor).toBeLessThan(5939);
    expect(imp.merchantIdentity).toMatchObject({ legalEntity: "MATCH", paymentRelationship: "MISMATCH", overall: "MISMATCH" });
    expect(compare.lowestVerifiedEligibleOffer).toMatchObject({ offerId: "off_alpha", merchantIdentity: { overall: "MATCH" } });
    expect(JSON.stringify(compare)).not.toMatch(/1018100001|001999999/); // identifiers are masked
    await client.close();
  });

  it("prepare binds business, offer, attested payee and attestation; capture pays exactly that recipient", async () => {
    const { h, client, args } = await setup();
    const prep = await call(client, "prepare_checkout", args);
    expect(prep.purchaseSummary.merchantIdentity).toMatchObject({ overall: "MATCH", intendedPayeeId: "MOCKPAYEE-ALPHA", attestedPayeeId: "MOCKPAYEE-ALPHA",
      payeeRelationship: "MERCHANT_ATTESTED_PAYEE", identifierMasked: "101-81-*****", provenance: ["MOCK"] });
    expect(JSON.stringify(prep)).not.toContain("1018100001");
    const orderId = new URL(prep.approvalUrl).pathname.split("/").pop()!;
    expect(h.mock.describe(orderId)!.payee.merchantId).toBe("MOCKPAYEE-ALPHA");
    await buyer(h, prep.approvalUrl);
    const s = await call(client, "get_checkout_status", { checkoutSessionId: prep.checkoutSessionId });
    expect(s.state).toBe("COMPLETED");
    expect(s.recipient).toEqual({ intendedPayeeId: "MOCKPAYEE-ALPHA", actualRecipientId: "MOCKPAYEE-ALPHA", verified: true, provenance: "MOCK" });
    const r = await call(client, "get_purchase_receipt", { checkoutSessionId: prep.checkoutSessionId });
    expect(r.auditTimeline.map((e: any) => e.type)).toEqual(expect.arrayContaining(["MERCHANT_IDENTITY_BOUND", "MERCHANT_RECIPIENT_VERIFIED"]));
    expect(r.merchantOrder.status).toBe("NOT_VERIFIED");
    await client.close();
  });

  it("payment-recipient substitution after approval fails closed: nothing captured, reservation released", async () => {
    const { h, client, args } = await setup();
    const prep = await call(client, "prepare_checkout", args);
    const orderId = new URL(prep.approvalUrl).pathname.split("/").pop()!;
    h.mock.substitutePayee(orderId, "MOCKPAYEE-ZULU");
    await buyer(h, prep.approvalUrl);
    const s = await call(client, "get_checkout_status", { checkoutSessionId: prep.checkoutSessionId });
    expect(s.state).toBe("FAILED");
    expect(s.failure.code).toBe("MERCHANT_RECIPIENT_MISMATCH");
    expect(h.mock.calls.captureOrder).toBe(0);
    expect(h.app.gateway.mandates.listActive("alice")[0]!.reservedMinor).toBe(0);
    await client.close();
  });

  it("an attestation that goes stale or is revoked before capture blocks the capture", async () => {
    const w = world();
    const { h, client, args } = await setup({ merchantIdentity: w.verifier });
    const prep = await call(client, "prepare_checkout", args);
    w.att.ageSeconds = 3600;
    await buyer(h, prep.approvalUrl);
    const s = await call(client, "get_checkout_status", { checkoutSessionId: prep.checkoutSessionId });
    expect(s).toMatchObject({ state: "FAILED", failure: { code: "MERCHANT_IDENTITY_UNKNOWN" } });
    expect(h.mock.calls.captureOrder).toBe(0);
    await client.close();
  });

  it("revocation between compare and prepare, and an altered merchant id, are rejected at prepare", async () => {
    const w = world();
    const { h, client, args } = await setup({ merchantIdentity: w.verifier });
    w.attEntries.find((e) => e.payeeAccountId === "MOCKPAYEE-ALPHA")!.status = "REVOKED";
    expect((await callError(client, "prepare_checkout", args)).code).toBe("MERCHANT_IDENTITY_MISMATCH");
    w.attEntries.find((e) => e.payeeAccountId === "MOCKPAYEE-ALPHA")!.status = "VALID";
    const real = h.app.gateway.research.findOffers.bind(h.app.gateway.research);
    vi.spyOn(h.app.gateway.research, "findOffers").mockImplementation(async (id) => (await real(id)).map((o) => o.offerId === "off_alpha" ? { ...o, merchantId: "mer_alpha_audi0" } : o));
    const altered = await callError(client, "prepare_checkout", args);
    expect(altered.code).toBe("MERCHANT_IDENTITY_MISMATCH");
    expect(h.mock.calls.createOrder).toBe(0);
    await client.close();
  });

  it("Sandbox platform mode: the recipient is DIAPORIA's own Sandbox account, and must be configured", async () => {
    // Test double that reports itself as PAYPAL_SANDBOX but makes no network calls.
    class FakeSandbox extends MockPayPalProvider { override readonly name = "PAYPAL_SANDBOX" as any; }
    const unset = await setup({ payments: (b) => new FakeSandbox(b) });
    expect((await callError(unset.client, "prepare_checkout", unset.args)).code).toBe("MERCHANT_RECIPIENT_UNKNOWN");
    await unset.client.close();
    const set = await setup({ payments: (b) => new FakeSandbox(b), sandboxPlatformPayeeId: "SANDBOXPLATFORM01" });
    const prep = await call(set.client, "prepare_checkout", set.args);
    expect(prep.purchaseSummary.merchantIdentity).toMatchObject({ intendedPayeeId: "SANDBOXPLATFORM01", attestedPayeeId: "MOCKPAYEE-ALPHA", payeeRelationship: "DIAPORIA_SANDBOX_PLATFORM_ACCOUNT" });
    expect(prep.paymentEnvironment).toBe("PAYPAL_SANDBOX");
    await set.client.close();
  });

  it("existing budget, mandate and idempotency protections are unchanged", async () => {
    const { h, client, args } = await setup();
    const again = [await call(client, "prepare_checkout", args), await call(client, "prepare_checkout", args)];
    expect(again[1].deduplicated).toBe(true);
    expect(h.mock.calls.createOrder).toBe(1);
    const big = await call(client, "research_purchase", { request: "Buy Sony WH-CH720N Black", currency: "USD", budgetMinor: 1_000_000 });
    await call(client, "compare_purchase_offers", { researchSessionId: big.purchaseSessionId, productIdentity: SONY_BLACK, destination: CA });
    const hold = await call(client, "prepare_checkout", { ...args, purchaseSessionId: big.purchaseSessionId, offerId: "off_india", maximumApprovedTotalMinor: 600000 });
    expect(hold.purchaseSummary.merchantIdentity.overall).toBe("MATCH"); // identity is fine...
    expect(hold.policy.code).not.toBe("ALLOWED");                        // ...the mandate still refuses
    expect(h.mock.calls.createOrder).toBe(1);
    await client.close();
  });
});
