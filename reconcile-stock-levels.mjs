/*
 * Stock levels, put back in step with the stock.
 *
 * Three layers hold the same number. consignment_inventory is the stock
 * itself, one row per consignor per size. consignment_stock_levels adds it
 * up per pair. Airtable's Stock Levels mirrors that, and autoAllocateBestUnit
 * matches on it, so a pair that is wrong there is a pair nobody gets offered.
 *
 * They are kept in step by refreshConsignmentStockLevel, which only runs when
 * stock CHANGES. Anything that slipped past - a failed call, an edit made
 * straight in a table, a rename - stays wrong for good, because nothing ever
 * looks at the whole picture again.
 *
 * This is that look. Measured on 11-09-2026, before it first ran:
 *
 *   44 pairs had no row in consignment_stock_levels
 *   34 had the wrong number
 *   73 rows claimed stock of a pair we no longer hold
 *   14 pairs had no row in Airtable, 25 had the wrong number
 *    9 pairs sat in Airtable twice, one of the two always empty
 *
 * The last one is why it deletes rather than only corrects: two rows for one
 * pair means a lookup finds whichever comes first, and half the time that is
 * the empty one.
 *
 * Dry unless --apply is given.
 *
 * Run with: node reconcile-stock-levels.mjs [--apply]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

for (const line of fs.readFileSync(path.join(here, ".env"), "utf8").split("\n")) {
  const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim();
}

const APPLY = process.argv.includes("--apply");

const AIRTABLE_BASE = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_HEAD = {
  Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}`,
  "Content-Type": "application/json"
};

const SUPA = {
  apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
  "Content-Type": "application/json"
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The same key the rest of the system uses, so a row made here is found by
// everything that looks for it.
const stockKey = (sku, size) => `${String(sku).toUpperCase().trim()}-${String(size).trim()}`;

/* ------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------ */

async function supabaseAll(table, select, extra = "") {
  const rows = [];

  for (let from = 0; ; from += 1000) {
    const page = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/${table}?select=${select}${extra}`,
      { headers: { ...SUPA, Range: `${from}-${from + 999}` } }
    ).then((r) => r.json());

    if (!Array.isArray(page) || !page.length) break;

    rows.push(...page);

    if (page.length < 1000) break;
  }

  return rows;
}

async function airtableAll(table, fields) {
  const rows = [];

  let offset = null;

  do {
    const url = new URL(`https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(table)}`);

    url.searchParams.set("pageSize", "100");
    fields.forEach((f) => url.searchParams.append("fields[]", f));

    if (offset) url.searchParams.set("offset", offset);

    const res = await fetch(url, { headers: AIRTABLE_HEAD }).then((r) => r.json());

    if (res.error) throw new Error(JSON.stringify(res.error));

    rows.push(...(res.records || []));
    offset = res.offset;
  } while (offset);

  return rows;
}

/* ------------------------------------------------------------------ *
 * Writing
 * ------------------------------------------------------------------ */

async function airtableWrite(method, table, body, query = "") {
  if (!APPLY) return;

  const res = await fetch(
    `https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(table)}${query}`,
    { method, headers: AIRTABLE_HEAD, body: body ? JSON.stringify(body) : undefined }
  );

  const json = await res.json();

  if (!res.ok) throw new Error(`${method} ${table}: ${JSON.stringify(json).slice(0, 250)}`);

  await sleep(220);

  return json;
}

async function inBatches(items, size, work) {
  for (let i = 0; i < items.length; i += size) {
    await work(items.slice(i, i + size));
  }
}

/* ------------------------------------------------------------------ *
 * The truth
 * ------------------------------------------------------------------ */

const stock = await supabaseAll(
  "consignment_inventory",
  "sku,size,quantity,product_name,brand",
  "&quantity=gt.0"
);

const truth = new Map();

for (const row of stock) {
  const key = stockKey(row.sku, row.size);
  const seen = truth.get(key) || {
    sku: String(row.sku).toUpperCase().trim(),
    size: String(row.size).trim(),
    quantity: 0,
    productName: "",
    brand: ""
  };

  seen.quantity += Number(row.quantity || 0);
  seen.productName ||= row.product_name || "";
  seen.brand ||= row.brand || "";

  truth.set(key, seen);
}

console.log(APPLY ? "ECHT UITVOEREN\n" : "DROOG, er wordt niets geschreven\n");
console.log(`consignmentparen met voorraad : ${truth.size}`);

/* ------------------------------------------------------------------ *
 * Layer two: consignment_stock_levels
 * ------------------------------------------------------------------ */

const levels = await supabaseAll(
  "consignment_stock_levels",
  "stock_counter_key,sku,size,stock_level,product_name,brand"
);

const levelByKey = new Map(levels.map((r) => [r.stock_counter_key, r]));

const levelWrites = [];

for (const [key, want] of truth) {
  const have = levelByKey.get(key);

  if (have && Number(have.stock_level || 0) === want.quantity) continue;

  levelWrites.push({
    stock_counter_key: key,
    sku: want.sku,
    size: want.size,
    stock_level: want.quantity,
    product_name: have?.product_name || want.productName,
    brand: have?.brand || want.brand,
    updated_at: new Date().toISOString()
  });
}

// Rows claiming stock of a pair we no longer hold. Kept, set to nothing, so
// whatever points at them still resolves.
const ghosts = levels.filter((r) => !truth.has(r.stock_counter_key) && Number(r.stock_level || 0) > 0);

console.log(`\nconsignment_stock_levels`);
console.log(`  aan te maken of te corrigeren : ${levelWrites.length}`);
console.log(`  op nul te zetten (voorraad weg) : ${ghosts.length}`);

if (APPLY && levelWrites.length) {
  await inBatches(levelWrites, 500, async (batch) => {
    const res = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/consignment_stock_levels?on_conflict=stock_counter_key`,
      {
        method: "POST",
        headers: { ...SUPA, Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify(batch)
      }
    );

    if (!res.ok) throw new Error(`stock_levels upsert: ${(await res.text()).slice(0, 250)}`);
  });
}

if (APPLY && ghosts.length) {
  await inBatches(ghosts, 500, async (batch) => {
    const res = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/consignment_stock_levels?on_conflict=stock_counter_key`,
      {
        method: "POST",
        headers: { ...SUPA, Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify(
          batch.map((r) => ({
            stock_counter_key: r.stock_counter_key,
            sku: r.sku,
            size: r.size,
            stock_level: 0,
            updated_at: new Date().toISOString()
          }))
        )
      }
    );

    if (!res.ok) throw new Error(`stock_levels zero: ${(await res.text()).slice(0, 250)}`);
  });
}

/* ------------------------------------------------------------------ *
 * Layer three: Airtable Stock Levels
 * ------------------------------------------------------------------ */

const airtableRows = await airtableAll("Stock Levels", [
  "SKU",
  "Size",
  "Partner Stock Level",
  "SKU Master",
  "Inventory Units Link",
  "Store Listings"
]);

const byKey = new Map();

for (const row of airtableRows) {
  const key = stockKey(row.fields["SKU"], row.fields["Size"]);

  if (!byKey.has(key)) byKey.set(key, []);

  byKey.get(key).push(row);
}

/*
  Two rows for one pair: keep the one that carries something and drop the
  empty one. A row linked to inventory units or store listings is never
  dropped, whatever its number - those links belong to our own stock.
*/
const duplicatesToDrop = [];

for (const [, rows] of byKey) {
  if (rows.length < 2) continue;

  const keepable = rows.filter(
    (r) =>
      Number(r.fields["Partner Stock Level"] || 0) > 0 ||
      (r.fields["Inventory Units Link"] || []).length ||
      (r.fields["Store Listings"] || []).length
  );

  // Keep the richest one, or simply the first when they are all empty.
  const keep = keepable[0] || rows[0];

  rows.filter((r) => r !== keep && !keepable.includes(r)).forEach((r) => duplicatesToDrop.push(r));
}

const skuMaster = await airtableAll("SKU Master", ["SKU"]);
const masterByS = new Map(
  skuMaster.map((r) => [String(r.fields["SKU"] || "").toUpperCase().trim(), r.id])
);

const toCreate = [];
const toUpdate = [];

for (const [key, want] of truth) {
  const rows = (byKey.get(key) || []).filter((r) => !duplicatesToDrop.includes(r));
  const row = rows[0];

  if (!row) {
    const fields = { SKU: want.sku, Size: want.size, "Partner Stock Level": want.quantity };
    const master = masterByS.get(want.sku);

    if (master) fields["SKU Master"] = [master];

    toCreate.push({ fields });
    continue;
  }

  const fields = {};

  if (Number(row.fields["Partner Stock Level"] || 0) !== want.quantity) {
    fields["Partner Stock Level"] = want.quantity;
  }

  if (!(row.fields["SKU Master"] || []).length && masterByS.get(want.sku)) {
    fields["SKU Master"] = [masterByS.get(want.sku)];
  }

  if (Object.keys(fields).length) toUpdate.push({ id: row.id, fields });
}

// Airtable rows claiming partner stock of a pair we no longer hold.
const airtableGhosts = airtableRows
  .filter((r) => !duplicatesToDrop.includes(r))
  .filter((r) => !truth.has(stockKey(r.fields["SKU"], r.fields["Size"])))
  .filter((r) => Number(r.fields["Partner Stock Level"] || 0) > 0)
  .map((r) => ({ id: r.id, fields: { "Partner Stock Level": 0 } }));

console.log(`\nAirtable Stock Levels`);
console.log(`  rijen                          : ${airtableRows.length}`);
console.log(`  lege dubbelen te verwijderen   : ${duplicatesToDrop.length}`);
console.log(`  aan te maken                   : ${toCreate.length}`);
console.log(`  bij te werken                  : ${toUpdate.length}`);
console.log(`  op nul te zetten (voorraad weg): ${airtableGhosts.length}`);

if (!APPLY) {
  console.log("\nDraai opnieuw met --apply om het echt te doen.");
  process.exit(0);
}

await inBatches(duplicatesToDrop, 10, (batch) =>
  airtableWrite("DELETE", "Stock Levels", null, "?" + batch.map((r) => `records[]=${r.id}`).join("&"))
);

await inBatches(toCreate, 10, (batch) =>
  airtableWrite("POST", "Stock Levels", { records: batch })
);

await inBatches([...toUpdate, ...airtableGhosts], 10, (batch) =>
  airtableWrite("PATCH", "Stock Levels", { records: batch })
);

console.log("\nklaar");
console.log(`  verwijderd   : ${duplicatesToDrop.length}`);
console.log(`  aangemaakt   : ${toCreate.length}`);
console.log(`  bijgewerkt   : ${toUpdate.length + airtableGhosts.length}`);
