import test from "node:test";
import assert from "node:assert/strict";

import { brokerReminderDue, buildBrokerDealAlert } from "../lib/brokerDealAlert.js";

const HOUR = 3600 * 1000;
const NOW = Date.parse("2026-11-19T12:00:00Z");

const parked = {
  source_type: "external_sale",
  status: "partner_agreed",
  order_id: "EXTD-000173",
  product_name: "ASICS Gel-NYC Cream Grey",
  sku: "1203A739-100",
  size: "48",
  seller_id: "SE-00930",
  offer_price: 88,
  vat_type: "VAT0"
};

test("reminder is due inside the last hours of the clock", () => {
  assert.equal(brokerReminderDue(parked, NOW + 3 * HOUR, NOW), true);
});

test("no reminder while there is plenty of time", () => {
  assert.equal(brokerReminderDue(parked, NOW + 10 * HOUR, NOW), false);
});

test("no reminder once the deadline has passed - the sweep ends it", () => {
  assert.equal(brokerReminderDue(parked, NOW - 1, NOW), false);
});

test("reminded once only", () => {
  assert.equal(
    brokerReminderDue({ ...parked, broker_reminder_sent_at: "2026-11-19T11:00:00Z" }, NOW + HOUR, NOW),
    false
  );
});

test("only broker rounds that are parked", () => {
  assert.equal(brokerReminderDue({ ...parked, source_type: "member_wtb" }, NOW + HOUR, NOW), false);
  assert.equal(brokerReminderDue({ ...parked, status: "open" }, NOW + HOUR, NOW), false);
});

test("the agreed message names the deal, the pair and the deadline", () => {
  const deadline = NOW + 24 * HOUR;
  const body = buildBrokerDealAlert({ kind: "agreed", offer: parked, buyerName: "Allegrini", deadlineMs: deadline });

  assert.match(body.content, /EXTD-000173/);
  assert.match(body.content, /agreed/);

  const values = body.embeds[0].fields.map((field) => field.value).join("\n");

  assert.match(values, /ASICS Gel-NYC Cream Grey · 48/);
  assert.match(values, /€ 88,00 · VAT0/);
  assert.match(values, /Allegrini/);
  assert.match(values, new RegExp(`<t:${Math.floor(deadline / 1000)}:R>`));
});

test("the reminder reads differently", () => {
  const body = buildBrokerDealAlert({ kind: "reminder", offer: parked, deadlineMs: NOW + HOUR });

  assert.match(body.content, /expires soon/);
  assert.equal(body.embeds[0].title, "Broker deal about to expire");
});
