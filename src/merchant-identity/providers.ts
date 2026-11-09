import { createHash, randomUUID } from "node:crypto";
import type { BusinessIdentifier, IdentifierScheme, RecipientAttestation, RegistryRecord, RegistrationStatus } from "./types.js";

/**
 * Port for legal-entity lookups. Future implementations could wrap official sources (for
 * example the Korean National Tax Service business status service, or US state business
 * registries). NONE is implemented here; only MOCK registries exist.
 */
export interface BusinessRegistryProvider {
  readonly name: string;
  readonly schemes: IdentifierScheme[];
  /** null = the registry has no such identifier. Throws RegistryUnavailableError when it cannot answer. */
  lookup(id: BusinessIdentifier): Promise<RegistryRecord | null>;
}

export class RegistryUnavailableError extends Error {}

/**
 * Port for "this payment account belongs to legal entity X and may receive payments for
 * merchant Y". This is a PROPOSED partner capability. PayPal does not offer such a public
 * API today, and nothing here calls PayPal. Only MockPayPalRecipientAttestationProvider exists.
 */
export interface PaymentRecipientAttestationProvider {
  readonly name: string;
  /** null = no attestation exists for this payee. */
  attest(payeeAccountId: string, subject: { merchantId: string; checkoutSessionId: string | null }): Promise<RecipientAttestation | null>;
}

interface MockRegistryEntry { value: string; legalName: string; jurisdiction: string; status: RegistrationStatus }

class MockRegistry implements BusinessRegistryProvider {
  available = true;
  constructor(readonly name: string, readonly schemes: IdentifierScheme[], private readonly entries: MockRegistryEntry[], private readonly now: () => number) {}
  async lookup(id: BusinessIdentifier): Promise<RegistryRecord | null> {
    if (!this.schemes.includes(id.scheme)) return null;
    if (!this.available) throw new RegistryUnavailableError(`${this.name} unavailable`);
    const e = this.entries.find((x) => x.value === id.value);
    return e ? { identifier: { ...id }, legalName: e.legalName, jurisdiction: e.jurisdiction, status: e.status, checkedAt: new Date(this.now()).toISOString(), provenance: "MOCK", source: this.name } : null;
  }
}

/** Simulated Korean business registry. All entries are fictional. */
export class MockKoreanBusinessRegistry extends MockRegistry {
  constructor(entries: MockRegistryEntry[], now: () => number = Date.now) { super("mock-kr-business-registry", ["KR_BRN"], entries, now); }
}
/** Simulated US registry (EIN + state). The US has no single public EIN registry; this is a stand-in. */
export class MockUSBusinessRegistry extends MockRegistry {
  constructor(entries: MockRegistryEntry[], now: () => number = Date.now) { super("mock-us-business-registry", ["US_EIN"], entries, now); }
}

/** Routes a lookup to the registry that handles the identifier's scheme. */
export class CompositeBusinessRegistry implements BusinessRegistryProvider {
  readonly name = "composite-registry";
  readonly schemes: IdentifierScheme[];
  constructor(private readonly registries: BusinessRegistryProvider[]) { this.schemes = registries.flatMap((r) => r.schemes); }
  async lookup(id: BusinessIdentifier) {
    const r = this.registries.find((x) => x.schemes.includes(id.scheme));
    if (!r) throw new RegistryUnavailableError(`No registry for ${id.scheme}`);
    return r.lookup(id);
  }
}

export interface MockAttestationEntry {
  payeeAccountId: string;
  legalEntity: BusinessIdentifier;
  legalName: string;
  authorizedMerchantIds: string[];
  authorizedDomains: string[];
  status: "VALID" | "REVOKED";
  ttlSeconds: number;
}

/** Simulated recipient attestation. Labelled MOCK; it does not represent any PayPal API. */
export class MockPayPalRecipientAttestationProvider implements PaymentRecipientAttestationProvider {
  readonly name = "mock-paypal-recipient-attestation";
  calls = 0;
  /** Test hook: shift issued-at into the past to simulate stale attestations. */
  ageSeconds = 0;
  constructor(private readonly entries: MockAttestationEntry[], private readonly now: () => number = Date.now) {}
  async attest(payeeAccountId: string, subject: { merchantId: string; checkoutSessionId: string | null }): Promise<RecipientAttestation | null> {
    this.calls++;
    const e = this.entries.find((x) => x.payeeAccountId === payeeAccountId);
    if (!e) return null;
    const issued = this.now() - this.ageSeconds * 1000;
    const attestationId = "att_mock_" + createHash("sha256").update(`${payeeAccountId}|${subject.merchantId}|${subject.checkoutSessionId}|${randomUUID()}`).digest("hex").slice(0, 20);
    return { attestationId, payeeAccountId, legalEntity: { ...e.legalEntity }, legalName: e.legalName, authorizedMerchantIds: [...e.authorizedMerchantIds],
      authorizedDomains: [...e.authorizedDomains], status: e.status, issuedAt: new Date(issued).toISOString(), expiresAt: new Date(issued + e.ttlSeconds * 1000).toISOString(),
      subject: { ...subject }, provenance: "MOCK", source: this.name };
  }
}
