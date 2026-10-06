const { amazonReady, config } = require("../config");
const spapi = require("../lib/spapi");

async function listing(body) {
  const asin = body && body.asin;
  if (!asin) return { ok: false, reason: "asin_required" };

  const catalog = await spapi.getCatalogItem(asin);
  const offers = await spapi.getItemOffers(asin);
  const pricing = await spapi.getCompetitivePricing(asin);
  const fees =
    body.price != null ? await spapi.getMyFeesEstimate(asin, body.price, body.currency) : { ok: false, reason: "price_not_provided" };

  if (!catalog.ok && !offers.ok && !pricing.ok) {
    return { ok: false, reason: "spapi_unavailable", detail: { catalog, offers, pricing } };
  }
  return { ok: true, data: { asin, catalog, offers, pricing, fees } };
}

const amazon = {
  id: "amazon",
  label: "Amazon SP-API",
  kind: "api",
  actions: {
    ping: async () => ({
      ok: amazonReady(),
      configured: amazonReady(),
      reason: amazonReady() ? null : "amazon_not_configured",
      market: config.market,
      region: config.region
    }),
    catalog: async (body) => spapi.searchCatalogItems(body || {}),
    item: async (body) => spapi.getCatalogItem(body && body.asin),
    offers: async (body) => spapi.getItemOffers(body && body.asin),
    pricing: async (body) => spapi.getCompetitivePricing(body && body.asin),
    fees: async (body) => spapi.getMyFeesEstimate(body && body.asin, body && body.price, body && body.currency),
    listing
  }
};

module.exports = amazon;
