// lib/sellerApiWantToBuys.js
//
// Want-to-buys, as the buyer follows them.
//
// A Member WTB is what a buyer buys from us, with our margin in its invoice.
// It is not the Inventory Unit: that is what we buy from the seller who fills
// it, and it belongs to that seller's sales feed. So the whole purchase - from
// placing it, through payment, to the tracking on the parcel - is followed on
// the want-to-buy itself.
//
// For live keys these rows mirror Airtable, refreshed by syncWantToBuys, so the
// API can answer "what changed since" without reading Airtable on every call
// and spending the shared allowance on somebody's polling loop. Test keys
// write straight to their own table of the same shape.

import crypto from "crypto";

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());
const first = (value) => (Array.isArray(value) ? value[0] : value);

const money = (value) => {
  const raw = first(value);

  // Number(null) and Number("") are 0, and a blank ceiling is no ceiling.
  if (raw === null || raw === undefined || text(raw) === "") return null;

  const n = Number(raw);

  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
};

export const WTB_FIELDS = [
  "Member WTB ID",
  "SKU",
  "Size",
  "Product Name",
  "Brand",
  "Max Price",
  "Buying Inventory Filter",
  "Purchase Status",
  "Fulfillment Status",
  "Payment Status",
  "Invoice Price",
  "Shipping Status",
  "Tracking Number",
  "Tracking URL",
  "Buyer Seller ID",
  "Date"
];

const INVENTORY_TYPE_BY_LABEL = { "B2B Only": "b2b", "Margin Only": "private", "All Inventory": "all" };

// The dashboard's meaning of open: still waiting for a seller.
const OPEN_FULFILMENT = ["Pending", "Outsource"];

export function isOpenWantToBuy(row) {
  return OPEN_FULFILMENT.includes(row.fulfillment_status);
}

export function isCancelledWantToBuy(row) {
  return row.fulfillment_status === "Cancelled" || row.purchase_status === "Cancelled";
}

/*
 * One Airtable Member WTB as a row. Pure, so what a purchase looks like to a
 * buyer can be tested without Airtable.
 */
export function wantToBuyRowFromRecord(record) {
  const f = record.fields || {};

  return {
    wtb_record_id: record.id,
    party_record_id: text(first(f["Buyer Seller ID"])) || null,
    wtb_id: text(first(f["Member WTB ID"])) || null,
    sku: text(first(f["SKU"])) || null,
    size: text(first(f["Size"])) || null,
    product_name: text(first(f["Product Name"])) || null,
    brand: text(first(f["Brand"])) || null,
    max_price: money(f["Max Price"]),
    inventory_type: INVENTORY_TYPE_BY_LABEL[text(f["Buying Inventory Filter"])] || "all",
    purchase_status: text(f["Purchase Status"]) || null,
    fulfillment_status: text(f["Fulfillment Status"]) || null,
    payment_status: text(f["Payment Status"]) || null,
    invoice_amount: money(f["Invoice Price"]),
    shipping_status: text(f["Shipping Status"]) || null,
    tracking_number: text(f["Tracking Number"]) || null,
    tracking_url: text(f["Tracking URL"]) || null,
    placed_at: text(f["Date"]) || record._rawJson?.createdTime || null
  };
}

const FINGERPRINTED = [
  "party_record_id",
  "wtb_id",
  "sku",
  "size",
  "product_name",
  "brand",
  "max_price",
  "inventory_type",
  "purchase_status",
  "fulfillment_status",
  "payment_status",
  "invoice_amount",
  "shipping_status",
  "tracking_number",
  "tracking_url",
  "placed_at"
];

export function fingerprintWantToBuy(row) {
  const picked = Object.fromEntries(FINGERPRINTED.map((key) => [key, row[key] ?? null]));

  return crypto.createHash("sha256").update(JSON.stringify(picked)).digest("hex");
}

/*
 * What a change means to the buyer. Placing one is not an event: whoever
 * placed it already knows, and a want-to-buy placed in the dashboard is
 * picked up by the feed like everything else.
 */
export function deriveWantToBuyEventTypes(previous, next) {
  if (!previous) return [];

  if (!isCancelledWantToBuy(previous) && isCancelledWantToBuy(next)) return ["want_to_buy.cancelled"];

  return ["want_to_buy.updated"];
}

export function serializeWantToBuy(row) {
  const iso = (value) => {
    const parsed = Date.parse(value);

    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  };

  const amount = (value) => (value === null || value === undefined ? null : Number(value));

  return {
    id: row.id,
    wtb_id: row.wtb_id || null,
    sku: row.sku || null,
    size: row.size || null,
    product_name: row.product_name || null,
    brand: row.brand || null,
    max_price: amount(row.max_price),
    inventory_type: row.inventory_type || "all",
    is_open: isOpenWantToBuy(row),
    purchase_status: row.purchase_status || null,
    fulfillment_status: row.fulfillment_status || null,
    payment_status: row.payment_status || null,
    // What the buyer is invoiced once a seller has filled it; null before.
    invoice_amount: amount(row.invoice_amount),
    currency: "EUR",
    shipping_status: row.shipping_status || null,
    tracking_number: row.tracking_number || null,
    tracking_url: row.tracking_url || null,
    placed_at: iso(row.placed_at),
    updated_at: iso(row.updated_at)
  };
}

/* ---------------- the sync ---------------- */

/*
 * Read recent want-to-buys, write only what changed.
 *
 * Same shape as the sales sync: a window instead of the whole table, and
 * emitEvents off for the first fill, because none of what that finds is news.
 *
 * The window is on the last edit, not on the creation date. A want-to-buy
 * without a ceiling can sit open for months, and its tracking number arrives
 * whenever a seller finally fills it.
 */
export async function syncWantToBuys({ reader, store, windowDays = 60, emitEvents = false, now = () => new Date(), logger = console }) {
  const startedAt = now();
  const modifiedAfter = windowDays === null
    ? null
    : new Date(startedAt.getTime() - windowDays * 86_400_000).toISOString();

  const records = await reader.listRecent({ modifiedAfter });
  const derived = records.map(wantToBuyRowFromRecord).filter((row) => row.party_record_id);

  const existing = await store.findByWtbRecordIds(derived.map((row) => row.wtb_record_id));

  // Copied: events compare against what a row WAS, worked out after writing.
  const known = new Map(
    existing.map((row) => [
      row.wtb_record_id,
      { id: row.id, fingerprint: row.fingerprint, fulfillment_status: row.fulfillment_status, purchase_status: row.purchase_status }
    ])
  );

  const stamp = startedAt.toISOString();
  const inserts = [];
  const updates = [];

  for (const row of derived) {
    const fingerprint = fingerprintWantToBuy(row);
    const previous = known.get(row.wtb_record_id);

    if (!previous) {
      inserts.push({ ...row, fingerprint, created_at: stamp, updated_at: stamp });
    } else if (previous.fingerprint !== fingerprint) {
      updates.push({ id: previous.id, ...row, fingerprint, updated_at: stamp });
    }
  }

  if (inserts.length) await store.insertMany(inserts);
  if (updates.length) await store.updateMany(updates);

  const result = { records: records.length, inserted: inserts.length, updated: updates.length };

  if (inserts.length || updates.length) {
    logger.log(`Seller API want-to-buy sync: ${JSON.stringify(result)}`);
  }

  if (!emitEvents) return result;

  return {
    ...result,
    events: updates.flatMap((row) =>
      deriveWantToBuyEventTypes(known.get(row.wtb_record_id), row).map((type) => ({
        type,
        partyRecordId: row.party_record_id,
        item: serializeWantToBuy(row)
      }))
    )
  };
}

/* ---------------- Airtable ---------------- */

const formulaText = (value) => text(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
const RECORD_ID = /^rec[A-Za-z0-9]{14}$/;

/*
 * Always select() on the table, never find(): find() resolves a record id
 * from anywhere in the base.
 */
export function createAirtableWantToBuyReader({ airtable, table }) {
  return {
    // LAST_MODIFIED_TIME() moves on any edit to the record's own fields, which
    // is where statuses, payment and tracking are written.
    async listRecent({ modifiedAfter }) {
      const hasBuyer = "{Buyer Seller ID} != ''";
      const formula = modifiedAfter
        ? `AND(${hasBuyer}, IS_AFTER(LAST_MODIFIED_TIME(), '${formulaText(modifiedAfter)}'))`
        : hasBuyer;

      return airtable(table).select({ fields: WTB_FIELDS, filterByFormula: formula }).all();
    },

    // Fresh, for the moment something is about to be acted on.
    async findRecord(recordId) {
      if (!RECORD_ID.test(text(recordId))) return null;

      const [record] = await airtable(table)
        .select({ fields: WTB_FIELDS, filterByFormula: `RECORD_ID() = '${formulaText(recordId)}'`, maxRecords: 1 })
        .firstPage();

      return record || null;
    },

    // What the dashboard's own Cancel button writes, and nothing more.
    async cancel(recordId) {
      return airtable(table).update(recordId, {
        "Purchase Status": "Cancelled",
        "Fulfillment Status": "Cancelled"
      });
    }
  };
}

/* ---------------- Supabase ---------------- */

const COLUMNS =
  "id, wtb_record_id, party_record_id, wtb_id, sku, size, product_name, brand, max_price, inventory_type, purchase_status, fulfillment_status, payment_status, invoice_amount, shipping_status, tracking_number, tracking_url, placed_at, fingerprint, created_at, updated_at";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function unwrap({ data, error }) {
  if (error) throw error;

  return data;
}

/*
 * One store for both modes: api_want_to_buys mirrors Airtable for live keys,
 * api_test_want_to_buys is the whole truth for test keys.
 */
export function createSupabaseWantToBuyStore(supabase, table, { chunk = 200 } = {}) {
  return {
    async isEmpty() {
      const { count, error } = await supabase.from(table).select("id", { count: "exact", head: true });

      if (error) throw error;

      return !count;
    },

    async findByWtbRecordIds(recordIds) {
      const out = [];

      for (let i = 0; i < recordIds.length; i += chunk) {
        out.push(
          ...(unwrap(
            await supabase
              .from(table)
              .select("id, wtb_record_id, fingerprint, fulfillment_status, purchase_status")
              .in("wtb_record_id", recordIds.slice(i, i + chunk))
          ) || [])
        );
      }

      return out;
    },

    async insertMany(rows) {
      const written = [];

      for (let i = 0; i < rows.length; i += chunk) {
        written.push(...(unwrap(await supabase.from(table).insert(rows.slice(i, i + chunk)).select(COLUMNS)) || []));
      }

      return written;
    },

    async updateMany(rows) {
      for (const { id, ...row } of rows) {
        unwrap(await supabase.from(table).update(row).eq("id", id));
      }
    },

    // For a want-to-buy the API itself just placed or cancelled: written at
    // once, so the caller's next read already shows it.
    async upsertFromRecord(row) {
      const fingerprint = fingerprintWantToBuy(row);
      const stamp = new Date().toISOString();

      const [existing] =
        unwrap(await supabase.from(table).select("id").eq("wtb_record_id", row.wtb_record_id).limit(1)) || [];

      if (existing) {
        return unwrap(
          await supabase.from(table).update({ ...row, fingerprint, updated_at: stamp }).eq("id", existing.id).select(COLUMNS).single()
        );
      }

      return unwrap(
        await supabase.from(table).insert({ ...row, fingerprint, created_at: stamp, updated_at: stamp }).select(COLUMNS).single()
      );
    },

    async insertTest(row) {
      return unwrap(await supabase.from(table).insert(row).select(COLUMNS).single());
    },

    async cancelTest(id) {
      return unwrap(
        await supabase
          .from(table)
          .update({ purchase_status: "Cancelled", fulfillment_status: "Cancelled", updated_at: new Date().toISOString() })
          .eq("id", id)
          .select(COLUMNS)
          .single()
      );
    },

    async listForParty({ partyRecordId, updatedSince, status, sku, from, to }) {
      let query = supabase.from(table).select(COLUMNS, { count: "exact" }).eq("party_record_id", partyRecordId);

      if (updatedSince) query = query.gte("updated_at", updatedSince);
      if (sku) query = query.eq("sku", sku);
      if (status === "open") query = query.in("fulfillment_status", OPEN_FULFILMENT);
      if (status === "closed") query = query.not("fulfillment_status", "in", `(${OPEN_FULFILMENT.join(",")})`);

      const { data, error, count } = await query
        .order("updated_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to);

      if (error) throw error;

      return { rows: data || [], total: count || 0 };
    },

    async findForParty({ partyRecordId, id }) {
      if (!UUID.test(text(id))) return null;

      return unwrap(
        await supabase.from(table).select(COLUMNS).eq("id", id).eq("party_record_id", partyRecordId).maybeSingle()
      );
    }
  };
}

/*
 * One finished purchase for test keys, next to the ones they place.
 *
 * A test want-to-buy never meets a seller, so without this nobody could see
 * an invoice amount or a tracking number before going live. Fixed, in the
 * live shape, and never cancellable.
 */
export function sampleWantToBuy() {
  return {
    id: "00000000-0000-4000-8000-0000000000b1",
    wtb_record_id: null,
    wtb_id: "MWTB-000422",
    sku: "M2002RDB",
    size: "46.5",
    product_name: "New Balance 2002R Protection Pack Phantom",
    brand: "New Balance",
    max_price: 150,
    inventory_type: "all",
    purchase_status: "Confirmed",
    fulfillment_status: "Shipped",
    payment_status: "Paid",
    invoice_amount: 143,
    shipping_status: "In Transit",
    tracking_number: "05162999841548",
    tracking_url: "https://tracking.dpd.de/status/en_NL/parcel/05162999841548",
    placed_at: "2026-09-02T09:58:57.000Z",
    fingerprint: "sample",
    created_at: "2026-09-02T09:58:57.000Z",
    updated_at: "2026-09-03T14:00:00.000Z"
  };
}
