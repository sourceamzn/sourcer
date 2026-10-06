const { config, amazonReady } = require("../config");
const { signRequest } = require("./sigv4");
const { getAccessToken } = require("./lwa");
const { jsonFetch } = require("./http");

function endpointFor(region) {
  if (region.startsWith("na")) return "sellingpartnerapi-na.amazon.com";
  if (region.startsWith("fe")) return "sellingpartnerapi-fe.amazon.com";
  return "sellingpartnerapi-eu.amazon.com";
}

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

  const res = await jsonFetch(url, { method, headers, body: body || undefined }, options.timeoutMs || 20000);

  if (!res.ok) {
    return { ok: false, reason: "spapi_http_" + res.status, status: res.status, data: res.data, error: res.error };
  }
  return { ok: true, data: res.data, status: res.status };
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

module.exports = {
  call,
  searchCatalogItems,
  getCatalogItem,
  getItemOffers,
  getCompetitivePricing,
  getMyFeesEstimate
};
