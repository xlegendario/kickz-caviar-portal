// lib/registration.js
//
// Validatie voor seller-registratie in de portal.
//
// De registratie verhuist van de Discord-bot hierheen. Dat betekent dat dit de
// enige plek wordt waar seller-records ontstaan, dus de regels moeten hier
// kloppen — er is geen tweede vangnet meer.
//
// Alle velden worden uitgevraagd (adres en payout-info incluis): browsers en
// telefoons vullen die automatisch in, dus ze kosten de seller nauwelijks
// moeite, terwijl ze later bij een geaccepteerde deal wél nodig zijn.

import { resolveCountry } from "./countries.js";

export const TNC_VERSION = "v1.0";

// Precies de VAT-regels die discord-wtb-bot bij elke offer toepast
// (validateSellerVatEligibility). Ze hier herhalen zou ze uit de pas laten
// lopen; deze functie legt alleen uit wat de seller straks mag, zodat het
// registratieformulier het meteen kan tonen.
export function vatTypesForSeller({ vatId, country }) {
  const hasVatId = !!String(vatId || "").trim();

  if (!hasVatId) return ["Margin"];

  const resolved = resolveCountry(country);
  const isNl = resolved?.code === "NL";

  return isNl ? ["Margin", "VAT21"] : ["Margin", "VAT0"];
}

const REQUIRED = [
  ["full_name", "Full name"],
  ["email", "Email"],
  ["address", "Address"],
  ["zipcode", "Zipcode"],
  ["city", "City"],
  ["country", "Country"],
  ["payout_info", "Payout info"]
];

// Bewust simpel. Het doel is een typefout opvangen, niet elk RFC-geldig adres
// toelaten; de mail wordt sowieso gebruikt voor wachtwoord-reset, dus een fout
// adres blijkt vanzelf.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function validateRegistration(input = {}) {
  const errors = {};
  const value = (key) => String(input[key] ?? "").trim();

  for (const [key, label] of REQUIRED) {
    if (!value(key)) errors[key] = `${label} is required`;
  }

  const email = value("email").toLowerCase();

  if (email && !EMAIL.test(email)) {
    errors.email = "That does not look like a valid email address";
  }

  // Het land moet uit de vaste lijst komen. De dropdown regelt dat in de
  // browser, maar een POST kan alles bevatten — en een land dat Airtable niet
  // kent laat "Country Code" leeg, waardoor de label-routing later stilvalt.
  const country = resolveCountry(value("country"));

  if (value("country") && !country) {
    errors.country = "Select a country from the list";
  }

  const password = String(input.password ?? "");

  if (password.length < 8) {
    errors.password = "Password must be at least 8 characters";
  }

  if (password !== String(input.password_confirm ?? "")) {
    errors.password_confirm = "Passwords do not match";
  }

  if (input.accept_terms !== true) {
    errors.accept_terms = "You must accept the Terms & Conditions";
  }

  if (Object.keys(errors).length) {
    return { ok: false, errors };
  }

  const addressLine2 = value("address_line_2");

  return {
    ok: true,
    errors: {},
    email,
    fields: {
      "Full Name": value("full_name"),
      "Company Name": value("company_name"),
      "VAT ID": value("vat_id"),
      Email: email,
      Address: addressLine2 ? `${value("address")}, ${addressLine2}` : value("address"),
      Zipcode: value("zipcode"),
      City: value("city"),
      Country: country.name,
      "Payout Info": value("payout_info"),
      "T&C Version": TNC_VERSION,
      "Agreement Text": "Agreed via portal registration",
      "Registration Date": new Date().toISOString().slice(0, 10)
    }
  };
}
