import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeIntake,
  orderPairsForSale,
  orderPairsForForwarding,
  priceDifferences
} from "../lib/partnerStock.js";

const pair = (id, extra) => ({
  id,
  status: "in_stock",
  mode: "consignment",
  sku: "MIHARA",
  size: "42",
  partner_price: 100,
  markup: 25,
  received_at: "2026-09-10T10:00:00Z",
  ...extra
});

test("an intake merges lines of the same size and price", () => {
  const { lines, errors } = normalizeIntake({
    mode: "consignment",
    items: [
      { barcode: "111", sku: "mihara", size: "42", quantity: 1, partner_price: "100", markup: "25" },
      { barcode: "222", sku: "MIHARA", size: "42", quantity: 2, partner_price: 100, markup: 25 },
      { barcode: "333", sku: "MIHARA", size: "42", quantity: 1, partner_price: 110, markup: 25 }
    ]
  });

  assert.deepEqual(errors, []);
  assert.deepEqual(lines, [
    { sku: "MIHARA", size: "42", barcode: "111", quantity: 3, partner_price: 100, markup: 25 },
    { sku: "MIHARA", size: "42", barcode: "333", quantity: 1, partner_price: 110, markup: 25 }
  ]);
});

test("a listed pair needs a partner price, a forwarded one does not", () => {
  const listed = normalizeIntake({
    mode: "both",
    items: [{ sku: "A", size: "42", quantity: 1, partner_price: "", markup: 10 }]
  });

  assert.deepEqual(listed.errors, ["A / 42: partner price is required"]);

  const forwarded = normalizeIntake({
    mode: "forwarding",
    items: [{ sku: "A", size: "42", quantity: 2 }]
  });

  assert.deepEqual(forwarded.errors, []);
  assert.deepEqual(forwarded.lines, [
    { sku: "A", size: "42", barcode: null, quantity: 2, partner_price: null, markup: 0 }
  ]);
});

test("every problem in a parcel is reported at once", () => {
  const { errors } = normalizeIntake({
    mode: "consignment",
    items: [
      { sku: "", size: "42", quantity: 1, partner_price: 100 },
      { sku: "B", size: "43", quantity: 0, partner_price: 100 },
      { sku: "C", size: "44", quantity: 1, partner_price: 100, markup: -5 },
      { sku: "D", size: "45", quantity: 1, partner_price: "12,50", markup: "2,5" }
    ]
  });

  assert.deepEqual(errors, [
    "Line 1: SKU and size are required",
    "B / 43: quantity must be a whole number from 1 to 200",
    "C / 44: markup cannot be negative"
  ]);
});

test("an unknown mode is refused", () => {
  assert.deepEqual(normalizeIntake({ mode: "direct", items: [] }).errors, ['Unknown mode "direct"']);
});

test("a sale takes the cheapest listed pair, oldest first", () => {
  const order = orderPairsForSale([
    pair("expensive", { partner_price: 110 }),
    pair("newer", { received_at: "2026-09-12T10:00:00Z" }),
    pair("older"),
    pair("forward-only", { mode: "forwarding", partner_price: null }),
    pair("gone", { status: "sold", partner_price: 50 })
  ]).map((p) => p.id);

  assert.deepEqual(order, ["older", "newer", "expensive"]);
});

test("a forward takes forward-only pairs first, then the priciest listed pair", () => {
  const order = orderPairsForForwarding([
    pair("cheap-both", { mode: "both", partner_price: 90 }),
    pair("dear-both", { mode: "both", partner_price: 130 }),
    pair("listed-only"),
    pair("fwd-new", { mode: "forwarding", partner_price: null, received_at: "2026-09-12T10:00:00Z" }),
    pair("fwd-old", { mode: "forwarding", partner_price: null })
  ]).map((p) => p.id);

  assert.deepEqual(order, ["fwd-old", "fwd-new", "dear-both", "cheap-both"]);
});

test("a different price for pairs already on the shelf is pointed out", () => {
  const notes = priceDifferences(
    [pair("a"), pair("b"), pair("c", { size: "43" })],
    [
      { sku: "MIHARA", size: "42", quantity: 1, partner_price: 110, markup: 25 },
      { sku: "MIHARA", size: "43", quantity: 1, partner_price: 100, markup: 25 }
    ]
  );

  assert.equal(notes.length, 1);
  assert.match(notes[0], /MIHARA \/ 42: 2 pair\(s\) already in stock at 100 \+ 25/);
});
