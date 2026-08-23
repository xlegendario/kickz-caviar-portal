import test from "node:test";
import assert from "node:assert/strict";

import {
  buildWelcomeMessage,
  buildExistingSellerMessage,
  buildDealConfirmationMessage,
  buildRegistrationChannelMessage,
  buildSellerIdMessage
} from "../lib/onboardingMessages.js";

const SIGNUP = "https://kickzcaviar.com/signup";

test("de welkomst-DM linkt naar de deals en naar registratie", () => {
  const { description } = buildWelcomeMessage({
    username: "legendario",
    signupUrl: SIGNUP,
    dealsUrl: "https://kickzcaviar.com/"
  });

  assert.match(description, /legendario/);
  assert.ok(description.includes(SIGNUP), "signup-link ontbreekt");
  assert.match(description, /buying right now/);

  // Het Seller ID is geen drempel meer die je vooraf moet regelen: de bots
  // zoeken je voortaan op via je Discord ID.
  assert.doesNotMatch(description, /You need a/);
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

test("het kanaal-embed linkt naar de deals en naar registratie", () => {
  const { title, description } = buildRegistrationChannelMessage({
    signupUrl: SIGNUP,
    dealsUrl: "https://kickzcaviar.com/"
  });

  assert.match(title, /Become a Seller/);
  assert.ok(description.includes(SIGNUP), "signup-link ontbreekt");
  assert.match(description, /buying right now/);

  // "Seller ID Check" staat op de knop, niet meer in de tekst: je hebt het ID
  // niet langer nodig om te dealen, dus het hoort niet in de uitleg thuis.
  assert.doesNotMatch(description, /you need a Seller ID/i);
});

test("de Seller ID-DM noemt het ID en verwijst naar Seller ID Check", () => {
  const bericht = buildSellerIdMessage({ sellerId: "SE-00856" });

  assert.match(bericht, /SE-00856/);
  assert.match(bericht, /Seller ID Check/);
  assert.match(bericht, /Welcome aboard/);
});
