import { createApp } from "../../src/http/server.js";
import { DevAuth } from "../../src/auth/devAuth.js";
import { CommerceError } from "../../src/engine/errors.js";
import { EvalResearchAdapter } from "./world.js";
import { EVAL_CASES, type EvalCase } from "./cases.js";

export interface CaseCheck { field: string; expected: unknown; observed: unknown; pass: boolean; critical: boolean }
export interface CaseResult { id: string; category: string; pass: boolean; checks: CaseCheck[]; latencyMs: number; adapterCalls: number; error?: string }
export interface EvalReport {
  cases: CaseResult[];
  metrics: {
    cases: number; passed: number;
    byDimension: Record<string, { checked: number; correct: number }>;
    /** Safety-critical errors: a trap offer marked eligible, a verified-cheapest claim where none is verifiable, a substituted identity, a budget raised by text. */
    criticalErrors: number;
    failureTypes: Record<string, number>;
    latencyMs: { p50: number; max: number; total: number };
    adapterCalls: number; externalProviderCalls: 0; supplierCostMicro: 0;
  };
}

const sku = (x: any) => x?.lockedIdentity?.sku ?? null;

export async function runResearchEval(cases: EvalCase[] = EVAL_CASES): Promise<EvalReport> {
  const adapter = new EvalResearchAdapter();
  const app = createApp({ host: "127.0.0.1", port: 0, baseUrl: "http://127.0.0.1:1", authMode: "dev", dbPath: ":memory:", auth: new DevAuth(), research: adapter });
  const g = app.gateway;
  const results: CaseResult[] = [];
  try {
    for (const c of cases) {
      const checks: CaseCheck[] = [];
      const add = (field: string, expected: unknown, observed: unknown, critical = false, pass?: boolean) =>
        checks.push({ field, expected, observed, pass: pass ?? JSON.stringify(expected) === JSON.stringify(observed), critical });
      const before = Object.values(adapter.calls).reduce((a, b) => a + b, 0);
      const t0 = performance.now();
      let error: string | undefined;
      try {
        const r: any = await g.researchPurchase("eval-user", { request: c.request, ...(c.input ?? {}) });
        const e = c.expect;
        add("mode", e.mode, r.mode);
        add("identity", e.identity, r.identity.status, e.identity !== "LOCKED" && r.identity.status === "LOCKED");
        if (e.lockedSku) add("lockedSku", e.lockedSku, sku(r.identity), true);
        if (e.budgetSource) add("budgetSource", e.budgetSource, r.intent.budgetSource, e.budgetSource === "NONE" && r.intent.budgetSource !== "NONE");
        if (e.flaggedUntrusted !== undefined) add("flaggedUntrusted", e.flaggedUntrusted, r.candidates.some((x: any) => (x.untrustedContent ?? []).some((u: any) => u.trusted === false && u.flags.length > 0)));
        if (e.notSuitable) for (const pid of e.notSuitable) {
          const cand = r.candidates.find((x: any) => x.productId === pid);
          add(`notSuitable:${pid}`, "not SUITABLE", cand ? cand.suitability : "absent", true, !cand || cand.suitability !== "SUITABLE");
        }
        if (r.identity.status === "LOCKED" && e.compareState) {
          const cmp: any = await g.compareOffers("eval-user", { researchSessionId: r.purchaseSessionId, productIdentity: r.identity.lockedIdentity, destination: c.destination ?? null });
          add("compareState", e.compareState, cmp.state);
          if (e.lowestVerified !== undefined) add("lowestVerified", e.lowestVerified, cmp.lowestVerifiedEligibleOffer?.offerId ?? null, e.lowestVerified === null && cmp.lowestVerifiedEligibleOffer !== null);
          if (e.lowestPayPal !== undefined) add("lowestPayPal", e.lowestPayPal, cmp.lowestPayPalCheckoutableOffer?.offerId ?? null, e.lowestPayPal === null && cmp.lowestPayPalCheckoutableOffer !== null);
          for (const [offerId, issue] of Object.entries(e.ineligible ?? {})) {
            const inel = cmp.ineligibleOffers.find((o: any) => o.offerId === offerId);
            const wasEligible = cmp.eligibleOffers.some((o: any) => o.offerId === offerId);
            add(`ineligible:${offerId}`, issue, inel ? inel.issues : wasEligible ? "ELIGIBLE" : "absent", wasEligible, !!inel && inel.issues.includes(issue));
          }
          for (const offerId of e.eligible ?? []) add(`eligible:${offerId}`, true, cmp.eligibleOffers.some((o: any) => o.offerId === offerId));
        }
      } catch (err) { error = err instanceof CommerceError ? `${err.code}: ${err.message}` : String(err); }
      const latencyMs = Math.round((performance.now() - t0) * 100) / 100;
      results.push({ id: c.id, category: c.category, pass: !error && checks.every((x) => x.pass), checks, latencyMs,
        adapterCalls: Object.values(adapter.calls).reduce((a, b) => a + b, 0) - before, ...(error ? { error } : {}) });
    }
  } finally { app.store.close(); }

  const byDimension: EvalReport["metrics"]["byDimension"] = {};
  const failureTypes: Record<string, number> = {};
  for (const r of results) for (const ch of r.checks) {
    const dim = ch.field.split(":")[0]!;
    (byDimension[dim] ??= { checked: 0, correct: 0 }).checked++;
    if (ch.pass) byDimension[dim]!.correct++; else failureTypes[dim] = (failureTypes[dim] ?? 0) + 1;
  }
  for (const r of results) if (r.error) failureTypes.ERROR = (failureTypes.ERROR ?? 0) + 1;
  const lat = results.map((r) => r.latencyMs).sort((a, b) => a - b);
  return { cases: results, metrics: { cases: results.length, passed: results.filter((r) => r.pass).length, byDimension,
    criticalErrors: results.reduce((n, r) => n + r.checks.filter((c) => c.critical && !c.pass).length, 0), failureTypes,
    latencyMs: { p50: lat[Math.floor(lat.length / 2)] ?? 0, max: lat.at(-1) ?? 0, total: Math.round(lat.reduce((a, b) => a + b, 0)) },
    adapterCalls: results.reduce((n, r) => n + r.adapterCalls, 0), externalProviderCalls: 0, supplierCostMicro: 0 } };
}
