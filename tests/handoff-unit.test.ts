import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HANDOFF_TRANSITIONS, PRE_TAKEOVER, assertHandoffTransition, type HandoffState } from "../src/handoff/states.js";
import { CHECKOUT_TRANSITIONS } from "../src/checkout/stateMachine.js";
import { evaluateConstraints, type CartSnapshot } from "../src/handoff/BrowserCheckoutHandoff.js";
import { PAYMENT_CONTROL, parseDisplayedMoney, validateRecipe } from "../src/handoff/recipes.js";
import { fixtureRecipe } from "../src/handoff/fixtureMerchant.js";

const SONY = { brand: "Sony", model: "WH-CH720N", variant: "Black", condition: "new" as const, sku: "WHCH720N/B" };
const snap = (o: Partial<CartSnapshot> = {}): CartSnapshot => ({ merchantHost: "m.example", title: "Sony WH-CH720N Headphones", variant: "Black", condition: "New", quantity: 1,
  currency: "USD", displayedCurrency: "USD", subtotalMinor: 4999, shippingMinor: 599, taxMinor: 400, totalMinor: 5998, cartRef: "cart_abcdef", capturedAt: "", provenance: "MERCHANT_PAGE_AS_DISPLAYED", ...o });
const exp = { identity: SONY, quantity: 1, currency: "USD" as const, merchantHost: "m.example" };
const cap = (n: number) => [{ source: "CLIENT_REQUEST" as const, maximumMinor: n }];

describe("handoff state machine", () => {
  it("is a separate table from the direct PayPal checkout", () => {
    const shared = Object.keys(HANDOFF_TRANSITIONS).filter((k) => k in CHECKOUT_TRANSITIONS);
    expect(shared).toEqual(["HOLD"]); // name overlap only; separate tables, separate persistence
  });
  it("after takeover, EXPIRED and plain CANCELLED are unreachable", () => {
    expect(() => assertHandoffTransition("HANDOFF_OPENED", "EXPIRED")).toThrow();
    expect(() => assertHandoffTransition("HANDOFF_OPENED", "CANCELLED")).toThrow();
    expect(() => assertHandoffTransition("ORDER_UNVERIFIED", "CANCELLED")).toThrow();
    for (const s of Object.keys(HANDOFF_TRANSITIONS) as HandoffState[]) {
      if (!PRE_TAKEOVER.has(s)) expect(HANDOFF_TRANSITIONS[s]).not.toContain("EXPIRED");
    }
  });
  it("ORDER_CONFIRMED is reachable only from an observation step and is final", () => {
    const into = (Object.entries(HANDOFF_TRANSITIONS) as Array<[HandoffState, readonly HandoffState[]]>).filter(([, t]) => t.includes("ORDER_CONFIRMED")).map(([f]) => f);
    expect(into.sort()).toEqual(["ORDER_UNVERIFIED", "RETURN_OBSERVED"]);
    expect(HANDOFF_TRANSITIONS.ORDER_CONFIRMED).toEqual([]);
  });
});

describe("constraints over the displayed cart", () => {
  it("accepts the exact authorized cart", () => expect(evaluateConstraints(snap(), exp, cap(6000)).violations).toEqual([]));
  it.each([
    [{ title: "Sony WH-1000XM5" }, "PRODUCT_MISMATCH"], [{ variant: "White" }, "VARIANT_MISMATCH"], [{ condition: "Renewed" }, "CONDITION_MISMATCH"],
    [{ condition: "Like new-ish" }, "CONDITION_UNRECOGNIZED"], [{ quantity: 2 }, "QUANTITY_MISMATCH"], [{ quantity: null }, "QUANTITY_UNKNOWN"],
    [{ displayedCurrency: "CAD" }, "CURRENCY_MISMATCH"], [{ totalMinor: null }, "TOTAL_UNKNOWN"], [{ totalMinor: 5000 }, "TOTAL_INCONSISTENT"],
    [{ merchantHost: "evil.example" }, "MERCHANT_HOST_MISMATCH"],
  ] as Array<[Partial<CartSnapshot>, string]>)("%o → %s", (o, v) => expect(evaluateConstraints(snap(o), exp, cap(9000)).violations).toContain(v));
  it("uses the LOWEST maximum across sources", () => {
    const r = evaluateConstraints(snap(), exp, [{ source: "CLIENT_REQUEST", maximumMinor: 9000 }, { source: "OWNER_HANDOFF_PAGE", maximumMinor: 5000 }]);
    expect(r.effectiveMaximumMinor).toBe(5000);
    expect(r.violations).toEqual(["AMOUNT_EXCEEDED"]);
  });
  it("missing components are unknowns, not zeros", () => {
    const r = evaluateConstraints(snap({ taxMinor: null, shippingMinor: null, condition: null }), exp, cap(9000));
    expect(r.unknowns).toEqual(expect.arrayContaining(["tax", "shipping", "condition"]));
  });
});

describe("displayed money parsing", () => {
  it.each([["$59.98", 5998], ["USD 1,059.00", 105900], ["59", 5900], ["Free", 0], ["$59.98 was $79.98", null], ["call us", null], [null, null]] as Array<[string | null, number | null]>)(
    "%s → %s", (t, v) => expect(parseDisplayedMoney(t, "USD")).toBe(v));
});

describe("recipes", () => {
  it("fixture recipe is valid only with loopback explicitly allowed", () => {
    expect(validateRecipe(fixtureRecipe("http://127.0.0.1:9999"), { allowLoopbackOrigin: true })).toBeNull();
    expect(validateRecipe(fixtureRecipe("http://127.0.0.1:9999"), { allowLoopbackOrigin: false })).toBe("RECIPE_ORIGIN_NOT_ALLOWED");
  });
  it("rejects click steps whose selector names a payment control", () => {
    const r = fixtureRecipe("http://127.0.0.1:9999");
    expect(validateRecipe({ ...r, steps: [{ action: "click", selector: "#paypal-button" }] }, { allowLoopbackOrigin: true })).toBe("RECIPE_TARGETS_PAYMENT_CONTROL");
  });
  it("payment-control pattern", () => {
    for (const t of ["PayPal", "Pay now", "Place order", "Place your order", "Buy now", "Complete purchase", "Confirm and pay"]) expect(PAYMENT_CONTROL.test(t)).toBe(true);
    for (const t of ["Add to cart", "Update quantity", "View cart", "Continue shopping"]) expect(PAYMENT_CONTROL.test(t)).toBe(false);
  });
});

describe("module boundaries", () => {
  it("the handoff module never imports a payment provider", () => {
    for (const f of readdirSync("src/handoff")) {
      const src = readFileSync(`src/handoff/${f}`, "utf8");
      expect(src, f).not.toMatch(/from\s+["']\.\.\/payment\//);
      expect(src, f).not.toMatch(/createOrder|captureOrder/);
    }
  });
  it("the direct PayPal Sandbox state machine is unchanged", () => {
    expect(CHECKOUT_TRANSITIONS.APPROVAL_REQUIRED).toEqual(["APPROVAL_REQUIRED", "APPROVED", "CANCELLED", "EXPIRED", "FAILED", "UNKNOWN", "HOLD"]);
    expect(CHECKOUT_TRANSITIONS.COMPLETED).toEqual(["REFUNDED"]);
  });
});
