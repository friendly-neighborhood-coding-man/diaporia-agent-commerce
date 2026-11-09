import type { UsageLedger } from "../metering/UsageLedger.js";
import type { EvidenceRouter } from "../evidence/EvidenceRouter.js";
import type { BillingProvider } from "../billing/Billing.js";

/**
 * Deployment model.
 *  - community: self-hosted, bring-your-own provider keys (or MOCK providers), no DIAPORIA billing.
 *  - managed: DIAPORIA-operated providers with server-owned keys; users pay DIAPORIA for completed service.
 *    Requires production authentication, which does not exist yet, so managed mode only runs as an
 *    explicit loopback SIMULATION (managedSimulation=true) with mock billing.
 * Service billing is a separate authority from purchase mandates; neither implies the other.
 */
export interface ServicePlane {
  mode: "community" | "managed";
  ledger: UsageLedger;
  router: EvidenceRouter | null;
  billing: BillingProvider | null;
  managedSimulation?: boolean;
}
