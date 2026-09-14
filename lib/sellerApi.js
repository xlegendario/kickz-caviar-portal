// lib/sellerApi.js
//
// The seller API: keys, and the endpoints a store or a member calls with one.
//
// Kept out of index.js on purpose. Everything here that decides something -
// who a key belongs to, whether a row is valid, which table a test key may
// touch - is a plain function or a router built from injected pieces, so it
// can be tested without Airtable, Supabase or a running portal. The portal
// hands in its own functions for the parts that already exist there (the SKU
// catalogue, the consignment upsert, the stock level refresh) rather than
// this file growing a second copy of them.

import crypto from "crypto";
import express from "express";

import { sampleSales, serializeSale } from "./sellerApiSales.js";
import {
  MAX_ACTIVE_WEBHOOKS,
  WEBHOOK_EVENTS,
  buildEventPayload,
  generateWebhookSecret,
  sendWebhook,
  validateWebhookUrl
} from "./sellerApiWebhooks.js";

export const API_KEY_MODES = ["live", "test"];

const KEY_RANDOM_BYTES = 32;
const KEY_PREFIX_LENGTH = 16;
const MAX_ACTIVE_KEYS = 10;
const MAX_BATCH = 200;
const VAT_TYPES = ["Margin", "VAT0", "VAT21"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());

/* ---------------- keys ---------------- */

/*
 * A key names its own mode.
 *
 * "sk_test_" and "sk_live_" are readable at a glance in a config file, which
 * is the cheapest protection there is against someone shipping the test key
 * to production and wondering why nothing sells.
 *
 * No brand in it. Two portals hand these out - Kickz Caviar and Lojiq - and a
 * Lojiq store should not find another company's initials in its own config.
 */
export function generateApiKey(mode) {
  if (!API_KEY_MODES.includes(mode)) {
    throw new Error(`Unknown key mode: ${mode}`);
  }

  const key = `sk_${mode}_${crypto.randomBytes(KEY_RANDOM_BYTES).toString("base64url")}`;

  return { key, prefix: key.slice(0, KEY_PREFIX_LENGTH), hash: hashApiKey(key) };
}

/*
 * SHA-256, not scrypt.
 *
 * Passwords are slow-hashed because people choose guessable ones. A key is
 * 256 random bits: there is nothing to guess, and a slow hash here would only
 * put a deliberate delay on every single API call.
 */
export function hashApiKey(key) {
  return crypto.createHash("sha256").update(String(key)).digest("hex");
}

export function readBearerKey(header) {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(text(header));

  if (!match) return null;

  return /^sk_(live|test)_[A-Za-z0-9_-]{20,}$/.test(match[1]) ? match[1] : null;
}

/* ---------------- rate limit ---------------- */

/*
 * A fixed window per key, in memory.
 *
 * Good enough for one instance, which is what the portal runs. It is there
 * so a broken loop on someone's side cannot drain our Airtable allowance for
 * everybody else, not to meter anyone precisely.
 */
export function createRateLimiter({ limit = 100, windowMs = 60_000, now = Date.now } = {}) {
  const windows = new Map();

  return function hit(id) {
    const at = now();
    let current = windows.get(id);

    if (!current || at >= current.resetAt) {
      current = { count: 0, resetAt: at + windowMs };
      windows.set(id, current);
    }

    current.count += 1;

    return {
      allowed: current.count <= limit,
      limit,
      remaining: Math.max(0, limit - current.count),
      retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - at) / 1000))
    };
  };
}

/* ---------------- request helpers ---------------- */

export function parsePagination(query = {}, { defaultPerPage = 50, maxPerPage = 100 } = {}) {
  const perPageRaw = Number.parseInt(query.per_page, 10);
  const pageRaw = Number.parseInt(query.page, 10);

  const perPage = Number.isFinite(perPageRaw)
    ? Math.min(Math.max(perPageRaw, 1), maxPerPage)
    : defaultPerPage;
  const page = Number.isFinite(pageRaw) && pageRaw >= 1 ? pageRaw : 1;

  return { page, perPage, from: (page - 1) * perPage, to: page * perPage - 1 };
}

export function paginationBlock({ page, perPage, total }) {
  const lastPage = Math.max(1, Math.ceil(total / perPage));

  return {
    current_page: page,
    per_page: perPage,
    total,
    last_page: lastPage,
    has_more_pages: page < lastPage
  };
}

/*
 * One inventory item, checked before anything is looked up.
 *
 * Returns the cleaned item or the reason it is refused. The size rule is the
 * portal's own, handed in, so a pair the dashboard accepts is a pair the API
 * accepts and the two can never disagree about what "42.5" is.
 */
export function validateInventoryItem(raw, { normalizeSize, isUsableSize, sizeError }) {
  const item = raw && typeof raw === "object" ? raw : {};

  const sku = text(item.sku).toUpperCase();
  const size = normalizeSize(text(item.size));
  const vatType = text(item.vat_type);
  const price = Number(item.price);
  const quantity = item.quantity === undefined || item.quantity === null || item.quantity === ""
    ? 1
    : Number(item.quantity);

  if (!sku) return { reason: "sku is required" };
  if (!size) return { reason: "size is required" };
  if (!isUsableSize(size)) return { reason: sizeError(size) };
  if (!VAT_TYPES.includes(vatType)) return { reason: "vat_type must be Margin, VAT0 or VAT21" };
  if (!Number.isFinite(price) || price <= 0) return { reason: "price must be higher than 0" };
  if (!Number.isInteger(quantity) || quantity < 0 || quantity > 999) {
    return { reason: "quantity must be a whole number from 0 to 999" };
  }

  return { item: { sku, size, vatType, price, quantity } };
}

export const INVENTORY_TYPES = ["all", "private", "b2b"];

// The dashboard's own meaning of "open": still waiting for a seller. Kept in
// one place because both listing and cancelling depend on it.
const OPEN_FULFILMENT = ["Pending", "Outsource"];

/*
 * One want-to-buy, checked before anything is looked up.
 *
 * Same size rule as stock: one pair in one size. A want-to-buy is fulfilled
 * by exactly one unit, and "36 x3 37 x5" in a size field is how MWTB-000442
 * became a record nobody could act on.
 */
export function validateWantToBuyInput(raw, { normalizeSize, isUsableSize, sizeError }) {
  const body = raw && typeof raw === "object" ? raw : {};

  const sku = text(body.sku).toUpperCase();
  const size = normalizeSize(text(body.size));
  const inventoryType = text(body.inventory_type).toLowerCase() || "all";
  const hasMaxPrice = body.max_price !== undefined && body.max_price !== null && text(body.max_price) !== "";
  const maxPrice = hasMaxPrice ? Number(body.max_price) : null;

  if (!sku) return { reason: "sku is required" };
  if (!size) return { reason: "size is required" };
  if (!isUsableSize(size)) return { reason: sizeError(size) };
  if (!INVENTORY_TYPES.includes(inventoryType)) return { reason: "inventory_type must be all, private or b2b" };

  // Blank means "no ceiling" and is a choice. Zero or text is a mistake, and
  // quietly treating it as no ceiling would let a typo buy at any price.
  if (hasMaxPrice && (!Number.isFinite(maxPrice) || maxPrice <= 0)) {
    return { reason: "max_price must be higher than 0, or left out for no ceiling" };
  }

  return { item: { sku, size, inventoryType, maxPrice } };
}

export function isOpenWantToBuy(row) {
  return OPEN_FULFILMENT.includes(row.fulfillment_status);
}

export function serializeWantToBuy(row) {
  return {
    id: row.id,
    wtb_id: row.wtb_id || null,
    sku: row.sku,
    size: row.size,
    product_name: row.product_name || null,
    brand: row.brand || null,
    max_price: row.max_price === null || row.max_price === undefined ? null : Number(row.max_price),
    inventory_type: row.inventory_type,
    is_open: isOpenWantToBuy(row),
    purchase_status: row.purchase_status || null,
    fulfillment_status: row.fulfillment_status || null,
    payment_status: row.payment_status || null,
    created_at: row.created_at || null
  };
}

export function serializeInventoryRow(row) {
  return {
    id: row.id,
    sku: row.sku,
    size: row.size,
    product_name: row.product_name || null,
    brand: row.brand || null,
    vat_type: row.vat_type,
    price: row.selling_price_suggested === null ? null : Number(row.selling_price_suggested),
    quantity: Number(row.quantity || 0),
    created_at: row.created_at || null,
    updated_at: row.updated_at || null
  };
}

/*
 * Where a label sits on its deal. An order and a Member WTB spell the
 * permanent copy differently, and the attachment wins because it is the
 * file the dashboard itself shows.
 */
export function labelUrlOf(record, sourceType) {
  const f = record?.fields || {};
  const attachment = Array.isArray(f["Shipping Label"])
    ? f["Shipping Label"].map((a) => text(a?.url)).find(Boolean)
    : "";
  const permanent = text(f[sourceType === "member_wtb" ? "Shipping Label Permanent URL" : "Shipping Label URL (Permanent)"]);
  const url = attachment || permanent;

  return /^https:\/\//i.test(url) ? url : "";
}

// A valid one-page PDF reading "SAMPLE LABEL", for test keys.
const SAMPLE_LABEL_PDF = Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
    "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 288 432]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n" +
    "4 0 obj<</Length 52>>stream\nBT /F1 24 Tf 60 220 Td (SAMPLE LABEL) Tj ET\nendstream endobj\n" +
    "5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n" +
    "trailer<</Root 1 0 R>>\n%%EOF\n",
  "latin1"
);

function ok(res, data, extra = {}) {
  return res.json({ success: true, data, ...extra });
}

function fail(res, status, message, extra = {}) {
  return res.status(status).json({ success: false, message, ...extra });
}

const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

/* ---------------- the API ---------------- */

/*
 * Everything under /api/v1.
 *
 * deps:
 *   store                      data access, see createSupabaseApiStore
 *   setLiveInventoryRow        the portal's consignment upsert
 *   resolveProduct             the portal's SKU catalogue gate
 *   refreshStockLevel          the portal's stock level refresh
 *   normalizeSize, isUsableSize, sizeError
 *   vatEligibilityError(sellerRecordId, vatType) -> message or null
 *   wantToBuyStores            { live, test }, see the two want-to-buy stores
 *   createLiveWantToBuy        the portal's open want-to-buy creator, -> record id
 *   b2bRefusal(type, sellerRecordId) -> message or null
 *   rateLimit                  optional, a createRateLimiter() instance
 */
export function createSellerApiRouter(deps) {
  const {
    store,
    setLiveInventoryRow,
    resolveProduct,
    refreshStockLevel,
    normalizeSize,
    isUsableSize,
    sizeError,
    vatEligibilityError,
    wantToBuyStores = {},
    createLiveWantToBuy,
    b2bRefusal = async () => null,
    salesStore,
    labels,
    webhookStore,
    sendWebhookImpl = sendWebhook,
    logger = console
  } = deps;

  const rateLimit = deps.rateLimit || createRateLimiter();
  const lastTouched = new Map();
  const router = express.Router();

  router.use(wrap(async (req, res, next) => {
    const key = readBearerKey(req.get("authorization"));

    if (!key) {
      return fail(res, 401, "Missing or malformed API key. Send it as: Authorization: Bearer <key>");
    }

    const found = await store.findActiveKeyByHash(hashApiKey(key));

    if (!found) return fail(res, 401, "Invalid or revoked API key");

    req.api = {
      keyId: found.id,
      sellerRecordId: found.seller_record_id,
      sellerId: found.seller_id || "",
      mode: found.mode
    };

    const limit = rateLimit(found.id);

    res.set("X-RateLimit-Limit", String(limit.limit));
    res.set("X-RateLimit-Remaining", String(limit.remaining));
    res.set("X-Api-Mode", found.mode);

    if (!limit.allowed) {
      res.set("Retry-After", String(limit.retryAfterSeconds));

      return fail(res, 429, "Too many requests. Wait for Retry-After seconds and back off.");
    }

    // Once a minute per key is plenty for "last used", and it keeps a busy
    // integration from turning every call into two writes.
    const at = Date.now();

    if (!lastTouched.has(found.id) || at - lastTouched.get(found.id) > 60_000) {
      lastTouched.set(found.id, at);
      store.touchKey(found.id, new Date(at).toISOString()).catch((err) =>
        logger.error("API key last_used_at update failed:", err.message)
      );
    }

    return next();
  }));

  router.get("/inventory", wrap(async (req, res) => {
    const { page, perPage, from, to } = parsePagination(req.query);
    const sku = text(req.query.sku).toUpperCase();
    const inStock = ["true", "1", "yes"].includes(text(req.query.in_stock).toLowerCase());

    const { rows, total } = await store.listInventory({
      mode: req.api.mode,
      sellerRecordId: req.api.sellerRecordId,
      sku,
      inStock,
      from,
      to
    });

    return ok(res, {
      items: rows.map(serializeInventoryRow),
      pagination: paginationBlock({ page, perPage, total })
    });
  }));

  router.post("/inventory", wrap(async (req, res) => {
    const items = Array.isArray(req.body?.items) ? req.body.items : null;

    if (!items || !items.length) {
      return fail(res, 400, "Send a non-empty items array");
    }

    if (items.length > MAX_BATCH) {
      return fail(res, 400, `At most ${MAX_BATCH} items per request`);
    }

    const { mode, sellerRecordId, sellerId } = req.api;
    const skuCache = new Map();
    const seen = new Map();
    const touched = new Map();
    const vatAnswers = new Map();
    const results = [];

    for (let index = 0; index < items.length; index++) {
      const skip = (reason, extra = {}) =>
        results.push({ index, status: "skipped", reason, ...extra });

      const checked = validateInventoryItem(items[index], { normalizeSize, isUsableSize, sizeError });

      if (checked.reason) {
        skip(checked.reason, { sku: text(items[index]?.sku) || null, size: text(items[index]?.size) || null });
        continue;
      }

      const { sku, size, vatType, price, quantity } = checked.item;

      // Once per VAT type per request: the answer comes from the seller's
      // profile, which does not change between row 3 and row 180.
      if (!vatAnswers.has(vatType)) {
        vatAnswers.set(vatType, await vatEligibilityError(sellerRecordId, vatType));
      }

      const vatMessage = vatAnswers.get(vatType);

      if (vatMessage) {
        skip(vatMessage, { sku, size });
        continue;
      }

      let product;

      try {
        product = await resolveProduct(sku, skuCache);
      } catch (err) {
        if (err?.isUnknownSku) {
          skip("SKU not recognised in our catalogue", { sku, size });
          continue;
        }

        if (err?.isLookupFailure) {
          skip("Product lookup temporarily unavailable, send this item again", { sku, size, retryable: true });
          continue;
        }

        throw err;
      }

      // The catalogue decides what a style code looks like, so two spellings
      // of one SKU in the same request are the same pair.
      const canonicalSku = text(product.matched_sku || sku).toUpperCase();
      const pairKey = `${canonicalSku}|${size}`;

      if (seen.has(pairKey)) {
        skip(`Same SKU and size as item ${seen.get(pairKey)} in this request`, { sku: canonicalSku, size });
        continue;
      }

      seen.set(pairKey, index);

      const existing = await store.findInventoryBySkuSize({ mode, sellerRecordId, sku: canonicalSku, size });

      // Zero is how an integration says "I no longer have it". For a pair we
      // were never told about there is nothing to set to zero, and creating an
      // empty row would only be clutter.
      if (!existing && quantity === 0) {
        skip("quantity is 0 for a pair you do not list", { sku: canonicalSku, size });
        continue;
      }

      let written;

      if (mode === "live") {
        written = await setLiveInventoryRow({
          sellerRecordId,
          sellerId,
          sku,
          size,
          vatType,
          sellingPriceSuggested: price,
          quantity,
          skuCache
        });

        touched.set(pairKey, { sku: canonicalSku, size });
      } else {
        written = await store.upsertTestInventoryRow({
          existing,
          row: {
            seller_record_id: sellerRecordId,
            seller_id: sellerId,
            product_name: product.product_name,
            brand: product.brand,
            sku: canonicalSku,
            size,
            vat_type: vatType,
            selling_price_suggested: price,
            quantity
          }
        });
      }

      results.push({
        index,
        status: existing ? "updated" : "created",
        id: written?.item?.id || written?.id || existing?.id || null,
        sku: canonicalSku,
        size
      });
    }

    // After the loop, once per pair. A refresh that fails is logged and not
    // thrown: the stock rows are already written, and the next change to
    // that pair refreshes it again.
    for (const pair of touched.values()) {
      await Promise.resolve(refreshStockLevel(pair.sku, pair.size)).catch((err) =>
        logger.error(`Stock level refresh failed for ${pair.sku} ${pair.size}:`, err.message)
      );
    }

    const count = (status) => results.filter((r) => r.status === status).length;

    return ok(res, {
      created_count: count("created"),
      updated_count: count("updated"),
      skipped_count: count("skipped"),
      items: results
    });
  }));

  router.patch("/inventory/:id", wrap(async (req, res) => {
    const id = text(req.params.id);
    const patch = {};

    if (req.body?.price !== undefined) {
      const price = Number(req.body.price);

      if (!Number.isFinite(price) || price <= 0) return fail(res, 400, "price must be higher than 0");

      patch.selling_price_suggested = price;
    }

    if (req.body?.quantity !== undefined) {
      const quantity = Number(req.body.quantity);

      if (!Number.isInteger(quantity) || quantity < 0 || quantity > 999) {
        return fail(res, 400, "quantity must be a whole number from 0 to 999");
      }

      patch.quantity = quantity;
    }

    if (!Object.keys(patch).length) return fail(res, 400, "Send price, quantity or both");

    // Filtered on the owner as well as the id, and answered the same way when
    // either misses. Telling a caller "exists but is not yours" would confirm
    // somebody else's listing id.
    if (!UUID.test(id)) return fail(res, 404, "Listing not found");

    const row = await store.updateInventoryById({
      mode: req.api.mode,
      sellerRecordId: req.api.sellerRecordId,
      id,
      patch: { ...patch, updated_at: new Date().toISOString() }
    });

    if (!row) return fail(res, 404, "Listing not found");

    if (req.api.mode === "live") {
      await Promise.resolve(refreshStockLevel(row.sku, row.size)).catch((err) =>
        logger.error(`Stock level refresh failed for ${row.sku} ${row.size}:`, err.message)
      );
    }

    return ok(res, { item: serializeInventoryRow(row) });
  }));

  router.delete("/inventory", wrap(async (req, res) => {
    const requested = Array.isArray(req.body?.ids)
      ? req.body.ids.map(text)
      : req.body?.id !== undefined
        ? [text(req.body.id)]
        : [];

    if (!requested.length) return fail(res, 400, "Send id or ids");
    if (requested.length > MAX_BATCH) return fail(res, 400, `At most ${MAX_BATCH} ids per request`);

    const valid = [...new Set(requested.filter((id) => UUID.test(id)))];

    const deleted = valid.length
      ? await store.deleteInventoryByIds({
          mode: req.api.mode,
          sellerRecordId: req.api.sellerRecordId,
          ids: valid
        })
      : [];

    if (req.api.mode === "live") {
      const pairs = new Map(deleted.map((row) => [`${row.sku}|${row.size}`, row]));

      for (const row of pairs.values()) {
        await Promise.resolve(refreshStockLevel(row.sku, row.size)).catch((err) =>
          logger.error(`Stock level refresh failed for ${row.sku} ${row.size}:`, err.message)
        );
      }
    }

    const deletedIds = new Set(deleted.map((row) => row.id));

    return ok(res, {
      deleted_count: deleted.length,
      not_found: [...new Set(requested)].filter((id) => !deletedIds.has(id))
    });
  }));

  /* ---------------- want-to-buys ---------------- */

  const wtbStoreFor = (mode) => wantToBuyStores[mode];

  router.post("/want-to-buys", wrap(async (req, res) => {
    const checked = validateWantToBuyInput(req.body, { normalizeSize, isUsableSize, sizeError });

    if (checked.reason) return fail(res, 400, checked.reason);

    const { sku, size, inventoryType, maxPrice } = checked.item;
    const { mode, sellerRecordId, sellerId } = req.api;

    // Asked up front and in both modes. The live creator refuses this too,
    // but as a bare error that would surface here as a 500 - and a test key
    // has to be told exactly what a live key would be told.
    const refusal = await b2bRefusal(inventoryType, sellerRecordId);

    if (refusal) return fail(res, 400, refusal);

    let created;

    if (mode === "live") {
      try {
        const recordId = await createLiveWantToBuy({ sellerRecordId, sellerId, sku, size, maxPrice, inventoryType });

        created = await wtbStoreFor("live").find({ sellerRecordId, sellerId, id: recordId });
      } catch (err) {
        // The creator marks the errors that are the caller's to fix.
        if (err?.statusCode && err.statusCode < 500) return fail(res, err.statusCode, err.message);

        throw err;
      }
    } else {
      let product;

      try {
        product = await resolveProduct(sku, null);
      } catch (err) {
        if (err?.isUnknownSku) return fail(res, 404, `SKU "${sku}" could not be found in our catalogue`);
        if (err?.isLookupFailure) return fail(res, 503, "Product lookup temporarily unavailable, try again");

        throw err;
      }

      created = await wtbStoreFor("test").insert({
        seller_record_id: sellerRecordId,
        seller_id: sellerId,
        sku: text(product.matched_sku || sku).toUpperCase(),
        size,
        product_name: product.product_name,
        brand: product.brand,
        max_price: maxPrice,
        inventory_type: inventoryType
      });
    }

    if (!created) {
      // Created, and then not readable back as ours. Should not happen, and
      // answering "failed" would invite a retry that places a second one.
      return fail(res, 500, "The want-to-buy was placed but could not be read back. Do not retry; list your want-to-buys instead.");
    }

    return ok(res, { item: serializeWantToBuy(created) });
  }));

  router.get("/want-to-buys", wrap(async (req, res) => {
    const { page, perPage, from, to } = parsePagination(req.query);
    const status = text(req.query.status).toLowerCase() || "all";
    const sku = text(req.query.sku).toUpperCase();

    if (!["open", "closed", "all"].includes(status)) {
      return fail(res, 400, "status must be open, closed or all");
    }

    const rows = (await wtbStoreFor(req.api.mode).list({
      sellerRecordId: req.api.sellerRecordId,
      sellerId: req.api.sellerId
    }))
      .filter((row) => !sku || text(row.sku).toUpperCase() === sku)
      .filter((row) => status === "all" || (status === "open") === isOpenWantToBuy(row))
      .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));

    return ok(res, {
      items: rows.slice(from, to + 1).map(serializeWantToBuy),
      pagination: paginationBlock({ page, perPage, total: rows.length })
    });
  }));

  router.get("/want-to-buys/:id", wrap(async (req, res) => {
    const row = await findOwnWantToBuy(req);

    if (!row) return fail(res, 404, "Want-to-buy not found");

    return ok(res, { item: serializeWantToBuy(row) });
  }));

  router.delete("/want-to-buys/:id", wrap(async (req, res) => {
    const row = await findOwnWantToBuy(req);

    if (!row) return fail(res, 404, "Want-to-buy not found");

    if (text(row.fulfillment_status) === "Cancelled" || text(row.purchase_status) === "Cancelled") {
      return ok(res, { item: serializeWantToBuy(row), already_cancelled: true });
    }

    // Only while nobody has agreed to anything. After that a seller is
    // shipping, or money is due, and walking away is a conversation rather
    // than an API call.
    if (!isOpenWantToBuy(row) || text(row.payment_status) === "Paid") {
      return fail(res, 409, `This want-to-buy can no longer be cancelled (${row.fulfillment_status || "in progress"}). Contact support.`);
    }

    const cancelled = await wtbStoreFor(req.api.mode).cancel({ id: row.id });

    return ok(res, { item: serializeWantToBuy(cancelled || { ...row, purchase_status: "Cancelled", fulfillment_status: "Cancelled" }) });
  }));

  async function findOwnWantToBuy(req) {
    const id = text(req.params.id);
    const valid = req.api.mode === "live" ? /^rec[A-Za-z0-9]{14}$/.test(id) : UUID.test(id);

    if (!valid) return null;

    return wtbStoreFor(req.api.mode).find({
      sellerRecordId: req.api.sellerRecordId,
      sellerId: req.api.sellerId,
      id
    });
  }

  /* ---------------- sales ---------------- */

  /*
   * Oldest change first, and >= on updated_since.
   *
   * Ascending is what lets a poller walk forward: take next_updated_since
   * from the last page and ask again. Greater-or-equal rather than greater,
   * because two rows can change in the same second and a strict comparison
   * silently drops the second one - the caller de-duplicates on id and
   * updated_at instead, which costs them nothing.
   */
  router.get("/sales", wrap(async (req, res) => {
    const { page, perPage, from, to } = parsePagination(req.query);
    const role = text(req.query.role).toLowerCase() || "all";
    const status = text(req.query.status).toLowerCase() || "all";
    const updatedSinceRaw = text(req.query.updated_since);

    if (!["sold", "bought", "all"].includes(role)) return fail(res, 400, "role must be sold, bought or all");
    if (!["active", "cancelled", "all"].includes(status)) return fail(res, 400, "status must be active, cancelled or all");

    let updatedSince = null;

    if (updatedSinceRaw) {
      const parsed = Date.parse(updatedSinceRaw);

      if (!Number.isFinite(parsed)) {
        return fail(res, 400, "updated_since must be an ISO-8601 date, for example 2026-09-01T00:00:00Z");
      }

      updatedSince = new Date(parsed).toISOString();
    }

    let rows;
    let total;

    if (req.api.mode === "test") {
      const all = sampleSales(req.api.sellerRecordId)
        .filter((row) => !updatedSince || row.updated_at >= updatedSince)
        .filter((row) => role === "all" || row.role === role)
        .filter((row) => status === "all" || row.status === status);

      rows = all.slice(from, to + 1);
      total = all.length;
    } else {
      ({ rows, total } = await salesStore.listForParty({
        partyRecordId: req.api.sellerRecordId,
        updatedSince,
        role: role === "all" ? null : role,
        status: status === "all" ? null : status,
        from,
        to
      }));
    }

    const last = rows[rows.length - 1];

    return ok(
      res,
      {
        items: rows.map(serializeSale),
        pagination: paginationBlock({ page, perPage, total })
      },
      { meta: { next_updated_since: last ? new Date(last.updated_at).toISOString() : updatedSince } }
    );
  }));

  async function findOwnSale(req) {
    const id = text(req.params.id);

    if (!UUID.test(id)) return null;

    return req.api.mode === "test"
      ? sampleSales(req.api.sellerRecordId).find((sale) => sale.id === id) || null
      : salesStore.findForParty({ partyRecordId: req.api.sellerRecordId, id });
  }

  router.get("/sales/:id", wrap(async (req, res) => {
    const row = await findOwnSale(req);

    if (!row) return fail(res, 404, "Sale not found");

    return ok(res, { item: serializeSale(row) });
  }));

  /* ---------------- labels ---------------- */

  /*
   * The label PDF, streamed through us.
   *
   * Never the stored URL. Airtable's attachment links expire within hours,
   * and our permanent copies sit on a public address made of the order
   * number - sequential, so handing that out would hand out every other
   * buyer's name and address with it. Behind the key, only the seller who
   * ships the pair ever sees it.
   */
  router.get("/sales/:id/label", wrap(async (req, res) => {
    const sale = await findOwnSale(req);

    if (!sale) return fail(res, 404, "Sale not found");
    if (sale.role !== "sold") return fail(res, 404, "Labels are only available to the seller shipping the pair");

    let file;

    if (req.api.mode === "test") {
      if (!sale.has_label) return fail(res, 404, "No label yet", { code: "label_not_ready" });

      file = { buffer: SAMPLE_LABEL_PDF };
    } else {
      const source = await labels.findSource({ sourceType: sale.source_type, recordId: sale.source_record_id });
      const url = source ? labelUrlOf(source, sale.source_type) : "";

      if (!url) return fail(res, 404, "No label yet", { code: "label_not_ready" });

      file = await labels.fetchFile(url);

      if (!file?.ok) return fail(res, 502, "The label could not be retrieved right now. Try again shortly.");
    }

    const name = `${text(sale.reference || sale.id).replace(/[^A-Za-z0-9_-]+/g, "-")}-label.pdf`;

    res.set("Content-Type", "application/pdf");
    res.set("Content-Disposition", `attachment; filename="${name}"`);
    res.set("Cache-Control", "no-store");

    return res.send(file.buffer);
  }));

  /*
   * Ask for the label, with the dashboard's own rules.
   *
   * Only while the deal is Allocated, which is the one state in which the
   * Confirmed tabs show the button; and for a Member WTB only once the buyer
   * has paid, for the same reason the dashboard hides it until then. Read
   * fresh from Airtable rather than from the feed, which can be minutes
   * behind: a second request on a store order lands a second request in
   * that store's channel.
   */
  router.post("/sales/:id/request-label", wrap(async (req, res) => {
    const sale = await findOwnSale(req);

    if (!sale) return fail(res, 404, "Sale not found");
    if (sale.role !== "sold") return fail(res, 404, "Only the seller shipping the pair can request its label");

    if (req.api.mode === "test") {
      // Simulated, so the happy path can be built without a real parcel.
      return ok(res, { requested: true, label_available: false, simulated: true });
    }

    const source = await labels.findSource({ sourceType: sale.source_type, recordId: sale.source_record_id });

    if (!source) return fail(res, 404, "Sale not found");

    const f = source.fields || {};
    const fulfilment = text(f["Fulfillment Status"]);

    if (labelUrlOf(source, sale.source_type)) {
      return fail(res, 409, "A label is already available for this sale", { code: "label_available" });
    }

    if (fulfilment !== "Allocated") {
      return fail(res, 409, `A label cannot be requested while the deal is ${fulfilment || "in this state"}`, {
        code: "not_requestable",
        fulfillment_status: fulfilment || null
      });
    }

    if (sale.source_type === "member_wtb" && !["Paid", "Trusted"].includes(text(f["Payment Status"]))) {
      return fail(res, 409, "The buyer has not paid yet. The label can be requested once they have.", {
        code: "awaiting_payment"
      });
    }

    try {
      if (sale.source_type === "member_wtb") {
        await labels.requestForWantToBuy(sale.source_record_id);
      } else {
        await labels.requestForOrder(sale.source_record_id);
      }
    } catch (err) {
      if (err?.statusCode && err.statusCode < 500) return fail(res, err.statusCode, err.message);

      logger.error(`Label request for sale ${sale.id} failed:`, err?.message);

      return fail(res, 502, "The label request failed. Contact support if this keeps happening.");
    }

    // Marketplace labels arrive during the request itself, so it is worth
    // looking once more before telling the caller to wait.
    const after = await labels.findSource({ sourceType: sale.source_type, recordId: sale.source_record_id });

    return ok(res, {
      requested: true,
      label_available: Boolean(after && labelUrlOf(after, sale.source_type)),
      tracking_number: text(after?.fields?.["Tracking Number"]) || null
    });
  }));

  /* ---------------- webhooks ---------------- */

  // Webhooks are set up in the dashboard; the key may only ask for a test
  // event, so a developer can check their receiver from their own code.
  router.post("/webhooks/test", wrap(async (req, res) => {
    const hooks = await webhookStore.activeWebhooksWithSecret(req.api.sellerRecordId);

    if (!hooks.length) {
      return fail(res, 404, "No active webhooks. Add one in your dashboard under API Access.");
    }

    const results = [];

    for (const hook of hooks) {
      results.push(await sendTestEvent({ hook, sellerRecordId: req.api.sellerRecordId, type: req.body?.type, send: sendWebhookImpl }));
    }

    return ok(res, { items: results });
  }));

  router.use((req, res) => fail(res, 404, `No such endpoint: ${req.method} /api/v1${req.path}`));

  return router;
}

/* ---------------- key management ---------------- */

/*
 * Creating, listing and revoking keys - called by the dashboards, never by a
 * key. A key that could mint keys would make revoking one pointless.
 *
 * deps:
 *   store
 *   identify(req) -> { sellerRecordId } or { status, error }
 *   lookupSellerId(sellerRecordId) -> "SE-00001" or null
 */
export function createApiKeyRouter({ store, identify, lookupSellerId, webhookStore, send = sendWebhook }) {
  const router = express.Router();

  const who = (req, res) => {
    const identity = identify(req);

    if (!identity?.sellerRecordId) {
      fail(res, identity?.status || 401, identity?.error || "Not signed in");

      return null;
    }

    return identity.sellerRecordId;
  };

  const serializeKey = (row) => ({
    id: row.id,
    name: row.name || null,
    mode: row.mode,
    key_prefix: row.key_prefix,
    created_at: row.created_at,
    last_used_at: row.last_used_at || null,
    revoked_at: row.revoked_at || null
  });

  router.get("/keys", wrap(async (req, res) => {
    const sellerRecordId = who(req, res);

    if (!sellerRecordId) return;

    const rows = await store.listKeys(sellerRecordId);

    return ok(res, { items: rows.map(serializeKey) });
  }));

  router.post("/keys", wrap(async (req, res) => {
    const sellerRecordId = who(req, res);

    if (!sellerRecordId) return;

    const mode = text(req.body?.mode).toLowerCase();

    if (!API_KEY_MODES.includes(mode)) return fail(res, 400, "mode must be live or test");

    const name = text(req.body?.name).slice(0, 60) || null;

    if ((await store.countActiveKeys(sellerRecordId)) >= MAX_ACTIVE_KEYS) {
      return fail(res, 400, `At most ${MAX_ACTIVE_KEYS} active keys. Revoke one first.`);
    }

    const sellerId = await lookupSellerId(sellerRecordId);

    if (!sellerId) return fail(res, 404, "Seller profile not found");

    const generated = generateApiKey(mode);

    const row = await store.insertKey({
      seller_record_id: sellerRecordId,
      seller_id: sellerId,
      name,
      mode,
      key_prefix: generated.prefix,
      key_hash: generated.hash
    });

    // The only time the key itself ever leaves this server.
    return ok(res, { key: generated.key, ...serializeKey(row) });
  }));

  router.post("/keys/:id/revoke", wrap(async (req, res) => {
    const sellerRecordId = who(req, res);

    if (!sellerRecordId) return;

    const id = text(req.params.id);

    if (!UUID.test(id)) return fail(res, 404, "Key not found");

    const row = await store.revokeKey({ id, sellerRecordId, at: new Date().toISOString() });

    if (!row) return fail(res, 404, "Key not found");

    return ok(res, serializeKey(row));
  }));

  /* ---------------- webhooks ---------------- */

  const serializeWebhook = (row) => ({
    id: row.id,
    url: row.url,
    events: row.events || WEBHOOK_EVENTS,
    active: !row.disabled_at,
    disabled_reason: row.disabled_reason || null,
    consecutive_failures: Number(row.consecutive_failures || 0),
    last_success_at: row.last_success_at || null,
    last_failure_at: row.last_failure_at || null,
    created_at: row.created_at
  });

  router.get("/webhooks", wrap(async (req, res) => {
    const sellerRecordId = who(req, res);

    if (!sellerRecordId) return;

    return ok(res, { items: (await webhookStore.listWebhooks(sellerRecordId)).map(serializeWebhook) });
  }));

  router.post("/webhooks", wrap(async (req, res) => {
    const sellerRecordId = who(req, res);

    if (!sellerRecordId) return;

    const urlReason = validateWebhookUrl(req.body?.url);

    if (urlReason) return fail(res, 400, urlReason);

    const requested = req.body?.events === undefined ? WEBHOOK_EVENTS : req.body.events;

    if (!Array.isArray(requested) || !requested.length || requested.some((e) => !WEBHOOK_EVENTS.includes(e))) {
      return fail(res, 400, `events must be a non-empty list of: ${WEBHOOK_EVENTS.join(", ")}`);
    }

    if ((await webhookStore.countActiveWebhooks(sellerRecordId)) >= MAX_ACTIVE_WEBHOOKS) {
      return fail(res, 400, `At most ${MAX_ACTIVE_WEBHOOKS} active webhooks. Remove one first.`);
    }

    const secret = generateWebhookSecret();

    const row = await webhookStore.insertWebhook({
      seller_record_id: sellerRecordId,
      url: text(req.body.url),
      secret,
      events: [...new Set(requested)]
    });

    // Shown once. It is what the receiver checks every signature against.
    return ok(res, { secret, ...serializeWebhook(row) });
  }));

  const ownWebhook = async (req, res) => {
    const sellerRecordId = who(req, res);

    if (!sellerRecordId) return null;

    const id = text(req.params.id);
    const row = UUID.test(id) ? await webhookStore.findWebhookWithSecret({ id, sellerRecordId }) : null;

    if (!row) {
      fail(res, 404, "Webhook not found");

      return null;
    }

    return { sellerRecordId, row };
  };

  router.delete("/webhooks/:id", wrap(async (req, res) => {
    const found = await ownWebhook(req, res);

    if (!found) return;

    await webhookStore.deleteWebhook({ id: found.row.id, sellerRecordId: found.sellerRecordId });

    return ok(res, { deleted: true });
  }));

  router.post("/webhooks/:id/enable", wrap(async (req, res) => {
    const found = await ownWebhook(req, res);

    if (!found) return;

    await webhookStore.updateWebhook(found.row.id, { disabled_at: null, disabled_reason: null, consecutive_failures: 0 });

    return ok(res, serializeWebhook({ ...found.row, disabled_at: null, disabled_reason: null, consecutive_failures: 0 }));
  }));

  router.get("/webhooks/:id/deliveries", wrap(async (req, res) => {
    const found = await ownWebhook(req, res);

    if (!found) return;

    return ok(res, { items: await webhookStore.recentDeliveries({ webhookId: found.row.id }) });
  }));

  router.post("/webhooks/:id/test", wrap(async (req, res) => {
    const found = await ownWebhook(req, res);

    if (!found) return;

    return ok(res, await sendTestEvent({ hook: found.row, sellerRecordId: found.sellerRecordId, type: req.body?.type, send }));
  }));

  return router;
}

/*
 * A signed sample event, sent now, answered with what came back.
 *
 * Marked test: true, carrying one of the sample sales, so a receiver can be
 * built and its signature check proven without waiting for a real sale.
 * Sent synchronously on purpose - "did my endpoint accept it" is the whole
 * question, and it deserves an answer in the same call.
 */
async function sendTestEvent({ hook, sellerRecordId, type, send }) {
  const eventType = WEBHOOK_EVENTS.includes(type) ? type : "sale.created";
  const payload = buildEventPayload({
    eventId: crypto.randomUUID(),
    type: eventType,
    item: serializeSale(sampleSales(sellerRecordId)[0]),
    createdAt: new Date().toISOString(),
    test: true
  });

  const outcome = await send({ url: hook.url, secret: hook.secret, payload, deliveryId: crypto.randomUUID() });

  return {
    webhook_id: hook.id,
    event_type: eventType,
    delivered: Boolean(outcome.ok),
    status_code: outcome.statusCode ?? null,
    error: outcome.ok ? null : outcome.error || null
  };
}

export { sendTestEvent };

/*
 * JSON errors for both routers, including the ones express.json() raises
 * before a router is even reached. Without this a malformed body gets
 * Express's HTML error page, which no integration can read.
 */
export function sellerApiErrorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  if (err?.type === "entity.parse.failed") {
    return fail(res, 400, "Request body is not valid JSON");
  }

  if (err?.type === "entity.too.large") {
    return fail(res, 413, "Request body is too large");
  }

  console.error(`Seller API error on ${req.method} ${req.originalUrl}:`, err);

  return fail(res, 500, "Something went wrong on our side. Try again, and contact support if it keeps happening.");
}

/* ---------------- storage ---------------- */

/*
 * Live want-to-buys, read from Airtable.
 *
 * Always through select() with a formula, never find(). find() on a table
 * resolves a record id from anywhere in the base, so find(someSellerId) on
 * Member WTBs quietly returns the seller - the trap behind three silent
 * failures in one day. A formula only ever returns rows of the table asked.
 *
 * Ownership rides on the SE code, because Airtable resolves a linked field
 * to the linked record's primary field inside a formula, and for Sellers
 * Database that is the Seller ID. The record id would never match there.
 */
const WTB_FIELDS = [
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
  "Date"
];

const INVENTORY_TYPE_BY_LABEL = { "B2B Only": "b2b", "Margin Only": "private", "All Inventory": "all" };

const formulaText = (value) => text(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");

function fromAirtableWantToBuy(record) {
  const f = record.fields || {};
  const first = (value) => (Array.isArray(value) ? value[0] : value);

  return {
    id: record.id,
    wtb_id: text(first(f["Member WTB ID"])) || null,
    sku: text(f["SKU"]),
    size: text(f["Size"]),
    product_name: text(f["Product Name"]) || null,
    brand: text(f["Brand"]) || null,
    max_price: f["Max Price"] === undefined || f["Max Price"] === null ? null : Number(f["Max Price"]),
    inventory_type: INVENTORY_TYPE_BY_LABEL[text(f["Buying Inventory Filter"])] || "all",
    purchase_status: text(f["Purchase Status"]) || null,
    fulfillment_status: text(f["Fulfillment Status"]) || null,
    payment_status: text(f["Payment Status"]) || null,
    created_at: text(f["Date"]) || record._rawJson?.createdTime || null
  };
}

export function createAirtableWantToBuyStore({ airtable, table }) {
  const ownedBy = (sellerId) => `FIND('${formulaText(sellerId)}', ARRAYJOIN({Buyer Seller ID}))`;

  return {
    async list({ sellerId }) {
      if (!sellerId) return [];

      const records = await airtable(table)
        .select({ fields: WTB_FIELDS, filterByFormula: ownedBy(sellerId) })
        .all();

      return records.map(fromAirtableWantToBuy);
    },

    async find({ sellerId, id }) {
      if (!sellerId || !/^rec[A-Za-z0-9]{14}$/.test(id)) return null;

      const records = await airtable(table)
        .select({
          fields: WTB_FIELDS,
          filterByFormula: `AND(RECORD_ID() = '${formulaText(id)}', ${ownedBy(sellerId)})`,
          maxRecords: 1
        })
        .firstPage();

      return records[0] ? fromAirtableWantToBuy(records[0]) : null;
    },

    // What the dashboard's own Cancel button writes, and nothing more.
    async cancel({ id }) {
      const updated = await airtable(table).update(id, {
        "Purchase Status": "Cancelled",
        "Fulfillment Status": "Cancelled"
      });

      return fromAirtableWantToBuy(updated);
    }
  };
}

const WTB_TEST_TABLE = "api_test_want_to_buys";

const WTB_TEST_COLUMNS =
  "id, seller_record_id, seller_id, sku, size, product_name, brand, max_price, inventory_type, purchase_status, fulfillment_status, payment_status, created_at";

export function createSupabaseTestWantToBuyStore(supabase) {
  return {
    async list({ sellerRecordId }) {
      return (
        unwrap(
          await supabase
            .from(WTB_TEST_TABLE)
            .select(WTB_TEST_COLUMNS)
            .eq("seller_record_id", sellerRecordId)
            .order("created_at", { ascending: false })
        ) || []
      );
    },

    async find({ sellerRecordId, id }) {
      if (!UUID.test(id)) return null;

      return unwrap(
        await supabase
          .from(WTB_TEST_TABLE)
          .select(WTB_TEST_COLUMNS)
          .eq("id", id)
          .eq("seller_record_id", sellerRecordId)
          .maybeSingle()
      );
    },

    async insert(row) {
      return unwrap(await supabase.from(WTB_TEST_TABLE).insert(row).select(WTB_TEST_COLUMNS).single());
    },

    async cancel({ id }) {
      return unwrap(
        await supabase
          .from(WTB_TEST_TABLE)
          .update({
            purchase_status: "Cancelled",
            fulfillment_status: "Cancelled",
            updated_at: new Date().toISOString()
          })
          .eq("id", id)
          .select(WTB_TEST_COLUMNS)
          .single()
      );
    }
  };
}

const TABLE = { live: "consignment_inventory", test: "api_test_inventory" };

const INVENTORY_COLUMNS =
  "id, seller_record_id, seller_id, product_name, brand, sku, size, vat_type, selling_price_suggested, quantity, created_at, updated_at";

const KEY_COLUMNS = "id, seller_record_id, seller_id, name, mode, key_prefix, created_at, last_used_at, revoked_at";

function tableFor(mode) {
  const table = TABLE[mode];

  if (!table) throw new Error(`Unknown key mode: ${mode}`);

  return table;
}

function unwrap({ data, error }) {
  if (error) throw error;

  return data;
}

export function createSupabaseApiStore(supabase) {
  return {
    async findActiveKeyByHash(hash) {
      return unwrap(
        await supabase
          .from("api_keys")
          .select(KEY_COLUMNS)
          .eq("key_hash", hash)
          .is("revoked_at", null)
          .maybeSingle()
      );
    },

    async touchKey(id, at) {
      unwrap(await supabase.from("api_keys").update({ last_used_at: at }).eq("id", id));
    },

    async listKeys(sellerRecordId) {
      return unwrap(
        await supabase
          .from("api_keys")
          .select(KEY_COLUMNS)
          .eq("seller_record_id", sellerRecordId)
          .order("created_at", { ascending: false })
      );
    },

    async countActiveKeys(sellerRecordId) {
      const { count, error } = await supabase
        .from("api_keys")
        .select("id", { count: "exact", head: true })
        .eq("seller_record_id", sellerRecordId)
        .is("revoked_at", null);

      if (error) throw error;

      return count || 0;
    },

    async insertKey(row) {
      return unwrap(await supabase.from("api_keys").insert(row).select(KEY_COLUMNS).single());
    },

    async revokeKey({ id, sellerRecordId, at }) {
      return unwrap(
        await supabase
          .from("api_keys")
          .update({ revoked_at: at })
          .eq("id", id)
          .eq("seller_record_id", sellerRecordId)
          .is("revoked_at", null)
          .select(KEY_COLUMNS)
          .maybeSingle()
      );
    },

    async listInventory({ mode, sellerRecordId, sku, inStock, from, to }) {
      let query = supabase
        .from(tableFor(mode))
        .select(INVENTORY_COLUMNS, { count: "exact" })
        .eq("seller_record_id", sellerRecordId);

      if (sku) query = query.eq("sku", sku);
      if (inStock) query = query.gt("quantity", 0);

      const { data, error, count } = await query
        .order("sku", { ascending: true })
        .order("size", { ascending: true })
        .range(from, to);

      if (error) throw error;

      return { rows: data || [], total: count || 0 };
    },

    async findInventoryBySkuSize({ mode, sellerRecordId, sku, size }) {
      return unwrap(
        await supabase
          .from(tableFor(mode))
          .select(INVENTORY_COLUMNS)
          .eq("seller_record_id", sellerRecordId)
          .eq("sku", sku)
          .eq("size", size)
          .maybeSingle()
      );
    },

    async upsertTestInventoryRow({ existing, row }) {
      if (existing) {
        return unwrap(
          await supabase
            .from(TABLE.test)
            .update({ ...row, updated_at: new Date().toISOString() })
            .eq("id", existing.id)
            .select(INVENTORY_COLUMNS)
            .single()
        );
      }

      return unwrap(await supabase.from(TABLE.test).insert(row).select(INVENTORY_COLUMNS).single());
    },

    async updateInventoryById({ mode, sellerRecordId, id, patch }) {
      return unwrap(
        await supabase
          .from(tableFor(mode))
          .update(patch)
          .eq("id", id)
          .eq("seller_record_id", sellerRecordId)
          .select(INVENTORY_COLUMNS)
          .maybeSingle()
      );
    },

    async deleteInventoryByIds({ mode, sellerRecordId, ids }) {
      return (
        unwrap(
          await supabase
            .from(tableFor(mode))
            .delete()
            .eq("seller_record_id", sellerRecordId)
            .in("id", ids)
            .select("id, sku, size")
        ) || []
      );
    }
  };
}
