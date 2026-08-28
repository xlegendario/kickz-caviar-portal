/**
 * discordGate.js — every acting seller must have Discord linked and be in
 * the server.
 *
 * WHY THIS IS MIDDLEWARE AND NOT A LINE PER ENDPOINT
 *
 * The check already existed as requireLinkedDiscord(), and it was correct.
 * It had one caller. Of the 88 write endpoints in the portal, exactly one
 * used it — while /api/claim-deal, which sits directly ABOVE the function
 * in the same file, did not. That is what one-line-per-endpoint gets you:
 * whoever adds the next endpoint has to remember, and eventually nobody
 * does.
 *
 * So this runs for everything and names its exceptions instead. A new
 * endpoint is covered the day it is written, without anyone thinking about
 * it. The list below is the whole security decision, in one place, and it
 * can be read in a minute.
 *
 * WHY IT DEFAULTS TO WARNING RATHER THAN BLOCKING
 *
 * Same reason sellerIdentityGuard does, and it worked there: deploy it
 * quiet, read a day of logs, then turn it on. If a path is classified
 * wrongly, the log says so and nobody is locked out of a live marketplace
 * while we find out.
 *
 * WHAT HAPPENS WHEN THE LOOKUP ITSELF FAILS
 *
 * It lets the request through and logs loudly. This gate exists so that an
 * accepted deal can get its Discord channel - it is not what stands between
 * a stranger and someone's account; sellerIdentityGuard does that, and it
 * runs first. An Airtable hiccup must not stop every seller from trading.
 */

// Paths that must keep working for someone without Discord.
//
// Prefixes, matched against the start of the path.
const DEFAULT_EXEMPT = [
  // Service to service. sellerIdentityGuard exempts these too.
  "/api/internal/",
  "/api/make/",

  // Getting in and out, and getting your password back. Blocking these
  // would lock out the very person who still has to link.
  "/api/login",
  "/api/logout",
  "/api/signup",
  "/api/session",
  "/api/forgot-password",
  "/api/reset-password",

  // Applying to become a consignor. Someone who is not yet anything should
  // be able to ask.
  "/api/consignment/application",

  // These calculate and return a number. They change nothing, and stopping
  // one would put the dialog in front of somebody who is only looking at a
  // price.
  "/api/consignment/offers/preview",
  "/api/consignment/pre-offer/calculate"
];

const GATED_METHODS = new Set(["POST", "PATCH", "DELETE"]);

/**
 * @param {object} options
 * @param {"off"|"warn"|"strict"} options.mode
 * @param {(recordId: string) => Promise<{discord_id?: string, discord_in_server?: boolean}|null>} options.lookupSeller
 * @param {string[]} [options.exempt] replaces the default list entirely
 * @param {string[]} [options.serviceSecrets] a valid x-kc-secret skips the gate
 * @param {number} [options.cacheMs] how long a lookup is reused
 */
export function discordMembershipGuard({
  mode = "warn",
  lookupSeller,
  exempt = DEFAULT_EXEMPT,
  serviceSecrets = [],
  cacheMs = 60000
}) {
  const secrets = serviceSecrets.map((s) => String(s || "")).filter(Boolean);

  // One lookup per seller per minute rather than one per request. A seller
  // clicking through their offers fires several writes in a row and they
  // would otherwise each cost an Airtable call.
  const cache = new Map();

  const cached = async (recordId) => {
    const hit = cache.get(recordId);

    if (hit && Date.now() - hit.at < cacheMs) return hit.value;

    const value = await lookupSeller(recordId);

    cache.set(recordId, { at: Date.now(), value });

    // The map would otherwise grow for the life of the process.
    if (cache.size > 500) {
      for (const [key, entry] of cache) {
        if (Date.now() - entry.at >= cacheMs) cache.delete(key);
      }
    }

    return value;
  };

  return async function guard(req, res, next) {
    if (mode === "off") return next();
    if (!GATED_METHODS.has(req.method)) return next();
    if (!req.path.startsWith("/api/")) return next();
    if (exempt.some((prefix) => req.path.startsWith(prefix))) return next();

    // No session means sellerIdentityGuard has already decided - in strict
    // mode it answered 401 and we never got here; in warn mode there is no
    // seller to check.
    const recordId = req.sellerSession?.rid;

    if (!recordId) return next();

    const presented = String(req.get("x-kc-secret") || "");

    if (presented && secrets.some((s) => s === presented)) return next();

    let seller;

    try {
      seller = await cached(recordId);
    } catch (err) {
      console.error(`[discord-gate] lookup failed for ${recordId}, letting through:`, err.message);
      return next();
    }

    if (!seller) return next();

    const linked = Boolean(seller.discord_id);
    const inServer = seller.discord_in_server !== false;

    if (linked && inServer) return next();

    const reason = linked ? "left_server" : "not_linked";

    console.warn(
      `[discord-gate:${mode}] ${req.method} ${req.path} — seller ${recordId} ${reason}`
    );

    if (mode !== "strict") return next();

    // Same shape the offer page already understands, so the dashboard and
    // the offer page can share one dialog.
    return res.status(403).json({
      error: linked
        ? "You are no longer in the Kickz Caviar Discord server."
        : "Link your Discord account to continue.",
      details: linked
        ? "Rejoin to keep trading — every accepted deal gets its own channel there with you in it."
        : "Every accepted deal gets its own Discord channel with you in it, so we need your Discord linked first. It takes one click.",
      code: "discord_not_linked",
      reason,
      link_url: "/auth/discord"
    });
  };
}

export { DEFAULT_EXEMPT };
