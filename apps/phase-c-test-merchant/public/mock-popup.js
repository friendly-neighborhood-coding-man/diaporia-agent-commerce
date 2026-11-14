// MOCK popup only (never used with PayPal). Tells the opener what the simulated buyer did, then closes.
(function () {
  "use strict";
  var el = document.getElementById("mock-result");
  if (!el) {
    var cancel = document.getElementById("cancel");
    if (cancel) cancel.addEventListener("click", function () {
      var order = cancel.getAttribute("data-order");
      if (window.opener) window.opener.postMessage({ src: "phc-mock-paypal", type: "cancelled", orderId: order }, location.origin);
      window.close();
    });
    return;
  }
  var msg = { src: "phc-mock-paypal", type: el.getAttribute("data-type"), orderId: el.getAttribute("data-order") };
  if (window.opener) { window.opener.postMessage(msg, location.origin); window.close(); }
})();
