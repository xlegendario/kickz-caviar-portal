// lib/agreementWebhook.js
//
// Na een nieuwe registratie gaat er een payload naar het Make-scenario dat de
// Sales Agreement PDF genereert en in het veld `Agreement PDF` zet.
//
// De oude seller-registration bot deed dit vlak na het aanmaken van het
// Airtable-record. In de portal ligt dat moment anders: daar bestaat het
// seller-record al vóórdat Discord gekoppeld is. We vuren daarom pas ná de
// koppeling, zodat de payload dezelfde velden bevat als voorheen —
// `discordId` en `discordTag` incluis, die Make anders leeg zou krijgen.

// Exact de veldnamen die de oude bot stuurde. Het Make-scenario leest deze
// sleutels, dus hernoemen breekt de PDF-generatie stil.
export function buildAgreementPayload({
  airtableRecordId,
  sellerId,
  discordId,
  discordTag,
  fields,
  timestamp
}) {
  const value = (key) => String(fields?.[key] ?? "");

  return {
    airtableRecordId,
    sellerId,
    discordId,
    discordTag,
    fullName: value("Full Name"),
    companyName: value("Company Name"),
    vatId: value("VAT ID"),
    email: value("Email"),
    // De oude bot voegde adresregel 2 samen tot één string voordat hij naar
    // Airtable schreef; het veld Address bevat die combinatie al.
    fullAddress: value("Address"),
    zipcode: value("Zipcode"),
    city: value("City"),
    countryName: value("Country"),
    payoutInfo: value("Payout Info"),
    tcVersion: value("T&C Version"),
    agreedVia: "portal",
    timestamp
  };
}
