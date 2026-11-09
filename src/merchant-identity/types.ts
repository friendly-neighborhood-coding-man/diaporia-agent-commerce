/**
 * Merchant identity verification types. Provider-agnostic: the same shapes are meant to carry
 * evidence from official business registries and from payment-provider recipient attestations.
 * Today, only MOCK providers exist (see README "Merchant Identity Verification — Mocked Future Integration").
 */

/** Where a piece of evidence came from. Never upgrade MOCK evidence to another label. */
export type Provenance = "MOCK" | "OFFICIAL_REGISTRY" | "PAYMENT_PROVIDER";

/** Strict tri-state. UNKNOWN is never treated as MATCH. */
export type IdentityResult = "MATCH" | "MISMATCH" | "UNKNOWN";

export type IdentifierScheme = "KR_BRN" | "US_EIN";

export interface BusinessIdentifier {
  scheme: IdentifierScheme;
  /** Digits only, normalized. Kept server-side; outputs use `masked`. */
  value: string;
}

/** Merchant-supplied (untrusted) identity claim, e.g. from a merchant profile or listing footer. */
export interface MerchantIdentityClaim {
  identifier: { scheme: IdentifierScheme; value: string };
  legalName: string;
  /** "KR" or "US-<state>" */
  jurisdiction: string;
  /** Payment account the merchant says should receive funds. */
  payeeAccountId: string;
}

export type RegistrationStatus = "ACTIVE" | "SUSPENDED" | "CLOSED" | "UNKNOWN";

/** A legal-entity record. Says nothing about who may receive payments. */
export interface RegistryRecord {
  identifier: BusinessIdentifier;
  legalName: string;
  jurisdiction: string;
  status: RegistrationStatus;
  checkedAt: string;
  provenance: Provenance;
  source: string;
}

/** Statement that a payment account belongs to a legal entity and is authorized for given merchants. */
export interface RecipientAttestation {
  attestationId: string;
  payeeAccountId: string;
  legalEntity: BusinessIdentifier;
  legalName: string;
  authorizedMerchantIds: string[];
  authorizedDomains: string[];
  status: "VALID" | "REVOKED";
  issuedAt: string;
  expiresAt: string;
  /** What the attestation was issued for. A checkout-bound attestation names its checkout. */
  subject: { merchantId: string; checkoutSessionId: string | null };
  provenance: Provenance;
  source: string;
}

export type IdentityCheckName =
  | "CLAIM_PRESENT" | "IDENTIFIER_FORMAT" | "REGISTRY_RECORD" | "REGISTRY_STATUS" | "LEGAL_NAME" | "JURISDICTION"
  | "PAYEE_ATTESTATION" | "PAYEE_LEGAL_ENTITY" | "PAYEE_MERCHANT_AUTHORIZATION" | "ATTESTATION_BINDING";

export interface IdentityCheck {
  check: IdentityCheckName;
  result: IdentityResult;
  provenance: Provenance | null;
  detail: string;
}

export interface MerchantIdentityAssessment {
  merchantId: string;
  merchantDomain: string;
  /** Legal-entity identity: does the claimed business exist, is it active, does the name match. */
  legalEntity: IdentityResult;
  /** Payment relationship: is the intended payee attested to that entity and this merchant. */
  paymentRelationship: IdentityResult;
  overall: IdentityResult;
  checks: IdentityCheck[];
  identifierMasked: string | null;
  verifiedLegalName: string | null;
  intendedPayeeAccountId: string | null;
  attestationId: string | null;
  attestationExpiresAt: string | null;
  evaluatedAt: string;
  disclosure: string;
}
