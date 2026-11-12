/**
 * CX counterexample cases (architecture thread). Probes from PREDICTION_REGISTER.md section C; oracle policy O1-O9 as in the IW series.
 * Helpers copied from the IW-24 case file (SEEN); the cases are new and builder-written.
 */
export type State = "RECOMMEND" | "INVESTIGATE" | "HOLD";
export interface Gate { group: string; mustRefuse: boolean; agentResolve?: boolean }
export interface IwCase { id: string; lang: "en" | "ko"; tags: string[]; request: string; input?: Record<string, unknown>; destination?: { country: string; region: string };
  budget?: { minor: number; currency: string; orUnresolved?: boolean } | "UNRESOLVED" | null;
  expect: { state: State[]; lock?: string | null; lockOneOf?: Array<string | null>; top?: string[]; rel?: Record<string, number>; forbidden?: string[]; lowestVerified?: string };
  gate?: Gate[] }

const CA = { country: "US", region: "CA" };
const USD = (n: number) => ({ minor: Math.round(n * 100), currency: "USD" });
const KRW = (n: number) => ({ minor: n, currency: "KRW" });
const R = (group: string) => ({ group, mustRefuse: true });
const AR = (group: string) => ({ group, mustRefuse: true, agentResolve: true });
const OK = (group: string) => ({ group, mustRefuse: false });
const ALL = ["RECOMMEND", "HOLD", "INVESTIGATE"] as State[];
const NONE = ["HOLD", "INVESTIGATE"] as State[];
const ACC = ["RECOMMEND", "INVESTIGATE"] as State[];
const RC = ["RECOMMEND"] as State[];
const Q = "hexley.example", H = "tewkes.example", V = "ormsby.example";
const LV = (domain: string, id: string) => `https://${domain}/p/${id}`;
/** Exact-product positive control. */
const X = (id: string, lang: "en" | "ko", tags: string[], request: string, lock: string, forbidden: string[], refuse: string[], extra: Partial<IwCase> = {}, lowest?: string): IwCase =>
  ({ id, lang, tags: [...tags, "positive-control"], request, budget: null, ...extra,
    ...(lowest ? { destination: CA } : {}), expect: { state: RC, lock, top: [lock], rel: { [lock]: 3 }, forbidden, ...(lowest ? { lowestVerified: lowest } : {}) }, gate: [OK(lock), ...refuse.map(R)] });
/** Nothing may be recommended. */
const N = (id: string, lang: "en" | "ko", tags: string[], request: string, forbidden: string[], gate: Gate[], extra: Partial<IwCase> = {}, lockOneOf?: Array<string | null>): IwCase =>
  ({ id, lang, tags, request, budget: null, ...extra, expect: { state: NONE, ...(lockOneOf ? { lockOneOf } : { lock: null }), forbidden }, gate });
/** Accessory positive control (lock optional). */
const AC = (id: string, lang: "en" | "ko", tags: string[], request: string, part: string, forbidden: string[], refuse: string[], extra: Partial<IwCase> = {}): IwCase =>
  ({ id, lang, tags: ["accessory", "accessory-requested", ...tags, "positive-control"], request, budget: null, ...extra,
    expect: { state: ACC, lockOneOf: [part, null], top: [part], rel: { [part]: 3 }, forbidden }, gate: [OK(part), ...refuse.map(R)] });
/** Discovery positive control. */
const D = (id: string, lang: "en" | "ko", tags: string[], request: string, good: string[], forbidden: string[], refuse: string[], extra: Partial<IwCase> = {}): IwCase =>
  ({ id, lang, tags: ["discovery", ...tags, "positive-control"], request, budget: null, ...extra,
    expect: { state: RC, top: good, rel: Object.fromEntries(good.map((g) => [g, 3])), forbidden }, gate: [OK(good[0]!), ...refuse.map(R)] });
/** Any state is acceptable, but the lock / recommendation must be right. */
const AS = (id: string, lang: "en" | "ko", tags: string[], request: string, lockOneOf: Array<string | null>, forbidden: string[], gate: Gate[], extra: Partial<IwCase> = {}): IwCase =>
  ({ id, lang, tags, request, budget: null, ...extra, expect: { state: ALL, lockOneOf, top: lockOneOf.filter((x): x is string => !!x), rel: Object.fromEntries(lockOneOf.filter((x): x is string => !!x).map((g) => [g, 3])), forbidden }, gate });

export const CX_CASES: IwCase[] = [
  N("cx01", "en", ["CX1", "D1", "context-contradicted"], "Corvane Hauler 40 for beach sand", ["ht40"], [R("ht40")]),
  X("cx02", "en", ["CX2", "cost-control", "context"], "Corvane Hauler 40 for my nephew", "ht40", ["ht40w", "ht60"], ["ht40w", "ht60"]),
  D("cx03", "en", ["CX3", "CX4", "D2", "conditional-accessory-evidence", "own-page-comparison"], "kayak trolley that carries at least 120 kg", ["ht60"], ["ht40", "ht40w"], ["ht40", "ht40w"]),
  X("cx05", "en", ["CX5", "D3", "minimality"], "Ostlund Embry 18", "em18", ["em18p"], ["em18p"]),
  N("cx06", "en", ["CX6", "D3", "host-substitution"], "rain hood for the Ostlund Embry 18", ["em18", "em18p", "em24"], [R("em18")]),
  N("cx07", "en", ["CX7", "D1", "fit-lost"], "spare rain hood for the Ostlund Embry 24", ["hood24", "em24", "em24p"], [R("hood24"), R("em24")]),
  N("cx08", "en", ["CX8", "D1", "x-only", "spec-line"], "Ostlund Embry 18, Wi-Fi only", ["em18", "em18p"], [R("em18")]),
  N("cx09", "ko", ["CX9", "D2", "korean-spec-line"], "와이파이 되는 Ostlund Embry 18", ["em18"], [R("em18")]),
  X("cx10", "en", ["CX10", "cost-control", "exact"], "Corvane Hauler 40", "ht40", ["ht40w", "ht60"], ["ht40w", "ht60"]),
  N("cx11", "en", ["CX11", "K4", "numeric-residual"], "kayak trolley for 3 kayaks", ["ht40", "ht40w", "ht60"], [R("ht40")]),
  X("cx12", "en", ["cost-control", "context"], "Ostlund Embry 24 Box Smoker for our cabin", "em24", ["em24p"], ["em24p"]),
  X("cx13", "en", ["cost-control", "requirement"], "Corvane Hauler 60 that folds flat", "ht60", ["ht40"], ["ht40"]),
  X("cx14", "en", ["cost-control", "exact-tail"], "Corvane Hauler 40 Wide", "ht40w", ["ht40"], ["ht40"]),
  AC("cx15", "en", ["cost-control", "part"], "puncture-proof wheel set for the Corvane Hauler 60", "wheel", ["ht60"], ["ht60"]),
  // probe v2 (added after the first f17a8c5 baseline run, see journal): routes that reach the evidence layer
  N("cx16", "en", ["CX3", "D2", "conditional-accessory-evidence", "exact"], "Corvane Hauler 40 that carries at least 120 kg", ["ht40"], [R("ht40")]),
  N("cx17", "en", ["CX1", "D1", "context-contradicted"], "Corvane Hauler 40 for beach launches", ["ht40"], [R("ht40")]),
  X("cx19", "en", ["cost-control", "exact-part"], "Ostlund Embry 24 Rain Hood", "hood24", ["em24"], ["em24"]),
  // probe v3 (convergence review cost probe: an incidental number)
  X("cx20", "en", ["cost-control", "K4", "family-of-4"], "Corvane Hauler 60 for a family of 4", "ht60", ["ht40"], ["ht40"]),
];
