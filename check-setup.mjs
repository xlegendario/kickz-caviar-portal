/**
 * check-setup.mjs — controleert of alles klaarstaat. Verandert niets.
 *
 * Draai dit als eerste. Het zegt per onderdeel of het werkt en wat er
 * ontbreekt, zodat je niet halverwege een opruimactie op een ontbrekende
 * sleutel stukloopt.
 *
 *   node check-setup.mjs
 */

import "dotenv/config";
import Airtable from "airtable";
import { createClient } from "@supabase/supabase-js";

const VERPLICHT = [
  ["SUPABASE_URL", "Supabase project-url"],
  ["SUPABASE_SERVICE_ROLE_KEY", "Supabase service role key"],
  ["AIRTABLE_TOKEN", "Airtable token"],
  ["AIRTABLE_BASE_ID", "Airtable base id"],
  ["STOCKX_API_KEY", "StockX api key"],
  ["RETAILED_API_KEY", "Retailed api key"],
  ["RETAILED_STOCKX_SEARCH_URL", "Retailed zoek-url"]
];

const OPTIONEEL = [
  ["AIRTABLE_SKU_MASTER_TABLE", "SKU Master"],
  ["AIRTABLE_STOCK_LEVELS_TABLE", "Stock Levels"],
  ["AIRTABLE_STOCKX_ACCESS_TOKEN_TABLE", "StockX Access Token"]
];

const ok = (t) => console.log(`  OK    ${t}`);
const fout = (t) => console.log(`  FOUT  ${t}`);
const info = (t) => console.log(`        ${t}`);

let problemen = 0;

function kop(t) {
  console.log(`\n${"-".repeat(60)}\n${t}\n${"-".repeat(60)}`);
}

/* -- 1. variabelen ---------------------------------------------------- */

kop("1. Variabelen in .env");

for (const [naam, wat] of VERPLICHT) {
  if (process.env[naam]) ok(`${naam}`);
  else {
    fout(`${naam} ontbreekt  (${wat})`);
    problemen++;
  }
}

for (const [naam, standaard] of OPTIONEEL) {
  const waarde = process.env[naam];
  info(`${naam} = ${waarde || `(niet gezet, gebruikt "${standaard}")`}`);
}

if (problemen) {
  console.log(`\n${problemen} variabele(n) ontbreken. Vul .env aan en draai opnieuw.\n`);
  process.exit(1);
}

/* -- 2. Supabase ------------------------------------------------------ */

kop("2. Supabase");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

for (const tabel of [
  "consignment_inventory",
  "consignment_stock_levels",
  "store_listings",
  "csv_import_jobs"
]) {
  const { count, error } = await supabase
    .from(tabel)
    .select("*", { count: "exact", head: true });

  if (error) {
    fout(`${tabel}: ${error.message}`);
    problemen++;
  } else {
    ok(`${tabel}  (${count} rijen)`);
  }
}

// De kolom die de overgeslagen SKU's bewaart.
const kolom = await supabase.from("csv_import_jobs").select("skipped_json").limit(1);

if (kolom.error) {
  fout("csv_import_jobs.skipped_json ontbreekt");
  info("  alter table csv_import_jobs add column if not exists skipped_json jsonb;");
  problemen++;
} else {
  ok("csv_import_jobs.skipped_json");
}

/* -- 3. Airtable ------------------------------------------------------ */

kop("3. Airtable");

const base = new Airtable({ apiKey: process.env.AIRTABLE_TOKEN }).base(
  process.env.AIRTABLE_BASE_ID
);

const SKU_MASTER = process.env.AIRTABLE_SKU_MASTER_TABLE || "SKU Master";
const STOCK_LEVELS = process.env.AIRTABLE_STOCK_LEVELS_TABLE || "Stock Levels";
const TOKEN_TABEL =
  process.env.AIRTABLE_STOCKX_ACCESS_TOKEN_TABLE || "StockX Access Token";

let stockxToken = "";

for (const tabel of [SKU_MASTER, STOCK_LEVELS, TOKEN_TABEL]) {
  try {
    const records = await base(tabel).select({ maxRecords: 1 }).firstPage();
    ok(`tabel "${tabel}" bereikbaar`);

    if (tabel === TOKEN_TABEL) {
      stockxToken = String(records[0]?.fields?.["Access Token"] || "");

      if (stockxToken) ok("  StockX Access Token gevuld");
      else {
        fout("  StockX Access Token is leeg");
        problemen++;
      }
    }
  } catch (err) {
    fout(`tabel "${tabel}": ${err.message}`);
    problemen++;
  }
}

// Het veld dat je hebt toegevoegd.
try {
  const records = await base(SKU_MASTER)
    .select({ fields: ["StockX URL Key"], maxRecords: 1 })
    .firstPage();

  ok(`veld "StockX URL Key" bestaat  (${records.length} record gelezen)`);
} catch (err) {
  fout(`veld "StockX URL Key": ${err.message}`);
  info("  Voeg een tekstveld met exact die naam toe aan SKU Master.");
  problemen++;
}

/* -- 4. StockX -------------------------------------------------------- */

kop("4. StockX");

if (stockxToken) {
  try {
    const url = new URL("https://api.stockx.com/v2/catalog/search");
    url.searchParams.set("query", "DZ5485-400");

    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${stockxToken}`,
        "x-api-key": process.env.STOCKX_API_KEY,
        Accept: "application/json"
      }
    });

    if (response.ok) {
      const data = await response.json();
      const results =
        (Array.isArray(data) && data) ||
        data.products || data.data || data.results || data.hits || [];

      ok(`catalogus bereikbaar  (${results.length} resultaten voor DZ5485-400)`);

      const eerste = results[0] || {};
      const heeftUrlKey = Boolean(eerste.urlKey || eerste.url_key || eerste.slug);

      if (heeftUrlKey) {
        ok(`  url key aanwezig: ${eerste.urlKey || eerste.url_key || eerste.slug}`);
      } else {
        fout("  GEEN url key in het antwoord");
        info("  Dit is het enige waarop we een Retailed-foto kunnen verifieren.");
        info("  Draai: node probe-lookup-shape.mjs DZ5485-400 --full");
        info("  en stuur die uitvoer door voordat je verder gaat.");
        problemen++;
      }
    } else {
      fout(`catalogus gaf HTTP ${response.status}`);
      if (response.status === 401) info("  Token verlopen? Ververs hem in Airtable.");
      problemen++;
    }
  } catch (err) {
    fout(`catalogus: ${err.message}`);
    problemen++;
  }
}

/* -- 5. Retailed ------------------------------------------------------ */

kop("5. Retailed");

try {
  const url = new URL(process.env.RETAILED_STOCKX_SEARCH_URL);
  url.searchParams.set("query", "DZ5485-400");

  const response = await fetch(url.toString(), {
    headers: { "x-api-key": process.env.RETAILED_API_KEY }
  });

  if (response.ok) {
    const data = await response.json();
    const results = Array.isArray(data)
      ? data
      : data?.data || data?.results || data?.products || [];

    ok(`bereikbaar  (${results.length} resultaten)`);

    if (results[0]?.slug) ok(`  slug aanwezig: ${results[0].slug}`);
    else {
      fout("  geen slug in het antwoord");
      problemen++;
    }
  } else {
    fout(`HTTP ${response.status}`);
    problemen++;
  }
} catch (err) {
  fout(err.message);
  problemen++;
}

/* -- slot -------------------------------------------------------------- */

console.log(`\n${"=".repeat(60)}`);

if (problemen) {
  console.log(`${problemen} probleem(en). Los die eerst op.\n`);
  process.exit(1);
}

console.log("Alles klaar. Volgende stap:\n");
console.log("  node resolve-existing.mjs --limit 50\n");
