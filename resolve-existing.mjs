/**
 * resolve-existing.mjs — walks everything that already exists, resolves it
 * through the new flow, and sorts every record into one of four outcomes.
 *
 * This is the counterpart to fixing intake. Intake stops new bad records
 * from being created; this repairs the ones already there.
 *
 * FOUR OUTCOMES, per record:
 *
 *   OK       resolves, and what is stored already matches. Untouched.
 *
 *   REPAIR   resolves, but what is stored is wrong or missing. This covers
 *            the SKU-as-name rows, and the store listings that were
 *            matched against a different shoe entirely and are sitting at
 *            "Low" risk because nothing ever compared them.
 *
 *   DEAD     StockX has no exact match. The SKU does not exist, or it has
 *            a typo. Consignment rows get removed; store listings get
 *            flagged High rather than removed, because the merchant still
 *            physically has the product.
 *
 *   UNKNOWN  the lookup itself failed. Never acted on. Run again.
 *
 * WHY REPAIR COMES BEFORE DELETE
 *
 * A large part of what currently looks dead only failed because the old
 * matcher compared the whole style id and StockX writes some of them
 * slash-separated ("315115-112/DD8959-100"). Those SKUs are real and the
 * consignor physically holds the stock. Deleting first would throw it
 * away. So: resolve everything, repair what resolves, and only then look
 * at what is left.
 *
 * USAGE
 *   node resolve-existing.mjs                     # dry run, full report
 *   node resolve-existing.mjs --apply             # repair + flag
 *   node resolve-existing.mjs --apply --delete    # also remove DEAD stock
 *   node resolve-existing.mjs --limit 200         # cap the API calls
 *   node resolve-existing.mjs --only inventory    # inventory|listings|master
 *
 * --apply never deletes. Deleting needs --delete on top, and writes a
 * backup of every removed record first.
 */

import "dotenv/config";
import fs from "node:fs";
import Airtable from "airtable";
import { createClient } from "@supabase/supabase-js";

import {
  asText,
  normalizeSku,
  normalizeSlug,
  slugsMatch,
  resolve as resolveSku,
  URL_KEY_FIELD,
  STYLE_ID_FIELD,
  PICTURE_URL_FIELD
} from "./sku-resolver.mjs";

const argOf = (naam, standaard) => {
  const i = process.argv.indexOf(naam);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : standaard;
};

const APPLY = process.argv.includes("--apply");
const DELETE = process.argv.includes("--delete");
const LIMIT = Number(argOf("--limit", "400"));
const ONLY = argOf("--only", "");
const DELAY_MS = Number(argOf("--delay", "250"));

/**
 * Opzoekingen bewaren tussen ronden door.
 *
 * De opzoekfase komt volledig voor de schrijffase, dus bij store_listings
 * zijn dat twee uur StockX-aanroepen voordat er ook maar iets op schijf
 * staat. Hapert er dan iets, dan is alles weg. Elke honderd SKU's gaat de
 * stand nu naar sku-truth.json, en met --truth-from pikt een volgende ronde
 * die op en slaat over wat al bekend is.
 *
 * Alleen gevonden en zeker-niet-gevonden worden overgeslagen. Een storing
 * betekent dat we het niet weten, en dat mag geen blijvend oordeel worden.
 */
const TRUTH_FILE = argOf("--truth-file", "sku-truth.json");
const TRUTH_FROM = argOf("--truth-from", "");

const SKU_MASTER_TABLE = process.env.AIRTABLE_SKU_MASTER_TABLE || "SKU Master";
const STOCK_LEVELS_TABLE = process.env.AIRTABLE_STOCK_LEVELS_TABLE || "Stock Levels";

for (const naam of [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "AIRTABLE_TOKEN",
  "AIRTABLE_BASE_ID"
]) {
  if (!process.env[naam]) {
    console.error(`Missing ${naam}`);
    process.exit(1);
  }
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const airtable = new Airtable({ apiKey: process.env.AIRTABLE_TOKEN }).base(
  process.env.AIRTABLE_BASE_ID
);

const wacht = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Airtable geeft af en toe een generieke 500 ("An unexpected error
 * occurred"). Een ronde over tweeduizend records klapte daar halverwege op,
 * en omdat het schrijven na het opzoeken komt was daarmee het hele werk
 * kwijt. Drie pogingen met oplopende pauze vangen dat af; blijft het
 * mislukken, dan gaat alleen dat ene record verloren en loopt de rest door.
 */
async function metHerkansing(fn, wat, pogingen = 3) {
  for (let poging = 1; ; poging++) {
    try {
      return await fn();
    } catch (err) {
      if (poging >= pogingen) {
        console.log(`  ${wat}: ${err.message} (opgegeven na ${pogingen})`);
        return null;
      }

      await wacht(400 * 2 ** (poging - 1));
    }
  }
}
const doet = (wat) => !ONLY || ONLY === wat;

const kop = (tekst) =>
  console.log(`\n${"=".repeat(68)}\n${tekst}\n${"=".repeat(68)}`);

const pictureUrlOf = (fields) => {
  const picture = fields?.["Picture"];
  return Array.isArray(picture) && picture[0]?.url ? asText(picture[0].url) : "";
};

const getStockCounterKey = (sku, size) =>
  `${asText(sku).toUpperCase()}-${asText(size).toUpperCase()}`;

/**
 * The two catalogs word the same shoe slightly differently — StockX writes
 * "Jordan 1 Retro High OG", Retailed writes name and colorway apart — so a
 * plain string compare would mark almost everything as wrong. Reuse the
 * slug comparison, which allows a couple of words of difference but not a
 * different colorway.
 */
function namesAgree(stored, resolved) {
  const a = asText(stored).trim();
  const b = asText(resolved).trim();

  if (!a || !b) return false;
  if (normalizeSlug(a) === normalizeSlug(b)) return true;

  return slugsMatch(a, b);
}

/* ------------------------------------------------------------------ */
/* Read everything                                                     */
/* ------------------------------------------------------------------ */

/**
 * Alle rijen van een tabel, gepagineerd op de laatst geziene id.
 *
 * GEWIJZIGD — pagineerde op positie: .range(300000, 300999). Postgres moet
 * dan eerst driehonderdduizend rijen doorlopen om ze weg te gooien, en dat
 * wordt per pagina trager. Bij store_listings, met 318.187 actieve rijen,
 * liep dat over de tijdslimiet:
 *
 *     canceling statement due to statement timeout
 *
 * Op de laatst geziene id vragen is per pagina even duur, hoe diep je ook
 * zit, want de index doet het werk. Vereist wel dat er op id gesorteerd
 * wordt, en dat deden we al.
 */
async function allRows(table, columns, filter) {
  const alles = [];
  const stap = 1000;

  let naId = null;

  for (;;) {
    let query = supabase.from(table).select(columns);
    if (filter) query = filter(query);
    if (naId !== null) query = query.gt("id", naId);

    const uitkomst = await metHerkansing(
      async () => {
        const uit = await query.order("id", { ascending: true }).limit(stap);
        if (uit.error) throw uit.error;
        return uit;
      },
      `${table} vanaf id ${naId ?? 0}`
    );

    // metHerkansing geeft null na de laatste mislukte poging. Dat stil
    // laten passeren zou een halve lijst opleveren die er compleet uitziet
    // — precies de fout die het weggehaalde vangnet hierboven maakte.
    if (!uitkomst) {
      throw new Error(
        `${table}: lezen mislukt vanaf id ${naId ?? 0}, gestopt met ` +
        `${alles.length} rijen om geen halve lijst terug te geven`
      );
    }

    const { data } = uitkomst;

    if (!data?.length) break;

    alles.push(...data);

    if (data.length < stap) break;

    naId = data[data.length - 1].id;
  }

  return alles;
}

async function readSkuMasterAll() {
  const alles = [];

  await airtable(SKU_MASTER_TABLE)
    .select({
      fields: [
        "SKU",
        "Product Name",
        "Brand",
        "Picture",
        URL_KEY_FIELD,
        STYLE_ID_FIELD,
        PICTURE_URL_FIELD
      ]
    })
    .eachPage((records, next) => {
      for (const record of records) {
        const f = record.fields || {};

        alles.push({
          id: record.id,
          sku: normalizeSku(f["SKU"]),
          product_name: asText(f["Product Name"]),
          brand: asText(f["Brand"]),
          image: pictureUrlOf(f),
          url_key: normalizeSlug(f[URL_KEY_FIELD]),
          style_id: normalizeSku(f[STYLE_ID_FIELD]),
          picture_url: asText(f[PICTURE_URL_FIELD])
        });
      }
      next();
    });

  return alles;
}

/* ------------------------------------------------------------------ */
/* Resolve every unique SKU once                                       */
/* ------------------------------------------------------------------ */

async function resolveAll(skus) {
  const waarheid = new Map();

  if (TRUTH_FROM && fs.existsSync(TRUTH_FROM)) {
    const eerder = JSON.parse(fs.readFileSync(TRUTH_FROM, "utf8"));
    let hergebruikt = 0;

    for (const [sku, uitkomst] of Object.entries(eerder)) {
      // Alleen wat we zeker weten. Een eerdere storing zegt niets over de
      // SKU en wordt dus opnieuw geprobeerd.
      if (uitkomst?.ok || uitkomst?.reason === "not_found") {
        waarheid.set(sku, uitkomst);
        hergebruikt++;
      }
    }

    console.log(`uit ${TRUTH_FROM}: ${hergebruikt} eerdere uitkomsten hergebruikt`);
  }

  const teDoen = skus.filter((sku) => !waarheid.has(sku));
  const werk = teDoen.slice(0, LIMIT);

  console.log(`unique SKUs        : ${skus.length}`);
  console.log(`nog op te zoeken   : ${teDoen.length}`);
  console.log(`resolving this run : ${werk.length}${teDoen.length > werk.length ? "  (raise with --limit)" : ""}\n`);

  const bewaar = () => {
    fs.writeFileSync(TRUTH_FILE, JSON.stringify(Object.fromEntries(waarheid)));
  };

  let ok = 0;
  let geen = 0;
  let mislukt = 0;

  for (const [i, sku] of werk.entries()) {
    // write:false — resolving must never create a SKU Master record. Only
    // intake may do that, and only on an exact match.
    const uitkomst = await resolveSku(sku, { write: false }).catch((err) => ({
      ok: false,
      reason: "lookup_failed",
      sku,
      error: err.message
    }));

    waarheid.set(sku, uitkomst);

    if (uitkomst.ok) ok++;
    else if (uitkomst.reason === "not_found") geen++;
    else mislukt++;

    if ((i + 1) % 50 === 0) {
      console.log(`  ${i + 1}/${werk.length}  resolved=${ok} no_match=${geen} failed=${mislukt}`);
    }

    // Elke honderd de stand naar schijf. De schrijffase komt pas na alle
    // opzoekingen, dus zonder dit is een onderbreking halverwege een ronde
    // van 11.000 SKU's twee uur werk kwijt.
    if ((i + 1) % 100 === 0) bewaar();

    await wacht(DELAY_MS);
  }

  bewaar();

  console.log(`\nresolved=${ok}  no_match=${geen}  lookup_failed=${mislukt}`);
  console.log(`tussenstand bewaard in ${TRUTH_FILE}`);

  return waarheid;
}

/* ------------------------------------------------------------------ */

async function main() {
  console.log(
    APPLY
      ? DELETE
        ? "\nAPPLY + DELETE — repairs, flags and removals are written\n"
        : "\nAPPLY — repairs and flags are written, nothing is deleted\n"
      : "\nDRY RUN — nothing is written\n"
  );

  /* -- gather ------------------------------------------------------- */

  const inventory = doet("inventory")
    ? await allRows(
        "consignment_inventory",
        "id, seller_record_id, product_name, sku, size, brand, quantity, image_url"
      )
    : [];

  const listings = doet("listings")
    ? await allRows(
        "store_listings",
        "id, sku, stockx_product_name, brand, picture_url, retailed_status, match_risk_level, status",
        (q) => q.eq("status", "active")
      )
    : [];

  const master = doet("master") ? await readSkuMasterAll() : [];

  kop("Loaded");
  console.log(`consignment_inventory : ${inventory.length}`);
  console.log(`store_listings active : ${listings.length}`);
  console.log(`SKU Master            : ${master.length}`);

  const skus = [
    ...new Set(
      [
        ...inventory.map((r) => normalizeSku(r.sku)),
        ...listings.map((r) => normalizeSku(r.sku)),
        ...master.map((r) => r.sku)
      ].filter(Boolean)
    )
  ].sort();

  kop("Resolving against StockX + Retailed");
  const waarheid = await resolveAll(skus);

  /* -- classify ----------------------------------------------------- */

  const plan = {
    master: { ok: [], repair: [], dead: [], unknown: [], unseen: [] },
    inventory: { ok: [], repair: [], dead: [], unknown: [], unseen: [] },
    listings: { ok: [], repair: [], dead: [], unknown: [], unseen: [] }
  };

  function classify(bak, record, huidigeNaam) {
    const uitkomst = waarheid.get(normalizeSku(record.sku));

    if (!uitkomst) return bak.unseen.push(record);
    if (!uitkomst.ok && uitkomst.reason === "not_found") {
      return bak.dead.push({ ...record, truth: uitkomst });
    }
    if (!uitkomst.ok) return bak.unknown.push({ ...record, truth: uitkomst });

    if (namesAgree(huidigeNaam, uitkomst.product_name)) {
      return bak.ok.push({ ...record, truth: uitkomst });
    }

    return bak.repair.push({ ...record, truth: uitkomst });
  }

  for (const r of master) classify(plan.master, r, r.product_name);
  for (const r of inventory) classify(plan.inventory, r, r.product_name);
  for (const r of listings) classify(plan.listings, r, r.stockx_product_name);

  const telling = (bak) =>
    `ok=${bak.ok.length}  repair=${bak.repair.length}  dead=${bak.dead.length}  unknown=${bak.unknown.length}  not-checked=${bak.unseen.length}`;

  kop("Plan");
  console.log(`SKU Master            : ${telling(plan.master)}`);
  console.log(`consignment_inventory : ${telling(plan.inventory)}`);
  console.log(`store_listings        : ${telling(plan.listings)}`);

  // The interesting number: listings that sat at "Low" while pointing at a
  // different shoe. Nothing in the current sync could have caught these,
  // because nothing compares the Retailed result to the SKU.
  const valseLow = plan.listings.repair.filter(
    (r) => asText(r.match_risk_level) === "Low" && asText(r.stockx_product_name).trim()
  );

  if (valseLow.length) {
    console.log(`\nstore_listings sitting at "Low" but matched to another shoe : ${valseLow.length}`);
    // Per unieke SKU, niet per rij: dezelfde SKU staat gemiddeld 29 keer in
    // deze tabel en dan vult een handvol producten je hele scherm.
    const gezien = new Set();
    const uniek = valseLow.filter((r) => {
      const k = normalizeSku(r.sku);
      if (gezien.has(k)) return false;
      gezien.add(k);
      return true;
    });

    console.log(`  (${uniek.length} unieke SKU's, ${valseLow.length} rijen)`);

    for (const r of uniek.slice(0, 10)) {
      // Niet afkappen. Kort afgekapte namen lezen als "het scheelt maar een
      // woord" terwijl er twee verschillen achter de streep verdwijnen, en
      // dan trek je de verkeerde conclusie uit je eigen rapport.
      console.log(`  ${normalizeSku(r.sku)}`);
      console.log(`     opgeslagen : ${asText(r.stockx_product_name) || "(leeg)"}`);
      console.log(`     StockX     : ${r.truth.product_name}`);
    }
  }

  if (plan.inventory.repair.length) {
    console.log(`\nconsignment rows that recover (real stock, do NOT delete) : ${plan.inventory.repair.length}`);
    for (const r of plan.inventory.repair.slice(0, 10)) {
      console.log(`  ${normalizeSku(r.sku).padEnd(18)} -> ${r.truth.product_name}`);
    }
  }

  // StockX bundelt soms twee codes achter een schuine streep wanneer dezelfde
  // schoen twee keer is uitgebracht ("315115-112/DD8959-100"). Die volledige
  // waarde wordt WEL in SKU Master gezet als losse notitie, maar nergens als
  // sleutel gebruikt: het SKU-veld blijft de code die is ingevoerd, want daar
  // zoekt alles op en niemand werkt met twee codes tegelijk.
  //
  // Hier alleen geteld, zodat je ziet hoeveel van je SKU's zo gebundeld zijn.
  const gebundeld = [...waarheid.values()].filter(
    (u) => u.ok && normalizeSku(u.matched_sku).includes("/")
  );

  if (gebundeld.length) {
    console.log(`
SKUs where StockX bundles two codes : ${gebundeld.length}`);
  }

  const bestand = `resolve-existing-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  fs.writeFileSync(bestand, JSON.stringify(plan, null, 2));
  console.log(`\nFull plan: ${bestand}`);

  if (!APPLY) {
    console.log("\nNothing was changed. Add --apply to repair and flag.\n");
    return;
  }

  /* -- 1. SKU Master ------------------------------------------------- */

  kop("Writing — SKU Master");

  let n = 0;

  for (const r of plan.master.repair) {
    const velden = {
      "Product Name": r.truth.product_name,
      "Brand": r.truth.brand || r.brand || ""
    };

    if (r.truth.url_key) velden[URL_KEY_FIELD] = r.truth.url_key;
    if (r.truth.matched_sku) velden[STYLE_ID_FIELD] = r.truth.matched_sku;

    // De blijvende url van de foto. Het Picture-veld is een bijlage en
    // levert bij het uitlezen een adres dat na een paar uur vervalt; wie
    // dat opslaat heeft morgen een dood plaatje. Vandaar dit ernaast.
    if (r.truth.image) velden[PICTURE_URL_FIELD] = r.truth.image;
    if (!r.image && r.truth.image) velden["Picture"] = [{ url: r.truth.image }];

    const gelukt = await metHerkansing(
      () => airtable(SKU_MASTER_TABLE).update(r.id, velden),
      r.sku
    );

    if (gelukt) n++;
  }

  console.log(`repaired : ${n}`);

  // Records that already read correctly but have no url key stored yet.
  let m = 0;

  for (const r of plan.master.ok) {
    const velden = {};

    if (!r.url_key && r.truth.url_key) velden[URL_KEY_FIELD] = r.truth.url_key;
    if (!r.style_id && r.truth.matched_sku) velden[STYLE_ID_FIELD] = r.truth.matched_sku;
    if (!r.picture_url && r.truth.image) velden[PICTURE_URL_FIELD] = r.truth.image;
    if (!r.image && r.truth.image) velden["Picture"] = [{ url: r.truth.image }];

    if (!Object.keys(velden).length) continue;

    const gelukt = await metHerkansing(
      () => airtable(SKU_MASTER_TABLE).update(r.id, velden),
      r.sku
    );

    if (gelukt) m++;
  }

  console.log(`topped up (url key / picture) : ${m}`);

  /* -- 2. consignment_inventory -------------------------------------- */

  kop("Writing — consignment_inventory");

  let hersteld = 0;

  for (const r of plan.inventory.repair) {
    const { error } = await supabase
      .from("consignment_inventory")
      .update({
        product_name: r.truth.product_name,
        brand: r.truth.brand || r.brand || "",
        updated_at: new Date().toISOString()
      })
      .eq("id", r.id);

    if (error) console.log(`  ${r.sku} failed: ${error.message}`);
    else hersteld++;
  }

  console.log(`repaired : ${hersteld}`);

  /* -- 3. store_listings --------------------------------------------- */

  kop("Writing — store_listings");

  // GEWIJZIGD — ging rij voor rij. Met 318.187 actieve rijen over 11.000
  // unieke SKU's zijn dat gemiddeld 29 rijen per SKU met exact dezelfde
  // productinformatie, dus tienduizenden verzoeken voor iets wat per SKU
  // een keer hoeft.
  //
  // Nu een schrijfactie per SKU, met een voorwaarde erbij zodat alleen de
  // rijen worden aangeraakt die het nodig hebben: zonder die voorwaarde
  // zouden 292.409 foto-urls die al prima zijn opnieuw worden geschreven.
  function perSku(bak) {
    const kaart = new Map();

    for (const r of bak) {
      const sku = normalizeSku(r.sku);
      if (!sku) continue;

      if (!kaart.has(sku)) kaart.set(sku, { sku, rijen: 0, truth: r.truth });
      kaart.get(sku).rijen++;
    }

    return [...kaart.values()];
  }

  const teRepareren = perSku(plan.listings.repair);
  const teMarkeren = perSku(plan.listings.dead);

  console.log(`SKUs with a wrong or missing name : ${teRepareren.length}`);
  console.log(`SKUs without an exact StockX match : ${teMarkeren.length}`);
  console.log("");

  let gerepareerd = 0;
  let gemarkeerd = 0;
  let fotos = 0;

  for (const [i, item] of teRepareren.entries()) {
    const naam = item.truth.product_name;

    const naamUit = await metHerkansing(
      () => supabase
        .from("store_listings")
        .update({
          stockx_product_name: naam,
          brand: item.truth.brand || "",
          match_risk_level: "Low",
          retailed_status: "ok",
          updated_at: new Date().toISOString()
        })
        .eq("sku", item.sku)
        .eq("status", "active")
        .neq("stockx_product_name", naam)
        .select("id"),
      item.sku
    );

    if (naamUit && !naamUit.error) gerepareerd += (naamUit.data || []).length;

    // De vervallende Airtable-urls vervangen door de blijvende. Alleen die
    // rijen: een werkende images.stockx.com-url is prima zoals hij is.
    if (item.truth.image) {
      const fotoUit = await metHerkansing(
        () => supabase
          .from("store_listings")
          .update({ picture_url: item.truth.image, updated_at: new Date().toISOString() })
          .eq("sku", item.sku)
          .eq("status", "active")
          .or("picture_url.is.null,picture_url.ilike.%airtableusercontent%")
          .select("id"),
        item.sku + " (foto)"
      );

      if (fotoUit && !fotoUit.error) fotos += (fotoUit.data || []).length;
    }

    if ((i + 1) % 200 === 0) {
      console.log(`  names ${i + 1}/${teRepareren.length}  rows=${gerepareerd} photos=${fotos}`);
    }
  }

  // Geen exacte StockX-match: de winkel heeft het product nog steeds, dus
  // de rij blijft staan, maar hij mag niet langer lezen als bevestigde
  // match.
  for (const [i, item] of teMarkeren.entries()) {
    const uit = await metHerkansing(
      () => supabase
        .from("store_listings")
        .update({
          match_risk_level: "High",
          retailed_status: "not_found",
          updated_at: new Date().toISOString()
        })
        .eq("sku", item.sku)
        .eq("status", "active")
        .neq("match_risk_level", "High")
        .select("id"),
      item.sku
    );

    if (uit && !uit.error) gemarkeerd += (uit.data || []).length;

    if ((i + 1) % 200 === 0) {
      console.log(`  flagging ${i + 1}/${teMarkeren.length}  rows=${gemarkeerd}`);
    }
  }

  console.log("");
  console.log(`names corrected : ${gerepareerd} rows`);
  console.log(`photos replaced : ${fotos} rows`);
  console.log(`flagged High    : ${gemarkeerd} rows`);

  /* -- 4. deletions --------------------------------------------------- */

  if (!DELETE) {
    console.log(`\nDEAD consignment rows left alone: ${plan.inventory.dead.length}`);
    console.log("Add --delete to remove them.\n");
    return;
  }

  kop("Deleting — DEAD consignment stock");

  const backup = `deleted-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  fs.writeFileSync(backup, JSON.stringify(plan.inventory.dead, null, 2));
  console.log(`backup written to ${backup}`);

  const sleutels = [
    ...new Set(plan.inventory.dead.map((r) => getStockCounterKey(r.sku, r.size)))
  ];

  for (let i = 0; i < plan.inventory.dead.length; i += 100) {
    const groep = plan.inventory.dead.slice(i, i + 100).map((r) => r.id);

    const { error } = await supabase.from("consignment_inventory").delete().in("id", groep);
    if (error) throw error;
  }

  console.log(`removed ${plan.inventory.dead.length} rows`);

  // Stock levels are shared across every consignor for the same sku+size,
  // so a level is only removed once nothing is left behind it.
  let weg = 0;
  let herrekend = 0;

  for (const sleutel of sleutels) {
    const streep = sleutel.lastIndexOf("-");
    const sku = sleutel.slice(0, streep);
    const size = sleutel.slice(streep + 1);

    const { data: rest } = await supabase
      .from("consignment_inventory")
      .select("quantity")
      .eq("sku", sku)
      .eq("size", size);

    const totaal = (rest || [])
      .filter((r) => Number(r.quantity || 0) > 0)
      .reduce((som, r) => som + Number(r.quantity || 0), 0);

    if (totaal > 0) {
      await supabase
        .from("consignment_stock_levels")
        .update({ stock_level: totaal, updated_at: new Date().toISOString() })
        .eq("stock_counter_key", sleutel);

      herrekend++;
      continue;
    }

    await supabase.from("consignment_stock_levels").delete().eq("stock_counter_key", sleutel);

    // Airtable mirrors this table, and autoAllocateBestUnit matches on
    // {Stock Counter Key}. Leaving it behind offers stock that is gone.
    const records = await airtable(STOCK_LEVELS_TABLE)
      .select({
        fields: ["Stock Counter Key"],
        filterByFormula: `{Stock Counter Key} = '${sleutel.replaceAll("'", "\\'")}'`,
        maxRecords: 1
      })
      .all()
      .catch(() => []);

    if (records.length) await airtable(STOCK_LEVELS_TABLE).destroy(records[0].id);

    weg++;
  }

  console.log(`stock levels removed=${weg} recalculated=${herrekend}`);

  /* -- consignors to notify ------------------------------------------ */

  const perVerkoper = new Map();

  for (const r of plan.inventory.dead) {
    const sleutel = r.seller_record_id || "unknown";
    if (!perVerkoper.has(sleutel)) perVerkoper.set(sleutel, []);
    perVerkoper.get(sleutel).push(r);
  }

  kop("Consignors to notify");

  for (const [id, rijen] of perVerkoper) {
    console.log(`\n${id}  (${rijen.length} rows)`);
    for (const r of rijen.slice(0, 20)) {
      console.log(`   ${normalizeSku(r.sku).padEnd(20)} size ${asText(r.size).padEnd(6)} qty ${r.quantity}`);
    }
    if (rijen.length > 20) console.log(`   ... and ${rijen.length - 20} more`);
  }

  console.log("\nDone.\n");
}

main().catch((err) => {
  console.error("\nStopped:", err.message);
  process.exit(1);
});
