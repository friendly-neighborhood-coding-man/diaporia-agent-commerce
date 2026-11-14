// DIAPORIA Phase C test merchant: merchant-owned checkout button. Loaded from the merchant origin only.
// MOCK: opens the merchant's own MOCK popup (not PayPal). SANDBOX: PayPal JavaScript SDK v6 (Sandbox) one-time payment.
// The browser never sends a price: only the cart reference, the CSRF token and PayPal's order id.
(function () {
  "use strict";
  var cart = document.getElementById("cart");
  if (!cart) return;
  var ref = cart.getAttribute("data-cart-ref");
  var csrf = cart.getAttribute("data-csrf");
  var mode = cart.getAttribute("data-mode");
  var statusEl = document.getElementById("pay-status");
  function say(t) { if (statusEl) statusEl.textContent = t; }
  function post(path, body) {
    return fetch(path, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.error || "HTTP " + r.status); return j; }); });
  }
  function report(code) { post("/api/checkout/sdk-event", { cartRef: ref, csrf: csrf, code: code }).catch(function () {}); }
  function createOrder() { return post("/api/checkout/orders", { cartRef: ref, csrf: csrf }).then(function (j) { return { orderId: j.orderId }; }); }
  function approved(orderId) {
    say("The browser received an approval. Asking the merchant server to verify it with PayPal...");
    return post("/api/checkout/orders/approve", { cartRef: ref, csrf: csrf, orderId: orderId })
      .catch(function () { /* the return page shows the server-side state either way */ })
      .then(function () { location.href = "/order/return?cart=" + encodeURIComponent(ref); });
  }
  function cancelled(orderId) {
    if (orderId) post("/api/checkout/orders/cancel", { cartRef: ref, csrf: csrf, orderId: orderId }).catch(function () {});
    say("Payment window closed or cancelled. Payment status unverified: the merchant server checks it with PayPal.");
  }

  if (mode === "MOCK") {
    var btn = document.getElementById("paypal-button");
    window.addEventListener("message", function (ev) {
      if (ev.origin !== location.origin || !ev.data || ev.data.src !== "phc-mock-paypal") return;
      if (ev.data.type === "approved") approved(ev.data.orderId);
      else if (ev.data.type === "cancelled") cancelled(ev.data.orderId);
    });
    btn.addEventListener("click", function () {
      // Open synchronously inside the click so popup blockers allow it, then point it at the MOCK approval page.
      var w = window.open("about:blank", "phcmockpaypal", "popup,width=480,height=640");
      if (!w) { say("Popup blocked"); return; }
      createOrder().then(function (o) { w.location.href = "/mock-paypal/checkout?order=" + encodeURIComponent(o.orderId); })
        .catch(function (e) { w.close(); say("Could not start checkout: " + e.message); });
    });
    say("MOCK checkout ready (not PayPal)");
    return;
  }

  // ---------------- PayPal JS SDK v6, Sandbox ----------------
  var sdkUrl = cart.getAttribute("data-sdk-url");
  if (sdkUrl !== "https://www.sandbox.paypal.com/web-sdk/v6/core") { say("SDK_URL_REFUSED"); return; }
  // Payment-surface evidence (review item 5). presentationMode "auto" may pick a popup, a modal/overlay or a redirect.
  // These are browser-side OBSERVATIONS for the operator's evidence; the human still records what they saw.
  // A popup PASS needs SURFACE_POPUP_OPENED here AND the human's note that PayPal opened in a separate window.
  var surfaceSeen = {};
  function surface(code) { if (surfaceSeen[code]) return; surfaceSeen[code] = true; report(code); }
  var nativeOpen = window.open;
  window.open = function () {
    var w = nativeOpen.apply(window, arguments);
    surface(w ? "SURFACE_POPUP_OPENED" : "SURFACE_POPUP_BLOCKED");
    return w;
  };
  try {
    new MutationObserver(function (records) {
      records.forEach(function (r) {
        Array.prototype.forEach.call(r.addedNodes, function (n) {
          var frames = n.tagName === "IFRAME" ? [n] : n.querySelectorAll ? n.querySelectorAll("iframe") : [];
          Array.prototype.forEach.call(frames, function () { surface("SURFACE_IFRAME_ADDED"); });
        });
      });
    }).observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) { /* observation only */ }
  var started = false;
  window.addEventListener("pagehide", function () {
    if (started) fetch("/api/checkout/sdk-event", { method: "POST", keepalive: true, credentials: "same-origin", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cartRef: ref, csrf: csrf, code: "SURFACE_PAGE_LEFT" }) }).catch(function () {});
  });

  function init() {
    fetch("/api/checkout/config", { credentials: "same-origin" }).then(function (r) { return r.json(); }).then(function (cfg) {
      return window.paypal.createInstance({ clientId: cfg.clientId, components: ["paypal-payments"], pageType: "checkout" });
    }).then(function (sdk) {
      return sdk.findEligibleMethods({ currencyCode: "USD" }).then(function (methods) {
        if (!methods.isEligible("paypal")) { say("PAYPAL_NOT_ELIGIBLE"); report("PAYPAL_NOT_ELIGIBLE"); return; }
        var session = sdk.createPayPalOneTimePaymentSession({
          onApprove: function (data) { return approved(data && data.orderId); },
          onCancel: function (data) { cancelled(data && data.orderId); },
          onError: function () { say("PayPal reported an error. Payment status unverified: the merchant server checks it with PayPal."); report("SDK_ON_ERROR"); },
        });
        var button = document.getElementById("paypal-button");
        button.removeAttribute("hidden");
        button.addEventListener("click", function () {
          // Do not await before start(): keeps the browser's transient user activation for the popup.
          var orderPromise = createOrder();
          started = true; report("SESSION_START_CALLED");
          session.start({ presentationMode: "auto" }, orderPromise).catch(function () { say("PayPal button failure"); report("SESSION_START_FAILED"); });
        });
        say("PayPal Sandbox ready");
      });
    }).catch(function () { say("PAYPAL_SDK_INIT_FAILED"); report("SDK_INIT_FAILED"); });
  }
  var s = document.createElement("script");
  s.src = sdkUrl; s.async = true;
  s.onload = init;
  s.onerror = function () { say("PAYPAL_SDK_LOAD_FAILED"); report("SDK_LOAD_FAILED"); };
  document.head.appendChild(s);
})();
