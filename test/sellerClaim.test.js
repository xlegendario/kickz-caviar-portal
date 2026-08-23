import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeSellerIdDigits,
  sellerIdMatches,
  generateClaimCode,
  hashClaimCode,
  claimCodeMatches,
  canStartClaim,
  isClaimCodeUsable,
  MAX_CLAIM_ATTEMPTS
} from "../lib/sellerClaim.js";

import { normalizeVatTypeInput } from "../lib/offerRules.js";

const record = (overrides = {}) => ({
  id: "recX",
  fields: { "Seller ID": "SE-00856", Email: "jan@example.com", ...overrides }
});

test("Seller ID wordt uit elke schrijfwijze gehaald", () => {
  for (const input of ["00856", "856", "SE-00856", "se 00856", " SE00856 "]) {
    assert.equal(normalizeSellerIdDigits(input), "856", input);
  }
});

test("onzin levert geen Seller ID op", () => {
  for (const input of ["", "   ", null, undefined, "abc", "SE-", "1".repeat(11)]) {
    assert.equal(normalizeSellerIdDigits(input), "", JSON.stringify(input));
  }
});

test("voorloopnullen maken niet uit bij het vergelijken", () => {
  assert.equal(sellerIdMatches("SE-00856", "856"), true);
  assert.equal(sellerIdMatches("SE-00856", "00856"), true);
  assert.equal(sellerIdMatches("SE-00856", "857"), false);
  assert.equal(sellerIdMatches("SE-00856", ""), false);
});

test("codes zijn zes cijfers en niet allemaal hetzelfde", () => {
  const codes = new Set();

  for (let i = 0; i < 50; i++) {
    const code = generateClaimCode();
    assert.match(code, /^\d{6}$/);
    codes.add(code);
  }

  assert.ok(codes.size > 20, "codes zijn verdacht weinig gevarieerd");
});

test("de code wordt gehasht bewaard en vergelijkt goed", () => {
  const code = "042195";
  const hash = hashClaimCode(code);

  assert.notEqual(hash, code);
  assert.equal(claimCodeMatches(code, hash), true);
  assert.equal(claimCodeMatches("042196", hash), false);
  assert.equal(claimCodeMatches(code, ""), false);
  assert.equal(claimCodeMatches(code, null), false);
});

test("claim mag starten bij een kloppend en nog ongekoppeld profiel", () => {
  const result = canStartClaim({
    record: record(),
    sellerIdInput: "856",
    emailInput: "JAN@example.com"
  });

  assert.deepEqual(result, { ok: true, reason: "" });
});

test("verkeerd Seller ID of e-mail wordt geweigerd", () => {
  assert.equal(
    canStartClaim({ record: record(), sellerIdInput: "857", emailInput: "jan@example.com" }).reason,
    "seller_id_mismatch"
  );

  assert.equal(
    canStartClaim({ record: record(), sellerIdInput: "856", emailInput: "piet@example.com" }).reason,
    "email_mismatch"
  );
});

test("een al gekoppeld profiel is niet te claimen", () => {
  // Dit is de rem die het risico beperkt tot records die nog nooit aan een
  // Discord hingen; andermans actieve profiel kan niemand overnemen.
  const result = canStartClaim({
    record: record({ "Discord ID": "630817461704589322" }),
    sellerIdInput: "856",
    emailInput: "jan@example.com"
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "already_linked");
});

test("een geldige code binnen de tijd is bruikbaar", () => {
  const result = isClaimCodeUsable({
    storedHash: hashClaimCode("123456"),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    attempts: 0
  });

  assert.equal(result.usable, true);
});

test("verlopen, ontbrekend of te vaak geprobeerd wordt geweigerd", () => {
  const hash = hashClaimCode("123456");

  assert.equal(isClaimCodeUsable({ storedHash: "", expiresAt: null, attempts: 0 }).reason, "no_code");

  assert.equal(
    isClaimCodeUsable({
      storedHash: hash,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
      attempts: 0
    }).reason,
    "expired"
  );

  assert.equal(
    isClaimCodeUsable({
      storedHash: hash,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      attempts: MAX_CLAIM_ATTEMPTS
    }).reason,
    "too_many_attempts"
  );
});

test("VAT-invoer wordt soepel ingelezen", () => {
  for (const input of ["Margin", "margin", " MARGIN ", "marge", "m"]) {
    assert.equal(normalizeVatTypeInput(input), "Margin", input);
  }

  for (const input of ["VAT21", "vat21", "vat 21", "VAT-21", "21", "btw21", "vat21%"]) {
    assert.equal(normalizeVatTypeInput(input), "VAT21", input);
  }

  for (const input of ["VAT0", "vat0", "vat 0", "0", "btw0", "vat00"]) {
    assert.equal(normalizeVatTypeInput(input), "VAT0", input);
  }
});

test("echt onleesbare VAT-invoer wordt geweigerd", () => {
  for (const input of ["", "   ", null, "vat", "22", "vat22", "zomaar wat"]) {
    assert.equal(normalizeVatTypeInput(input), "", JSON.stringify(input));
  }
});
