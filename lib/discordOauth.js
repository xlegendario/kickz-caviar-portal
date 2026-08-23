// lib/discordOauth.js
//
// "Link Discord" in één klik: koppelt het Discord-account aan het
// Sellers Database-record én zet de seller in de server. Dat tweede komt van de
// scope `guilds.join`, waarmee we de gebruiker via de bot kunnen toevoegen
// zonder dat hij een invite hoeft aan te klikken en zonder de portal te verlaten.
//
// Alle netwerkcalls krijgen fetchImpl geïnjecteerd zodat dit zonder Discord
// getest kan worden.

const API = "https://discord.com/api/v10";

export const OAUTH_SCOPES = ["identify", "guilds.join"];

export function buildAuthorizeUrl({ clientId, redirectUri, state }) {
  const params = new URLSearchParams({
    client_id: String(clientId),
    redirect_uri: String(redirectUri),
    response_type: "code",
    scope: OAUTH_SCOPES.join(" "),
    state: String(state),
    // Zonder dit slaat Discord het toestemmingsscherm over bij een herhaalde
    // koppeling. Dat lijkt fijner, maar dan levert de flow geen access token
    // met guilds.join op wanneer de seller de scope eerder al gaf en
    // inmiddels de server verlaten heeft — precies het geval dat we willen
    // repareren.
    prompt: "consent"
  });

  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

export async function exchangeCode({
  clientId,
  clientSecret,
  code,
  redirectUri,
  fetchImpl = fetch
}) {
  const body = new URLSearchParams({
    client_id: String(clientId),
    client_secret: String(clientSecret),
    grant_type: "authorization_code",
    code: String(code),
    redirect_uri: String(redirectUri)
  });

  const res = await fetchImpl(`${API}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString()
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Discord token exchange failed (${res.status}): ${detail.slice(0, 200)}`);
  }

  const data = await res.json();

  if (!data?.access_token) {
    throw new Error("Discord token exchange returned no access_token");
  }

  const granted = String(data.scope || "").split(/\s+/).filter(Boolean);
  const missing = OAUTH_SCOPES.filter((s) => !granted.includes(s));

  // De gebruiker kan scopes weigeren. Zonder guilds.join lukt de join later
  // stil niet; dat willen we hier weten, niet drie stappen verderop.
  if (missing.length) {
    throw new Error(`Discord did not grant required scopes: ${missing.join(", ")}`);
  }

  return { accessToken: data.access_token };
}

export async function fetchDiscordUser({ accessToken, fetchImpl = fetch }) {
  const res = await fetchImpl(`${API}/users/@me`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch Discord user (${res.status})`);
  }

  const user = await res.json();

  if (!user?.id) {
    throw new Error("Discord user response had no id");
  }

  return {
    id: String(user.id),
    username: String(user.username || ""),
    displayName: String(user.global_name || user.username || "")
  };
}

// 201 = toegevoegd, 204 = zat er al in. Beide zijn succes.
export async function joinGuild({
  botToken,
  guildId,
  userId,
  accessToken,
  fetchImpl = fetch
}) {
  const res = await fetchImpl(`${API}/guilds/${guildId}/members/${userId}`, {
    method: "PUT",
    headers: {
      Authorization: `Bot ${botToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ access_token: accessToken })
  });

  if (res.status === 201) return { joined: true, alreadyMember: false };
  if (res.status === 204) return { joined: true, alreadyMember: true };

  const detail = await res.text().catch(() => "");

  // 403 betekent vrijwel altijd dat de bot het recht "Create Invite" mist in
  // de server, niet dat de gebruiker iets fout deed.
  throw new Error(
    `Failed to add user to guild (${res.status}): ${detail.slice(0, 200)}`
  );
}
