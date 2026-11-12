import { AsyncLocalStorage } from "node:async_hooks";

/**
 * DIAPORIA Buy panel: live research progress.
 *
 * The panel never runs its own research. It observes the gateway's own research (the same code path as the
 * research_purchase MCP tool) by wrapping the research adapter and the evidence router in pass-through proxies. A proxy
 * forwards every call unchanged and, only when the call runs inside a panel run (AsyncLocalStorage), records a short
 * progress line. Calls outside a panel run (plain MCP research) record nothing. Arguments and results are never
 * changed, and only fixed labels plus counts are recorded (no provider payloads, no keys).
 */
export interface ProgressSink { emit(step: string, label: string, detail?: string | null): void }

export const progressContext = new AsyncLocalStorage<ProgressSink>();

const ADAPTER_LABELS: Record<string, [string, string]> = {
  searchProducts: ["SEARCH", "Searching the catalog"],
  searchPage: ["SEARCH", "Searching the catalog"],
  searchCandidates: ["SEARCH", "Searching the catalog"],
  lookupUrl: ["SEARCH", "Checking a listing"],
  getProduct: ["DETAILS", "Reading product details"],
  resolveVariant: ["DETAILS", "Resolving the exact variant"],
  getVariantProduct: ["DETAILS", "Resolving the exact variant"],
  findOffers: ["OFFERS", "Finding merchant listings"],
  getQuote: ["QUOTES", "Requesting a merchant quote"],
};
const ROUTER_LABELS: Record<string, [string, string]> = {
  verify: ["EVIDENCE", "Checking independent evidence"],
  verifyMany: ["EVIDENCE", "Checking independent evidence"],
};

function countOf(v: unknown): string | null {
  if (Array.isArray(v)) return `${v.length} result${v.length === 1 ? "" : "s"}`;
  if (v && typeof v === "object" && Array.isArray((v as { products?: unknown[] }).products)) return `${(v as { products: unknown[] }).products.length} results`;
  return null;
}

/** Pass-through proxy: identical behaviour, plus progress lines inside a panel run. */
export function observe<T extends object>(target: T, labels: Record<string, [string, string]> = ADAPTER_LABELS): T {
  return new Proxy(target, {
    get(t, prop, _recv) {
      const v = Reflect.get(t, prop, t);
      if (typeof v !== "function" || typeof prop !== "string" || !labels[prop]) return typeof v === "function" ? v.bind(t) : v;
      const [step, label] = labels[prop]!;
      return (...args: unknown[]) => {
        const sink = progressContext.getStore();
        if (!sink) return v.apply(t, args);
        const caps = prop.startsWith("verify") ? (Array.isArray(args[1]) ? args[1] : [args[1]]).filter((x) => typeof x === "string") as string[] : [];
        const capability = caps.length ? caps.join(", ").slice(0, 80) : null;
        const product = capability && args[0] && typeof (args[0] as { title?: unknown }).title === "string" ? `${String((args[0] as { title: string }).title).slice(0, 60)}: ` : "";
        sink.emit(step, label, capability ? `${product}${capability}` : null);
        const out = v.apply(t, args);
        if (out && typeof (out as Promise<unknown>).then === "function")
          (out as Promise<unknown>).then((r) => { const c = countOf(r); if (c) sink.emit(step, `${label}: done`, c); }, () => sink.emit(step, `${label}: failed`, null));
        return out;
      };
    },
  });
}

export const observeRouter = <T extends object>(router: T): T => observe(router, ROUTER_LABELS);
