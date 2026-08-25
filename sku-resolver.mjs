/**
 * sku-resolver.mjs — one place where a SKU becomes a product.
 *
 * Today four different code paths turn a SKU into a name, a brand and a
 * picture, and they disagree with each other:
 *
 *   index.js:14602  lookupSkuMasterProduct          StockX only, no picture
 *   index.js:14395  createSkuMasterFrom...          Retailed only
 *   index.js:28565  Open WTB creation               Retailed, then StockX
 *   shopify-active-product-sync/server.js:1080      Retailed, UNVERIFIED
 *
 * They differ in three ways that produce bad data:
 *
 *   1. Name shape. StockX paths build `title || name || productName`.
 *      Retailed paths build `name + " " + colorway`. The same SKU gets a
 *      different name depending on which path happened to create it first.
 *
 *   2. Exactness. The portal compares the full SKU string, so a StockX
 *      style id written as "FZ5808-133/FZ5808133" never matches even
 *      though one half is the SKU you asked for. The Shopify sync does
 *      not compare at all — it takes results[0] whatever it is.
 *
 *   3. Failure. The portal writes the SKU as the product name, which is
 *      indistinguishable from a real name later on. Nothing ever retries.
 *
 * This module replaces all four with a single flow:
 *
 *   1. SKU Master is the source of truth. Look there first.
 *   2. Identity comes from StockX, and only from an exact match, where
 *      "exact" understands slash-separated style ids.
 *   3. No exact match => resolve fails and NOTHING is written anywhere.
 *   4. The picture is enrichment, not identity. StockX rarely returns one,
 *      so Retailed fills it in — but Retailed returns sku:null on every
 *      result, so the match is made on the StockX url key, which Retailed
 *      returns as `slug`. A missing picture repairs itself on the next
 *      pass; a wrong picture never does.
 *   5. One write, one complete SKU Master record.
 *
 * Nothing in this file runs on import. It is not wired into index.js yet.
 */

import Airtable from "airtable";

// Stored on every write so later picture checks have something to verify
// Retailed against without asking StockX again.
export const URL_KEY_FIELD = "StockX URL Key";

// The full style id exactly as StockX writes it, including the slash when
// two codes are bundled ("315115-112/DD8959-100"). StockX groups those
// because it is the same shoe, released twice under different codes.
//
// Deliberately NOT in the SKU field: everything looks that up by exact
// match (readSkuMaster, getSkuMasterImageMap, and SKU Master Link from
// Make.com). Keeping it alongside shows which of our codes are the same
// shoe without rebuilding a key.
export const STYLE_ID_FIELD = "StockX Style ID";

// The original, durable URL of the picture. The Picture field is an
// attachment and hands back an address that expires; this field keeps where
// the image actually came from, so other services can store it.
export const PICTURE_URL_FIELD = "Picture URL";

/**
 * Read on use, not on import.
 *
 * index.js calls dotenv.config() in its body, but ES module imports are
 * evaluated before any of that body runs. Reading the keys into consts up
 * here would capture undefined for every one of them and the lookups would
 * fail silently in production — while the standalone scripts, which do
 * `import "dotenv/config"` first, kept working fine. Hence functions.
 */
const env = {
  skuMasterTable: () => process.env.AIRTABLE_SKU_MASTER_TABLE || "SKU Master",
  tokenTable: () =>
    process.env.AIRTABLE_STOCKX_ACCESS_TOKEN_TABLE || "StockX Access Token",
  stockxKey: () => process.env.STOCKX_API_KEY,
  stockxClientId: () => process.env.STOCKX_CLIENT_ID,
  stockxClientSecret: () => process.env.STOCKX_CLIENT_SECRET,
  stockxRefreshToken: () => process.env.STOCKX_REFRESH_TOKEN,
  retailedKey: () => process.env.RETAILED_API_KEY,
  retailedUrl: () => process.env.RETAILED_STOCKX_SEARCH_URL
};

let base = null;

function airtable(table) {
  if (!base) {
    base = new Airtable({ apiKey: process.env.AIRTABLE_TOKEN }).base(
      process.env.AIRTABLE_BASE_ID
    );
  }

  return base(table);
}

/* ------------------------------------------------------------------ */
/* SKU comparison                                                      */
/* ------------------------------------------------------------------ */

export const asText = (value) =>
  value === null || value === undefined ? "" : String(value);

export const normalizeSku = (value) => asText(value).toUpperCase().trim();

/**
 * StockX and Retailed both write the url key as a slug, but not always
 * identically ("air-jordan-1-high-og-unc-toe" vs
 * "air-jordan-1-retro-high-og-unc-toe"). Lowercase and strip separators
 * so the comparison is about the words, not the punctuation.
 */
export function normalizeSlug(value) {
  return asText(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** Words of a slug as a set, for the looser second comparison. */
function slugWords(value) {
  return new Set(normalizeSlug(value).split("-").filter(Boolean));
}

/**
 * True when two slugs describe the same shoe.
 *
 * Exact equality first. The two catalogs also disagree on one word now and
 * then — StockX writes "air-jordan-1-retro-high-og-unc-toe" where Retailed
 * writes "air-jordan-1-high-og-unc-toe" — so a near miss is allowed, but
 * under tight limits, because a loose rule here is how a wrong picture
 * gets in:
 *
 *   - the shorter slug must carry at least 4 words, so a base model name
 *     like "nike-dunk-low" can never swallow a specific colorway
 *   - at most 2 words may differ
 *   - every word of the shorter must appear in the longer
 *
 * Even then this is only half the test. findPictureOnRetailed also
 * compares the colorway, because the colorway is what actually separates
 * one shoe from the next: "unc-toe" and "unc-reimagined" share every word
 * that matters and are two different shoes.
 */
export function slugsMatch(a, b) {
  const left = normalizeSlug(a);
  const right = normalizeSlug(b);

  if (!left || !right) return false;
  if (left === right) return true;

  const leftWords = slugWords(left);
  const rightWords = slugWords(right);

  const kleinste = leftWords.size <= rightWords.size ? leftWords : rightWords;
  const grootste = leftWords.size <= rightWords.size ? rightWords : leftWords;

  if (kleinste.size < 4) return false;
  if (grootste.size - kleinste.size > 2) return false;

  for (const woord of kleinste) {
    if (!grootste.has(woord)) return false;
  }

  return true;
}

/**
 * The colorway is the discriminator. Both catalogs return it as its own
 * field, so it is compared on its own rather than trusting that it made it
 * into the slug intact.
 */
export function colorwaysMatch(a, b) {
  const left = normalizeSlug(a);
  const right = normalizeSlug(b);

  // Nothing to compare is not the same as agreeing.
  if (!left || !right) return false;
  if (left === right) return true;

  const leftWords = slugWords(left);
  const rightWords = slugWords(right);

  const kleinste = leftWords.size <= rightWords.size ? leftWords : rightWords;
  const grootste = leftWords.size <= rightWords.size ? rightWords : leftWords;

  for (const woord of kleinste) {
    if (!grootste.has(woord)) return false;
  }

  return true;
}

/**
 * StockX style ids are not always a single code. Seen in the catalog:
 *
 *   "FZ5808-133"              one code
 *   "FZ5808-133/FZ5808133"    the same shoe, hyphenated and not
 *   "DV0831-106/DZ5485-612"   a pack, two real codes
 *
 * Comparing the whole string means all but the first form fail, which is
 * why real SKUs currently fall through to the SKU-as-name branch.
 */
export function skuVariants(value) {
  const raw = normalizeSku(value);
  if (!raw) return [];

  const parts = raw
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);

  const variants = new Set();

  for (const part of parts.length ? parts : [raw]) {
    variants.add(part);

    // "FZ5808133" and "FZ5808-133" are the same code written two ways.
    // Only used as a secondary comparison, never to widen a search.
    variants.add(part.replaceAll("-", "").replaceAll(" ", ""));
  }

  return [...variants].filter(Boolean);
}

/**
 * True when the candidate is the SKU we asked for. Both sides are split,
 * so "DV0831-106" matches a candidate listed as "DV0831-106/DZ5485-612".
 */
export function isExactSkuMatch(candidate, wanted) {
  const wantedVariants = skuVariants(wanted);
  if (!wantedVariants.length) return false;

  const candidateVariants = skuVariants(candidate);
  if (!candidateVariants.length) return false;

  return candidateVariants.some((one) => wantedVariants.includes(one));
}

/* ------------------------------------------------------------------ */
/* StockX — identity                                                   */
/* ------------------------------------------------------------------ */

// The token lives in Airtable and used to be fetched again on every lookup.
// Over a run of thousands of SKUs that is thousands of extra Airtable calls
// for a value that does not change. Holding it for five minutes sits well
// inside the token's lifetime and removes almost all of them.
let tokenCache = { waarde: "", tot: 0 };

/**
 * Exchanges the refresh token for a new access token and stores it in
 * Airtable, the same way index.js does.
 *
 * Needed because a long pass outlives the token. A run over 9,230 SKUs hit
 * its expiry after about three thousand and then failed on every single one
 * after that: re-reading Airtable gets you the same expired token, so only
 * an actual refresh helps.
 *
 * Returns "" when the refresh credentials are absent, so a caller without
 * them fails on the 401 as before rather than on a confusing config error.
 */
async function refreshStockxAccessToken() {
  if (!env.stockxClientId() || !env.stockxClientSecret() || !env.stockxRefreshToken()) {
    return "";
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: env.stockxClientId(),
    client_secret: env.stockxClientSecret(),
    audience: "gateway.stockx.com",
    refresh_token: env.stockxRefreshToken()
  });

  const response = await fetch("https://accounts.stockx.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok || !data.access_token) {
    throw new Error(`StockX token refresh failed: ${response.status}`);
  }

  const records = await airtable(env.tokenTable())
    .select({ fields: ["Access Token", "Refreshed At"], maxRecords: 1 })
    .firstPage();

  if (records[0]) {
    await airtable(env.tokenTable()).update(records[0].id, {
      "Access Token": data.access_token,
      "Refreshed At": new Date().toISOString()
    });
  }

  tokenCache = { waarde: data.access_token, tot: Date.now() + 5 * 60 * 1000 };

  return data.access_token;
}

async function getStockxAccessToken({ ververs = false } = {}) {
  const nu = Date.now();

  if (!ververs && tokenCache.waarde && nu < tokenCache.tot) {
    return tokenCache.waarde;
  }

  const records = await airtable(env.tokenTable())
    .select({ fields: ["Access Token"], maxRecords: 1 })
    .firstPage();

  const token = asText(records[0]?.fields?.["Access Token"]);
  if (!token) throw new Error("StockX access token is empty in Airtable");

  tokenCache = { waarde: token, tot: nu + 5 * 60 * 1000 };

  return token;
}

function stockxResults(data) {
  if (Array.isArray(data)) return data;

  return (
    data?.products ||
    data?.data ||
    data?.results ||
    data?.hits ||
    []
  );
}

function stockxSkuOf(item) {
  return (
    asText(item?.styleId) ||
    asText(item?.style_id) ||
    asText(item?.sku) ||
    asText(item?.productAttributes?.styleId)
  );
}

/**
 * Retailed's own `sku` is always null, so the only thing both APIs return
 * for the same product is the StockX url key — Retailed calls it `slug`.
 * That is what verifies a picture belongs to the SKU we asked for.
 */
function stockxUrlKeyOf(item) {
  return normalizeSlug(
    asText(item?.urlKey) ||
    asText(item?.url_key) ||
    asText(item?.slug) ||
    asText(item?.productAttributes?.urlKey)
  );
}

/**
 * The one name shape. Every path used to build this differently, which is
 * how the same SKU ended up with two spellings in two tables.
 */
function stockxNameOf(item) {
  return (
    asText(item?.title) ||
    asText(item?.name) ||
    asText(item?.productName) ||
    ""
  );
}

const slaap = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Searches the StockX catalog, with retries.
 *
 * Without retries a short burst of rate limiting costs you a handful of SKUs
 * per run, and those get written off as "could not look up". Over thousands
 * of SKUs that adds up. Only 429 and 5xx are retried; a 4xx means the request
 * itself is wrong and repeating it will not help.
 *
 * On a 401 the token is re-read from Airtable: that is the only place the
 * server refreshes it, so a long-running pass picks up a new token by
 * itself.
 */
export async function searchStockx(sku, { token, pogingen = 4 } = {}) {
  if (!env.stockxKey()) throw new Error("Missing STOCKX_API_KEY");

  const cleanSku = normalizeSku(sku);

  const url = new URL("https://api.stockx.com/v2/catalog/search");
  url.searchParams.set("query", cleanSku);

  let laatsteFout = null;

  for (let poging = 1; poging <= pogingen; poging++) {
    let accessToken;

    if (token) {
      accessToken = token;
    } else if (poging > 1 && laatsteFout?.status === 401) {
      // Re-reading Airtable hands back the same expired token, so the only
      // thing that helps is an actual refresh. Falls back to the stored one
      // when the refresh credentials are not configured.
      accessToken =
        (await refreshStockxAccessToken().catch(() => "")) ||
        (await getStockxAccessToken({ ververs: true }));
    } else {
      accessToken = await getStockxAccessToken();
    }

    let response;

    try {
      response = await fetch(url.toString(), {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "x-api-key": env.stockxKey(),
          Accept: "application/json"
        }
      });
    } catch (err) {
      // Network error: worth retrying.
      laatsteFout = err;

      if (poging < pogingen) {
        await slaap(500 * 2 ** (poging - 1));
        continue;
      }

      throw err;
    }

    const data = await response.json().catch(() => ({}));

    if (response.ok) return stockxResults(data);

    const err = new Error(`StockX catalog search failed: ${response.status}`);
    err.status = response.status;
    err.body = data;
    laatsteFout = err;

    // 404 belongs in this list too, odd as that looks. StockX sometimes
    // answers 404 "No product found for GTIN" for a SKU that returns ten
    // results on the next attempt. Seventeen SKUs from the first SKU Master
    // pass were exactly that, and all seventeen resolved on a retry.
    //
    // A SKU that genuinely does not exist gives a 200 with an empty list,
    // not a 404; that is handled further down. If it is still a 404 after
    // every attempt it comes back as a failure rather than "does not
    // exist" — wrongly marking a SKU as missing costs real stock, whereas
    // trying again costs one API call.
    const magOpnieuw =
      response.status === 404 ||
      response.status === 429 ||
      response.status === 401 ||
      response.status >= 500;

    if (!magOpnieuw || poging === pogingen) throw err;

    // Respecteer Retry-After als StockX hem meestuurt.
    const wacht = Number(response.headers.get("retry-after"));

    await slaap(
      Number.isFinite(wacht) && wacht > 0
        ? Math.min(wacht * 1000, 15000)
        : 500 * 2 ** (poging - 1)
    );
  }

  throw laatsteFout;
}

/**
 * Identity only. Returns null when StockX has no exact match, which is the
 * signal that the SKU does not exist and nothing should be written.
 */
export async function identifyOnStockx(sku, options = {}) {
  const cleanSku = normalizeSku(sku);
  if (!cleanSku) return null;

  const results = await searchStockx(cleanSku, options);

  const match = results.find((item) =>
    isExactSkuMatch(stockxSkuOf(item), cleanSku)
  );

  if (!match) return null;

  const name = stockxNameOf(match);

  // A match without a usable name is not an identity. Falling back to the
  // SKU here is exactly the behaviour this module exists to remove.
  if (!name) return null;

  return {
    sku: cleanSku,
    matched_sku: normalizeSku(stockxSkuOf(match)),
    url_key: stockxUrlKeyOf(match),
    colorway: asText(match?.colorway) || asText(match?.productAttributes?.colorway) || "",
    product_name: name,
    brand: asText(match?.brand) || asText(match?.primaryCategory) || "",
    image:
      asText(match?.image) ||
      asText(match?.media?.imageUrl) ||
      asText(match?.media?.smallImageUrl) ||
      asText(match?.thumbnail) ||
      "",
    raw: match
  };
}

/* ------------------------------------------------------------------ */
/* Retailed — picture only                                             */
/* ------------------------------------------------------------------ */

/**
 * Picture only, and only after StockX has already confirmed the SKU.
 *
 * Retailed returns `sku: null` on every result, so there is no SKU to
 * compare. What both sides do return is the StockX url key — StockX as
 * `urlKey`, Retailed as `slug`. That is the check.
 *
 * It matters because a Retailed query it cannot place returns a page of
 * loosely related shoes: a query can come back with ten different Jordan
 * 1 High OG colorways, and results[0] is then simply the most popular one,
 * not yours. That is how a wrong picture gets in, and nothing ever
 * corrects it afterwards.
 *
 * Pass `identity` (the result of identifyOnStockx) to enable the check.
 * Without it there is nothing to verify against and the call returns null
 * unless allowUnverified is set.
 */
export async function findPictureOnRetailed(
  sku,
  { identity = null, allowUnverified = false } = {}
) {
  if (!env.retailedUrl() || !env.retailedKey()) return null;

  const cleanSku = normalizeSku(sku);
  if (!cleanSku) return null;

  const url = new URL(env.retailedUrl());
  url.searchParams.set("query", cleanSku);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(url.toString(), {
      method: "GET",
      headers: { "x-api-key": env.retailedKey() },
      signal: controller.signal
    });

    if (!response.ok) return null;

    const data = await response.json().catch(() => null);
    const results = Array.isArray(data)
      ? data
      : data?.data || data?.results || data?.products || [];

    if (!results.length) return null;

    const wantedSlug = asText(identity?.url_key);

    // Retailed does sometimes carry a style id under another name. Free to
    // check, and it beats the slug when present.
    const bySku = results.find(
      (item) =>
        isExactSkuMatch(item?.sku, cleanSku) ||
        isExactSkuMatch(item?.styleId, cleanSku) ||
        isExactSkuMatch(item?.style_id, cleanSku)
    );

    // Slug and colorway must both agree. The slug alone lets "unc-toe"
    // pass for "unc-reimagined"; the colorway alone lets a Dunk colorway
    // pass for a Jordan one.
    const wantedColorway = asText(identity?.colorway);

    const bySlug = wantedSlug
      ? results.find((item) => {
          if (!slugsMatch(item?.slug, wantedSlug)) return false;
          if (normalizeSlug(item?.slug) === wantedSlug) return true;

          return colorwaysMatch(item?.colorway, wantedColorway);
        })
      : null;

    const chosen = bySku || bySlug || (allowUnverified ? results[0] : null);

    if (!chosen) return null;

    const image = asText(chosen.image);
    if (!image) return null;

    return {
      image,
      verified_by: bySku ? "sku" : bySlug ? "slug" : "none",
      retailed_slug: normalizeSlug(chosen.slug),
      brand: asText(chosen.brand),
      raw: chosen
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/* ------------------------------------------------------------------ */
/* SKU Master                                                          */
/* ------------------------------------------------------------------ */

function escapeFormulaValue(value) {
  return asText(value).replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

/**
 * Airtable serves attachments from a temporary URL that expires after a few
 * hours. Inside Airtable that is fine — the field keeps working — but handing
 * such a URL to another service that stores it leaves you with a dead image
 * a day later.
 *
 * index.js already has a check for this (isUnstableImageUrl) and its picture
 * chain treats those URLs as "no picture". Same rule here.
 */
export function isUnstableImageUrl(value) {
  const url = asText(value).toLowerCase();

  return (
    !url ||
    url.includes("airtableusercontent.com") ||
    url.includes("dl.airtable.com")
  );
}

/** The attachment URL. Fine for checking whether a picture exists, not for
    handing to anyone else. */
function pictureUrlOf(fields) {
  const picture = fields?.["Picture"];
  return Array.isArray(picture) && picture[0]?.url ? asText(picture[0].url) : "";
}

/**
 * The URL that is safe to hand out.
 *
 * The Picture field is an attachment: Airtable downloads the image and then
 * serves it from an address of its own that expires after a few hours. Fine
 * inside Airtable, fatal the moment another service stores it. So the
 * original URL is kept next to it as plain text.
 */
function stablePictureUrl(fields) {
  const url = asText(fields?.[PICTURE_URL_FIELD]);
  return isUnstableImageUrl(url) ? "" : url;
}

export async function readSkuMaster(sku) {
  const cleanSku = normalizeSku(sku);
  if (!cleanSku) return null;

  const records = await airtable(env.skuMasterTable())
    .select({
      fields: [
        "SKU",
        "Product Name",
        "Brand",
        "Picture",
        URL_KEY_FIELD,
        STYLE_ID_FIELD,
        PICTURE_URL_FIELD
      ],
      filterByFormula: `{SKU} = '${escapeFormulaValue(cleanSku)}'`,
      maxRecords: 1
    })
    .firstPage();

  const record = records[0];
  if (!record) return null;

  const name = asText(record.fields?.["Product Name"]);

  return {
    id: record.id,
    sku: normalizeSku(record.fields?.["SKU"]),
    product_name: name,
    brand: asText(record.fields?.["Brand"]),
    image: stablePictureUrl(record.fields),
    heeft_bijlage: Boolean(pictureUrlOf(record.fields)),
    url_key: normalizeSlug(record.fields?.[URL_KEY_FIELD]),
    style_id: normalizeSku(record.fields?.[STYLE_ID_FIELD]),

    // A record whose name is empty or is just the SKU is a leftover from
    // the old fallback. It is a cache miss, not a hit.
    usable: Boolean(name) && normalizeSku(name) !== cleanSku
  };
}

/* ------------------------------------------------------------------ */
/* The flow                                                            */
/* ------------------------------------------------------------------ */

/**
 * resolve("FZ5808-133") ->
 *   { ok: true,  source: "sku_master" | "stockx", product_name, brand, image }
 *   { ok: false, reason: "empty_sku" | "not_found" | "lookup_failed" }
 *
 * ok:false means: do not create the inventory row, do not create the
 * listing, tell the consignor this SKU was not recognised.
 *
 * `write` false runs the whole flow without touching Airtable, which is
 * what the audit script uses.
 */
export async function resolve(sku, { write = true, token = null } = {}) {
  const cleanSku = normalizeSku(sku);

  if (!cleanSku) return { ok: false, reason: "empty_sku", sku: "" };

  const cached = await readSkuMaster(cleanSku).catch(() => null);

  if (cached?.usable && cached.image) {
    return {
      ok: true,
      source: "sku_master",
      sku: cleanSku,
      record_id: cached.id,
      product_name: cached.product_name,
      brand: cached.brand,
      image: cached.image,
      url_key: cached.url_key,
      matched_sku: cached.style_id || cached.sku
    };
  }

  let identity;

  try {
    identity = await identifyOnStockx(cleanSku, { token });
  } catch (err) {
    // A failed call is not the same as "does not exist". Never let an API
    // outage delete or reject real stock.
    //
    // FIXED — this always returned lookup_failed, even when SKU Master
    // already knew the name. Nineteen Fear of God codes stayed stuck on
    // "could not look up" while a perfectly good record was sitting there:
    // StockX answers 404 "No product found for GTIN" for those codes, even
    // after retries. What we already know is then the best there is.
    if (cached?.usable) {
      return {
        ok: true,
        source: "sku_master",
        sku: cleanSku,
        record_id: cached.id,
        product_name: cached.product_name,
        brand: cached.brand,
        image: cached.image,
        url_key: cached.url_key,
        matched_sku: cached.style_id || cleanSku,
        lookup_failed: true
      };
    }

    return { ok: false, reason: "lookup_failed", sku: cleanSku, error: err.message };
  }

  if (!identity) {
    // Fall back to whatever SKU Master already holds, so an existing good
    // record is never discarded because StockX changed its catalog.
    if (cached?.usable) {
      return {
        ok: true,
        source: "sku_master",
        sku: cleanSku,
        record_id: cached.id,
        product_name: cached.product_name,
        brand: cached.brand,
        image: cached.image,
        // The other success paths all carry this; without it here a caller
        // that stores matched_sku would fall back to the raw input on
        // exactly the rows that came from SKU Master.
        matched_sku: cached.style_id || cached.sku || cleanSku
      };
    }

    return { ok: false, reason: "not_found", sku: cleanSku };
  }

  let image = identity.image || cached?.image || "";
  let pictureSource = image ? (identity.image ? "stockx" : "sku_master") : "";

  if (!image) {
    const picture = await findPictureOnRetailed(cleanSku, { identity });

    if (picture) {
      image = picture.image;
      pictureSource = `retailed:${picture.verified_by}`;
    }
  }

  const result = {
    ok: true,
    source: "stockx",
    sku: cleanSku,
    matched_sku: identity.matched_sku,
    // Should have been here all along. It was used internally when writing,
    // but never came back out, so with write:false a caller never saw the
    // url key and the field stayed empty.
    url_key: identity.url_key,
    colorway: identity.colorway,
    product_name: identity.product_name,
    brand: identity.brand,
    image,
    picture_source: pictureSource,
    record_id: cached?.id || null
  };

  if (!write) return result;

  const fields = {
    "SKU": cleanSku,
    "Product Name": identity.product_name,
    "Brand": identity.brand || cached?.brand || ""
  };

  if (identity.url_key) fields[URL_KEY_FIELD] = identity.url_key;
  if (identity.matched_sku) fields[STYLE_ID_FIELD] = identity.matched_sku;
  if (image) {
    fields[PICTURE_URL_FIELD] = image;

    // Only create the attachment when there isn't one. Setting it again
    // makes Airtable re-download the image, which is pure traffic.
    if (!cached?.heeft_bijlage) fields["Picture"] = [{ url: image }];
  }

  if (cached?.id) {
    await airtable(env.skuMasterTable()).update(cached.id, fields);
  } else {
    const created = await airtable(env.skuMasterTable()).create(fields);
    result.record_id = created.id;
  }

  return result;
}
