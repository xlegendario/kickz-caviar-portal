// lib/sellerClaim.js
//
// Een bestaand seller-profiel claimen vanuit Discord.
//
// Achtergrond: ruim de helft van de sellers heeft een Seller ID uit de tijd dat
// we het Discord ID nog niet vastlegden. Die mensen moeten hun ID nu bij elke
// offer overtypen. Zodra ze hun profiel één keer claimen, weet de bot wie ze
// zijn en hoeft dat nooit meer.
//
// Bewijs is Seller ID + e-mail + een code die naar dat e-mailadres gaat. Die
// laatste stap is er niet voor de sier: Seller ID's lopen op en zijn dus te
// raden, dus zonder code zou een bekend e-mailadres genoeg zijn om andermans
// profiel over te nemen.

import crypto from "crypto";

export const CLAIM_CODE_TTL_MS = 15 * 60 * 1000;
export const MAX_CLAIM_ATTEMPTS = 5;

// Sellers typen "00001", "1", "SE-00001" of "se 00001". Alles wat geen cijfer
// is gaat eruit, en daarna vergelijken we op getalwaarde zodat voorloopnullen
// niet uitmaken.
export function normalizeSellerIdDigits(input) {
  const digits = String(input ?? "").replace(/\D/g, "");

  if (!digits || digits.length > 10) return "";

  return String(Number(digits));
}

export function sellerIdMatches(recordSellerId, input) {
  const wanted = normalizeSellerIdDigits(input);
  const actual = normalizeSellerIdDigits(recordSellerId);

  return !!wanted && wanted === actual;
}

export function normalizeEmail(input) {
  return String(input ?? "").trim().toLowerCase();
}

export function generateClaimCode() {
  // Zes cijfers, uit een cryptografische bron. randomInt vermijdt de scheve
  // verdeling die je met % 1000000 op random bytes krijgt.
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

// De code wordt gehasht opgeslagen, net als een wachtwoord. Wie de Airtable-rij
// kan lezen mag daarmee nog steeds geen profiel kunnen claimen.
export function hashClaimCode(code) {
  return crypto.createHash("sha256").update(String(code)).digest("hex");
}

export function claimCodeMatches(code, storedHash) {
  const supplied = Buffer.from(hashClaimCode(code), "utf8");
  const expected = Buffer.from(String(storedHash ?? ""), "utf8");

  if (!expected.length || supplied.length !== expected.length) return false;

  return crypto.timingSafeEqual(supplied, expected);
}

// Beslist of er een code verstuurd mag worden. Geeft bewust bij elke afwijzing
// een eigen reden terug voor de logs — maar de aanroeper toont de seller één
// en dezelfde tekst, zodat je er niet uit kunt afleiden of een Seller ID of
// e-mailadres bestaat.
export function canStartClaim({ record, sellerIdInput, emailInput }) {
  if (!record) return { ok: false, reason: "no_record" };

  const fields = record.fields || {};

  if (!sellerIdMatches(fields["Seller ID"], sellerIdInput)) {
    return { ok: false, reason: "seller_id_mismatch" };
  }

  if (normalizeEmail(fields.Email) !== normalizeEmail(emailInput)) {
    return { ok: false, reason: "email_mismatch" };
  }

  // Een al gekoppeld profiel is niet te claimen. Dat beperkt het risico tot de
  // records die nog nooit aan een Discord hingen.
  if (String(fields["Discord ID"] ?? "").trim()) {
    return { ok: false, reason: "already_linked" };
  }

  return { ok: true, reason: "" };
}

export function isClaimCodeUsable({ storedHash, expiresAt, attempts, now = Date.now() }) {
  if (!storedHash) return { usable: false, reason: "no_code" };

  if (Number(attempts) >= MAX_CLAIM_ATTEMPTS) {
    return { usable: false, reason: "too_many_attempts" };
  }

  const deadline = expiresAt ? new Date(expiresAt).getTime() : 0;

  if (!deadline || Number.isNaN(deadline) || deadline < now) {
    return { usable: false, reason: "expired" };
  }

  return { usable: true, reason: "" };
}
