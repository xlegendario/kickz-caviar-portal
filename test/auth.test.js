import test from "node:test";
import assert from "node:assert/strict";
import express from "express";

import {
  hashPassword,
  verifyPassword,
  signSession,
  verifySession,
  sellerIdentityGuard,
  requireSeller
} from "../lib/auth.js";

const SECRET = "test-secret";

function buildApp(guardOpts = {}) {
  const app = express();
  app.use(express.json());
  app.use(
    sellerIdentityGuard({
      secret: SECRET,
      mode: "strict",
      allowPaths: ["/api/make/", "/api/internal/"],
      ...guardOpts
    })
  );

  app.post("/api/place-offer", (req, res) => {
    res.json({ sellerRecordId: req.body.sellerRecordId ?? null });
  });

  app.post("/api/make/hook", (req, res) => {
    res.json({ sellerRecordId: req.body.sellerRecordId ?? null });
  });

  app.post("/api/me", requireSeller(SECRET), (req, res) => {
    res.json({ rid: req.sellerSession.rid });
  });

  return app;
}

function listen(app, t) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      t.after(() => {
        server.closeAllConnections();
        server.close();
      });
      resolve(server);
    });
  });
}

async function post(server, path, body, headers = {}) {
  const { port } = server.address();

  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Connection: "close", ...headers },
    body: JSON.stringify(body)
  });

  return { status: res.status, body: await res.json().catch(() => null) };
}

function cookieFor(rid) {
  const token = signSession({ rid, exp: Date.now() + 60_000 }, SECRET);
  return { Cookie: `kc_session=${encodeURIComponent(token)}` };
}

test("wachtwoord: scrypt-hash valideert en weigert correct", () => {
  const stored = hashPassword("correct horse");

  assert.equal(verifyPassword("correct horse", stored).ok, true);
  assert.equal(verifyPassword("Correct horse", stored).ok, false);
  assert.equal(verifyPassword("", stored).ok, false);
});

test("wachtwoord: oud plain-text formaat werkt nog en vraagt om rehash", () => {
  assert.deepEqual(verifyPassword("hunter2", "hunter2"), { ok: true, needsRehash: true });
  assert.deepEqual(verifyPassword("hunter3", "hunter2"), { ok: false, needsRehash: false });
});

test("wachtwoord: leeg opgeslagen wachtwoord logt nooit in", () => {
  assert.equal(verifyPassword("", "").ok, false);
  assert.equal(verifyPassword("wat dan ook", "").ok, false);
});

test("sessie: geldig token komt terug, gemanipuleerd token niet", () => {
  const token = signSession({ rid: "recAAA", exp: Date.now() + 60_000 }, SECRET);

  assert.equal(verifySession(token, SECRET).rid, "recAAA");
  assert.equal(verifySession(token, "ander-secret"), null);
  assert.equal(verifySession(token.slice(0, -2) + "xx", SECRET), null);
});

test("sessie: verlopen token wordt geweigerd", () => {
  const token = signSession({ rid: "recAAA", exp: Date.now() - 1 }, SECRET);
  assert.equal(verifySession(token, SECRET), null);
});

test("guard: zonder sessie is offeren geblokkeerd", async (t) => {
  const server = await listen(buildApp(), t);

  const res = await post(server, "/api/place-offer", { sellerRecordId: "recSLACHTOFFER" });

  assert.equal(res.status, 401);
});

test("guard: identiteit uit de body wordt overschreven door de sessie", async (t) => {
  const server = await listen(buildApp(), t);

  const res = await post(
    server,
    "/api/place-offer",
    { sellerRecordId: "recSLACHTOFFER" },
    cookieFor("recIKZELF")
  );

  assert.equal(res.status, 200);
  assert.equal(res.body.sellerRecordId, "recIKZELF");
});

test("guard: routes zonder seller-identiteit blijven publiek", async (t) => {
  const server = await listen(buildApp(), t);

  const res = await post(server, "/api/place-offer", { orderRecordId: "recORDER" });

  assert.equal(res.status, 200);
});

test("guard: Make/interne paden blijven doorgaan zonder sessie", async (t) => {
  const server = await listen(buildApp(), t);

  const res = await post(server, "/api/make/hook", { sellerRecordId: "recX" }, {});

  assert.equal(res.status, 200);
  assert.equal(res.body.sellerRecordId, "recX");
});

test("guard: x-kc-secret laat bots hun eigen seller meesturen", async (t) => {
  const server = await listen(buildApp({ serviceSecrets: ["s3rv1ce"] }), t);

  const res = await post(
    server,
    "/api/place-offer",
    { sellerRecordId: "recBOT" },
    { "x-kc-secret": "s3rv1ce" }
  );

  assert.equal(res.status, 200);
  assert.equal(res.body.sellerRecordId, "recBOT");
});

test("guard: verkeerd x-kc-secret telt niet als sessie", async (t) => {
  const server = await listen(buildApp({ serviceSecrets: ["s3rv1ce"] }), t);

  const res = await post(
    server,
    "/api/place-offer",
    { sellerRecordId: "recBOT" },
    { "x-kc-secret": "fout" }
  );

  assert.equal(res.status, 401);
});

test("guard: warn-modus logt wel maar blokkeert niet", async (t) => {
  const server = await listen(buildApp({ mode: "warn" }), t);

  const res = await post(server, "/api/place-offer", { sellerRecordId: "recSLACHTOFFER" });

  assert.equal(res.status, 200);
  assert.equal(res.body.sellerRecordId, "recSLACHTOFFER");
});

test("requireSeller: beschermt nieuwe routes", async (t) => {
  const server = await listen(buildApp(), t);

  const zonder = await post(server, "/api/me", {});
  assert.equal(zonder.status, 401);

  const met = await post(server, "/api/me", {}, cookieFor("recIKZELF"));
  assert.equal(met.status, 200);
  assert.equal(met.body.rid, "recIKZELF");

});
