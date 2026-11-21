import test from "node:test";
import assert from "node:assert/strict";
import { createAsiaPartnerFlow, storePriceFor, partnerMaxFor, minProfitFor, expiresAt } from "../lib/asiaPartner.js";

test("store price: halfway Target-Max, at most Dewu + 40, a counter split 50/50", () => {
  // Autopriced store, our 20 in the Max: the store stays on its Max, a counter comes off our side.
  assert.equal(storePriceFor({ target: 0, max: 120, dewu: 100, partnerPrice: 100, minProfit: 10 }), 120);
  assert.equal(storePriceFor({ target: 0, max: 120, dewu: 100, partnerPrice: 106, minProfit: 10 }), 120);
  // Room up to the Max: half each.
  assert.equal(storePriceFor({ target: 150, max: 160, dewu: 110, partnerPrice: 110, minProfit: 10 }), 150);
  assert.equal(storePriceFor({ target: 150, max: 160, dewu: 110, partnerPrice: 116, minProfit: 10 }), 153);
  // The store's half hits its Max: it pays the Max, we keep the rest (12).
  assert.equal(storePriceFor({ target: 140, max: 160, dewu: 120, partnerPrice: 148, minProfit: 10 }), 160);
  // Our half would drop below the minimum: the store takes more, up to its Max.
  assert.equal(storePriceFor({ target: 120, max: 160, dewu: 120, partnerPrice: 145, minProfit: 10 }), 155);
  // A partner below Dewu: the store price does not move.
  assert.equal(storePriceFor({ target: 150, max: 160, dewu: 110, partnerPrice: 105, minProfit: 10 }), 150);
});

test("partner max and minimum profit per store", () => {
  assert.equal(partnerMaxFor({ max: 160, minProfit: 10 }), 150);
  assert.equal(partnerMaxFor({ max: 260, minProfit: 10 }), 200);
  assert.equal(minProfitFor({}), 10);
  assert.equal(minProfitFor({ "Asia Min Spread": 0 }), 0);
  assert.equal(minProfitFor({ "Asia Min Spread": 20 }), 10);
  assert.equal(expiresAt("2026-11-20T10:00:00.000Z").toISOString(), "2026-11-22T10:00:00.000Z");
});

// ---- a small Airtable + Discord stand-in

function world({ orderFields = {}, merchant = {} } = {}) {
  const tables = {
    "Unfulfilled Orders Log": {
      recORDER: {
        "Order ID": "ORD-1", "Fulfillment Status": "Outsource", "Most Valid Sourcing": "Dewu", "Dewu Checked Price": 110,
        "Maximum Buying Price": 160, "Target Buying Price": 150, "Order Date": "2026-11-21T08:00:00.000Z", Client: ["recM"],
        "Auto Offer Accept?": ["Yes"], SKU: "DD1391-100", Size: "42", "Product Name": "Dunk", ...orderFields
      }
    },
    Merchants: { recM: merchant },
    "Sellers Database": { recDEWU: { "Seller ID": "SE-00455", "Dewu Supplier?": true } },
    "Partner Offers": {}
  };
  const log = [];
  let n = 0;
  const table = (name) => ({
    find: async (id) => {
      const fields = tables[name][id];
      if (!fields) throw new Error(`${name} ${id} not found`);
      return { id, fields: { ...fields } };
    },
    update: async (id, fields) => {
      log.push(["update", name, id, fields]);
      Object.assign(tables[name][id], fields);
    },
    create: async (fields) => {
      const id = `recPO${++n}`;
      tables[name][id] = { ...fields, "Order ID": ["ORD-1"], "Partner Offer ID": `POFF-${n}` };
      log.push(["create", name, id, fields]);
      return { id, fields };
    },
    select: ({ filterByFormula }) => ({
      all: async () => {
        const rows = Object.entries(tables[name]).map(([id, fields]) => ({ id, fields }));
        if (name === "Unfulfilled Orders Log") return rows.filter((r) => r.fields["Fulfillment Status"] === "Outsource" && r.fields["Most Valid Sourcing"] === "Dewu" && !r.fields["Dewu Declined?"]);
        if (name === "Sellers Database") return rows;
        if (name === "Partner Offers" && /Sent', \{Asia Status\} = 'Waiting/.test(filterByFormula) && !/Accepted/.test(filterByFormula)) return rows.filter((r) => ["Sent", "Waiting for Store"].includes(r.fields["Asia Status"]));
        if (name === "Partner Offers") return rows.filter((r) => ["Sent", "Waiting for Store", "Accepted"].includes(r.fields["Asia Status"]));
        return rows;
      }
    })
  });
  const sent = [];
  const channel = {
    send: async (m) => { sent.push(m); return { id: `msg${sent.length}` }; },
    messages: { fetch: async () => ({ edit: async (m) => sent.push({ edited: m }) }) }
  };
  const deals = [];
  const checks = [];
  let clock = new Date("2026-11-21T12:00:00.000Z");
  const flow = createAsiaPartnerFlow({
    table,
    getChannel: async () => channel,
    channelId: "chan",
    partnerDiscordId: "partner",
    lojiqDeal: async (body) => { deals.push(body); return { ok: true }; },
    outsourceCheck: async (id) => checks.push(id),
    now: () => clock
  });
  return { flow, tables, log, sent, deals, checks, setClock: (d) => { clock = new Date(d); } };
}

test("a Dewu order is offered once: Dewu Processing, Partner Offer, message with buttons", async () => {
  const w = world();
  const { made } = await w.flow.sweep();
  assert.deepEqual(made, ["ORD-1"]);
  assert.equal(w.tables["Unfulfilled Orders Log"].recORDER["Fulfillment Status"], "Dewu Processing");
  const po = w.tables["Partner Offers"].recPO1;
  assert.equal(po["Asia Status"], "Sent");
  assert.equal(po["Our Ask"], 110);
  assert.equal(po["Partner Max"], 150);
  assert.equal(po["Expires At"], "2026-11-23T08:00:00.000Z");
  assert.equal(po["Discord Message ID"], "msg1");
  assert.equal(w.sent[0].components[0].components.length, 3);

  // A second sweep does not offer it again.
  w.tables["Unfulfilled Orders Log"].recORDER["Fulfillment Status"] = "Outsource";
  assert.deepEqual((await w.flow.sweep()).made, []);
});

test("an order more than 48 hours old, or above 200, is not offered", async () => {
  assert.deepEqual((await world({ orderFields: { "Order Date": "2026-11-19T11:00:00.000Z" } }).flow.sweep()).made, []);
  assert.deepEqual((await world({ orderFields: { "Dewu Checked Price": 205, "Maximum Buying Price": 260 } }).flow.sweep()).made, []);
});

test("auto-accept store: his price above the max is refused, within it the deal is made right away", async () => {
  const w = world();
  await w.flow.sweep();
  const tooHigh = await w.flow.settle("recPO1", 151);
  assert.equal(tooHigh.ok, false);
  assert.match(tooHigh.say, /€150/);
  assert.equal(w.deals.length, 0);

  const out = await w.flow.settle("recPO1", 116);
  assert.equal(out.status, "Accepted");
  assert.deepEqual(w.deals, [{ order_record_id: "recORDER", payout: 116, store_price: 153 }]);
  assert.equal(w.tables["Partner Offers"].recPO1["Asia Status"], "Accepted");
  assert.match(w.sent.at(-1).content, /Deal confirmed/);

  // Closed now.
  assert.equal((await w.flow.settle("recPO1", 110)).ok, false);
});

test("store without auto-accept: offer to the store first, the deal follows its accept", async () => {
  const w = world({ orderFields: { "Auto Offer Accept?": ["No"] } });
  await w.flow.sweep();
  const out = await w.flow.settle("recPO1", 110);
  assert.equal(out.status, "Waiting for Store");
  assert.equal(w.deals.length, 0);
  const o = w.tables["Unfulfilled Orders Log"].recORDER;
  assert.equal(o["Custom Offer"], 150);
  assert.equal(o["Offer Sent?"], true);
  assert.equal(o["Estimated Time"], "8-10 business days");
  assert.equal(o.offer_request_webhook_key, "");
  assert.ok(!w.sent.some((m) => /Deal confirmed/.test(m.content || "")), "no deal message yet");

  // Store accepts in its portal.
  Object.assign(o, { "Offer Accepted?": true, "Fulfillment Status": "Confirmed" });
  await w.flow.sweep();
  assert.deepEqual(w.deals, [{ order_record_id: "recORDER", payout: 110, store_price: 150 }]);
  assert.equal(w.tables["Partner Offers"].recPO1["Asia Status"], "Accepted");
  assert.match(w.sent.at(-1).content, /Deal confirmed/);
});

test("store denies: no deal, partner told, order back to Outsource without Dewu", async () => {
  const w = world({ orderFields: { "Auto Offer Accept?": ["No"] } });
  await w.flow.sweep();
  await w.flow.settle("recPO1", 110);
  w.tables["Unfulfilled Orders Log"].recORDER["Offer Denied?"] = true;
  await w.flow.sweep();
  const o = w.tables["Unfulfilled Orders Log"].recORDER;
  assert.equal(w.tables["Partner Offers"].recPO1["Asia Status"], "Store Declined");
  assert.equal(o["Fulfillment Status"], "Outsource");
  assert.equal(o["Dewu Declined?"], true);
  assert.equal(o["Custom Offer"], null);
  assert.deepEqual(w.checks, ["recORDER"]);
  assert.match(w.sent.at(-1).content, /No deal/);
  assert.equal(w.deals.length, 0);
});

test("partner declines, or 48 hours pass: back to Outsource without Dewu", async () => {
  const w = world();
  await w.flow.sweep();
  assert.equal((await w.flow.decline("recPO1")).status, "Declined");
  assert.equal(w.tables["Unfulfilled Orders Log"].recORDER["Fulfillment Status"], "Outsource");
  assert.equal(w.tables["Unfulfilled Orders Log"].recORDER["Dewu Declined?"], true);

  const x = world();
  await x.flow.sweep();
  x.setClock("2026-11-23T08:00:00.000Z");
  await x.flow.sweep();
  assert.equal(x.tables["Partner Offers"].recPO1["Asia Status"], "Expired");
  assert.equal(x.tables["Unfulfilled Orders Log"].recORDER["Fulfillment Status"], "Outsource");
  assert.equal((await x.flow.settle("recPO1", 110)).ok, false);
});

test("the store fulfils it itself meanwhile: the offer is cancelled", async () => {
  const w = world();
  await w.flow.sweep();
  w.tables["Unfulfilled Orders Log"].recORDER["Fulfillment Status"] = "Store Fulfilled";
  await w.flow.sweep();
  assert.equal(w.tables["Partner Offers"].recPO1["Asia Status"], "Cancelled");
  assert.equal(w.deals.length, 0);
});

test("a double click makes one deal", async () => {
  const w = world();
  await w.flow.sweep();
  const [a, b] = await Promise.all([w.flow.settle("recPO1", 110), w.flow.settle("recPO1", 110)]);
  assert.equal([a, b].filter((r) => r.ok).length, 1);
  assert.equal(w.deals.length, 1);
});
