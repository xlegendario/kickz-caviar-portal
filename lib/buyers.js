// lib/buyers.js
//
// Buyers of External Sales (and forwards), in Supabase public.buyers since
// 22-09-2026. Before that they lived twice in Airtable - "Buyer Database" in
// the WMS's base and "Buyers Database" in the main base - and Rompslomp had
// drifted from both. One row per buyer now, with a buyer number that never
// changes (BU-00084) and the Rompslomp contact it is invoiced to.
//
// The WMS reads and makes buyers through /api/internal/buyers/*; these are
// the rules those routes share. Kept free of any API call.

import { resolveCountry } from "./countries.js";

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());

export const buyerId = (buyer) => `BU-${String(buyer?.buyer_number ?? "").padStart(5, "0")}`;

// A buyer is recognised by the business, not by its owner: "Company (Owner)",
// or just the name for a private buyer.
export function buyerLabel(buyer) {
  const company = text(buyer?.company_name);
  const person = text(buyer?.full_name);
  if (company && person && company.toLowerCase() !== person.toLowerCase()) return `${company} (${person})`;
  return company || person;
}

export const normalizeVat = (value) => text(value).replace(/[\s.-]/g, "").toUpperCase();

/*
 * A new buyer from the Create Outbound form, or why not.
 *
 * Everything an invoice needs is required here, so an invoice never fails
 * on a buyer later: a name (person or company), an email, the address and a
 * country we know. The country code comes from the country, as the Airtable
 * formula did.
 */
export function buyerFromInput(input = {}) {
  const errors = [];
  const country = resolveCountry(input.country);

  const row = {
    full_name: text(input.full_name) || null,
    company_name: text(input.company_name) || null,
    vat_id: normalizeVat(input.vat_id) || null,
    email: text(input.email).toLowerCase() || null,
    address: text(input.address) || null,
    address_line2: text(input.address_line_2 ?? input.address_line2) || null,
    zipcode: text(input.zipcode) || null,
    city: text(input.city) || null,
    country: country?.name || null,
    country_code: country?.code || null
  };

  if (!row.full_name && !row.company_name) errors.push("Enter the buyer's name or company name.");
  if (!row.email) errors.push("Enter an email address; the invoice is sent there.");
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email)) errors.push("That email address does not look right.");
  if (!row.address) errors.push("Enter the address.");
  if (!row.zipcode) errors.push("Enter the zipcode.");
  if (!row.city) errors.push("Enter the city.");
  if (!country) errors.push(text(input.country) ? `"${text(input.country)}" is not a country we can invoice to.` : "Choose the country.");

  return { errors, row };
}

// An existing buyer that is the same one: same VAT number, or same email.
// A second row for the same business is how the six duplicates of 22-09
// came about.
export function findDuplicate(buyers, row) {
  const vat = normalizeVat(row.vat_id);
  const email = text(row.email).toLowerCase();
  return (
    (vat && buyers.find((b) => normalizeVat(b.vat_id) === vat)) ||
    (email && buyers.find((b) => text(b.email).toLowerCase() === email)) ||
    null
  );
}

// What the WMS form shows. `id` is the Supabase buyer id.
export function buyerOption(buyer) {
  return {
    id: buyer.id,
    buyer_id: buyerId(buyer),
    label: buyerLabel(buyer),
    details: {
      full_name: text(buyer.full_name),
      company_name: text(buyer.company_name),
      vat_id: text(buyer.vat_id),
      email: text(buyer.email),
      address: text(buyer.address),
      address_line_2: text(buyer.address_line2),
      zipcode: text(buyer.zipcode),
      city: text(buyer.city),
      country: text(buyer.country),
      country_code: text(buyer.country_code)
    }
  };
}

// The main base's "Buyers Database" row for a buyer. Until the WMS writes
// External Sales to Supabase (block 2), a deal in the External Sales Log
// still links to that row.
export function airtableBuyerFields(buyer) {
  return {
    "Buyer ID": buyerId(buyer),
    "Full Name": text(buyer.full_name) || text(buyer.company_name),
    "Company Name": text(buyer.company_name) || null,
    "VAT ID": text(buyer.vat_id) || null,
    "Email": text(buyer.email) || null,
    "Address": text(buyer.address) || null,
    "Address line 2": text(buyer.address_line2) || null,
    "Zipcode": text(buyer.zipcode) || null,
    "City": text(buyer.city) || null,
    "Country": text(buyer.country) || null,
    "Country Code": text(buyer.country_code) || null
  };
}
