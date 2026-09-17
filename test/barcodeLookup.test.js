import test from "node:test";
import assert from "node:assert/strict";

import {
  cleanBarcode,
  barcodeForms,
  sameBarcode,
  euSizeOf,
  findVariantForBarcode,
  barcodeRowsForVariants,
  pickOwnSku,
  isUnknownBarcodeError
} from "../lib/barcodeLookup.js";

// Trimmed from the real StockX answer for CZ0790-110.
const variant = (eu, gtins) => ({
  variantValue: "6",
  sizeChart: {
    availableConversions: [
      { size: "US M 6", type: "us m" },
      { size: `EU ${eu}`, type: "eu" }
    ]
  },
  gtins
});

const BARONS = [
  variant("38.5", [
    { identifier: "197600075078", type: "UPC" },
    { identifier: "3810654400180", type: "EAN-13" }
  ]),
  variant("42", [{ identifier: "197600040076", type: "UPC" }]),
  variant("44 1/2", [{ identifier: "0197600011111", type: "EAN-13" }]),
  variant("42", [{ identifier: "197600099999", type: "UPC" }])
];

test("a scanned code is digits only, 8 to 14 long", () => {
  assert.equal(cleanBarcode(" 0197600040076 "), "0197600040076");
  assert.equal(cleanBarcode("CZ0790-110"), "");
  assert.equal(cleanBarcode("1234567"), "");
  assert.equal(cleanBarcode(null), "");
});

test("a UPC-A is looked up in every length it can be stored in", () => {
  assert.deepEqual(barcodeForms("197600040076"), [
    "197600040076",
    "0197600040076",
    "00197600040076"
  ]);

  assert.deepEqual(barcodeForms("0197600040076"), [
    "0197600040076",
    "197600040076",
    "00197600040076"
  ]);
});

test("a real EAN-13 is not shortened into a code it is not", () => {
  assert.deepEqual(barcodeForms("3810654400180"), [
    "3810654400180",
    "03810654400180"
  ]);
});

test("a GTIN-8 only matches itself", () => {
  assert.deepEqual(barcodeForms("01234565"), ["01234565"]);
});

test("leading zeros do not make two barcodes different", () => {
  assert.equal(sameBarcode("197600040076", "0197600040076"), true);
  assert.equal(sameBarcode("197600040076", "197600040077"), false);
  assert.equal(sameBarcode("", ""), false);
});

test("EU size is written the way consignment stock writes it", () => {
  assert.equal(euSizeOf(variant("44 1/2", [])), "44.5");
  assert.equal(euSizeOf(variant("38 2/3", [])), "38 2/3");
  assert.equal(euSizeOf(variant("42.0", [])), "42");
});

test("the scanned barcode picks its own size, in either form", () => {
  assert.equal(findVariantForBarcode(BARONS, "0197600040076").size, "42");
  assert.equal(findVariantForBarcode(BARONS, "3810654400180").size, "38.5");
  assert.equal(findVariantForBarcode(BARONS, "197600075078").size, "38.5");
  assert.equal(findVariantForBarcode(BARONS, "5059244580001"), null);
});

test("bol_barcodes rows keep the thirteen and twelve digit forms apart", () => {
  const rows = barcodeRowsForVariants("CZ0790-110", BARONS);

  assert.deepEqual(rows, [
    { sku: "CZ0790-110", size: "38.5", ean: "3810654400180", gtin: "197600075078" },
    { sku: "CZ0790-110", size: "42", ean: "0197600040076", gtin: "197600040076" },
    { sku: "CZ0790-110", size: "44.5", ean: "0197600011111", gtin: "197600011111" }
  ]);
});

test("a bundled style id resolves to the code we already hold", () => {
  assert.equal(pickOwnSku("315115-112/DD8959-100", ["DD8959-100"]), "DD8959-100");
  assert.equal(pickOwnSku("315115-112/DD8959-100", []), "315115-112");
  assert.equal(pickOwnSku("cz0790-110"), "CZ0790-110");
  assert.equal(pickOwnSku(""), "");
});

test("only StockX's own not-found answer counts as an unknown barcode", () => {
  const unknown = { status: 404, body: { errorMessage: "No product found for GTIN." } };

  assert.equal(isUnknownBarcodeError(unknown), true);
  assert.equal(isUnknownBarcodeError({ status: 429, body: {} }), false);
  assert.equal(isUnknownBarcodeError({ status: 404, body: {} }), false);
});
