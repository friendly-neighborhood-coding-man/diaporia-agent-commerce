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
    say("Payment window closed or cancelled. Nothing was captured.");
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
  function init() {
    fetch("/api/checkout/config", { credentials: "same-origin" }).then(function (r) { return r.json(); }).then(function (cfg) {
      return window.paypal.createInstance({ clientId: cfg.clientId, components: ["paypal-payments"], pageType: "checkout" });
    }).then(function (sdk) {
      return sdk.findEligibleMethods({ currencyCode: "USD" }).then(function (methods) {
        if (!methods.isEligible("paypal")) { say("PAYPAL_NOT_ELIGIBLE"); report("PAYPAL_NOT_ELIGIBLE"); return; }
        var session = sdk.createPayPalOneTimePaymentSession({
          onApprove: function (data) { return approved(data && data.orderId); },
          onCancel: function (data) { cancelled(data && data.orderId); },
          onError: function () { say("PayPal reported an error. Nothing was captured."); report("SDK_ON_ERROR"); },
        });
        var button = document.getElementById("paypal-button");
        button.removeAttribute("hidden");
        button.addEventListener("click", function () {
          // Do not await before start(): keeps the browser's transient user activation for the popup.
          var orderPromise = createOrder();
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
