import test from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import express from "express";

import {
  generateApiKey,
  hashApiKey,
  readBearerKey,
  createRateLimiter,
  parsePagination,
  validateInventoryItem,
  createSellerApiRouter,
  createApiKeyRouter,
  sellerApiErrorHandler
} from "../lib/sellerApi.js";
import { wantToBuyRowFromRecord } from "../lib/sellerApiWantToBuys.js";

/* ---------------- fakes ---------------- */

// The same size rules the portal hands in, trimmed to what these tests use.
const sizeRules = {
  normalizeSize: (size) => String(size || "").trim().replace(/^EU\s+/i, "").replace(",", "."),
  isUsableSize: (size) => /^\d{1,2}(\.5)?$/.test(size) || /^(S|M|L|XL)$/.test(size),
  sizeError: (size) => `size "${size}" is not a valid EU size`
};

// An in-memory stand-in for createSupabaseApiStore, with one table per mode
// so a test key writing to the live table would show up as a failure.
function memoryStore() {
  const keys = [];
  const tables = { live: [], test: [] };

  const pick = (row) => ({ ...row });

  return {
    keys,
    tables,

    async findActiveKeyByHash(hash) {
      const row = keys.find((k) => k.key_hash === hash && !k.revoked_at);

      return row ? pick(row) : null;
    },
    async touchKey(id, at) {
      const row = keys.find((k) => k.id === id);
      if (row) row.last_used_at = at;
    },
    async listKeys(sellerRecordId) {
      return keys.filter((k) => k.seller_record_id === sellerRecordId).map(pick);
    },
    async countActiveKeys(sellerRecordId) {
      return keys.filter((k) => k.seller_record_id === sellerRecordId && !k.revoked_at).length;
    },
    async insertKey(row) {
      const created = { id: crypto.randomUUID(), created_at: new Date().toISOString(), ...row };
      keys.push(created);

      return pick(created);
    },
    async revokeKey({ id, sellerRecordId, at }) {
      const row = keys.find((k) => k.id === id && k.seller_record_id === sellerRecordId && !k.revoked_at);
      if (!row) return null;
      row.revoked_at = at;

      return pick(row);
    },
    async listInventory({ mode, sellerRecordId, sku, inStock, from, to }) {
      const rows = tables[mode]
        .filter((r) => r.seller_record_id === sellerRecordId)
        .filter((r) => !sku || r.sku === sku)
        .filter((r) => !inStock || r.quantity > 0);

      return { rows: rows.slice(from, to + 1).map(pick), total: rows.length };
    },
    async findInventoryBySkuSize({ mode, sellerRecordId, sku, size }) {
      const row = tables[mode].find((r) => r.seller_record_id === sellerRecordId && r.sku === sku && r.size === size);

      return row ? pick(row) : null;
    },
    async upsertTestInventoryRow({ existing, row }) {
      if (existing) {
        const target = tables.test.find((r) => r.id === existing.id);
        Object.assign(target, row);

        return pick(target);
      }

      const created = { id: crypto.randomUUID(), ...row };
      tables.test.push(created);

      return pick(created);
    },
    async updateInventoryById({ mode, sellerRecordId, id, patch }) {
      const row = tables[mode].find((r) => r.id === id && r.seller_record_id === sellerRecordId);
      if (!row) return null;
      Object.assign(row, patch);

      return pick(row);
    },
    async deleteInventoryByIds({ mode, sellerRecordId, ids }) {
      const gone = tables[mode].filter((r) => r.seller_record_id === sellerRecordId && ids.includes(r.id));
      tables[mode] = tables[mode].filter((r) => !gone.includes(r));

      return gone.map((r) => ({ id: r.id, sku: r.sku, size: r.size }));
    }
  };
}

// Want-to-buys: Airtable's Member WTBs as records, and one snapshot table per
// mode, shaped like the real stores.
function memoryWantToBuys() {
  const airtable = [];
  const rows = { live: [], test: [] };

  const snapshotStore = (mode) => ({
    async upsertFromRecord(row) {
      const existing = rows[mode].find((r) => r.wtb_record_id === row.wtb_record_id);
      const stamp = new Date().toISOString();

      if (existing) {
        Object.assign(existing, row, { updated_at: stamp });

        return { ...existing };
      }

      const created = { id: crypto.randomUUID(), ...row, fingerprint: "x", created_at: stamp, updated_at: stamp };
      rows[mode].push(created);

      return { ...created };
    },
    async insertTest(row) {
      const created = { id: crypto.randomUUID(), ...row };
      rows[mode].push(created);

      return { ...created };
    },
    async cancelTest(id) {
      const row = rows[mode].find((r) => r.id === id);
      Object.assign(row, { purchase_status: "Cancelled", fulfillment_status: "Cancelled", updated_at: new Date().toISOString() });

      return { ...row };
    },
    async listForParty({ partyRecordId, updatedSince, status, sku, from, to }) {
      const open = (r) => ["Pending", "Outsource"].includes(r.fulfillment_status);
      const all = rows[mode]
        .filter((r) => r.party_record_id === partyRecordId)
        .filter((r) => !updatedSince || r.updated_at >= updatedSince)
        .filter((r) => !sku || r.sku === sku)
        .filter((r) => !status || (status === "open") === open(r));

      return { rows: all.slice(from, to + 1).map((r) => ({ ...r })), total: all.length };
    },
    async findForParty({ partyRecordId, id }) {
      const row = rows[mode].find((r) => r.id === id && r.party_record_id === partyRecordId);

      return row ? { ...row } : null;
    }
  });

  const reader = {
    async findRecord(recordId) {
      const record = airtable.find((r) => r.id === recordId);

      return record ? structuredClone(record) : null;
    },
    async cancel(recordId) {
      const record = airtable.find((r) => r.id === recordId);
      Object.assign(record.fields, { "Purchase Status": "Cancelled", "Fulfillment Status": "Cancelled" });

      return structuredClone(record);
    }
  };

  const addRecord = (buyerRecordId, fields) => {
    const record = {
      id: `rec${crypto.randomBytes(7).toString("hex")}`,
      fields: {
        "Buyer Seller ID": [buyerRecordId],
        "Purchase Status": "Offers Sent",
        "Fulfillment Status": "Outsource",
        "Payment Status": "Pending",
        ...fields
      }
    };
    airtable.push(record);

    return record;
  };

  return { airtable, rows, reader, addRecord, stores: { live: snapshotStore("live"), test: snapshotStore("test") } };
}

function buildApi({ store, catalogue = {}, vat = {}, rateLimit, wtbs = memoryWantToBuys(), createLiveWantToBuy, b2bRefusal, consignorRefusal } = {}) {
  const refreshed = [];

  // Stands in for the portal's consignment upsert, writing the live table.
  const setLiveInventoryRow = async ({ sellerRecordId, sellerId, sku, size, vatType, sellingPriceSuggested, quantity }) => {
    const canonical = (catalogue[sku]?.matched_sku || sku).toUpperCase();
    const existing = store.tables.live.find(
      (r) => r.seller_record_id === sellerRecordId && r.sku === canonical && r.size === size
    );

    const values = {
      seller_record_id: sellerRecordId,
      seller_id: sellerId,
      sku: canonical,
      size,
      vat_type: vatType,
      selling_price_suggested: sellingPriceSuggested,
      quantity
    };

    if (existing) {
      Object.assign(existing, values);

      return { mode: "updated", item: { ...existing } };
    }

    const created = { id: crypto.randomUUID(), ...values };
    store.tables.live.push(created);

    return { mode: "created", item: { ...created } };
  };

  const resolveProduct = async (sku) => {
    const entry = catalogue[sku];

    if (entry === "lookup_failed") {
      throw Object.assign(new Error("down"), { isLookupFailure: true });
    }

    if (!entry) throw Object.assign(new Error("unknown"), { isUnknownSku: true });

    return { product_name: entry.name, brand: entry.brand || "", matched_sku: entry.matched_sku || sku };
  };

  const app = express();
  app.use(express.json());
  app.use(
    "/api/v1",
    createSellerApiRouter({
      store,
      setLiveInventoryRow,
      resolveProduct,
      refreshStockLevel: async (sku, size) => refreshed.push(`${sku}|${size}`),
      ...sizeRules,
      vatEligibilityError: async (_id, vatType) => vat[vatType] || null,
      wantToBuyStores: wtbs.stores,
      wantToBuyReader: wtbs.reader,
      // Stands in for createOpenMemberWtb: writes an Airtable record, returns its id.
      createLiveWantToBuy:
        createLiveWantToBuy ||
        (async ({ sellerRecordId, sku, size, maxPrice, inventoryType }) =>
          wtbs.addRecord(sellerRecordId, {
            SKU: sku,
            Size: size,
            "Max Price": maxPrice,
            "Buying Inventory Filter": { all: "All Inventory", private: "Margin Only", b2b: "B2B Only" }[inventoryType]
          }).id),
      b2bRefusal,
      consignorRefusal,
      rateLimit,
      logger: { error() {} }
    })
  );
  app.use("/api/v1", sellerApiErrorHandler);

  return { app, refreshed, wtbs };
}

async function withServer(app, t) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });

  t.after(() => server.close());

  const base = `http://127.0.0.1:${server.address().port}`;

  return async (method, path, { key, body, headers = {} } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...headers
      },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body)
    });

    const json = await res.json().catch(() => null);

    return { status: res.status, json, headers: res.headers };
  };
}

async function issueKey(store, { sellerRecordId = "recSELLER1", sellerId = "SE-00001", mode = "live" } = {}) {
  const generated = generateApiKey(mode);

  await store.insertKey({
    seller_record_id: sellerRecordId,
    seller_id: sellerId,
    mode,
    key_prefix: generated.prefix,
    key_hash: generated.hash
  });

  return generated.key;
}

const CATALOGUE = {
  "DZ5485-612": { name: "Jordan 1 Lost and Found", brand: "Jordan" },
  "DD1503 101": { name: "Dunk Low Panda", brand: "Nike", matched_sku: "DD1503-101" },
  "DD1503-101": { name: "Dunk Low Panda", brand: "Nike" }
};

/* ---------------- pure pieces ---------------- */

test("a generated key names its mode and is only stored as a hash", () => {
  const live = generateApiKey("live");
  const testKey = generateApiKey("test");

  assert.match(live.key, /^sk_live_[A-Za-z0-9_-]{40,}$/);
  assert.match(testKey.key, /^sk_test_/);
  assert.equal(live.hash, hashApiKey(live.key));
  assert.notEqual(live.key, generateApiKey("live").key);
  assert.ok(live.key.startsWith(live.prefix));
  assert.throws(() => generateApiKey("prod"));
});

test("only a well-formed Bearer key is read", () => {
  const { key } = generateApiKey("live");

  assert.equal(readBearerKey(`Bearer ${key}`), key);
  assert.equal(readBearerKey(`bearer ${key}`), key);
  assert.equal(readBearerKey(key), null);
  assert.equal(readBearerKey("Bearer pk_live_somethingelse1234567890"), null);
  assert.equal(readBearerKey(""), null);
  assert.equal(readBearerKey(undefined), null);
});

test("the rate limiter refuses past the limit and resets with the window", () => {
  let clock = 0;
  const hit = createRateLimiter({ limit: 2, windowMs: 1000, now: () => clock });

  assert.equal(hit("a").allowed, true);
  assert.equal(hit("a").allowed, true);

  const third = hit("a");
  assert.equal(third.allowed, false);
  assert.equal(third.remaining, 0);
  assert.equal(third.retryAfterSeconds, 1);

  assert.equal(hit("b").allowed, true, "a different key has its own window");

  clock = 1000;
  assert.equal(hit("a").allowed, true);
});

test("pagination is clamped rather than refused", () => {
  assert.deepEqual(parsePagination({}), { page: 1, perPage: 50, from: 0, to: 49 });
  assert.deepEqual(parsePagination({ page: "3", per_page: "10" }), { page: 3, perPage: 10, from: 20, to: 29 });
  assert.equal(parsePagination({ per_page: "5000" }).perPage, 100);
  assert.equal(parsePagination({ per_page: "0" }).perPage, 1);
  assert.equal(parsePagination({ page: "-2" }).page, 1);
});

test("an inventory item is validated with the portal's own size rule", () => {
  const ok = validateInventoryItem({ sku: "dz5485-612", size: "EU 42,5", vat_type: "Margin", price: 180 }, sizeRules);

  assert.deepEqual(ok.item, { sku: "DZ5485-612", size: "42.5", vatType: "Margin", price: 180, quantity: 1 });

  const reasons = [
    [{ size: "42", vat_type: "Margin", price: 1 }, /sku is required/],
    [{ sku: "X", size: "42 1/3", vat_type: "Margin", price: 1 }, /not a valid EU size/],
    [{ sku: "X", size: "42", vat_type: "VAT9", price: 1 }, /vat_type/],
    [{ sku: "X", size: "42", vat_type: "Margin", price: 0 }, /price/],
    [{ sku: "X", size: "42", vat_type: "Margin", price: 10, quantity: 1.5 }, /quantity/],
    [{ sku: "X", size: "42", vat_type: "Margin", price: 10, quantity: -1 }, /quantity/]
  ];

  for (const [item, reason] of reasons) {
    assert.match(validateInventoryItem(item, sizeRules).reason, reason);
  }
});

/* ---------------- authentication ---------------- */

test("no key, a malformed key and a revoked key are all refused", async (t) => {
  const store = memoryStore();
  const call = await withServer(buildApi({ store }).app, t);

  assert.equal((await call("GET", "/api/v1/inventory")).status, 401);
  assert.equal((await call("GET", "/api/v1/inventory", { headers: { Authorization: "Bearer nope" } })).status, 401);

  const key = await issueKey(store);
  await store.revokeKey({ id: store.keys[0].id, sellerRecordId: "recSELLER1", at: "2026-09-14T00:00:00Z" });

  const revoked = await call("GET", "/api/v1/inventory", { key });
  assert.equal(revoked.status, 401);
  assert.equal(revoked.json.success, false);
});

test("a key over its limit gets 429 with Retry-After", async (t) => {
  const store = memoryStore();
  const key = await issueKey(store);
  const call = await withServer(buildApi({ store, rateLimit: createRateLimiter({ limit: 1 }) }).app, t);

  const first = await call("GET", "/api/v1/inventory", { key });
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("x-ratelimit-limit"), "1");

  const second = await call("GET", "/api/v1/inventory", { key });
  assert.equal(second.status, 429);
  assert.ok(Number(second.headers.get("retry-after")) >= 1);
});

test("a malformed JSON body is answered in JSON, not an HTML error page", async (t) => {
  const store = memoryStore();
  const key = await issueKey(store);
  const call = await withServer(buildApi({ store }).app, t);

  const res = await call("POST", "/api/v1/inventory", { key, body: "{not json" });

  assert.equal(res.status, 400);
  assert.equal(res.json.success, false);
});

/* ---------------- inventory ---------------- */

test("a batch creates, updates and skips per item, with a reason for each skip", async (t) => {
  const store = memoryStore();
  const key = await issueKey(store);
  const { app, refreshed } = buildApi({ store, catalogue: CATALOGUE, vat: { VAT21: "Private sellers cannot list VAT21" } });
  const call = await withServer(app, t);

  const first = await call("POST", "/api/v1/inventory", {
    key,
    body: { items: [{ sku: "DZ5485-612", size: "42", vat_type: "Margin", price: 180, quantity: 2 }] }
  });

  assert.equal(first.status, 200);
  assert.equal(first.json.data.created_count, 1);

  const second = await call("POST", "/api/v1/inventory", {
    key,
    body: {
      items: [
        { sku: "DZ5485-612", size: "42", vat_type: "Margin", price: 175, quantity: 1 },
        { sku: "NOPE-000", size: "42", vat_type: "Margin", price: 100 },
        { sku: "DZ5485-612", size: "43", vat_type: "VAT21", price: 100 },
        { sku: "DZ5485-612", size: "44", vat_type: "Margin", price: 100, quantity: 0 },
        { sku: "DD1503 101", size: "42", vat_type: "Margin", price: 120 },
        { sku: "DD1503-101", size: "42", vat_type: "Margin", price: 125 }
      ]
    }
  });

  const data = second.json.data;

  assert.equal(data.updated_count, 1);
  assert.equal(data.created_count, 1);
  assert.equal(data.skipped_count, 4);

  const byIndex = Object.fromEntries(data.items.map((item) => [item.index, item]));

  assert.equal(byIndex[0].status, "updated");
  assert.match(byIndex[1].reason, /not recognised/);
  assert.match(byIndex[2].reason, /VAT21/);
  assert.match(byIndex[3].reason, /do not list/);
  assert.equal(byIndex[4].sku, "DD1503-101", "the catalogue's spelling is stored");
  assert.match(byIndex[5].reason, /Same SKU and size as item 4/);

  assert.equal(store.tables.live.find((r) => r.size === "42" && r.sku === "DZ5485-612").quantity, 1, "quantity is set, not added");
  assert.ok(refreshed.includes("DZ5485-612|42"));
});

test("a lookup outage is a retryable skip, not a failed request", async (t) => {
  const store = memoryStore();
  const key = await issueKey(store);
  const call = await withServer(buildApi({ store, catalogue: { "DOWN-1": "lookup_failed" } }).app, t);

  const res = await call("POST", "/api/v1/inventory", {
    key,
    body: { items: [{ sku: "DOWN-1", size: "42", vat_type: "Margin", price: 100 }] }
  });

  assert.equal(res.status, 200);
  assert.equal(res.json.data.items[0].retryable, true);
});

test("a test key never touches the live table, and never refreshes stock levels", async (t) => {
  const store = memoryStore();
  const key = await issueKey(store, { mode: "test" });
  const { app, refreshed } = buildApi({ store, catalogue: CATALOGUE });
  const call = await withServer(app, t);

  const created = await call("POST", "/api/v1/inventory", {
    key,
    body: { items: [{ sku: "DZ5485-612", size: "42", vat_type: "Margin", price: 180 }] }
  });

  assert.equal(created.headers.get("x-api-mode"), "test");
  assert.equal(store.tables.live.length, 0);
  assert.equal(store.tables.test.length, 1);

  const id = created.json.data.items[0].id;

  assert.equal((await call("PATCH", `/api/v1/inventory/${id}`, { key, body: { quantity: 3 } })).status, 200);
  assert.equal((await call("DELETE", "/api/v1/inventory", { key, body: { ids: [id] } })).json.data.deleted_count, 1);
  assert.deepEqual(refreshed, []);
});

test("a seller can neither see, change nor delete another seller's listing", async (t) => {
  const store = memoryStore();
  const mine = await issueKey(store, { sellerRecordId: "recMINE" });
  const theirs = await issueKey(store, { sellerRecordId: "recTHEIRS", sellerId: "SE-00002" });
  const call = await withServer(buildApi({ store, catalogue: CATALOGUE }).app, t);

  const created = await call("POST", "/api/v1/inventory", {
    key: theirs,
    body: { items: [{ sku: "DZ5485-612", size: "42", vat_type: "Margin", price: 180 }] }
  });

  const id = created.json.data.items[0].id;

  assert.equal((await call("GET", "/api/v1/inventory", { key: mine })).json.data.pagination.total, 0);

  const patch = await call("PATCH", `/api/v1/inventory/${id}`, { key: mine, body: { price: 1 } });
  assert.equal(patch.status, 404);

  const del = await call("DELETE", "/api/v1/inventory", { key: mine, body: { ids: [id] } });
  assert.equal(del.json.data.deleted_count, 0);
  assert.deepEqual(del.json.data.not_found, [id]);

  assert.equal(store.tables.live[0].selling_price_suggested, 180);
});

test("inventory lists as items plus pagination, filterable by SKU and stock", async (t) => {
  const store = memoryStore();
  const key = await issueKey(store);
  const call = await withServer(buildApi({ store, catalogue: CATALOGUE }).app, t);

  await call("POST", "/api/v1/inventory", {
    key,
    body: {
      items: [
        { sku: "DZ5485-612", size: "42", vat_type: "Margin", price: 180 },
        { sku: "DZ5485-612", size: "43", vat_type: "Margin", price: 180 },
        { sku: "DD1503-101", size: "42", vat_type: "Margin", price: 120 }
      ]
    }
  });

  const id = store.tables.live.find((r) => r.size === "43").id;
  await call("PATCH", `/api/v1/inventory/${id}`, { key, body: { quantity: 0 } });

  const page = await call("GET", "/api/v1/inventory?per_page=2", { key });
  assert.equal(page.json.data.items.length, 2);
  assert.equal(page.json.data.pagination.total, 3);
  assert.equal(page.json.data.pagination.has_more_pages, true);

  const filtered = await call("GET", "/api/v1/inventory?sku=dz5485-612&in_stock=true", { key });
  assert.equal(filtered.json.data.pagination.total, 1);
});

test("PATCH and DELETE refuse what they cannot act on", async (t) => {
  const store = memoryStore();
  const key = await issueKey(store);
  const call = await withServer(buildApi({ store }).app, t);

  assert.equal((await call("PATCH", "/api/v1/inventory/not-a-uuid", { key, body: { price: 1 } })).status, 404);
  assert.equal((await call("PATCH", `/api/v1/inventory/${crypto.randomUUID()}`, { key, body: {} })).status, 400);
  assert.equal((await call("DELETE", "/api/v1/inventory", { key, body: {} })).status, 400);

  const unknown = await call("GET", "/api/v1/nothing-here", { key });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json.success, false);
});

/* ---------------- key management ---------------- */

function buildKeyApp(store, { sessionFor = null, sellerIds = { recSELLER1: "SE-00001" } } = {}) {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/seller-api",
    createApiKeyRouter({
      store,
      identify: () => (sessionFor ? { sellerRecordId: sessionFor } : { status: 401, error: "Not signed in" }),
      lookupSellerId: async (id) => sellerIds[id] || null
    })
  );
  app.use("/api/seller-api", sellerApiErrorHandler);

  return app;
}

test("keys can only be managed by a signed-in seller", async (t) => {
  const call = await withServer(buildKeyApp(memoryStore()), t);

  assert.equal((await call("GET", "/api/seller-api/keys")).status, 401);
  assert.equal((await call("POST", "/api/seller-api/keys", { body: { mode: "live" } })).status, 401);
});

test("a created key is shown once, works, and stops working when revoked", async (t) => {
  const store = memoryStore();
  const keysCall = await withServer(buildKeyApp(store, { sessionFor: "recSELLER1" }), t);
  const apiCall = await withServer(buildApi({ store }).app, t);

  const created = await keysCall("POST", "/api/seller-api/keys", { body: { mode: "test", name: "Staging" } });

  assert.equal(created.status, 200);
  assert.match(created.json.data.key, /^sk_test_/);
  assert.equal(store.keys[0].seller_id, "SE-00001");
  assert.equal("key_hash" in created.json.data, false);

  const listed = await keysCall("GET", "/api/seller-api/keys");
  assert.equal(listed.json.data.items.length, 1);
  assert.equal("key" in listed.json.data.items[0], false, "the key itself is never listed");

  const key = created.json.data.key;
  assert.equal((await apiCall("GET", "/api/v1/inventory", { key })).status, 200);

  const revoked = await keysCall("POST", `/api/seller-api/keys/${created.json.data.id}/revoke`);
  assert.ok(revoked.json.data.revoked_at);

  assert.equal((await apiCall("GET", "/api/v1/inventory", { key })).status, 401);
});

test("a seller cannot revoke someone else's key, and the mode must be live or test", async (t) => {
  const store = memoryStore();
  await issueKey(store, { sellerRecordId: "recOTHER" });

  const call = await withServer(buildKeyApp(store, { sessionFor: "recSELLER1" }), t);

  assert.equal((await call("POST", `/api/seller-api/keys/${store.keys[0].id}/revoke`)).status, 404);
  assert.equal(store.keys[0].revoked_at, undefined);
  assert.equal((await call("POST", "/api/seller-api/keys", { body: { mode: "prod" } })).status, 400);
});

/* ---------------- want-to-buys ---------------- */

test("a want-to-buy is validated before anything is looked up", async () => {
  const { validateWantToBuyInput } = await import("../lib/sellerApi.js");

  assert.deepEqual(
    validateWantToBuyInput({ sku: "dz5485-612", size: "EU 42,5" }, sizeRules).item,
    { sku: "DZ5485-612", size: "42.5", inventoryType: "all", maxPrice: null }
  );

  assert.equal(validateWantToBuyInput({ sku: "X", size: "42", max_price: "" }, sizeRules).item.maxPrice, null);
  assert.equal(validateWantToBuyInput({ sku: "X", size: "42", max_price: 150 }, sizeRules).item.maxPrice, 150);

  const reasons = [
    [{ size: "42" }, /sku is required/],
    [{ sku: "X", size: "36 x3 37 x5" }, /not a valid EU size/],
    [{ sku: "X", size: "42", max_price: 0 }, /max_price/],
    [{ sku: "X", size: "42", max_price: "abc" }, /max_price/],
    [{ sku: "X", size: "42", inventory_type: "wholesale" }, /inventory_type/]
  ];

  for (const [body, reason] of reasons) {
    assert.match(validateWantToBuyInput(body, sizeRules).reason, reason);
  }
});

test("a test key places, lists, reads and cancels want-to-buys without touching the live ones", async (t) => {
  const store = memoryStore();
  const key = await issueKey(store, { mode: "test" });
  const { app, wtbs } = buildApi({
    store,
    catalogue: CATALOGUE,
    createLiveWantToBuy: async () => { throw new Error("a test key reached the live creator"); }
  });
  const call = await withServer(app, t);

  const placed = await call("POST", "/api/v1/want-to-buys", {
    key,
    body: { sku: "DD1503 101", size: "42", max_price: 140, inventory_type: "private" }
  });

  assert.equal(placed.status, 200);
  assert.equal(placed.json.data.item.sku, "DD1503-101", "the catalogue's spelling");
  assert.equal(placed.json.data.item.is_open, true);
  assert.equal(placed.json.data.item.invoice_amount, null);
  assert.equal(wtbs.rows.live.length, 0);
  assert.equal(wtbs.airtable.length, 0);

  const id = placed.json.data.item.id;

  assert.equal((await call("GET", `/api/v1/want-to-buys/${id}`, { key })).json.data.item.max_price, 140);
  assert.equal((await call("GET", "/api/v1/want-to-buys?status=open", { key })).json.data.pagination.total, 1);

  const cancelled = await call("DELETE", `/api/v1/want-to-buys/${id}`, { key });
  assert.equal(cancelled.json.data.item.is_open, false);
  assert.equal(cancelled.json.data.item.fulfillment_status, "Cancelled");

  const again = await call("DELETE", `/api/v1/want-to-buys/${id}`, { key });
  assert.equal(again.status, 200);
  assert.equal(again.json.data.already_cancelled, true);

  assert.equal((await call("GET", "/api/v1/want-to-buys?status=open", { key })).json.data.pagination.total, 0);
  // The cancelled one, and the finished sample purchase every test key has.
  assert.equal((await call("GET", "/api/v1/want-to-buys?status=closed", { key })).json.data.pagination.total, 2);
});

test("a test key sees one finished purchase to build against, which it cannot cancel", async (t) => {
  const store = memoryStore();
  const key = await issueKey(store, { mode: "test" });
  const call = await withServer(buildApi({ store, catalogue: CATALOGUE }).app, t);

  const list = await call("GET", "/api/v1/want-to-buys", { key });
  const [sample] = list.json.data.items;

  assert.equal(list.json.data.pagination.total, 1);
  assert.equal(sample.payment_status, "Paid");
  assert.equal(sample.invoice_amount, 143);
  assert.ok(sample.tracking_number);
  assert.equal(list.json.meta.next_updated_since, sample.updated_at);

  assert.equal((await call("GET", `/api/v1/want-to-buys/${sample.id}`, { key })).status, 200);
  assert.equal((await call("DELETE", `/api/v1/want-to-buys/${sample.id}`, { key })).status, 409);
});

test("an unknown SKU is refused for a test key the way it would be for a live one", async (t) => {
  const store = memoryStore();
  const key = await issueKey(store, { mode: "test" });
  const call = await withServer(buildApi({ store, catalogue: CATALOGUE }).app, t);

  const res = await call("POST", "/api/v1/want-to-buys", { key, body: { sku: "NOPE-000", size: "42" } });

  assert.equal(res.status, 404);
  assert.match(res.json.message, /could not be found/);
});

test("a live key goes through the portal's creator and lands in the feed at once", async (t) => {
  const store = memoryStore();
  const key = await issueKey(store);
  const { app, wtbs } = buildApi({ store, catalogue: CATALOGUE });
  const call = await withServer(app, t);

  const placed = await call("POST", "/api/v1/want-to-buys", { key, body: { sku: "DZ5485-612", size: "43" } });

  assert.equal(placed.status, 200);
  assert.equal(wtbs.airtable.length, 1);
  assert.equal(wtbs.rows.live.length, 1);
  assert.match(placed.json.data.item.id, /^[0-9a-f-]{36}$/, "the feed's id, not the Airtable record id");
  assert.equal(placed.json.data.item.max_price, null);
  assert.equal(placed.json.data.item.is_open, true);

  const listed = await call("GET", "/api/v1/want-to-buys", { key });
  assert.deepEqual(listed.json.data.items.map((i) => i.id), [placed.json.data.item.id]);
});

test("the creator's own refusals keep their status instead of becoming a 500", async (t) => {
  const store = memoryStore();
  const key = await issueKey(store);
  const call = await withServer(
    buildApi({
      store,
      createLiveWantToBuy: async () => {
        throw Object.assign(new Error('SKU "ZZ" could not be found or confirmed in our database.'), { statusCode: 404 });
      }
    }).app,
    t
  );

  const res = await call("POST", "/api/v1/want-to-buys", { key, body: { sku: "ZZ", size: "42" } });

  assert.equal(res.status, 404);
  assert.match(res.json.message, /could not be found/);
});

test("B2B Only is refused for a buyer without a VAT ID, in both modes", async (t) => {
  const store = memoryStore();
  const live = await issueKey(store);
  const testKey = await issueKey(store, { mode: "test" });
  const call = await withServer(
    buildApi({ store, catalogue: CATALOGUE, b2bRefusal: async (type) => (type === "b2b" ? "B2B Only is for buyers with a VAT ID." : null) }).app,
    t
  );

  for (const key of [live, testKey]) {
    const res = await call("POST", "/api/v1/want-to-buys", { key, body: { sku: "DZ5485-612", size: "42", inventory_type: "b2b" } });

    assert.equal(res.status, 400);
    assert.match(res.json.message, /VAT ID/);
  }
});

test("cancelling is decided on Airtable as it is now, not on a feed that is behind", async (t) => {
  const store = memoryStore();
  const mine = await issueKey(store, { sellerRecordId: "recMINE" });
  const theirs = await issueKey(store, { sellerRecordId: "recTHEIRS", sellerId: "SE-00002" });
  const wtbs = memoryWantToBuys();
  const call = await withServer(buildApi({ store, catalogue: CATALOGUE, wtbs }).app, t);

  const record = wtbs.addRecord("recMINE", { SKU: "DZ5485-612", Size: "42" });
  const row = await wtbs.stores.live.upsertFromRecord(wantToBuyRowFromRecord(record));

  // A seller accepted a minute ago; the feed still says Outsource.
  Object.assign(record.fields, { "Fulfillment Status": "Allocated", "Payment Status": "Awaiting Payment", "Invoice Price": 210 });

  const refused = await call("DELETE", `/api/v1/want-to-buys/${row.id}`, { key: mine });
  assert.equal(refused.status, 409);
  assert.equal(record.fields["Fulfillment Status"], "Allocated");
  assert.equal(wtbs.rows.live[0].fulfillment_status, "Allocated", "and the feed is brought up to date on the way");

  assert.equal((await call("GET", `/api/v1/want-to-buys/${row.id}`, { key: theirs })).status, 404);
  assert.equal((await call("DELETE", `/api/v1/want-to-buys/${row.id}`, { key: theirs })).status, 404);
  assert.equal((await call("GET", "/api/v1/want-to-buys/not-an-id", { key: mine })).status, 404);
});

test("an open live want-to-buy is cancelled in Airtable and in the feed", async (t) => {
  const store = memoryStore();
  const key = await issueKey(store, { sellerRecordId: "recMINE" });
  const wtbs = memoryWantToBuys();
  const call = await withServer(buildApi({ store, catalogue: CATALOGUE, wtbs }).app, t);

  const record = wtbs.addRecord("recMINE", { SKU: "DZ5485-612", Size: "42" });
  const row = await wtbs.stores.live.upsertFromRecord(wantToBuyRowFromRecord(record));

  const res = await call("DELETE", `/api/v1/want-to-buys/${row.id}`, { key });

  assert.equal(res.status, 200);
  assert.equal(res.json.data.item.fulfillment_status, "Cancelled");
  assert.equal(record.fields["Fulfillment Status"], "Cancelled");
  assert.equal(wtbs.rows.live[0].fulfillment_status, "Cancelled");
});

test("a feed row whose Airtable record no longer names this buyer is not theirs", async (t) => {
  const store = memoryStore();
  const key = await issueKey(store, { sellerRecordId: "recMINE" });
  const wtbs = memoryWantToBuys();
  const call = await withServer(buildApi({ store, catalogue: CATALOGUE, wtbs }).app, t);

  const record = wtbs.addRecord("recMINE", { SKU: "DZ5485-612", Size: "42" });
  const row = await wtbs.stores.live.upsertFromRecord(wantToBuyRowFromRecord(record));

  record.fields["Buyer Seller ID"] = ["recSOMEONEELSE"];

  assert.equal((await call("DELETE", `/api/v1/want-to-buys/${row.id}`, { key })).status, 404);
  assert.equal(record.fields["Fulfillment Status"], "Outsource");
});

test("a seller who is not a consignor cannot list stock, but can still read and remove it", async (t) => {
  const store = memoryStore();
  const live = await issueKey(store, { sellerRecordId: "recNOTCONSIGNOR" });
  const testKey = await issueKey(store, { sellerRecordId: "recNOTCONSIGNOR", mode: "test" });
  const { app, refreshed } = buildApi({
    store,
    catalogue: CATALOGUE,
    consignorRefusal: async () => ({ status: 403, message: "Consignment is not enabled for your account." })
  });
  const call = await withServer(app, t);

  store.tables.live.push({ id: "5b7f6c1e-0d2a-4c3b-9e8f-7a6b5c4d3e2f", seller_record_id: "recNOTCONSIGNOR", sku: "DZ5485-612", size: "42", vat_type: "Margin", selling_price_suggested: 180, quantity: 1 });

  for (const key of [live, testKey]) {
    const res = await call("POST", "/api/v1/inventory", { key, body: { items: [{ sku: "DZ5485-612", size: "43", vat_type: "Margin", price: 180 }] } });

    assert.equal(res.status, 403);
    assert.equal(res.json.code, "not_consignor");
  }

  assert.equal(store.tables.live.length, 1, "nothing was written");
  assert.equal(store.tables.test.length, 0);
  assert.deepEqual(refreshed, []);

  assert.equal((await call("GET", "/api/v1/inventory", { key: live })).json.data.pagination.total, 1);
  assert.equal((await call("DELETE", "/api/v1/inventory", { key: live, body: { id: "5b7f6c1e-0d2a-4c3b-9e8f-7a6b5c4d3e2f" } })).json.data.deleted_count, 1);
});
