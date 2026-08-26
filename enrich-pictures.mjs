/**
 * enrich-pictures.mjs — fills in missing pictures. Runs on an interval.
 *
 * Two passes, in this order, because the direction matters:
 *
 *   A. SKU Master   picture missing -> find it on Retailed, verified
 *   B. store_listings  picture or name missing -> copy from SKU Master
 *
 * SKU Master is the truth. store_listings never does its own product
 * lookup any more; it reads what SKU Master already established. That is
 * what stops the same SKU from getting two different names, and stops an
 * unverified Retailed hit from entering as fact.
 *
 * Pass A is also the retry that was missing: a SKU whose picture failed
 * because Retailed was down gets picked up on the next run, forever, until
 * it succeeds. Nothing else in the system retries anything.
 *
 * WHAT IT WILL NOT DO
 *
 *   - never create a SKU Master record. Only an exact StockX match may do
 *     that, and that happens in sku-resolver.js at intake.
 *   - never overwrite a picture that is already there.
 *   - never attach an unverified picture. Retailed returns sku:null on
 *     every result, so a query it cannot place comes back as a page of
 *     loosely related shoes; results[0] is then just the most popular one.
 *     The match is made on the StockX url key, which Retailed calls
 *     `slug`, plus the colorway.
 *
 * USAGE
 *   node enrich-pictures.mjs                  # dry run, changes nothing
 *   node enrich-pictures.mjs --apply
 *   node enrich-pictures.mjs --apply --limit 200
 *   node enrich-pictures.mjs --apply --only a     # only SKU Master
 *   node enrich-pictures.mjs --apply --only b     # only store_listings
 *
 * The url key: SKU Master does not store it today, so pass A asks StockX
 * for it each time. Add a "StockX URL Key" text field to SKU Master and
 * this script fills it in as it goes; from then on the verification is
 * free and pass A needs one API call instead of two.
 */

import "dotenv/config";
import Airtable from "airtable";
import { createClient } from "@supabase/supabase-js";

import {
  asText,
  normalizeSku,
  normalizeSlug,
  identifyOnStockx,
  findPictureOnRetailed,
  isUnstableImageUrl,
  PICTURE_URL_FIELD
} from "./sku-resolver.mjs";

const argOf = (naam, standaard) => {
  const i = process.argv.indexOf(naam);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : standaard;
};

const APPLY = process.argv.includes("--apply");
const LIMIT = Number(argOf("--limit", "100"));
const ONLY = argOf("--only", "");
const DELAY_MS = Number(argOf("--delay", "250"));

const SKU_MASTER_TABLE = process.env.AIRTABLE_SKU_MASTER_TABLE || "SKU Master";
const URL_KEY_FIELD = "StockX URL Key";

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
 * FIXED - this read the "Picture" attachment, whose url points at
 * airtableusercontent.com and expires within hours. Two things went wrong
 * with that. Pass A treated a row holding only such an attachment as done,
 * so it never got a lasting link. And pass B copied that address straight
 * into store_listings.picture_url, where it kept working for exactly as
 * long as it took anyone to look.
 *
 * "Picture URL" is the text field beside it, holding where the image really
 * came from - the field sku-resolver.mjs writes at intake for this very
 * reason. An expiring address counts as no picture at all, which is what
 * makes pass A pick those rows up and give them a real one.
 */
const pictureUrlOf = (fields) => {
  const url = asText(fields?.[PICTURE_URL_FIELD]);
  return isUnstableImageUrl(url) ? "" : url;
};

const heeftBijlage = (fields) => {
  const picture = fields?.["Picture"];
  return Array.isArray(picture) && Boolean(picture[0]?.url);
};

/**
 * A record whose Product Name is empty or is literally the SKU was never
 * properly matched. Giving it a picture would make a broken record look
 * finished, so it is left alone and reported instead.
 */
function isProperlyMatched(fields) {
  const sku = normalizeSku(fields?.["SKU"]);
  const naam = asText(fields?.["Product Name"]).trim();

  return Boolean(sku) && Boolean(naam) && normalizeSku(naam) !== sku;
}

/* ------------------------------------------------------------------ */
/* A. SKU Master: missing picture -> Retailed, verified                */
/* ------------------------------------------------------------------ */

async function passA() {
  console.log(`\n${"=".repeat(66)}\nA. SKU Master — missing pictures\n${"=".repeat(66)}`);

  const kandidaten = [];
  const ongeschikt = [];
  let heeftUrlKeyVeld = false;

  await airtable(SKU_MASTER_TABLE)
    .select({ fields: ["SKU", "Product Name", "Brand", "Picture", PICTURE_URL_FIELD, URL_KEY_FIELD] })
    .eachPage((records, next) => {
      for (const record of records) {
        const f = record.fields || {};

        if (URL_KEY_FIELD in f) heeftUrlKeyVeld = true;
        if (pictureUrlOf(f)) continue;

        const rij = {
          id: record.id,
          sku: normalizeSku(f["SKU"]),
          product_name: asText(f["Product Name"]),
          url_key: normalizeSlug(f[URL_KEY_FIELD]),

          // Only used to leave an attachment that is already there alone.
          // Setting it again makes Airtable re-download the image.
          heeft_bijlage: heeftBijlage(f)
        };

        if (!rij.sku) continue;

        if (isProperlyMatched(f)) kandidaten.push(rij);
        else ongeschikt.push(rij);
      }
      next();
    });

  console.log(`without a picture, properly matched : ${kandidaten.length}`);
  console.log(`without a picture, name is broken   : ${ongeschikt.length}  (left alone)`);
  console.log(`"${URL_KEY_FIELD}" field present    : ${heeftUrlKeyVeld ? "yes" : "no — StockX is queried each time"}`);

  const werk = kandidaten.slice(0, LIMIT);
  if (werk.length < kandidaten.length) {
    console.log(`processing ${werk.length} this run (raise with --limit)`);
  }

  const uitkomst = { filled: 0, no_match: 0, unverified: 0, failed: 0 };

  for (const [i, rij] of werk.entries()) {
    try {
      let urlKey = rij.url_key;
      let colorway = "";

      // Without a stored url key there is nothing to verify Retailed
      // against, so StockX has to be asked first.
      if (!urlKey) {
        const identity = await identifyOnStockx(rij.sku);

        if (!identity) {
          uitkomst.no_match++;
          console.log(`  ${rij.sku.padEnd(18)} no exact StockX match — skipped`);
          await wacht(DELAY_MS);
          continue;
        }

        urlKey = identity.url_key;
        colorway = identity.colorway;
      }

      const picture = await findPictureOnRetailed(rij.sku, {
        identity: { url_key: urlKey, colorway }
      });

      if (!picture) {
        uitkomst.unverified++;
        console.log(`  ${rij.sku.padEnd(18)} no verified picture — left empty`);
        await wacht(DELAY_MS);
        continue;
      }

      if (APPLY) {
        // The lasting link first; the attachment only when the row has
        // none. A row that already shows a picture keeps the one it has -
        // what it was missing is a link other services can store.
        const velden = { [PICTURE_URL_FIELD]: picture.image };

        if (!rij.heeft_bijlage) velden["Picture"] = [{ url: picture.image }];

        // Store the key so the next run skips the StockX call entirely.
        if (heeftUrlKeyVeld && urlKey) velden[URL_KEY_FIELD] = urlKey;

        await airtable(SKU_MASTER_TABLE).update(rij.id, velden);
      }

      uitkomst.filled++;
      console.log(
        `  ${rij.sku.padEnd(18)} picture via ${picture.verified_by.padEnd(5)} ${APPLY ? "" : "(dry run)"}`
      );
    } catch (err) {
      uitkomst.failed++;
      console.log(`  ${rij.sku.padEnd(18)} failed: ${err.message}`);
    }

    await wacht(DELAY_MS);
  }

  console.log(
    `\nfilled=${uitkomst.filled}  no_stockx_match=${uitkomst.no_match}  unverified=${uitkomst.unverified}  failed=${uitkomst.failed}`
  );

  return uitkomst;
}

/* ------------------------------------------------------------------ */
/* B. store_listings: missing picture or name -> from SKU Master       */
/* ------------------------------------------------------------------ */

async function passB() {
  console.log(`\n${"=".repeat(66)}\nB. store_listings — fill from SKU Master\n${"=".repeat(66)}`);

  const rijen = [];
  const stap = 1000;

  for (let start = 0; ; start += stap) {
    const { data, error } = await supabase
      .from("store_listings")
      .select("id, sku, stockx_product_name, brand, picture_url, status")
      .eq("status", "active")
      .order("id", { ascending: true })
      .range(start, start + stap - 1);

    if (error) throw error;
    if (!data?.length) break;

    rijen.push(...data);
    if (data.length < stap) break;
  }

  const onvolledig = rijen.filter(
    (r) => normalizeSku(r.sku) && (!asText(r.picture_url).trim() || !asText(r.stockx_product_name).trim())
  );

  console.log(`active rows        : ${rijen.length}`);
  console.log(`missing name or picture : ${onvolledig.length}`);

  if (!onvolledig.length) return { updated: 0, unresolved: 0 };

  // One Airtable read per 50 SKUs rather than one per row.
  const skus = [...new Set(onvolledig.map((r) => normalizeSku(r.sku)))];
  const master = new Map();

  for (let i = 0; i < skus.length; i += 50) {
    const groep = skus.slice(i, i + 50);

    const records = await airtable(SKU_MASTER_TABLE)
      .select({
        fields: ["SKU", "Product Name", "Brand", "Picture", PICTURE_URL_FIELD],
        filterByFormula: `OR(${groep
          .map((sku) => `{SKU} = '${sku.replaceAll("'", "\\'")}'`)
          .join(",")})`
      })
      .all()
      .catch(() => []);

    for (const record of records) {
      const f = record.fields || {};

      // A broken SKU Master record must not be copied outward.
      if (!isProperlyMatched(f)) continue;

      master.set(normalizeSku(f["SKU"]), {
        product_name: asText(f["Product Name"]),
        brand: asText(f["Brand"]),
        image: pictureUrlOf(f)
      });
    }
  }

  console.log(`usable SKU Master entries : ${master.size} of ${skus.length} SKUs`);

  let bijgewerkt = 0;
  let onopgelost = 0;

  for (const rij of onvolledig) {
    const bron = master.get(normalizeSku(rij.sku));

    if (!bron) {
      onopgelost++;
      continue;
    }

    const velden = {};

    if (!asText(rij.stockx_product_name).trim() && bron.product_name) {
      velden.stockx_product_name = bron.product_name;
    }

    if (!asText(rij.brand).trim() && bron.brand) velden.brand = bron.brand;
    if (!asText(rij.picture_url).trim() && bron.image) velden.picture_url = bron.image;

    if (!Object.keys(velden).length) continue;

    if (APPLY) {
      velden.updated_at = new Date().toISOString();

      const { error } = await supabase
        .from("store_listings")
        .update(velden)
        .eq("id", rij.id);

      if (error) {
        console.log(`  ${rij.sku} failed: ${error.message}`);
        continue;
      }
    }

    bijgewerkt++;
  }

  console.log(`\nfilled=${bijgewerkt}  no usable SKU Master entry=${onopgelost}`);

  return { updated: bijgewerkt, unresolved: onopgelost };
}

/* ------------------------------------------------------------------ */

async function main() {
  console.log(APPLY ? "\nAPPLY — writes enabled\n" : "\nDRY RUN — nothing is written\n");

  if (ONLY !== "b") await passA();
  if (ONLY !== "a") await passB();

  if (!APPLY) console.log("\nNothing was changed. Add --apply to write.\n");
  else console.log("\nDone.\n");
}

main().catch((err) => {
  console.error("\nStopped:", err.message);
  process.exit(1);
});
