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
 * "kc_test_" and "kc_live_" are readable at a glance in a config file, which
 * is the cheapest protection there is against someone shipping the test key
 * to production and wondering why nothing sells.
 */
export function generateApiKey(mode) {
  if (!API_KEY_MODES.includes(mode)) {
    throw new Error(`Unknown key mode: ${mode}`);
  }

  const key = `kc_${mode}_${crypto.randomBytes(KEY_RANDOM_BYTES).toString("base64url")}`;

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

  return /^kc_(live|test)_[A-Za-z0-9_-]{20,}$/.test(match[1]) ? match[1] : null;
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
export function createApiKeyRouter({ store, identify, lookupSellerId }) {
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

  return router;
}

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
