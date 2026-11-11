/**
 * FROZEN HOLDOUT 2 (research eval v2). Written 2026-11-10 AFTER the V2 dogfood iterations, because those iterations
 * printed results of holdout 1 (holdout.ts) and two fixes were made after seeing holdout-1 misses (see
 * docs/research/DECISION_JOURNAL.md, entry J-07). Holdout 1 is therefore reported as CONTAMINATED; this file is the
 * clean holdout. Written under the world rules in cases.ts against the unchanged world.ts, before any system was run
 * on these cases. Never edit: HOLDOUT2_FREEZE.json records this file's SHA-256 and the harness refuses a mismatch.
 * PROVENANCE: AGENT_AUTHORED, not independently reviewed.
 */
import type { EvalCaseV2 } from "./cases.js";

const CA = { country: "US", region: "CA" };
const ALL_NOVA = ["nova9-128", "nova9-256", "nova9pro-256", "nova9-case"];

export const HOLDOUT2_CASES: EvalCaseV2[] = [
  { id: "q01", split: "holdout2", tags: ["exact", "model-family", "phones"], lang: "en", request: "Buy Litware Nova 9 Pro 256GB",
    expect: { state: ["RECOMMEND"], lock: "nova9pro-256", top: ["nova9pro-256"], rel: { "nova9pro-256": 3 }, forbidden: ["nova9-256", "nova9-128", "nova9-case"] } },
  { id: "q02", split: "holdout2", tags: ["exact", "variant-missing", "phones"], lang: "en", request: "Buy Litware Nova 9 512GB",
    expect: { state: ["HOLD"], lock: null, forbidden: ALL_NOVA } },
  { id: "q03", split: "holdout2", tags: ["exact", "condition-refurbished", "laptops"], lang: "en", request: "Buy a renewed Fabrikam Aero 14 16GB",
    expect: { state: ["RECOMMEND"], lock: "aero14-renewed", top: ["aero14-renewed"], rel: { "aero14-renewed": 3 }, forbidden: ["aero14-16", "aero14-32", "aero-charger"] } },
  { id: "q04", split: "holdout2", tags: ["exact", "named-model", "chairs"], lang: "en", request: "Buy Wingtip Basic Task chair",
    expect: { state: ["RECOMMEND"], lock: "task", top: ["task"], rel: { task: 3 }, forbidden: ["ergo", "ergo-pro"] } },
  { id: "q05", split: "holdout2", tags: ["exact", "model-family", "monitors"], lang: "en", request: "Buy Relecloud View 27 FHD monitor",
    expect: { state: ["RECOMMEND"], lock: "view27fhd", top: ["view27fhd"], rel: { view27fhd: 3 }, forbidden: ["view27", "view32"] } },
  { id: "q06", split: "holdout2", tags: ["exact", "model-family", "monitors"], lang: "en", request: "Buy Relecloud View 27",
    expect: { state: ["RECOMMEND"], lock: "view27", top: ["view27"], rel: { view27: 3 }, forbidden: ["view27fhd", "view32"] } },
  { id: "q07", split: "holdout2", tags: ["exact", "over-budget", "vacuums"], lang: "en", request: "Buy Coho Sweep S5 under $150",
    expect: { state: ["HOLD"], forbidden: ["s5", "s7"] } },
  { id: "q08", split: "holdout2", tags: ["exact", "variant-missing", "bottles"], lang: "en", request: "Buy Adatum Summit 32 oz bottle in Red",
    expect: { state: ["HOLD"], lock: null, forbidden: ["summit32", "summit24", "summit32-2pk"] } },
  { id: "q09", split: "holdout2", tags: ["exact", "brand-apostrophe", "capacity", "backpacks"], lang: "en", request: "Buy Margie's Travel Daypack 30L",
    expect: { state: ["RECOMMEND"], lock: "day30", top: ["day30"], rel: { day30: 3 }, forbidden: ["day20"] } },
  { id: "q10", split: "holdout2", tags: ["discovery", "cheapest", "coffee"], lang: "en", request: "Cheapest programmable coffee maker",
    expect: { state: ["RECOMMEND"], top: ["brew12"], rel: { brew12: 3, thermobrew: 2 }, forbidden: ["brew8", "brew-carafe"] } },
  { id: "q11", split: "holdout2", tags: ["discovery", "must-vs-nice", "tight-budget", "headphones"], lang: "en", request: "Noise cancelling headphones with multipoint under $300, a 40-hour battery would be nice",
    expect: { state: ["RECOMMEND"], top: ["cx500-black", "cx500-white"], rel: { "cx500-black": 3, "cx500-white": 3, "tailspin-pro": 2, "lumen-q5": 1, nw200: 1, "cx500-bundle": 1 },
      forbidden: ["aria", "fab-lite", "lumen-q5", "tailspin-pro", "cx500-pads"] } },
  { id: "q12", split: "holdout2", tags: ["discovery", "all-violate", "backpacks"], lang: "en", request: "Waterproof backpack under $50",
    expect: { state: ["HOLD"], forbidden: ["day20", "day30"] } },
  { id: "q13", split: "holdout2", tags: ["discovery", "laptops"], lang: "en", request: "Laptop with backlit keyboard and USB-C charging under $1300",
    expect: { state: ["RECOMMEND"], top: ["aero14-16"], rel: { "aero14-16": 3, "aero14-32": 2 }, forbidden: ["tsbook-air", "aero14-renewed", "aero-charger", "tsbook-pro16", "aero14-32"] } },
  { id: "q14", split: "holdout2", tags: ["discovery", "monitors"], lang: "en", request: "USB-C charging 4K monitor, money is no object",
    expect: { state: ["RECOMMEND"], top: ["view27"], rel: { view27: 3 }, forbidden: ["view32", "view27fhd"] } },
  { id: "q15", split: "holdout2", tags: ["discovery", "korean", "currency-krw", "vacuums"], lang: "ko", request: "무선 청소기 HEPA 필터 40만원 이하",
    expect: { state: ["INVESTIGATE", "HOLD"], forbidden: ["s7", "s5"] } },
  { id: "q16", split: "holdout2", tags: ["discovery", "korean", "monitors"], lang: "ko", request: "4K 모니터 500달러 이하",
    expect: { state: ["RECOMMEND"], top: ["view27"], rel: { view27: 3, view32: 3 }, forbidden: ["view27fhd"] } },
  { id: "q17", split: "holdout2", tags: ["exact", "korean", "variant", "phones"], lang: "ko", request: "Litware Nova 9 256GB 블랙 구매",
    expect: { state: ["RECOMMEND"], lock: "nova9-256", top: ["nova9-256"], rel: { "nova9-256": 3 }, forbidden: ["nova9-128", "nova9pro-256", "nova9-case"] } },
  { id: "q18", split: "holdout2", tags: ["exact", "tight-budget", "compare", "headphones"], lang: "en", request: "Buy Contoso CX-500 White under $120", destination: CA,
    expect: { state: ["INVESTIGATE"], lock: "cx500-white", top: ["cx500-white"], rel: { "cx500-white": 3 }, forbidden: ["cx500-black", "cx500-bundle"], lowestVerified: null } },
  { id: "q19", split: "holdout2", tags: ["discovery", "size", "category-trap", "shoes"], lang: "en", request: "Waterproof running shoes size 10 under $150",
    expect: { state: ["RECOMMEND"], top: ["trail-10"], rel: { "trail-10": 3 }, forbidden: ["trail-105", "trail-9", "ridge-10"] } },
  { id: "q20", split: "holdout2", tags: ["discovery", "pack", "bottles"], lang: "en", request: "Insulated water bottle 2-pack under $80",
    expect: { state: ["RECOMMEND"], top: ["summit32-2pk"], rel: { "summit32-2pk": 3 }, forbidden: ["summit32", "summit24", "basic-bottle"] } },
  { id: "q21", split: "holdout2", tags: ["exact", "named-model", "size", "boots"], lang: "en", request: "Buy Woodgrove Ridge Hiker boots size 10",
    expect: { state: ["RECOMMEND"], lock: "ridge-10", top: ["ridge-10"], rel: { "ridge-10": 3 }, forbidden: ["trail-10", "trail-105"] } },
  { id: "q22", split: "holdout2", tags: ["discovery", "missing-spec", "tight-budget", "headphones"], lang: "en", request: "Over-ear headphones under $60",
    expect: { state: ["INVESTIGATE"], rel: { aria: 2 }, forbidden: ["aria", "fab-lite", "cx500-pads"] } },
];
