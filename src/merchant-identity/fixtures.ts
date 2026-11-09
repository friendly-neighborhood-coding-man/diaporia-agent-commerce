/**
 * FICTIONAL merchant identity data for the mock registries and the mock recipient attestation.
 * Korean numbers have valid check digits so the format validator accepts them; US EINs use the
 * unassigned "00" prefix. Any coincidence with a real registration is unintended.
 */
import type { MerchantIdentityClaim } from "./types.js";
import type { MockAttestationEntry } from "./providers.js";

export const KR_REGISTRY = [
  { value: "1018100001", legalName: "Alpha Audio Co., Ltd.", jurisdiction: "KR", status: "ACTIVE" as const },
  { value: "2208111115", legalName: "Charlie Mart Inc.", jurisdiction: "KR", status: "ACTIVE" as const },
  { value: "3148622227", legalName: "Echo Outlet Co.", jurisdiction: "KR", status: "ACTIVE" as const },
  { value: "4098133333", legalName: "Foxtrot Shop Co.", jurisdiction: "KR", status: "CLOSED" as const },
  { value: "6058744444", legalName: "India Premium Co.", jurisdiction: "KR", status: "ACTIVE" as const },
];
export const US_REGISTRY = [
  { value: "001000001", legalName: "Bravo Electronics LLC", jurisdiction: "US-DE", status: "ACTIVE" as const },
  { value: "001000002", legalName: "Delta Deals Inc.", jurisdiction: "US-CA", status: "ACTIVE" as const },
  { value: "001000003", legalName: "Golf Gadgets LLC", jurisdiction: "US-NY", status: "ACTIVE" as const },
  { value: "001000004", legalName: "Hotel Supply Corp.", jurisdiction: "US-TX", status: "SUSPENDED" as const },
  { value: "001999999", legalName: "Zulu Trading LLC", jurisdiction: "US-NV", status: "ACTIVE" as const },
];

const kr = (value: string) => ({ scheme: "KR_BRN" as const, value });
const us = (value: string) => ({ scheme: "US_EIN" as const, value });
const att = (payee: string, entity: { scheme: "KR_BRN" | "US_EIN"; value: string }, legalName: string, merchantId: string, domain: string): MockAttestationEntry =>
  ({ payeeAccountId: payee, legalEntity: entity, legalName, authorizedMerchantIds: [merchantId], authorizedDomains: [domain], status: "VALID", ttlSeconds: 1800 });

export const ATTESTATIONS: MockAttestationEntry[] = [
  att("MOCKPAYEE-ALPHA", kr("1018100001"), "Alpha Audio Co., Ltd.", "mer_alpha_audio", "alpha-audio.example"),
  att("MOCKPAYEE-BRAVO", us("001000001"), "Bravo Electronics LLC", "mer_bravo_electronics", "bravo-electronics.example"),
  att("MOCKPAYEE-CHARLIE", kr("2208111115"), "Charlie Mart Inc.", "mer_charlie_mart", "charlie-mart.example"),
  att("MOCKPAYEE-DELTA", us("001000002"), "Delta Deals Inc.", "mer_delta_deals", "delta-deals.example"),
  att("MOCKPAYEE-ECHO", kr("3148622227"), "Echo Outlet Co.", "mer_echo_outlet", "echo-outlet.example"),
  att("MOCKPAYEE-FOXTROT", kr("4098133333"), "Foxtrot Shop Co.", "mer_foxtrot_shop", "foxtrot-shop.example"),
  att("MOCKPAYEE-GOLF", us("001000003"), "Golf Gadgets LLC", "mer_golf_gadgets", "golf-gadgets.example"),
  att("MOCKPAYEE-HOTEL", us("001000004"), "Hotel Supply Corp.", "mer_hotel_supply", "hotel-supply.example"),
  att("MOCKPAYEE-INDIA", kr("6058744444"), "India Premium Co.", "mer_india_premium", "india-premium.example"),
  // The impersonator's payment account really belongs to a different company.
  att("MOCKPAYEE-ZULU", us("001999999"), "Zulu Trading LLC", "mer_zulu_trading", "zulu-trading.example"),
];

/** Identity claims as merchants publish them (untrusted). Keyed by merchant domain. */
export const MERCHANT_CLAIMS: Record<string, MerchantIdentityClaim> = {
  "alpha-audio.example": { identifier: { scheme: "KR_BRN", value: "101-81-00001" }, legalName: "Alpha Audio Co., Ltd.", jurisdiction: "KR", payeeAccountId: "MOCKPAYEE-ALPHA" },
  "bravo-electronics.example": { identifier: { scheme: "US_EIN", value: "00-1000001" }, legalName: "Bravo Electronics LLC", jurisdiction: "US-DE", payeeAccountId: "MOCKPAYEE-BRAVO" },
  "charlie-mart.example": { identifier: { scheme: "KR_BRN", value: "220-81-11115" }, legalName: "Charlie Mart Inc.", jurisdiction: "KR", payeeAccountId: "MOCKPAYEE-CHARLIE" },
  "delta-deals.example": { identifier: { scheme: "US_EIN", value: "00-1000002" }, legalName: "Delta Deals Inc.", jurisdiction: "US-CA", payeeAccountId: "MOCKPAYEE-DELTA" },
  "echo-outlet.example": { identifier: { scheme: "KR_BRN", value: "314-86-22227" }, legalName: "Echo Outlet Co.", jurisdiction: "KR", payeeAccountId: "MOCKPAYEE-ECHO" },
  "foxtrot-shop.example": { identifier: { scheme: "KR_BRN", value: "409-81-33333" }, legalName: "Foxtrot Shop Co.", jurisdiction: "KR", payeeAccountId: "MOCKPAYEE-FOXTROT" },
  "golf-gadgets.example": { identifier: { scheme: "US_EIN", value: "00-1000003" }, legalName: "Golf Gadgets LLC", jurisdiction: "US-NY", payeeAccountId: "MOCKPAYEE-GOLF" },
  "hotel-supply.example": { identifier: { scheme: "US_EIN", value: "00-1000004" }, legalName: "Hotel Supply Corp.", jurisdiction: "US-TX", payeeAccountId: "MOCKPAYEE-HOTEL" },
  "india-premium.example": { identifier: { scheme: "KR_BRN", value: "605-87-44444" }, legalName: "India Premium Co.", jurisdiction: "KR", payeeAccountId: "MOCKPAYEE-INDIA" },
  // Impersonation: look-alike domain, STOLEN Alpha Audio registration number and name, its own payee account.
  "alpha-audi0.example": { identifier: { scheme: "KR_BRN", value: "101-81-00001" }, legalName: "Alpha Audio Co., Ltd.", jurisdiction: "KR", payeeAccountId: "MOCKPAYEE-ZULU" },
};
