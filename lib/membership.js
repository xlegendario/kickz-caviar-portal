// lib/membership.js
//
// Bijhouden wie er nog in de Discord-server zit.
//
// Waarom dit bestaat: een geaccepteerde deal maakt een channel aan met de
// seller erin. Zit die niet meer in de server, dan mislukt dat stil. De
// offer-flow controleert daarom "Discord In Server?", en dit is wat dat veld
// waarheidsgetrouw houdt.
//
// Twee bronnen, met opzet:
//  1. Gateway-events (join/leave) — direct, maar gemist tijdens downtime.
//  2. Een periodieke reconcile tegen de volledige ledenlijst — traag, maar
//     haalt in wat de gateway miste.

// Een gedeeltelijk opgehaalde ledenlijst is het gevaarlijkste scenario dat
// hier kan optreden: dan lijkt bijna iedereen vertrokken en zet de reconcile
// de halve database op "niet meer in de server", waarna niemand meer kan
// bieden. Liever een ronde overslaan dan dat.
export const MIN_RECONCILE_RATIO = 0.5;

export function isReconcileSafe({ fetchedCount, knownInServerCount, minRatio = MIN_RECONCILE_RATIO }) {
  if (!Number.isFinite(fetchedCount) || fetchedCount <= 0) {
    return { safe: false, reason: "Guild member fetch returned nothing" };
  }

  // Nog niets bekend in Airtable (eerste run): dan valt er niets te
  // vergelijken en is elke uitkomst goed.
  if (!knownInServerCount) return { safe: true, reason: "" };

  if (fetchedCount < knownInServerCount * minRatio) {
    return {
      safe: false,
      reason:
        `Guild fetch returned ${fetchedCount} members while ${knownInServerCount} were marked in-server. ` +
        `That looks like a partial fetch, not an exodus — skipping this round.`
    };
  }

  return { safe: true, reason: "" };
}

// Bepaalt welke Discord Members-rijen bijgewerkt moeten worden. Geeft alleen
// de verschillen terug, zodat er geen records worden aangeraakt die al kloppen
// — dat scheelt Airtable-writes en houdt "Left Server At" op de oorspronkelijke
// datum staan.
export function planMembershipChanges({ guildMemberIds, airtableRows }) {
  const inGuild = new Set([...guildMemberIds].map((id) => String(id).trim()).filter(Boolean));

  const toMarkLeft = [];
  const toMarkRejoined = [];

  for (const row of airtableRows) {
    const discordId = String(row.discordUserId || "").trim();

    if (!discordId) continue;

    const present = inGuild.has(discordId);

    // Airtable geeft een uitgevinkte checkbox terug als undefined, niet als
    // false. Alles wat niet expliciet false is telt dus als "zat erin", wat
    // ook de veilige aanname is voor bestaande records.
    const wasInServer = row.inServer !== false;

    if (wasInServer && !present) {
      toMarkLeft.push(row);
    } else if (!wasInServer && present) {
      toMarkRejoined.push(row);
    }
  }

  return { toMarkLeft, toMarkRejoined };
}
