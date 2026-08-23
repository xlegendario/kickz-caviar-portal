import test from "node:test";
import assert from "node:assert/strict";

import {
  buildWelcomeMessage,
  buildExistingSellerMessage,
  buildDealConfirmationMessage,
  buildRegistrationChannelMessage
} from "../lib/onboardingMessages.js";

const SIGNUP = "https://kickzcaviar.com/signup";

test("de welkomst-DM stuurt naar de portal, niet naar een Discord-knop", () => {
  const { description } = buildWelcomeMessage({ username: "legendario", signupUrl: SIGNUP });

  assert.match(description, /legendario/);
  assert.match(description, new RegExp(SIGNUP.replace(/\//g, "\\/")));
  // De oude flow ("klik SIGN UP hieronder") bestaat niet meer; als die tekst
  // terugkomt stuurt hij mensen naar een knop die niemand meer afhandelt.
  assert.doesNotMatch(description, /SIGN UP below|click \*\*SIGN UP\*\*/i);
});

test("bestaande seller krijgt zijn Seller ID en de optionele velden alleen als ze er zijn", () => {
  const volledig = buildExistingSellerMessage({
    username: "jan",
    sellerId: "SE-00044",
    email: "jan@example.com",
    orderId: "ORD-1",
    inviteUrl: "https://discord.gg/x"
  });

  assert.match(volledig, /SE-00044/);
  assert.match(volledig, /jan@example\.com/);
  assert.match(volledig, /ORD-1/);
  assert.match(volledig, /discord\.gg\/x/);

  const kaal = buildExistingSellerMessage({ username: "jan", sellerId: "SE-00044" });

  assert.match(kaal, /SE-00044/);
  assert.doesNotMatch(kaal, /registered on/);
  assert.doesNotMatch(kaal, /This message is about order/);
  assert.doesNotMatch(kaal, /Click here/);
});

test("dealbevestiging toont alleen de regels die gevuld zijn", () => {
  const volledig = buildDealConfirmationMessage({
    name: "Jan",
    sellerId: "SE-1",
    orderId: "ORD-9",
    sku: "FZ8117-204",
    size: "42",
    payout: 250,
    orderDate: "2026-08-23"
  });

  assert.match(volledig, /\*\*Deal Summary\*\*/);
  assert.match(volledig, /FZ8117-204/);
  assert.match(volledig, /€250/);

  const kaal = buildDealConfirmationMessage({ name: "Jan", sellerId: "SE-1" });

  assert.doesNotMatch(kaal, /Deal Summary/);
  assert.match(kaal, /SE-1/);
});

test("een payout van 0 wordt niet als regel getoond", () => {
  const bericht = buildDealConfirmationMessage({ name: "Jan", sellerId: "SE-1", payout: 0 });

  // Niet op /Payout/ matchen: "Payout by Kickz Caviar" is de merknaam en
  // staat altijd in de begroeting. Het gaat om de samenvattingsregel.
  assert.equal(bericht.includes("**Payout:**"), false);
});

test("het kanaal-embed linkt naar de portal en houdt Seller ID Check", () => {
  const { title, description } = buildRegistrationChannelMessage({ signupUrl: SIGNUP });

  assert.match(title, /Seller Registration/);
  assert.match(description, new RegExp(SIGNUP.replace(/\//g, "\\/")));
  assert.match(description, /Seller ID Check/);
});
