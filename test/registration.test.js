import test from "node:test";
import assert from "node:assert/strict";

import { validateRegistration, vatTypesForSeller, TNC_VERSION } from "../lib/registration.js";

function geldig(overrides = {}) {
  return {
    full_name: "Jan Jansen",
    email: "Jan@Example.COM",
    address: "Hoofdstraat 1",
    zipcode: "1234 AB",
    city: "Amsterdam",
    country: "Netherlands",
    payout_info: "NL91ABNA0417164300",
    password: "hunter22!",
    password_confirm: "hunter22!",
    accept_terms: true,
    ...overrides
  };
}

test("een volledige registratie levert Airtable-velden op", () => {
  const result = validateRegistration(geldig());

  assert.equal(result.ok, true);
  assert.equal(result.fields["Full Name"], "Jan Jansen");
  assert.equal(result.fields.Country, "Netherlands");
  assert.equal(result.fields["T&C Version"], TNC_VERSION);
  assert.match(result.fields["Registration Date"], /^\d{4}-\d{2}-\d{2}$/);
});

test("e-mail wordt genormaliseerd naar kleine letters", () => {
  const result = validateRegistration(geldig());

  assert.equal(result.email, "jan@example.com");
  assert.equal(result.fields.Email, "jan@example.com");
});

test("adresregel 2 wordt samengevoegd, net als de oude Discord-registratie deed", () => {
  const met = validateRegistration(geldig({ address_line_2: "2 hoog" }));
  assert.equal(met.fields.Address, "Hoofdstraat 1, 2 hoog");

  const zonder = validateRegistration(geldig());
  assert.equal(zonder.fields.Address, "Hoofdstraat 1");
});

test("elk verplicht veld wordt afzonderlijk gemeld", () => {
  const result = validateRegistration({ accept_terms: true, password: "hunter22!", password_confirm: "hunter22!" });

  assert.equal(result.ok, false);
  for (const key of ["full_name", "email", "address", "zipcode", "city", "country", "payout_info"]) {
    assert.ok(result.errors[key], `${key} zou een fout moeten geven`);
  }
});

test("een land buiten de lijst wordt geweigerd", () => {
  const result = validateRegistration(geldig({ country: "Nederland" }));

  assert.equal(result.ok, false);
  assert.match(result.errors.country, /Select a country/);
});

test("de nieuwe landen worden geaccepteerd", () => {
  for (const land of ["Ireland", "Estonia", "Malta", "United Kingdom", "Iceland", "Lithuania"]) {
    assert.equal(validateRegistration(geldig({ country: land })).ok, true, land);
  }
});

test("wachtwoordregels", () => {
  assert.match(validateRegistration(geldig({ password: "kort", password_confirm: "kort" })).errors.password, /8 characters/);
  assert.match(validateRegistration(geldig({ password_confirm: "anders123" })).errors.password_confirm, /do not match/);
});

test("zonder akkoord op de voorwaarden geen registratie", () => {
  assert.match(validateRegistration(geldig({ accept_terms: false })).errors.accept_terms, /Terms/);
  assert.match(validateRegistration(geldig({ accept_terms: "true" })).errors.accept_terms, /Terms/);
});

test("onzin-e-mail wordt geweigerd", () => {
  for (const adres of ["geen-apenstaartje", "a@b", "a b@c.nl", "@example.com"]) {
    assert.equal(validateRegistration(geldig({ email: adres })).ok, false, adres);
  }
});

test("VAT-opties volgen dezelfde regels als de WTB-bot bij een offer hanteert", () => {
  assert.deepEqual(vatTypesForSeller({ vatId: "", country: "Netherlands" }), ["Margin"]);
  assert.deepEqual(vatTypesForSeller({ vatId: "NL0012", country: "Netherlands" }), ["Margin", "VAT21"]);
  assert.deepEqual(vatTypesForSeller({ vatId: "DE0012", country: "Germany" }), ["Margin", "VAT0"]);
  assert.deepEqual(vatTypesForSeller({ vatId: "IE0012", country: "Ireland" }), ["Margin", "VAT0"]);
});
