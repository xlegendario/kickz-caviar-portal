import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAuthorizeUrl,
  exchangeCode,
  fetchDiscordUser,
  joinGuild,
  OAUTH_SCOPES
} from "../lib/discordOauth.js";

function fakeResponse({ status = 200, json, text = "" }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => json,
    text: async () => text
  };
}

test("authorize-URL bevat de juiste scopes en redirect", () => {
  const url = new URL(
    buildAuthorizeUrl({
      clientId: "942785648048353370",
      redirectUri: "https://kickzcaviar.com/auth/discord/callback",
      state: "abc.def"
    })
  );

  assert.equal(url.origin + url.pathname, "https://discord.com/oauth2/authorize");
  assert.equal(url.searchParams.get("client_id"), "942785648048353370");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("scope"), "identify guilds.join");
  assert.equal(url.searchParams.get("state"), "abc.def");
  assert.equal(
    url.searchParams.get("redirect_uri"),
    "https://kickzcaviar.com/auth/discord/callback"
  );
});

test("prompt=consent staat aan zodat een herkoppeling opnieuw guilds.join oplevert", () => {
  const url = new URL(
    buildAuthorizeUrl({ clientId: "1", redirectUri: "https://x/cb", state: "s" })
  );

  assert.equal(url.searchParams.get("prompt"), "consent");
});

test("code-exchange geeft het access token terug", async () => {
  let captured;

  const accessToken = await exchangeCode({
    clientId: "1",
    clientSecret: "geheim",
    code: "CODE",
    redirectUri: "https://x/cb",
    fetchImpl: async (url, opts) => {
      captured = { url, opts };
      return fakeResponse({
        json: { access_token: "AT", scope: OAUTH_SCOPES.join(" ") }
      });
    }
  });

  assert.equal(accessToken.accessToken, "AT");
  assert.equal(captured.url, "https://discord.com/api/v10/oauth2/token");
  assert.match(captured.opts.body, /grant_type=authorization_code/);
  assert.match(captured.opts.body, /code=CODE/);
});

test("geweigerde guilds.join scope wordt meteen als fout gemeld", async () => {
  await assert.rejects(
    exchangeCode({
      clientId: "1",
      clientSecret: "geheim",
      code: "CODE",
      redirectUri: "https://x/cb",
      fetchImpl: async () => fakeResponse({ json: { access_token: "AT", scope: "identify" } })
    }),
    /did not grant required scopes: guilds\.join/
  );
});

test("mislukte exchange geeft een leesbare fout", async () => {
  await assert.rejects(
    exchangeCode({
      clientId: "1",
      clientSecret: "fout",
      code: "CODE",
      redirectUri: "https://x/cb",
      fetchImpl: async () =>
        fakeResponse({ status: 401, text: '{"error":"invalid_client"}' })
    }),
    /token exchange failed \(401\).*invalid_client/
  );
});

test("gebruiker ophalen normaliseert username en display name", async () => {
  const user = await fetchDiscordUser({
    accessToken: "AT",
    fetchImpl: async () =>
      fakeResponse({ json: { id: "123", username: "legendario", global_name: "Legendario" } })
  });

  assert.deepEqual(user, { id: "123", username: "legendario", displayName: "Legendario" });
});

test("gebruiker zonder global_name valt terug op username", async () => {
  const user = await fetchDiscordUser({
    accessToken: "AT",
    fetchImpl: async () => fakeResponse({ json: { id: "123", username: "solo" } })
  });

  assert.equal(user.displayName, "solo");
});

test("join: 201 telt als toegevoegd, 204 als al lid", async () => {
  const nieuw = await joinGuild({
    botToken: "BOT",
    guildId: "922818998163361792",
    userId: "123",
    accessToken: "AT",
    fetchImpl: async () => fakeResponse({ status: 201 })
  });

  assert.deepEqual(nieuw, { joined: true, alreadyMember: false });

  const bestaand = await joinGuild({
    botToken: "BOT",
    guildId: "922818998163361792",
    userId: "123",
    accessToken: "AT",
    fetchImpl: async () => fakeResponse({ status: 204 })
  });

  assert.deepEqual(bestaand, { joined: true, alreadyMember: true });
});

test("join stuurt het bot-token en het access token mee", async () => {
  let captured;

  await joinGuild({
    botToken: "BOT",
    guildId: "GUILD",
    userId: "123",
    accessToken: "AT",
    fetchImpl: async (url, opts) => {
      captured = { url, opts };
      return fakeResponse({ status: 201 });
    }
  });

  assert.equal(captured.url, "https://discord.com/api/v10/guilds/GUILD/members/123");
  assert.equal(captured.opts.method, "PUT");
  assert.equal(captured.opts.headers.Authorization, "Bot BOT");
  assert.deepEqual(JSON.parse(captured.opts.body), { access_token: "AT" });
});

test("join zonder Create Invite-recht geeft een 403 met detail", async () => {
  await assert.rejects(
    joinGuild({
      botToken: "BOT",
      guildId: "GUILD",
      userId: "123",
      accessToken: "AT",
      fetchImpl: async () =>
        fakeResponse({ status: 403, text: '{"message":"Missing Permissions"}' })
    }),
    /Failed to add user to guild \(403\).*Missing Permissions/
  );
});
