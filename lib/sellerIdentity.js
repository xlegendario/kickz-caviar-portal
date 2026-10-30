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

/*
 * One email and one Discord account belong to one Seller ID.
 *
 * Every second profile so far came from a route that checked one of the two
 * and not the other: the Discord bot looked only at Discord ID, the Sales
 * Agreement flow in Make only at an exact, case-sensitive email. So both are
 * checked here, the email the way it is compared everywhere else - trimmed
 * and lowercased.
 *
 * existingSellerFormula finds every record that would clash, for a select;
 * sellerConflict says which one clashes and on what, so the caller can send
 * the seller to that profile instead of making a new one.
 */
export const normalizeSellerEmail = (value) => text(value).toLowerCase();

const formulaValue = (value) => text(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");

export function existingSellerFormula({ email, discordId } = {}) {
  const wantedEmail = normalizeSellerEmail(email);
  const wantedDiscord = text(discordId);
  const clauses = [];

  if (wantedEmail) clauses.push(`LOWER(TRIM({Email} & '')) = '${formulaValue(wantedEmail)}'`);
  if (wantedDiscord) clauses.push(`TRIM({Discord ID} & '') = '${formulaValue(wantedDiscord)}'`);

  if (!clauses.length) return "";

  return clauses.length === 1 ? clauses[0] : `OR(${clauses.join(", ")})`;
}

export function sellerConflict(records, { email, discordId, exceptRecordId } = {}) {
  const wantedEmail = normalizeSellerEmail(email);
  const wantedDiscord = text(discordId);
  const others = (records || []).filter((record) => record && record.id !== exceptRecordId);

  // Discord first: it is the identity the bots and the gate work with, so a
  // clash there decides which profile the seller is sent to.
  const byDiscord = wantedDiscord && others.find((record) => text(record.fields?.["Discord ID"]) === wantedDiscord);

  if (byDiscord) return { matchedOn: "discord", record: byDiscord };

  const byEmail = wantedEmail && others.find((record) => normalizeSellerEmail(record.fields?.Email) === wantedEmail);

  if (byEmail) return { matchedOn: "email", record: byEmail };

  return null;
}

export function isBuyerOfMemberWtb(record, sellerRecordId) {
  const buyers = record?.fields?.["Buyer Seller ID"];

  return Array.isArray(buyers) && Boolean(text(sellerRecordId)) && buyers.includes(text(sellerRecordId));
}
