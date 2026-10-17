const { config, amazonReady } = require("../config");
const { signRequest } = require("./sigv4");
const { getAccessToken } = require("./lwa");
const { jsonFetch } = require("./http");
const retry = require("./retry");

function endpointFor(region) {
  if (region.startsWith("na")) return "sellingpartnerapi-na.amazon.com";
  if (region.startsWith("fe")) return "sellingpartnerapi-fe.amazon.com";
  return "sellingpartnerapi-eu.amazon.com";
}

/* Reintento con espera exponencial + jitter. SP-API devuelve 429 con
   `Retry-After` en segundos: se respeta; si no hay cabecera se usa la base. */
async function call(pathname, options = {}) {
  if (!amazonReady()) {
    return { ok: false, reason: "amazon_not_configured" };
  }
  const accessToken = await getAccessToken();
  if (!accessToken) {
    return { ok: false, reason: "lwa_token_error" };
  }

  const method = options.method || "GET";
  const host = endpointFor(config.region);
  const query = new URLSearchParams(options.query || {});
  const qs = query.toString();
  const url = "https://" + host + pathname + (qs ? "?" + qs : "");
  const body = options.body ? JSON.stringify(options.body) : "";
  const cfg = config.spapi || {};
  const maxRetries = cfg.maxRetries == null ? 3 : cfg.maxRetries;
  const base = cfg.retryMs == null ? 600 : cfg.retryMs;

  let res = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const signed = signRequest({
      method,
      url,
      region: config.region,
      service: "execute-api",
      accessKeyId: config.amazon.accessKeyId,
      secretAccessKey: config.amazon.secretAccessKey,
      body
    });

    const headers = {
      "x-amz-date": signed.amzDate,
      "x-amz-access-token": accessToken,
      Authorization: signed.authorization
    };
    if (body) headers["content-type"] = "application/json";

    res = await jsonFetch(url, { method, headers, body: body || undefined }, options.timeoutMs || 20000);
    if (res.ok) return { ok: true, data: res.data, status: res.status };
    if (!retry.retryable(res.status) || attempt === maxRetries) break;

    const retryAfter = res.headers && (res.headers["retry-after"] || res.headers["Retry-After"]);
    await new Promise(function (r) { setTimeout(r, retry.backoffMs(attempt, retryAfter, base)); });
  }

  return { ok: false, reason: "spapi_http_" + res.status, status: res.status, data: res.data, error: res.error };
}

function searchCatalogItems(params) {
  return call("/catalog/2022-04-01/items", {
    query: Object.assign({ marketplaceIds: config.market }, params)
  });
}

function getCatalogItem(asin) {
  return call("/catalog/2022-04-01/items/" + encodeURIComponent(asin), {
    query: { marketplaceIds: config.market, includedData: "attributes,summaries,salesRanks" }
  });
}

function getItemOffers(asin) {
  return call("/products/pricing/v0/items/" + encodeURIComponent(asin) + "/offers", {
    query: { MarketplaceId: config.market, ItemCondition: "New" }
  });
}

function getCompetitivePricing(asin) {
  return call("/products/pricing/v0/competitivePrice", {
    query: { MarketplaceId: config.market, Asins: asin, ItemType: "Asin" }
  });
}

function getMyFeesEstimate(asin, listingPriceAmount, currency) {
  const body = {
    FeesEstimateRequest: {
      MarketplaceId: config.market,
      IsAmazonFulfilled: true,
      Identifier: "sourcing-" + asin,
      PriceToEstimateFees: {
        ListingPrice: { CurrencyCode: currency || "EUR", Amount: Number(listingPriceAmount) || 0 }
      }
    }
  };
  return call("/products/fees/v0/items/" + encodeURIComponent(asin) + "/feesEstimate", {
    method: "POST",
    body
  });
}

/* Listings Restrictions API: marca (no descarta) si el listado exige aprobacion
   o tiene restricciones de marca/categoria. Requiere SPAPI_SELLER_ID. */
function getListingsRestrictions(asin, sellerId) {
  const sid = sellerId || config.amazon.sellerId;
  if (!sid) return { ok: false, reason: "seller_id_missing" };
  return call("/listings/2021-08-01/restrictions", {
    query: {
      asin: String(asin || "").toUpperCase(),
      sellerId: sid,
      marketplaceIds: config.market,
      conditionType: "new_new"
    }
  });
}

module.exports = {
  call,
  backoffMs: retry.backoffMs,
  retryable: retry.retryable,
  searchCatalogItems,
  getCatalogItem,
  getItemOffers,
  getCompetitivePricing,
  getMyFeesEstimate,
  getListingsRestrictions
};
