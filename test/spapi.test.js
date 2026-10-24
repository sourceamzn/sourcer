const test = require("node:test");
const assert = require("node:assert");

const { config, amazonReady } = require("../src/config");
const spapi = require("../src/lib/spapi");
const breaker = require("../src/lib/breaker");
const cache = require("../src/lib/cache");

function setCreds() {
  config.amazon.clientId = "amzn1.app";
  config.amazon.clientSecret = "secret";
  config.amazon.refreshToken = "Atzr|x";
  config.amazon.sellerId = "A2SELLER";
  config.amazon.accessKeyId = "";
  config.amazon.secretAccessKey = "";
  config.spapi.maxRetries = 1;
  config.spapi.retryMs = 200;
}
function resp(status, data, headers) {
  return { ok: status >= 200 && status < 300, status: status, headers: new Map(Object.entries(headers || {})), text: async function () { return JSON.stringify(data); } };
}
/* fetch falso: token LWA + rutas SP-API. */
function mockFetch(routes, log) {
  global.fetch = async function (url, opts) {
    log.push({ url: String(url), opts: opts || {} });
    if (/api\.amazon\.com\/auth\/o2\/token/.test(url)) return resp(200, { access_token: "Atza|tok", expires_in: 3600 });
    for (const k of Object.keys(routes)) if (String(url).indexOf(k) !== -1) return routes[k](url, opts);
    return resp(404, { errors: [{ code: "NotFound", message: "no" }] });
  };
}

test("spapi: basta LWA (sin claves AWS) y no firma SigV4", async () => {
  setCreds(); breaker.reset(); cache._reset(); spapi._resetBuckets(); spapi._setSleep(async function () {});
  assert.equal(amazonReady(), true);
  const log = [];
  mockFetch({ "/sellers/v1/marketplaceParticipations": function () {
    return resp(200, { payload: [{ marketplace: { id: "A1RKKUPIHCS9HS", countryCode: "ES", name: "Amazon.es" }, participation: { isParticipating: true }, storeName: "Brunea" }] });
  } }, log);
  const r = await spapi.check();
  assert.equal(r.ok, true);
  assert.equal(r.current.country, "ES");
  const call = log.filter(function (x) { return /sellingpartnerapi/.test(x.url); })[0];
  assert.equal(call.opts.headers["x-amz-access-token"], "Atza|tok");
  assert.equal(call.opts.headers.Authorization, undefined);
});

test("spapi: catalogo por EAN, ofertas y comisiones por lotes + cache", async () => {
  setCreds(); breaker.reset(); cache._reset(); spapi._resetBuckets(); spapi._setSleep(async function () {});
  const log = [];
  mockFetch({
    "/catalog/2022-04-01/items": function () {
      return resp(200, { items: [
        { asin: "B0AAA", identifiers: [{ marketplaceId: "A1RKKUPIHCS9HS", identifiers: [{ identifierType: "EAN", identifier: "8410000000017" }] }],
          summaries: [{ marketplaceId: "A1RKKUPIHCS9HS", itemName: "Batidora", brand: "Acme" }],
          salesRanks: [{ marketplaceId: "A1RKKUPIHCS9HS", displayGroupRanks: [{ rank: 1500 }] }],
          images: [{ marketplaceId: "A1RKKUPIHCS9HS", images: [{ variant: "MAIN", link: "https://m.media-amazon.com/x.jpg", width: 500 }] }] }
      ] });
    },
    "/batches/products/pricing/v0/itemOffers": function () {
      return resp(200, { responses: [{ status: { statusCode: 200 }, request: { uri: "/products/pricing/v0/items/B0AAA/offers" }, body: { payload: {
        ASIN: "B0AAA",
        Summary: { TotalOfferCount: 5, BuyBoxPrices: [{ condition: "New", LandedPrice: { Amount: 49.9 } }],
          NumberOfOffers: [{ condition: "new", fulfillmentChannel: "Amazon", OfferCount: 3 }, { condition: "new", fulfillmentChannel: "Merchant", OfferCount: 2 }] },
        Offers: [{ SellerId: "A1AT7YVPFBWXBL", IsFulfilledByAmazon: true, IsBuyBoxWinner: false }, { SellerId: "S1", IsFulfilledByAmazon: true, IsBuyBoxWinner: true }, { SellerId: "S2", IsFulfilledByAmazon: true }]
      } } }] });
    },
    "/products/fees/v0/feesEstimate": function (u, opts) {
      const body = JSON.parse(opts.body);
      assert.equal(body[0].IdType, "ASIN");
      return resp(200, [{ Status: "Success", FeesEstimateIdentifier: { IdValue: "B0AAA" }, FeesEstimate: { FeeDetailList: [
        { FeeType: "ReferralFee", FeeAmount: { CurrencyCode: "EUR", Amount: 7.49 } }, { FeeType: "FBAFees", FeeAmount: { CurrencyCode: "EUR", Amount: 4.1 } }
      ] } }]);
    }
  }, log);
  const cat = await spapi.catalogByEans(["8410000000017", "8410000000024"]);
  assert.equal(cat.ok, true);
  assert.equal(cat.byEan["8410000000017"][0].asin, "B0AAA");
  assert.equal(cat.byEan["8410000000017"][0].bsr, 1500);
  assert.deepEqual(cat.byEan["8410000000024"], []);
  const off = await spapi.offersBatch(["B0AAA"]);
  const o = off.byAsin.B0AAA;
  assert.equal(o.price, 49.9);
  assert.equal(o.amazonSells, true);
  assert.equal(o.offersFba, 3);
  assert.equal(o.fbaThird, 2);
  assert.equal(o.thirdParty, 4);
  const fees = await spapi.feesBatch([{ asin: "B0AAA", price: 49.9 }]);
  const f = require("../src/lib/fees").fromEstimate(fees.byAsin.B0AAA, 49.9);
  assert.equal(f.fbaFee, 4.1);
  assert.equal(f.referralPct, 15.01);
  const n = log.length;
  await spapi.catalogByEans(["8410000000017", "8410000000024"]);
  await spapi.feesBatch([{ asin: "B0AAA", price: 49.9 }]);
  assert.equal(log.length, n, "la segunda vez sale de cache");
});

test("spapi: un 403 aparta SP-API (no insiste) y el limite por operacion espera", async () => {
  setCreds(); breaker.reset(); cache._reset(); spapi._resetBuckets();
  const waits = [];
  spapi._setSleep(async function (ms) { waits.push(ms); });
  const log = [];
  mockFetch({ "/listings/2021-08-01/restrictions": function () { return resp(403, { errors: [{ code: "Unauthorized", message: "Access to requested resource is denied." }] }); } }, log);
  const r = await spapi.getListingsRestrictions("B0ZZZ");
  assert.equal(r.ok, false);
  assert.match(r.message, /Unauthorized/);
  const before = log.length;
  const r2 = await spapi.getListingsRestrictions("B0YYY");
  assert.equal(r2.reason, "spapi_pausado");
  assert.equal(log.length, before);
  breaker.reset();
  mockFetch({ "/products/fees/v0/feesEstimate": function () { return resp(200, []); } }, log);
  await spapi.feesBatch([{ asin: "B01", price: 10 }]);
  await spapi.feesBatch([{ asin: "B02", price: 10 }]);
  assert.ok(waits.some(function (w) { return w >= 1500; }), "0,5 peticiones/s: la segunda espera ~2 s");
});
