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
    var out = [];
    rows.filter(Boolean).forEach(function (r) { out.push(el("dt", { text: r[0] }), el("dd", null, [typeof r[1] === "string" || typeof r[1] === "number" ? String(r[1]) : r[1]])); });
    return el("dl", { class: "kv" }, out);
  }
  function chip(text, cls) { return el("span", { class: "badge " + (cls || "neutral"), text: text }); }
  function safeUrl(u) { return typeof u === "string" && /^https?:\/\//.test(u) ? u : null; }
  function extLink(u, text) { var s = safeUrl(u); return s ? el("a", { href: s, target: "_blank", rel: "noopener noreferrer", text: text || s }) : el("span", { text: text || String(u || "") }); }
  function toast(msg) { toastEl.textContent = msg; toastEl.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(function () { toastEl.hidden = true; }, 7000); }
  function setConn(state, text) { conn.className = "conn " + state; conn.textContent = text; conn.title = "Connection: " + text; conn.setAttribute("aria-label", "Connection: " + text); }
  function statusChip(s) { return s === "ELIGIBLE" ? chip("Eligible", "ok") : s === "NEEDS_VERIFICATION" ? chip("Needs investigation", "warn") : chip("Not eligible", "bad"); }

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
    app.replaceChildren(note("bad", "!", "This panel link cannot be used", [el("p", { text: msg }),
      el("p", { class: "muted small", text: "Ask your assistant to open a new DIAPORIA Buy panel (start_shopping_panel or open_shopping_panel)." })]));
  }
  function note(kind, icon, title, kids) {
    return el("div", { class: "note " + kind, role: kind === "bad" ? "alert" : null }, [el("span", { class: "ni", "aria-hidden": "true", text: icon }),
      el("div", { class: "grow" }, [title ? el("b", { text: title }) : null].concat(kids || []))]);
  }

  // ---------------------------------------------------------------- views
  var FINAL = { FAILED: 1, CANCELLED: 1, EXPIRED: 1, REFUNDED: 1 };
  function render() {
    if (!snap) return;
    var sandbox = snap.paymentEnvironment === "PAYPAL_SANDBOX";
    envEl.hidden = false;
    envEl.className = "env " + (sandbox ? "sandbox" : "mock");
    envEl.textContent = sandbox ? "PayPal Sandbox · test funds" : "MOCK · no money moves";
    envEl.title = sandbox ? "PayPal Sandbox: test accounts, no real money" : "MOCK payment provider: nothing is charged";
    var parts = [];
    if (snap.session && !ui.detail) parts.push(el("div", { class: "request" }, [el("div", { class: "grow" }, [el("div", { class: "lbl", text: "Your request" }), el("div", { class: "q", text: snap.session.request })]),
      snap.session.budgetMinor ? el("span", { class: "badge neutral num", text: "Budget " + money(snap.session.budgetMinor, snap.session.currency) }) : null]));
    parts.push(stageTrack());
    if (snap.session && snap.session.expired && snap.view !== "RECEIPT") parts.push(note("warn", "!", "This purchase session has expired", [el("p", { class: "small", text: "Ask your assistant to research again to compare offers or buy." })]));
    if (ui.detail) parts.push(detailView());
    else if (snap.view === "PROGRESS") parts.push(progressView());
    else if (snap.view === "ERROR") parts.push(errorView());
    else if (snap.view === "RECEIPT") parts.push(receiptView());
    else if (snap.view === "CHECKOUT") parts.push(checkoutView());
    else if (snap.comparison) parts.push(compareView());
    else parts.push(resultsView());
    if (!ui.detail && snap.view !== "PROGRESS" && snap.progress && snap.progress.length) parts.push(el("details", { class: "disc section" }, [el("summary", null, [el("span", { text: "Research activity" }), el("span", { class: "muted small", text: snap.progress.length + " steps" })]), el("div", { class: "body" }, [activityList(false)])]));
    // Keep the reader's place on live updates; start at the top when the screen itself changes.
    var screen = (ui.detail ? "D" : snap.view) + (snap.comparison ? "+C" : "");
    var y = screen === ui.screen ? window.scrollY : 0; ui.screen = screen;
    app.replaceChildren.apply(app, parts);
    window.scrollTo(0, y);
  }

  // Six stages derived only from real server state: progress events from the research run, then the session records.
  function stages() {
    var ev = snap.progress || []; var has = function (step) { return ev.some(function (p) { return p.step === step; }); };
    var researching = snap.view === "PROGRESS", failed = snap.view === "ERROR";
    var researched = !researching && !failed;
    var st = snap.checkout && snap.checkout.status; var done = snap.view === "RECEIPT";
    var cmp = !!snap.comparison || !!st;
    var s = [
      { t: "Interpreting request", d: researching ? !!ev.length : !failed || !!ev.length },
      { t: "Finding candidates", d: researched || has("EVIDENCE"), a: researching && (has("SEARCH") || has("DETAILS")) && !has("EVIDENCE") },
      { t: "Verifying requirements", d: researched, a: researching && has("EVIDENCE") },
      { t: "Comparing verified offers", d: cmp, a: researched && !cmp && !!(snap.selection && snap.selection.productId) },
      { t: "Preparing checkout", d: !!st, a: false },
      { t: done ? "Payment confirmed" : "Awaiting authorization", d: done, a: !!st && !done && !FINAL[st.state] },
    ];
    if (researching && !ev.length) s[0].a = true;
    if (failed) { var i = s.findIndex(function (x) { return !x.d; }); if (i >= 0) s[i].f = true; }
    if (st && FINAL[st.state]) s[5].f = true;
    return s;
  }
  function stageTrack() {
    var s = stages(); var cur = s.find(function (x) { return x.f; }) || s.find(function (x) { return x.a; }) || s.find(function (x) { return !x.d; }) || s[s.length - 1];
    var n = s.filter(function (x) { return x.d; }).length;
    return el("div", { class: "track", role: "group", "aria-label": "Purchase progress" }, [
      el("div", { class: "head" }, [el("b", { text: cur.t === "Comparing verified offers" && !cur.a && !cur.d ? "Next: select a product to compare offers" : cur.t }), el("span", { class: "num", text: "Step " + Math.min(n + (cur.d ? 0 : 1), 6) + " of 6" })]),
      el("div", { class: "bars", "aria-hidden": "true" }, s.map(function (x) { return el("span", { class: x.f ? "fail" : x.d ? "done" : x.a ? "active" : "" }); })),
    ]);
  }
  function stepIcon(x) { return el("span", { class: "ico " + (x.f ? "fail" : x.d ? "done" : x.a ? "active" : ""), "aria-hidden": "true", text: x.f ? "!" : x.d ? "✓" : "" }); }
  function activityList(running) {
    var list = snap.progress || [];
    return el("ul", { class: "steps" }, list.map(function (p, i) {
      var last = i === list.length - 1;
      return el("li", null, [stepIcon({ d: !(last && running), a: last && running }), el("div", null, [el("div", { class: "t small", text: p.label }), p.detail ? el("div", { class: "s", text: p.detail }) : null])]);
    }));
  }
  function progressView() {
    var s = stages().slice(0, 3);
    var ev = snap.progress || [];
    var lastEv = ev[ev.length - 1];
    return el("div", { class: "card" }, [
      el("h2", { text: "Researching products" }),
      el("p", { class: "muted small", text: "Searching, reading product details and checking evidence. This view updates live." }),
      el("ul", { class: "steps" }, s.map(function (x) {
        return el("li", { class: !x.d && !x.a ? "pending" : null }, [stepIcon(x), el("div", null, [el("div", { class: "t", text: x.t }),
          x.a && lastEv ? el("div", { class: "s", text: lastEv.label + (lastEv.detail ? " · " + lastEv.detail : "") }) : null])]);
      })),
      ev.length ? el("details", { class: "plain" }, [el("summary", { text: "Show all activity (" + ev.length + ")" }), activityList(true)]) : null,
      el("div", { class: "stack section" }, [el("div", { class: "skeleton" }), el("div", { class: "skeleton" })]),
    ]);
  }
  function errorView() {
    var e = snap.error || { code: "UNKNOWN", message: "Research did not finish." };
    return note("bad", "!", snap.runState === "INTERRUPTED" ? "Research was interrupted" : "Research could not finish", [el("p", { class: "small", text: e.message }),
      el("p", { class: "muted tiny", text: e.code + (snap.runState === "INTERRUPTED" ? " · the server restarted while research was running; ask your assistant to start a new panel." : "") })]);
  }

  // ---------------------------------------------------------------- results
  function monogram(c) {
    var id = c.identity || {}; var src = String(id.brand || c.title || "?").trim();
    var m = String(id.model || "").replace(/[^A-Za-z0-9]/g, "");
    var t = (src.charAt(0) + (m.charAt(0) || src.charAt(1) || "")).toUpperCase();
    // No product images exist in the catalog data: a labelled monogram, never a stock or generated picture.
    return el("div", { class: "thumb" + (c.lg ? " lg" : ""), role: "img", "aria-label": "No product image available", title: "No product image available", text: t });
  }
  function reqChip(r) {
    var ok = r.status === "VERIFIED_TRUE", no = r.status === "VERIFIED_FALSE" || r.status === "CONTRADICTED";
    return el("span", { class: "req " + (ok ? "ok" : no ? "no" : "open"), title: r.label + ": " + statusText(r.status) }, [el("i", { "aria-hidden": "true", text: ok ? "✓" : no ? "×" : "?" }),
      el("span", { text: r.label }), el("span", { class: "sr", text: " — " + statusText(r.status) })]);
  }
  function statusText(s) {
    return { VERIFIED_TRUE: "verified", VERIFIED_FALSE: "does not meet", CONTRADICTED: "contradicted by evidence", UNVERIFIED: "not verified", UNKNOWN: "not verified", INSUFFICIENT: "insufficient evidence" }[s] || String(s || "").replace(/_/g, " ").toLowerCase();
  }
  function bestVerified() { var c = snap.comparison; return c && c.state === "OFFER_VERIFIED" && c.lowestVerifiedEligibleOffer ? c.lowestVerifiedEligibleOffer : null; }
  function priceBlock(c, selected) {
    var best = selected ? bestVerified() : null;
    if (best && best.cost && best.cost.totalMinor !== null && best.cost.totalMinor !== undefined) {
      var complete = !(best.cost.unknownComponents || []).length;
      return el("div", { class: "price" }, [el("span", { class: "amt num", text: money(best.cost.totalMinor, best.cost.currency) }),
        el("span", { class: "ptag ver", text: complete ? "Merchant-verified total · incl. shipping & tax" : "Merchant-verified, some costs unknown" })]);
    }
    var lp = c.listingPrice || {};
    if (lp.lowestListingMinor === null || lp.lowestListingMinor === undefined) return el("div", { class: "price" }, [el("span", { class: "amt unverified", text: "Price unknown" }), el("span", { class: "ptag", text: "no listing price found" })]);
    return el("div", { class: "price" }, [el("span", { class: "amt unverified num", text: money(lp.lowestListingMinor, lp.currency) }),
      el("span", { class: "ptag unv", title: "Search-time listing price. Not a checkout total: shipping, tax and the merchant are verified at comparison.", text: "Listing price" + (lp.merchantDomain ? " · " + lp.merchantDomain + " (unverified)" : " · unverified") })]);
  }
  function productCard(c, i, sel) {
    var isSel = sel === c.productId; var id = c.identity || {};
    var reqs = (c.requirements || []).slice(0, 6);
    return el("article", { class: "pcard" + (isSel ? " sel" : i === 0 && c.status === "ELIGIBLE" ? " top" : ""), "data-pid": c.productId, "aria-label": c.title }, [
      monogram(c),
      el("div", { class: "grow" }, [
        el("div", { class: "between" }, [el("div", { class: "grow" }, [id.brand ? el("div", { class: "pbrand", text: id.brand }) : null, el("div", { class: "ptitle", text: id.model ? id.model + (id.variant ? " · " + id.variant : "") : c.title })]),
          el("div", { class: "row", style: null }, [c.recommended ? chip("Recommended", "rec") : null])]),
        el("div", { class: "row", style: null }, [statusChip(c.status), isSel ? chip("Selected", "ok") : null, c.rank ? el("span", { class: "tiny muted", text: "Rank #" + c.rank }) : null]),
        priceBlock(c, isSel),
        reqs.length ? el("div", { class: "reqs", "aria-label": "Requirements" }, reqs.map(reqChip)) : null,
        c.reason ? el("p", { class: "reason", text: c.reason }) : null,
        el("div", { class: "actions" }, [
          el("button", { class: "btn sec", type: "button", onclick: function () { openDetail(c.productId); }, text: "Details" }),
          isSel ? null : el("button", { class: "btn", type: "button", disabled: ui.busy || lockedOther(c.productId) || (snap.session && snap.session.expired), onclick: function () { act("/select", { productId: c.productId }); }, text: lockedOther(c.productId) ? "Locked" : "Select" }),
        ]),
      ]),
    ]);
  }
  function lockedOther(pid) { return !!(snap.session && snap.session.lockedProductId && snap.session.lockedProductId !== pid && snap.comparison); }
  function resultsView() {
    var s = snap.session || {};
    var sel = snap.selection && snap.selection.productId;
    var n = snap.candidates.length;
    var kids = [el("div", { class: "between" }, [el("h1", { text: n ? (n === 1 ? "1 matching product" : "Top " + n + " matching products") : "No product could be recommended" }),
      s.decisionState ? el("span", { class: "badge neutral", title: "Decision engine state", text: decisionText(s.decisionState) }) : null])];
    if (n) kids.push(el("p", { class: "muted small", text: "Ranked by DIAPORIA's decision engine. Prices here are search-time listings; verified totals appear after you compare offers." }));
    if (!n && s.holdReasons && s.holdReasons.length) kids.push(note("warn", "!", "Why nothing is shown", [el("ul", null, s.holdReasons.map(function (h) { return el("li", { class: "small", text: h }); }))]));
    kids.push(el("div", { class: "stack section" }, snap.candidates.map(function (c, i) { return productCard(c, i, sel); })));
    if (sel) kids.push(compareForm());
    return el("div", null, kids);
  }
  function decisionText(d) { return { RECOMMEND: "Recommendation ready", HOLD: "On hold", INVESTIGATE: "Needs investigation", NO_MATCH: "No match" }[d] || String(d).replace(/_/g, " ").toLowerCase(); }

  function compareForm() {
    var c = el("input", { id: "dc", name: "country", value: ui.dest.country, maxlength: "2", autocomplete: "off", inputmode: "text", spellcheck: "false" });
    var r = el("input", { id: "dr", name: "region", value: ui.dest.region, maxlength: "10", autocomplete: "off", spellcheck: "false" });
    var p = snap.candidates.find(function (x) { return x.productId === snap.selection.productId; });
    return el("section", { class: "card section", "aria-labelledby": "cmp-h" }, [
      el("h2", { id: "cmp-h", text: "Compare verified offers" }),
      el("p", { class: "muted small", text: "DIAPORIA asks each merchant for a fresh quote for " + (p ? p.title : "the selected product") + ". Tax depends on where it ships." }),
      el("form", { class: "dest", onsubmit: function (ev) { ev.preventDefault(); ui.dest = { country: c.value.trim().toUpperCase(), region: r.value.trim().toUpperCase() };
        act("/compare", { destination: { country: ui.dest.country, region: ui.dest.region || undefined } }); } }, [
        el("label", { for: "dc" }, ["Ship to country", c]), el("label", { for: "dr" }, ["Region", r]),
        el("button", { class: "btn", type: "submit", disabled: ui.busy || (snap.session && snap.session.expired), text: ui.busy ? "Requesting quotes…" : "Compare offers" }),
      ]),
    ]);
  }

  // ---------------------------------------------------------------- detail
  function evidenceItems(d, cap) {
    var e = (d.evidence || []).find(function (x) { return x.capability === cap; });
    return e ? e.items || [] : [];
  }
  function detailView() {
    var d = ui.detailData;
    var back = el("button", { class: "btn ghost back", type: "button", text: "← Back", onclick: function () { ui.detail = null; ui.detailData = null; render(); } });
    if (!d) return el("div", null, [back, el("div", { class: "skeleton" })]);
    var sel = snap.selection && snap.selection.productId === d.productId;
    var id = d.identity || {};
    var kids = [back, el("div", { class: "hero" }, [monogram({ identity: id, title: d.title, lg: true }), el("div", { class: "grow" }, [
      id.brand ? el("div", { class: "pbrand", text: id.brand }) : null, el("h1", { text: d.title }),
      el("div", { class: "row", style: null }, [statusChip(d.status), d.rank ? el("span", { class: "tiny muted", text: "Rank #" + d.rank }) : null, sel ? chip("Selected", "ok") : null])])])];
    var lp = d.listingPrice || {};
    kids.push(priceBlock({ listingPrice: { lowestListingMinor: lp.lowestListingMinor, currency: lp.currency, merchantDomain: lp.merchantDomain } }, sel));
    if (d.whySelected && d.whySelected.length) kids.push(el("h3", { text: "Why it matches" }), el("ul", { class: "small", style: null }, d.whySelected.slice(0, 4).map(function (w) { return el("li", { text: w }); })));

    var rows = d.validated || [];
    var groups = [["Verified", rows.filter(function (v) { return v.status === "VERIFIED_TRUE"; }), "ok"],
      ["Not yet verified", rows.filter(function (v) { return v.status !== "VERIFIED_TRUE" && v.status !== "VERIFIED_FALSE" && v.status !== "CONTRADICTED"; }), "open"],
      ["Failed", rows.filter(function (v) { return v.status === "VERIFIED_FALSE" || v.status === "CONTRADICTED"; }), "no"]];
    kids.push(el("h3", { text: "Requirements & evidence" }));
    if (!rows.length) kids.push(el("p", { class: "muted small", text: "No stated requirements." }));
    groups.forEach(function (g) {
      if (!g[1].length) return;
      kids.push(el("div", { class: "tiny muted", style: null, text: g[0] + " (" + g[1].length + ")" }));
      g[1].forEach(function (v) {
        var items = evidenceItems(d, v.capability);
        var counted = items.filter(function (it) { return it.counts; }).length;
        kids.push(el("details", { class: "disc" }, [
          el("summary", null, [el("span", { class: "req " + g[2] }, [el("i", { "aria-hidden": "true", text: g[2] === "ok" ? "✓" : g[2] === "no" ? "×" : "?" }), el("span", { text: v.label || v.capability })]),
            v.strength === "MUST" ? el("span", { class: "tiny muted", text: "must-have" }) : el("span", { class: "tiny muted", text: "nice-to-have" }),
            el("span", { class: "tiny muted", style: null, text: items.length ? counted + "/" + items.length + " sources" : "" })]),
          el("div", { class: "body" }, items.length ? items.map(function (it) {
            return el("div", { class: "ev" }, [el("div", { class: "src" }, [extLink(it.url, hostOf(it.url) || it.sourceClass), " · " + (it.sourceClass || "source") + " · " + (it.counts ? "counted" : "not counted")]),
              it.quote ? el("q", { text: it.quote }) : null, it.whyNotCounted ? el("div", { class: "tiny muted", text: it.whyNotCounted }) : null]);
          }) : [el("p", { class: "muted small", text: statusText(v.status) + ": no attributable source was found." + (v.satisfiedBy ? " Satisfied by: " + v.satisfiedBy : "") })]),
        ]));
      });
    });

    var unresolved = [].concat((d.blockers || []).map(function (b) { return b.detail; }), d.unresolved || []).filter(function (x, i, a) { return x && a.indexOf(x) === i; });
    if (unresolved.length || (d.disqualifiers || []).length) kids.push(el("div", { class: "section" }, [note("warn", "!", "Before this can be bought", [el("ul", null, unresolved.concat((d.disqualifiers || []).map(function (x) { return x.detail || String(x); })).map(function (u) { return el("li", { class: "small", text: u }); }))])]));
    else if (d.purchaseReady) kids.push(el("div", { class: "section" }, [note("ok", "✓", "No open conditions", [el("p", { class: "small", text: "Purchase-ready once a merchant-verified total exists." })])]));
    if (d.verifyBeforePurchase && d.verifyBeforePurchase.length) kids.push(el("p", { class: "muted small", text: "Verify before purchase: " + d.verifyBeforePurchase.join("; ") }));

    kids.push(el("h3", { text: "Product identity" }), kv([["Brand", id.brand || "—"], ["Model", id.model || "—"], ["Variant", id.variant || "—"], ["Condition", id.condition || "—"], id.sku ? ["SKU", id.sku] : null, id.gtin ? ["GTIN", id.gtin] : null]));
    kids.push(el("h3", { text: "Merchant" }));
    if (d.merchants && d.merchants.source === "VERIFIED_COMPARISON") kids.push(el("p", { class: "small", text: d.merchants.offers.length + " merchant offer" + (d.merchants.offers.length === 1 ? " was" : "s were") + " compared with fresh quotes." }));
    else kids.push(kv([["Search-time merchant", (d.merchants && d.merchants.merchantDomain) || lp.merchantDomain || "—"], ["Trust status", "Not yet verified (checked when you compare offers)"]]));
    if (d.untrustedListingText && d.untrustedListingText.length) {
      kids.push(el("details", { class: "plain section" }, [el("summary", { text: "Merchant listing text (untrusted, " + d.untrustedListingText.length + ")" })].concat(d.untrustedListingText.map(function (u) {
        return el("div", null, [el("div", { class: "untrusted", text: u.text }), u.flags && u.flags.length ? el("div", { class: "tiny muted", text: "Flagged: " + u.flags.join(", ") + ". Shown as text, never followed." }) : null]);
      }))));
    }
    var locked = lockedOther(d.productId);
    kids.push(el("div", { class: "sticky" }, [sel ? el("button", { class: "btn block sec", type: "button", text: "Selected · back to offers", onclick: function () { ui.detail = null; render(); } })
      : el("button", { class: "btn block lg", type: "button", disabled: ui.busy || d.status === "NOT_ELIGIBLE" || locked || (snap.session && snap.session.expired), text: locked ? "Another product is locked for this purchase" : d.status === "NOT_ELIGIBLE" ? "Not eligible" : "Select this product",
        onclick: function () { act("/select", { productId: d.productId }); } })]));
    return el("div", { class: "card" }, kids);
  }
  function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ""); } catch (e) { return null; } }

  // ---------------------------------------------------------------- offers
  function costLines(cost) {
    if (!cost) return el("div", { class: "lines" }, [el("div", { class: "line unknown total" }, [el("span", { text: "Total" }), el("span", { class: "v", text: "Unknown" })])]);
    var cur = cost.currency; var unk = cost.unknownComponents || [];
    function line(lbl, v, key) {
      var u = v === null || v === undefined || unk.indexOf(key) >= 0;
      return el("div", { class: "line" + (u ? " unknown" : "") }, [el("span", { text: lbl }), el("span", { class: "v", text: u ? "Unknown" : money(v, cur) })]);
    }
    return el("div", { class: "lines" }, [line("Item", cost.itemMinor, "item"), line("Shipping", cost.shippingMinor, "shipping"), line("Tax", cost.taxMinor, "tax"), line("Fees", cost.feesMinor, "fees"),
      cost.discountMinor ? el("div", { class: "line" }, [el("span", { text: "Discount" }), el("span", { class: "v", text: "−" + money(Math.abs(cost.discountMinor), cur) })]) : null,
      el("div", { class: "line total" }, [el("span", { text: unk.length ? "Total (incomplete)" : "Verified total" }), el("span", { class: "v", text: money(cost.totalMinor, cur) })]),
      unk.length ? el("p", { class: "tiny muted", text: "Unknown is not zero: " + unk.join(", ") + " could not be verified." }) : null]);
  }
  function compareView() {
    var c = snap.comparison;
    var best = bestVerified();
    var offers = (c.eligibleOffers || []).slice().sort(function (a, b) { return (a.cost && a.cost.totalMinor != null ? a.cost.totalMinor : Infinity) - (b.cost && b.cost.totalMinor != null ? b.cost.totalMinor : Infinity); });
    var primary = best ? offers.find(function (o) { return o.offerId === best.offerId; }) : null;
    var p = snap.candidates.find(function (x) { return snap.selection && x.productId === snap.selection.productId; });
    var dest = c.destinationUsed ? c.destinationUsed.country + (c.destinationUsed.region ? "-" + c.destinationUsed.region : "") : null;
    var kids = [el("button", { class: "btn ghost back", type: "button", text: "← Products", onclick: function () { snap.comparison = null; render(); } }),
      el("div", { class: "between" }, [el("h1", { text: "Verified offers" }), dest ? el("span", { class: "badge neutral", text: "Ship to " + dest }) : null])];
    if (p) kids.push(el("div", { class: "row section", style: null }, [monogram(p), el("div", { class: "grow" }, [p.identity && p.identity.brand ? el("div", { class: "pbrand", text: p.identity.brand }) : null, el("div", { class: "ptitle", text: p.title })])]));
    var open = [].concat(c.holdReasons || []).filter(function (x, i, a) { return a.indexOf(x) === i; });
    if (c.state !== "OFFER_VERIFIED" || open.length) kids.push(el("div", { class: "section" }, [note("warn", "!", c.state === "HOLD" || open.length ? "On hold: not ready for checkout" : "No verified offer yet", [
      open.length ? el("ul", null, open.map(function (h) { return el("li", { class: "small", text: h }); })) : null,
      el("p", { class: "tiny muted", text: "Open requirements are resolved only by the owner on the owner page. Your assistant can propose a resolution." })])]));
    if (primary) {
      kids.push(el("section", { class: "offer best section", "aria-label": "Lowest verified offer" }, [
        el("div", { class: "between" }, [el("div", { class: "grow" }, [el("div", { class: "mname", text: primary.merchantName }), primary.merchantDomain !== primary.merchantName ? el("div", { class: "mdom", text: primary.merchantDomain }) : null]), chip("Lowest verified total", "ok")]),
        merchantTrust(primary), costLines(primary.cost),
        el("div", { class: "section" }, [prepareButton(primary, c)]),
        el("p", { class: "tiny muted", style: null, text: primary.checkoutPath === "EXTERNAL_MERCHANT_CHECKOUT" ? "Completes on the merchant's own site." : "Preparing a checkout does not pay. The owner sets a spending limit and confirms on the owner page; payment approval follows." }),
      ]));
    }
    var rest = offers.filter(function (o) { return !primary || o.offerId !== primary.offerId; });
    if (rest.length) kids.push(el("h3", { text: "Other verified offers" }), el("div", { class: "card" }, rest.map(function (o) {
      return el("details", { class: "plain" }, [el("summary", null, [el("span", { text: o.merchantName + " · " }), el("b", { class: "num", text: money(o.cost && o.cost.totalMinor, o.cost && o.cost.currency) })]), merchantTrust(o), costLines(o.cost), el("div", { class: "section" }, [prepareButton(o, c, true)])]);
    })));
    if ((c.ineligibleOffers || []).length) kids.push(el("h3", { text: "Rejected merchants (" + c.ineligibleOffers.length + ")" }), el("div", { class: "card" }, c.ineligibleOffers.map(function (o) {
      return el("div", { class: "excl" }, [el("div", { class: "row", style: null }, [el("b", { text: o.merchantName }), el("span", { class: "mdom", text: o.merchantDomain })]),
        el("ul", { class: "small muted", style: null }, (o.issues || ["Rejected by verification"]).map(function (x) { return el("li", { text: humanIssue(x) }); }))]);
    })));
    kids.push(el("details", { class: "plain section" }, [el("summary", { text: "Compare again with another destination" }), compareForm()]));
    return el("div", null, kids);
  }
  function merchantTrust(o) {
    var mi = o.merchantIdentity; var v = mi && String(mi.overall || "");
    var c = v === "MATCH" ? chip("Merchant identity verified", "ok") : v === "MISMATCH" ? chip("Merchant identity mismatch", "bad") : v ? chip("Merchant identity unknown", "warn") : chip("Merchant identity not checked", "neutral");
    return el("div", { class: "row" }, [c]);
  }
  function humanIssue(x) { var s = String(x).replace(/^[A-Z_]{4,}:\s*/, ""); return s.charAt(0).toUpperCase() + s.slice(1); }
  function prepareButton(o, c, secondary) {
    if (c.state !== "OFFER_VERIFIED" || !o.eligible) return el("button", { class: "btn block lg", type: "button", disabled: true, text: "Checkout unavailable while on hold" });
    if (!snap.capabilities.prepare) return note("info", "i", null, [el("p", { class: "small", text: "Ask your assistant to prepare this checkout. This panel link can compare offers but not prepare checkouts." })]);
    return el("button", { class: "btn block" + (secondary ? " sec" : " lg"), type: "button", disabled: ui.busy || (snap.session && snap.session.expired), text: ui.busy ? "Preparing…" : "Continue to checkout · " + money(o.cost && o.cost.totalMinor, o.cost && o.cost.currency),
      onclick: function () { act("/prepare", { offerId: o.offerId }); } });
  }

  // ---------------------------------------------------------------- checkout + receipt
  function checkoutView() {
    var ck = snap.checkout; var st = ck.status; var h = ck.handoff;
    if (!st) return note("warn", "!", "No DIAPORIA checkout was created", []);
    var fin = FINAL[st.state];
    var ownerDone = !!(st.approval.approvalUrl || st.approval.buyerApprovalVerified || st.state === "COMPLETED");
    var buyerDone = !!(st.approval.buyerApprovalVerified || st.state === "COMPLETED");
    var tl = [
      { t: "Checkout prepared", s: "Merchant-verified total locked for this product and merchant.", d: true },
      { t: "Owner sets limit and confirms", s: "On the owner page, with the owner key.", d: ownerDone, a: !fin && h && h.kind === "OWNER_AUTHORIZATION" },
      { t: "Payment approval", s: snap.paymentEnvironment === "PAYPAL_SANDBOX" ? "PayPal Sandbox approval (test account)." : "MOCK buyer step (stands in for PayPal login).", d: buyerDone, a: !fin && h && h.kind === "BUYER_PAYMENT_APPROVAL" },
      { t: "Payment confirmed by the backend", s: "The receipt appears only after this.", d: st.state === "COMPLETED", a: !fin && buyerDone && st.state !== "COMPLETED" },
    ];
    if (fin) { var i = tl.findIndex(function (x) { return !x.d; }); if (i >= 0) tl[i].f = true; }
    var who = st.productIdentity ? [st.productIdentity.brand, st.productIdentity.model].filter(Boolean).join(" ") : "the product";
    var merchant = st.merchantIdentity ? String(st.merchantIdentity.verifiedLegalName || st.merchantIdentity.merchantName || "verified merchant") : "—";
    var kids = [el("div", { class: "between" }, [el("h1", { text: fin ? "Checkout " + st.state.toLowerCase() : h ? "Approval required" : "Confirming payment" }), chip(st.state.replace(/_/g, " ").toLowerCase(), fin ? "bad" : st.state === "COMPLETED" ? "ok" : "warn")]),
      el("div", { class: "card section" }, [el("div", { class: "big", text: money(st.amount.totalMinor, st.amount.currency) }),
        el("div", { class: "muted small", text: "Merchant-verified total · " + who + " · qty " + st.quantity }),
        el("div", { class: "tiny muted", text: merchant }),
        el("ul", { class: "timeline" }, tl.map(function (x) { return el("li", { class: !x.d && !x.a && !x.f ? "pending" : null }, [stepIcon(x), el("div", null, [el("div", { class: "t", text: x.t }), el("div", { class: "s", text: x.s })])]); })),
      ])];
    if (st.failure || st.uncertainty) kids.push(el("div", { class: "section" }, [note(fin ? "bad" : "warn", "!", fin ? "This checkout ended" : "Note", [st.failure ? el("p", { class: "small", text: humanIssue(st.failure.reason) + " (" + st.failure.code + ")" }) : null, st.uncertainty ? el("p", { class: "small", text: st.uncertainty }) : null])]));
    else if (fin) kids.push(el("div", { class: "section" }, [note("bad", "!", "This checkout ended: " + st.state.toLowerCase(), [el("p", { class: "small", text: "Nothing was charged by this panel. You can return to the offers for fresh quotes." })])]));
    if (h) {
      kids.push(el("div", { class: "section" }, [
        // Same tab on purpose: the host's browser panel keeps the flow beside the conversation; /buy/ resumes this panel afterwards.
        el("a", { class: "btn block lg", href: h.url, rel: "noopener noreferrer", target: h.kind === "EXTERNAL_MERCHANT_CHECKOUT" ? "_blank" : "_self", text: h.kind === "OWNER_AUTHORIZATION" ? "Open owner approval" : h.kind === "BUYER_PAYMENT_APPROVAL" ? "Open payment approval" : "Open merchant checkout" }),
        el("p", { class: "tiny muted", text: h.who + " This panel only links to the approval step and updates by itself when the server verifies the result." })]));
    } else if (!fin && st.state !== "COMPLETED") kids.push(el("p", { class: "muted small section", text: "Waiting for the payment backend to verify the result…" }));
    if ({ CANCELLED: 1, FAILED: 1, EXPIRED: 1 }[st.state]) kids.push(el("button", { class: "btn block sec section", type: "button", disabled: ui.busy, text: "Back to offers (fresh quotes)", onclick: function () { act("/reset", {}); } }));
    kids.push(el("details", { class: "plain section" }, [el("summary", { text: "Checkout details" }), kv([["Spending limit", spendingLimitText(st)], ["Buyer approval", st.approval.buyerApprovalVerified ? "verified" : st.approval.required ? "required" : "not yet"],
      ["Payment status", st.paymentStatus], ["Environment", snap.paymentEnvironment === "PAYPAL_SANDBOX" ? "PayPal Sandbox (test funds)" : "MOCK (no money moves)"], ["Expires", st.expiresAt]])]));
    if (st.purchaseOutcome) kids.push(el("p", { class: "tiny muted", text: st.purchaseOutcome.statement }));
    return el("div", null, kids);
  }
  function spendingLimitText(st) {
    if (st.state === "APPROVAL_REQUIRED" && !st.approval.approvalUrl) return "Not set: the owner sets it on the owner page";
    if (st.approval.approvalUrl || st.approval.buyerApprovalVerified || st.state === "COMPLETED") return "Authorized by the owner for this checkout";
    return "Not set";
  }
  function receiptView() {
    var r = snap.receipt; var pr = r.paymentResult || {};
    var sandbox = r.paymentEnvironment === "PAYPAL_SANDBOX";
    return el("div", null, [
      el("div", { class: "card" }, [
        el("div", { class: "hero" }, [el("span", { class: "okmark", "aria-hidden": "true", text: "✓" }), el("div", { class: "grow" }, [el("h1", { text: "Payment completed" }),
          el("div", { class: "small muted", text: "Verified by the payment backend · " + (sandbox ? "PayPal Sandbox (test funds)" : "MOCK: no real money moved") })])]),
        el("div", { class: "big section", text: money(pr.amount && pr.amount.totalMinor, pr.amount && pr.amount.currency) }),
        r.paymentStatusNote ? el("p", { class: "small muted", text: r.paymentStatusNote }) : null,
        kv([["Status", "COMPLETED"], ["Environment", sandbox ? "PayPal Sandbox" : "MOCK"], ["Provider order", pr.providerOrderId || "—"], ["Capture", pr.captureId || "—"], ["Checkout", r.checkoutSessionId], ["Merchant order", "Not verified"]]),
      ]),
      r.purchaseOutcome ? el("p", { class: "tiny muted section", text: r.purchaseOutcome.statement }) : null,
      el("details", { class: "disc section" }, [el("summary", null, [el("span", { text: "Audit timeline" }), el("span", { class: "muted small", text: String((r.auditTimeline || []).length) })]),
        el("div", { class: "body" }, [el("ul", { class: "steps" }, (r.auditTimeline || []).map(function (e) { return el("li", null, [stepIcon({ d: true }), el("div", null, [el("div", { class: "t small", text: String(e.type).replace(/_/g, " ").toLowerCase() }), el("div", { class: "s num", text: e.at })])]); }))])]),
    ]);
  }

  // ---------------------------------------------------------------- boot
  if (!runId || !key) {
    setConn("down", "no link");
    app.replaceChildren(note("info", "i", "No DIAPORIA Buy session", [el("p", { class: "small", text: "Open the panel link your assistant gave you, or ask it to start a DIAPORIA Buy panel." })]));
    return;
  }
  api("").then(function (s) { snap = s; render(); }).catch(function (e) { if (e.status === 401) fatal(e.message); });
  connect();
})();
