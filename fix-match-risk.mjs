/**
 * fix-match-risk.mjs — puts store_listings back on "Low" where the SKU is
 * genuinely matched.
 *
 * WHY THIS EXISTS
 *
 * calculateMatchRisk in shopify-active-product-sync reads two things: the
 * SKU and a stockxMatched flag. One of its three callers never passed that
 * flag, so it was always undefined, and "if (!stockxMatched) return High"
 * did the rest. Every listing written through that path came out High no
 * matter how cleanly its SKU resolved.
 *
 * An order inherits Match Risk Level from its listing, and
 * autoAllocateBestUnit refuses to touch anything that is not "Low". So
 * those orders were never allocated, never moved to Outsource, and never
 * reached a seller. They simply sat on Pending.
 *
 * The caller is fixed. This repairs what it wrote in the meantime, because
 * the sync only runs when someone starts it by hand.
 *
 * THE RULE, AND WHY IT IS SAFE
 *
 * A SKU goes back to Low when SKU Master holds it with a real product name
 * and a StockX Style ID that matches the SKU exactly - the same slash-aware
 * comparison sku-resolver.mjs uses ("315115-112/DD8959-100" contains both).
 *
 * That is the same source the sync consults. It calls resolveSkuViaPortal,
 * which reads SKU Master and only reports success on an exact match. So
 * everything this marks Low, the sync would mark Low as well. The reverse
 * is not true: this is the stricter of the two, never the looser one. A SKU
 * that is not in SKU Master stays High, which is correct - nothing has
 * verified it.
 *
 * WHAT IT DOES NOT DO
 *
 *   - it never sets anything to High. This can only relax a verdict that
 *     was made by a bug, never tighten one a human might rely on.
 *   - it leaves updated_at alone. These rows were not re-synced, and
 *     stamping them would make it look like they were.
 *   - it only touches status = 'active'.
 *
 * USAGE
 *   node fix-match-risk.mjs --store "Tienne Milano"           # dry run
 *   node fix-match-risk.mjs --store "Tienne Milano" --apply
 *   node fix-match-risk.mjs --store "Tienne Milano" --apply --limit 500
 *
 * Without --store it walks every store, which now runs into Postgres'
 * statement timeout. See the note at STORE below.
 */

import "dotenv/config";
import Airtable from "airtable";

const APPLY = process.argv.includes("--apply");

const LIMIT = (() => {
  const i = process.argv.indexOf("--limit");
  const value = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return Number.isFinite(value) && value > 0 ? value : Infinity;
})();

/*
 * One store at a time.
 *
 * store_listings has no index on the columns this filters by, so the scan
 * across every active row now runs past Postgres' statement timeout - it
 * used to fit, and stopped fitting once all eleven stores were switched to
 * active. Narrowing to one merchant brings it back within budget, and it
 * happens to be what you usually want anyway: a single store was missed.
 *
 *   node fix-match-risk.mjs --store "ALC SELECT STORE SL"
 *
 * Without it every store is walked, which is the old behaviour and will
 * likely time out again.
 */
const STORE = (() => {
  const i = process.argv.indexOf("--store");
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : "";
})();

const storeFilter = STORE
  ? `&merchant_name=eq.${encodeURIComponent(STORE)}`
  : "";

for (const name of [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "AIRTABLE_TOKEN",
  "AIRTABLE_BASE_ID"
]) {
  if (!process.env[name]) {
    console.error(`Missing ${name}`);
    process.exit(1);
  }
}

const SKU_MASTER_TABLE = process.env.AIRTABLE_SKU_MASTER_TABLE || "SKU Master";

const airtable = new Airtable({ apiKey: process.env.AIRTABLE_TOKEN })
  .base(process.env.AIRTABLE_BASE_ID);

const SUPABASE_HEADERS = {
  apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`
};

const norm = (value) => String(value ?? "").trim().toUpperCase();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The table is large and its updated_at is not indexed, so anything that
 * scans it times out. Everything here therefore retries, and pages by id
 * rather than by offset - a deep offset makes Postgres walk the whole table
 * again for every page.
 */
async function supabase(path, options = {}, attempts = 6) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, {
        ...options,
        headers: { ...SUPABASE_HEADERS, ...(options.headers || {}) }
      });

      if (response.ok) return response;

      lastError = new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
    } catch (error) {
      lastError = error;
    }

    await sleep(2000 * attempt);
  }

  throw lastError;
}

/** Both halves of a slash-separated style id, with and without hyphens. */
function skuVariants(value) {
  const raw = norm(value);
  const out = new Set();

  for (const part of raw.includes("/") ? raw.split("/") : [raw]) {
    const clean = part.trim();
    if (!clean) continue;

    out.add(clean);
    out.add(clean.replaceAll("-", "").replaceAll(" ", ""));
  }

  return out;
}

async function loadSkuMaster() {
  const records = await airtable(SKU_MASTER_TABLE)
    .select({ fields: ["SKU", "Product Name", "StockX Style ID"] })
    .all();

  const master = new Map();

  for (const record of records) {
    const sku = norm(record.fields["SKU"]);
    if (sku && !master.has(sku)) master.set(sku, record.fields);
  }

  return master;
}

function isVerified(sku, master) {
  const fields = master.get(sku);
  if (!fields) return false;

  const name = String(fields["Product Name"] ?? "").trim();

  // A name that is empty, or that is just the SKU written out, is what the
  // old fallback left behind. It is a miss, not a match.
  if (!name || norm(name) === sku) return false;

  const styleId = fields["StockX Style ID"];
  if (!styleId) return false;

  const known = skuVariants(styleId);

  return [...skuVariants(sku)].some((variant) => known.has(variant));
}

/*
 * CHANGED - paged by id window instead of by keyset.
 *
 * The keyset version asked for `order=id.asc`, and that one clause is what
 * broke it. Measured against the live table:
 *
 *   merchant + High + active                90ms
 *   the same, plus order=id.asc           8105ms -> statement timeout
 *
 * With the sort, Postgres walks the primary key index looking for rows that
 * match, and a store with seventy hits among half a million rows means it
 * walks nearly all of them. Without the sort it filters on merchant first
 * and is done. The store with the fewest matches timed out hardest, which
 * is the giveaway: the cost is in the scan, not in the number of hits.
 *
 * So: no sorting. Walk fixed windows of id instead. Each window is bounded
 * work, the whole range is covered exactly once, and nothing is missed
 * because a window is a range rather than a position.
 *
 * A window that comes back completely full may have been cut off at the
 * thousand-row ceiling, so it is halved and read again.
 */
const ID_WINDOW = 100000;

async function collectHighSkus() {
  const perSku = new Map();
  let rows = 0;

  const topResponse = await supabase("store_listings?select=id&order=id.desc&limit=1");
  const top = (await topResponse.json())[0]?.id ?? 0;

  const readWindow = async (from, to) => {
    const response = await supabase(
      `store_listings?select=id,sku&status=eq.active&sku=not.is.null` +
      `&match_risk_level=eq.High${storeFilter}&id=gte.${from}&id=lt.${to}&limit=1000`
    );

    const page = await response.json();
    if (!Array.isArray(page)) return;

    // Full page: the window may hold more than we were given. Split rather
    // than accept a silent truncation.
    if (page.length === 1000 && to - from > 1) {
      const mid = Math.floor((from + to) / 2);

      await readWindow(from, mid);
      await readWindow(mid, to);
      return;
    }

    for (const row of page) {
      const sku = norm(row.sku);
      perSku.set(sku, (perSku.get(sku) || 0) + 1);
      rows += 1;
    }
  };

  for (let from = 0; from <= top; from += ID_WINDOW) {
    await readWindow(from, from + ID_WINDOW);

    console.log(`  ...id ${from + ID_WINDOW} of ${top}, ${rows} rows so far`);
  }

  return { perSku, rows };
}

/**
 * A SKU containing a comma or a quote cannot go into PostgREST's in.(...)
 * list without escaping games, so those are updated one at a time. There
 * are few of them and correctness beats cleverness here.
 */
const needsOwnRequest = (sku) => sku.includes(",") || sku.includes('"');

async function setLow(skus) {
  const body = JSON.stringify({ match_risk_level: "Low" });

  const headers = {
    "Content-Type": "application/json",
    Prefer: "return=minimal"
  };

  const filter = `&status=eq.active&match_risk_level=eq.High${storeFilter}`;

  const simple = skus.filter((sku) => !needsOwnRequest(sku));
  const awkward = skus.filter(needsOwnRequest);

  for (let i = 0; i < simple.length; i += 100) {
    const batch = simple.slice(i, i + 100);
    const list = batch.map((sku) => `"${sku}"`).join(",");

    await supabase(
      `store_listings?sku=in.(${encodeURIComponent(list)})${filter}`,
      { method: "PATCH", headers, body }
    );

    console.log(`  updated ${Math.min(i + 100, simple.length)}/${simple.length} SKUs`);
  }

  for (const sku of awkward) {
    await supabase(
      `store_listings?sku=eq.${encodeURIComponent(sku)}${filter}`,
      { method: "PATCH", headers, body }
    );
  }
}

async function main() {
  console.log(APPLY ? "APPLY — this writes\n" : "DRY RUN — nothing is written\n");

  console.log(STORE ? `store: ${STORE}` : "store: all of them");
  console.log("reading store_listings...");
  const { perSku, rows } = await collectHighSkus();
  console.log(`  ${rows} rows on High, ${perSku.size} distinct SKUs\n`);

  console.log("reading SKU Master...");
  const master = await loadSkuMaster();
  console.log(`  ${master.size} SKUs\n`);

  const verified = [];
  let verifiedRows = 0;
  let unknownRows = 0;

  for (const [sku, count] of perSku) {
    if (isVerified(sku, master)) {
      verified.push(sku);
      verifiedRows += count;
    } else {
      unknownRows += count;
    }
  }

  console.log("--- verdict ---");
  console.log(`  to Low   : ${verified.length} SKUs, ${verifiedRows} rows`);
  console.log(`  stays High: ${perSku.size - verified.length} SKUs, ${unknownRows} rows (not in SKU Master)`);
  console.log("\nexamples going to Low:");

  for (const sku of verified.slice(0, 8)) {
    console.log(`   ${sku.padEnd(22)} ${master.get(sku)["Product Name"]}`);
  }

  if (!APPLY) {
    console.log("\ndry run — rerun with --apply to write");
    return;
  }

  const todo = verified.slice(0, LIMIT);
  console.log(`\nwriting ${todo.length} SKUs...`);

  await setLow(todo);

  console.log("\ndone. counting what is left:");

  const check = await supabase(
    `store_listings?select=id&status=eq.active&sku=not.is.null&match_risk_level=eq.High${storeFilter}`,
    { headers: { Prefer: "count=exact", Range: "0-0" } }
  );

  console.log(`  still High with a SKU: ${check.headers.get("content-range")?.split("/")[1]}`);
}

main().catch((error) => {
  console.error("\nfailed:", error.message);
  process.exit(1);
});
