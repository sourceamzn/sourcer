const { config } = require("../config");
const { jsonFetch } = require("./http");

const TOKEN_URL = "https://api.amazon.com/auth/o2/token";
let cache = { token: null, expiresAt: 0 };

async function getAccessToken() {
  if (!config.amazon.clientId || !config.amazon.clientSecret || !config.amazon.refreshToken) {
    return null;
  }
  const now = Date.now();
  if (cache.token && now < cache.expiresAt - 60000) {
    return cache.token;
  }
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: config.amazon.refreshToken,
    client_id: config.amazon.clientId,
    client_secret: config.amazon.clientSecret
  }).toString();

  const res = await jsonFetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });

  if (!res.ok || !res.data || !res.data.access_token) {
    return null;
  }
  cache = { token: res.data.access_token, expiresAt: now + (res.data.expires_in || 3600) * 1000 };
  return cache.token;
}

module.exports = { getAccessToken };
