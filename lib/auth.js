// lib/auth.js
//
// Sessie- en wachtwoordlaag voor de Seller Portal.
//
// Twee problemen die dit oplost:
//
//  1. IMPERSONATIE. Endpoints als /api/place-offer en /api/claim-deal namen
//     `sellerRecordId` rechtstreeks uit de request body over. Er was geen
//     enkele controle dat de aanroeper ook echt die seller was — met een
//     record ID kon iedereen namens een willekeurige seller bieden. Zodra de
//     publieke order-pagina live gaat is dat een open deur. `sellerIdentityGuard`
//     overschrijft de identiteit in de body met die uit de sessiecookie, in
//     één plek, zodat de ~550 bestaande verwijzingen ongemoeid kunnen blijven.
//
//  2. PLAIN-TEXT WACHTWOORDEN. "Portal Password" stond leesbaar in Airtable en
//     werd met === vergeleken. Hieronder scrypt (Node stdlib, geen extra
//     dependency) met transparante migratie: bij de eerste succesvolle login
//     met een oud plain-text wachtwoord wordt de hash teruggeschreven.

import crypto from "crypto";

const SESSION_COOKIE = "kc_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 dagen

const SCRYPT_N = 16384;
const SCRYPT_r = 8;
const SCRYPT_p = 1;
const SCRYPT_KEYLEN = 64;

/* ---------------- wachtwoorden ---------------- */

export function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(plain), salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_r,
    p: SCRYPT_p
  });

  return [
    "scrypt",
    SCRYPT_N,
    SCRYPT_r,
    SCRYPT_p,
    salt.toString("base64"),
    hash.toString("base64")
  ].join("$");
}

// Geeft { ok, needsRehash } terug. needsRehash is true wanneer het opgeslagen
// wachtwoord nog het oude plain-text formaat had, zodat de aanroeper de
// gemigreerde hash kan wegschrijven.
export function verifyPassword(plain, stored) {
  const supplied = String(plain ?? "");
  const current = String(stored ?? "");

  if (!current) return { ok: false, needsRehash: false };

  if (!current.startsWith("scrypt$")) {
    // Legacy: plain-text vergelijking, wel timing-safe.
    return {
      ok: timingSafeEqualString(supplied, current),
      needsRehash: timingSafeEqualString(supplied, current)
    };
  }

  const [, nRaw, rRaw, pRaw, saltB64, hashB64] = current.split("$");
  const salt = Buffer.from(String(saltB64), "base64");
  const expected = Buffer.from(String(hashB64), "base64");

  let actual;
  try {
    actual = crypto.scryptSync(supplied, salt, expected.length, {
      N: Number(nRaw),
      r: Number(rRaw),
      p: Number(pRaw)
    });
  } catch {
    return { ok: false, needsRehash: false };
  }

  return {
    ok: actual.length === expected.length && crypto.timingSafeEqual(actual, expected),
    needsRehash: false
  };
}

function timingSafeEqualString(a, b) {
  const bufA = Buffer.from(String(a), "utf8");
  const bufB = Buffer.from(String(b), "utf8");

  // timingSafeEqual eist gelijke lengtes; hash eerst zodat de lengte van het
  // opgeslagen wachtwoord niet uitlekt.
  const digestA = crypto.createHash("sha256").update(bufA).digest();
  const digestB = crypto.createHash("sha256").update(bufB).digest();

  return crypto.timingSafeEqual(digestA, digestB);
}

/* ---------------- sessietokens ---------------- */

function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

export function signSession(payload, secret) {
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(crypto.createHmac("sha256", String(secret)).update(body).digest());

  return `${body}.${sig}`;
}

export function verifySession(token, secret) {
  const raw = String(token || "");
  const dot = raw.indexOf(".");

  if (dot <= 0) return null;

  const body = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);

  const expected = b64url(
    crypto.createHmac("sha256", String(secret)).update(body).digest()
  );

  const sigBuf = Buffer.from(sig, "utf8");
  const expBuf = Buffer.from(expected, "utf8");

  if (sigBuf.length !== expBuf.length) return null;
  if (!crypto.timingSafeEqual(sigBuf, expBuf)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  if (!payload?.exp || Date.now() > Number(payload.exp)) return null;

  return payload;
}

/* ---------------- cookies ---------------- */

export function parseCookies(header) {
  const out = {};

  for (const part of String(header || "").split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;

    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();

    if (key) out[key] = decodeURIComponent(value);
  }

  return out;
}

export function setSessionCookie(res, payload, { secret, secure }) {
  const token = signSession(
    { ...payload, exp: Date.now() + SESSION_TTL_MS },
    secret
  );

  const attrs = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
  ];

  if (secure) attrs.push("Secure");

  appendSetCookie(res, attrs.join("; "));
}

export function clearSessionCookie(res, { secure } = {}) {
  const attrs = [
    `${SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0"
  ];

  if (secure) attrs.push("Secure");

  appendSetCookie(res, attrs.join("; "));
}

function appendSetCookie(res, value) {
  const existing = res.getHeader("Set-Cookie");

  if (!existing) {
    res.setHeader("Set-Cookie", value);
    return;
  }

  res.setHeader(
    "Set-Cookie",
    Array.isArray(existing) ? [...existing, value] : [existing, value]
  );
}

export function readSession(req, secret) {
  const cookies = parseCookies(req.headers?.cookie);
  return verifySession(cookies[SESSION_COOKIE], secret);
}

export { SESSION_COOKIE };

/* ---------------- identiteits-guard ---------------- */

// Pint de seller-identiteit in de request body vast op de ingelogde sessie.
// Eén middleware in plaats van ~550 losse call sites aanpassen: elke route die
// `sellerRecordId` / `seller_record_id` uit de body leest, krijgt vanaf hier
// gegarandeerd de sessie-identiteit — of een 401.
//
// mode "warn"   → logt alleen wat er geblokkeerd zóu worden (voor de testfase)
// mode "strict" → weigert daadwerkelijk (aanzetten vóór de publieke pagina live gaat)
export function sellerIdentityGuard({
  secret,
  mode = "warn",
  allowPaths = [],
  serviceSecrets = []
}) {
  // De portal valideerde de header x-kc-secret al op ~29 routes, tegen drie
  // verschillende env-secrets. Die conventie hergebruiken we hier in plaats van
  // er een vierde naast te zetten.
  const knownSecrets = serviceSecrets.map((s) => String(s || "")).filter(Boolean);
  const IDENTITY_KEYS = ["sellerRecordId", "seller_record_id"];

  return function guard(req, res, next) {
    const session = readSession(req, secret);
    req.sellerSession = session || null;

    const body = req.body;

    if (!body || typeof body !== "object" || Array.isArray(body)) return next();

    const present = IDENTITY_KEYS.filter((k) => k in body);
    if (!present.length) return next();

    // Service-to-service (Make, de Discord-bots) mag zichzelf identificeren.
    const presented = String(req.get("x-kc-secret") || "");
    if (presented && knownSecrets.some((s) => timingSafeEqualString(presented, s))) {
      return next();
    }
    if (allowPaths.some((p) => req.path.startsWith(p))) return next();

    const claimed = present.map((k) => String(body[k] ?? "").trim()).filter(Boolean);

    if (!session?.rid) {
      if (mode === "strict") {
        return res.status(401).json({ error: "Not signed in" });
      }

      if (claimed.length) {
        console.warn(
          `[auth:warn] ${req.method} ${req.path} — geen sessie, body claimt ${claimed.join(", ")}`
        );
      }

      return next();
    }

    for (const key of present) {
      const value = String(body[key] ?? "").trim();

      if (value && value !== session.rid) {
        console.warn(
          `[auth] ${req.method} ${req.path} — body claimde ${value}, sessie is ${session.rid}; gepind op sessie`
        );
      }

      body[key] = session.rid;
    }

    return next();
  };
}

// Voor nieuwe routes (offer-pagina, registratie) die simpelweg een ingelogde
// seller vereisen.
export function requireSeller(secret) {
  return function require(req, res, next) {
    const session = req.sellerSession ?? readSession(req, secret);

    if (!session?.rid) {
      return res.status(401).json({ error: "Not signed in" });
    }

    req.sellerSession = session;
    return next();
  };
}
