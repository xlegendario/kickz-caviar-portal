import test from "node:test";
import assert from "node:assert/strict";

import { normalizeRefCode, shouldAttribute, planQualifications } from "../lib/referral.js";

test("geldige invite codes komen er ongewijzigd door", () => {
  assert.equal(normalizeRefCode("aE4j7T8a"), "aE4j7T8a");
  assert.equal(normalizeRefCode("  aE4j7T8a  "), "aE4j7T8a");
  assert.equal(normalizeRefCode("abc-123_XYZ"), "abc-123_XYZ");
});

test("alles wat geen invite code is wordt weggegooid", () => {
  for (const rommel of ["", "   ", null, undefined, "kort maar met spaties", "../../etc", "<script>", "a".repeat(33)]) {
    assert.equal(normalizeRefCode(rommel), "", JSON.stringify(rommel));
  }
});

test("een normale referral wordt vastgelegd", () => {
  const result = shouldAttribute({
    inviteeDiscordId: "111",
    inviterDiscordId: "222",
    existingInviterId: ""
  });

  assert.deepEqual(result, { attribute: true, reason: "" });
});

test("jezelf uitnodigen telt niet", () => {
  const result = shouldAttribute({
    inviteeDiscordId: "111",
    inviterDiscordId: "111",
    existingInviterId: ""
  });

  assert.equal(result.attribute, false);
  assert.equal(result.reason, "self_referral");
});

test("een bestaande uitnodiger wordt nooit overschreven", () => {
  // Anders kan iemand een tweede ref-link sturen en de credit van een ander
  // overnemen.
  const result = shouldAttribute({
    inviteeDiscordId: "111",
    inviterDiscordId: "333",
    existingInviterId: "222"
  });

  assert.equal(result.attribute, false);
  assert.equal(result.reason, "already_attributed");
});

test("een onbekende ref-code levert geen attributie op", () => {
  const result = shouldAttribute({
    inviteeDiscordId: "111",
    inviterDiscordId: "",
    existingInviterId: ""
  });

  assert.equal(result.attribute, false);
  assert.equal(result.reason, "unknown_ref_code");
});

test("kwalificeren gebeurt alleen bij een Inventory Unit", () => {
  const ids = planQualifications([
    { logId: "recA", qualified: false, hasInventoryUnit: true },
    { logId: "recB", qualified: false, hasInventoryUnit: false },
    { logId: "recC", qualified: undefined, hasInventoryUnit: true }
  ]);

  assert.deepEqual(ids, ["recA", "recC"]);
});

test("al gekwalificeerde rijen worden niet opnieuw aangeraakt", () => {
  const ids = planQualifications([
    { logId: "recA", qualified: true, hasInventoryUnit: true },
    { logId: "recB", qualified: true, hasInventoryUnit: false }
  ]);

  assert.deepEqual(ids, []);
});

test("een aanmelding zonder deal kwalificeert niet", () => {
  // Dit is precies het onderscheid dat Dario wilde: iemand die zich registreert
  // en Discord koppelt is nog geen deal. Pas een Inventory Unit op zijn
  // Seller ID telt.
  const ids = planQualifications([{ logId: "recA", qualified: false, hasInventoryUnit: false }]);

  assert.deepEqual(ids, []);
});
