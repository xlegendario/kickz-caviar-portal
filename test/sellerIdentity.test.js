import test from "node:test";
import assert from "node:assert/strict";

import { isBuyerOfMemberWtb, rankSellersSharingEmail, strictSellerIdentity } from "../lib/sellerIdentity.js";

const SECRETS = [undefined, "service-secret", ""];

test("a session decides who acts, whatever the request claims", () => {
  assert.deepEqual(
    strictSellerIdentity({ sessionRecordId: "recME", askedRecordId: "recVICTIM", trustedSecrets: SECRETS }),
    { sellerRecordId: "recME" }
  );
});

test("a trusted service may act for the seller it names", () => {
  assert.deepEqual(
    strictSellerIdentity({ presentedSecret: "service-secret", askedRecordId: "recSTORE", trustedSecrets: SECRETS }),
    { sellerRecordId: "recSTORE" }
  );
});

test("without a session or a valid secret there is no fallback to the claimed seller", () => {
  const refused = [
    { askedRecordId: "recVICTIM" },
    { presentedSecret: "wrong", askedRecordId: "recVICTIM" },
    { presentedSecret: "service-secre", askedRecordId: "recVICTIM" },
    { presentedSecret: "", askedRecordId: "recVICTIM" },
    { presentedSecret: "service-secret" }
  ];

  for (const input of refused) {
    assert.equal(strictSellerIdentity({ trustedSecrets: SECRETS, ...input }).status, 401, JSON.stringify(input));
  }
});

test("an empty secret in the configuration never matches an empty header", () => {
  assert.equal(strictSellerIdentity({ presentedSecret: "", askedRecordId: "recX", trustedSecrets: ["", undefined] }).status, 401);
});

test("a Member WTB belongs to the buyers on its link field, and only them", () => {
  const record = { fields: { "Buyer Seller ID": ["recBUYER"] } };

  assert.equal(isBuyerOfMemberWtb(record, "recBUYER"), true);
  assert.equal(isBuyerOfMemberWtb(record, "recOTHER"), false);
  assert.equal(isBuyerOfMemberWtb(record, ""), false);
  assert.equal(isBuyerOfMemberWtb({ fields: {} }, "recBUYER"), false);
  assert.equal(isBuyerOfMemberWtb(null, "recBUYER"), false);
});

test("one email, two profiles: the one with Discord signs in, not the first Airtable returns", () => {
  const ranked = rankSellersSharingEmail([
    { seller_id: "SE-00282", discord_id: "" },
    { seller_id: "SE-00814", discord_id: "764941839773466654" }
  ]);

  assert.deepEqual(ranked.map((s) => s.seller_id), ["SE-00814", "SE-00282"]);
});

test("profiles alike on Discord: the newest Seller ID first", () => {
  const ranked = rankSellersSharingEmail([
    { seller_id: "SE-00133", discord_id: "1" },
    { seller_id: "SE-00675", discord_id: "2" },
    { seller_id: "SE-00009", discord_id: "" }
  ]);

  assert.deepEqual(ranked.map((s) => s.seller_id), ["SE-00675", "SE-00133", "SE-00009"]);
});
