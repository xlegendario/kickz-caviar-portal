import test from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import express from "express";

import {
  deriveSaleRows,
  pickCurrentOrder,
  fingerprintSale,
  syncSales,
  serializeSale
} from "../lib/sellerApiSales.js";
import { createSellerApiRouter, generateApiKey, labelUrlOf, sellerApiErrorHandler } from "../lib/sellerApi.js";

/* ---------------- builders ---------------- */

const unit = (id, fields) => ({ id, fields: { SKU: "DZ5485-612", Size: "42", "Created Time": "2026-09-10T10:00:00.000Z", ...fields } });
const order = (id, fields) => ({ id, fields: { "Shopify Order Number": "7454", "Product Name": "Jordan 1 Lost and Found", ...fields } });
const wtb = (id, fields) => ({ id, fields: { "Member WTB ID": "MWTB-000468", ...fields } });

const derive = (u, orders = [], wtbs = []) =>
  deriveSaleRows({
    unit: u,
    ordersById: new Map(orders.map((o) => [o.id, o])),
    wtbsById: new Map(wtbs.map((w) => [w.id, w]))
  });

/* ---------------- what a sale is ---------------- */

test("a unit on a store order is one sale, for the seller only", () => {
  const rows = derive(
    unit("recUNIT1", {
      "Seller Record ID": ["recMATEO"],
      "Unfulfilled Orders Log": ["recORDER1"],
      "Final Purchase Price": 155,
      "Payment Status": "To Pay"
    }),
    [order("recORDER1", { "Fulfillment Status": "Allocated", "Tracking Number": "0516", "Shipping Label": [{ url: "https://x/label.pdf" }] })]
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].role, "sold");
  assert.equal(rows[0].party_record_id, "recMATEO");
  assert.equal(rows[0].amount, 155);
  assert.equal(rows[0].status, "active");
  assert.equal(rows[0].reference, "7454");
  assert.equal(rows[0].tracking_number, "0516");
  assert.equal(rows[0].has_label, true);
});

test("a unit on a Member WTB is a sale for the seller and a purchase for the buyer", () => {
  const rows = derive(
    unit("recUNIT2", { "Seller Record ID": ["recSELLER"], "Member WTBs": ["recWTB1"], "Final Purchase Price": 107.9 }),
    [],
    [wtb("recWTB1", { "Buyer Seller ID": ["recBUYER"], "Invoice Price": 131.4, "Payment Status": "Awaiting Payment", "Fulfillment Status": "Allocated" })]
  );

  const sold = rows.find((r) => r.role === "sold");
  const bought = rows.find((r) => r.role === "bought");

  assert.equal(sold.party_record_id, "recSELLER");
  assert.equal(sold.amount, 107.9, "the seller sees his payout");
  assert.equal(bought.party_record_id, "recBUYER");
  assert.equal(bought.amount, 131.4, "the buyer sees his invoice");
  assert.equal(bought.payment_status, "Awaiting Payment");
  assert.equal(bought.reference, "MWTB-000468");
});

test("a unit with neither an order nor a Member WTB is not a sale", () => {
  assert.deepEqual(derive(unit("recFORWARD", { "Seller Record ID": ["recX"] })), []);
});

test("a reassigned unit follows its live order, and is cancelled only when every order is", () => {
  const cancelled = order("recOLD", { "Fulfillment Status": "Cancelled", "Shopify Order Number": "9228" });
  const live = order("recNEW", { "Fulfillment Status": "Ready to Ship", "Shopify Order Number": "9301" });

  assert.equal(pickCurrentOrder([cancelled, live]).id, "recNEW");
  assert.equal(pickCurrentOrder([cancelled]).id, "recOLD");
  assert.equal(pickCurrentOrder([]), null);

  const moved = derive(
    unit("recUNIT3", { "Seller Record ID": ["recS"], "Unfulfilled Orders Log": ["recOLD", "recNEW"] }),
    [cancelled, live]
  );

  assert.equal(moved[0].status, "active");
  assert.equal(moved[0].reference, "9301");

  const dead = derive(unit("recUNIT4", { "Seller Record ID": ["recS"], "Unfulfilled Orders Log": ["recOLD"] }), [cancelled]);

  assert.equal(dead[0].status, "cancelled");
});

test("the fingerprint moves with what the API shows, and only with that", () => {
  const [row] = derive(
    unit("recUNIT5", { "Seller Record ID": ["recS"], "Unfulfilled Orders Log": ["recO"] }),
    [order("recO", { "Fulfillment Status": "Requested Label" })]
  );

  const before = fingerprintSale(row);

  assert.equal(fingerprintSale({ ...row, updated_at: "later", fingerprint: "x" }), before);
  assert.notEqual(fingerprintSale({ ...row, tracking_number: "0516" }), before);
});

/* ---------------- the sync ---------------- */

function fakeReader({ units, orders = [], wtbs = [] }) {
  const calls = [];

  return {
    calls,
    async listUnits(args) {
      calls.push(args);

      return units;
    },
    async listOrders(recordIds) {
      return orders.filter((o) => recordIds.includes(o.id));
    },
    async listWantToBuys(recordIds) {
      return wtbs.filter((w) => recordIds.includes(w.id));
    }
  };
}

function fakeSalesStore() {
  const rows = [];

  return {
    rows,
    async isEmpty() {
      return rows.length === 0;
    },
    async findByUnitIds(unitIds) {
      return rows.filter((r) => unitIds.includes(r.unit_record_id));
    },
    async insertMany(list) {
      for (const row of list) rows.push({ id: crypto.randomUUID(), ...row });
    },
    async updateMany(list) {
      for (const { id, ...row } of list) Object.assign(rows.find((r) => r.id === id), row);
    },
    async listForParty({ partyRecordId, updatedSince, role, status, from, to }) {
      const all = rows
        .filter((r) => r.party_record_id === partyRecordId)
        .filter((r) => !updatedSince || r.updated_at >= updatedSince)
        .filter((r) => !role || r.role === role)
        .filter((r) => !status || r.status === status)
        .sort((a, b) => a.updated_at.localeCompare(b.updated_at) || a.id.localeCompare(b.id));

      return { rows: all.slice(from, to + 1), total: all.length };
    },
    async findForParty({ partyRecordId, id }) {
      return rows.find((r) => r.id === id && r.party_record_id === partyRecordId) || null;
    }
  };
}

test("the sync inserts new sales, bumps only the ones that changed, and leaves the rest alone", async () => {
  const theOrder = order("recO", { "Fulfillment Status": "Requested Label" });
  const units = [
    unit("recU1", { "Seller Record ID": ["recS"], "Unfulfilled Orders Log": ["recO"] }),
    unit("recU2", { "Seller Record ID": ["recS"], "Unfulfilled Orders Log": ["recO"] })
  ];

  const store = fakeSalesStore();
  let clock = new Date("2026-09-14T10:00:00.000Z");
  const quiet = { log() {} };

  const first = await syncSales({ reader: fakeReader({ units, orders: [theOrder] }), store, now: () => clock, logger: quiet });

  assert.deepEqual(first, { units: 2, rows: 2, inserted: 2, updated: 0 });

  clock = new Date("2026-09-14T10:05:00.000Z");
  const unchanged = await syncSales({ reader: fakeReader({ units, orders: [theOrder] }), store, now: () => clock, logger: quiet });

  assert.equal(unchanged.updated, 0);
  assert.ok(store.rows.every((r) => r.updated_at === "2026-09-14T10:00:00.000Z"), "nothing changed, nothing moved");

  clock = new Date("2026-09-14T10:10:00.000Z");
  theOrder.fields["Tracking Number"] = "05162999841548";

  const tracked = await syncSales({ reader: fakeReader({ units, orders: [theOrder] }), store, now: () => clock, logger: quiet });

  assert.equal(tracked.updated, 2);
  assert.ok(store.rows.every((r) => r.updated_at === "2026-09-14T10:10:00.000Z"));
  assert.ok(store.rows.every((r) => r.created_at === "2026-09-14T10:00:00.000Z"), "created_at stays");
});

test("the sync reads a window of recent units, or everything when told to", async () => {
  const store = fakeSalesStore();
  const now = () => new Date("2026-09-14T00:00:00.000Z");

  const windowed = fakeReader({ units: [] });
  await syncSales({ reader: windowed, store, now, windowDays: 60, logger: { log() {} } });
  assert.equal(windowed.calls[0].createdAfter, "2026-07-16T00:00:00.000Z");

  const full = fakeReader({ units: [] });
  await syncSales({ reader: full, store, now, windowDays: null, logger: { log() {} } });
  assert.equal(full.calls[0].createdAfter, null);
});

/* ---------------- the endpoint ---------------- */

async function serve(t, { salesStore, labels, mode = "live", sellerRecordId = "recS" }) {
  const generated = generateApiKey(mode);
  const keyRow = { id: crypto.randomUUID(), seller_record_id: sellerRecordId, seller_id: "SE-00001", mode, key_hash: generated.hash };

  const app = express();
  app.use(express.json());
  app.use(
    "/api/v1",
    createSellerApiRouter({
      store: { findActiveKeyByHash: async (hash) => (hash === keyRow.key_hash ? keyRow : null), touchKey: async () => {} },
      salesStore,
      labels,
      normalizeSize: (s) => s,
      isUsableSize: () => true,
      sizeError: () => "",
      vatEligibilityError: async () => null,
      logger: { error() {} }
    })
  );
  app.use("/api/v1", sellerApiErrorHandler);

  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });

  t.after(() => server.close());

  return async (path, { method = "GET" } = {}) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method,
      headers: { Authorization: `Bearer ${generated.key}` }
    });

    const isJson = (res.headers.get("content-type") || "").includes("application/json");
    const body = isJson ? await res.json() : Buffer.from(await res.arrayBuffer());

    return { status: res.status, json: isJson ? body : null, body, headers: res.headers };
  };
}

test("the feed walks forward with updated_since and hands back where to continue", async (t) => {
  const store = fakeSalesStore();
  const row = (id, updatedAt, extra = {}) => ({
    id,
    unit_record_id: `u${id}`,
    role: "sold",
    party_record_id: "recS",
    status: "active",
    source_type: "order",
    has_label: false,
    updated_at: updatedAt,
    ...extra
  });

  store.rows.push(
    row("00000000-0000-4000-8000-00000000000a", "2026-09-10T10:00:00.000Z"),
    row("00000000-0000-4000-8000-00000000000b", "2026-09-11T10:00:00.000Z", { has_label: true }),
    row("00000000-0000-4000-8000-00000000000c", "2026-09-12T10:00:00.000Z", { role: "bought", has_label: true }),
    row("00000000-0000-4000-8000-00000000000d", "2026-09-12T10:00:00.000Z", { party_record_id: "recSOMEONEELSE" })
  );

  const call = await serve(t, { salesStore: store });

  const all = await call("/api/v1/sales?per_page=2");
  assert.equal(all.json.data.pagination.total, 3, "another party's sale is not in the feed");
  assert.equal(all.json.data.items[0].id, "00000000-0000-4000-8000-00000000000a", "oldest change first");
  assert.equal(all.json.meta.next_updated_since, "2026-09-11T10:00:00.000Z");

  const next = await call(`/api/v1/sales?updated_since=${all.json.meta.next_updated_since}`);
  assert.equal(next.json.data.items.length, 2, ">= keeps the boundary row, the caller de-duplicates");

  assert.equal((await call("/api/v1/sales?role=bought")).json.data.pagination.total, 1);

  const byId = await call("/api/v1/sales/00000000-0000-4000-8000-00000000000c");
  assert.equal(byId.json.data.item.label_available, false, "a buyer has no label to fetch");
  assert.equal((await call("/api/v1/sales/00000000-0000-4000-8000-00000000000d")).status, 404);
});

test("the feed refuses what it cannot read", async (t) => {
  const call = await serve(t, { salesStore: fakeSalesStore() });

  assert.equal((await call("/api/v1/sales?updated_since=yesterday")).status, 400);
  assert.equal((await call("/api/v1/sales?role=refunded")).status, 400);
  assert.equal((await call("/api/v1/sales?status=shipped")).status, 400);
  assert.equal((await call("/api/v1/sales/not-an-id")).status, 404);
});

test("a test key gets two sample sales in the live shape and never reads the real feed", async (t) => {
  const call = await serve(t, {
    mode: "test",
    salesStore: { listForParty: async () => { throw new Error("a test key read real sales"); } }
  });

  const res = await call("/api/v1/sales");

  assert.equal(res.status, 200);
  assert.equal(res.json.data.items.length, 2);
  assert.deepEqual(res.json.data.items.map((i) => i.role).sort(), ["bought", "sold"]);
  assert.deepEqual(Object.keys(res.json.data.items[0]).sort(), Object.keys(serializeSale({ role: "sold" })).sort());
});

/* ---------------- labels ---------------- */

const SOLD_ID = "00000000-0000-4000-8000-0000000000e1";
const BOUGHT_ID = "00000000-0000-4000-8000-0000000000e2";
const WTB_SOLD_ID = "00000000-0000-4000-8000-0000000000e3";

function labelFixture({ orderFields = {}, wtbFields = {}, requestError = null, fetchOk = true } = {}) {
  const salesStore = fakeSalesStore();

  const sale = (id, extra) => ({
    id,
    unit_record_id: `u-${id}`,
    party_record_id: "recS",
    status: "active",
    reference: "7454",
    has_label: false,
    updated_at: "2026-09-14T10:00:00.000Z",
    ...extra
  });

  salesStore.rows.push(
    sale(SOLD_ID, { role: "sold", source_type: "order", source_record_id: "recORDER000000001" }),
    sale(BOUGHT_ID, { role: "bought", source_type: "member_wtb", source_record_id: "recWTB00000000001" }),
    sale(WTB_SOLD_ID, { role: "sold", source_type: "member_wtb", source_record_id: "recWTB00000000001", reference: "MWTB-000468" })
  );

  const records = {
    recORDER000000001: { id: "recORDER000000001", fields: { "Fulfillment Status": "Allocated", ...orderFields } },
    recWTB00000000001: { id: "recWTB00000000001", fields: { "Fulfillment Status": "Allocated", "Payment Status": "Paid", ...wtbFields } }
  };

  const calls = { order: [], wtb: [], fetched: [] };

  const labels = {
    async findSource({ recordId }) {
      return records[recordId] ? { ...records[recordId], fields: { ...records[recordId].fields } } : null;
    },
    async fetchFile(url) {
      calls.fetched.push(url);

      return fetchOk ? { ok: true, buffer: Buffer.from("%PDF-1.4 real label") } : { ok: false, status: 500 };
    },
    async requestForOrder(id) {
      calls.order.push(id);
      if (requestError) throw requestError;
      // A marketplace label lands during the request itself.
      records[id].fields["Shipping Label"] = [{ url: "https://dl.airtable.com/label.pdf" }];
      records[id].fields["Tracking Number"] = "05162999841548";
    },
    async requestForWantToBuy(id) {
      calls.wtb.push(id);
      records[id].fields["Fulfillment Status"] = "Requested Label";
    }
  };

  return { salesStore, labels, calls };
}

test("a label is found on the attachment first, then on the permanent copy, and only over https", () => {
  assert.equal(labelUrlOf({ fields: { "Shipping Label": [{ url: "https://a/1.pdf" }], "Shipping Label URL (Permanent)": "https://b/2.pdf" } }, "order"), "https://a/1.pdf");
  assert.equal(labelUrlOf({ fields: { "Shipping Label URL (Permanent)": "https://b/2.pdf" } }, "order"), "https://b/2.pdf");
  assert.equal(labelUrlOf({ fields: { "Shipping Label Permanent URL": "https://c/3.pdf" } }, "member_wtb"), "https://c/3.pdf");
  assert.equal(labelUrlOf({ fields: { "Shipping Label Permanent URL": "https://c/3.pdf" } }, "order"), "", "an order does not read the WTB column");
  assert.equal(labelUrlOf({ fields: { "Shipping Label URL (Permanent)": "http://plain/4.pdf" } }, "order"), "");
});

test("the seller downloads the label as a PDF through us, never as a link", async (t) => {
  const fx = labelFixture({ orderFields: { "Shipping Label": [{ url: "https://dl.airtable.com/label.pdf" }] } });
  const call = await serve(t, fx);

  const res = await call(`/api/v1/sales/${SOLD_ID}/label`);

  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/pdf");
  assert.match(res.headers.get("content-disposition"), /7454-label\.pdf/);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.body.toString(), "%PDF-1.4 real label");
  assert.deepEqual(fx.calls.fetched, ["https://dl.airtable.com/label.pdf"]);
});

test("no label yet, a buyer, another party and a failed download are each answered plainly", async (t) => {
  const fx = labelFixture();
  const call = await serve(t, fx);

  const notReady = await call(`/api/v1/sales/${SOLD_ID}/label`);
  assert.equal(notReady.status, 404);
  assert.equal(notReady.json.code, "label_not_ready");

  assert.equal((await call(`/api/v1/sales/${BOUGHT_ID}/label`)).status, 404);

  const other = labelFixture({ orderFields: { "Shipping Label": [{ url: "https://dl.airtable.com/x.pdf" }] } });
  const otherCall = await serve(t, { ...other, sellerRecordId: "recSOMEONEELSE" });
  assert.equal((await otherCall(`/api/v1/sales/${SOLD_ID}/label`)).status, 404);
  assert.deepEqual(other.calls.fetched, [], "nothing is fetched for somebody else's sale");

  const broken = labelFixture({ orderFields: { "Shipping Label": [{ url: "https://dl.airtable.com/x.pdf" }] }, fetchOk: false });
  const brokenCall = await serve(t, broken);
  assert.equal((await brokenCall(`/api/v1/sales/${SOLD_ID}/label`)).status, 502);
});

test("requesting a label on an Allocated order runs the Discord button's route and reports the label it produced", async (t) => {
  const fx = labelFixture();
  const call = await serve(t, fx);

  const res = await call(`/api/v1/sales/${SOLD_ID}/request-label`, { method: "POST" });

  assert.equal(res.status, 200);
  assert.deepEqual(fx.calls.order, ["recORDER000000001"]);
  assert.equal(res.json.data.label_available, true);
  assert.equal(res.json.data.tracking_number, "05162999841548");

  const again = await call(`/api/v1/sales/${SOLD_ID}/request-label`, { method: "POST" });
  assert.equal(again.status, 409);
  assert.equal(again.json.code, "label_available");
  assert.equal(fx.calls.order.length, 1, "no second request once a label exists");
});

test("a label cannot be requested outside Allocated, or on a Member WTB the buyer has not paid", async (t) => {
  const moved = labelFixture({ orderFields: { "Fulfillment Status": "Requested Label" } });
  const movedCall = await serve(t, moved);

  const res = await movedCall(`/api/v1/sales/${SOLD_ID}/request-label`, { method: "POST" });
  assert.equal(res.status, 409);
  assert.equal(res.json.code, "not_requestable");
  assert.equal(res.json.fulfillment_status, "Requested Label");
  assert.deepEqual(moved.calls.order, []);

  const unpaid = labelFixture({ wtbFields: { "Payment Status": "Awaiting Payment" } });
  const unpaidCall = await serve(t, unpaid);

  const waiting = await unpaidCall(`/api/v1/sales/${WTB_SOLD_ID}/request-label`, { method: "POST" });
  assert.equal(waiting.status, 409);
  assert.equal(waiting.json.code, "awaiting_payment");
  assert.deepEqual(unpaid.calls.wtb, []);
});

test("a paid Member WTB goes through the Member WTB route, and a buyer cannot request at all", async (t) => {
  const fx = labelFixture();
  const call = await serve(t, fx);

  const res = await call(`/api/v1/sales/${WTB_SOLD_ID}/request-label`, { method: "POST" });

  assert.equal(res.status, 200);
  assert.deepEqual(fx.calls.wtb, ["recWTB00000000001"]);
  assert.deepEqual(fx.calls.order, []);
  assert.equal(res.json.data.label_available, false);

  assert.equal((await call(`/api/v1/sales/${BOUGHT_ID}/request-label`, { method: "POST" })).status, 404);
});

test("a failing label request keeps a caller's error and hides ours", async (t) => {
  const theirs = labelFixture({ requestError: Object.assign(new Error("Missing Label Request Channel ID"), { statusCode: 400 }) });
  const ours = labelFixture({ requestError: new Error("Sendcloud create parcel failed: 500") });

  const theirsCall = await serve(t, theirs);
  const oursCall = await serve(t, ours);

  assert.equal((await theirsCall(`/api/v1/sales/${SOLD_ID}/request-label`, { method: "POST" })).status, 400);

  const hidden = await oursCall(`/api/v1/sales/${SOLD_ID}/request-label`, { method: "POST" });
  assert.equal(hidden.status, 502);
  assert.doesNotMatch(hidden.json.message, /Sendcloud/);
});

test("a test key downloads a sample PDF and gets a simulated request", async (t) => {
  const call = await serve(t, {
    mode: "test",
    salesStore: { findForParty: async () => { throw new Error("a test key read real sales"); } },
    labels: {
      findSource: async () => { throw new Error("a test key reached Airtable"); },
      requestForOrder: async () => { throw new Error("a test key requested a real label"); }
    }
  });

  const pdf = await call("/api/v1/sales/00000000-0000-4000-8000-000000000001/label");
  assert.equal(pdf.status, 200);
  assert.match(pdf.body.toString("latin1"), /^%PDF-1\.4/);

  assert.equal((await call("/api/v1/sales/00000000-0000-4000-8000-000000000002/label")).status, 404);

  const requested = await call("/api/v1/sales/00000000-0000-4000-8000-000000000001/request-label", { method: "POST" });
  assert.equal(requested.status, 200);
  assert.equal(requested.json.data.simulated, true);
});

test("a label download that fails once is tried again before anyone is told", async () => {
  const { fetchLabelFile } = await import("../lib/sellerApiSales.js");

  let attempts = 0;
  const flaky = async () => {
    attempts += 1;

    return attempts === 1
      ? { ok: false, status: 503 }
      : { ok: true, arrayBuffer: async () => new TextEncoder().encode("%PDF-1.4").buffer };
  };

  const file = await fetchLabelFile("https://x/label.pdf", { fetchImpl: flaky });

  assert.equal(file.ok, true);
  assert.equal(attempts, 2);

  let down = 0;
  const gone = await fetchLabelFile("https://x/label.pdf", { fetchImpl: async () => { down += 1; return { ok: false, status: 404 }; } });

  assert.equal(gone.ok, false);
  assert.equal(down, 2, "twice, and no more");
});
