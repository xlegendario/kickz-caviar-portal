// lib/sellerApiWebhooks.js
//
// Sale and want-to-buy events pushed to a seller's own endpoint.
//
// The feeds are the guarantee and this is the courtesy: every event sent here
// is also in GET /api/v1/sales or /want-to-buys, so a delivery that never arrives costs a
// partner a few minutes, not a sale. That is why this can afford to give up
// on an endpoint after a day of retries, and why it never tries to be clever
// about exactly-once. A receiver de-duplicates on the event id.

import crypto from "crypto";
import dns from "dns";
import net from "net";

// Consignment: sale.* and label.ready, for the seller shipping the pair.
// Buying: want_to_buy.*, for the buyer who placed it.
export const WEBHOOK_EVENTS = [
  "sale.created",
  "sale.updated",
  "sale.cancelled",
  "label.ready",
  "want_to_buy.updated",
  "want_to_buy.cancelled"
];

// After the first attempt: a minute, five, half an hour, two hours, six,
// twelve. Roughly a day in total, which covers a deploy, an outage and a
// weekend server nobody is watching - and then the feed takes over.
export const RETRY_DELAYS_MS = [60_000, 300_000, 1_800_000, 7_200_000, 21_600_000, 43_200_000];

export const MAX_ACTIVE_WEBHOOKS = 5;
export const DISABLE_AFTER_FAILED_DELIVERIES = 5;

const SIGNATURE_TOLERANCE_SECONDS = 300;
const text = (value) => (value === null || value === undefined ? "" : String(value).trim());

/* ---------------- signing ---------------- */

export function generateWebhookSecret() {
  return `whsec_${crypto.randomBytes(32).toString("base64url")}`;
}

/*
 * HMAC-SHA256 over "<timestamp>.<body>".
 *
 * The timestamp is inside the signature so a captured delivery cannot be
 * replayed tomorrow: the receiver rejects anything older than five minutes,
 * and changing the timestamp breaks the signature.
 */
export function signPayload({ secret, timestamp, body }) {
  return crypto.createHmac("sha256", String(secret)).update(`${timestamp}.${body}`).digest("hex");
}

export function signatureHeaders({ secret, body, eventType, deliveryId, now = Date.now() }) {
  const timestamp = Math.floor(now / 1000);

  return {
    "Content-Type": "application/json",
    // Brand-neutral, for the same reason as the key prefix: a Lojiq store's
    // receiver should not be reading another company's initials.
    "User-Agent": "Seller-API-Webhooks/1",
    "X-Webhook-Event": eventType,
    "X-Webhook-Delivery": deliveryId,
    "X-Webhook-Timestamp": String(timestamp),
    "X-Webhook-Signature": `sha256=${signPayload({ secret, timestamp, body })}`
  };
}

// What a receiver runs. Here so the documentation and the tests use the very
// same check the sender is built against.
export function verifyWebhookSignature({ secret, body, timestamp, signature, now = Date.now() }) {
  const age = Math.abs(Math.floor(now / 1000) - Number(timestamp));

  if (!Number.isFinite(age) || age > SIGNATURE_TOLERANCE_SECONDS) return false;

  const expected = Buffer.from(`sha256=${signPayload({ secret, timestamp, body })}`);
  const given = Buffer.from(String(signature || ""));

  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

/* ---------------- where we are willing to send ---------------- */

/*
 * The portal calls whatever address a seller types in. Without this, a
 * webhook pointed at localhost or 10.0.0.1 would make our own server probe
 * our own network on somebody else's behalf, and read the answers back in
 * the delivery log.
 */
export function isPrivateAddress(address) {
  const ip = text(address).replace(/^\[|\]$/g, "");

  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);

    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }

  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);

    if (mapped) return isPrivateAddress(mapped[1]);

    return lower === "::" || lower === "::1" || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower);
  }

  return false;
}

export function validateWebhookUrl(raw) {
  const value = text(raw);

  if (!value) return "url is required";
  if (value.length > 500) return "url is too long";

  let url;

  try {
    url = new URL(value);
  } catch {
    return "url is not a valid address";
  }

  if (url.protocol !== "https:") return "url must use https";
  if (url.username || url.password) return "url must not contain a username or password";

  const host = url.hostname.toLowerCase();

  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) {
    return "url must be a public address";
  }

  if (isPrivateAddress(host)) return "url must be a public address";

  return null;
}

// Checked again at send time, on what the name resolves to now: a hostname
// that was public when it was saved can point somewhere else later.
async function resolvesToPublic(hostname, lookup) {
  if (net.isIP(hostname.replace(/^\[|\]$/g, ""))) return !isPrivateAddress(hostname);

  try {
    const addresses = await lookup(hostname, { all: true });

    return addresses.length > 0 && addresses.every((entry) => !isPrivateAddress(entry.address));
  } catch {
    return false;
  }
}

/* ---------------- events ---------------- */

export function buildEventPayload({ eventId, type, item, createdAt, test = false }) {
  return {
    id: eventId,
    type,
    created_at: createdAt,
    ...(test ? { test: true } : {}),
    data: { item }
  };
}

/*
 * One delivery per event per webhook that wants it.
 *
 * events: [{ type, partyRecordId, item }]
 */
export async function enqueueEvents({ events, store, now = () => new Date() }) {
  if (!events.length) return 0;

  const parties = [...new Set(events.map((e) => e.partyRecordId))];
  const webhooks = await store.activeWebhooksFor(parties);

  if (!webhooks.length) return 0;

  const createdAt = now().toISOString();
  const deliveries = [];

  for (const event of events) {
    const eventId = crypto.randomUUID();
    const payload = buildEventPayload({ eventId, type: event.type, item: event.item, createdAt });

    for (const hook of webhooks) {
      if (hook.seller_record_id !== event.partyRecordId) continue;
      if (!(hook.events || WEBHOOK_EVENTS).includes(event.type)) continue;

      deliveries.push({
        webhook_id: hook.id,
        event_id: eventId,
        event_type: event.type,
        payload,
        next_attempt_at: createdAt
      });
    }
  }

  if (deliveries.length) await store.insertDeliveries(deliveries);

  return deliveries.length;
}

/* ---------------- sending ---------------- */

export async function sendWebhook({
  url,
  secret,
  payload,
  deliveryId,
  fetchImpl = fetch,
  lookup = dns.promises.lookup,
  timeoutMs = 10_000,
  now = Date.now()
}) {
  const reason = validateWebhookUrl(url);

  if (reason) return { ok: false, error: reason };

  if (!(await resolvesToPublic(new URL(url).hostname, lookup))) {
    return { ok: false, error: "url does not resolve to a public address" };
  }

  const body = JSON.stringify(payload);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: signatureHeaders({ secret, body, eventType: payload.type, deliveryId, now }),
      body,
      // A redirect would send the signed body somewhere nobody configured.
      redirect: "manual",
      signal: controller.signal
    });

    return res.status >= 200 && res.status < 300
      ? { ok: true, statusCode: res.status }
      : { ok: false, statusCode: res.status, error: `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, error: err?.name === "AbortError" ? "timed out after 10s" : text(err?.message) || "request failed" };
  } finally {
    clearTimeout(timer);
  }
}

/*
 * Drain what is due.
 *
 * A delivery that fails is scheduled again along RETRY_DELAYS_MS; one that
 * runs out of retries is marked failed and counts against its webhook. Five
 * of those in a row turn the webhook off, because an endpoint that has not
 * answered for five straight events over a day is gone, and retrying it
 * forever only spends our time.
 */
export async function deliverDue({ store, send = sendWebhook, now = () => new Date(), limit = 50, logger = console }) {
  const due = await store.dueDeliveries({ at: now().toISOString(), limit });
  const result = { attempted: 0, delivered: 0, retrying: 0, failed: 0 };

  // One copy per webhook for the whole run: each delivery row carries its own
  // snapshot, and two failures in one run must count as two, not as one each.
  const hooks = new Map();

  for (const delivery of due) {
    const hook = delivery.webhook
      ? hooks.get(delivery.webhook.id) || hooks.set(delivery.webhook.id, { ...delivery.webhook }).get(delivery.webhook.id)
      : null;

    if (!hook || hook.disabled_at) {
      await store.updateDelivery(delivery.id, { status: "failed", last_error: "webhook disabled" });
      continue;
    }

    result.attempted += 1;

    const outcome = await send({
      url: hook.url,
      secret: hook.secret,
      payload: delivery.payload,
      deliveryId: delivery.id
    });

    const attempts = delivery.attempts + 1;
    const stamp = now().toISOString();

    if (outcome.ok) {
      result.delivered += 1;

      await store.updateDelivery(delivery.id, {
        status: "delivered",
        attempts,
        last_status_code: outcome.statusCode ?? null,
        last_error: null,
        delivered_at: stamp
      });

      await store.updateWebhook(hook.id, { consecutive_failures: 0, last_success_at: stamp });
      hook.consecutive_failures = 0;
      continue;
    }

    const delay = RETRY_DELAYS_MS[attempts - 1];

    if (delay !== undefined) {
      result.retrying += 1;

      await store.updateDelivery(delivery.id, {
        attempts,
        last_status_code: outcome.statusCode ?? null,
        last_error: text(outcome.error).slice(0, 300),
        next_attempt_at: new Date(now().getTime() + delay).toISOString()
      });

      continue;
    }

    result.failed += 1;

    await store.updateDelivery(delivery.id, {
      status: "failed",
      attempts,
      last_status_code: outcome.statusCode ?? null,
      last_error: text(outcome.error).slice(0, 300)
    });

    const failures = Number(hook.consecutive_failures || 0) + 1;
    const patch = { consecutive_failures: failures, last_failure_at: stamp };

    if (failures >= DISABLE_AFTER_FAILED_DELIVERIES) {
      patch.disabled_at = stamp;
      patch.disabled_reason = `${failures} deliveries in a row failed after every retry`;
      logger.warn?.(`Webhook ${hook.id} disabled: ${patch.disabled_reason}`);
    }

    await store.updateWebhook(hook.id, patch);
    hook.consecutive_failures = failures;
    if (patch.disabled_at) hook.disabled_at = patch.disabled_at;
  }

  return result;
}

/* ---------------- storage ---------------- */

const WEBHOOK_COLUMNS =
  "id, seller_record_id, url, events, consecutive_failures, last_success_at, last_failure_at, disabled_at, disabled_reason, created_at";

function unwrap({ data, error }) {
  if (error) throw error;

  return data;
}

export function createSupabaseWebhookStore(supabase) {
  return {
    async listWebhooks(sellerRecordId) {
      return (
        unwrap(
          await supabase
            .from("api_webhooks")
            .select(WEBHOOK_COLUMNS)
            .eq("seller_record_id", sellerRecordId)
            .order("created_at", { ascending: false })
        ) || []
      );
    },

    async countActiveWebhooks(sellerRecordId) {
      const { count, error } = await supabase
        .from("api_webhooks")
        .select("id", { count: "exact", head: true })
        .eq("seller_record_id", sellerRecordId)
        .is("disabled_at", null);

      if (error) throw error;

      return count || 0;
    },

    async insertWebhook(row) {
      return unwrap(await supabase.from("api_webhooks").insert(row).select(WEBHOOK_COLUMNS).single());
    },

    async findWebhookWithSecret({ id, sellerRecordId }) {
      return unwrap(
        await supabase
          .from("api_webhooks")
          .select(`${WEBHOOK_COLUMNS}, secret`)
          .eq("id", id)
          .eq("seller_record_id", sellerRecordId)
          .maybeSingle()
      );
    },

    async deleteWebhook({ id, sellerRecordId }) {
      return unwrap(
        await supabase
          .from("api_webhooks")
          .delete()
          .eq("id", id)
          .eq("seller_record_id", sellerRecordId)
          .select("id")
          .maybeSingle()
      );
    },

    async updateWebhook(id, patch) {
      unwrap(await supabase.from("api_webhooks").update(patch).eq("id", id));
    },

    async activeWebhooksWithSecret(sellerRecordId) {
      return (
        unwrap(
          await supabase
            .from("api_webhooks")
            .select(`${WEBHOOK_COLUMNS}, secret`)
            .eq("seller_record_id", sellerRecordId)
            .is("disabled_at", null)
        ) || []
      );
    },

    async activeWebhooksFor(sellerRecordIds) {
      if (!sellerRecordIds.length) return [];

      return (
        unwrap(
          await supabase
            .from("api_webhooks")
            .select("id, seller_record_id, events")
            .in("seller_record_id", sellerRecordIds)
            .is("disabled_at", null)
        ) || []
      );
    },

    async insertDeliveries(rows) {
      for (let i = 0; i < rows.length; i += 200) {
        unwrap(await supabase.from("api_webhook_deliveries").insert(rows.slice(i, i + 200)));
      }
    },

    async dueDeliveries({ at, limit }) {
      const rows =
        unwrap(
          await supabase
            .from("api_webhook_deliveries")
            .select("id, event_type, payload, attempts, webhook:api_webhooks(id, url, secret, consecutive_failures, disabled_at)")
            .eq("status", "pending")
            .lte("next_attempt_at", at)
            .order("next_attempt_at", { ascending: true })
            .limit(limit)
        ) || [];

      return rows;
    },

    async updateDelivery(id, patch) {
      unwrap(await supabase.from("api_webhook_deliveries").update(patch).eq("id", id));
    },

    async recentDeliveries({ webhookId, limit = 20 }) {
      return (
        unwrap(
          await supabase
            .from("api_webhook_deliveries")
            .select("id, event_type, status, attempts, last_status_code, last_error, created_at, delivered_at")
            .eq("webhook_id", webhookId)
            .order("created_at", { ascending: false })
            .limit(limit)
        ) || []
      );
    }
  };
}
