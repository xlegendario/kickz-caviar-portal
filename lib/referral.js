// lib/referral.js
//
// Affiliate-attributie voor sellers die via de portal binnenkomen.
//
// Waarom dit nodig is: discord-deal-bot bepaalt wie iemand uitnodigde door
// invite-tellers voor en na de join te vergelijken. Dat werkt alleen als de
// nieuwe member echt op een invite-link klikt. De portal voegt hem via
// OAuth (`guilds.join`) rechtstreeks toe, waarbij géén invite verbruikt wordt —
// die join zou dus nooit toegeschreven worden.
//
// In plaats van te gokken welke invite gebruikt is, draagt de portal de
// referral expliciet mee in de URL (?ref=<invite code>). Dat is betrouwbaarder
// dan de teller-heuristiek, en het hergebruikt de `Invite Code` die al op elke
// Discord Members-rij staat, zodat er geen tweede identifier bijkomt.

export function normalizeRefCode(input) {
  const value = String(input ?? "").trim();

  // Invite codes van Discord zijn kort en alfanumeriek. Alles daarbuiten is
  // geen code maar iemand die met de URL speelt.
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(value)) return "";

  return value;
}

// Bepaalt of we de uitnodiger mogen vastleggen op het record van de
// uitgenodigde. Spiegelt de regels die affiliateInvites al hanteert, zodat
// beide routes dezelfde uitkomst geven.
export function shouldAttribute({ inviteeDiscordId, inviterDiscordId, existingInviterId }) {
  const invitee = String(inviteeDiscordId || "").trim();
  const inviter = String(inviterDiscordId || "").trim();

  if (!invitee) return { attribute: false, reason: "no_invitee" };
  if (!inviter) return { attribute: false, reason: "unknown_ref_code" };

  // Jezelf uitnodigen is de goedkoopste manier om een leaderboard te vervuilen.
  if (invitee === inviter) return { attribute: false, reason: "self_referral" };

  // affiliateInvites schrijft de uitnodiger alleen weg als het veld nog leeg
  // is. Dezelfde regel hier, anders zou een tweede link de eerste overschrijven
  // en kan iemand de credit van een ander overnemen.
  if (String(existingInviterId || "").trim()) {
    return { attribute: false, reason: "already_attributed" };
  }

  return { attribute: true, reason: "" };
}

// Welke Invites Log-rijen mogen op "Referral Qualified" gezet worden.
//
// Een referral telt pas als er een Inventory Unit op de Seller ID van de
// uitgenodigde staat: dat is het eerste harde bewijs dat er echt een deal was,
// niet alleen een aanmelding. Eenmaal gekwalificeerd blijft gekwalificeerd,
// ook als de member later de server verlaat — de uitnodiger heeft zijn werk
// al gedaan.
export function planQualifications(rows) {
  return rows
    .filter((row) => row.qualified !== true && row.hasInventoryUnit === true)
    .map((row) => row.logId);
}
