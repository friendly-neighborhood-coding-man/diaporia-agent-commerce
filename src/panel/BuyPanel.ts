import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { CommerceGateway } from "../engine/CommerceGateway.js";
import { CommerceError } from "../engine/errors.js";
import type { Store } from "../store/Database.js";
import { SCOPES, type Principal } from "../auth/devAuth.js";
import { progressContext } from "./progress.js";
import { redact } from "../security/redact.js";

/**
 * DIAPORIA Buy panel (docs/BUY_PANEL.md): an observer and interaction surface over the SAME purchase session the MCP
 * tools use. It is not a second purchasing engine:
 *  - research runs through gateway.researchPurchase (the research_purchase tool's code path);
 *  - offer comparison runs through gateway.compareOffers with the product identity read from the server's stored
 *    research candidates (the browser sends only a productId);
 *  - checkout preparation runs through gateway.prepareCheckout with the server's own verified total as the client
 *    maximum (the browser sends only an offerId that must be in the server's comparison);
 *  - payment authorization stays on the existing owner page (/authorize/…, owner key) and the (MOCK) PayPal buyer
 *    step; the panel only links to them;
 *  - payment status and the receipt are read from gateway.getCheckoutStatus / getPurchaseReceipt.
 *
 * Access: a panel link carries a random capability (dpl_…, stored only as SHA-256) bound to one panel run, one user and
 * at most one purchase session. Its rights are never wider than the MCP principal that minted it: compare needs the
 * research scope (which minting already required), prepare needs the prepare scope AND a deployment where payment
 * preparation is enabled. The AI host that minted the link can already do everything the link can, so the link widens
 * nothing.
 */

export type RunState = "RESEARCHING" | "READY" | "FAILED" | "INTERRUPTED";
export interface PanelRun {
  runId: string; userId: string; purchaseSessionId: string | null; state: RunState; canPrepare: boolean; mintedBy: string;
  selectedProductId: string | null; compare: Record<string, unknown> | null; checkoutSessionId: string | null; prepare: Record<string, unknown> | null;
  error: { code: string; message: string } | null; createdAt: number; expiresAt: number; version: number;
}
export interface ProgressLine { seq: number; at: string; step: string; label: string; detail: string | null }

const RUN_TTL_MS = 2 * 60 * 60_000;
const MAX_PROGRESS = 60;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const RUN_ID = /^br_[0-9a-f-]{36}$/;

export interface BuyPanelConfig { baseUrl: string; paymentExecutionEnabled: boolean; now?: () => number }

export class BuyPanel {
  private readonly progress = new Map<string, ProgressLine[]>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly now: () => number;

  constructor(private readonly store: Store, private readonly gateway: CommerceGateway, private readonly cfg: BuyPanelConfig) {
    this.now = cfg.now ?? Date.now;
    store.db.exec(`CREATE TABLE IF NOT EXISTS buy_panel_runs (
      run_id TEXT PRIMARY KEY, link_hash TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL, purchase_session_id TEXT, state TEXT NOT NULL,
      can_prepare INTEGER NOT NULL, minted_by TEXT NOT NULL, selected_product_id TEXT, compare_json TEXT, checkout_session_id TEXT, prepare_json TEXT,
      error_json TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 0)`);
    // A research that was running when the server stopped cannot resume (its in-memory call is gone). Say so.
    store.db.prepare("UPDATE buy_panel_runs SET state='INTERRUPTED', error_json=?, version=version+1 WHERE state='RESEARCHING'")
      .run(JSON.stringify({ code: "RESEARCH_INTERRUPTED", message: "The server restarted while research was running. Ask the assistant to research again." }));
  }

  // ------------------------------------------------------------------ minting (MCP side)

  private mint(principal: Principal, purchaseSessionId: string | null, state: RunState) {
    const runId = `br_${randomUUID()}`;
    const link = `dpl_${randomBytes(32).toString("base64url")}`;
    const canPrepare = this.cfg.paymentExecutionEnabled && principal.scopes.has(SCOPES.PREPARE);
    const now = this.now();
    this.store.db.prepare(`INSERT INTO buy_panel_runs(run_id,link_hash,user_id,purchase_session_id,state,can_prepare,minted_by,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(runId, sha(link), principal.userId, purchaseSessionId, state, canPrepare ? 1 : 0, `${principal.kind}:${principal.tokenFingerprint}`, now, now + RUN_TTL_MS);
    this.gateway.audit.append(runId, principal.userId, "BUY_PANEL_OPENED", { purchaseSessionId, canPrepare, actor: `${principal.kind}:${principal.tokenFingerprint}` });
    const panelUrl = `${this.cfg.baseUrl}/buy/#run=${runId}&k=${link}`;
    return { runId, panelUrl, canPrepare, link };
  }

  private hostHints(panelUrl: string) {
    return {
      panelUrl,
      openIn: [
        "Claude Desktop / Claude Code Desktop: open panelUrl in the built-in Browser panel beside the conversation.",
        "Codex Desktop: open panelUrl in the right-side Browser tab next to the conversation.",
        "CLI hosts: open panelUrl in a separate browser window if the host can (e.g. the system browser), and always print it as a clickable link.",
        "Other hosts: show panelUrl as a clickable link the user opens in a browser on this machine.",
      ],
      opening: "DIAPORIA cannot open or dock a panel itself. If the host cannot open it programmatically, show panelUrl as a link.",
      linkNote: "The link contains a capability for this one purchase session. Do not post it anywhere public. It cannot authorize payment: the owner page and the payment approval still require the owner.",
    };
  }

  /** start_shopping_panel: start research in the background (same gateway call as research_purchase) and return the panel link at once. */
  start(principal: Principal, input: Parameters<CommerceGateway["researchPurchase"]>[1]) {
    if (!principal.scopes.has(SCOPES.RESEARCH)) throw new CommerceError("FORBIDDEN", `Token lacks scope ${SCOPES.RESEARCH}`);
    const m = this.mint(principal, null, "RESEARCHING");
    this.record(m.runId, "QUEUED", "Research started", null);
    const job = progressContext.run({ emit: (step, label, detail) => this.record(m.runId, step, label, detail ?? null) }, async () => {
      try {
        const out = await this.gateway.researchPurchase(principal.userId, input);
        this.update(m.runId, { purchaseSessionId: out.purchaseSessionId, state: "READY" });
        this.record(m.runId, "DONE", out.state === "HOLD" ? "Research finished: on hold" : "Research finished", `${(out.candidates ?? []).length} candidates ranked`);
      } catch (e) {
        const err = e instanceof CommerceError ? { code: e.code, message: e.message } : { code: "RESEARCH_FAILED", message: "Research failed; see the server audit log." };
        try { this.update(m.runId, { state: "FAILED", error: err }); this.record(m.runId, "FAILED", "Research failed", err.code); }
        catch { /* store closed (server shutting down): the next start marks this run INTERRUPTED */ }
      } finally { this.inflight.delete(m.runId); }
    });
    this.inflight.set(m.runId, job);
    return { runId: m.runId, state: "RESEARCHING" as const, ...this.hostHints(m.panelUrl), canPrepareFromPanel: m.canPrepare, paymentEffect: "NONE" as const };
  }

  /** open_shopping_panel: a panel over an existing purchase session of this user. */
  open(principal: Principal, purchaseSessionId: string) {
    if (!principal.scopes.has(SCOPES.RESEARCH)) throw new CommerceError("FORBIDDEN", `Token lacks scope ${SCOPES.RESEARCH}`);
    try { this.gateway.sessions.getPurchaseSession(purchaseSessionId, principal.userId); }
    catch { throw new CommerceError("NOT_FOUND", "Purchase session not found"); }
    const m = this.mint(principal, purchaseSessionId, "READY");
    this.record(m.runId, "DONE", "Opened on an existing purchase session", null);
    return { runId: m.runId, state: "READY" as const, ...this.hostHints(m.panelUrl), canPrepareFromPanel: m.canPrepare, paymentEffect: "NONE" as const };
  }

  /** Test hook: wait for a background research to finish. */
  async settled(runId: string) { await this.inflight.get(runId); }

  // ------------------------------------------------------------------ access

  /** The run for a panel capability, or null. Expired runs are refused. */
  authenticate(header: string | undefined, runId: string): PanelRun | null {
    const m = /^Bearer (dpl_[A-Za-z0-9_-]{43})$/.exec(header ?? "");
    if (!m || !RUN_ID.test(runId)) return null;
    const r = this.store.db.prepare("SELECT * FROM buy_panel_runs WHERE link_hash = ?").get(sha(m[1]!)) as Row | undefined;
    if (!r || String(r.run_id) !== runId) return null;
    const run = toRun(r);
    return run.expiresAt > this.now() ? run : null;
  }

  /** Read by the owning MCP principal (get_shopping_panel). */
  getForUser(userId: string, runId: string): PanelRun {
    const r = RUN_ID.test(runId) ? this.store.db.prepare("SELECT * FROM buy_panel_runs WHERE run_id = ? AND user_id = ?").get(runId, userId) as Row | undefined : undefined;
    if (!r) throw new CommerceError("NOT_FOUND", "Panel run not found");
    return toRun(r);
  }

  private reload(runId: string): PanelRun { return toRun(this.store.db.prepare("SELECT * FROM buy_panel_runs WHERE run_id = ?").get(runId) as Row); }

  private update(runId: string, p: Partial<Pick<PanelRun, "purchaseSessionId" | "state" | "selectedProductId" | "compare" | "checkoutSessionId" | "prepare" | "error">>) {
    const cur = this.reload(runId);
    const n = { ...cur, ...p };
    this.store.db.prepare(`UPDATE buy_panel_runs SET purchase_session_id=?, state=?, selected_product_id=?, compare_json=?, checkout_session_id=?, prepare_json=?, error_json=?, version=version+1 WHERE run_id=?`)
      .run(n.purchaseSessionId, n.state, n.selectedProductId, n.compare ? JSON.stringify(n.compare) : null, n.checkoutSessionId, n.prepare ? JSON.stringify(n.prepare) : null,
        n.error ? JSON.stringify(n.error) : null, runId);
    this.notify(runId);
  }

  // ------------------------------------------------------------------ live updates

  private record(runId: string, step: string, label: string, detail: string | null) {
    const list = this.progress.get(runId) ?? [];
    const last = list[list.length - 1];
    // Collapse repeats of the same step/label so a long search reads as one line with a count.
    if (last && last.step === step && last.label === label && detail === null) { last.detail = `${(Number(/^×(\d+)$/.exec(last.detail ?? "")?.[1] ?? 1)) + 1}`.replace(/^/, "×"); last.at = new Date(this.now()).toISOString(); }
    else list.push({ seq: (last?.seq ?? 0) + 1, at: new Date(this.now()).toISOString(), step, label, detail });
    if (list.length > MAX_PROGRESS) list.splice(0, list.length - MAX_PROGRESS);
    this.progress.set(runId, list);
    this.notify(runId);
  }

  subscribe(runId: string, fn: () => void): () => void {
    const set = this.listeners.get(runId) ?? new Set();
    set.add(fn); this.listeners.set(runId, set);
    return () => { set.delete(fn); if (!set.size) this.listeners.delete(runId); };
  }
  private notify(runId: string) { for (const fn of this.listeners.get(runId) ?? []) { try { fn(); } catch { /* listener errors never affect state */ } } }

  // ------------------------------------------------------------------ views

  /** The panel's whole state, built only from server records. */
  view(run: PanelRun) {
    run = this.reload(run.runId);
    const base = {
      runId: run.runId, runState: run.state, error: run.error, progress: this.progress.get(run.runId) ?? [],
      paymentEnvironment: this.gateway.payments.name === "PAYPAL_SANDBOX" ? "PAYPAL_SANDBOX" : "MOCK",
      researchData: this.gateway.research.isMock ? "MOCK_OR_FIXTURE" : "LIVE_CATALOG",
      capabilities: { compare: true, prepare: run.canPrepare },
      expiresAt: new Date(run.expiresAt).toISOString(),
    };
    if (!run.purchaseSessionId) return { ...base, view: run.state === "RESEARCHING" ? "PROGRESS" : "ERROR", session: null, candidates: [], selection: null, comparison: null, checkout: null, receipt: null };
    const ps = this.gateway.sessions.getPurchaseSession(run.purchaseSessionId, run.userId);
    const cards = topCandidates(ps.research as ResearchRecord);
    const decision = (ps.research as ResearchRecord).decision ?? null;
    const session = {
      purchaseSessionId: ps.purchaseSessionId, state: ps.state, mode: ps.mode, request: ps.request,
      currency: ps.intent.currency, budgetMinor: ps.intent.budgetMinor, expired: ps.expiresAt <= this.now(), expiresAt: new Date(ps.expiresAt).toISOString(),
      decisionState: decision?.state ?? null, holdReasons: (decision?.holdReasons ?? []).slice(0, 6),
      lockedProductId: ps.productId,
    };
    let checkout = null as null | Record<string, unknown>;
    let receipt = null as null | Record<string, unknown>;
    if (run.checkoutSessionId) {
      const st = this.gateway.getCheckoutStatus(run.userId, run.checkoutSessionId);
      checkout = { status: st, handoff: this.handoff(st, run.prepare) };
      // COMPLETED is shown only when the payment backend's own record says so (never from the browser or a redirect).
      if (st.state === "COMPLETED") receipt = this.gateway.getPurchaseReceipt(run.userId, run.checkoutSessionId) as unknown as Record<string, unknown>;
    } else if (run.prepare) checkout = { status: null, handoff: this.handoff(null, run.prepare) };
    const view = receipt ? "RECEIPT" : checkout ? "CHECKOUT" : run.compare ? "COMPARE" : cards.length ? "RESULTS" : "RESULTS_EMPTY";
    return redact({ ...base, view, session, candidates: cards, selection: run.selectedProductId ? { productId: run.selectedProductId } : null,
      comparison: run.compare, checkout, receipt: receipt ? trimReceipt(receipt) : null });
  }

  private handoff(st: ReturnType<CommerceGateway["getCheckoutStatus"]> | null, prepare: Record<string, unknown> | null) {
    const same = (u: unknown) => typeof u === "string" && u.startsWith(`${this.cfg.baseUrl}/`) ? u : null;
    if (st?.state === "APPROVAL_REQUIRED" && st.approval.approvalUrl) {
      const u = String(st.approval.approvalUrl);
      const ok = same(u) ?? (/^https:\/\/www\.sandbox\.paypal\.com\//.test(u) ? u : null);
      if (ok) return { kind: "BUYER_PAYMENT_APPROVAL", url: ok, who: "The buyer approves the payment on the payment page (MOCK: owner key stands in for the PayPal login)." };
    }
    const ownerUrl = same(prepare?.userAuthorizationUrl);
    if (ownerUrl && (!st || ["APPROVAL_REQUIRED", "HOLD", "PREPARED"].includes(st.state)))
      return { kind: "OWNER_AUTHORIZATION", url: ownerUrl, who: "The owner reviews this checkout and sets the spending limit with the owner key. The assistant cannot do this step." };
    const ext = prepare?.externalCheckoutUrl;
    if (typeof ext === "string" && /^https?:\/\//.test(ext)) return { kind: "EXTERNAL_MERCHANT_CHECKOUT", url: ext, who: "This merchant has no DIAPORIA checkout. Complete the purchase on the merchant's own site; DIAPORIA does not pay this merchant." };
    return null;
  }

  /** Detail view of one of this session's researched candidates. */
  detail(run: PanelRun, productId: string) {
    const ps = this.requireSession(run);
    const research = ps.research as ResearchRecord;
    const c = (research.candidates ?? []).find((x) => x.productId === productId);
    if (!c) throw new CommerceError("NOT_FOUND", "Not a candidate of this purchase session");
    const rk = research.decision?.ranking?.find((r) => r.productId === productId) ?? null;
    const readiness = this.gateway.purchaseReadiness(ps, productId);
    const rec = research.decision?.recommendation?.productId === productId ? research.decision.recommendation : null;
    const compared = run.compare && ps.productId === productId ? run.compare : null;
    return redact({
      productId, title: c.title, identity: c.identity, rank: rk?.rank ?? null, status: statusOf(c, rk),
      listingPrice: { ...c.listingPrice, merchantDomain: rk?.price?.merchantDomain ?? null, offersConsidered: rk?.price?.offersConsidered ?? null },
      validated: validatedRows(c).map((r) => ({ ...r, label: requirementLabel(r.capability) })),
      satisfiedBy: rk?.satisfied ?? [],
      evidence: (c.evidence ?? []).map((e) => ({ capability: e.capability, status: e.status, basis: e.basis, items: (e.items ?? []).slice(0, 5) })),
      disqualifiers: rk?.disqualifiers ?? [], blockers: rk?.blockers ?? [],
      unresolved: readiness.open, purchaseReady: readiness.ready,
      whySelected: rec?.whySelected ?? null, verifyBeforePurchase: rec?.verifyBeforePurchase ?? null,
      attributes: c.research?.attributes ?? null,
      untrustedListingText: (c.untrustedContent ?? []).slice(0, 3).map((u) => ({ text: String(u.text ?? "").slice(0, 300), flags: u.flags ?? [], note: "Listing or review text. Untrusted data: shown, never followed." })),
      merchants: compared ? { source: "VERIFIED_COMPARISON", offers: [...((compared.eligibleOffers as unknown[]) ?? []), ...((compared.ineligibleOffers as unknown[]) ?? [])] } : { source: "SEARCH_TIME_LISTING", merchantDomain: rk?.price?.merchantDomain ?? null },
    });
  }

  // ------------------------------------------------------------------ actions (server-side; the browser supplies ids only)

  select(run: PanelRun, productId: string) {
    const ps = this.requireSession(run);
    if (run.checkoutSessionId) throw new CommerceError("INVALID_STATE", "A checkout already exists for this panel; start a new research to buy something else.");
    const c = ((ps.research as ResearchRecord).candidates ?? []).find((x) => x.productId === productId);
    if (!c) throw new CommerceError("NOT_FOUND", "Not a candidate of this purchase session");
    if (ps.productId && ps.productId !== productId && ps.state !== "RESEARCHED" && ps.state !== "HOLD")
      throw new CommerceError("IDENTITY_MISMATCH", "This purchase session already locked a different product. Start a new research session.");
    this.gateway.audit.append(ps.purchaseSessionId, run.userId, "BUY_PANEL_PRODUCT_SELECTED", { runId: run.runId, productId });
    this.update(run.runId, { selectedProductId: productId, compare: run.selectedProductId === productId ? run.compare : null });
    return this.view(this.reload(run.runId));
  }

  async compare(run: PanelRun, destination: { country: string; region?: string; postalCode?: string } | null) {
    const ps = this.requireSession(run);
    if (!run.selectedProductId) throw new CommerceError("INVALID_STATE", "Select a product first.");
    if (run.checkoutSessionId) throw new CommerceError("INVALID_STATE", "A checkout already exists for this panel.");
    const c = ((ps.research as ResearchRecord).candidates ?? []).find((x) => x.productId === run.selectedProductId);
    if (!c) throw new CommerceError("NOT_FOUND", "Selected product is no longer a candidate");
    // The identity is the server's own research record, never the browser's.
    const out = await this.gateway.compareOffers(run.userId, { researchSessionId: ps.purchaseSessionId, productIdentity: c.identity as never, destination });
    this.update(run.runId, { compare: out as unknown as Record<string, unknown> });
    return this.view(this.reload(run.runId));
  }

  async prepare(run: PanelRun, offerId: string) {
    if (!run.canPrepare) throw new CommerceError("FORBIDDEN", "This panel link cannot prepare checkouts (the assistant's connection has no prepare scope, or payment preparation is disabled on this server).");
    const ps = this.requireSession(run);
    const known = (ps.comparison?.eligible ?? []).find((o) => o.offerId === offerId) as { offerId: string; cost?: { totalMinor: number | null } } | undefined;
    if (!known) throw new CommerceError("OFFER_NOT_ELIGIBLE", "Offer is not an eligible offer of this session's verified comparison.");
    const total = known.cost?.totalMinor;
    if (typeof total !== "number" || !Number.isSafeInteger(total) || total <= 0) throw new CommerceError("OFFER_NOT_ELIGIBLE", "The offer has no verified total.");
    // The client maximum is the server's own verified total: a fresh quote that costs more is refused (CLIENT_LIMIT_EXCEEDED).
    const out = await this.gateway.prepareCheckout(run.userId, { purchaseSessionId: ps.purchaseSessionId, offerId, maximumApprovedTotalMinor: total, currency: ps.intent.currency, quantity: 1 },
      `BUY_PANEL:${run.runId}:${run.mintedBy}`) as Record<string, unknown>;
    this.update(run.runId, { checkoutSessionId: typeof out.checkoutSessionId === "string" ? out.checkoutSessionId : null, prepare: pickPrepare(out) });
    return this.view(this.reload(run.runId));
  }

  /**
   * After the checkout ended without payment (CANCELLED, FAILED, EXPIRED), go back to offer comparison. Only the panel's
   * pointer is cleared; the checkout record and its audit stay. Fresh quotes are required (the comparison is cleared), and
   * a new prepare is still decided by the gateway's own one-payment-per-session rules.
   */
  reset(run: PanelRun) {
    if (!run.checkoutSessionId && !run.prepare) throw new CommerceError("INVALID_STATE", "There is no checkout to leave.");
    if (run.checkoutSessionId) {
      const st = this.gateway.getCheckoutStatus(run.userId, run.checkoutSessionId);
      if (!["CANCELLED", "FAILED", "EXPIRED"].includes(st.state)) throw new CommerceError("INVALID_STATE", `The checkout is ${st.state}; it can only be left after it was cancelled, failed or expired.`);
    }
    this.gateway.audit.append(run.purchaseSessionId ?? run.runId, run.userId, "BUY_PANEL_CHECKOUT_LEFT", { runId: run.runId, checkoutSessionId: run.checkoutSessionId });
    this.update(run.runId, { checkoutSessionId: null, prepare: null, compare: null });
    return this.view(this.reload(run.runId));
  }

  private requireSession(run: PanelRun) {
    if (!run.purchaseSessionId) throw new CommerceError("INVALID_STATE", run.state === "RESEARCHING" ? "Research is still running." : "This panel has no purchase session.");
    return this.gateway.sessions.getPurchaseSession(run.purchaseSessionId, run.userId);
  }
}

// ------------------------------------------------------------------ helpers

type Row = Record<string, unknown>;
function toRun(r: Row): PanelRun {
  const json = (v: unknown) => (v === null || v === undefined ? null : JSON.parse(String(v)));
  return { runId: String(r.run_id), userId: String(r.user_id), purchaseSessionId: r.purchase_session_id === null ? null : String(r.purchase_session_id), state: r.state as RunState,
    canPrepare: Number(r.can_prepare) === 1, mintedBy: String(r.minted_by), selectedProductId: r.selected_product_id === null ? null : String(r.selected_product_id),
    compare: json(r.compare_json), checkoutSessionId: r.checkout_session_id === null ? null : String(r.checkout_session_id), prepare: json(r.prepare_json),
    error: json(r.error_json), createdAt: Number(r.created_at), expiresAt: Number(r.expires_at), version: Number(r.version) };
}

interface Cap { capability: string; status: string; evidence?: { kind?: string; url?: string } | null }
interface Candidate {
  productId: string; title: string; identity: Record<string, unknown>; suitability: string; mustHave?: Cap[]; niceToHave?: Cap[];
  listingPrice: { lowestListingMinor: number | null; currency: string; note: string }; budgetFit?: string;
  untrustedContent?: Array<{ text?: string; flags?: string[] }>;
  evidence?: Array<{ capability: string; status: string; basis: string; items?: unknown[] }>;
  research?: { attributes?: unknown } | null;
}
interface Ranked { productId: string; rank: number; eligible: boolean; disqualifiers: Array<{ code: string; detail: string }>; blockers: Array<{ code: string; detail: string }>;
  satisfied?: unknown[]; price?: { merchantDomain: string | null; offersConsidered: number } }
interface ResearchRecord {
  candidates?: Candidate[];
  decision?: { state: string; holdReasons?: string[]; ranking?: Ranked[]; recommendation?: { productId: string; whySelected?: string[]; verifyBeforePurchase?: string[] } | null } | null;
}

function statusOf(c: Candidate, rk: Ranked | null): "ELIGIBLE" | "NEEDS_VERIFICATION" | "NOT_ELIGIBLE" {
  // The decision engine's eligible flag means "not disqualified"; open blockers still need verification before purchase.
  if (rk) return rk.disqualifiers.length > 0 ? "NOT_ELIGIBLE" : rk.eligible && rk.blockers.length === 0 ? "ELIGIBLE" : "NEEDS_VERIFICATION";
  return c.suitability === "SUITABLE" ? "ELIGIBLE" : c.suitability === "NEEDS_VERIFICATION" ? "NEEDS_VERIFICATION" : "NOT_ELIGIBLE";
}

/** The three best eligible (or, after them, investigable) candidates, in the decision engine's rank order. Never a disqualified one. */
export function topCandidates(research: ResearchRecord) {
  const cands = research.candidates ?? [];
  const ranking = research.decision?.ranking ?? null;
  const rankOf = (pid: string) => ranking?.find((r) => r.productId === pid) ?? null;
  const rows = cands.map((c, i) => ({ c, rk: rankOf(c.productId), i, status: statusOf(c, rankOf(c.productId)) })).filter((x) => x.status !== "NOT_ELIGIBLE");
  rows.sort((a, b) => (a.status === b.status ? 0 : a.status === "ELIGIBLE" ? -1 : 1) || (a.rk?.rank ?? a.i + 1000) - (b.rk?.rank ?? b.i + 1000));
  const recommended = research.decision?.recommendation?.productId ?? null;
  return rows.slice(0, 3).map(({ c, rk, status }, idx) => {
    const must = c.mustHave ?? [];
    return {
      position: idx + 1, productId: c.productId, title: c.title, identity: c.identity, rank: rk?.rank ?? null, status, recommended: recommended === c.productId,
      listingPrice: { lowestListingMinor: c.listingPrice?.lowestListingMinor ?? null, currency: c.listingPrice?.currency, merchantDomain: rk?.price?.merchantDomain ?? null, note: "Search-time listing price, not a checkout total." },
      mustHave: requirementCount(c),
      // Human labels for the card (server-derived; the browser renders them as text).
      requirements: validatedRows(c).map((r) => ({ label: requirementLabel(r.capability), strength: r.strength, status: r.status })),
      reason: cardReason(status, recommended === c.productId, research.decision?.recommendation?.whySelected ?? null, rk, validatedRows(c)),
      openItems: [...(rk?.blockers ?? []).map((b) => b.detail), ...must.filter((m) => m.status !== "VERIFIED_TRUE").map((m) => `${m.capability}: ${m.status}`)].slice(0, 3),
    };
  });
}

/** "unrecognized:lanyard-loop" -> "Lanyard loop", "active_noise_cancellation" -> "Active noise cancellation". */
export function requirementLabel(cap: string): string {
  const t = String(cap).replace(/^(?:unrecognized|must|nice|attr):/i, "").replace(/[_-]+/g, " ").trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : String(cap);
}
/** One sentence from the decision engine's own records (never invented): why recommended, or what still needs checking. */
function cardReason(status: string, recommended: boolean, why: string[] | null, rk: Ranked | null, rows: Array<{ capability: string; status: string; strength: string }>) {
  const must = rows.filter((r) => r.strength === "MUST");
  const ok = must.filter((r) => r.status === "VERIFIED_TRUE").length;
  if (recommended && why?.length) return why[0]!.length > 160 ? `${why[0]!.slice(0, 157)}…` : why[0]!;
  if (status === "NEEDS_VERIFICATION") {
    const open = must.filter((r) => r.status !== "VERIFIED_TRUE").map((r) => requirementLabel(r.capability));
    return open.length ? `Needs investigation: ${open.slice(0, 3).join(", ").toLowerCase()} not yet verified by an attributable source.` : `Needs investigation: ${(rk?.blockers?.[0]?.detail ?? "open items remain").slice(0, 140)}`;
  }
  if (must.length && ok < must.length) return `${ok} of ${must.length} stated requirements verified with evidence; ranked #${rk?.rank ?? "?"} by the decision engine.`;
  return must.length ? `Meets all ${ok} stated requirement${ok === 1 ? "" : "s"} with evidence; ranked #${rk?.rank ?? "?"} by the decision engine.` : `Ranked #${rk?.rank ?? "?"} by the decision engine.`;
}

/**
 * Requirement rows: the V1-shaped must/nice capability list plus every requirement the V2 evidence ledger checked
 * (e.g. a requirement the parser could not map to a known capability), so the card count matches the detail.
 */
function validatedRows(c: Candidate) {
  const rows = [...(c.mustHave ?? []).map((m) => ({ ...m, strength: "MUST" })), ...(c.niceToHave ?? []).map((m) => ({ ...m, strength: "NICE" }))];
  for (const e of c.evidence ?? []) if (!rows.some((r) => r.capability === e.capability))
    rows.push({ capability: e.capability, status: e.status === "UNVERIFIED" ? "UNKNOWN" : e.status, evidence: null, strength: "MUST" });
  return rows;
}
function requirementCount(c: Candidate) {
  const must = validatedRows(c).filter((r) => r.strength === "MUST");
  return { verified: must.filter((m) => m.status === "VERIFIED_TRUE").length, total: must.length };
}

function pickPrepare(out: Record<string, unknown>) {
  const keys = ["checkoutSessionId", "state", "checkoutPath", "authorizationRequirements", "approvalUrl", "userAuthorizationUrl", "externalCheckoutUrl", "expiresAt", "policy", "paymentEffect", "paymentEnvironment", "note", "purchaseSummary"];
  return Object.fromEntries(keys.filter((k) => k in out).map((k) => [k, out[k]]));
}

function trimReceipt(r: Record<string, unknown>) {
  const { auditTimeline, ...rest } = r as { auditTimeline?: Array<{ at: string; type: string }> } & Record<string, unknown>;
  return { ...rest, auditTimeline: (auditTimeline ?? []).map((e) => ({ at: e.at, type: e.type })) };
}
