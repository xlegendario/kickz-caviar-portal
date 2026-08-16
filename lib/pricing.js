// ---------------------------------------------------------------------
// Shared pricing + VAT helpers.
//
// Moved here VERBATIM from index.js — no logic was changed in the move.
// The point is that these are the only place prices and VAT types are
// computed, they are PURE (no Airtable, no Discord, no I/O, no clock),
// and they are therefore directly testable. See test/pricing.test.js,
// which encodes the audit's test matrix against them.
//
// Anything that decides an amount or a VAT type belongs in this file.
// If you find yourself recomputing one of these inline somewhere else,
// that is the bug class this whole audit is about — import it instead.
// ---------------------------------------------------------------------

export function asText(value) {
  if (value === null || value === undefined) return "";

  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (item === null || item === undefined) return "";
        if (typeof item === "object") {
          return item.name || item.text || item.value || "";
        }
        return String(item);
      })
      .filter(Boolean)
      .join(", ")
      .trim();
  }

  return String(value).trim();
}

// FIXED — this had no reverse-charge branch at all, unlike every other
// Member WTB calculation in this file (see memberWtbIsReverseCharge).
// It divided Max Price by 1.21 for EVERY VAT0/VAT21 unit, so for a
// foreign reverse-charge buyer the Final Buying Price came out 21% too
// low — and because "Invoice Price" hands a reverse-charge buyer the
// bare Final Buying Price, that 21% was simply never billed.
//
// Confirmed rule: Max Price is all-in incl. NL VAT, EXCEPT on a B2B-only
// filter (where it's already bare). So only strip the 21% when the buyer
// genuinely pays Dutch VAT — i.e. VAT0/VAT21 unit, not B2B-only, and not
// reverse-charge:
//
//   VAT0/VAT21 · normal   · NL or no VAT ID  -> /1.21   (unchanged)
//   VAT0/VAT21 · normal   · reverse-charge   -> bare    (FIXED)
//   VAT0/VAT21 · B2B-only · any              -> bare    (unchanged)
//   Margin     · any      · any              -> bare    (unchanged)
//
// memberWtbFields is a NEW, OPTIONAL 4th argument: omitted, it defaults
// to {} and memberWtbIsReverseCharge({}) returns false, which reproduces
// the exact previous behavior. (memberWtbIsReverseCharge is a hoisted
// function declaration further down this file, so calling it here is
// safe.)
export function getMemberWtbNetSalePrice(price, vatType, inventoryFilter, memberWtbFields = {}) {
  const amount = Number(price || 0);
  const type = asText(vatType);
  const filter = asText(inventoryFilter).toLowerCase();

  if (!Number.isFinite(amount) || amount <= 0) return 0;

  if (type === "VAT0" || type === "VAT21") {
    if (filter.includes("b2b")) {
      return amount;
    }

    if (memberWtbIsReverseCharge(memberWtbFields)) {
      return Math.round(amount * 100) / 100;
    }

    return Math.round((amount / 1.21) * 100) / 100;
  }

  return amount;
}

export function numberValue(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

export function roundDownToStep(value, step = 2.5) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.floor(n / step) * step;
}

export function getCounterEquivalentPriceForVatType(storeCounterAllInPrice, vatType, orderFields = {}) {
  const price = Number(storeCounterAllInPrice);
  const type = asText(vatType);

  if (!Number.isFinite(price) || price <= 0) return null;

  if (type === "VAT0") {
    return price / 1.21;
  }

  return price;
}

// FIXED (F6c) — narrow, deliberate fix: a VAT21 seller against a
// NON-DUTCH store was never converted at all.
//
// getCounterEquivalentPriceForVatType only divides for VAT0; VAT21 and
// Margin pass through untouched. That is right for a Dutch store, where
// the store's number and the seller's number are on the same all-in
// scale. For a foreign store it is not: that store sees and types a VAT0
// figure, while a Dutch VAT21 seller is paid incl. 21%. Nothing bridged
// those two, so the seller was paid out of a number that still had the
// input scaling in it, and the margin constants (+10/+5/-10) landed on
// the wrong scale.
//
// What is deliberately NOT changed: the margin still runs on the price
// the STORE pays, because the percentage margin is taken over the all-in
// price (there is VAT to remit on it). For a Dutch store that is the
// all-in figure — unchanged from before. For a foreign store the price
// they pay IS the VAT0 figure, so "over the all-in price" and "over the
// VAT0 base" are the same number there and nothing moves either. Only
// the seller-side gross-up for a VAT21 seller is new.
//
// The guard is intentionally conservative: a foreign store is only
// recognised when Client Country is actually present and not Dutch.
// Several callers pass `orderFieldsForEdit || {}`, and an empty object
// must keep behaving exactly as it does today rather than being read as
// "foreign".
export function calculateCounterPayoutForVatType(storeCounterAllInPrice, vatType, orderFields = {}) {
  const type = asText(vatType);
  const clientCountry = asText(orderFields["Client Country"]);
  const isForeignStore = !!clientCountry && !isDutchClientCountry(clientCountry);
  const bridgeForeignVat21 = isForeignStore && type === "VAT21";

  // A foreign store's typed figure was scaled up on the way in
  // (storeInputMultiplier); undo that to get back to the VAT0 number
  // they actually typed, which is what our margin applies to.
  const converted = bridgeForeignVat21
    ? Number(storeCounterAllInPrice) / 1.21
    : getCounterEquivalentPriceForVatType(storeCounterAllInPrice, vatType);

  if (!Number.isFinite(converted) || converted <= 0) return null;

  const margin = numberValue(orderFields["Offer Margin"]);
  const percentage = numberValue(orderFields["Offer Percentage"]);
  const method = asText(orderFields["Offer Method"]);

  let payout;

  if (method === "Firm Range" && Number.isFinite(margin) && margin > 0) {
    payout = converted - margin;
  } else if (Number.isFinite(percentage) && percentage > 0) {
    // FIXED — must invert MAX(base+10, base*(1+pct)+5), same fix as
    // calculateStoreCounterEquivalent's forward direction, mirrored
    // using the same proven threshold-based approach already used in
    // calculateConsignmentBaseFromStoreOffer below (a naive
    // min(converted-10, converted/(1+percentage)) was both missing the
    // "-5" and less explicit about which branch actually applies).
    const threshold = 5 / percentage;
    const candidateFromFloor = converted - 10;
    const candidateFromPercentage = (converted - 5) / (1 + percentage);
    payout = candidateFromFloor <= threshold ? candidateFromFloor : candidateFromPercentage;
  } else if (Number.isFinite(margin) && margin > 0) {
    payout = converted - margin;
  } else {
    return null;
  }

  // A Dutch VAT21 seller is paid incl. 21% on top of what we pay them.
  // Only needed on the foreign-store branch — on the Dutch-store branch
  // the number never left the all-in scale in the first place.
  if (bridgeForeignVat21) {
    payout = payout * 1.21;
  }

  return roundDownToStep(payout, 2.5);
}

export function roundToNearestStep(value, step = 2.5) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n / step) * step;
}

// NEW — additive only: the FORWARD direction of the margin conversion
// above — given a seller's ask, what would the store need to pay so the
// seller still receives (approximately) that ask after margin. This is
// the exact inverse logic of the "Offer To Store" Airtable formula
// (Firm Range: add the margin; Percentage: apply the percentage with a
// minimum +€10 floor), rounded to the nearest €2.50 step rather than
// floored, matching that formula's ROUND(...) behavior. Needed so the
// ping-pong can compare the seller's and store's numbers on the SAME
// scale — without this, a seller's raw ask and a store's raw counter
// price look like two unrelated numbers even when the margin between
// them is the only real difference.
export function calculateStoreCounterEquivalent(sellerAskPrice, vatType, orderFields = {}, preAdjustmentMultiplier = 1) {
  let converted = getCounterEquivalentPriceForVatType(sellerAskPrice, vatType);

  if (!Number.isFinite(converted) || converted <= 0) return null;

  // NEW — additive only: his exact catch — applying a non-Dutch
  // display adjustment AFTER this function's own internal rounding
  // (roundToNearestStep below) loses precision (e.g. €192.50 becoming
  // €193.60). Applying it here, before the margin math and before the
  // single rounding step at the end, gives the exact same figure the
  // store originally saw on the fresh-offer embed.
  converted = converted * preAdjustmentMultiplier;

  const margin = numberValue(orderFields["Offer Margin"]);
  const percentage = numberValue(orderFields["Offer Percentage"]);
  const method = asText(orderFields["Offer Method"]);

  let storePrice;

  if (method === "Firm Range" && Number.isFinite(margin) && margin > 0) {
    storePrice = converted + margin;
  } else if (Number.isFinite(percentage) && percentage > 0) {
    // FIXED — his confirmed, deliberate design: the Airtable "Offer To
    // Store" formula's Percentage branch is
    // MAX(base+10, base*(1+pct)+5) — the "+5" was missing here,
    // producing a store price up to €5 lower than the formula would
    // give the exact same raw seller price for. Mirrors the already-
    // correct calculateStoreCustomOfferFromConsignmentBase below.
    storePrice = Math.max(
      converted + 10,
      converted * (1 + percentage) + 5
    );
  } else if (Number.isFinite(margin) && margin > 0) {
    storePrice = converted + margin;
  } else {
    return null;
  }

  return roundToNearestStep(storePrice, 2.5);
}

// NEW — additive only: the store types/sees/pays in the VAT-scale of
// the offer embed they're responding to. For a non-Dutch store
// responding to a VAT-source (VAT21/VAT0) position, that scale is
// excl.-VAT vs the internal all-in scale; for a Dutch store, or a
// Margin-source position, it's the plain all-in scale (÷1). This
// divisor converts an internal all-in figure back to what the store
// should SEE in a store-facing embed / the Portal.
// FIXED — the excl. divisor now uses the client's REAL VAT rate (e.g.
// 22% for Italy → ÷1.22) so the store's displayed "Your Previous
// Counter" matches the invoice's "Store Counter Price Excl VAT" (which
// also uses the real rate) instead of drifting by the 1.21-vs-1.22 gap
// (e.g. 220 all-in showed €181.82 but the invoice said €180.33). Falls
// back to 1.21 only if the rate field is missing. This is display-only
// — it does not touch any payout, band, or accept math.
// FIXED (F6b) — the divisor is back to a flat 1.21.
//
// It briefly used the client's real VAT rate (Italy ÷1.22) to make the
// displayed figure line up with "Store Counter Price Excl VAT". That
// fixed a visible symptom in the wrong place. The client rate has
// exactly one job in this system — turning a foreign store's all-in Max
// Buying Price into the VAT0 base — and after that everything is Dutch
// logic. This divisor is the inverse of storeInputMultiplier, which
// moves between the store's scale and the INTERNAL scale, and that
// transition is defined by the Dutch 21%, not by the store's local rate.
//
// Must stay in lockstep with storeInputMultiplier below AND with the
// Airtable formula "Store Counter Price Excl VAT" — see the deploy note
// in the audit report; changing one without the others breaks the
// round-trip between what a store types and what it is invoiced.
export function storeDisplayDivisor(storeVatContext, orderFields = {}) {
  const isDutch = isDutchClientCountry(orderFields["Client Country"]);
  const isVatSource = storeVatContext === "VAT21" || storeVatContext === "VAT0";
  if (isDutch || !isVatSource) return 1;
  return 1.21;
}

// NEW — additive only: the multiplier that converts a store's typed
// VAT0/VAT21 counter (in the store's own excl. scale) UP to the
// internal all-in scale for storage. Uses the client's REAL VAT rate
// (e.g. 22% Italy → ×1.22) so that "Store Counter Price Excl VAT"
// (which divides by that same real rate) comes back to EXACTLY what the
// store typed — e.g. store types €185 → stored 225.70 → excl €185, not
// the old ×1.21 → 223.85 → excl €183.48 mismatch. This is the exact
// inverse of storeDisplayDivisor, so input and display round-trip
// perfectly. Falls back to 1.21 if the rate field is missing. Does NOT
// affect the seller payout (that stays ÷1.21 — VAT21 is a real Dutch
// 21% and VAT0 payouts were already correct).
// FIXED (F6b) — flat 1.21, was (1 + Client VAT Rate).
//
// Using the client's rate here inflated every foreign store's counter by
// clientRate/1.21 before it ever reached the payout math, which then
// divided by 1.21 — so an Italian store's typed €148 became a €149.22
// payout base (+0.83%; +3.3% for a 25% country) and the seller was
// systematically overpaid. The comment that used to sit here claimed
// this "does NOT affect the seller payout"; it did.
//
// The parameter is kept so no call site has to change, and so the
// signature still says "this is per order" if the rule ever gains a
// per-order dimension again.
export function storeInputMultiplier(orderFields = {}) {
  return 1.21;
}

// NEW — additive only: computes the "Seller's New Counter" figure a
// store-facing embed should show, in the STORE's own scale. The
// seller's counter is already in the same VAT context the store is
// negotiating in (VAT0→VAT0 for a non-Dutch store on a VAT-source
// position — no ÷1.21 — or all-in for a Dutch store / Margin), so we
// apply the store's margin markup directly via the Margin path (no
// VAT deling), then the store-display divisor stays 1 in that case.
// For a Dutch store the internal all-in figure IS what they see, so
// the divisor is 1 there too. This mirrors his confirmed rule:
// "Seller's New Counter is the margin formula on the seller's
// counter, without ×1.21 for VAT0→VAT0, but ×1.21 if the store is
// Dutch."
// The VAT type a store SEES for a seller's position. Display only — the
// accept paths re-derive this server-side and never take it from here.
//
// The rule follows the CLIENT, never the seller:
//   Margin      -> Margin   (passes through untouched)
//   Dutch store -> VAT21    (Lojiq buys VAT0 abroad and sells VAT21 at
//                            home, so a NL store never sees VAT0)
//   otherwise   -> VAT0     (intracommunautair; the store self-accounts)
//
// FIXED — this used to `return type` for a non-Dutch store, i.e. the
// seller's OWN type. For a VAT0 seller that happens to be right, which
// is why it survived: VAT0 -> VAT0 either way. For a VAT21 seller it was
// wrong — an Italian store was shown "VAT21" on a Dutch seller's
// position while we invoice that store VAT0. Confirmed live on an
// Italian store with a VAT21 seller: correct amount, wrong label.
//
// The old comment claimed "non-Dutch clients keep the seller's own type
// unchanged (VAT0 stays VAT0)" — only the VAT0 case had been thought
// through. This now matches the rule already used by the four accept
// paths that write "Offer VAT Type", and by computeAndPushLowestOffer's
// outputVatType, so all three agree.
export function storeFacingVatType(sellerVatType, orderFields = {}) {
  const type = asText(sellerVatType);
  if (type === "Margin") return "Margin";
  if (isDutchClientCountry(orderFields["Client Country"])) return "VAT21";
  return "VAT0";
}

export function computeSellerCounterForStoreDisplay(sellerCounterPrice, storeVatContext, orderFields = {}) {
  const isDutch = isDutchClientCountry(orderFields["Client Country"]);
  const isVatSource = storeVatContext === "VAT21" || storeVatContext === "VAT0";

  if (!isDutch && isVatSource) {
    // A VAT0 seller's counter is already in the store's excl. scale, so
    // only the margin markup applies (Margin path = no VAT division).
    //
    // FIXED (F6c, display side) — a VAT21 seller's counter is NOT: that
    // number is Dutch all-in incl. 21%, while the store reads and pays
    // in VAT0 terms. It used to go through the same no-division Margin
    // path, so a foreign store was quoted roughly 21% too much for every
    // Dutch seller's counter — €196.06 showed as €217.50 instead of
    // €180.00. Because store-accept writes exactly this figure into
    // "Custom Offer", the store was then invoiced that inflated number.
    // This is the exact mirror of the payout-side bridge in
    // calculateCounterPayoutForVatType; the two are now inverses.
    const storeFacingBase = storeVatContext === "VAT21"
      ? sellerCounterPrice / 1.21
      : sellerCounterPrice;

    return calculateStoreCounterEquivalent(storeFacingBase, "Margin", orderFields);
  }

  // NEW — additive only: Dutch client + VAT0 seller. Lojiq is the
  // middleman — buys VAT0 abroad, sells VAT21 to the NL store — so a NL
  // store NEVER sees VAT0. Mirror the "Offer To Store" formula exactly:
  // "Lowest Offer" holds the seller's VAT0 price already grossed up
  // ×1.21 to the VAT21 sale base (the "Lowest Seller Offer (Normalized)"
  // field in computeAndPushLowestOffer), THEN the margin formula runs.
  // So gross up ×1.21 here, then route through the Margin path (margin
  // + 2.5-grid rounding, no further VAT division). e.g. 80 VAT0 →
  // 96.80 → MAX(106.80, 106.64) → 107.50 VAT21.
  if (isDutch && storeVatContext === "VAT0") {
    return calculateStoreCounterEquivalent(sellerCounterPrice * 1.21, "Margin", orderFields);
  }

  // Dutch store (VAT21 or Margin source), or Margin source generally:
  // the store sees the plain all-in figure, computed with the seller's
  // real VAT type (which applies ÷1.21 internally for VAT0 — not hit
  // here anymore for a Dutch store — giving the incl. all-in expected).
  return calculateStoreCounterEquivalent(sellerCounterPrice, storeVatContext, orderFields);
}

// NEW — additive only: replicates the EXACT VAT-exclusion rule used
// downstream in calculateLinkedUnitPrice.js (the Airtable automation
// that sets the order's Final Buying Price): only divide by 1.21 when
// the client is Dutch AND the seller's VAT type is VAT21 — otherwise
// leave the number as-is. Used to compute a correct
// store_counter_price_excl_vat for the accept webhook when the
// Airtable formula field it would normally read is empty (seller-
// placed rounds never populate "Store Counter Price", so the formula
// derived from it comes back empty too).
export function computeStoreExclVatForOrder(storeAllInPrice, vatType, orderFields = {}) {
  const price = Number(storeAllInPrice);
  if (!Number.isFinite(price)) return null;

  const clientCountry = asText(orderFields["Client Country"]).toLowerCase();
  const type = asText(vatType).toUpperCase().replace(/\s+/g, "");

  if (clientCountry.includes("netherland") && type === "VAT21") {
    return Math.round((price / 1.21) * 100) / 100;
  }

  return Math.round(price * 100) / 100;
}

// NEW — additive only: the value to write into "Custom Offer" when a
// deal is accepted. calculateLinkedUnitPrice.js takes Custom Offer
// essentially 1:1 (it only divides by 1.21 for a NL + VAT21 order, to
// force the VAT-exclusive Final Buying Price a Dutch VAT product
// requires). So Custom Offer must ALREADY be on the right scale per
// VAT type:
//   - VAT21 (only ever a NL store): store was offered/accepted an
//     ALL-IN figure → write the all-in Store Counter Price; the
//     downstream script divides it by 1.21 itself.
//   - VAT0 (only ever a non-NL store): we invoice that store VAT-
//     EXCLUSIVE, and the downstream script does NOT divide for VAT0 →
//     so Custom Offer must already be the excl. figure. Use the
//     Airtable-computed "Store Counter Price Excl VAT" (which uses the
//     client's real VAT rate, e.g. 22% for Italy — more correct than a
//     hardcoded 1.21), falling back to the store all-in price if that
//     field is somehow empty.
//   - Margin: no VAT at all → the full Store Counter Price.
// This is the fix for "accepted a VAT0 deal but the store got invoiced
// the full incl. price": Custom Offer was the all-in figure with VAT
// type VAT0, and the downstream script took it as-is (no VAT0 branch
// there), so the store was billed the gross amount instead of the net.
export function customOfferValueForAccept(vatType, storeAllInPrice, storeExclVatPrice) {
  const type = asText(vatType).toUpperCase().replace(/\s+/g, "");
  const allIn = Number(storeAllInPrice);

  if (type === "VAT0") {
    const excl = Number(storeExclVatPrice);
    if (Number.isFinite(excl) && excl > 0) return excl;
    // Fallback only if the Excl VAT formula field is unexpectedly empty.
    return Number.isFinite(allIn) ? allIn : null;
  }

  // VAT21 and Margin: write the all-in Store Counter Price unchanged.
  return Number.isFinite(allIn) ? allIn : null;
}

// Member WTB margin between seller and buyer.
//
// FIXED — this returned a hardcoded 10 while BOTH other readers of the
// same margin already honoured the per-record field: the Airtable
// formula "Offer To Buyer" uses IF({Offer Margin}, {Offer Margin}, 10)
// and process-seller-offer read memberFields['Offer Margin']. So the
// moment "Offer Margin" was set to anything other than 10, every
// negotiation price computed here (buyer equivalents, seller payouts,
// band validation, DM amounts) silently disagreed with the Final Buying
// Price and with what Airtable displayed. Confirmed decision: the field
// is the single source of truth, with 10 as the default.
//
// The fallback deliberately mirrors Airtable's IF({x}, {x}, 10)
// truthiness EXACTLY, so the two can never diverge again:
//   - blank / non-numeric -> 10
//   - 0                   -> 10   (0 is falsy in Airtable too)
//   - any other number    -> that number
// numberValue() also unwraps a single-element array and maps
// non-numeric to 0, which closes the old `Number([] || 10)` trap in
// process-seller-offer (an empty lookup array is truthy in JS, so that
// produced a silent margin of 0).
export function getMemberWtbMargin(memberWtbFields = {}) {
  const configured = numberValue(memberWtbFields["Offer Margin"]);
  return configured !== 0 ? configured : 10;
}

export function memberWtbIsReverseCharge(memberWtbFields = {}) {
  const buyerVatId = asText(memberWtbFields["Buyer VAT ID"]);
  const buyerCountry = asText(memberWtbFields["Buyer Country"]);
  return !!buyerVatId && buyerCountry !== "Netherlands" && buyerCountry !== "Nederland";
}

export function memberWtbBuyerFacingVatType(sellerVatType, memberWtbFields = {}) {
  const type = asText(sellerVatType);
  // Margin is always shown as Margin (it passes through unchanged).
  if (type === "Margin") return "Margin";
  // A reverse-charge buyer (outside NL, has a VAT ID) always buys VAT0
  // from Kickz Caviar B.V. — an intracommunautaire levering, so the
  // buyer-facing label is VAT0 regardless of the underlying seller's own
  // VAT type (a VAT21 seller still shows VAT0 to a foreign buyer; only
  // the amount conversion differs, handled in calculateMemberWtbBuyerEquivalent).
  // A domestic/NL buyer buys VAT21 from Lojiq. Margin passed through above.
  return memberWtbIsReverseCharge(memberWtbFields) ? "VAT0" : "VAT21";
}

export function calculateMemberWtbBuyerEquivalent(sellerAskPrice, vatType, memberWtbFields = {}) {
  const price = Number(sellerAskPrice);
  if (!Number.isFinite(price) || price <= 0) return null;

  const margin = getMemberWtbMargin(memberWtbFields);
  const type = asText(vatType);

  if (type === "Margin") {
    return Math.round((price + margin) * 100) / 100;
  }

  const reverseCharge = memberWtbIsReverseCharge(memberWtbFields);

  if (reverseCharge) {
    const result = type === "VAT21" ? (price / 1.21) + margin : price + margin;
    return Math.round(result * 100) / 100;
  }

  const result = type === "VAT21" ? ((price / 1.21) + margin) * 1.21 : (price + margin) * 1.21;
  return Math.round(result * 100) / 100;
}

export function calculateMemberWtbSellerPayout(buyerPrice, vatType, memberWtbFields = {}) {
  const price = Number(buyerPrice);
  if (!Number.isFinite(price) || price <= 0) return null;

  const margin = getMemberWtbMargin(memberWtbFields);
  const type = asText(vatType);

  if (type === "Margin") {
    return Math.round((price - margin) * 100) / 100;
  }

  const reverseCharge = memberWtbIsReverseCharge(memberWtbFields);

  if (reverseCharge) {
    const result = type === "VAT21" ? (price - margin) * 1.21 : price - margin;
    return Math.round(result * 100) / 100;
  }

  const grossless = price / 1.21;
  const result = type === "VAT21" ? (grossless - margin) * 1.21 : grossless - margin;
  return Math.round(result * 100) / 100;
}

export function isDutchClientCountry(country) {
  const value = asText(country).toLowerCase();

  return [
    "nl",
    "nederland",
    "netherlands",
    "the netherlands"
  ].includes(value);
}
