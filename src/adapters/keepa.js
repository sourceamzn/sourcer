const { config, keepaReady } = require("../config");
const { jsonFetch } = require("../lib/http");

const BASE = "https://api.keepa.com/";

async function request(path, params) {
  const query = new URLSearchParams(
    Object.assign({ key: config.keepa.apiKey, domain: String(config.keepa.domain) }, params)
  );
  const res = await jsonFetch(BASE + path + "?" + query.toString(), { method: "GET" }, 30000);
  if (!res.ok) return { ok: false, reason: "keepa_http_" + res.status, error: res.error };
  const data = res.data;
  if (data && typeof data === "object" && data.error) return { ok: false, reason: "keepa_error", error: data.error };
  return { ok: true, data };
}

function cleanCode(value) {
  return String(value == null ? "" : value).replace(/[^0-9Xx]/g, "");
}

async function product(body) {
  if (!keepaReady()) return { ok: false, reason: "keepa_not_configured" };
  const asin = body && (body.asin || body.ASIN);
  const code = body && (body.ean || body.upc || body.gtin || body.code);
  if (!asin && !code) return { ok: false, reason: "asin_or_code_required" };
  const params = { stats: "1", history: "1" };
  if (body && body.buybox) params.buybox = "1";
  if (asin) {
    params.asin = String(asin).trim().toUpperCase();
  } else {
    params.code = cleanCode(code);
    params["code-limit"] = String(Math.max(1, Math.min(parseInt((body && body.limit) || 5, 10) || 5, 100)));
  }
  const offers = parseInt((body && body.offers) || 0, 10);
  if (offers) {
    params.offers = String(Math.max(20, Math.min(offers, 100)));
    params["only-live-offers"] = "1";
    if (body && body.stock) params.stock = "1";
  } else if (body && body.buybox) {
    params.buybox = "1";
  }
  return request("product", params);
}

async function search(body) {
  if (!keepaReady()) return { ok: false, reason: "keepa_not_configured" };
  const term = body && (body.query || body.term || body.q);
  if (!term) return { ok: false, reason: "query_required" };
  return request("search", { type: "product", term: String(term), stats: "1" });
}

async function history(body) {
  if (!keepaReady()) return { ok: false, reason: "keepa_not_configured" };
  const asin = body && (body.asin || body.ASIN);
  if (!asin) return { ok: false, reason: "asin_required" };
  return request("product", { asin: String(asin).trim().toUpperCase(), stats: "1", history: "1", buybox: "1", days: "180" });
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
    history,
    product,
    search,
    find: search
  }
};

module.exports = keepa;
