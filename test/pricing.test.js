// ---------------------------------------------------------------------
// Test matrix for lib/pricing.js — the audit's §6 matrices, executable.
//
// Runs on plain Node (>=20), no dependencies:   npm test
//
// Three kinds of test live here, and the difference matters:
//
//   1. RULE tests    — assert the confirmed business rule. If one of
//                      these fails, the code is wrong.
//   2. LOCK tests    — pin down current behaviour that is NOT obviously
//                      right but that we are deliberately not changing
//                      yet. If one fails, someone changed behaviour;
//                      decide whether that was intended.
//   3. TODO tests    — the target behaviour for a known-open finding.
//                      These are expected to fail today; they are the
//                      acceptance criteria for that fix. Node reports
//                      them as TODO, so the suite stays green.
//
// When you fix F6, the F6 TODO tests should go green and the matching
// LOCK tests should be updated in the same change — that pairing is the
// whole point of writing them down now.
// ---------------------------------------------------------------------

import test from "node:test";
import assert from "node:assert/strict";

import {
  asText,
  numberValue,
  isDutchClientCountry,
  getMemberWtbMargin,
  memberWtbIsReverseCharge,
  memberWtbBuyerFacingVatType,
  memberWtbBuyerInvoiceAmount,
  calculateMemberWtbBuyerEquivalent,
  calculateMemberWtbSellerPayout,
  getMemberWtbNetSalePrice,
  calculateCounterPayoutForVatType,
  calculateStoreCounterEquivalent,
  computeSellerCounterForStoreDisplay,
  computeStoreExclVatForOrder,
  customOfferValueForAccept,
  storeInputMultiplier,
  storeDisplayDivisor,
  storeFacingVatType,
  roundDownToStep,
  roundToNearestStep
} from "../lib/pricing.js";

// ---------------------------------------------------------------------
// Reference implementations of the DOWNSTREAM steps that do not live in
// pricing.js — the Airtable formulas and the inline Final Buying Price
// calculation in process-seller-offer. They are duplicated here on
// purpose so the matrix can be checked end-to-end (seller ask -> what
// the buyer is actually invoiced).
//
// If you change one of these in Airtable or in index.js, change it here
// too — a green suite with a stale reference proves nothing.
// ---------------------------------------------------------------------

/** Airtable: Member WTBs."Buying VAT Amount" */
function refBuyingVatAmount(finalBuyingPrice, unitVatType, f) {
  const isVat = unitVatType === "VAT0" || unitVatType === "VAT21";
  const country = asText(f["Buyer Country"]);
  const domestic =
    country === "Netherlands" || country === "Nederland" || !asText(f["Buyer VAT ID"]);
  if (!finalBuyingPrice || !isVat || !domestic) return null;
  return Math.round(finalBuyingPrice * 0.21 * 100) / 100;
}

/** Airtable: Member WTBs."Invoice Price" — what the buyer actually pays. */
function refInvoicePrice(finalBuyingPrice, unitVatType, f) {
  if (!finalBuyingPrice) return null;
  const vat = refBuyingVatAmount(finalBuyingPrice, unitVatType, f);
  return vat === null
    ? finalBuyingPrice
    : Math.round((finalBuyingPrice + vat) * 100) / 100;
}

/** index.js: process-seller-offer, open-WTB flow (no "Offer To Buyer" set). */
function refFinalBuyingPriceOpenFlow(purchasePrice, sellerVatType, f) {
  const margin = getMemberWtbMargin(f);
  let x;
  if (sellerVatType === "VAT0") x = purchasePrice + margin;
  else if (sellerVatType === "VAT21") x = purchasePrice / 1.21 + margin;
  // Margin stock: the margin is grossed up, same as the buyer-facing side.
  else x = purchasePrice + margin * 1.21;
  return Math.round(x * 100) / 100;
}

/** Airtable automation calculateLinkedUnitPrice.js: Custom Offer -> Final Buying Price. */
function refStoreFinalBuyingPrice(customOffer, offerVatType, orderFields) {
  const country = asText(orderFields["Client Country"]).toLowerCase();
  const strip = country.includes("netherland") && offerVatType === "VAT21";
  return Math.round((strip ? customOffer / 1.21 : customOffer) * 100) / 100;
}

// --------------------------- buyer contexts ---------------------------
const buyer = {
  nl:        { "Buyer Country": ["Netherlands"], "Buyer VAT ID": ["NL001"] },
  nlNoVat:   { "Buyer Country": ["Netherlands"] },
  reverse:   { "Buyer Country": ["Italy"],       "Buyer VAT ID": ["IT001"] },
  foreignNo: { "Buyer Country": ["Italy"] }
};
const withMargin = (ctx, m) => ({ ...ctx, "Offer Margin": [m] });

// --------------------------- store contexts ---------------------------
const store = {
  nl: {
    "Client Country": ["Netherlands"], "Client VAT Rate": [0.21],
    "Offer Method": ["Percentage"], "Offer Percentage": [0.08]
  },
  it: {
    "Client Country": ["Italy"], "Client VAT Rate": [0.22],
    "Offer Method": ["Percentage"], "Offer Percentage": [0.08]
  },
  dk: {
    "Client Country": ["Denmark"], "Client VAT Rate": [0.25],
    "Offer Method": ["Percentage"], "Offer Percentage": [0.08]
  },
  be: {
    "Client Country": ["Belgium"], "Client VAT Rate": [0.21],
    "Offer Method": ["Percentage"], "Offer Percentage": [0.08]
  },
  itFirm: {
    "Client Country": ["Italy"], "Client VAT Rate": [0.22],
    "Offer Method": ["Firm Range"], "Offer Margin": [15]
  }
};

// =====================================================================
// 1. Plumbing — the array-unwrapping that Airtable lookups force on us
// =====================================================================

test("RULE: asText / numberValue unwrap Airtable lookup shapes", () => {
  assert.equal(asText(["Netherlands"]), "Netherlands");
  assert.equal(asText([{ name: "VAT21" }]), "VAT21");
  assert.equal(asText(null), "");
  assert.equal(numberValue([0.22]), 0.22);
  assert.equal(numberValue([]), 0, "empty lookup array must not become NaN");
  assert.equal(numberValue("nonsense"), 0);
});

test("RULE: isDutchClientCountry accepts every spelling in use", () => {
  for (const v of ["Netherlands", "nederland", "NL", "The Netherlands", ["Netherlands"]]) {
    assert.equal(isDutchClientCountry(v), true, `${JSON.stringify(v)} should be Dutch`);
  }
  assert.equal(isDutchClientCountry(["Italy"]), false);
});

// =====================================================================
// 2. Member WTB margin (F2) — one source of truth, Airtable-identical
// =====================================================================

test("RULE: margin comes from Offer Margin, mirroring IF({x},{x},10)", () => {
  assert.equal(getMemberWtbMargin({ "Offer Margin": [5] }), 5);
  assert.equal(getMemberWtbMargin({ "Offer Margin": [15] }), 15);
  assert.equal(getMemberWtbMargin({ "Offer Margin": [7.5] }), 7.5);
  // 0 / blank / junk all fall back to 10, exactly like the Airtable formula
  assert.equal(getMemberWtbMargin({ "Offer Margin": [0] }), 10);
  assert.equal(getMemberWtbMargin({ "Offer Margin": [] }), 10);
  assert.equal(getMemberWtbMargin({}), 10);
});

// =====================================================================
// 3. Member WTB reverse-charge + buyer-facing label (the golden rule)
// =====================================================================

test("RULE: reverse-charge needs BOTH a VAT ID and a non-NL country", () => {
  assert.equal(memberWtbIsReverseCharge(buyer.reverse), true);
  assert.equal(memberWtbIsReverseCharge(buyer.nl), false, "NL + VAT ID is not reverse-charge");
  assert.equal(memberWtbIsReverseCharge(buyer.foreignNo), false, "no VAT ID is not reverse-charge");
  assert.equal(memberWtbIsReverseCharge(buyer.nlNoVat), false);
});

test("RULE: the buyer-facing VAT label is display-only and never the seller's", () => {
  // A VAT21 seller selling to a reverse-charge buyer shows VAT0 to that
  // buyer — but the seller is still VAT21. This label must never be fed
  // back into a seller-side calculation or onto the inventory unit.
  assert.equal(memberWtbBuyerFacingVatType("VAT21", buyer.reverse), "VAT0");
  assert.equal(memberWtbBuyerFacingVatType("VAT21", buyer.nl), "VAT21");
  assert.equal(memberWtbBuyerFacingVatType("VAT0", buyer.nl), "VAT21");
  assert.equal(memberWtbBuyerFacingVatType("Margin", buyer.reverse), "Margin");
  assert.equal(memberWtbBuyerFacingVatType("Margin", buyer.nl), "Margin");
});

// =====================================================================
// 4. Matrix 6a — Member WTB end to end, at margin 10 AND margin 5
// =====================================================================

const matrix6a = [
  // seller ask, seller VAT, buyer ctx,      buyerPrice@10, FBP@10,  invoice@10
  [146, "VAT21",  "reverse",   130.66, 130.66, 130.66],
  [146, "VAT21",  "nl",        158.10, 130.66, 158.10],
  [146, "VAT21",  "foreignNo", 158.10, 130.66, 158.10],
  [120, "VAT0",   "reverse",   130.00, 130.00, 130.00],
  [120, "VAT0",   "nl",        157.30, 130.00, 157.30],
  [120, "VAT0",   "foreignNo", 157.30, 130.00, 157.30],
  [200, "Margin", "reverse",   212.10, 212.10, 212.10],
  [200, "Margin", "nl",        212.10, 212.10, 212.10]
];

for (const [ask, sellerVat, ctxName, expBuyer, expFbp, expInvoice] of matrix6a) {
  test(`RULE 6a: ${ask} ${sellerVat} -> ${ctxName} buyer (margin 10)`, () => {
    const f = buyer[ctxName];

    const buyerPrice = calculateMemberWtbBuyerEquivalent(ask, sellerVat, f);
    assert.equal(buyerPrice, expBuyer, "buyer-facing price");

    // The two conversions must be exact inverses, or a counter round
    // silently changes the deal.
    const backToSeller = calculateMemberWtbSellerPayout(buyerPrice, sellerVat, f);
    assert.ok(Math.abs(backToSeller - ask) < 0.02, `round-trip: ${backToSeller} != ${ask}`);

    const fbp = refFinalBuyingPriceOpenFlow(ask, sellerVat, f);
    assert.equal(fbp, expFbp, "Final Buying Price");

    // The inventory unit always carries the SELLER's VAT type — that is
    // what drives the invoice, never the buyer-facing label.
    const invoice = refInvoicePrice(fbp, sellerVat, f);
    assert.equal(invoice, expInvoice, "Invoice / Mollie amount");
    assert.equal(invoice, buyerPrice, "invoice must equal what the buyer was shown");
  });
}

test("RULE 6a: the whole matrix still closes when the margin is 5", () => {
  for (const [ask, sellerVat, ctxName] of matrix6a) {
    const f = withMargin(buyer[ctxName], 5);
    const buyerPrice = calculateMemberWtbBuyerEquivalent(ask, sellerVat, f);
    const backToSeller = calculateMemberWtbSellerPayout(buyerPrice, sellerVat, f);
    const fbp = refFinalBuyingPriceOpenFlow(ask, sellerVat, f);
    const invoice = refInvoicePrice(fbp, sellerVat, f);

    assert.ok(Math.abs(backToSeller - ask) < 0.02,
      `${ask} ${sellerVat} ${ctxName}: round-trip broke at margin 5`);
    assert.ok(Math.abs(invoice - buyerPrice) < 0.02,
      `${ask} ${sellerVat} ${ctxName}: invoice ${invoice} != buyer price ${buyerPrice}`);
  }
});

test("RULE 6a: a €5 margin really is €5 cheaper for the buyer", () => {
  const at10 = calculateMemberWtbBuyerEquivalent(146, "VAT21", withMargin(buyer.reverse, 10));
  const at5 = calculateMemberWtbBuyerEquivalent(146, "VAT21", withMargin(buyer.reverse, 5));
  assert.equal(at10, 130.66);
  assert.equal(at5, 125.66);
});

// =====================================================================
// 5. Matrix 6b — KC-owned / consignment (koper-VAT-rate)
// =====================================================================

// The divisor is the BUYER's own VAT rate: the Buying page states that
// the member fills in an all-in price, so the VAT inside it is the VAT of
// their country. B2B Only is already bare and divides nothing.
const MAX_PRICE = 200;
const RATE = { nl: 0.21, dk: 0.25, it: 0.22, fr: 0.20 };

const matrix6b = [
  // unit VAT, inventory filter, buyer rate, expected Final Buying Price
  ["VAT21",  "All Inventory", RATE.nl, 165.29],
  ["VAT21",  "All Inventory", RATE.dk, 160.00],
  ["VAT21",  "All Inventory", RATE.it, 163.93],
  ["VAT21",  "All Inventory", RATE.fr, 166.67],
  ["VAT0",   "All Inventory", RATE.nl, 165.29],
  ["VAT0",   "All Inventory", RATE.dk, 160.00],
  ["Margin", "All Inventory", RATE.dk, 200.00],
  ["VAT21",  "B2B Only",      RATE.nl, 200.00],
  ["VAT21",  "B2B Only",      RATE.dk, 200.00],
  ["Margin", "B2B Only",      RATE.dk, 200.00]
];

for (const [unitVat, filter, rate, expected] of matrix6b) {
  test(`RULE 6b: Max ${MAX_PRICE} · ${unitVat} · ${filter} · rate ${rate}`, () => {
    assert.equal(getMemberWtbNetSalePrice(MAX_PRICE, unitVat, filter, [rate]), expected);
  });
}

test("RULE 6b: a missing or zero buyer rate falls back to 21%", () => {
  for (const bad of [undefined, null, 0, [], [0], "nonsense"]) {
    assert.equal(
      getMemberWtbNetSalePrice(MAX_PRICE, "VAT21", "All Inventory", bad),
      165.29,
      `fallback failed for ${JSON.stringify(bad)}`
    );
  }
});

test("RULE 6b: the function sees a RATE, never a buyer context", () => {
  // A reverse-charge branch lived here once and was reverted: it made a
  // foreign business pay €200 where a Dutch business really paid €165.29.
  // The 4th argument is a plain number, so that branch cannot be written
  // again — there is no VAT ID or country to test. A context object reads
  // as "no rate" and falls back.
  assert.equal(getMemberWtbNetSalePrice(MAX_PRICE, "VAT21", "All Inventory", [RATE.nl]), 165.29);
  assert.equal(getMemberWtbNetSalePrice(MAX_PRICE, "VAT21", "All Inventory", buyer.reverse), 165.29);
});

test("RULE 6b: both business buyers end up at the same REAL price", () => {
  // Same country, same rate: a Dutch business reclaims the 21%, a
  // reverse-charge business is never charged it, so both really pay the
  // net amount. This is what the reverted branch broke.
  const fbp = getMemberWtbNetSalePrice(MAX_PRICE, "VAT21", "All Inventory", [RATE.nl]);
  assert.equal(fbp, 165.29);

  const dutchInvoice = refInvoicePrice(fbp, "VAT21", buyer.nl);
  const dutchVat = Math.round((dutchInvoice - fbp) * 100) / 100;

  assert.equal(dutchInvoice, 200.00);
  assert.equal(Math.round((dutchInvoice - dutchVat) * 100) / 100, 165.29);
  assert.equal(refInvoicePrice(fbp, "VAT21", buyer.reverse), 165.29);
});

test("RULE 6b: a Danish buyer typing 200 nets 160, not 165.29", () => {
  const dk = getMemberWtbNetSalePrice(MAX_PRICE, "VAT21", "All Inventory", [RATE.dk]);
  assert.equal(dk, 160.00, "200 incl. 25% Danish VAT is 160 net");
  assert.equal(refInvoicePrice(dk, "VAT21", buyer.reverse), 160.00,
    "reverse-charge: invoiced VAT-free at the net amount");
});


// =====================================================================
// 6. Matrix 6c — Store Orders
// =====================================================================

test("RULE: the store-facing VAT label follows the CLIENT, never the seller", () => {
  // A Dutch store never sees VAT0; a foreign store always sees VAT0.
  assert.equal(storeFacingVatType("VAT0", store.nl), "VAT21");
  assert.equal(storeFacingVatType("VAT21", store.nl), "VAT21");
  assert.equal(storeFacingVatType("VAT0", store.it), "VAT0");
  // This is the one that was wrong: a VAT21 seller on a foreign store
  // was labelled VAT21, while we invoice that store VAT0.
  assert.equal(storeFacingVatType("VAT21", store.it), "VAT0");
  assert.equal(storeFacingVatType("VAT21", store.dk), "VAT0");
  // Margin passes through regardless of country.
  assert.equal(storeFacingVatType("Margin", store.nl), "Margin");
  assert.equal(storeFacingVatType("Margin", store.it), "Margin");
});

test("RULE: the label matches the rule the accept paths use to write Offer VAT Type", () => {
  // index.js:5823 / 9057 / 14666 / 16843 all do:
  //   Margin ? "Margin" : (isDutchClientCountry(...) ? "VAT21" : "VAT0")
  // storeFacingVatType must agree, or the store reads one type and gets
  // invoiced under another.
  const acceptRule = (sellerVat, orderFields) =>
    sellerVat === "Margin"
      ? "Margin"
      : (isDutchClientCountry(orderFields["Client Country"]) ? "VAT21" : "VAT0");

  for (const s of [store.nl, store.it, store.dk, store.be]) {
    for (const sellerVat of ["VAT0", "VAT21", "Margin"]) {
      assert.equal(
        storeFacingVatType(sellerVat, s),
        acceptRule(sellerVat, s),
        `${sellerVat} @ ${asText(s["Client Country"])}`
      );
    }
  }
});

test("RULE F6c: display and payout are exact inverses for a foreign store", () => {
  // The mirror of the payout-side bridge. A VAT21 seller's counter is
  // Dutch all-in; the store reads VAT0. Without the division the store
  // was quoted ~21% too much AND invoiced it (store-accept writes this
  // very figure into Custom Offer).
  assert.equal(computeSellerCounterForStoreDisplay(196.06, "VAT21", store.it), 180.00);
  assert.equal(computeSellerCounterForStoreDisplay(150.00, "VAT21", store.it), 140.00);
  assert.equal(computeSellerCounterForStoreDisplay(240.00, "VAT21", store.it), 220.00);

  // A VAT0 seller is already in the store's scale — unchanged.
  assert.equal(computeSellerCounterForStoreDisplay(140, "VAT0", store.it), 155.00);
  // A Dutch store shares the seller's all-in scale — unchanged.
  assert.equal(computeSellerCounterForStoreDisplay(196.06, "VAT21", store.nl), 217.50);

  // Round-trip: what the store sees, countered back, returns roughly the
  // seller's own ask (within the €2.50 grid).
  const shown = computeSellerCounterForStoreDisplay(196.06, "VAT21", store.it);
  const stored = shown * storeInputMultiplier(store.it);
  const backToSeller = calculateCounterPayoutForVatType(stored, "VAT21", store.it);
  assert.ok(Math.abs(backToSeller - 196.06) <= 2.5,
    `display/payout must be inverses: ${backToSeller} vs 196.06`);
});

test("LOCK 6c: what a store is shown for a 140 VAT0 seller ask", () => {
  // Italy: seller's VAT0 ask is already in the store's excl. scale, so
  // only the margin formula runs -> MAX(150, 156.20) -> 2.50 grid.
  assert.equal(computeSellerCounterForStoreDisplay(140, "VAT0", store.it), 155.00);
  // NL: grossed up x1.21 first (Lojiq buys VAT0 abroad, sells VAT21 at
  // home) -> 169.40 -> MAX(179.40, 187.95) -> 2.50 grid.
  assert.equal(computeSellerCounterForStoreDisplay(140, "VAT0", store.nl), 187.50);
  // Firm Range takes the flat margin instead of the percentage.
  assert.equal(computeSellerCounterForStoreDisplay(140, "VAT0", store.itFirm), 155.00);
});

test("LOCK 6c: store input and display round-trip exactly", () => {
  // Whatever storeInputMultiplier does, the Excl-VAT formula must undo
  // it exactly, or the store gets invoiced a number it never typed.
  // (Since F6b both legs are 1.21 — see the F6b tests further down.)
  for (const s of [store.it, store.dk, store.be]) {
    const typed = 190;
    const stored = typed * storeInputMultiplier(s);
    const shownBack = stored / storeDisplayDivisor("VAT0", s);
    assert.ok(Math.abs(shownBack - typed) < 0.01,
      `${asText(s["Client Country"])}: ${shownBack} != ${typed}`);
  }
  // A Dutch store types and sees the plain all-in figure.
  assert.equal(storeDisplayDivisor("VAT0", store.nl), 1);
  assert.equal(storeDisplayDivisor("Margin", store.it), 1, "Margin is never excl.");
});

test("RULE 6c/F1: Custom Offer for a VAT0 store is the EXCL figure", () => {
  // This is the bug that made a legacy accept path invoice +22%: the
  // stored all-in number must never reach Custom Offer for VAT0.
  assert.equal(customOfferValueForAccept("VAT0", 231.80, 190.00), 190.00);
  // VAT21 / Margin write the all-in number; the downstream automation
  // divides for VAT21 itself.
  assert.equal(customOfferValueForAccept("VAT21", 230.00, 190.08), 230.00);
  assert.equal(customOfferValueForAccept("Margin", 210.00, null), 210.00);
});

test("RULE 6c: accepted store price ends up on the invoice unchanged", () => {
  // Italy, VAT0: store typed 190 -> stored 231.80 -> billed 190.
  const typed = 190;
  const stored = typed * storeInputMultiplier(store.it);
  const custom = customOfferValueForAccept("VAT0", stored, stored / storeInputMultiplier(store.it));
  assert.equal(refStoreFinalBuyingPrice(custom, "VAT0", store.it), typed);

  // NL, VAT21: store typed 230 all-in -> billed 230 (190.08 + 21%).
  const fbpNl = refStoreFinalBuyingPrice(230, "VAT21", store.nl);
  assert.equal(fbpNl, 190.08);
  assert.equal(Math.round(fbpNl * 1.21 * 100) / 100, 230.00);
});

test("LOCK: rounding helpers", () => {
  assert.equal(roundDownToStep(133.54, 2.5), 132.5);
  assert.equal(roundDownToStep(132.50, 2.5), 132.5);
  assert.equal(roundToNearestStep(187.952, 2.5), 187.5);
  assert.equal(roundToNearestStep(188.80, 2.5), 190);
});

// =====================================================================
// 7. Matrix 6d — F6, still OPEN. These are the acceptance criteria.
//
// Confirmed rule: the client VAT rate has exactly ONE job — converting a
// foreign store's all-in Max Buying Price into the VAT0 base price.
// After that it is Dutch logic only, and the seller payout must always
// run on 1.21.
// =====================================================================

test("RULE F6b: the seller payout never depends on the client's VAT rate", () => {
  // The client rate has one job only: turning a foreign store's all-in
  // Max Buying Price into the VAT0 base. It must not reach the payout.
  // Store types 148 -> (148 - 5) / 1.08 -> floor to 2.50 -> 130.00,
  // the same for every country.
  for (const s of [store.it, store.dk, store.be]) {
    const stored = 148 * storeInputMultiplier(s);
    assert.equal(calculateCounterPayoutForVatType(stored, "VAT0", s), 130.00,
      `${asText(s["Client Country"])} payout must not depend on the client rate`);
  }
});

test("RULE F6b: input scaling and the Excl-VAT formula both use 1.21", () => {
  // storeInputMultiplier moves between the store's scale and the
  // INTERNAL scale, and that transition is Dutch 21% — not the store's
  // local rate. The Airtable formula "Store Counter Price Excl VAT" must
  // divide by the same 1.21 or the round-trip breaks.
  for (const s of [store.it, store.dk, store.be, store.nl]) {
    assert.equal(storeInputMultiplier(s), 1.21);
  }
  assert.equal(storeDisplayDivisor("VAT0", store.it), 1.21);
  assert.equal(storeDisplayDivisor("VAT0", store.dk), 1.21);
  assert.equal(storeDisplayDivisor("VAT0", store.nl), 1, "a Dutch store sees the all-in figure");
  assert.equal(storeDisplayDivisor("Margin", store.it), 1, "Margin is never excl.");

  // What the store types must come back out unchanged.
  const typed = 190;
  const stored = typed * storeInputMultiplier(store.it);
  assert.equal(stored / 1.21, typed, "Store Counter Price Excl VAT must return the typed number");
});

test("RULE F6c: a VAT21 seller against a foreign store gets the 1.21 bridge", () => {
  // The foreign store's number is a VAT0 base; a Dutch VAT21 seller is
  // paid incl. 21%. Nothing used to bridge those two.
  // (180 - 5) / 1.08 = 162.04 net -> x1.21 -> floor to 2.50 -> 195.00.
  for (const s of [store.it, store.dk]) {
    const stored = 180 * storeInputMultiplier(s);
    assert.equal(calculateCounterPayoutForVatType(stored, "VAT21", s), 195.00);
  }
});

test("RULE F6c: a Dutch store keeps the margin over the ALL-IN price", () => {
  // Deliberate: the percentage margin is taken over the all-in price
  // because there is VAT to remit on it. So for a Dutch store the shape
  // stays (all-in - constant) / (1 + pct) with no VAT conversion at all,
  // exactly as before F6c. These four values are unchanged by the fix.
  assert.equal(calculateCounterPayoutForVatType(242.00, "VAT21", store.nl), 217.50);
  assert.equal(calculateCounterPayoutForVatType(300.00, "VAT21", store.nl), 272.50);
  assert.equal(calculateCounterPayoutForVatType(187.50, "VAT21", store.nl), 167.50);
  assert.equal(calculateCounterPayoutForVatType(425.00, "VAT21", store.nl), 387.50);
});

test("RULE F6c: the foreign-store bridge needs a KNOWN non-Dutch country", () => {
  // Several callers pass `orderFieldsForEdit || {}`. An empty object
  // must not be read as "foreign store" — it has to behave exactly as
  // before, or an edit would silently repay the seller on a new scale.
  const noContext = { "Offer Method": ["Percentage"], "Offer Percentage": [0.08] };
  assert.equal(calculateCounterPayoutForVatType(219.60, "VAT21", noContext), 197.50,
    "unknown country must fall back to the pre-F6c behaviour");
  assert.equal(calculateCounterPayoutForVatType(219.60, "VAT21", {}), null,
    "no margin config at all still yields null");
});

// F6a lives in four AIRTABLE formulas, so it cannot be asserted against
// code. Encoded here as the arithmetic those formulas must satisfy once
// changed, so the expected numbers are written down somewhere runnable.
//
// The four to change (confirmed field-by-field):
//   Maximum Buying Price            / IF(VAT0|VAT21, 1.21, 1) -> 1 + Client VAT Rate
//   Target Buying Price             idem, in BOTH branches
//   Final Outsource Buying Price (VAT 0%)   / 1.21 -> / (1 + Client VAT Rate)
//   Outsource Buying Price (VAT 0%)         idem
//
// Explicitly NOT changing: Current Lowest (VAT0), Max Allowed Offer
// (VAT0) and Current Lowest Offer — those are seller-facing, and the
// seller side never uses the client rate. The 4.13 in Max Allowed Offer
// (VAT0) is the €5 step on the VAT0 scale (5/1.21), not a VAT conversion.
test("F6a: the VAT0 outsource ceiling must use the client rate", { todo: true }, () => {
  const grid = (x) => Math.round(x / 2.5) * 2.5;
  const ceiling = (maxBuy, rate) => grid((maxBuy * 0.95 - 5) / (1 + rate));

  // Denmark 25% — worst case found across Max Buying Price 100..600.
  assert.equal(ceiling(510, 0.25), 382.50, "DK: 397.50 with 1.21, 382.50 is correct");
  // Italy 22%.
  assert.equal(ceiling(440, 0.22), 337.50, "IT: 342.50 with 1.21, 337.50 is correct");
  // Belgium 21% — must be unchanged, which is why this hid for so long.
  assert.equal(ceiling(510, 0.21), grid((510 * 0.95 - 5) / 1.21), "BE: identical either way");
});

test("F6a: note — the divisor in Max/Target Buying Price is dormant while offering", () => {
  // NOT a todo: this documents WHY changing those two formulas will look
  // like it did nothing. Their divisor keys on {VAT Type}, a lookup via
  // {Linked Inventory Unit}, which is empty during Outsource (nothing is
  // linked until autoAllocateBestUnit links it *and* sets Allocated in
  // the same write). So the IF is false and the divisor is 1 either way.
  const divisor = (unitVatType, clientRate) =>
    unitVatType === "VAT0" || unitVatType === "VAT21" ? 1 + clientRate : 1;

  assert.equal(divisor("", 0.22), 1, "offer phase: no unit linked -> no VAT stripped");
  assert.equal(divisor("VAT21", 0.22), 1.22, "after allocation: client rate applies");
});

// =====================================================================
// 8. What the buyer is invoiced — embed and accept must agree
// =====================================================================

test("RULE: memberWtbBuyerInvoiceAmount mirrors the Airtable Invoice Price", () => {
  for (const unitVat of ["VAT0", "VAT21", "Margin"]) {
    for (const ctxName of ["nl", "nlNoVat", "reverse", "foreignNo"]) {
      const f = buyer[ctxName];
      const fbp = getMemberWtbNetSalePrice(MAX_PRICE, unitVat, "All Inventory");
      assert.equal(
        memberWtbBuyerInvoiceAmount(fbp, unitVat, f),
        refInvoicePrice(fbp, unitVat, f),
        `${unitVat} @ ${ctxName}`
      );
    }
  }
});

test("RULE: the KC offer embed quotes exactly what the accept books", () => {
  // The embed shows "We receive: X (LABEL)". Both come from the same
  // helpers the accept uses, so recomputing them here must reproduce the
  // documented figures for a €200 offer on a VAT21 unit.
  const unitVat = "VAT21";
  const fbp = getMemberWtbNetSalePrice(MAX_PRICE, unitVat, "All Inventory");

  assert.equal(fbp, 165.29, "the accept books this as Final Buying Price");

  assert.equal(memberWtbBuyerInvoiceAmount(fbp, unitVat, buyer.reverse), 165.29);
  assert.equal(memberWtbBuyerFacingVatType(unitVat, buyer.reverse), "VAT0");

  assert.equal(memberWtbBuyerInvoiceAmount(fbp, unitVat, buyer.nl), 200.00);
  assert.equal(memberWtbBuyerFacingVatType(unitVat, buyer.nl), "VAT21");
});

test("RULE: a Margin unit is never grossed up, for any buyer", () => {
  const fbp = getMemberWtbNetSalePrice(MAX_PRICE, "Margin", "All Inventory");
  assert.equal(fbp, 200.00);
  for (const ctxName of ["nl", "reverse", "nlNoVat", "foreignNo"]) {
    assert.equal(memberWtbBuyerInvoiceAmount(fbp, "Margin", buyer[ctxName]), 200.00);
    assert.equal(memberWtbBuyerFacingVatType("Margin", buyer[ctxName]), "Margin");
  }
});
