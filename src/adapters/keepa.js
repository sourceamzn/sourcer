const { config, keepaReady } = require("../config");
const { jsonFetch } = require("../lib/http");

function buildUrl(params) {
  const query = new URLSearchParams(Object.assign({ key: config.keepa.apiKey, domain: String(config.keepa.domain) }, params));
  return "https://api.keepa.com/" + (params.type === "find" ? "query" : "product") + "?" + query.toString();
}

async function product(body) {
  if (!keepaReady()) return { ok: false, reason: "keepa_not_configured" };
  const asin = body && body.asin;
  if (!asin) return { ok: false, reason: "asin_required" };
  const url = buildUrl({ asin, stats: "1", history: "1" });
  const res = await jsonFetch(url, { method: "GET" }, 30000);
  if (!res.ok) return { ok: false, reason: "keepa_http_" + res.status, error: res.error };
  return { ok: true, data: res.data };
}

const keepa = {
  id: "keepa",
  label: "Keepa",
  kind: "api",
  actions: {
    ping: async () => ({
      ok: keepaReady(),
      configured: keepaReady(),
      reason: keepaReady() ? null : "keepa_not_configured",
      domain: config.keepa.domain
    }),
    history: product,
    product
  }
};

module.exports = keepa;
