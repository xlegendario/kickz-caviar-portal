// ---------------------------------------------------------------------
// Generates the expected amounts for the post-deploy test checklist,
// straight out of lib/pricing.js — so the numbers in the checklist are
// what the code actually computes, not what someone worked out by hand.
//
//   node tools/scenario-values.mjs
//
// Edit STORES below to match your real merchants (country, VAT rate,
// Offer Method / Percentage / Margin) and re-run to get a checklist
// tailored to your own test accounts.
//
// Deliberately NOT in test/ — `node --test` scans that directory.
// ---------------------------------------------------------------------

import {
  computeSellerCounterForStoreDisplay,
  calculateCounterPayoutForVatType,
  calculateStoreCounterEquivalent,
  customOfferValueForAccept,
  storeInputMultiplier,
  storeDisplayDivisor,
  isDutchClientCountry,
  calculateMemberWtbBuyerEquivalent,
  calculateMemberWtbSellerPayout,
  getMemberWtbNetSalePrice,
  getMemberWtbMargin,
  memberWtbIsReverseCharge,
  memberWtbBuyerFacingVatType,
  asText
} from "../lib/pricing.js";

// ------------------------- CONFIGURE ME -------------------------------
const STORES = {
  IT: { label: "Italië",      "Client Country": ["Italy"],       "Client VAT Rate": [0.22], "Offer Method": ["Percentage"], "Offer Percentage": [0.05] },
  NL: { label: "Nederland",   "Client Country": ["Netherlands"], "Client VAT Rate": [0.21], "Offer Method": ["Percentage"], "Offer Percentage": [0.05] },
  DK: { label: "Denemarken",  "Client Country": ["Denmark"],     "Client VAT Rate": [0.25], "Offer Method": ["Percentage"], "Offer Percentage": [0.05] }
};

const BUYERS = {
  nl:      { label: "NL-koper",              "Buyer Country": ["Netherlands"], "Buyer VAT ID": ["NL0001"] },
  reverse: { label: "reverse-charge koper",  "Buyer Country": ["Italy"],       "Buyer VAT ID": ["IT0001"] },
  noVatId: { label: "buitenland zonder BTW", "Buyer Country": ["Italy"] }
};
// ----------------------------------------------------------------------

const eur = (n) => (n === null || n === undefined || Number.isNaN(n) ? "—" : `€${Number(n).toFixed(2)}`);
const rule = (t) => console.log(`\n${"=".repeat(74)}\n${t}\n${"=".repeat(74)}`);

// The Airtable side, mirrored so the chain can be shown end to end.
const exclVatFormula = (storeCounterPrice) => storeCounterPrice / 1.21;      // NA de wijziging
const exclVatFormulaOld = (scp, store) => scp / (1 + Number(store["Client VAT Rate"][0])); // huidige
const finalBuyingPriceStore = (customOffer, offerVatType, store) =>
  Math.round((asText(store["Client Country"]).toLowerCase().includes("netherland") && offerVatType === "VAT21"
    ? customOffer / 1.21 : customOffer) * 100) / 100;
// Airtable: Unfulfilled Orders Log."Invoice Price (VAT Included)".
// LET OP: {VAT Type} daar is een lookup via {Linked Inventory Unit} —
// dus het VAT-type van de SELLER, niet het store-facing {Offer VAT Type}.
// Bij een Margin-unit wordt er nooit BTW bijgeteld, ook niet voor een
// Nederlandse store.
const invoiceStore = (fbp, store, sellerVatType) =>
  isDutchClientCountry(store["Client Country"]) && (sellerVatType === "VAT0" || sellerVatType === "VAT21")
    ? Math.round(fbp * 1.21 * 100) / 100
    : fbp;

const offerVatTypeFor = (sellerVat, store) =>
  sellerVat === "Margin" ? "Margin" : (isDutchClientCountry(store["Client Country"]) ? "VAT21" : "VAT0");

function storeOrderChain({ storeKey, sellerVat, sellerAsk, storeTypes }) {
  const store = STORES[storeKey];
  const isDutch = isDutchClientCountry(store["Client Country"]);
  const isVatSource = sellerVat === "VAT0" || sellerVat === "VAT21";
  const scales = !isDutch && isVatSource;

  console.log(`\n  Store ${store.label} · seller ${sellerVat} · vraagt ${eur(sellerAsk)}`);

  const shown = computeSellerCounterForStoreDisplay(sellerAsk, sellerVat, store);
  console.log(`    1. store ziet de counter van de seller als        ${eur(shown)}`);

  // Store accepteert die counter meteen (store-accept -> Custom Offer = de getoonde figuur)
  const ovt = offerVatTypeFor(sellerVat, store);
  const fbpA = finalBuyingPriceStore(shown, ovt, store);
  console.log(`       -> store ACCEPTEERT: Custom Offer ${eur(shown)} (${ovt}) · Final Buying Price ${eur(fbpA)} · factuur ${eur(invoiceStore(fbpA, store, sellerVat))}`);

  // Of de store countert terug
  const stored = scales ? storeTypes * storeInputMultiplier(store) : storeTypes;
  const excl = exclVatFormula(stored);
  const exclOld = exclVatFormulaOld(stored, store);
  const payout = calculateCounterPayoutForVatType(stored, sellerVat, store);
  const backToStore = stored / storeDisplayDivisor(sellerVat, store);

  console.log(`    2. store COUNTERT ${eur(storeTypes)}`);
  console.log(`       Store Counter Price (opgeslagen)               ${eur(stored)}${scales ? "  (= getypt x 1,21)" : "  (niet geschaald)"}`);
  console.log(`       Store Counter Price Excl VAT  NA de wijziging  ${eur(excl)}`);
  console.log(`                                     nu (fout)        ${eur(exclOld)}${Math.abs(excl - exclOld) < 0.005 ? "  (gelijk)" : ""}`);
  console.log(`       store ziet z'n eigen counter terug als         ${eur(backToStore)}`);
  console.log(`       seller ziet payout                             ${eur(payout)}`);

  const customOffer = customOfferValueForAccept(ovt, stored, excl);
  const fbpB = finalBuyingPriceStore(customOffer, ovt, store);
  console.log(`       -> seller ACCEPTEERT: Custom Offer ${eur(customOffer)} (${ovt}) · Final Buying Price ${eur(fbpB)} · factuur ${eur(invoiceStore(fbpB, store, sellerVat))}`);
}

function ceilingCheck({ storeKey, maxBuyingPrice }) {
  const store = STORES[storeKey];
  const rate = Number(store["Client VAT Rate"][0]);
  const grid = (x) => Math.round(x / 2.5) * 2.5;
  const base = maxBuyingPrice * 0.95 - 5;
  const MIN_UNDERCUT = 2.5;
  console.log(`\n  Store ${store.label} · Maximum Buying Price ${eur(maxBuyingPrice)}`);
  console.log(`    Final Outsource Buying Price (VAT 0%)  nu /1.21    ${eur(grid(base / 1.21))}`);
  console.log(`                                           na /(1+r)   ${eur(grid(base / (1 + rate)))}`);
  console.log(`    max toegestane VAT0-offer, 1e bieder   nu          ${eur(Math.floor((maxBuyingPrice - MIN_UNDERCUT) / 1.21))}`);
  console.log(`                                           na          ${eur(Math.floor((maxBuyingPrice - MIN_UNDERCUT) / (1 + rate)))}`);
}

function memberWtbChain({ sellerVat, sellerAsk, buyerKey, offerMargin }) {
  const wtb = { ...BUYERS[buyerKey], "Offer Margin": [offerMargin] };
  const margin = getMemberWtbMargin(wtb);
  const rc = memberWtbIsReverseCharge(wtb);
  const buyerPrice = calculateMemberWtbBuyerEquivalent(sellerAsk, sellerVat, wtb);
  const back = calculateMemberWtbSellerPayout(buyerPrice, sellerVat, wtb);
  const label = memberWtbBuyerFacingVatType(sellerVat, wtb);

  let fbp;
  if (sellerVat === "VAT0") fbp = sellerAsk + margin;
  else if (sellerVat === "VAT21") fbp = sellerAsk / 1.21 + margin;
  else fbp = sellerAsk + margin;
  fbp = Math.round(fbp * 100) / 100;
  const invoice = (sellerVat === "VAT0" || sellerVat === "VAT21") && !rc
    ? Math.round(fbp * 1.21 * 100) / 100 : fbp;

  console.log(`\n  seller ${sellerVat} vraagt ${eur(sellerAsk)} · ${BUYERS[buyerKey].label} · Offer Margin ${eur(margin)}`);
  console.log(`    koper ziet                    ${eur(buyerPrice)}  (label ${label})`);
  console.log(`    payout terug naar seller      ${eur(back)}   ${Math.abs(back - sellerAsk) < 0.02 ? "(round-trip sluit)" : "!! WIJKT AF !!"}`);
  console.log(`    inventory-unit VAT Type       ${sellerVat}  · Purchase Price ${eur(sellerAsk)}`);
  console.log(`    Final Buying Price            ${eur(fbp)}`);
  console.log(`    Invoice Price / Mollie        ${eur(invoice)}`);
}

function kcOwnedChain({ unitVat, maxPrice, buyerKey, filter }) {
  const wtb = BUYERS[buyerKey];
  const nowValue = getMemberWtbNetSalePrice(maxPrice, unitVat, filter, wtb);
  const before = getMemberWtbNetSalePrice(maxPrice, unitVat, filter); // zonder koper-context = oud gedrag
  const rc = memberWtbIsReverseCharge(wtb);
  const invoice = (unitVat === "VAT0" || unitVat === "VAT21") && !rc
    ? Math.round(nowValue * 1.21 * 100) / 100 : nowValue;
  console.log(`\n  KC-voorraad ${unitVat} · filter "${filter}" · Max Price ${eur(maxPrice)} · ${wtb.label}`);
  console.log(`    Final Buying Price   vóór F3  ${eur(before)}`);
  console.log(`                         ná F3    ${eur(nowValue)}${Math.abs(before - nowValue) > 0.005 ? "   <-- GEWIJZIGD" : "   (ongewijzigd)"}`);
  console.log(`    Invoice Price                 ${eur(invoice)}`);
}

// =====================================================================
rule("A. STORE ORDERS — buitenlandse store (de gewijzigde paden)");
storeOrderChain({ storeKey: "IT", sellerVat: "VAT21", sellerAsk: 196.06, storeTypes: 180 });
storeOrderChain({ storeKey: "IT", sellerVat: "VAT0",  sellerAsk: 140,    storeTypes: 148 });
storeOrderChain({ storeKey: "DK", sellerVat: "VAT21", sellerAsk: 196.06, storeTypes: 180 });

rule("B. STORE ORDERS — controlegroep, mag NIET veranderen");
storeOrderChain({ storeKey: "NL", sellerVat: "VAT21",  sellerAsk: 196.06, storeTypes: 242 });
storeOrderChain({ storeKey: "NL", sellerVat: "VAT0",   sellerAsk: 140,    storeTypes: 242 });
storeOrderChain({ storeKey: "IT", sellerVat: "Margin", sellerAsk: 200,    storeTypes: 210 });
storeOrderChain({ storeKey: "NL", sellerVat: "Margin", sellerAsk: 200,    storeTypes: 210 });

rule("C. VAT0-PLAFOND voor de eerste bieder (F6a)");
ceilingCheck({ storeKey: "IT", maxBuyingPrice: 440 });
ceilingCheck({ storeKey: "DK", maxBuyingPrice: 510 });
ceilingCheck({ storeKey: "NL", maxBuyingPrice: 440 });

rule("D. MEMBER WTB — open flow (marge uit Offer Margin, F2)");
for (const m of [10, 5]) {
  console.log(`\n  --- Offer Margin ${eur(m)} ---`);
  memberWtbChain({ sellerVat: "VAT21",  sellerAsk: 146, buyerKey: "reverse", offerMargin: m });
  memberWtbChain({ sellerVat: "VAT21",  sellerAsk: 146, buyerKey: "nl",      offerMargin: m });
  memberWtbChain({ sellerVat: "VAT0",   sellerAsk: 120, buyerKey: "reverse", offerMargin: m });
  memberWtbChain({ sellerVat: "VAT0",   sellerAsk: 120, buyerKey: "nl",      offerMargin: m });
  memberWtbChain({ sellerVat: "Margin", sellerAsk: 200, buyerKey: "nl",      offerMargin: m });
}

rule("E. MEMBER WTB — KC-voorraad / consignment (F3 reverse-charge)");
kcOwnedChain({ unitVat: "VAT21",  maxPrice: 200, buyerKey: "reverse", filter: "All Inventory" });
kcOwnedChain({ unitVat: "VAT21",  maxPrice: 200, buyerKey: "nl",      filter: "All Inventory" });
kcOwnedChain({ unitVat: "VAT0",   maxPrice: 200, buyerKey: "reverse", filter: "All Inventory" });
kcOwnedChain({ unitVat: "VAT21",  maxPrice: 200, buyerKey: "reverse", filter: "B2B Only" });
kcOwnedChain({ unitVat: "Margin", maxPrice: 200, buyerKey: "nl",      filter: "All Inventory" });

console.log("\n");
