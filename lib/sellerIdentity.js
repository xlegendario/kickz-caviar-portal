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
export function isBuyerOfMemberWtb(record, sellerRecordId) {
  const buyers = record?.fields?.["Buyer Seller ID"];

  return Array.isArray(buyers) && Boolean(text(sellerRecordId)) && buyers.includes(text(sellerRecordId));
}
