import test from "node:test";
import assert from "node:assert/strict";
import express from "express";

import { discordMembershipGuard } from "../lib/discordGate.js";

const LINKED = { discord_id: "123", discord_in_server: true };
const LEFT = { discord_id: "123", discord_in_server: false };
const UNLINKED = { discord_id: "", discord_in_server: true };

/**
 * The guard reads req.sellerSession, which sellerIdentityGuard sets in the
 * real app. Here a tiny stand-in puts it there so the two can be tested
 * apart - this file is about the membership decision, not about sessions.
 */
function buildApp({ mode = "strict", seller = LINKED, lookup, ...rest } = {}) {
  const app = express();

  app.use(express.json());

  app.use((req, _res, next) => {
    req.sellerSession = req.get("x-test-no-session") ? null : { rid: "recSeller" };
    next();
  });

  app.use(
    discordMembershipGuard({
      mode,
      serviceSecrets: ["service-key"],
      lookupSeller: lookup || (async () => seller),
      ...rest
    })
  );

  const ok = (_req, res) => res.json({ ok: true });

  app.post("/api/claim-deal", ok);
  app.post("/api/login", ok);
  app.post("/api/internal/resolve-sku", ok);
  app.post("/api/consignment/pre-offer/calculate", ok);
  app.get("/api/dashboard/counts", ok);

  return app;
}

async function call(app, path, { method = "POST", headers = {} } = {}) {
  const server = app.listen(0);

  try {
    const { port } = server.address();

    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: method === "GET" ? undefined : "{}"
    });

    return { status: response.status, body: await response.json().catch(() => null) };
  } finally {
    server.close();
  }
}

test("strict: a linked seller who is in the server gets through", async () => {
  const res = await call(buildApp({ seller: LINKED }), "/api/claim-deal");

  assert.equal(res.status, 200);
});

test("strict: an unlinked seller is refused, with the code the UI listens for", async () => {
  const res = await call(buildApp({ seller: UNLINKED }), "/api/claim-deal");

  assert.equal(res.status, 403);
  assert.equal(res.body.code, "discord_not_linked");
  assert.equal(res.body.reason, "not_linked");
  assert.equal(res.body.link_url, "/auth/discord");
});

test("strict: a seller who left the server is refused, and told so", async () => {
  const res = await call(buildApp({ seller: LEFT }), "/api/claim-deal");

  assert.equal(res.status, 403);
  assert.equal(res.body.reason, "left_server");
  assert.match(res.body.error, /no longer in/i);
});

test("warn: the same seller is only logged, never blocked", async () => {
  const res = await call(buildApp({ mode: "warn", seller: UNLINKED }), "/api/claim-deal");

  assert.equal(res.status, 200);
});

test("off: nothing is checked at all", async () => {
  const res = await call(buildApp({ mode: "off", seller: UNLINKED }), "/api/claim-deal");

  assert.equal(res.status, 200);
});

test("logging in is never blocked - that is the way back", async () => {
  const res = await call(buildApp({ seller: UNLINKED }), "/api/login");

  assert.equal(res.status, 200);
});

test("service to service is left alone", async () => {
  const res = await call(buildApp({ seller: UNLINKED }), "/api/internal/resolve-sku");

  assert.equal(res.status, 200);
});

test("a valid service secret skips the gate on any path", async () => {
  const res = await call(buildApp({ seller: UNLINKED }), "/api/claim-deal", {
    headers: { "x-kc-secret": "service-key" }
  });

  assert.equal(res.status, 200);
});

test("a wrong service secret does not", async () => {
  const res = await call(buildApp({ seller: UNLINKED }), "/api/claim-deal", {
    headers: { "x-kc-secret": "guess" }
  });

  assert.equal(res.status, 403);
});

test("looking at a price is not acting on one", async () => {
  const res = await call(buildApp({ seller: UNLINKED }), "/api/consignment/pre-offer/calculate");

  assert.equal(res.status, 200);
});

test("reads are never gated", async () => {
  const res = await call(buildApp({ seller: UNLINKED }), "/api/dashboard/counts", { method: "GET" });

  assert.equal(res.status, 200);
});

test("no session means there is nothing to check here", async () => {
  const res = await call(buildApp({ seller: UNLINKED }), "/api/claim-deal", {
    headers: { "x-test-no-session": "1" }
  });

  assert.equal(res.status, 200);
});

test("a failing lookup lets the request through rather than halting trade", async () => {
  const app = buildApp({
    lookup: async () => {
      throw new Error("Airtable down");
    }
  });

  const res = await call(app, "/api/claim-deal");

  assert.equal(res.status, 200);
});

test("the lookup is cached, so a burst of writes costs one call", async () => {
  let calls = 0;

  const app = buildApp({
    lookup: async () => {
      calls += 1;
      return LINKED;
    }
  });

  await call(app, "/api/claim-deal");
  await call(app, "/api/claim-deal");
  await call(app, "/api/claim-deal");

  assert.equal(calls, 1);
});

test("a seller record that cannot be found is not treated as unlinked", async () => {
  const res = await call(buildApp({ lookup: async () => null }), "/api/claim-deal");

  assert.equal(res.status, 200);
});
