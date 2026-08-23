// lib/countries.js
//
// De canonieke landenlijst voor seller-registratie.
//
// Er liepen drie lijsten door elkaar: de Discord-bot bood er 25 aan (beperkt
// door de optielimiet van een Discord-dropdown), het Airtable-veld `Country
// Code` kent er 31 en `Sellers VAT Rate` dekt er 27. De 31 hieronder komen
// exact overeen met de SWITCH in `Country Code` — dat veld wordt in code
// gebruikt (label-routing), dus een land dat daar ontbreekt loopt stuk.
//
// `eu: false` markeert de vier niet-EU landen. Die krijgen in `Sellers VAT
// Rate` bewust 0: een levering vanuit die landen is import, geen
// intracommunautaire levering, dus het binnenlandse tarief van de seller is
// niet wat telt.

export const COUNTRIES = [
  { name: "Austria", code: "AT", eu: true },
  { name: "Belgium", code: "BE", eu: true },
  { name: "Bulgaria", code: "BG", eu: true },
  { name: "Croatia", code: "HR", eu: true },
  { name: "Cyprus", code: "CY", eu: true },
  { name: "Czech Republic", code: "CZ", eu: true },
  { name: "Denmark", code: "DK", eu: true },
  { name: "Estonia", code: "EE", eu: true },
  { name: "Finland", code: "FI", eu: true },
  { name: "France", code: "FR", eu: true },
  { name: "Germany", code: "DE", eu: true },
  { name: "Greece", code: "GR", eu: true },
  { name: "Hungary", code: "HU", eu: true },
  { name: "Ireland", code: "IE", eu: true },
  { name: "Italy", code: "IT", eu: true },
  { name: "Latvia", code: "LV", eu: true },
  { name: "Lithuania", code: "LT", eu: true },
  { name: "Luxembourg", code: "LU", eu: true },
  { name: "Malta", code: "MT", eu: true },
  { name: "Netherlands", code: "NL", eu: true },
  { name: "Poland", code: "PL", eu: true },
  { name: "Portugal", code: "PT", eu: true },
  { name: "Romania", code: "RO", eu: true },
  { name: "Slovakia", code: "SK", eu: true },
  { name: "Slovenia", code: "SI", eu: true },
  { name: "Spain", code: "ES", eu: true },
  { name: "Sweden", code: "SE", eu: true },
  { name: "Norway", code: "NO", eu: false },
  { name: "Switzerland", code: "CH", eu: false },
  { name: "United Kingdom", code: "GB", eu: false },
  { name: "Iceland", code: "IS", eu: false }
];

export const COUNTRY_NAMES = COUNTRIES.map((c) => c.name);

const BY_NAME = new Map(COUNTRIES.map((c) => [c.name.toLowerCase(), c]));

// De registratie is een dropdown, maar een POST kan alles bevatten. Elke
// route die een land aanneemt moet dit door deze functie halen: geeft het
// canonieke land terug of null. Nooit de rauwe invoer naar Airtable schrijven —
// `Country` is daar singleLineText, dus typefouten worden stil geaccepteerd en
// laten `Country Code` leeg, wat de label-routing breekt.
export function resolveCountry(input) {
  const key = String(input ?? "").trim().toLowerCase();
  if (!key) return null;

  return BY_NAME.get(key) ?? null;
}

export function isValidCountry(input) {
  return resolveCountry(input) !== null;
}
