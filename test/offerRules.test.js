import test from "node:test";
import assert from "node:assert/strict";

import {
  blockingOfferOnStock,
  normalizeSourceType,
  isOpenForOffers,
  allowedVatTypesForMemberWtb,
  vatTypesForSeller,
  offerableVatTypes
} from "../lib/offerRules.js";

test("source type uit de URL wordt genormaliseerd, rommel wordt geweigerd", () => {
  assert.equal(normalizeSourceType("order"), "order");
  assert.equal(normalizeSourceType("member-wtb"), "member_wtb");
  assert.equal(normalizeSourceType("member_wtb"), "member_wtb");
  assert.equal(normalizeSourceType("MEMBER-WTB"), "member_wtb");
  assert.equal(normalizeSourceType("consignment"), null);
  assert.equal(normalizeSourceType(""), null);
});

test("een store-order is alleen open bij Outsource", () => {
  assert.equal(isOpenForOffers({ sourceType: "order", fulfillmentStatus: "Outsource" }).open, true);

  for (const status of ["Claim Processing", "Fulfilled", "Cancelled", ""]) {
    const result = isOpenForOffers({ sourceType: "order", fulfillmentStatus: status });
    assert.equal(result.open, false, status);
    assert.match(result.reason, /no longer open/);
  }
});

test("een member WTB is open tenzij hij een eindstatus heeft", () => {
  for (const status of ["", "Open", "Offer Sent", "Negotiating"]) {
    assert.equal(isOpenForOffers({ sourceType: "member_wtb", fulfillmentStatus: status }).open, true, status);
  }

  for (const status of ["Confirmed", "Allocated", "Fulfilled", "Cancelled"]) {
    assert.equal(isOpenForOffers({ sourceType: "member_wtb", fulfillmentStatus: status }).open, false, status);
  }
});

test("het koperfilter bepaalt welke VAT-types de WTB accepteert", () => {
  assert.deepEqual(allowedVatTypesForMemberWtb("B2B Only"), ["VAT0", "VAT21"]);
  assert.deepEqual(allowedVatTypesForMemberWtb("Margin Only"), ["Margin"]);
  assert.deepEqual(allowedVatTypesForMemberWtb("Private Only"), ["Margin"]);
  assert.deepEqual(allowedVatTypesForMemberWtb(""), ["Margin", "VAT0", "VAT21"]);
  assert.deepEqual(allowedVatTypesForMemberWtb("Iets anders"), ["Margin", "VAT0", "VAT21"]);
});

test("zonder VAT ID kan een seller alleen Margin", () => {
  assert.deepEqual(vatTypesForSeller({ vatId: "", country: "Netherlands" }), ["Margin"]);
  assert.deepEqual(vatTypesForSeller({ vatId: "   ", country: "Germany" }), ["Margin"]);
});

test("Nederlands bedrijf krijgt VAT21, niet-Nederlands krijgt VAT0", () => {
  assert.deepEqual(vatTypesForSeller({ vatId: "NL1", country: "Netherlands" }), ["Margin", "VAT21"]);
  assert.deepEqual(vatTypesForSeller({ vatId: "DE1", country: "Germany" }), ["Margin", "VAT0"]);
  assert.deepEqual(vatTypesForSeller({ vatId: "IE1", country: "Ireland" }), ["Margin", "VAT0"]);
});

test("op een store-order telt alleen wat de seller mag", () => {
  assert.deepEqual(
    offerableVatTypes({ sourceType: "order", vatId: "NL1", country: "Netherlands" }),
    ["Margin", "VAT21"]
  );
});

test("op een member WTB geldt de doorsnede van koperfilter en seller", () => {
  // Nederlands bedrijf (Margin, VAT21) op een B2B Only WTB (VAT0, VAT21).
  assert.deepEqual(
    offerableVatTypes({
      sourceType: "member_wtb",
      buyingInventoryFilter: "B2B Only",
      vatId: "NL1",
      country: "Netherlands"
    }),
    ["VAT21"]
  );

  // Duits bedrijf (Margin, VAT0) op dezelfde WTB.
  assert.deepEqual(
    offerableVatTypes({
      sourceType: "member_wtb",
      buyingInventoryFilter: "B2B Only",
      vatId: "DE1",
      country: "Germany"
    }),
    ["VAT0"]
  );
});

test("particulier op een B2B Only WTB houdt niets over", () => {
  // Deze seller kan hier onmogelijk bieden; de pagina moet dat tonen in plaats
  // van hem een offer te laten insturen die de bot toch afwijst.
  assert.deepEqual(
    offerableVatTypes({
      sourceType: "member_wtb",
      buyingInventoryFilter: "B2B Only",
      vatId: "",
      country: "Netherlands"
    }),
    []
  );
});

test("bedrijf op een Margin Only WTB houdt Margin over", () => {
  assert.deepEqual(
    offerableVatTypes({
      sourceType: "member_wtb",
      buyingInventoryFilter: "Margin Only",
      vatId: "NL1",
      country: "Netherlands"
    }),
    ["Margin"]
  );
});

const LINK = "Linked Orders";

function offerOn(order, fields = {}) {
  return { id: `off-${order}`, fields: { [LINK]: [order], ...fields } };
}

test("een lopende offer op dezelfde voorraad blokkeert een nieuwe ronde", () => {
  const blocking = blockingOfferOnStock({
    offers: [offerOn("recOTHER"), offerOn("recORDER")],
    sourceRecordId: "recORDER",
    offerLink: LINK
  });

  assert.equal(blocking?.id, "off-recORDER");
});

test("een offer van een andere order telt niet mee", () => {
  assert.equal(
    blockingOfferOnStock({
      offers: [offerOn("recOTHER")],
      sourceRecordId: "recORDER",
      offerLink: LINK
    }),
    null
  );
});

test("withdrawn blijft blokkeren: dezelfde man niet twee keer dezelfde vraag", () => {
  const blocking = blockingOfferOnStock({
    offers: [offerOn("recORDER", { "Withdrawn?": true })],
    sourceRecordId: "recORDER",
    offerLink: LINK
  });

  assert.equal(blocking?.id, "off-recORDER");
});

test("de retry mag langs een withdrawn offer, want dat was 'geen voorraad'", () => {
  assert.equal(
    blockingOfferOnStock({
      offers: [offerOn("recORDER", { "Withdrawn?": true })],
      sourceRecordId: "recORDER",
      offerLink: LINK,
      waiveWithdrawn: true
    }),
    null
  );
});

test("de retry mag NIET langs een offer die nog open staat", () => {
  const blocking = blockingOfferOnStock({
    offers: [offerOn("recORDER")],
    sourceRecordId: "recORDER",
    offerLink: LINK,
    waiveWithdrawn: true
  });

  assert.equal(blocking?.id, "off-recORDER");
});

test("zonder order of linkveld valt er niets te blokkeren", () => {
  assert.equal(blockingOfferOnStock({ offers: [offerOn("recORDER")], offerLink: LINK }), null);
  assert.equal(blockingOfferOnStock({ offers: [offerOn("recORDER")], sourceRecordId: "recORDER" }), null);
  assert.equal(blockingOfferOnStock(), null);
});
