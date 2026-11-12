/**
 * Obligation kernel (architecture experiment, research/architecture/).
 *
 * The decision engine acts permissively in three places when it is uncertain: a span that did not become a MUST imposes
 * no obligation (D1), any clause matching a requirement key credits the product whose pool it is in (D2), and identity
 * locks the best listing left after filters (D3). This kernel runs after the decision, receives the typed obligations
 * implied by whatever intent the interpreter produced (TS parser or a typed semantic adapter), and can only DEMOTE a
 * RECOMMEND to INVESTIGATE. It never promotes, never verifies anything by itself and never loosens a requirement.
 *
 * Checks (all evaluated and logged on every RECOMMEND, so each can be ablated):
 *  K1a kind      a requested accessory / bundle / standalone is never answered with another kind.
 *  K1b identity  every Latin identity word of a named request appears in the recommended listing's title.
 *  K1c filtered  no sibling with the same brand, model digits and head noun was dropped before ranking while the
 *                recommended listing carries words the request did not state (filter-then-substitute).
 *  K2 binding    every manufacturer-verified MUST has a counted source bound to R from page-visible text (page title
 *                names R and no other listing; the clause is not conditional on an add-on).
 *  K3 contradict no bound manufacturer statement about R negates any stated phrase (MUST, NICE, CONTEXT) or the fit to
 *                a named host; spec lines "<label>: none/없음/…" are read with a frozen negative-value list.
 *  K4 numbers    a number in the request that nothing consumed must appear in R's title.
 *
 * E4.1 (v0.2.0): K2 and K3 read pages through one shared subject binder (./SubjectBinding.ts): every claim has a subject
 * (base product, variant, accessory, or unknown) and an optional condition, contrasts ("A, not B") become denials, and a
 * claim credits or contradicts R only when it is about R without a condition. Context requirements and request segments
 * nothing interpreted are contradiction-only obligations. Every gateable product is checked, and a product other than
 * the recommendation is not payable while a MUST is neither verified through the binder nor readable on a page about it
 * (unless the engine already blocks that MUST). Ablations: DIAPORIA_E41_BINDER / _OBLIGATIONS / _UNCHECKED = off.
 */
import type { CatalogProduct, MerchantOffer } from "../domain/types.js";
import type { Decision } from "../decision/DecisionEngine.js";
import type { ResearchIntentV2 } from "../intent/ResearchIntentV2.js";
import type { CapabilityVerdict } from "../evidence/EvidenceV2.js";
import type { EvidenceRouter } from "../evidence/EvidenceRouter.js";
import { hostOf } from "../evidence/SourceRegistry.js";
import { clauseStatement, fitKey } from "../research/capabilities.js";
import { GENERIC_WORDS } from "../identity/ProductIdentityExtractor.js";
import { claimsOf, statementFor, claimsAbout, describe, pageSubject, BINDER_VERSION } from "./SubjectBinding.js";

export const KERNEL_VERSION = "obligation-kernel-v0.2.0-e41";
/** E4.1 ablation switches (each "off" restores the v0.1 behaviour of that part only). */
const E41 = () => ({ binder: process.env.DIAPORIA_E41_BINDER !== "off", obligations: process.env.DIAPORIA_E41_OBLIGATIONS !== "off", unchecked: process.env.DIAPORIA_E41_UNCHECKED !== "off" });
export interface KernelCheck { id: "K1a" | "K1b" | "K1c" | "K2" | "K3" | "K4"; pass: boolean; detail: string }
export interface KernelLog { version: string; binder?: string; e41?: { binder: boolean; obligations: boolean; unchecked: boolean }; applied: boolean; demoted: boolean; productId: string | null; checks: KernelCheck[]; pageLookups: number; others?: Array<{ productId: string; failed: string[] }> }
export interface KernelInput {
  intent: ResearchIntentV2; requestText: string | null;
  /** The planner's evidence-search budget still allows one lookup (the kernel never exceeds the per-request cap). */
  lookupAllowed?: boolean; products: CatalogProduct[]; offers: Map<string, MerchantOffer[]>;
  decision: Decision; verdicts: Map<string, Record<string, CapabilityVerdict>>;
  /** The identity resolver's exclusions (exact mode): why each listing was not the requested product. */
  excluded?: Array<{ productId: string; reason: string }>;
  /** The intent as the interpreter produced it, before the planner narrowed a part request to its host. */
  requestIntent?: ResearchIntentV2;
}
export interface KernelDeps { router: EvidenceRouter | null; ctx: { userId: string; requestId: string } }

/** Frozen stop list: function words, shopping verbs and condition words (never identity). */
const STOP = new Set(("a an the i me my we our us you your he she his her their them it its this that these those is am are was be been " +
  "need needs want wants looking look find buy buying purchase order get getting please some any with without and or but of to in on at for from by as " +
  "so very really just also too would like love can could should must have has had prefer ideally nice new used refurbished renewed only " +
  "one exactly one's me. please. thanks thank").split(/\s+/));
/** Frozen negative values of a spec line ("Wi-Fi: not available", "와이파이: 없음"). */
const NEG_VALUE = /^\s*([^:：]{1,40})[:：]\s*(?:none|no|not available|not included|n\/a|not supported|unsupported|없음|미지원|지원\s*안\s*함|지원하지\s*않음|불가|아니오|안\s*됨)\s*[.。]?\s*$/i;
/** Frozen unit words (a number's unit, never an identity word of its own). */
const UNIT = new Set(["foot", "feet", "ft", "inch", "inche", "in", "lb", "lbs", "pound", "kg", "g", "l", "liter", "litre", "cm", "mm", "m", "hp", "v", "volt", "w", "watt", "gal", "gallon", "qt", "quart", "oz", "psi", "sq", "square", "cu", "cubic", "person", "people", "seat", "inch."]);
const UNIT_CANON: Record<string, string> = { foot: "ft", feet: "ft", inch: "in", inche: "in", liter: "l", litre: "l", pound: "lb", lbs: "lb", gallon: "gal", quart: "qt", volt: "v", watt: "w" };
/** A number written apart from its unit ("28 ft", "28-foot", "60 L") matches the joined title form ("28ft", "60L"). */
function numberInTitle(tokens: string[], i: number, rj: Set<string>): boolean {
  const w = tokens[i]!; if (rj.has(w)) return true;
  const next = tokens[i + 1]; if (!next || !UNIT.has(next)) return false;
  return rj.has(w + next) || rj.has(w + (UNIT_CANON[next] ?? next));
}
/** A comparison lead ("Unlike the X, …", "Compared with the X, …"): what it names is not the sentence's subject. */
const COMPARE_LEAD = /^\s*(?:unlike|compared (?:with|to)|in contrast to|like)\b[^,]*,/i;
/** The sentence mentions R only inside a comparison lead, so it is about another product. */
function aboutOtherViaComparison(sentence: string, r: CatalogProduct): boolean {
  const m = COMPARE_LEAD.exec(sentence); if (!m) return false;
  const mt = modelTokens(r); if (!mt.length) return false;
  const lead = tokset(m[0]); const rest = tokset(sentence.slice(m[0].length));
  return mt.every((w) => lead.has(w)) && !mt.every((w) => rest.has(w));
}
/** A leading condition before the subject ("With the riser block, …", "When fitted with …"); comparisons are not conditions. */
const CONDITION_LEAD = /^\s*(?:with|when|using|once|if|after|paired with|fitted with|equipped with|combined with)\b/i;

const norm = (s: string) => s.normalize("NFKC").toLowerCase();
const words = (s: string): string[] => norm(s).split(/[^a-z0-9가-힣.]+/).map((w) => w.replace(/^\.+|\.+$/g, "")).filter(Boolean)
  .map((w) => (w.length > 3 && /^[a-z]+s$/.test(w) && !w.endsWith("ss") ? w.slice(0, -1) : w));
const tokset = (s: string) => new Set(words(s));
const compact = (s: string) => norm(s).replace(/[^a-z0-9가-힣]+/g, "");
const hasDigit = (w: string) => /\d/.test(w);
const isLatin = (w: string) => /^[a-z0-9.]+$/.test(w);
const content = (s: string) => words(s).filter((w) => !STOP.has(w) && !GENERIC_WORDS.has(w));
const headNoun = (p: CatalogProduct) => { const w = words(p.title).filter((x) => !hasDigit(x)); return w[w.length - 1] ?? ""; };
const modelTokens = (p: CatalogProduct) => words(p.identity.model ?? "");
const kindOf = (p: CatalogProduct) => p.research?.kind ?? null;
const sentencesOf = (text: string) => text.split(/(?<=[.!?。])\s+|;\s*|\n+/).map((x) => x.trim()).filter(Boolean);

/** Words of S's title that R's title lacks (the words that make S a different listing). */
function distinguishing(s: CatalogProduct, r: CatalogProduct): string[] {
  const rt = tokset(r.title);
  return words(s.title).filter((w) => !rt.has(w) && !GENERIC_WORDS.has(w) && !STOP.has(w));
}
/** The text names listing S (all of its distinguishing words and its model digits occur) rather than only R. */
function namesOther(text: string, s: CatalogProduct, r: CatalogProduct): boolean {
  const t = tokset(text); const d = distinguishing(s, r);
  if (!d.length || !d.every((w) => t.has(w))) return false;
  return modelTokens(s).filter(hasDigit).every((w) => t.has(w));
}
/**
 * Words a page title must contain to name listing L: its model, plus the words right after the model that set it apart
 * from a listed sibling with the same model digits ("Fernwake 16 Kevlar", "Trestor 72 Cabinet"). Descriptors and specs
 * in a retailer title ("16GB RAM, 512GB SSD") are not required. The brand is implied by the manufacturer's domain.
 */
let LISTED: CatalogProduct[] = [];
function requiredWords(l: CatalogProduct): string[] {
  const cat = tokset(`${l.category ?? ""} ${l.research?.categoryTitle ?? ""}`); const head = headNoun(l); const brand = tokset(l.identity.brand ?? "");
  const tw = words(l.title); const m = modelTokens(l).filter((w) => !brand.has(w));
  if (!m.length) return [...new Set(tw.filter((w) => !GENERIC_WORDS.has(w) && !STOP.has(w) && !cat.has(w) && !brand.has(w) && w !== head))].slice(0, 3);
  const at = tw.lastIndexOf(m[m.length - 1]!);
  const tail: string[] = [];
  for (let i = at + 1; at >= 0 && i < tw.length; i++) { const w = tw[i]!; if (w === head || cat.has(w) || GENERIC_WORDS.has(w) || STOP.has(w) || hasDigit(w)) break; tail.push(w); }
  const digits = m.filter(hasDigit);
  const sibs = LISTED.filter((s) => s.productId !== l.productId && digits.every((x) => tokset(s.title).has(x)));
  return [...new Set([...m, ...tail.filter((w) => sibs.some((s) => !tokset(s.title).has(w)))])];
}
/** Title words plus every join of 2-3 adjacent words ("Fernwake 16" also yields "fernwake16"): exact, never substrings. */
function joinedTokens(s: string): Set<string> {
  const w = words(s).map((x) => x.replace(/\./g, "")); const out = new Set(words(s));
  for (let i = 0; i < w.length; i++) { if (i + 1 < w.length) out.add(w[i]! + w[i + 1]!); if (i + 2 < w.length) out.add(w[i]! + w[i + 1]! + w[i + 2]!); }
  return out;
}
const contains = (title: string, ws: string[]) => { const t = joinedTokens(title); return ws.every((w) => t.has(w)); };
/**
 * Page-visible binding: the page title names R completely, and no other listing that the title also names completely
 * is more specific (a sibling's or an add-on's page names R's words plus its own).
 */
function titleBindsTo(title: string, r: CatalogProduct, listed: CatalogProduct[]): boolean {
  const req = requiredWords(r);
  if (!req.length || !contains(title, req)) return false;
  const rt = tokset(r.title);
  if (continuesModel(title, r)) return false;
  return !listed.some((l) => l.productId !== r.productId && requiredWords(l).some((w) => !rt.has(w)) && contains(title, requiredWords(l)));
}
/** Frozen words a page title may add after a product name without naming another product. */
const PAGE_WORDS = new Set(["specifications", "specification", "specs", "spec", "sheet", "review", "reviews", "official", "manual", "product", "page", "overview", "details", "features", "support", "site", "store", "datasheet", "faq", "guide"]);
/** The title continues R's model with a word R's title lacks ("Crucible 18 Glass", "Kerfmaster 14in Riser Block"): another product. */
function continuesModel(title: string, r: CatalogProduct): boolean {
  const m = modelTokens(r); if (!m.length) return false;
  const t = words(title); const last = m[m.length - 1]!;
  const i = t.indexOf(last); if (i < 0 || i + 1 >= t.length) return false;
  const next = t[i + 1]!; const rt = tokset(r.title);
  return !rt.has(next) && !PAGE_WORDS.has(next) && !GENERIC_WORDS.has(next) && !STOP.has(next);
}
/** A sentence whose subject is conditioned on something that is not R ("With the spark screen, the X is approved …"). */
function conditional(sentence: string, r: CatalogProduct): boolean {
  if (!CONDITION_LEAD.test(sentence)) return false;
  const m = modelTokens(r); const lw = norm(sentence);
  const at = m.length ? lw.indexOf(m[0]!) : -1;
  const lead = at > 0 ? sentence.slice(0, at) : sentence.split(",")[0] ?? sentence;
  const rt = tokset(r.title);
  return content(lead).some((w) => !rt.has(w) && !hasDigit(w));
}
/** Key evaluable by the engine's own negation detector (context keys are read as propositions). */
const checkKey = (key: string) => (key.startsWith("context:") ? `unrecognized:${key.slice("context:".length)}` : key);

export async function applyObligationKernel(inp: KernelInput, deps: KernelDeps): Promise<KernelLog> {
  const log: KernelLog = { version: KERNEL_VERSION, binder: BINDER_VERSION, e41: E41(), applied: false, demoted: false, productId: null, checks: [], pageLookups: 0, others: [] };
  if (process.env.DIAPORIA_OBLIGATION_KERNEL === "off") return log;
  const d = inp.decision;
  LISTED = inp.products;
  const byId = new Map(inp.products.map((p) => [p.productId, p]));
  // Every product the payment gate could prepare is checked (the recommendation first), not only the recommendation.
  const recId = d.state === "RECOMMEND" && d.recommendation ? d.recommendation.productId : null;
  const gateable = d.ranking.filter((x) => x.eligible && !x.disqualifiers.length).map((x) => x.productId);
  const order = [...new Set([...(recId ? [recId] : []), ...gateable])].filter((id) => byId.has(id)).slice(0, E41().unchecked ? Infinity : 4);
  if (!order.length) return log;
  log.applied = true; log.productId = recId;
  for (const pid of order) {
    const r = byId.get(pid)!;
    // Only the recommendation may trigger a page lookup; other gateable products are checked against the pool.
    const checks = await checkProduct(r, pid === recId ? inp : { ...inp, lookupAllowed: false }, deps, log, pid === recId);
    const failed = checks.filter((c) => !c.pass);
    if (pid === recId) log.checks = checks; else log.others!.push({ productId: pid, failed: failed.map((c) => `${c.id}: ${c.detail.slice(0, 160)}`) });
    if (!failed.length) continue;
    const rk = d.ranking.find((x) => x.productId === pid);
    if (rk) {
      rk.eligible = false;
      for (const c of failed) {
        if (c.id.startsWith("K1")) rk.disqualifiers.push({ code: "NOT_LOCKED_IDENTITY", detail: `obligation kernel ${c.id}: ${c.detail}` });
        else rk.blockers.push({ code: c.id === "K3" ? "MUST_HAVE_CONTRADICTED" : "MUST_HAVE_UNVERIFIED", detail: `must-have "kernel:${c.id}" is not satisfied (obligation kernel): ${c.detail}` });
      }
    }
    if (pid === recId) {
      log.demoted = true;
      d.state = "INVESTIGATE";
      d.topCandidate = { productId: r.productId, title: r.title, open: failed.map((c) => `${c.id}: ${c.detail}`) };
      d.recommendation = null;
    }
  }
  (d as Decision & { kernel?: KernelLog }).kernel = log;
  if (process.env.DIAPORIA_KERNEL_DEBUG) console.error("[kernel]", JSON.stringify({ request: inp.requestText, ...log, excluded: inp.excluded, ranking: d.ranking.map((x) => [x.productId, x.eligible, x.disqualifiers.map((q) => q.code)]) }));
  return log;
}

async function checkProduct(r: CatalogProduct, inp: KernelInput, deps: KernelDeps, log: KernelLog, isRec = true): Promise<KernelCheck[]> {
  const flags = E41();
  const out: KernelCheck[] = [];
  const d = inp.decision;
  const it = inp.intent; const target = it.target;
    const byId = new Map(inp.products.map((p) => [p.productId, p]));
  const req = inp.requestText ?? "";
  const consumedText = [...it.requirements.map((x) => x.text), ...(it.moneyConstraints ?? []).map((m: any) => String(m.text ?? m.raw ?? "")), ...(it.uninterpreted ?? []).map((u: any) => String(u.word ?? u.text ?? ""))].join(" ");
  const hostWords = target?.kind === "ACCESSORY" ? `${target.model ?? ""} ${inp.requestIntent?.target?.model ?? ""}` : "";
  const attrText = Object.values(it.attributes ?? {}).filter((x) => typeof x === "string").join(" ");
  const consumed = tokset(`${consumedText} ${hostWords} ${attrText}`);
  const rTitle = tokset(r.title); const rCat = tokset(`${r.category ?? ""} ${r.research?.categoryTitle ?? ""}`);
  const add = (id: KernelCheck["id"], pass: boolean, detail: string) => out.push({ id, pass, detail });

  // K1a kind
  // A kind mismatch is a substitution unless the request itself names the listing's head noun ("Fernwake 14 portage yoke").
  const want = target?.kind ?? null; const got = kindOf(r);
  const namedHead = tokset(req).has(headNoun(r));
  const k1a = !(want && got && want !== got && !namedHead);
  add("K1a", k1a, k1a ? "kind consistent, unknown, or the request names the listing's product noun" : `requested ${want}, recommended listing is ${got} ("${headNoun(r)}" is not in the request)`);

  // K1b identity words: the words written with the named product (from its brand/model to the next boundary word),
  // plus the part noun of an accessory request. Latin tokens only; words of requirements and money are not identity.
  if (target && req) {
    const BOUNDARY = new Set(["for", "with", "that", "which", "who", "under", "below", "over", "at", "in", "on", "and", "but", "to", "from", "if", "or", "so", "because", "is", "are", "was", "will", "would", "should", "please", "i"]);
    const toks = req.normalize("NFKC").split(/(\s+|[,:;!?()]|\.(?!\d))/).filter((x) => x && x.trim());
    const anchors = words(`${target.brand ?? ""} ${target.model ?? ""}`);
    const start = toks.findIndex((t) => anchors.includes(words(t)[0] ?? "\u0000"));
    const win: string[] = [];
    if (start >= 0) for (let i = start; i < toks.length; i++) { const t = toks[i]!; if (/^[,:;!?().]$/.test(t) || BOUNDARY.has(t.toLowerCase())) break; win.push(...words(t)); }
    const part = target.kind === "ACCESSORY" ? words(target.accessoryNoun ?? "").filter((w) => !["part", "accessory", "accessorie", "spare"].includes(w)) : [];
    // A part request: the host phrase is the fit obligation (K3), so only the part noun is identity here.
    const idWords = (target.kind === "ACCESSORY" ? part : win).filter((w) => isLatin(w) && !STOP.has(w) && !GENERIC_WORDS.has(w) && !consumed.has(w));
    // Unit words written after a number belong to the number ("28-foot" = "28ft"); a part's request may repeat its host's
    // tail ("28ft Pro leveler feet"): words of a same-brand standalone listing's title are the host's, not the part's.
    const hostTitles = kindOf(r) && kindOf(r) !== "STANDALONE" ? inp.products.filter((p) => p.productId !== r.productId && kindOf(p) === "STANDALONE" && norm(p.identity.brand ?? "") === norm(r.identity.brand ?? "")).map((p) => tokset(p.title)) : [];
    const rj = joinedTokens(r.title);
    const joinedOk = new Set<number>(); idWords.forEach((w, i) => { if (i + 1 < idWords.length && rj.has(w + idWords[i + 1]!)) { joinedOk.add(i); joinedOk.add(i + 1); } });
    idWords.forEach((w, i) => { if (hasDigit(w) && numberInTitle(idWords, i, rj)) joinedOk.add(i); });
    const missing = idWords.filter((w, i) => !joinedOk.has(i) && !(UNIT.has(w) && i > 0 && hasDigit(idWords[i - 1]!)))
      .filter((w) => !hostTitles.some((t) => t.has(w)))
      .filter((w) => !rTitle.has(w) && !rCat.has(w) && !rj.has(w));
    add("K1b", missing.length === 0, start < 0 ? "named product not found verbatim in the request (not checked)" : missing.length ? `request words not in the listing title: ${[...new Set(missing)].join(", ")}` : "every identity word is in the title");
  } else add("K1b", true, "not a named request");

  // K1c filter-then-substitute
  {
    const reqT = tokset(req);
    const extra = words(r.title).filter((w) => !reqT.has(w) && !GENERIC_WORDS.has(w) && !STOP.has(w) && !rCat.has(w) && w !== headNoun(r));
    const digits = modelTokens(r).filter(hasDigit);
    // "Dropped by kind": the resolver excluded it as an accessory/bundle/other kind, or the ranking disqualified it as not standalone.
    const KIND_REASON = /^(?:accessory|bundle|standalone product, not|not a |a different variant \(the title adds)/i;
    const droppedByKind = new Set([...(inp.excluded ?? []).filter((e) => KIND_REASON.test(e.reason)).map((e) => e.productId),
      ...d.ranking.filter((x) => x.disqualifiers.some((q) => q.code === "NOT_STANDALONE" || q.code === "BUNDLE_EXCLUDED")).map((x) => x.productId)]);
    const dropped = extra.length && digits.length ? inp.products.filter((s) => s.productId !== r.productId && droppedByKind.has(s.productId)
      && norm(s.identity.brand ?? "") === norm(r.identity.brand ?? "") && digits.every((x) => tokset(s.title).has(x))
      && headNoun(s) === headNoun(r) && !extra.every((w) => tokset(s.title).has(w))) : [];
    add("K1c", dropped.length === 0, dropped.length ? `sibling of the same product type was excluded as another kind: ${dropped.map((s) => s.title).join(" | ")} (recommended listing adds: ${extra.join(", ")})` : "no filtered sibling");
  }

  // Pages bound to R (page-visible text only)
  const brand = r.identity.brand ?? null;
  const sellers = [...new Set([...inp.offers.values()].flat().map((o) => o.merchantDomain).concat([...inp.offers.values()].flat().map((o) => (o.listingUrl ? hostOf(o.listingUrl) : ""))).filter(Boolean))];
  const bound = (hits: Array<{ url: string; title: string; snippet: string; publishedDate?: string | null }>) => hits.filter((h) => titleBindsTo(h.title, r, inp.products));
  const manu = (hits: Array<{ url: string; title: string; snippet: string; publishedDate?: string | null }>) => hits.filter((h) => deps.router?.registry.classify(h.url, brand, sellers, h.publishedDate ?? null) === "MANUFACTURER");
  let pool = deps.router && typeof deps.router.requestHits === "function" ? deps.router.requestHits(deps.ctx.requestId) : [];

  // K2 subject + condition binding of counted manufacturer evidence
  const confirmed = new Set<string>();
  if (process.env.DIAPORIA_KERNEL_DEBUG) console.error("[kernel-rk]", JSON.stringify({ r: r.productId, state: d.state, rk: d.ranking.find((x) => x.productId === r.productId), reqs: it.requirements.map((x) => [x.key, x.polarity, (x as any).strength]) }));
  {
    const fails: string[] = [];
    const rk = d.ranking.find((x) => x.productId === r.productId);
    const v = inp.verdicts.get(r.productId) ?? {};
    for (const s of rk?.satisfied ?? []) {
      if (s.basis !== "MANUFACTURER") continue;
      const items = (v[s.key]?.evidence ?? []).filter((e) => e.counts && e.value);
      if (!items.length) continue;
      const ok = items.some((e) => {
        const hit = pool.find((h) => h.url === e.url);
        // E4.1: the shared binder re-reads the counted page. The credit stands only if a claim whose subject is R and that
        // carries no condition affirms the key, and no claim about R denies it (the same reading K3 uses).
        if (flags.binder && hit) {
          // Every pool hit of the counted URL is read (one page can come back as several snippets).
          const same = pool.filter((h) => h.url === e.url);
          // The counted quote is page-visible text of that page too (a pool may keep another snippet of the same URL).
          const cl = [...same, ...(same.some((h) => h.snippet.includes(e.quote)) ? [] : [{ title: hit.title, snippet: e.quote }])].flatMap((h) => claimsOf(h, inp.products)); const st = statementFor(cl, r.productId, s.key);
          if (st.value !== true && process.env.DIAPORIA_KERNEL_DEBUG) console.error("[kernel-k2b]", JSON.stringify({ r: [r.productId, r.title, r.identity.model], key: s.key, quote: e.quote.slice(0, 160), title: hit.title, claims: cl.map((c) => [describe(c.subject), c.condition, c.text.slice(0, 100)]) }));
          return st.value === true;
        }
        if (hit && !titleBindsTo(hit.title, r, inp.products)) return false;
        if (conditional(e.quote, r) || aboutOtherViaComparison(e.quote, r)) return false;
        if (!hit && inp.products.some((o) => o.productId !== r.productId && namesOther(e.quote, o, r) && !/\b(compared with|unlike|than)\b/i.test(e.quote))) return false;
        return true;
      });
      if (!ok && process.env.DIAPORIA_KERNEL_DEBUG) console.error("[kernel-k2]", JSON.stringify({ r: r.title, key: s.key, items: items.map((e) => { const h = pool.find((x) => x.url === e.url); return [e.url, e.quote.slice(0, 140), h?.title ?? null, h ? titleBindsTo(h.title, r, inp.products) : null, conditional(e.quote, r), aboutOtherViaComparison(e.quote, r)]; }) }));
      if (!ok) fails.push(`"${s.key}" is verified only by statements about another product or under a condition`);
      else confirmed.add(checkKey(s.key));
    }
    for (const s of rk?.satisfied ?? []) if (s.basis !== "MANUFACTURER") confirmed.add(checkKey(s.key));
    add("K2", fails.length === 0, fails.length ? fails.join("; ") : "verified requirements are bound to the product");
  }

  // K3 non-contradiction of every stated phrase and of the fit to a named host
  {
    const obligations: Array<{ key: string; text: string; fit: boolean; contradictOnly?: boolean }> = it.requirements.filter((x) => x.polarity === "REQUIRED").map((x) => ({ key: checkKey(x.key), text: x.text, fit: false, contradictOnly: (x as { strength?: string }).strength !== "MUST" }));
    if (target && target.kind === "ACCESSORY" && target.model) obligations.push({ key: fitKey(target.model), text: target.model, fit: true });
    // E4.1: every other stated phrase is an obligation too. Context requirements and request segments nothing interpreted
    // (D1) are contradiction-only: they block when a claim about R denies them, never because they are unverified.
    if (flags.obligations) {
      for (const x of it.requirements) if (x.polarity !== "REQUIRED" && x.polarity !== "EXCLUDED" && !obligations.some((o) => o.key === checkKey(x.key))) obligations.push({ key: checkKey(x.key), text: x.text, fit: false, contradictOnly: true });
      for (const sp of orphanSpans(req, consumed, r, inp)) if (!obligations.some((o) => o.key === sp.key)) obligations.push({ ...sp, fit: false, contradictOnly: true });
    }
    if (!obligations.length) add("K3", true, "no stated phrase to check");
    else if (flags.binder) {
      const negValue = (o: { text: string; fit: boolean }) => (t: string) => {
        if (o.fit) return false;
        const m = NEG_VALUE.exec(t); if (!m) return false;
        const label = words(m[1]!); const ow = content(o.text).filter((w) => w !== "only");
        return ow.length > 0 && ow.every((w) => label.some((l) => l === w || (w.length >= 2 && (l.startsWith(w) || w.startsWith(l)) && Math.min(l.length, w.length) >= 2)));
      };
      const readPages = () => manu(pool).map((h) => ({ h, claims: claimsOf(h, inp.products) })).filter((p) => claimsAbout(p.claims, r.productId) > 0);
      let pages = readPages();
      const needsLookup = obligations.some((o) => o.fit || !confirmed.has(o.key));
      if (!pages.length && needsLookup && inp.lookupAllowed !== false && deps.router && typeof deps.router.lookupProductPages === "function") { log.pageLookups++; await deps.router.lookupProductPages(r, deps.ctx, sellers); pool = deps.router.requestHits(deps.ctx.requestId); pages = readPages(); }
      const found: string[] = [];
      for (const p of pages) for (const o of obligations) {
        const st = statementFor(p.claims, r.productId, o.key, negValue(o));
        if (st.value === false && process.env.DIAPORIA_KERNEL_DEBUG) console.error("[kernel-k3b]", JSON.stringify({ r: r.productId, title: p.h.title, listed: inp.products.map((x) => [x.productId, x.title, x.identity.model]) }));
        if (st.value === false) found.push(`"${o.text}" is denied for ${describe(pageSubject(p.h.title, inp.products))} on ${hostOf(p.h.url)}: "${st.claim!.sentence.slice(0, 120)}"`);
      }
      // A MUST the engine already blocks on this product (unverified, owner-confirmable) is already not payable as is: the
      // kernel adds no second gate for it and leaves the existing owner-confirmation rule unchanged.
      const engineBlocked = (key: string) => (d.ranking.find((x) => x.productId === r.productId)?.blockers ?? []).some((b) => b.detail.includes(`"${key}"`) || b.detail.includes(`"${key.replace(/^unrecognized:/, "")}"`));
      const unchecked = obligations.filter((o) => !o.contradictOnly && !confirmed.has(o.key) && !engineBlocked(o.key));
      if (found.length) add("K3", false, [...new Set(found)].join("; "));
      else if (!pages.length && flags.unchecked && !isRec && unchecked.length) add("K3", false, `UNCHECKED: no page about this product was readable and nothing bound verifies ${unchecked.map((o) => `"${o.text}"`).join(", ")} (not payable)`);
      else if (!pages.length) add("K3", true, "UNCHECKED: no manufacturer page for this product was readable");
      else add("K3", true, `no claim about this product denies a stated phrase (${obligations.length} obligations, ${pages.length} pages)`);
    } else {
      let pages = manu(bound(pool));
      // One lookup only when some phrase is not already a MUST the engine verified (its evidence was negation-checked).
      const verifiedKeys = new Set((d.ranking.find((x) => x.productId === r.productId)?.satisfied ?? []).map((x) => checkKey(x.key)));
      const needsLookup = obligations.some((o) => o.fit || !verifiedKeys.has(o.key));
      if (!pages.length && needsLookup && inp.lookupAllowed !== false && deps.router && typeof deps.router.lookupProductPages === "function") { log.pageLookups++; await deps.router.lookupProductPages(r, deps.ctx, sellers); pool = deps.router.requestHits(deps.ctx.requestId); pages = manu(bound(pool)); }
      if (process.env.DIAPORIA_KERNEL_DEBUG && !pages.length) console.error("[kernel-pool]", JSON.stringify({ r: r.title, req: requiredWords(r), model: modelTokens(r), killers: pool.slice(0, 12).map((h) => [h.title, continuesModel(h.title, r), inp.products.filter((l) => l.productId !== r.productId && requiredWords(l).some((w) => !tokset(r.title).has(w)) && contains(h.title, requiredWords(l))).map((l) => [l.title, requiredWords(l)])]), pool: pool.map((h) => [h.url, h.title, titleBindsTo(h.title, r, inp.products), deps.router?.registry.classify(h.url, brand, sellers, h.publishedDate ?? null)]) }));
      // No readable manufacturer page: nothing known contradicts the phrases. Passed but logged as UNCHECKED (design
      // decision v0.1: failing closed here blocked every fixture flow without an evidence provider; see the journal).
      if (!pages.length) add("K3", true, "UNCHECKED: no manufacturer page for this product was readable");
      else {
        const hitsFound: string[] = [];
        for (const p of pages) for (const sent of sentencesOf(`${p.snippet}`)) for (const o of obligations) {
          if (!o.fit && (aboutOtherViaComparison(sent, r) || inp.products.some((s) => s.productId !== r.productId && namesOther(sent, s, r)))) continue;
          let neg = false;
          try { neg = clauseStatement(sent, o.key) === false; } catch { neg = false; }
          if (!neg && !o.fit) {
            const m = NEG_VALUE.exec(sent);
            if (m) {
              const label = words(m[1]!); const ow = content(o.text).filter((w) => w !== "only");
              neg = ow.length > 0 && ow.every((w) => label.some((l) => l === w || (w.length >= 2 && (l.startsWith(w) || w.startsWith(l)) && Math.min(l.length, w.length) >= 2)));
            }
          }
          if (neg) hitsFound.push(`"${o.text}" is negated on ${hostOf(p.url)}: "${sent.slice(0, 120)}"`);
        }
        add("K3", hitsFound.length === 0, hitsFound.length ? [...new Set(hitsFound)].join("; ") : "no bound manufacturer statement negates a stated phrase");
      }
    }
  }

  // K4 numbers nothing consumed
  {
    const covered = new Set([...consumed, ...tokset(`${target?.model ?? ""} ${target?.brand ?? ""}`)]);
    // The sentence that states the purchase only: later sentences (notes, quoted or injected text) are not the request.
    const rq = words(req.split(/(?<=[.!?])\s+/)[0] ?? req); const rjt = joinedTokens(r.title);
    const stray = rq.filter((w, i) => hasDigit(w) && !/^\d+(?:st|nd|rd|th)$/.test(w) && !covered.has(w) && !rTitle.has(w) && !numberInTitle(rq, i, rjt));
    add("K4", stray.length === 0, stray.length ? `numbers in the request that nothing interpreted: ${stray.join(", ")}` : "every number is accounted for");
  }

  return out;
}

/**
 * E4.1 (D1): request segments (split at commas, semicolons and "and") that nothing interpreted: none of their content
 * words is part of the identity, a requirement, money, an attribute or the listing's own name. Each becomes a
 * contradiction-only obligation keyed as a proposition ("Cellaro 46 Dual, built-in" → "unrecognized:built-in").
 */
function orphanSpans(req: string, consumed: Set<string>, r: CatalogProduct, inp: KernelInput): Array<{ key: string; text: string }> {
  const first = req.split(/(?<=[.!?])\s+/)[0] ?? req;
  const t = inp.intent.target;
  const known = new Set([...consumed, ...tokset(`${t?.brand ?? ""} ${t?.model ?? ""} ${t?.accessoryNoun ?? ""} ${r.title} ${r.category ?? ""} ${r.research?.categoryTitle ?? ""}`)]);
  const out: Array<{ key: string; text: string }> = [];
  for (const seg of first.split(/\s*[,;]\s*|\s+and\s+/i)) {
    const cw = content(seg).filter((w) => !hasDigit(w));
    if (!cw.length || cw.some((w) => known.has(w))) continue;
    const slug = norm(seg).replace(/[^a-z0-9가-힣]+/g, "-").replace(/^-|-$/g, "");
    if (slug) out.push({ key: `unrecognized:${slug}`, text: seg.trim() });
  }
  return out;
}
