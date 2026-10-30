// lib/sellerIdentity.js
//
// Who is acting, for routes that change or remove something.
//
// sellerIdentityForRead in index.js is deliberately forgiving: while
// AUTH_ENFORCE is "warn" it falls back to whatever seller id the request names,
// so nothing breaks while the session rollout settles. That is acceptable for
// reading. For writing it is the whole problem - a check that a record belongs
// to the caller is worthless when the caller may simply claim to be its owner.
//
// So this has exactly two answers and no fallback:
//
//   a signed-in session       the seller in the cookie, whatever else is sent
//   a trusted service secret  the Lojiq portal or a bot, acting for the seller
//                             it names in the request
//
// Anything else is not signed in.

import crypto from "crypto";

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());

function matchesAny(presented, secrets) {
  const given = Buffer.from(text(presented));

  if (!given.length) return false;

  return secrets.filter(Boolean).some((secret) => {
    const expected = Buffer.from(String(secret));

    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  });
}

export function strictSellerIdentity({ sessionRecordId, presentedSecret, trustedSecrets = [], askedRecordId }) {
  const session = text(sessionRecordId);

  if (session) return { sellerRecordId: session };

  const asked = text(askedRecordId);

  if (asked && matchesAny(presentedSecret, trustedSecrets)) return { sellerRecordId: asked };

  return { status: 401, error: "Not signed in" };
}

/*
 * Whether a Member WTB belongs to this buyer.
 *
 * Read from the link field the API returns - record ids - rather than through
 * a formula, where a linked field turns into its primary field and a record
 * id would never match.
 */
/*
 * The profile to sign in to when one email belongs to several sellers.
 *
 * 33 emails in Sellers Database have more than one record - a profile from
 * the old form next to the one the Discord bot made later. Taking whichever
 * Airtable returned first signed RM SNEAKER TRADE in to SE-00282, which has
 * no Discord; the Discord gate then sent them to link it, and their Discord
 * is on SE-00814, so the link was refused on every sign-in. The profile with
 * Discord is the one in use, so it comes first, then the newest Seller ID.
 */
const sellerNumber = (seller) => Number(text(seller?.seller_id).replace(/\D/g, "")) || 0;

export function rankSellersSharingEmail(sellers) {
  return [...(sellers || [])].sort(
    (a, b) =>
      Number(Boolean(text(b?.discord_id))) - Number(Boolean(text(a?.discord_id))) ||
      sellerNumber(b) - sellerNumber(a)
  );
}

export function isBuyerOfMemberWtb(record, sellerRecordId) {
  const buyers = record?.fields?.["Buyer Seller ID"];

  return Array.isArray(buyers) && Boolean(text(sellerRecordId)) && buyers.includes(text(sellerRecordId));
}
