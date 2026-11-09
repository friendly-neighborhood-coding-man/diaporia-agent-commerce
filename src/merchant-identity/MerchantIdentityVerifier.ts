import type { MerchantOffer } from "../domain/types.js";
import { maskIdentifier, normalizeIdentifier, normalizeLegalName, sameIdentifier } from "./identifiers.js";
import { RegistryUnavailableError, type BusinessRegistryProvider, type PaymentRecipientAttestationProvider } from "./providers.js";
import type { IdentityCheck, IdentityResult, MerchantIdentityAssessment, MerchantIdentityClaim, RecipientAttestation } from "./types.js";

const combine = (results: IdentityResult[]): IdentityResult =>
  results.includes("MISMATCH") ? "MISMATCH" : results.length === 0 || results.includes("UNKNOWN") ? "UNKNOWN" : "MATCH";

export interface VerifyIdentityInput {
  offer: Pick<MerchantOffer, "merchantId" | "merchantDomain">;
  claim: MerchantIdentityClaim | null;
  /** Bind the attestation to this checkout (prepare / capture time). */
  checkoutSessionId?: string | null;
  /** When re-verifying a bound checkout: the payee and legal entity recorded at prepare time. */
  expected?: { payeeAccountId: string; identifierValue: string } | null;
}

/**
 * Verifies a merchant's claimed identity in two independent layers:
 *  1. legal entity: the claimed registration exists in a registry, is ACTIVE, and the name/jurisdiction match;
 *  2. payment relationship: the intended payee is attested to THAT legal entity and authorized for THIS merchant/domain.
 * A registration number on its own never yields MATCH. Any MISMATCH fails; any UNKNOWN stays UNKNOWN.
 */
export class MerchantIdentityVerifier {
  constructor(private readonly registry: BusinessRegistryProvider, private readonly attestations: PaymentRecipientAttestationProvider,
    private readonly now: () => number = Date.now) {}

  async verify(input: VerifyIdentityInput): Promise<MerchantIdentityAssessment> {
    const checks: IdentityCheck[] = [];
    const add = (check: IdentityCheck["check"], result: IdentityResult, provenance: IdentityCheck["provenance"], detail: string) => { checks.push({ check, result, provenance, detail }); return result; };
    const base = { merchantId: input.offer.merchantId, merchantDomain: input.offer.merchantDomain, evaluatedAt: new Date(this.now()).toISOString(),
      disclosure: "Registry and recipient-attestation evidence here comes from MOCK providers unless a check is labelled otherwise. No official registry or PayPal identity attestation is integrated." };
    const done = (legal: IdentityResult[], pay: IdentityResult[], extra: Partial<MerchantIdentityAssessment> = {}): MerchantIdentityAssessment => {
      const legalEntity = combine(legal), paymentRelationship = combine(pay);
      return { ...base, legalEntity, paymentRelationship, overall: combine([legalEntity, paymentRelationship]), checks,
        identifierMasked: null, verifiedLegalName: null, intendedPayeeAccountId: null, attestationId: null, attestationExpiresAt: null, ...extra };
    };

    const claim = input.claim;
    if (!claim) { add("CLAIM_PRESENT", "UNKNOWN", null, "Merchant published no business identity claim"); return done(["UNKNOWN"], ["UNKNOWN"]); }
    const norm = normalizeIdentifier(claim.identifier.scheme, claim.identifier.value);
    if (!norm.ok) { add("IDENTIFIER_FORMAT", "MISMATCH", null, norm.reason); return done(["MISMATCH"], ["UNKNOWN"]); }
    const id = norm.identifier;
    const masked = maskIdentifier(id);

    // ---- Layer 1: legal entity ------------------------------------------------------------
    const legal: IdentityResult[] = [];
    let verifiedLegalName: string | null = null;
    try {
      const rec = await this.registry.lookup(id);
      if (!rec) legal.push(add("REGISTRY_RECORD", "MISMATCH", "MOCK", `No registry record for ${masked}`));
      else {
        legal.push(add("REGISTRY_RECORD", "MATCH", rec.provenance, `Record found in ${rec.source}`));
        legal.push(add("REGISTRY_STATUS", rec.status === "ACTIVE" ? "MATCH" : rec.status === "UNKNOWN" ? "UNKNOWN" : "MISMATCH", rec.provenance, `Registration status ${rec.status}`));
        legal.push(add("LEGAL_NAME", normalizeLegalName(rec.legalName) === normalizeLegalName(claim.legalName) ? "MATCH" : "MISMATCH", rec.provenance, "Claimed legal name vs registry legal name"));
        legal.push(add("JURISDICTION", rec.jurisdiction === claim.jurisdiction ? "MATCH" : "MISMATCH", rec.provenance, `Claimed ${claim.jurisdiction}, registry ${rec.jurisdiction}`));
        verifiedLegalName = rec.legalName;
      }
    } catch (e) {
      legal.push(add("REGISTRY_RECORD", "UNKNOWN", null, e instanceof RegistryUnavailableError ? "Registry unavailable" : "Registry lookup failed"));
    }

    // ---- Layer 2: payment relationship ----------------------------------------------------
    const pay: IdentityResult[] = [];
    let att: RecipientAttestation | null = null;
    if (input.expected && input.expected.payeeAccountId !== claim.payeeAccountId)
      pay.push(add("ATTESTATION_BINDING", "MISMATCH", null, "Payee differs from the payee bound at checkout preparation"));
    if (input.expected && input.expected.identifierValue !== id.value)
      pay.push(add("ATTESTATION_BINDING", "MISMATCH", null, "Legal entity differs from the entity bound at checkout preparation"));
    try { att = await this.attestations.attest(claim.payeeAccountId, { merchantId: input.offer.merchantId, checkoutSessionId: input.checkoutSessionId ?? null }); }
    catch { att = null; }
    if (!att) pay.push(add("PAYEE_ATTESTATION", "UNKNOWN", null, "No recipient attestation available for the intended payee"));
    else {
      const fresh = Date.parse(att.expiresAt) > this.now() && Date.parse(att.issuedAt) <= this.now();
      const bound = att.payeeAccountId === claim.payeeAccountId && att.subject.merchantId === input.offer.merchantId &&
        (input.checkoutSessionId === undefined || att.subject.checkoutSessionId === (input.checkoutSessionId ?? null));
      pay.push(add("PAYEE_ATTESTATION", att.status === "REVOKED" ? "MISMATCH" : !fresh ? "UNKNOWN" : !bound ? "MISMATCH" : "MATCH", att.provenance,
        att.status === "REVOKED" ? "Attestation revoked" : !fresh ? `Attestation stale (expired ${att.expiresAt})` : !bound ? "Attestation is bound to a different payee, merchant or checkout" : `Attestation ${att.attestationId}`));
      pay.push(add("PAYEE_LEGAL_ENTITY", sameIdentifier(att.legalEntity, id) ? "MATCH" : "MISMATCH", att.provenance,
        sameIdentifier(att.legalEntity, id) ? "Payee belongs to the claimed legal entity" : "Payee belongs to a DIFFERENT legal entity than the one claimed"));
      const authorized = att.authorizedMerchantIds.includes(input.offer.merchantId) && att.authorizedDomains.includes(input.offer.merchantDomain.toLowerCase());
      pay.push(add("PAYEE_MERCHANT_AUTHORIZATION", authorized ? "MATCH" : "MISMATCH", att.provenance,
        authorized ? "Payee is authorized for this merchant id and domain" : "Payee is not authorized for this merchant id/domain"));
    }

    return done(legal, pay, {
      identifierMasked: masked, verifiedLegalName,
      intendedPayeeAccountId: claim.payeeAccountId,
      attestationId: att?.attestationId ?? null, attestationExpiresAt: att?.expiresAt ?? null,
    });
  }
}
