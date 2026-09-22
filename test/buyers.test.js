import test from "node:test";
import assert from "node:assert/strict";

import { buyerFromInput, buyerId, buyerLabel, buyerOption, findDuplicate } from "../lib/buyers.js";

test("a buyer is shown by company first, then the owner", () => {
  assert.equal(buyerLabel({ company_name: "ALC SELECT STORE SL", full_name: "Juan Lopez" }), "ALC SELECT STORE SL (Juan Lopez)");
  assert.equal(buyerLabel({ full_name: "Lian Gietermans" }), "Lian Gietermans");
  assert.equal(buyerLabel({ company_name: "DPX Capital s.r.o.", full_name: "DPX Capital s.r.o." }), "DPX Capital s.r.o.");
});

test("buyer numbers keep their five digits", () => {
  assert.equal(buyerId({ buyer_number: 85 }), "BU-00085");
});

test("a new buyer needs everything an invoice needs", () => {
  const { errors } = buyerFromInput({ full_name: "", company_name: "", email: "nope", country: "Narnia" });
  assert.equal(errors.length, 6);
  assert.match(errors.join(" "), /name or company/);
  assert.match(errors.join(" "), /email address does not look right/);
  assert.match(errors.join(" "), /"Narnia" is not a country/);
});

test("the country code comes from the country, and the VAT number is cleaned", () => {
  const { errors, row } = buyerFromInput({
    company_name: "Grail Point sp. z o.o.",
    email: "Dawid@Example.PL",
    vat_id: "pl 701-103-52.18",
    address: "ul. 1",
    zipcode: "00-001",
    city: "Warsaw",
    country: "poland"
  });
  assert.deepEqual(errors, []);
  assert.equal(row.country, "Poland");
  assert.equal(row.country_code, "PL");
  assert.equal(row.vat_id, "PL7011035218");
  assert.equal(row.email, "dawid@example.pl");
});

test("the same business twice is caught by VAT number or email", () => {
  const existing = [{ id: "a", buyer_number: 22, company_name: "DPX Capital s.r.o.", vat_id: "CZ23343567", email: "buyout@sneakerstore.cz" }];
  assert.equal(findDuplicate(existing, { vat_id: "cz 23343567", email: "other@x.cz" })?.id, "a");
  assert.equal(findDuplicate(existing, { vat_id: "", email: "BUYOUT@sneakerstore.cz" })?.id, "a");
  assert.equal(findDuplicate(existing, { vat_id: "CZ999", email: "new@x.cz" }), null);
});

test("the WMS option carries the Supabase id and the details", () => {
  const option = buyerOption({ id: "uuid-1", buyer_number: 84, company_name: "Grail Point", country: "Poland", country_code: "PL", address_line2: "2nd" });
  assert.equal(option.id, "uuid-1");
  assert.equal(option.buyer_id, "BU-00084");
  assert.equal(option.details.address_line_2, "2nd");
});
