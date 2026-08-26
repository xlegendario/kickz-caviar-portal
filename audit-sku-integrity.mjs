/**
 * audit-sku-integrity.mjs — read-only. Changes nothing, anywhere.
 *
 * Counts and classifies the damage before anything gets deleted, because
 * the three categories need different treatment:
 *
 *   RECOVERABLE  the SKU is real and the new slash-aware matcher finds it.
 *                These rows are real stock. Deleting them would throw away
 *                inventory a consignor physically holds. They need their
 *                name repaired, not removing.
 *
 *   DEAD         StockX has no exact match. Typo, or the SKU does not
 *                exist. These are the ones to remove.
 *
 *   UNKNOWN      the lookup itself failed (token, rate limit, timeout).
 *                Never delete on this. Run again.
 *
 * Run this before the cleanup. The order matters: fix the matcher, see
 * what recovers, repair those, and only then delete what is left.
 *
 *   node audit-sku-integrity.mjs
 *   node audit-sku-integrity.mjs --limit 50      # try 50 SKUs against StockX
 *   node audit-sku-integrity.mjs --no-lookup     # counts only, no API calls
 */

import "dotenv/config";
import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";
import Airtable from "airtable";

import { asText, normalizeSku, identifyOnStockx, skuVariants } from "./sku-resolver.mjs";

const argOf = (naam, standaard) => {
  const i = process.argv.indexOf(naam);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : standaard;
};

const LIMIT = Number(argOf("--limit", "150"));
const DO_LOOKUP = !process.argv.includes("--no-lookup");
const DELAY_MS = Number(argOf("--delay", "250"));

const SKU_MASTER_TABLE = process.env.AIRTABLE_SKU_MASTER_TABLE || "SKU Master";

for (const naam of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "AIRTABLE_TOKEN", "AIRTABLE_BASE_ID"]) {
  if (!process.env[naam]) {
    console.error(`Missing ${naam}`);
    process.exit(1);
  }
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const airtable = new Airtable({ apiKey: process.env.AIRTABLE_TOKEN }).base(process.env.AIRTABLE_BASE_ID);

const wacht = (ms) => new Promise((r) => setTimeout(r, ms));

async function allRows(table, columns) {
  const alles = [];
  const stap = 1000;

  for (let start = 0; ; start += stap) {
    const { data, error } = await supabase
      .from(table)
      .select(columns)
      .order("id", { ascending: true })
      .range(start, start + stap - 1);

    if (error) throw error;
    if (!data?.length) break;

    alles.push(...data);
    if (data.length < stap) break;
  }

  return alles;
}

function kop(tekst) {
  console.log(`\n${"=".repeat(64)}\n${tekst}\n${"=".repeat(64)}`);
}

async function main() {
  console.log("\nREAD-ONLY. Nothing is written or deleted.\n");

  /* -- 1. consignment_inventory ------------------------------------- */

  kop("1. consignment_inventory");

  const inventory = await allRows(
    "consignment_inventory",
    "id, seller_record_id, product_name, sku, size, brand, quantity, image_url"
  );

  const skuAsName = inventory.filter((r) => {
    const sku = normalizeSku(r.sku);
    return sku && normalizeSku(r.product_name) === sku;
  });

  const noName = inventory.filter((r) => !asText(r.product_name).trim());

  console.log(`rows                       : ${inventory.length}`);
  console.log(`product_name == sku        : ${skuAsName.length}`);
  console.log(`product_name empty         : ${noName.length}`);
  console.log(
    `  of those, WITH a picture : ${skuAsName.filter((r) => asText(r.image_url).trim()).length}`
  );
  console.log(
    `units at stake             : ${skuAsName.reduce((s, r) => s + Number(r.quantity || 0), 0)}`
  );

  const slashInInventory = skuAsName.filter((r) => asText(r.sku).includes("/"));
  console.log(`sku contains a slash       : ${slashInInventory.length}`);

  /* -- 2. SKU Master ------------------------------------------------- */

  kop("2. SKU Master (Airtable)");

  const skuMaster = [];

  await airtable(SKU_MASTER_TABLE)
    .select({ fields: ["SKU", "Product Name", "Brand", "Picture"] })
    .eachPage((records, next) => {
      for (const record of records) {
        const f = record.fields || {};
        skuMaster.push({
          id: record.id,
          sku: normalizeSku(f["SKU"]),
          product_name: asText(f["Product Name"]),
          brand: asText(f["Brand"]),
          has_picture: Array.isArray(f["Picture"]) && f["Picture"].length > 0
        });
      }
      next();
    });

  const masterNoName = skuMaster.filter((r) => r.sku && !r.product_name.trim());
  const masterNameIsSku = skuMaster.filter(
    (r) => r.sku && normalizeSku(r.product_name) === r.sku
  );
  const masterNoSku = skuMaster.filter((r) => !r.sku);
  const masterSlash = skuMaster.filter((r) => r.sku.includes("/"));

  console.log(`records                    : ${skuMaster.length}`);
  console.log(`no Product Name            : ${masterNoName.length}`);
  console.log(`Product Name == SKU        : ${masterNameIsSku.length}`);
  console.log(`no SKU at all              : ${masterNoSku.length}`);
  console.log(`SKU contains a slash       : ${masterSlash.length}`);
  console.log(
    `broken but WITH a picture  : ${[...masterNoName, ...masterNameIsSku].filter((r) => r.has_picture).length}`
  );

  /* -- 3. store_listings --------------------------------------------- */

  kop("3. store_listings (Supabase)");

  const listings = await allRows(
    "store_listings",
    "id, sku, stockx_product_name, brand, picture_url, retailed_status, match_risk_level, status"
  ).catch((err) => {
    console.log(`could not read: ${err.message}`);
    return [];
  });

  if (listings.length) {
    const actief = listings.filter((r) => r.status === "active");
    const zonderNaam = actief.filter((r) => !asText(r.stockx_product_name).trim());
    const naamIsSku = actief.filter(
      (r) => normalizeSku(r.sku) && normalizeSku(r.stockx_product_name) === normalizeSku(r.sku)
    );
    const zonderSku = actief.filter((r) => !normalizeSku(r.sku));

    console.log(`rows                       : ${listings.length}`);
    console.log(`active                     : ${actief.length}`);
    console.log(`no stockx_product_name     : ${zonderNaam.length}`);
    console.log(`name == sku                : ${naamIsSku.length}`);
    console.log(`no sku                     : ${zonderSku.length}`);
    console.log(`retailed_status != ok      : ${actief.filter((r) => r.retailed_status !== "ok").length}`);

    // match_risk_level is currently computed by calculateMatchRisk({sku}),
    // which only checks that a SKU string is present. It never compares the
    // returned product to the SKU, so "Low" is not evidence of a match.
    const risico = new Map();
    for (const r of actief) {
      const k = asText(r.match_risk_level) || "(empty)";
      risico.set(k, (risico.get(k) || 0) + 1);
    }
    console.log(`match_risk_level           : ${[...risico].map(([k, v]) => `${k}=${v}`).join("  ")}`);
  }

  /* -- 4. wat herstelt de nieuwe matcher? ---------------------------- */

  const teTesten = [
    ...new Set([
      ...skuAsName.map((r) => normalizeSku(r.sku)),
      ...masterNoName.map((r) => r.sku),
      ...masterNameIsSku.map((r) => r.sku)
    ])
  ].filter(Boolean);

  kop(`4. StockX re-check with the slash-aware matcher`);
  console.log(`unique broken SKUs         : ${teTesten.length}`);

  if (!DO_LOOKUP) {
    console.log("skipped (--no-lookup)");
  } else {
    const steekproef = teTesten.slice(0, LIMIT);
    console.log(`testing                    : ${steekproef.length}${
      teTesten.length > steekproef.length ? `  (raise with --limit)` : ""
    }\n`);

    const uitkomst = { recoverable: [], dead: [], unknown: [] };

    for (const [i, sku] of steekproef.entries()) {
      try {
        const identity = await identifyOnStockx(sku);

        if (identity) {
          uitkomst.recoverable.push({
            sku,
            matched_sku: identity.matched_sku,
            product_name: identity.product_name,
            brand: identity.brand,
            // The interesting ones: they only failed because the style id
            // is slash-separated, so the old whole-string compare missed.
            only_slash_was_wrong:
              normalizeSku(identity.matched_sku) !== sku &&
              skuVariants(identity.matched_sku).includes(sku)
          });
        } else {
          uitkomst.dead.push({ sku });
        }
      } catch (err) {
        uitkomst.unknown.push({ sku, error: err.message });
      }

      if ((i + 1) % 25 === 0) {
        console.log(
          `  ${i + 1}/${steekproef.length}  recoverable=${uitkomst.recoverable.length} dead=${uitkomst.dead.length} unknown=${uitkomst.unknown.length}`
        );
      }

      await wacht(DELAY_MS);
    }

    const slashHerstel = uitkomst.recoverable.filter((r) => r.only_slash_was_wrong);

    console.log(`\nRECOVERABLE (real stock)   : ${uitkomst.recoverable.length}`);
    console.log(`  recovered by slash fix   : ${slashHerstel.length}`);
    console.log(`DEAD (safe to delete)      : ${uitkomst.dead.length}`);
    console.log(`UNKNOWN (retry, do NOT delete) : ${uitkomst.unknown.length}`);

    if (uitkomst.recoverable.length) {
      console.log("\n  examples of what would be repaired:");
      for (const r of uitkomst.recoverable.slice(0, 12)) {
        console.log(`    ${r.sku.padEnd(20)} -> ${r.product_name}`);
      }
    }

    if (uitkomst.dead.length) {
      console.log("\n  examples of what would be deleted:");
      for (const r of uitkomst.dead.slice(0, 12)) console.log(`    ${r.sku}`);
    }

    var stockxUitkomst = uitkomst;
  }

  /* -- rapport ------------------------------------------------------- */

  const rapport = {
    generated_at: new Date().toISOString(),
    consignment_inventory: {
      total: inventory.length,
      sku_as_name: skuAsName,
      empty_name: noName.length
    },
    sku_master: {
      total: skuMaster.length,
      no_product_name: masterNoName,
      name_is_sku: masterNameIsSku,
      no_sku: masterNoSku.length,
      slash_skus: masterSlash
    },
    store_listings: { total: listings.length },
    stockx_recheck: typeof stockxUitkomst === "undefined" ? null : stockxUitkomst
  };

  const bestand = `sku-audit-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  fs.writeFileSync(bestand, JSON.stringify(rapport, null, 2));

  console.log(`\nFull report: ${bestand}`);
  console.log("Nothing was changed.\n");
}

main().catch((err) => {
  console.error("\nStopped:", err.message);
  process.exit(1);
});
