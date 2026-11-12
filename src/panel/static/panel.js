/* DIAPORIA Buy panel. One frontend for every host browser surface (Claude Desktop Browser panel, Codex Desktop Browser
 * tab, a normal browser window). It only displays server records and sends ids (productId, offerId) and a shipping
 * country; prices, identities and payment status always come from the server. Every string from the server is placed
 * with textContent (never innerHTML). */
(function () {
  "use strict";
  var app = document.getElementById("app");
  var conn = document.getElementById("conn");
  var envEl = document.getElementById("env");
  var toastEl = document.getElementById("toast");

  // ---------------------------------------------------------------- capability from the link (#run=…&k=…)
  var params = new URLSearchParams(location.hash.slice(1));
  var runId = params.get("run");
  var key = params.get("k");
  try {
    if (runId && key) { sessionStorage.setItem("dpl:" + runId, key); sessionStorage.setItem("dpl:last", runId); }
    if (runId && !key) key = sessionStorage.getItem("dpl:" + runId);
    if (!runId) { runId = sessionStorage.getItem("dpl:last"); key = runId ? sessionStorage.getItem("dpl:" + runId) : null; }
  } catch (e) { /* storage blocked: the link still works until reload */ }
  // Keep the capability out of the address bar, screenshots and history once it is stored.
  if (runId && key) { try { history.replaceState(null, "", "/buy/#run=" + runId); } catch (e) {} }

  // A host that re-navigates an already open panel tab to a new link only changes the #fragment: load that link.
  window.addEventListener("hashchange", function () {
    var n = new URLSearchParams(location.hash.slice(1));
    if (n.get("run") && (n.get("run") !== runId || n.get("k"))) location.reload();
  });

  var snap = null;          // last server snapshot
  var ui = { detail: null, detailData: null, busy: false, dest: { country: "US", region: "CA" } };
  var stopped = false;

  // ---------------------------------------------------------------- helpers
  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) continue;
      if (k === "text") n.textContent = String(v);
      else if (k === "class") n.className = v;
      else if (k.slice(0, 2) === "on") n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? "" : String(v));
    }
    (kids || []).forEach(function (c) { if (c !== null && c !== undefined && c !== false) n.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return n;
  }
  function money(minor, cur) {
    if (minor === null || minor === undefined) return "unknown";
    var digits = cur === "JPY" || cur === "KRW" ? 0 : 2;
    try { return new Intl.NumberFormat(undefined, { style: "currency", currency: cur || "USD", minimumFractionDigits: digits, maximumFractionDigits: digits }).format(minor / Math.pow(10, digits)); }
    catch (e) { return (minor / Math.pow(10, digits)).toFixed(digits) + " " + cur; }
  }
  function kv(rows) {
    return el("table", { class: "kv" }, rows.filter(Boolean).map(function (r) {
      return el("tr", null, [el("td", { text: r[0] }), el("td", null, [typeof r[1] === "string" || typeof r[1] === "number" ? String(r[1]) : r[1]])]);
    }));
  }
  function chip(text, cls) { return el("span", { class: "chip " + (cls || ""), text: text }); }
  function safeUrl(u) { return typeof u === "string" && /^https?:\/\//.test(u) ? u : null; }
  function extLink(u, text) { var s = safeUrl(u); return s ? el("a", { href: s, target: "_blank", rel: "noopener noreferrer", text: text || s }) : el("span", { text: text || String(u || "") }); }
  function toast(msg) { toastEl.textContent = msg; toastEl.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(function () { toastEl.hidden = true; }, 7000); }
  function setConn(state, text) { conn.className = "conn " + state; conn.textContent = text; }
  function statusChip(s) { return s === "ELIGIBLE" ? chip("Eligible", "ok") : s === "NEEDS_VERIFICATION" ? chip("Needs verification", "warn") : chip(s, "bad"); }

  // ---------------------------------------------------------------- API
  function api(path, opts) {
    opts = opts || {};
    var h = { Authorization: "Bearer " + key };
    if (opts.body) h["Content-Type"] = "application/json";
    return fetch("/buy/api/runs/" + runId + (path || ""), { method: opts.method || "GET", headers: h, body: opts.body ? JSON.stringify(opts.body) : undefined, cache: "no-store", credentials: "omit" })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) { var e = new Error((j.error && j.error.message) || ("HTTP " + r.status)); e.status = r.status; e.code = j.error && j.error.code; throw e; } return j; }); });
  }
  function act(path, body) {
    if (ui.busy) return;
    ui.busy = true; render();
    return api(path, { method: "POST", body: body || {} })
      .then(function (s) { snap = s; ui.detail = null; ui.detailData = null; })
      .catch(function (e) { if (e.status === 401) return fatal(e.message); toast((e.code ? e.code + ": " : "") + e.message); })
      .then(function () { ui.busy = false; render(); });
  }
  function openDetail(pid) {
    ui.detail = pid; ui.detailData = null; render();
    api("/candidates/" + encodeURIComponent(pid)).then(function (d) { if (ui.detail === pid) { ui.detailData = d; render(); window.scrollTo(0, 0); } })
      .catch(function (e) { ui.detail = null; toast(e.message); render(); });
  }

  // ---------------------------------------------------------------- live stream (SSE over fetch, so the capability stays in a header)
  var backoff = 1000;
  function connect() {
    if (stopped) return;
    setConn("", "connecting");
    var ctrl = new AbortController();
    fetch("/buy/api/runs/" + runId + "/events", { headers: { Authorization: "Bearer " + key, Accept: "text/event-stream" }, cache: "no-store", credentials: "omit", signal: ctrl.signal })
      .then(function (r) {
        if (r.status === 401) { stopped = true; return r.json().then(function (j) { fatal((j.error && j.error.message) || "Panel link not valid."); }); }
        if (!r.ok || !r.body) throw new Error("stream " + r.status);
        setConn("live", "live"); backoff = 1000;
        var reader = r.body.getReader(); var dec = new TextDecoder(); var buf = "";
        function pump() {
          return reader.read().then(function (x) {
            if (x.done) throw new Error("stream ended");
            buf += dec.decode(x.value, { stream: true });
            var i;
            while ((i = buf.indexOf("\n\n")) >= 0) {
              var block = buf.slice(0, i); buf = buf.slice(i + 2);
              var ev = "message", data = "";
              block.split("\n").forEach(function (line) { if (line.indexOf("event:") === 0) ev = line.slice(6).trim(); else if (line.indexOf("data:") === 0) data += line.slice(5).trim(); });
              if (ev === "snapshot" && data) { try { var s = JSON.parse(data); if (s.error && !s.runId) toast(s.error.message); else { snap = s; render(); } } catch (e) {} }
            }
            return pump();
          });
        }
        return pump();
      })
      .catch(function () {
        if (stopped) return;
        setConn("down", "reconnecting…");
        // Fallback read while the stream is down, so the panel never shows stale state for long.
        api("").then(function (s) { snap = s; render(); }).catch(function (e) { if (e.status === 401) { stopped = true; fatal(e.message); } });
        setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 10000);
      });
  }
  window.addEventListener("online", function () { backoff = 1000; });

  function fatal(msg) {
    stopped = true; setConn("down", "offline");
    app.replaceChildren(el("div", { class: "box bad" }, [el("h2", { text: "This panel link cannot be used" }), el("p", { text: msg }),
      el("p", { class: "muted", text: "Ask your assistant to open a new DIAPORIA Buy panel (start_shopping_panel or open_shopping_panel)." })]));
  }

  // ---------------------------------------------------------------- views
  function render() {
    if (!snap) return;
    envEl.hidden = false;
    envEl.textContent = snap.paymentEnvironment === "PAYPAL_SANDBOX" ? "PAYPAL SANDBOX · test money" : "MOCK · no money moves";
    var parts = [];
    if (snap.session) parts.push(el("div", { class: "req" }, [el("div", { class: "muted", text: "Request" }), el("div", { text: snap.session.request })]));
    if (snap.session && snap.session.expired && snap.view !== "RECEIPT") parts.push(el("div", { class: "box warn", text: "This purchase session has expired. Research again to compare or buy." }));
    if (ui.detail) parts.push(detailView());
    else if (snap.view === "PROGRESS") parts.push(progressView());
    else if (snap.view === "ERROR") parts.push(errorView());
    else if (snap.view === "RECEIPT") parts.push(receiptView());
    else if (snap.view === "CHECKOUT") parts.push(checkoutView());
    else { if (snap.comparison) parts.push(compareView()); parts.push(resultsView()); }
    if (!ui.detail && snap.view !== "PROGRESS" && snap.progress && snap.progress.length) parts.push(el("details", null, [el("summary", { class: "muted", text: "Research log (" + snap.progress.length + ")" }), stepsList(false)]));
    app.replaceChildren.apply(app, parts);
  }

  function stepsList(running) {
    var list = snap.progress || [];
    return el("ul", { class: "steps" }, list.map(function (p, i) {
      var last = i === list.length - 1;
      return el("li", null, [last && running ? el("span", { class: "spin" }) : el("span", { class: "dot" }), el("span", { class: "t", text: p.label }), p.detail ? el("span", { class: "d", text: p.detail }) : null]);
    }));
  }
  function progressView() {
    return el("div", null, [el("h2", { text: "Researching…" }), el("p", { class: "muted", text: "DIAPORIA is searching, checking evidence and ranking products. This view updates live." }), stepsList(true)]);
  }
  function errorView() {
    var e = snap.error || { code: "UNKNOWN", message: "Research did not finish." };
    return el("div", { class: "box bad" }, [el("h2", { text: snap.runState === "INTERRUPTED" ? "Research was interrupted" : "Research failed" }), el("p", { text: e.message }), el("p", { class: "muted", text: e.code })]);
  }

  function resultsView() {
    var s = snap.session || {};
    var kids = [el("h2", { text: snap.candidates.length ? "Top " + snap.candidates.length + " candidates" : "No eligible or investigable candidate" })];
    if (s.decisionState) kids.push(el("p", { class: "muted", text: "Decision: " + s.decisionState + (s.budgetMinor ? " · budget " + money(s.budgetMinor, s.currency) : "") }));
    if (!snap.candidates.length && s.holdReasons && s.holdReasons.length) kids.push(el("ul", { class: "open" }, s.holdReasons.map(function (h) { return el("li", { text: h }); })));
    var sel = snap.selection && snap.selection.productId;
    kids.push(el("div", { class: "cards" }, snap.candidates.map(function (c) {
      return el("button", { class: "card" + (sel === c.productId ? " sel" : ""), type: "button", "aria-pressed": sel === c.productId ? "true" : "false", "data-pid": c.productId, onclick: function () { openDetail(c.productId); } }, [
        el("div", { class: "row" }, [el("span", { class: "pos", text: "#" + c.position }), el("span", { class: "title", text: c.title })]),
        el("div", { class: "row" }, [statusChip(c.status), c.recommended ? chip("Recommended", "rec") : null, sel === c.productId ? chip("Selected", "ok") : null]),
        el("div", { class: "row" }, [el("span", { class: "price", text: money(c.listingPrice.lowestListingMinor, c.listingPrice.currency) }),
          el("span", { class: "muted", text: "lowest search-time listing" + (c.listingPrice.merchantDomain ? " (" + c.listingPrice.merchantDomain + ", merchant not yet verified)" : "") + "; not a checkout total" })]),
        el("div", { class: "muted", text: "Requirements verified: " + c.mustHave.verified + "/" + c.mustHave.total }),
        c.openItems.length ? el("ul", { class: "open" }, c.openItems.map(function (o) { return el("li", { text: o }); })) : null,
      ]);
    })));
    if (snap.candidates.length && !sel) kids.push(el("p", { class: "muted", text: "Tap a product to see its evidence and select it." }));
    if (sel && !snap.comparison) kids.push(compareForm());
    return el("div", null, kids);
  }

  function compareForm() {
    var c = el("input", { name: "country", value: ui.dest.country, maxlength: "2", "aria-label": "Country", autocomplete: "off" });
    var r = el("input", { name: "region", value: ui.dest.region, maxlength: "10", "aria-label": "Region", autocomplete: "off" });
    return el("div", { class: "box" }, [
      el("h3", { text: "Compare verified offers" }),
      el("p", { class: "muted", text: "DIAPORIA asks each merchant for a fresh quote. Tax needs the shipping country and region." }),
      el("form", { class: "dest", onsubmit: function (ev) { ev.preventDefault(); ui.dest = { country: c.value.trim().toUpperCase(), region: r.value.trim().toUpperCase() };
        act("/compare", { destination: { country: ui.dest.country, region: ui.dest.region || undefined } }); } }, [
        el("label", null, ["Country", c]), el("label", null, ["Region", r]),
        el("button", { class: "btn", type: "submit", disabled: ui.busy, text: ui.busy ? "Comparing…" : "Compare offers" }),
      ]),
    ]);
  }

  function detailView() {
    var d = ui.detailData;
    var back = el("button", { class: "link", type: "button", text: "← Back to results", onclick: function () { ui.detail = null; ui.detailData = null; render(); } });
    if (!d) return el("div", null, [back, el("p", { class: "muted", text: "Loading details…" })]);
    var sel = snap.selection && snap.selection.productId === d.productId;
    var id = d.identity || {};
    var kids = [back, el("h2", { text: d.title }), el("div", { class: "row" }, [statusChip(d.status), d.rank ? chip("Rank " + d.rank) : null, sel ? chip("Selected", "ok") : null])];
    kids.push(el("h3", { text: "Identity" }), kv([["Brand", id.brand || "—"], ["Model", id.model || "—"], ["Variant", id.variant || "—"], ["Condition", id.condition || "—"], id.sku ? ["SKU", id.sku] : null,
      ["Listing price", money(d.listingPrice.lowestListingMinor, d.listingPrice.currency) + " (search-time, not a total)"]]));
    if (d.whySelected && d.whySelected.length) kids.push(el("h3", { text: "Why it ranks here" }), el("ul", null, d.whySelected.map(function (w) { return el("li", { text: w }); })));
    kids.push(el("h3", { text: "Requirements and features" }));
    kids.push(d.validated.length ? kv(d.validated.map(function (v) {
      var ok = v.status === "VERIFIED_TRUE";
      return [v.capability + (v.strength === "MUST" ? " (must)" : ""), el("span", null, [chip(v.status.replace(/_/g, " ").toLowerCase(), ok ? "ok" : v.status === "VERIFIED_FALSE" || v.status === "CONTRADICTED" ? "bad" : "warn"),
        v.evidence && v.evidence.url ? el("div", { class: "ev" }, [extLink(v.evidence.url, v.evidence.kind || "source")]) : null])];
    })) : el("p", { class: "muted", text: "No stated requirements." }));
    if (d.evidence && d.evidence.length) {
      kids.push(el("h3", { text: "Evidence" }));
      d.evidence.forEach(function (e) {
        kids.push(el("div", null, [el("div", null, [el("b", { text: e.capability }), " ", chip(e.status), " ", el("span", { class: "muted", text: e.basis || "" })])]));
        (e.items || []).forEach(function (it) {
          kids.push(el("div", { class: "ev" }, [extLink(it.url, it.sourceClass + (it.counts ? " (counted)" : " (not counted)")), it.quote ? el("div", { text: "“" + it.quote + "”" }) : null,
            it.whyNotCounted ? el("div", { class: "muted", text: it.whyNotCounted }) : null]));
        });
      });
    }
    var unresolved = [].concat((d.blockers || []).map(function (b) { return b.detail; }), d.unresolved || []).filter(function (x, i, a) { return a.indexOf(x) === i; });
    kids.push(el("h3", { text: "Unresolved conditions" }), unresolved.length ? el("ul", { class: "open" }, unresolved.map(function (u) { return el("li", { text: u }); }))
      : el("p", { class: "muted", text: d.purchaseReady ? "None. Purchase-ready once a merchant total is verified." : "None listed." }));
    if (d.verifyBeforePurchase && d.verifyBeforePurchase.length) kids.push(el("p", { class: "muted", text: "Verify before purchase: " + d.verifyBeforePurchase.join("; ") }));
    kids.push(el("h3", { text: "Merchant" }));
    if (d.merchants.source === "VERIFIED_COMPARISON") kids.push(el("p", { class: "muted", text: d.merchants.offers.length + " merchant offers were compared. See the comparison below the results." }));
    else kids.push(el("p", null, [d.merchants.merchantDomain ? el("span", { text: d.merchants.merchantDomain + " (search-time listing; merchant not yet verified)" }) : el("span", { class: "muted", text: "No merchant verified yet." })]));
    if (d.untrustedListingText && d.untrustedListingText.length) {
      kids.push(el("h3", { text: "Listing text (untrusted)" }));
      d.untrustedListingText.forEach(function (u) { kids.push(el("div", { class: "untrusted", text: u.text }), u.flags.length ? el("div", { class: "muted", text: "Flagged: " + u.flags.join(", ") + " — shown, never followed." }) : null); });
    }
    var locked = snap.session && snap.session.lockedProductId && snap.session.lockedProductId !== d.productId && snap.comparison;
    if (!sel) kids.push(el("button", { class: "btn block", type: "button", disabled: ui.busy || d.status === "NOT_ELIGIBLE" || locked || (snap.session && snap.session.expired), text: locked ? "Another product is already locked" : "Select this product",
      onclick: function () { act("/select", { productId: d.productId }); } }));
    else kids.push(el("button", { class: "btn block sec", type: "button", text: "Selected — back to compare offers", onclick: function () { ui.detail = null; render(); } }));
    return el("div", null, kids);
  }

  function costRows(cost) {
    if (!cost) return [["Total", "unknown"]];
    var cur = cost.currency;
    var unk = cost.unknownComponents || [];
    return [["Item", money(cost.itemMinor, cur)], ["Shipping", money(cost.shippingMinor, cur)], ["Tax", money(cost.taxMinor, cur)], ["Fees", money(cost.feesMinor, cur)],
      cost.discountMinor ? ["Discount", money(cost.discountMinor, cur)] : null, unk.length ? ["Unknown", unk.join(", ") + " (unknown is not zero)"] : null,
      ["Verified total", el("b", { text: money(cost.totalMinor, cur) })]];
  }

  function compareView() {
    var c = snap.comparison;
    var best = c.lowestVerifiedEligibleOffer;
    var kids = [el("h2", { text: "Verified offers" }), el("div", { class: "row" }, [chip(c.state, c.state === "OFFER_VERIFIED" ? "ok" : "warn"), el("span", { class: "muted", text: (c.destinationUsed ? "Ship to " + c.destinationUsed.country + (c.destinationUsed.region ? "-" + c.destinationUsed.region : "") : "No destination") })])];
    (c.eligibleOffers || []).forEach(function (o) {
      var isBest = best && best.offerId === o.offerId;
      kids.push(el("div", { class: "offer" }, [
        el("div", { class: "row" }, [el("span", { class: "title", text: o.merchantName === o.merchantDomain ? o.merchantName : o.merchantName + " · " + o.merchantDomain }), isBest ? chip("Lowest verified", "ok") : null]),
        kv(costRows(o.cost).concat([["Checkout", o.checkoutPath === "EXTERNAL_MERCHANT_CHECKOUT" ? "On the merchant's own site" : "DIAPORIA checkout (owner approval required)"], o.merchantIdentity ? ["Merchant identity", String(o.merchantIdentity.overall || o.merchantIdentity.legalEntity || "checked")] : null])),
        prepareButton(o, c),
      ]));
    });
    if ((c.ineligibleOffers || []).length) kids.push(el("details", null, [el("summary", { class: "muted", text: c.ineligibleOffers.length + (c.ineligibleOffers.length === 1 ? " offer rejected" : " offers rejected") }),
      el("div", null, c.ineligibleOffers.map(function (o) { return el("div", { class: "ev" }, [el("b", { text: o.merchantName + " · " + o.merchantDomain }), el("div", { class: "muted", text: (o.issues || []).join("; ") })]); }))]));
    var open = [].concat(c.holdReasons || []).filter(function (x, i, a) { return a.indexOf(x) === i; });
    if (open.length) kids.push(el("div", { class: "box warn" }, [el("b", { text: "Not ready for checkout" }), el("ul", { class: "open" }, open.map(function (h) { return el("li", { text: h }); })),
      el("p", { class: "muted", text: "Open requirements are resolved only by the owner on the owner page; ask your assistant to propose a resolution." })]));
    kids.push(el("button", { class: "link", type: "button", text: "Compare again with another destination", onclick: function () { snap.comparison = null; render(); } }));
    return el("div", { class: "box" }, kids);
  }

  function prepareButton(o, c) {
    if (c.state !== "OFFER_VERIFIED" || !o.eligible) return null;
    if (!snap.capabilities.prepare) return el("p", { class: "muted", text: "Ask your assistant to prepare this checkout (this panel link cannot prepare checkouts)." });
    return el("button", { class: "btn block", type: "button", disabled: ui.busy || (snap.session && snap.session.expired), text: ui.busy ? "Preparing…" : "Prepare checkout · " + money(o.cost && o.cost.totalMinor, o.cost && o.cost.currency),
      onclick: function () { act("/prepare", { offerId: o.offerId }); } });
  }

  function checkoutView() {
    var ck = snap.checkout; var st = ck.status; var h = ck.handoff;
    var kids = [el("h2", { text: "Checkout" })];
    if (!st) {
      kids.push(el("p", { text: "No DIAPORIA checkout was created." }));
    } else {
      var final = { FAILED: 1, CANCELLED: 1, EXPIRED: 1, REFUNDED: 1 }[st.state];
      kids.push(el("div", { class: "box " + (final ? "bad" : "") }, [
        el("div", { class: "row" }, [el("span", { class: "muted", text: "Server-verified state" }), el("span", { class: "state", text: st.state })]),
        el("div", { class: "big", text: money(st.amount.totalMinor, st.amount.currency) }),
        el("div", { class: "muted", text: "Merchant-verified total for " + ((st.productIdentity && (st.productIdentity.brand + " " + st.productIdentity.model)) || "the product") + " · quantity " + st.quantity }),
        kv([["Merchant", st.merchantIdentity ? String(st.merchantIdentity.verifiedLegalName || st.merchantIdentity.merchantName || "verified") : "—"],
          ["Spending limit", spendingLimitText(st, ck)], ["Buyer approval", st.approval.buyerApprovalVerified ? "verified" : st.approval.required ? "required" : "not yet"],
          ["Payment", st.paymentStatus], ["Next step", st.payment && st.payment.recommendedNextAction ? st.payment.recommendedNextAction.replace(/_/g, " ").toLowerCase() : "—"],
          st.failure ? ["Failure", st.failure.code + ": " + st.failure.reason] : null, st.uncertainty ? ["Note", st.uncertainty] : null, ["Expires", st.expiresAt]]),
      ]));
    }
    if (h) {
      kids.push(el("div", { class: "box warn" }, [el("b", { text: h.kind === "OWNER_AUTHORIZATION" ? "Owner approval needed" : h.kind === "BUYER_PAYMENT_APPROVAL" ? "Payment approval needed" : "Complete on the merchant site" }),
        el("p", { text: h.who }),
        // Same tab on purpose: the host's browser panel keeps the flow beside the conversation; /buy/ resumes this panel afterwards.
        el("a", { class: "btn block", href: h.url, rel: "noopener noreferrer", target: h.kind === "EXTERNAL_MERCHANT_CHECKOUT" ? "_blank" : "_self", text: h.kind === "OWNER_AUTHORIZATION" ? "Open owner approval page" : h.kind === "BUYER_PAYMENT_APPROVAL" ? "Open payment approval" : "Open merchant checkout" }),
        el("p", { class: "muted", text: "This panel only links to the approval step. It updates by itself when the server verifies the result." })]));
    } else if (st && !{ COMPLETED: 1, FAILED: 1, CANCELLED: 1, EXPIRED: 1, REFUNDED: 1 }[st.state]) {
      kids.push(el("p", { class: "muted", text: "Waiting for the payment backend to verify the result…" }));
    }
    if (st && { CANCELLED: 1, FAILED: 1, EXPIRED: 1 }[st.state]) kids.push(el("button", { class: "btn block sec", type: "button", disabled: ui.busy, text: "Back to offers (fresh quotes)",
      onclick: function () { act("/reset", {}); } }));
    if (ck.status && ck.status.purchaseOutcome) kids.push(el("p", { class: "muted", text: ck.status.purchaseOutcome.statement }));
    return el("div", null, kids);
  }
  function spendingLimitText(st, ck) {
    if (st.state === "APPROVAL_REQUIRED" && !st.approval.approvalUrl) return "not set: the owner sets it on the owner page";
    if (st.approval.approvalUrl || st.approval.buyerApprovalVerified || st.state === "COMPLETED") return "authorized by the owner (DIAPORIA limit for this checkout)";
    return "not set";
  }

  function receiptView() {
    var r = snap.receipt; var pr = r.paymentResult || {};
    return el("div", null, [
      el("h2", { text: "Payment completed" }),
      el("div", { class: "box ok" }, [el("div", { class: "big", text: money(pr.amount && pr.amount.totalMinor, pr.amount && pr.amount.currency) }),
        el("div", { class: "muted", text: r.paymentStatusNote }),
        kv([["Status", "COMPLETED (verified by the payment backend)"], ["Environment", r.paymentEnvironment], ["Provider order", pr.providerOrderId || "—"], ["Capture", pr.captureId || "—"],
          ["Checkout", r.checkoutSessionId], ["Merchant order", "not verified"]])]),
      el("p", { class: "muted", text: r.purchaseOutcome && r.purchaseOutcome.statement }),
      el("details", null, [el("summary", { class: "muted", text: "Audit timeline (" + (r.auditTimeline || []).length + ")" }),
        el("ul", { class: "steps" }, (r.auditTimeline || []).map(function (e) { return el("li", null, [el("span", { class: "t", text: e.type }), el("span", { class: "d", text: e.at })]); }))]),
    ]);
  }

  // ---------------------------------------------------------------- boot
  if (!runId || !key) {
    setConn("down", "no link");
    app.replaceChildren(el("div", { class: "box" }, [el("h2", { text: "No DIAPORIA Buy session" }), el("p", { text: "Open the panel link your assistant gave you. Ask it to start a DIAPORIA Buy panel if you have none." })]));
    return;
  }
  api("").then(function (s) { snap = s; render(); }).catch(function (e) { if (e.status === 401) fatal(e.message); });
  connect();
})();
