import test from "node:test";
import assert from "node:assert/strict";

import { COUNTRIES, COUNTRY_NAMES, resolveCountry, isValidCountry } from "../lib/countries.js";

test("lijst telt 31 landen, exact de EU-27 plus vier niet-EU", () => {
  assert.equal(COUNTRIES.length, 31);
  assert.equal(COUNTRIES.filter((c) => c.eu).length, 27);

  assert.deepEqual(
    COUNTRIES.filter((c) => !c.eu).map((c) => c.name),
    ["Norway", "Switzerland", "United Kingdom", "Iceland"]
  );
});

test("geen dubbele namen of codes", () => {
  assert.equal(new Set(COUNTRY_NAMES).size, 31);
  assert.equal(new Set(COUNTRIES.map((c) => c.code)).size, 31);
});

test("landen die de Discord-bot miste zitten er nu wel in", () => {
  for (const naam of ["Estonia", "Ireland", "Lithuania", "Malta", "United Kingdom", "Iceland"]) {
    assert.equal(isValidCountry(naam), true, `${naam} ontbreekt`);
  }
});

test("resolveCountry geeft de canonieke schrijfwijze terug", () => {
  assert.deepEqual(resolveCountry("netherlands"), { name: "Netherlands", code: "NL", eu: true });
  assert.deepEqual(resolveCountry("  CZECH REPUBLIC "), {
    name: "Czech Republic",
    code: "CZ",
    eu: true
  });
});

test("rommel wordt geweigerd in plaats van doorgelaten", () => {
  for (const rommel of ["", "  ", null, undefined, "Nederland", "Holland", "USA", "NL"]) {
    assert.equal(resolveCountry(rommel), null, `${JSON.stringify(rommel)} werd geaccepteerd`);
  }
});
