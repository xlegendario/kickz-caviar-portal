// lib/sellerApiSales.js
//
// The sales feed: what each seller sold, as rows the API can hand out and
// poll on.
//
// A sale is an Inventory Unit, and it is final the moment that unit exists -
// that is when the Deal Update with its Request Label button goes out. Before
// it, everything is a question somebody can still refuse.
//
// A sale belongs to the seller on the unit, when the unit fills a store order,
// a Member WTB or a broker deal (an External Sale we brokered from the
// seller's stock). Units with none of these are the forwarding service, or
// our own stock sold on, and are left out.
//
// The buyer is deliberately not here. What a buyer buys is the Member WTB,
// with our margin in its invoice; the unit is what WE buy from the seller. So
// a purchase is followed on the want-to-buy itself - see
// sellerApiWantToBuys.js - and never as the other side of a unit. A store's
// own Shopify orders have nothing to do with the API either.
//
// The rows live in Supabase and are refreshed by syncSales. Reading Airtable
// on every API call would spend our shared allowance on polling, and Airtable
// cannot answer "what changed since" for a unit whose only change is the
// tracking number arriving on its order.

import crypto from "crypto";

import { changedFields } from "./sellerApiWebhooks.js";

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());
const first = (value) => (Array.isArray(value) ? value[0] : value);
const ids = (value) => (Array.isArray(value) ? value.filter(Boolean).map(String) : []);
const money = (value) => {
  const n = Number(first(value));

  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
};

const hasAttachment = (value) => Array.isArray(value) && value.some((a) => text(a?.url));

export const UNIT_FIELDS = [
  "SKU",
  "Size",
  "Product Name",
  "Final Purchase Price",
  "Payment Status",
  "Created Time",
  "Seller Record ID",
  "Unfulfilled Orders Log",
  "Member WTBs",
  "External Deal ID"
];

export const ORDER_FIELDS = [
  "Order ID",
  "Shopify Order Number",
  "Product Name",
  "Fulfillment Status",
  "Shipping Status",
  "Tracking Number",
  "Tracking URL",
  "Shipping Label",
  "Shipping Label URL (Permanent)"
];

export const WTB_FIELDS = [
  "Member WTB ID",
  "Product Name",
  "Fulfillment Status",
  "Shipping Status",
  "Payment Status",
  "Tracking Number",
  "Tracking URL",
  "Shipping Label",
  "Shipping Label Permanent URL",
];

/*
 * Which of a unit's orders is the live one.
 *
 * A unit keeps its old order link when a cancelled deal is handed to a new
 * buyer, so "Cancelled, Ready to Ship" on one unit is ordinary. The sale is
 * whichever order is not cancelled; only when every one of them is, is the
 * sale itself cancelled.
 */
export function pickCurrentOrder(orders) {
  const known = orders.filter(Boolean);

  if (!known.length) return null;

  return known.find((o) => text(o.fields?.["Fulfillment Status"]) !== "Cancelled") || known[known.length - 1];
}

/*
 * A brokered pair, read as if it were an order.
 *
 * A broker deal lives in Supabase (external_sale_pairs), not in Airtable, so
 * there is no record to read the usual columns from. This gives it those
 * columns, and everything after - the row, the label download - treats it
 * like any other deal.
 *
 * The pair's own step stays "Ready to Ship" for good, even once delivered:
 * the admin page reads it as "his label went out". What moves is the
 * shipping column, so a shipped pair is shown as Fulfilled, as an order is.
 */
export const dealNumberOf = (dealNumber) =>
  dealNumber === null || dealNumber === undefined || dealNumber === "" || !Number.isFinite(Number(dealNumber))
    ? ""
    : `EXTD-${String(dealNumber).padStart(6, "0")}`;

export function brokerPairAsDeal(pair) {
  const sale = pair.external_sales || {};
  const cancelled = Boolean(pair.cancelled_at || sale.cancelled_at);
  const shipping = text(pair.consignor_shipping_status);
  // The column is named for a URL but holds the bare tracking number.
  const tracking = text(pair.consignor_tracking_url);
  const isUrl = /^https?:\/\//i.test(tracking);

  return {
    id: pair.id,
    fields: {
      "External Deal ID": dealNumberOf(sale.deal_number),
      "Fulfillment Status": cancelled
        ? "Cancelled"
        : ["Shipped", "Delivered"].includes(shipping)
          ? "Fulfilled"
          : text(pair.consignor_fulfillment_status),
      "Shipping Status": shipping,
      "Tracking Number": isUrl ? "" : tracking,
      "Tracking URL": isUrl ? tracking : "",
      "Shipping Label URL (Permanent)": text(pair.consignor_label_url)
    }
  };
}

// A unit can sit on a cancelled deal and then on a new one; the live one wins.
function pickCurrentPair(pairs) {
  const known = (pairs || []).filter(Boolean);

  return known.find((p) => !p.cancelled_at && !p.external_sales?.cancelled_at) || known[known.length - 1] || null;
}

/*
 * A unit becomes zero or one feed row.
 *
 * Pure: the unit and the records it links to go in, rows come out. Everything
 * about what a sale IS lives here, so it can be tested without Airtable.
 */
export function deriveSaleRows({ unit, ordersById, wtbsById, brokerPairsByUnit = new Map() }) {
  const f = unit.fields || {};
  const rows = [];

  const wtb = ids(f["Member WTBs"]).map((id) => wtbsById.get(id)).find(Boolean) || null;
  const order = pickCurrentOrder(ids(f["Unfulfilled Orders Log"]).map((id) => ordersById.get(id)));

  const pair = wtb || order ? null : pickCurrentPair(brokerPairsByUnit.get(unit.id));

  // A unit that fills a Member WTB is that deal, even on the rare unit that
  // also carries an order link.
  const source = wtb
    ? { type: "member_wtb", record: wtb }
    : order
      ? { type: "order", record: order }
      : pair
        ? { type: "external_sale", record: brokerPairAsDeal(pair) }
        : null;

  if (!source) return rows;

  const sf = source.record.fields || {};
  const isWtb = source.type === "member_wtb";
  const isDeal = source.type === "external_sale";

  const shared = {
    unit_record_id: unit.id,
    sku: text(f["SKU"]) || null,
    size: text(f["Size"]) || null,
    product_name: text(first(f["Product Name"])) || text(sf["Product Name"]) || null,
    // Store Fulfilled means the shop sent the order from its own stock: for
    // the seller that is the same as a cancelled sale.
    status: ["Cancelled", "Store Fulfilled"].includes(text(sf["Fulfillment Status"])) ? "cancelled" : "active",
    source_type: source.type,
    source_record_id: source.record.id,
    // Our own number, the one the seller sees in their dashboard. Never the
    // shop's Shopify number: that means nothing to the seller.
    reference: isWtb
      ? text(first(sf["Member WTB ID"])) || null
      : isDeal
        ? text(sf["External Deal ID"]) || null
        : text(first(sf["Order ID"])) || null,
    external_deal_id: (isDeal && text(sf["External Deal ID"])) || text(first(f["External Deal ID"])) || null,
    fulfillment_status: text(sf["Fulfillment Status"]) || null,
    shipping_status: text(sf["Shipping Status"]) || null,
    tracking_number: text(sf["Tracking Number"]) || null,
    tracking_url: text(sf["Tracking URL"]) || null,
    has_label:
      hasAttachment(sf["Shipping Label"]) ||
      Boolean(text(sf[isWtb ? "Shipping Label Permanent URL" : "Shipping Label URL (Permanent)"])),
    sale_date: text(f["Created Time"]) || null
  };

  const sellerRecordId = text(first(f["Seller Record ID"]));

  if (sellerRecordId) {
    rows.push({
      ...shared,
      role: "sold",
      party_record_id: sellerRecordId,
      // What the seller is paid, after any shipping deduction.
      amount: money(f["Final Purchase Price"]),
      payment_status: text(f["Payment Status"]) || null
    });
  }

  return rows;
}

const FINGERPRINTED = [
  "party_record_id",
  "sku",
  "size",
  "product_name",
  "amount",
  "status",
  "source_type",
  "source_record_id",
  "reference",
  "external_deal_id",
  "fulfillment_status",
  "shipping_status",
  "payment_status",
  "tracking_number",
  "tracking_url",
  "has_label",
  "sale_date"
];

/*
 * A row whose only change is one of our deal numbers is not news. The
 * numbers do not move on a live deal; this happens when the feed itself
 * starts showing a number differently - as when reference switched from the
 * shop's Shopify number to our Order ID - and that must not send every
 * receiver a sale.updated for every sale at once. The row is still
 * rewritten, and its updated_at moves, so a poller picks the number up.
 */
const NUMBER_FIELDS = ["reference", "external_deal_id"];

// Compared through the fingerprint, not field by field: Supabase hands back
// dates and amounts spelled differently from what Airtable gave.
export function onlyNumbersChanged(previous, next) {
  if (!previous?.fingerprint) return false;

  const withOldNumbers = { ...next };
  NUMBER_FIELDS.forEach((key) => { withOldNumbers[key] = previous[key] ?? null; });

  return fingerprintSale(withOldNumbers) === previous.fingerprint;
}

export function fingerprintSale(row) {
  const picked = Object.fromEntries(FINGERPRINTED.map((key) => [key, row[key] ?? null]));

  // Left out while empty, so the rows written before this field existed keep
  // their fingerprint.
  if (picked.external_deal_id === null) delete picked.external_deal_id;

  return crypto.createHash("sha256").update(JSON.stringify(picked)).digest("hex");
}

/*
 * Read Airtable, write only what changed.
 *
 * windowDays limits the pass to units created recently. A unit older than
 * that has long been delivered or cancelled, and re-reading thousands of
 * finished sales every few minutes is exactly the allowance this whole
 * design exists to save. windowDays = null reads everything, which the
 * first run does to fill the table.
 */
/*
 * emitEvents: return what changed as events for the webhooks. Off for the
 * first fill - that run finds every sale ever made, and none of them is news.
 */
export async function syncSales({ reader, store, windowDays = 60, emitEvents = false, now = () => new Date(), logger = console }) {
  const startedAt = now();
  const createdAfter = windowDays === null
    ? null
    : new Date(startedAt.getTime() - windowDays * 86_400_000).toISOString();

  const units = [...(await reader.listUnits({ createdAfter }))];

  // Broker pairs are read whole, not windowed: there are a few dozen, and a
  // deal can be months younger than its unit.
  const brokerPairs = reader.listBrokerPairs ? await reader.listBrokerPairs() : [];
  const brokerPairsByUnit = new Map();

  for (const pair of brokerPairs) {
    const unitId = text(pair.inventory_unit_record_id);

    if (!unitId) continue;
    if (!brokerPairsByUnit.has(unitId)) brokerPairsByUnit.set(unitId, []);
    brokerPairsByUnit.get(unitId).push(pair);
  }

  const read = new Set(units.map((u) => u.id));
  const missing = [...brokerPairsByUnit.keys()].filter((id) => !read.has(id));

  if (missing.length) units.push(...(await reader.listUnitsByIds(missing)));

  const orderIds = new Set();
  const wtbIds = new Set();

  for (const unit of units) {
    ids(unit.fields?.["Unfulfilled Orders Log"]).forEach((id) => orderIds.add(id));
    ids(unit.fields?.["Member WTBs"]).forEach((id) => wtbIds.add(id));
  }

  const [orders, wtbs] = await Promise.all([
    reader.listOrders([...orderIds]),
    reader.listWantToBuys([...wtbIds])
  ]);

  const ordersById = new Map(orders.map((r) => [r.id, r]));
  const wtbsById = new Map(wtbs.map((r) => [r.id, r]));

  const derived = units.flatMap((unit) => deriveSaleRows({ unit, ordersById, wtbsById, brokerPairsByUnit }));
  const existing = await store.findByUnitIds([...new Set(derived.map((r) => r.unit_record_id))]);

  // Copied, not referenced: the events below compare against what a row WAS,
  // and they are worked out after the writes. A store that hands back live
  // objects would otherwise show "before" as "after", and a label arriving
  // would go out as a plain update.
  const existingByKey = new Map(existing.map((r) => [`${r.unit_record_id}|${r.role}`, { ...r }]));

  const stamp = startedAt.toISOString();
  const inserts = [];
  const updates = [];

  for (const row of derived) {
    const fingerprint = fingerprintSale(row);
    const known = existingByKey.get(`${row.unit_record_id}|${row.role}`);

    if (!known) {
      inserts.push({ ...row, fingerprint, created_at: stamp, updated_at: stamp });
    } else if (known.fingerprint !== fingerprint) {
      updates.push({ id: known.id, ...row, fingerprint, updated_at: stamp });
    }
  }

  const inserted = inserts.length ? (await store.insertMany(inserts)) || [] : [];
  if (updates.length) await store.updateMany(updates);

  const result = { units: units.length, rows: derived.length, inserted: inserts.length, updated: updates.length };

  if (inserts.length || updates.length) {
    logger.log(`Seller API sales sync: ${JSON.stringify(result)}`);
  }

  if (!emitEvents) return result;

  const events = [];

  for (const row of inserted) {
    events.push({ previous: null, row });
  }

  for (const row of updates) {
    const previous = existingByKey.get(`${row.unit_record_id}|${row.role}`);

    if (!onlyNumbersChanged(previous, row)) events.push({ previous, row });
  }

  return {
    ...result,
    events: events.flatMap(({ previous, row }) => {
      const item = serializeSale(row);
      const changes = previous ? changedFields(serializeSale(previous), item) : [];

      return deriveEventTypes(previous, row).map((type) => ({ type, partyRecordId: row.party_record_id, item, changes }));
    })
  };
}

/*
 * What a change to one feed row means to a receiver.
 *
 * The moments a seller acts on get their own event, sent instead of
 * sale.updated: a label to print, the parcel moving, the payout. A cancelled
 * sale is only ever "cancelled" - whatever else changed with it, the one
 * thing that matters is not to ship it.
 */
const isShippedOrLater = (status) => ["Shipped", "Delivered"].includes(status);

export function deriveEventTypes(previous, next) {
  if (!previous) return ["sale.created"];

  if (previous.status !== "cancelled" && next.status === "cancelled") return ["sale.cancelled"];

  const types = [];

  if (!previous.has_label && next.has_label) types.push("label.ready");
  if (!isShippedOrLater(previous.shipping_status) && next.shipping_status === "Shipped") types.push("sale.shipped");
  if (previous.shipping_status !== "Delivered" && next.shipping_status === "Delivered") types.push("sale.delivered");
  if (previous.payment_status !== "Paid" && next.payment_status === "Paid") types.push("sale.paid_out");

  return types.length ? types : ["sale.updated"];
}

/* ---------------- Airtable ---------------- */

const formulaText = (value) => text(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");

/*
 * Linked records are fetched with a RECORD_ID() formula on their own table,
 * never with find(): find() resolves an id from anywhere in the base.
 */
/*
 * Broker pairs are the ones with a consignor step of their own. Every
 * External Sale has pairs, and one off our own shelf must not turn into
 * somebody's sale - the consignor dashboard draws the same line.
 */
const BROKER_PAIR_COLUMNS =
  "id, inventory_unit_record_id, consignor_fulfillment_status, consignor_shipping_status, consignor_label_url, consignor_tracking_url, cancelled_at, created_at, external_sales(deal_number, cancelled_at)";

async function readBrokerPairs(supabase, narrow = (query) => query) {
  const { data, error } = await narrow(
    supabase.from("external_sale_pairs").select(BROKER_PAIR_COLUMNS).not("consignor_fulfillment_status", "is", null)
  ).order("created_at", { ascending: true });

  if (error) throw error;

  return data || [];
}

export function createAirtableSalesReader({ airtable, unitsTable, ordersTable, wtbsTable, supabase = null, batchSize = 40 }) {
  async function byIds(table, recordIds, fields) {
    const out = [];

    for (let i = 0; i < recordIds.length; i += batchSize) {
      const chunk = recordIds.slice(i, i + batchSize);
      const formula = `OR(${chunk.map((id) => `RECORD_ID() = '${formulaText(id)}'`).join(",")})`;

      out.push(...(await airtable(table).select({ fields, filterByFormula: formula }).all()));
    }

    return out;
  }

  return {
    async listUnits({ createdAfter }) {
      const linked = "OR({Unfulfilled Orders Log} != '', {Member WTBs} != '')";
      const formula = createdAfter
        ? `AND(${linked}, IS_AFTER({Created Time}, '${formulaText(createdAfter)}'))`
        : linked;

      return airtable(unitsTable).select({ fields: UNIT_FIELDS, filterByFormula: formula }).all();
    },

    listOrders: (recordIds) => byIds(ordersTable, recordIds, ORDER_FIELDS),
    listWantToBuys: (recordIds) => byIds(wtbsTable, recordIds, WTB_FIELDS),
    listUnitsByIds: (recordIds) => byIds(unitsTable, recordIds, UNIT_FIELDS),
    listBrokerPairs: supabase ? () => readBrokerPairs(supabase) : null
  };
}

/*
 * The deal behind a sale, read fresh, for the label endpoints.
 *
 * Fresh because those two act: the feed can be minutes behind, and asking a
 * store twice for one label puts two requests in its channel.
 */
export function createAirtableLabelSource({ airtable, ordersTable, wtbsTable, supabase = null }) {
  return {
    async findSource({ sourceType, recordId }) {
      if (sourceType === "external_sale") {
        if (!supabase || !/^[0-9a-f-]{36}$/i.test(text(recordId))) return null;

        const [pair] = await readBrokerPairs(supabase, (query) => query.eq("id", recordId));

        return pair ? brokerPairAsDeal(pair) : null;
      }

      if (!/^rec[A-Za-z0-9]{14}$/.test(text(recordId))) return null;

      const isWtb = sourceType === "member_wtb";
      const records = await airtable(isWtb ? wtbsTable : ordersTable)
        .select({
          fields: isWtb ? WTB_FIELDS : ORDER_FIELDS,
          filterByFormula: `RECORD_ID() = '${formulaText(recordId)}'`,
          maxRecords: 1
        })
        .firstPage();

      return records[0] || null;
    }
  };
}

const MAX_LABEL_BYTES = 10 * 1024 * 1024;

/*
 * One quiet retry. The first live check failed once on a label that
 * downloaded fine on eight tries straight after - a blip at Airtable's file
 * host, not a missing label - and a partner should not have to build their
 * own retry around something we can absorb in a second.
 */
export async function fetchLabelFile(url, options = {}) {
  const first = await fetchLabelFileOnce(url, options);

  return first.ok ? first : fetchLabelFileOnce(url, options);
}

async function fetchLabelFileOnce(url, { fetchImpl = fetch, timeoutMs = 20_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchImpl(url, { signal: controller.signal });

    if (!res.ok) return { ok: false, status: res.status };

    const buffer = Buffer.from(await res.arrayBuffer());

    if (!buffer.length || buffer.length > MAX_LABEL_BYTES) return { ok: false, status: 502 };

    return { ok: true, buffer };
  } catch {
    return { ok: false, status: 502 };
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------- Supabase ---------------- */

export const SALE_COLUMNS =
  "id, unit_record_id, role, party_record_id, sku, size, product_name, amount, status, source_type, source_record_id, reference, external_deal_id, fulfillment_status, shipping_status, payment_status, tracking_number, tracking_url, has_label, sale_date, fingerprint, created_at, updated_at";

function unwrap({ data, error }) {
  if (error) throw error;

  return data;
}

export function createSupabaseSalesStore(supabase, { chunk = 200 } = {}) {
  return {
    async isEmpty() {
      const { count, error } = await supabase.from("api_sales").select("id", { count: "exact", head: true });

      if (error) throw error;

      return !count;
    },

    async findByUnitIds(unitIds) {
      const out = [];

      for (let i = 0; i < unitIds.length; i += chunk) {
        out.push(
          ...(unwrap(
            await supabase
              .from("api_sales")
              .select(SALE_COLUMNS)
              .in("unit_record_id", unitIds.slice(i, i + chunk))
              .eq("role", "sold")
          ) || [])
        );
      }

      return out;
    },

    // Returns what was written, ids included: an event needs the id the
    // receiver will later see in the feed.
    async insertMany(rows) {
      const written = [];

      for (let i = 0; i < rows.length; i += chunk) {
        written.push(...(unwrap(await supabase.from("api_sales").insert(rows.slice(i, i + chunk)).select(SALE_COLUMNS)) || []));
      }

      return written;
    },

    async updateMany(rows) {
      for (const { id, ...row } of rows) {
        unwrap(await supabase.from("api_sales").update(row).eq("id", id));
      }
    },

    async listForParty({ partyRecordId, updatedSince, status, from, to }) {
      let query = supabase
        .from("api_sales")
        .select(SALE_COLUMNS, { count: "exact" })
        .eq("party_record_id", partyRecordId)
        .eq("role", "sold");

      if (updatedSince) query = query.gte("updated_at", updatedSince);
      if (status) query = query.eq("status", status);

      const { data, error, count } = await query
        .order("updated_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to);

      if (error) throw error;

      return { rows: data || [], total: count || 0 };
    },

    async findForParty({ partyRecordId, id }) {
      return unwrap(
        await supabase
          .from("api_sales")
          .select(SALE_COLUMNS)
          .eq("id", id)
          .eq("party_record_id", partyRecordId)
          .eq("role", "sold")
          .maybeSingle()
      );
    }
  };
}

/* ---------------- API shape ---------------- */

// Supabase answers "+00:00", Airtable "Z". One spelling out, so a poller can
// compare timestamps as strings without surprises.
const iso = (value) => {
  const parsed = Date.parse(value);

  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
};

export function serializeSale(row) {
  return {
    id: row.id,
    status: row.status,
    sku: row.sku,
    size: row.size,
    product_name: row.product_name,
    amount: row.amount === null || row.amount === undefined ? null : Number(row.amount),
    currency: "EUR",
    source: row.source_type,
    reference: row.reference,
    order_id: row.source_type === "order" ? row.reference ?? null : null,
    member_wtb_id: row.source_type === "member_wtb" ? row.reference ?? null : null,
    external_deal_id: row.external_deal_id ?? null,
    fulfillment_status: row.fulfillment_status,
    shipping_status: row.shipping_status,
    payment_status: row.payment_status,
    tracking_number: row.tracking_number,
    tracking_url: row.tracking_url,
    label_available: Boolean(row.has_label),
    sale_date: iso(row.sale_date),
    updated_at: iso(row.updated_at)
  };
}

/*
 * What a test key sees instead of real sales.
 *
 * A test key has no sales and never will, and an integration cannot be built
 * against an empty list. Two fixed rows - a store order with a label and
 * tracking, a want-to-buy still waiting for its label - in exactly the live shape, so a parser written against these
 * works unchanged on a live key.
 */
export function sampleSales(partyRecordId) {
  const base = {
    party_record_id: partyRecordId,
    status: "active",
    fingerprint: "sample",
    created_at: "2026-09-01T10:00:00.000Z"
  };

  return [
    {
      ...base,
      id: "00000000-0000-4000-8000-000000000001",
      role: "sold",
      sku: "DZ5485-612",
      size: "42",
      product_name: "Jordan 1 Retro High OG Chicago Lost and Found",
      amount: 180,
      source_type: "order",
      reference: "ORD-007454",
      external_deal_id: null,
      fulfillment_status: "Requested Label",
      shipping_status: null,
      payment_status: "To Pay",
      tracking_number: "05162999841548",
      tracking_url: "https://tracking.dpd.de/status/en_NL/parcel/05162999841548",
      has_label: true,
      sale_date: "2026-09-01T10:00:00.000Z",
      updated_at: "2026-09-01T10:05:00.000Z"
    },
    {
      ...base,
      id: "00000000-0000-4000-8000-000000000002",
      role: "sold",
      sku: "M2002RDB",
      size: "46.5",
      product_name: "New Balance 2002R Protection Pack Phantom",
      amount: 118,
      source_type: "member_wtb",
      reference: "MWTB-000422",
      external_deal_id: null,
      fulfillment_status: "Allocated",
      shipping_status: null,
      payment_status: "To Pay",
      tracking_number: null,
      tracking_url: null,
      has_label: false,
      sale_date: "2026-09-02T09:58:57.000Z",
      updated_at: "2026-09-02T10:00:00.000Z"
    }
  ];
}
