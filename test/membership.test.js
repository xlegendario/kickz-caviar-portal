import test from "node:test";
import assert from "node:assert/strict";

import { planMembershipChanges, isReconcileSafe } from "../lib/membership.js";

const rij = (discordUserId, inServer) => ({ id: "rec" + discordUserId, discordUserId, inServer });

test("wie weg is wordt gemarkeerd, wie terug is ook", () => {
  const { toMarkLeft, toMarkRejoined } = planMembershipChanges({
    guildMemberIds: ["1", "3"],
    airtableRows: [rij("1", true), rij("2", true), rij("3", false)]
  });

  assert.deepEqual(toMarkLeft.map((r) => r.discordUserId), ["2"]);
  assert.deepEqual(toMarkRejoined.map((r) => r.discordUserId), ["3"]);
});

test("records die al kloppen worden niet aangeraakt", () => {
  const { toMarkLeft, toMarkRejoined } = planMembershipChanges({
    guildMemberIds: ["1", "2"],
    airtableRows: [rij("1", true), rij("2", true), rij("9", false)]
  });

  assert.equal(toMarkLeft.length, 0);
  assert.equal(toMarkRejoined.length, 0);
});

test("een uitgevinkte checkbox komt als undefined terug en telt als in-server", () => {
  // Airtable laat een uitgevinkte checkbox weg uit fields. Zonder deze
  // aanname zou elke bestaande rij als 'was al weg' gelden en zou de reconcile
  // ze allemaal als rejoin behandelen.
  const { toMarkLeft, toMarkRejoined } = planMembershipChanges({
    guildMemberIds: ["1"],
    airtableRows: [
      { id: "recA", discordUserId: "1", inServer: undefined },
      { id: "recB", discordUserId: "2", inServer: undefined }
    ]
  });

  assert.deepEqual(toMarkLeft.map((r) => r.discordUserId), ["2"]);
  assert.equal(toMarkRejoined.length, 0);
});

test("rijen zonder Discord ID worden overgeslagen", () => {
  const { toMarkLeft } = planMembershipChanges({
    guildMemberIds: ["1"],
    airtableRows: [{ id: "recX", discordUserId: "", inServer: true }, { id: "recY", discordUserId: "   ", inServer: true }]
  });

  assert.equal(toMarkLeft.length, 0);
});

test("witruimte in ID's breekt de vergelijking niet", () => {
  const { toMarkLeft } = planMembershipChanges({
    guildMemberIds: [" 1 ", "2"],
    airtableRows: [rij("1", true), rij("2", true)]
  });

  assert.equal(toMarkLeft.length, 0);
});

test("een lege ledenlijst wordt geweigerd, niet uitgevoerd", () => {
  // Zonder deze rem zou een mislukte fetch de hele database op 'vertrokken'
  // zetten en kon niemand meer bieden.
  const result = isReconcileSafe({ fetchedCount: 0, knownInServerCount: 400 });

  assert.equal(result.safe, false);
  assert.match(result.reason, /returned nothing/);
});

test("een verdacht kleine ledenlijst wordt geweigerd", () => {
  const result = isReconcileSafe({ fetchedCount: 120, knownInServerCount: 400 });

  assert.equal(result.safe, false);
  assert.match(result.reason, /partial fetch/);
});

test("een normale daling gaat gewoon door", () => {
  assert.equal(isReconcileSafe({ fetchedCount: 380, knownInServerCount: 400 }).safe, true);
  assert.equal(isReconcileSafe({ fetchedCount: 201, knownInServerCount: 400 }).safe, true);
});

test("de eerste run heeft niets om mee te vergelijken en mag altijd", () => {
  assert.equal(isReconcileSafe({ fetchedCount: 5, knownInServerCount: 0 }).safe, true);
});

test("groei is nooit verdacht", () => {
  assert.equal(isReconcileSafe({ fetchedCount: 900, knownInServerCount: 400 }).safe, true);
});
