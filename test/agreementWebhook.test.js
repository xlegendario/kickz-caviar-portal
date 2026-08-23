import test from "node:test";
import assert from "node:assert/strict";

import { buildAgreementPayload } from "../lib/agreementWebhook.js";

const FIELDS = {
  "Full Name": "Jan Jansen",
  "Company Name": "Jansen BV",
  "VAT ID": "NL0012345B01",
  Email: "jan@example.com",
  Address: "Hoofdstraat 1, 2 hoog",
  Zipcode: "1234 AB",
  City: "Amsterdam",
  Country: "Netherlands",
  "Payout Info": "NL91ABNA0417164300",
  "T&C Version": "v1.0"
};

test("de payload draagt exact de sleutels die het Make-scenario verwacht", () => {
  const payload = buildAgreementPayload({
    airtableRecordId: "recABC",
    sellerId: "SE-00123",
    discordId: "111",
    discordTag: "legendario",
    fields: FIELDS,
    timestamp: "2026-08-23T10:00:00.000Z"
  });

  // Deze lijst komt uit de oude seller-registration bot. Wijkt hij af, dan
  // krijgt Make lege velden en komt dat pas in de PDF naar boven.
  assert.deepEqual(Object.keys(payload).sort(), [
    "agreedVia",
    "airtableRecordId",
    "city",
    "companyName",
    "countryName",
    "discordId",
    "discordTag",
    "email",
    "fullAddress",
    "fullName",
    "payoutInfo",
    "sellerId",
    "tcVersion",
    "timestamp",
    "vatId",
    "zipcode"
  ]);
});

test("velden worden één op één overgenomen", () => {
  const payload = buildAgreementPayload({
    airtableRecordId: "recABC",
    sellerId: "SE-00123",
    discordId: "111",
    discordTag: "legendario",
    fields: FIELDS,
    timestamp: "2026-08-23T10:00:00.000Z"
  });

  assert.equal(payload.fullName, "Jan Jansen");
  assert.equal(payload.fullAddress, "Hoofdstraat 1, 2 hoog");
  assert.equal(payload.countryName, "Netherlands");
  assert.equal(payload.tcVersion, "v1.0");
  assert.equal(payload.agreedVia, "portal");
});

test("ontbrekende optionele velden worden lege strings, geen undefined", () => {
  // Make-modules die undefined krijgen laten het veld helemaal weg, waardoor
  // de PDF-template stilletjes een lege plek krijgt in plaats van een lege regel.
  const payload = buildAgreementPayload({
    airtableRecordId: "recABC",
    sellerId: "SE-1",
    discordId: "111",
    discordTag: "x",
    fields: { "Full Name": "Jan" },
    timestamp: "2026-08-23T10:00:00.000Z"
  });

  assert.equal(payload.companyName, "");
  assert.equal(payload.vatId, "");
  assert.equal(payload.payoutInfo, "");
  for (const value of Object.values(payload)) {
    assert.notEqual(value, undefined);
  }
});
