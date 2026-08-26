/**
 * fix-sku-typos.mjs — corrigeert verkeerd ingevoerde SKU's in de
 * consignment-voorraad, en verwijdert wat echt niet te redden is.
 *
 * WAAROM APART
 *
 * resolve-existing.mjs repareert namen. Dit script raakt het SKU-veld zelf
 * aan, en dat is een sleutel: `sku` + `size` vormt de stock_counter_key
 * waar consignment_stock_levels, Airtable's Stock Levels en
 * autoAllocateBestUnit op matchen. Een sku wijzigen betekent dus ook de
 * oude voorraadstand opruimen en de nieuwe aanmaken. Daarom staat dit
 * los, met een vaste lijst in plaats van iets dat zelf gokt.
 *
 * DE LIJST
 *
 * Elke correctie hieronder is een voor een tegen StockX gehouden. Ze
 * komen uit de audit van 21-08-2026 op 3.361 voorraadregels, waar 8 SKU's
 * geen exacte match hadden. Vier daarvan bleken typefouten met samen 43
 * stuks echte voorraad erachter.
 *
 * BOTSINGEN
 *
 * Als dezelfde consignor de goede code al gebruikt voor dezelfde maat,
 * worden de aantallen opgeteld en verdwijnt de verkeerde regel. Anders
 * wordt de sku gewoon bijgewerkt.
 *
 *   node fix-sku-typos.mjs           # laat zien wat er zou gebeuren
 *   node fix-sku-typos.mjs --apply
 */

import "dotenv/config";
import fs from "node:fs";
import Airtable from "airtable";
import { createClient } from "@supabase/supabase-js";

import { asText, normalizeSku, identifyOnStockx } from "./sku-resolver.mjs";

const APPLY = process.argv.includes("--apply");

/**
 * Herstelmodus. Als het herberekenen halverwege stukloopt kan het script
 * niet gewoon opnieuw: de oude SKU's zijn dan al gecorrigeerd, dus stap 2
 * vindt geen regels meer en de sleutellijst blijft leeg.
 *
 * Deze modus haalt de sleutels uit de backup van de eerste ronde en doet
 * alleen stap 4 over. Herberekenen is idempotent — een sleutel die al
 * goed staat wordt gewoon opnieuw op dezelfde waarde gezet.
 *
 *   node fix-sku-typos.mjs --levels-from fix-sku-typos-<datum>.json --apply
 */
const LEVELS_FROM = (() => {
  const i = process.argv.indexOf("--levels-from");
  return i >= 0 ? process.argv[i + 1] || "" : "";
})();

/**
 * Verkeerd ingevoerd -> wat het moet zijn.
 *
 * De fouten zelf: twee keer een letter O waar een nul hoort, een dubbele
 * W, en een etiket zonder haakjes. Die laatste is niet DC6887-200: StockX
 * voert de Special Box als een eigen product met een eigen style id.
 */
const CORRECTIES = {
  "CWW2288-111": "CW2288-111",
  "HO3472": "H03472",
  "HO3471": "H03471",
  // Hoofdletters, want addConsignmentInventoryRow slaat elke sku zo op
  // en de herberekening zoekt er ook zo op.
  "SPECIAL BOX DC6887-200": "(SPECIAL BOX) DC6887-200"
};

/**
 * Niet te redden: geen enkele variant levert een StockX-match op. Zodra de
 * consignor ze opnieuw invoert krijgt hij de melding en kan hij de code
 * corrigeren of contact opnemen.
 */
const VERWIJDEREN = ["A05W702", "L", "FV9918-00", "DH6927-010"];

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

const kop = (t) => console.log(`\n${"=".repeat(66)}\n${t}\n${"=".repeat(66)}`);

const getStockCounterKey = (sku, size) =>
  `${asText(sku).toUpperCase()}-${asText(size).toUpperCase()}`;

const getConsignmentComparePrice = (price, vatType) => {
  const amount = Number(price || 0);
  return vatType === "VAT0" ? amount * 1.21 : amount;
};

async function rijenVoor(sku) {
  const { data, error } = await supabase
    .from("consignment_inventory")
    .select("id, seller_record_id, seller_id, product_name, sku, size, brand, vat_type, selling_price_suggested, quantity")
    .eq("sku", sku);

  if (error) throw error;
  return data || [];
}

/**
 * Zelfde logica als refreshConsignmentStockLevel in index.js: de stand
 * telt over ALLE consignors voor die sku+maat. Bestaat er niets meer, dan
 * gaat de stand weg — ook uit Airtable, want autoAllocateBestUnit matcht
 * daarop en zou anders voorraad blijven aanbieden die er niet is.
 */
async function herberekenStand(sku, size) {
  const cleanSku = asText(sku).toUpperCase();
  const cleanSize = asText(size).toUpperCase();
  const sleutel = getStockCounterKey(cleanSku, cleanSize);

  const { data: rijen, error } = await supabase
    .from("consignment_inventory")
    .select("product_name, brand, vat_type, quantity, selling_price_suggested")
    .eq("sku", cleanSku)
    .eq("size", cleanSize);

  if (error) throw error;

  const actief = (rijen || []).filter((r) => Number(r.quantity || 0) > 0);

  if (!actief.length) {
    await supabase.from("consignment_stock_levels").delete().eq("stock_counter_key", sleutel);

    const records = await airtable(STOCK_LEVELS_TABLE)
      .select({
        fields: ["Stock Counter Key"],
        filterByFormula: `{Stock Counter Key} = '${sleutel.replaceAll("'", "\\'")}'`,
        maxRecords: 1
      })
      .all()
      .catch(() => []);

    if (records.length) await airtable(STOCK_LEVELS_TABLE).destroy(records[0].id);

    return { sleutel, actie: "verwijderd", stand: 0 };
  }

  const stand = actief.reduce((som, r) => som + Number(r.quantity || 0), 0);

  const prijzen = actief
    .map((r) => getConsignmentComparePrice(r.selling_price_suggested, r.vat_type))
    .filter((p) => Number.isFinite(p) && p > 0);

  await supabase.from("consignment_stock_levels").upsert(
    {
      stock_counter_key: sleutel,
      sku: cleanSku,
      size: cleanSize,
      product_name: actief[0].product_name || "",
      brand: actief[0].brand || "",
      stock_level: stand,
      lowest_suggested_price: prijzen.length ? Math.min(...prijzen) : null,
      updated_at: new Date().toISOString()
    },
    { onConflict: "stock_counter_key" }
  );

  const records = await airtable(STOCK_LEVELS_TABLE)
    .select({
      fields: ["Stock Counter Key"],
      filterByFormula: `{Stock Counter Key} = '${sleutel.replaceAll("'", "\\'")}'`,
      maxRecords: 1
    })
    .all()
    .catch(() => []);

  const velden = { "SKU": cleanSku, "Size": cleanSize, "Partner Stock Level": stand };

  // "Stock Counter Key" is in Airtable een berekend veld en mag niet
  // meegestuurd worden; hij volgt uit SKU en Size. Zo doet
  // syncConsignmentStockLevelToAirtable in index.js het ook.
  if (records.length) await airtable(STOCK_LEVELS_TABLE).update(records[0].id, velden);
  else await airtable(STOCK_LEVELS_TABLE).create(velden);

  return { sleutel, actie: "bijgewerkt", stand };
}

/* ------------------------------------------------------------------ */

async function main() {
  console.log(APPLY ? "\nAPPLY — er wordt geschreven\n" : "\nDRY RUN — er verandert niets\n");

  if (LEVELS_FROM) {
    kop("Herstelmodus — alleen voorraadstanden");

    const eerder = JSON.parse(fs.readFileSync(LEVELS_FROM, "utf8"));
    const sleutels = new Set();

    for (const r of eerder.correcties || []) {
      sleutels.add(getStockCounterKey(r.sku, r.size));
      sleutels.add(getStockCounterKey(r.nieuwe_sku, r.size));
    }

    for (const r of eerder.verwijderd || []) {
      sleutels.add(getStockCounterKey(r.sku, r.size));
    }

    console.log(`sleutels uit ${LEVELS_FROM}: ${sleutels.size}`);
    console.log("");

    let mislukt = 0;

    for (const sleutel of sleutels) {
      const streep = sleutel.lastIndexOf("-");
      const sku = sleutel.slice(0, streep);
      const size = sleutel.slice(streep + 1);

      if (!APPLY) {
        console.log(`  ${sleutel}`);
        continue;
      }

      try {
        const uit = await herberekenStand(sku, size);
        console.log(`  ${uit.sleutel.padEnd(34)} ${uit.actie}  (${uit.stand})`);
      } catch (err) {
        mislukt++;
        console.log(`  ${sleutel.padEnd(34)} MISLUKT: ${err.message}`);
      }
    }

    console.log(mislukt ? `\n${mislukt} mislukt.` : "\nAlle standen bijgewerkt.");
    return;
  }

  const backup = { correcties: [], verwijderd: [], gecontroleerd: [] };

  /* -- 1. de correcties eerst opnieuw tegen StockX houden ------------ */

  kop("1. Correcties controleren tegen StockX");

  for (const [fout, goed] of Object.entries(CORRECTIES)) {
    const uit = await identifyOnStockx(goed).catch(() => null);

    if (!uit) {
      console.log(`  AFGEBROKEN  ${goed} levert geen exacte match op`);
      console.log("  Er wordt niets gewijzigd.\n");
      process.exit(1);
    }

    console.log(`  OK  ${fout.padEnd(24)} -> ${goed.padEnd(26)} ${uit.product_name}`);
    backup.gecontroleerd.push({ fout, goed, product_name: uit.product_name });
  }

  /* -- 2. correcties toepassen --------------------------------------- */

  kop("2. SKU's corrigeren");

  const aangeraakteSleutels = new Set();

  for (const [fout, goed] of Object.entries(CORRECTIES)) {
    const rijen = await rijenVoor(fout);

    if (!rijen.length) {
      console.log(`\n${fout}: geen regels meer gevonden, overgeslagen`);
      continue;
    }

    const stuks = rijen.reduce((s, r) => s + Number(r.quantity || 0), 0);
    console.log(`\n${fout} -> ${goed}   (${rijen.length} regels, ${stuks} stuks)`);

    for (const rij of rijen) {
      aangeraakteSleutels.add(getStockCounterKey(fout, rij.size));
      aangeraakteSleutels.add(getStockCounterKey(goed, rij.size));

      // Heeft deze consignor de goede code al voor deze maat?
      const { data: bestaand } = await supabase
        .from("consignment_inventory")
        .select("id, quantity")
        .eq("seller_record_id", rij.seller_record_id)
        .eq("sku", goed)
        .eq("size", rij.size)
        .limit(1);

      if (bestaand?.length) {
        const samen = Number(bestaand[0].quantity || 0) + Number(rij.quantity || 0);
        console.log(`   maat ${String(rij.size).padEnd(8)} samengevoegd met bestaande regel -> ${samen}`);

        if (APPLY) {
          await supabase
            .from("consignment_inventory")
            .update({ quantity: samen, updated_at: new Date().toISOString() })
            .eq("id", bestaand[0].id);

          await supabase.from("consignment_inventory").delete().eq("id", rij.id);
        }
      } else {
        console.log(`   maat ${String(rij.size).padEnd(8)} sku bijgewerkt  (${rij.quantity} stuks)`);

        if (APPLY) {
          await supabase
            .from("consignment_inventory")
            .update({ sku: goed, updated_at: new Date().toISOString() })
            .eq("id", rij.id);
        }
      }

      backup.correcties.push({ ...rij, nieuwe_sku: goed });
    }
  }

  /* -- 3. verwijderen ------------------------------------------------ */

  kop("3. Verwijderen");

  for (const sku of VERWIJDEREN) {
    const rijen = await rijenVoor(sku);

    if (!rijen.length) {
      console.log(`\n${sku}: geen regels meer gevonden`);
      continue;
    }

    const stuks = rijen.reduce((s, r) => s + Number(r.quantity || 0), 0);
    console.log(`\n${sku}: ${rijen.length} regels, ${stuks} stuks`);

    for (const rij of rijen) {
      aangeraakteSleutels.add(getStockCounterKey(sku, rij.size));
      backup.verwijderd.push(rij);
    }

    if (APPLY) {
      const { error } = await supabase
        .from("consignment_inventory")
        .delete()
        .in("id", rijen.map((r) => r.id));

      if (error) throw error;
    }
  }

  /* -- 4. voorraadstanden -------------------------------------------- */

  kop("4. Voorraadstanden");

  console.log(`aangeraakte sleutels: ${aangeraakteSleutels.size}`);

  if (APPLY) {
    for (const sleutel of aangeraakteSleutels) {
      const streep = sleutel.lastIndexOf("-");
      const uit = await herberekenStand(sleutel.slice(0, streep), sleutel.slice(streep + 1));
      console.log(`  ${uit.sleutel.padEnd(34)} ${uit.actie}  (${uit.stand})`);
    }
  } else {
    for (const sleutel of aangeraakteSleutels) console.log(`  ${sleutel}`);
  }

  /* -- slot ----------------------------------------------------------- */

  const bestand = `fix-sku-typos-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  fs.writeFileSync(bestand, JSON.stringify(backup, null, 2));

  console.log(`\nBackup van alles wat aangeraakt is: ${bestand}`);

  if (!APPLY) console.log("\nEr is niets gewijzigd. Draai opnieuw met --apply.\n");
  else console.log("\nKlaar.\n");
}

main().catch((err) => {
  console.error("\nGestopt:", err.message);
  process.exit(1);
});
