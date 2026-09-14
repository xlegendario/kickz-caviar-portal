import test from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import express from "express";

import {
  DISABLE_AFTER_FAILED_DELIVERIES,
  RETRY_DELAYS_MS,
  deliverDue,
  enqueueEvents,
  generateWebhookSecret,
  isPrivateAddress,
  sendWebhook,
  signPayload,
  validateWebhookUrl,
  verifyWebhookSignature
} from "../lib/sellerApiWebhooks.js";
import { deriveEventTypes, syncSales } from "../lib/sellerApiSales.js";
import { createApiKeyRouter, createSellerApiRouter, generateApiKey, sellerApiErrorHandler } from "../lib/sellerApi.js";

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

/* ---------------- signing ---------------- */

test("a signature verifies, and fails on a changed body, another secret or an old timestamp", () => {
  const secret = generateWebhookSecret();
  const body = JSON.stringify({ id: "evt", type: "sale.created" });
  const now = 1_757_800_000_000;
  const timestamp = Math.floor(now / 1000);
  const signature = `sha256=${signPayload({ secret, timestamp, body })}`;

  assert.match(secret, /^whsec_[A-Za-z0-9_-]{40,}$/);
  assert.equal(verifyWebhookSignature({ secret, body, timestamp, signature, now }), true);
  assert.equal(verifyWebhookSignature({ secret, body: body + " ", timestamp, signature, now }), false);
  assert.equal(verifyWebhookSignature({ secret: generateWebhookSecret(), body, timestamp, signature, now }), false);
  assert.equal(verifyWebhookSignature({ secret, body, timestamp, signature, now: now + 10 * 60_000 }), false, "a replay ten minutes later");
});

/* ---------------- where we send ---------------- */

test("only a public https address is accepted", () => {
  assert.equal(validateWebhookUrl("https://hooks.example.com/kc"), null);

  const refused = [
    ["", /required/],
    ["http://hooks.example.com/kc", /https/],
    ["https://user:pass@hooks.example.com", /username/],
    ["https://localhost:3000/hook", /public/],
    ["https://127.0.0.1/hook", /public/],
    ["https://10.0.0.5/hook", /public/],
    ["https://192.168.1.10/hook", /public/],
    ["https://169.254.169.254/latest/meta-data", /public/],
    ["https://[::1]/hook", /public/],
    ["https://render.internal/hook", /public/],
    ["not a url", /valid/]
  ];

  for (const [url, reason] of refused) assert.match(validateWebhookUrl(url), reason, url);
});

test("private address ranges are recognised, including IPv4 hidden in IPv6", () => {
  for (const ip of ["10.1.2.3", "172.16.0.1", "172.31.255.255", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:192.168.0.1"]) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }

  for (const ip of ["93.184.216.34", "172.32.0.1", "8.8.8.8", "2606:4700::1111"]) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
});

test("a delivery is signed, not redirected, and refused when the name resolves inward", async () => {
  const secret = generateWebhookSecret();
  let seen;

  const fetchImpl = async (url, init) => {
    seen = { url, init };

    return { status: 204 };
  };

  const payload = { id: "evt_1", type: "label.ready", data: {} };
  const sent = await sendWebhook({ url: "https://hooks.example.com/kc", secret, payload, deliveryId: "d1", fetchImpl, lookup: publicLookup });

  assert.equal(sent.ok, true);
  assert.equal(seen.init.redirect, "manual");
  assert.equal(seen.init.headers["X-Webhook-Event"], "label.ready");
  assert.equal(
    verifyWebhookSignature({
      secret,
      body: seen.init.body,
      timestamp: seen.init.headers["X-Webhook-Timestamp"],
      signature: seen.init.headers["X-Webhook-Signature"]
    }),
    true
  );

  const inward = await sendWebhook({
    url: "https://sneaky.example.com/kc",
    secret,
    payload,
    deliveryId: "d2",
    fetchImpl: async () => { throw new Error("must not be called"); },
    lookup: async () => [{ address: "10.0.0.7", family: 4 }]
  });

  assert.equal(inward.ok, false);
  assert.match(inward.error, /public/);

  const refused = await sendWebhook({ url: "https://hooks.example.com/kc", secret, payload, deliveryId: "d3", fetchImpl: async () => ({ status: 500 }), lookup: publicLookup });

  assert.deepEqual([refused.ok, refused.statusCode], [false, 500]);
});

/* ---------------- events ---------------- */

test("a change becomes the most specific event it can", () => {
  const sold = { role: "sold", status: "active", has_label: false };

  assert.deepEqual(deriveEventTypes(null, sold), ["sale.created"]);
  assert.deepEqual(deriveEventTypes(sold, { ...sold, status: "cancelled" }), ["sale.cancelled"]);
  assert.deepEqual(deriveEventTypes(sold, { ...sold, has_label: true }), ["label.ready"]);
  assert.deepEqual(deriveEventTypes({ ...sold, role: "bought" }, { ...sold, role: "bought", has_label: true }), ["sale.updated"], "a buyer has no label to be told about");
  assert.deepEqual(deriveEventTypes(sold, { ...sold, tracking_number: "0516" }), ["sale.updated"]);
});

function salesFixture() {
  const rows = [];

  return {
    rows,
    async findByUnitIds(ids) {
      return rows.filter((r) => ids.includes(r.unit_record_id));
    },
    async insertMany(list) {
      const written = list.map((row) => ({ id: crypto.randomUUID(), ...row }));
      rows.push(...written);

      return written;
    },
    async updateMany(list) {
      for (const { id, ...row } of list) Object.assign(rows.find((r) => r.id === id), row);
    }
  };
}

test("the sync hands over events only when asked, never on the first fill", async () => {
  const theOrder = { id: "recO", fields: { "Fulfillment Status": "Allocated", "Shopify Order Number": "7454" } };
  const units = [{ id: "recU", fields: { "Seller Record ID": ["recS"], "Unfulfilled Orders Log": ["recO"], "Created Time": "2026-09-14T10:00:00Z" } }];
  const reader = { listUnits: async () => units, listOrders: async () => [theOrder], listWantToBuys: async () => [] };
  const store = salesFixture();
  const quiet = { log() {} };

  const fill = await syncSales({ reader, store, windowDays: null, logger: quiet });
  assert.equal(fill.events, undefined, "the first fill announces nothing");

  theOrder.fields["Shipping Label"] = [{ url: "https://dl.airtable.com/l.pdf" }];

  const next = await syncSales({ reader, store, emitEvents: true, logger: quiet });

  assert.equal(next.events.length, 1);
  assert.equal(next.events[0].type, "label.ready");
  assert.equal(next.events[0].partyRecordId, "recS");
  assert.equal(next.events[0].item.label_available, true);
  assert.equal(next.events[0].item.id, store.rows[0].id, "the event carries the id the feed shows");
});

/* ---------------- the outbox ---------------- */

function webhookFixture(hooks = []) {
  const deliveries = [];

  return {
    hooks,
    deliveries,
    async activeWebhooksFor(parties) {
      return hooks.filter((h) => parties.includes(h.seller_record_id) && !h.disabled_at);
    },
    async insertDeliveries(rows) {
      for (const row of rows) deliveries.push({ id: crypto.randomUUID(), status: "pending", attempts: 0, ...row });
    },
    async dueDeliveries({ at, limit }) {
      return deliveries
        .filter((d) => d.status === "pending" && d.next_attempt_at <= at)
        .slice(0, limit)
        .map((d) => ({ ...d, webhook: { ...hooks.find((h) => h.id === d.webhook_id) } }));
    },
    async updateDelivery(id, patch) {
      Object.assign(deliveries.find((d) => d.id === id), patch);
    },
    async updateWebhook(id, patch) {
      Object.assign(hooks.find((h) => h.id === id), patch);
    }
  };
}

const hook = (id, extra = {}) => ({ id, seller_record_id: "recS", url: "https://hooks.example.com/kc", secret: "whsec_x", events: ["sale.created", "sale.updated", "sale.cancelled", "label.ready"], consecutive_failures: 0, ...extra });

test("an event goes to each webhook of that party that asked for it, and nowhere else", async () => {
  const store = webhookFixture([
    hook("h-all"),
    hook("h-labels", { events: ["label.ready"] }),
    hook("h-other", { seller_record_id: "recOTHER" }),
    hook("h-off", { disabled_at: "2026-09-01T00:00:00Z" })
  ]);

  const queued = await enqueueEvents({
    store,
    events: [
      { type: "sale.created", partyRecordId: "recS", item: { id: "s1" } },
      { type: "label.ready", partyRecordId: "recS", item: { id: "s1" } }
    ]
  });

  assert.equal(queued, 3);
  assert.deepEqual(store.deliveries.map((d) => `${d.webhook_id}:${d.event_type}`).sort(), ["h-all:label.ready", "h-all:sale.created", "h-labels:label.ready"]);
  assert.equal(store.deliveries[0].payload.data.item.id, "s1");
  assert.equal(await enqueueEvents({ store: webhookFixture([]), events: [{ type: "sale.created", partyRecordId: "recS", item: {} }] }), 0);
});

test("a failed delivery is retried on schedule, and a delivered one clears the failure count", async () => {
  const store = webhookFixture([hook("h1", { consecutive_failures: 3 })]);
  let clock = new Date("2026-09-14T10:00:00.000Z");

  await enqueueEvents({ store, events: [{ type: "sale.created", partyRecordId: "recS", item: {} }], now: () => clock });

  const down = await deliverDue({ store, now: () => clock, send: async () => ({ ok: false, statusCode: 502, error: "HTTP 502" }) });

  assert.equal(down.retrying, 1);
  assert.equal(store.deliveries[0].attempts, 1);
  assert.equal(store.deliveries[0].next_attempt_at, new Date(clock.getTime() + RETRY_DELAYS_MS[0]).toISOString());

  const tooEarly = await deliverDue({ store, now: () => clock, send: async () => { throw new Error("not due yet"); } });
  assert.equal(tooEarly.attempted, 0);

  clock = new Date(clock.getTime() + RETRY_DELAYS_MS[0]);
  const up = await deliverDue({ store, now: () => clock, send: async () => ({ ok: true, statusCode: 200 }) });

  assert.equal(up.delivered, 1);
  assert.equal(store.deliveries[0].status, "delivered");
  assert.equal(store.hooks[0].consecutive_failures, 0);
});

test("a delivery that runs out of retries fails, and enough of those switch the webhook off", async () => {
  const store = webhookFixture([hook("h1", { consecutive_failures: DISABLE_AFTER_FAILED_DELIVERIES - 2 })]);
  const clock = new Date("2026-09-14T10:00:00.000Z");

  // Two deliveries already on their last attempt, due in the same run.
  for (let i = 0; i < 2; i++) {
    store.deliveries.push({
      id: `d${i}`,
      webhook_id: "h1",
      status: "pending",
      attempts: RETRY_DELAYS_MS.length,
      next_attempt_at: clock.toISOString(),
      payload: { type: "sale.updated" }
    });
  }

  const result = await deliverDue({ store, now: () => clock, send: async () => ({ ok: false, error: "timed out after 10s" }), logger: { warn() {} } });

  assert.equal(result.failed, 2);
  assert.ok(store.deliveries.every((d) => d.status === "failed"));
  assert.equal(store.hooks[0].consecutive_failures, DISABLE_AFTER_FAILED_DELIVERIES, "two failures in one run count as two");
  assert.ok(store.hooks[0].disabled_at);
  assert.match(store.hooks[0].disabled_reason, /in a row/);
});

/* ---------------- management ---------------- */

function managementStore() {
  const rows = [];

  return {
    rows,
    async listWebhooks(seller) {
      return rows.filter((r) => r.seller_record_id === seller).map(({ secret, ...rest }) => rest);
    },
    async countActiveWebhooks(seller) {
      return rows.filter((r) => r.seller_record_id === seller && !r.disabled_at).length;
    },
    async insertWebhook(row) {
      const created = { id: crypto.randomUUID(), created_at: new Date().toISOString(), consecutive_failures: 0, ...row };
      rows.push(created);
      const { secret, ...rest } = created;

      return rest;
    },
    async findWebhookWithSecret({ id, sellerRecordId }) {
      return rows.find((r) => r.id === id && r.seller_record_id === sellerRecordId) || null;
    },
    async deleteWebhook({ id, sellerRecordId }) {
      const i = rows.findIndex((r) => r.id === id && r.seller_record_id === sellerRecordId);
      if (i >= 0) rows.splice(i, 1);
    },
    async updateWebhook(id, patch) {
      Object.assign(rows.find((r) => r.id === id), patch);
    },
    async recentDeliveries() {
      return [];
    },
    async activeWebhooksWithSecret(seller) {
      return rows.filter((r) => r.seller_record_id === seller && !r.disabled_at);
    }
  };
}

async function listen(app, t) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });

  t.after(() => server.close());

  return async (method, path, { body, headers = {} } = {}) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method,
      headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined
    });

    return { status: res.status, json: await res.json() };
  };
}

function managementApp(webhookStore, { sessionFor = "recS", sent = [] } = {}) {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/seller-api",
    createApiKeyRouter({
      store: {},
      identify: () => (sessionFor ? { sellerRecordId: sessionFor } : { status: 401, error: "Not signed in" }),
      lookupSellerId: async () => "SE-00001",
      webhookStore,
      send: async (args) => {
        sent.push(args);

        return { ok: true, statusCode: 200 };
      }
    })
  );
  app.use("/api/seller-api", sellerApiErrorHandler);

  return app;
}

test("a webhook is created with its secret shown once, and refused for a bad address or past the limit", async (t) => {
  const webhookStore = managementStore();
  const call = await listen(managementApp(webhookStore), t);

  const bad = await call("POST", "/api/seller-api/webhooks", { body: { url: "http://hooks.example.com" } });
  assert.equal(bad.status, 400);

  const wrongEvents = await call("POST", "/api/seller-api/webhooks", { body: { url: "https://hooks.example.com", events: ["order.paid"] } });
  assert.equal(wrongEvents.status, 400);

  const created = await call("POST", "/api/seller-api/webhooks", { body: { url: "https://hooks.example.com/kc", events: ["label.ready"] } });
  assert.equal(created.status, 200);
  assert.match(created.json.data.secret, /^whsec_/);
  assert.deepEqual(created.json.data.events, ["label.ready"]);

  const listed = await call("GET", "/api/seller-api/webhooks");
  assert.equal("secret" in listed.json.data.items[0], false, "never listed again");

  for (let i = 1; i < 5; i++) {
    assert.equal((await call("POST", "/api/seller-api/webhooks", { body: { url: `https://hooks.example.com/${i}` } })).status, 200);
  }

  const sixth = await call("POST", "/api/seller-api/webhooks", { body: { url: "https://hooks.example.com/6" } });
  assert.equal(sixth.status, 400);
});

test("a webhook can be tested, re-enabled and removed by its owner only", async (t) => {
  const webhookStore = managementStore();
  const sent = [];
  const mine = await listen(managementApp(webhookStore, { sent }), t);
  const theirs = await listen(managementApp(webhookStore, { sessionFor: "recOTHER" }), t);
  const nobody = await listen(managementApp(webhookStore, { sessionFor: null }), t);

  const created = await mine("POST", "/api/seller-api/webhooks", { body: { url: "https://hooks.example.com/kc" } });
  const id = created.json.data.id;

  assert.equal((await nobody("GET", "/api/seller-api/webhooks")).status, 401);
  assert.equal((await theirs("POST", `/api/seller-api/webhooks/${id}/test`)).status, 404);
  assert.equal((await theirs("DELETE", `/api/seller-api/webhooks/${id}`)).status, 404);

  const tested = await mine("POST", `/api/seller-api/webhooks/${id}/test`, { body: { type: "label.ready" } });
  assert.equal(tested.json.data.delivered, true);
  assert.equal(sent[0].payload.test, true);
  assert.equal(sent[0].payload.type, "label.ready");
  assert.equal(sent[0].secret, created.json.data.secret);

  webhookStore.rows[0].disabled_at = "2026-09-14T00:00:00Z";
  webhookStore.rows[0].consecutive_failures = 5;

  const enabled = await mine("POST", `/api/seller-api/webhooks/${id}/enable`);
  assert.equal(enabled.json.data.active, true);
  assert.equal(webhookStore.rows[0].consecutive_failures, 0);

  assert.equal((await mine("DELETE", `/api/seller-api/webhooks/${id}`)).status, 200);
  assert.equal(webhookStore.rows.length, 0);
});

test("with a key, a developer can fire a test event at their own webhooks", async (t) => {
  const webhookStore = managementStore();
  const sent = [];
  const generated = generateApiKey("test");
  const keyRow = { id: "k1", seller_record_id: "recS", seller_id: "SE-00001", mode: "test", key_hash: generated.hash };

  const app = express();
  app.use(express.json());
  app.use(
    "/api/v1",
    createSellerApiRouter({
      store: { findActiveKeyByHash: async (h) => (h === keyRow.key_hash ? keyRow : null), touchKey: async () => {} },
      webhookStore,
      sendWebhookImpl: async (args) => {
        sent.push(args);

        return { ok: false, statusCode: 401, error: "HTTP 401" };
      },
      normalizeSize: (s) => s,
      isUsableSize: () => true,
      sizeError: () => "",
      vatEligibilityError: async () => null,
      logger: { error() {} }
    })
  );

  const call = await listen(app, t);
  const auth = { Authorization: `Bearer ${generated.key}` };

  const none = await call("POST", "/api/v1/webhooks/test", { headers: auth });
  assert.equal(none.status, 404);

  webhookStore.rows.push({ id: "w1", seller_record_id: "recS", url: "https://hooks.example.com/kc", secret: "whsec_s", events: ["sale.created"] });

  const res = await call("POST", "/api/v1/webhooks/test", { headers: auth });
  assert.equal(res.status, 200);
  assert.equal(res.json.data.items[0].delivered, false);
  assert.equal(res.json.data.items[0].status_code, 401, "their receiver's answer, passed back");
  assert.equal(sent.length, 1);
});
