import test from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";

import {
  deriveWantToBuyEventTypes,
  fingerprintWantToBuy,
  sampleWantToBuy,
  serializeWantToBuy,
  syncWantToBuys,
  wantToBuyRowFromRecord
} from "../lib/sellerApiWantToBuys.js";
import { sendTestEvent } from "../lib/sellerApi.js";
import { WEBHOOK_EVENTS } from "../lib/sellerApiWebhooks.js";

const record = (id, fields) => ({
  id,
  fields: {
    "Member WTB ID": "MWTB-000470",
    SKU: "DZ5485-612",
    Size: "42",
    "Buyer Seller ID": ["recBUYER"],
    "Purchase Status": "Offers Sent",
    "Fulfillment Status": "Outsource",
    "Payment Status": "Pending",
    ...fields
  }
});

/* ---------------- what a purchase looks like ---------------- */

test("a Member WTB carries the buyer's whole purchase: invoice, payment and tracking", () => {
  const row = wantToBuyRowFromRecord(
    record("recWTB1", {
      "Fulfillment Status": "Shipped",
      "Payment Status": "Paid",
      "Invoice Price": 131.4,
      "Shipping Status": "In Transit",
      "Tracking Number": "05162999841548",
      "Tracking URL": "https://tracking.dpd.de/x",
      "Buying Inventory Filter": "Margin Only",
      "Product Name": ["Jordan 1 Lost and Found"]
    })
  );

  assert.equal(row.party_record_id, "recBUYER");
  assert.equal(row.invoice_amount, 131.4);
  assert.equal(row.inventory_type, "private");
  assert.equal(row.product_name, "Jordan 1 Lost and Found");

  const item = serializeWantToBuy({ ...row, id: "00000000-0000-4000-8000-000000000123", updated_at: "2026-09-14T10:00:00+00:00" });

  assert.equal(item.is_open, false);
  assert.equal(item.tracking_number, "05162999841548");
  assert.equal(item.updated_at, "2026-09-14T10:00:00.000Z");
  assert.equal("wtb_record_id" in item, false, "no Airtable ids leave the API");
  assert.equal("party_record_id" in item, false);
});

test("a blank ceiling or invoice is null, not zero", () => {
  const row = wantToBuyRowFromRecord(record("recWTB2", { "Max Price": null }));

  assert.equal(row.max_price, null);
  assert.equal(row.invoice_amount, null);
});

test("the fingerprint moves with what the buyer sees, and only with that", () => {
  const row = wantToBuyRowFromRecord(record("recWTB3", {}));
  const before = fingerprintWantToBuy(row);

  assert.equal(fingerprintWantToBuy({ ...row, id: "x", updated_at: "later" }), before);
  assert.notEqual(fingerprintWantToBuy({ ...row, tracking_number: "0516" }), before);
  assert.notEqual(fingerprintWantToBuy({ ...row, payment_status: "Paid" }), before);
});

test("each moment a buyer acts on has its own event, and nothing is news on first sight", () => {
  const open = { fulfillment_status: "Outsource", purchase_status: "Offers Sent", payment_status: "Pending", shipping_status: null };
  const filled = { ...open, purchase_status: "Confirmed", fulfillment_status: "Allocated", payment_status: "Awaiting Payment" };

  assert.deepEqual(deriveWantToBuyEventTypes(null, open), []);
  assert.deepEqual(deriveWantToBuyEventTypes(open, { ...open, fulfillment_status: "Cancelled" }), ["want_to_buy.cancelled"]);
  assert.deepEqual(deriveWantToBuyEventTypes(open, { ...open, purchase_status: "Cancelled" }), ["want_to_buy.cancelled"]);
  assert.deepEqual(deriveWantToBuyEventTypes(open, filled), ["want_to_buy.filled"]);
  assert.deepEqual(deriveWantToBuyEventTypes(filled, { ...filled, payment_status: "Paid" }), ["want_to_buy.paid"]);
  assert.deepEqual(deriveWantToBuyEventTypes(filled, { ...filled, shipping_status: "Shipped" }), ["want_to_buy.shipped"]);
  assert.deepEqual(deriveWantToBuyEventTypes({ ...filled, shipping_status: "Shipped" }, { ...filled, shipping_status: "Delivered" }), ["want_to_buy.delivered"]);
  assert.deepEqual(deriveWantToBuyEventTypes({ ...filled, shipping_status: "Delivered" }, { ...filled, shipping_status: "Shipped" }), ["want_to_buy.updated"], "a status going back is not shipped again");
  assert.deepEqual(deriveWantToBuyEventTypes(filled, { ...filled, payment_status: "Expired" }), ["want_to_buy.updated"]);
  assert.deepEqual(
    deriveWantToBuyEventTypes({ ...filled, payment_status: "Paid" }, { ...filled, payment_status: "Paid", fulfillment_status: "Cancelled" }),
    ["want_to_buy.cancelled"],
    "cancelled says it all"
  );
});

/* ---------------- the sync ---------------- */

function fakeStore() {
  const rows = [];

  return {
    rows,
    async findByWtbRecordIds(ids) {
      return rows.filter((r) => ids.includes(r.wtb_record_id));
    },
    async insertMany(list) {
      rows.push(...list.map((row) => ({ id: crypto.randomUUID(), ...row })));
    },
    async updateMany(list) {
      for (const { id, ...row } of list) Object.assign(rows.find((r) => r.id === id), row);
    }
  };
}

test("the sync inserts quietly, then reports changes as events for the buyer", async () => {
  const theRecord = record("recWTB4", {});
  const calls = [];
  const reader = {
    async listRecent(args) {
      calls.push(args);

      return [theRecord, { id: "recNOBUYER", fields: { SKU: "X" } }];
    }
  };

  const store = fakeStore();
  const quiet = { log() {} };
  let clock = new Date("2026-09-14T10:00:00.000Z");

  const first = await syncWantToBuys({ reader, store, now: () => clock, windowDays: null, logger: quiet });

  assert.deepEqual(first, { records: 2, inserted: 1, updated: 0 });
  assert.equal(calls[0].modifiedAfter, null);

  clock = new Date("2026-09-14T10:05:00.000Z");
  const unchanged = await syncWantToBuys({ reader, store, now: () => clock, emitEvents: true, logger: quiet });

  assert.deepEqual(unchanged.events, []);
  assert.equal(calls[1].modifiedAfter, "2026-07-16T10:05:00.000Z", "a window on the last edit");

  clock = new Date("2026-09-14T10:10:00.000Z");
  Object.assign(theRecord.fields, { "Fulfillment Status": "Shipped", "Tracking Number": "0516" });

  const shipped = await syncWantToBuys({ reader, store, now: () => clock, emitEvents: true, logger: quiet });

  assert.equal(shipped.updated, 1);
  assert.deepEqual(
    shipped.events.map((e) => [e.type, e.partyRecordId, e.item.tracking_number]),
    [["want_to_buy.filled", "recBUYER", "0516"]],
    "open to Shipped in one sync is filled; Shipping Status itself did not move"
  );
  assert.deepEqual(shipped.events[0].changes, ["is_open", "fulfillment_status", "tracking_number"]);
  assert.equal(shipped.events[0].item.id, store.rows[0].id, "the id the buyer knows from the feed");
  assert.equal(store.rows[0].created_at, "2026-09-14T10:00:00.000Z");

  theRecord.fields["Shipping Status"] = "Shipped";

  const inTransit = await syncWantToBuys({ reader, store, now: () => clock, emitEvents: true, logger: quiet });

  assert.deepEqual(inTransit.events.map((e) => [e.type, e.changes]), [["want_to_buy.shipped", ["shipping_status"]]]);

  theRecord.fields["Fulfillment Status"] = "Cancelled";

  const cancelled = await syncWantToBuys({ reader, store, now: () => clock, emitEvents: true, logger: quiet });

  assert.deepEqual(cancelled.events.map((e) => e.type), ["want_to_buy.cancelled"]);
});

/* ---------------- webhooks ---------------- */

test("buyers can subscribe to want-to-buy events, and a test event carries a want-to-buy", async () => {
  assert.ok(WEBHOOK_EVENTS.includes("want_to_buy.updated"));
  assert.ok(WEBHOOK_EVENTS.includes("want_to_buy.cancelled"));

  let sent;
  const result = await sendTestEvent({
    hook: { id: "h1", url: "https://example.com/hook", secret: "s" },
    sellerRecordId: "recBUYER",
    type: "want_to_buy.cancelled",
    send: async ({ payload }) => {
      sent = payload;

      return { ok: true, statusCode: 200 };
    }
  });

  assert.equal(result.event_type, "want_to_buy.cancelled");
  assert.equal(sent.data.item.wtb_id, sampleWantToBuy().wtb_id);
  assert.equal(sent.data.item.fulfillment_status, "Cancelled");
  assert.deepEqual(sent.data.changes, ["purchase_status", "fulfillment_status", "is_open"]);

  for (const type of WEBHOOK_EVENTS) {
    await sendTestEvent({
      hook: { id: "h1", url: "https://example.com/hook", secret: "s" },
      sellerRecordId: "recBUYER",
      type,
      send: async ({ payload }) => {
        sent = payload;

        return { ok: true, statusCode: 200 };
      }
    });

    assert.equal(sent.type, type);
    assert.ok(Array.isArray(sent.data.changes), type);
    assert.equal("wtb_id" in sent.data.item, type.startsWith("want_to_buy."), type);
  }
});
