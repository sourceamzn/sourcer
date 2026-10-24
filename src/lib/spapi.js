"use strict";
/* Cliente de Amazon Selling Partner API (SP-API) para la cuenta propia.

   - Solo hacen falta las credenciales de la app (LWA_CLIENT_ID,
     LWA_CLIENT_SECRET) y el token de autorizacion de la cuenta
     (SPAPI_REFRESH_TOKEN). Desde octubre de 2023 Amazon ya no exige AWS IAM
     ni firma SigV4; si existen AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY se
     sigue firmando (compatibilidad), si no, no.
   - Limite de peticiones POR OPERACION (cubo de fichas) con las cifras
     publicadas por Amazon; si la respuesta trae `x-amzn-RateLimit-Limit` se
     ajusta solo. Nunca se fuerza: un 429 se espera y se reintenta.
   - Interruptor: credenciales invalidas (401/403) apartan SP-API 15 min y la
     app sigue con Keepa/estimaciones.
   - Cache: catalogo por EAN 30 d, comisiones 7 d, restricciones 2 d,
     ofertas 30 min. */

const { config, amazonReady } = require("../config");
const { signRequest } = require("./sigv4");
const { getAccessToken } = require("./lwa");
const { jsonFetch } = require("./http");
const retry = require("./retry");
const breaker = require("./breaker");
const cache = require("./cache");

const B = "spapi";
const usage = { calls: 0, ok: 0, throttled: 0, errors: 0, byOp: {}, lastError: "", lastOkAt: null };

function endpointFor(region) {
  if (region.startsWith("na") || region.startsWith("us")) return "sellingpartnerapi-na.amazon.com";
  if (region.startsWith("fe") || region.startsWith("ap")) return "sellingpartnerapi-fe.amazon.com";
  return "sellingpartnerapi-eu.amazon.com";
}

/* ---------- limite por operacion (peticiones/segundo y rafaga) ---------- */
const LIMITS = {
  searchCatalogItems: { rate: 2, burst: 2 },
  getCatalogItem: { rate: 2, burst: 2 },
  getItemOffers: { rate: 0.5, burst: 1 },
  getItemOffersBatch: { rate: 0.5, burst: 1 },
  getCompetitivePricing: { rate: 0.5, burst: 1 },
  getMyFeesEstimateForASIN: { rate: 1, burst: 2 },
  getMyFeesEstimates: { rate: 0.5, burst: 1 },
  getListingsRestrictions: { rate: 5, burst: 10 },
  getMarketplaceParticipations: { rate: 0.016, burst: 15 },
  other: { rate: 0.5, burst: 1 }
};
const buckets = {};
let sleep = function (ms) { return new Promise(function (r) { const t = setTimeout(r, ms); if (t.unref) t.unref(); }); };

async function take(op) {
  const lim = LIMITS[op] || LIMITS.other;
  const b = buckets[op] = buckets[op] || { tokens: lim.burst, at: Date.now(), rate: lim.rate, burst: lim.burst };
  for (let i = 0; i < 600; i++) {
    const now = Date.now();
    b.tokens = Math.min(b.burst, b.tokens + ((now - b.at) / 1000) * b.rate);
    b.at = now;
    if (b.tokens >= 1) { b.tokens -= 1; return; }
    await sleep(Math.max(50, Math.ceil(((1 - b.tokens) / b.rate) * 1000)));
  }
}
function adapt(op, headers) {
  const v = Number(headers && (headers["x-amzn-ratelimit-limit"] || headers["x-amzn-RateLimit-Limit"]));
  if (isFinite(v) && v > 0 && buckets[op]) buckets[op].rate = v;
}

/* ---------- llamada base ---------- */
async function call(pathname, options) {
  options = options || {};
  const op = options.op || "other";
  if (!amazonReady()) return { ok: false, reason: "amazon_not_configured" };
  if (!breaker.allow(B)) return { ok: false, reason: "spapi_pausado" };
  const accessToken = await getAccessToken();
  if (!accessToken) {
    breaker.failure(B, "lwa_token_error", { hard: true, coolMs: 15 * 60000 });
    usage.lastError = "No se pudo obtener el token de Amazon (revisa LWA_CLIENT_ID, LWA_CLIENT_SECRET y SPAPI_REFRESH_TOKEN).";
    return { ok: false, reason: "lwa_token_error" };
  }
  const method = options.method || "GET";
  const host = endpointFor(config.region);
  const qs = new URLSearchParams(options.query || {}).toString();
  const url = "https://" + host + pathname + (qs ? "?" + qs : "");
  const body = options.body ? JSON.stringify(options.body) : "";
  const cfg = config.spapi || {};
  const maxRetries = cfg.maxRetries == null ? 3 : cfg.maxRetries;
  const base = cfg.retryMs == null ? 600 : cfg.retryMs;
  const o = usage.byOp[op] = usage.byOp[op] || { calls: 0, ok: 0, throttled: 0, errors: 0 };

  let res = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    await take(op);
    const headers = { "x-amz-access-token": accessToken, "user-agent": "SourcingFBA/1.0 (Language=Node.js)" };
    if (config.amazon.accessKeyId && config.amazon.secretAccessKey) {
      const signed = signRequest({ method: method, url: url, region: config.region, service: "execute-api", accessKeyId: config.amazon.accessKeyId, secretAccessKey: config.amazon.secretAccessKey, body: body });
      headers["x-amz-date"] = signed.amzDate;
      headers.Authorization = signed.authorization;
    }
    if (body) headers["content-type"] = "application/json";
    usage.calls++; o.calls++;
    try { require("./usage").add("spapi", { calls: 1 }); } catch (e) {}
    res = await jsonFetch(url, { method: method, headers: headers, body: body || undefined }, options.timeoutMs || 20000);
    adapt(op, res.headers);
    if (res.ok) {
      usage.ok++; o.ok++; usage.lastOkAt = new Date().toISOString();
      breaker.success(B);
      return { ok: true, data: res.data, status: res.status };
    }
    if (res.status === 429) { usage.throttled++; o.throttled++; }
    if (!retry.retryable(res.status) || attempt === maxRetries) break;
    const ra = res.headers && (res.headers["retry-after"] || res.headers["Retry-After"]);
    await sleep(retry.backoffMs(attempt, ra, base));
  }
  usage.errors++; o.errors++;
  const msg = errText(res);
  usage.lastError = op + ": " + msg;
  if (res.status === 401 || res.status === 403) {
    /* Credenciales o permisos (rol) que faltan: no insistir. */
    breaker.failure(B, msg, { hard: true, coolMs: 15 * 60000 });
  } else if (res.status === 0 || res.status >= 500) {
    breaker.failure(B, msg, { threshold: 4, coolMs: 5 * 60000 });
  }
  return { ok: false, reason: "spapi_http_" + res.status, status: res.status, data: res.data, error: res.error, message: msg };
}

function errText(res) {
  if (!res) return "sin respuesta";
  const e = res.data && res.data.errors && res.data.errors[0];
  if (e) return String((e.code || "") + " " + (e.message || "")).trim().slice(0, 200);
  return res.error ? String(res.error).slice(0, 200) : ("HTTP " + res.status);
}

/* ---------- operaciones sueltas (compatibles con el codigo anterior) ---------- */
function searchCatalogItems(params) {
  return call("/catalog/2022-04-01/items", { op: "searchCatalogItems", query: Object.assign({ marketplaceIds: config.market }, params) });
}
function getCatalogItem(asin) {
  return call("/catalog/2022-04-01/items/" + encodeURIComponent(asin), { op: "getCatalogItem", query: { marketplaceIds: config.market, includedData: "attributes,summaries,salesRanks,images,identifiers" } });
}
function getItemOffers(asin) {
  return call("/products/pricing/v0/items/" + encodeURIComponent(asin) + "/offers", { op: "getItemOffers", query: { MarketplaceId: config.market, ItemCondition: "New" } });
}
function getCompetitivePricing(asin) {
  return call("/products/pricing/v0/competitivePrice", { op: "getCompetitivePricing", query: { MarketplaceId: config.market, Asins: asin, ItemType: "Asin" } });
}
function priceKey(p) { return Math.round((Number(p) || 0) * 2) / 2; }
async function getMyFeesEstimate(asin, listingPriceAmount, currency) {
  const k = String(asin).toUpperCase() + "|" + priceKey(listingPriceAmount);
  const hit = await cache.get("sp_fee", k);
  if (hit) return { ok: true, data: hit, cached: true };
  const body = { FeesEstimateRequest: { MarketplaceId: config.market, IsAmazonFulfilled: true, Identifier: "sourcing-" + asin, PriceToEstimateFees: { ListingPrice: { CurrencyCode: currency || "EUR", Amount: Number(listingPriceAmount) || 0 } } } };
  const r = await call("/products/fees/v0/items/" + encodeURIComponent(asin) + "/feesEstimate", { op: "getMyFeesEstimateForASIN", method: "POST", body: body });
  if (r.ok && feeOk(r.data)) await cache.set("sp_fee", k, r.data, 7 * cache.DAY);
  return r;
}
function feeOk(data) {
  try { return String(data.payload.FeesEstimateResult.Status) === "Success"; } catch (e) { return false; }
}
async function getListingsRestrictions(asin, sellerId) {
  const sid = sellerId || config.amazon.sellerId;
  if (!sid) return { ok: false, reason: "seller_id_missing" };
  const a = String(asin || "").toUpperCase();
  const hit = await cache.get("sp_restr", a);
  if (hit) return { ok: true, data: hit, cached: true };
  const r = await call("/listings/2021-08-01/restrictions", { op: "getListingsRestrictions", query: { asin: a, sellerId: sid, marketplaceIds: config.market, conditionType: "new_new" } });
  if (r.ok) await cache.set("sp_restr", a, r.data, 2 * cache.DAY);
  return r;
}
function getMarketplaceParticipations() {
  return call("/sellers/v1/marketplaceParticipations", { op: "getMarketplaceParticipations" });
}

/* ---------- operaciones por lotes (cruce de tarifas) ---------- */

/* EAN -> fichas de Amazon (hasta 20 EAN por llamada). Devuelve { ean: [item...] }. */
async function catalogByEans(eans) {
  const out = {};
  const list = Array.from(new Set((eans || []).map(String).filter(Boolean)));
  const cached = await cache.getMany("sp_cat", list);
  const need = list.filter(function (e) { if (cached[e]) { out[e] = cached[e]; return false; } return true; });
  for (let i = 0; i < need.length; i += 20) {
    const chunk = need.slice(i, i + 20);
    const found = {};
    let pageToken = null;
    for (let page = 0; page < 4; page++) {
      const q = { identifiers: chunk.join(","), identifiersType: "EAN", includedData: "identifiers,summaries,salesRanks,images", pageSize: "20" };
      if (pageToken) q.pageToken = pageToken;
      const r = await searchCatalogItems(q);
      if (!r.ok) { if (!page) return { ok: false, reason: r.reason, message: r.message, byEan: out }; break; }
      ((r.data && r.data.items) || []).forEach(function (it) {
        const codes = identifiersOf(it);
        chunk.forEach(function (e) { if (codes.indexOf(e) !== -1) (found[e] = found[e] || []).push(slimItem(it)); });
      });
      pageToken = r.data && r.data.pagination && r.data.pagination.nextToken;
      if (!pageToken) break;
    }
    for (let j = 0; j < chunk.length; j++) {
      const e = chunk[j];
      out[e] = found[e] || [];
      /* Lo no encontrado tambien se recuerda (menos tiempo): no existe en Amazon. */
      await cache.set("sp_cat", e, out[e], (out[e].length ? 30 : 7) * cache.DAY);
    }
  }
  return { ok: true, byEan: out };
}
function norm13(c) { const d = String(c || "").replace(/\D/g, ""); return d.length === 12 ? "0" + d : d; }
function identifiersOf(it) {
  const out = [];
  (it.identifiers || []).forEach(function (g) {
    (g.identifiers || []).forEach(function (x) { if (/EAN|UPC|GTIN/i.test(x.identifierType || "")) out.push(norm13(x.identifier)); });
  });
  return out;
}
function slimItem(it) {
  const mk = config.market;
  const sum = (it.summaries || []).filter(function (s) { return !s.marketplaceId || s.marketplaceId === mk; })[0] || (it.summaries || [])[0] || {};
  let rank = null;
  (it.salesRanks || []).forEach(function (g) {
    if (g.marketplaceId && g.marketplaceId !== mk) return;
    const d = (g.displayGroupRanks || [])[0] || (g.classificationRanks || [])[0];
    if (d && d.rank && (rank == null || d.rank < rank)) rank = d.rank;
  });
  let image = "";
  (it.images || []).forEach(function (g) {
    if (image || (g.marketplaceId && g.marketplaceId !== mk)) return;
    const main = (g.images || []).filter(function (x) { return x.variant === "MAIN"; }).sort(function (a, b) { return (b.width || 0) - (a.width || 0); })[0] || (g.images || [])[0];
    if (main && main.link) image = main.link;
  });
  return { asin: String(it.asin || "").toUpperCase(), title: sum.itemName || "", brand: sum.brand || sum.brandName || "", manufacturer: sum.manufacturer || "", bsr: rank, image: image, packageQuantity: Number(sum.packageQuantity) || null };
}

/* Ofertas actuales de hasta 20 ASIN por llamada. Devuelve { asin: resumen }. */
async function offersBatch(asins) {
  const out = {};
  const list = Array.from(new Set((asins || []).map(function (a) { return String(a).toUpperCase(); }).filter(Boolean)));
  const cached = await cache.getMany("sp_off", list);
  const need = list.filter(function (a) { if (cached[a]) { out[a] = cached[a]; return false; } return true; });
  for (let i = 0; i < need.length; i += 20) {
    const chunk = need.slice(i, i + 20);
    const body = { requests: chunk.map(function (a) { return { uri: "/products/pricing/v0/items/" + a + "/offers", method: "GET", MarketplaceId: config.market, ItemCondition: "New", CustomerType: "Consumer" }; }) };
    const r = await call("/batches/products/pricing/v0/itemOffers", { op: "getItemOffersBatch", method: "POST", body: body });
    if (!r.ok) { if (!i) return { ok: false, reason: r.reason, message: r.message, byAsin: out }; break; }
    const resps = (r.data && r.data.responses) || [];
    for (let j = 0; j < resps.length; j++) {
      const x = resps[j];
      const payload = x && x.body && x.body.payload;
      const asin = String((payload && payload.ASIN) || (x.request && String(x.request.uri || "").split("/")[5]) || "").toUpperCase();
      if (!asin) continue;
      const st = x.status && x.status.statusCode;
      if (st && st !== 200) { out[asin] = { asin: asin, error: true }; continue; }
      out[asin] = summarizeOffers(payload, asin);
      await cache.set("sp_off", asin, out[asin], 30 * 60000);
    }
  }
  return { ok: true, byAsin: out };
}
function amt(x) { const n = Number(x && x.Amount); return isFinite(n) ? n : null; }
function summarizeOffers(payload, asin) {
  const AMZ = require("./buybox").AMAZON_SELLERS;
  const s = (payload && payload.Summary) || {};
  const offers = (payload && payload.Offers) || [];
  let buyBox = null;
  (s.BuyBoxPrices || []).forEach(function (b) { if (/new/i.test(b.condition || "New") && buyBox == null) buyBox = amt(b.LandedPrice) || ((amt(b.ListingPrice) || 0) + (amt(b.Shipping) || 0)); });
  let lowest = null;
  (s.LowestPrices || []).forEach(function (b) { if (!/new/i.test(b.condition || "New")) return; const p = amt(b.LandedPrice) || ((amt(b.ListingPrice) || 0) + (amt(b.Shipping) || 0)); if (p && (lowest == null || p < lowest)) lowest = p; });
  let total = 0, fbaCount = 0;
  (s.NumberOfOffers || []).forEach(function (n) {
    if (!/new/i.test(n.condition || "")) return;
    total += Number(n.OfferCount) || 0;
    if (/amazon/i.test(n.fulfillmentChannel || "")) fbaCount += Number(n.OfferCount) || 0;
  });
  if (!total && s.TotalOfferCount) total = Number(s.TotalOfferCount) || 0;
  let amazonSells = false, bbSeller = "", bbFba = null, fbaThirdListed = 0;
  offers.forEach(function (o) {
    const isAmz = AMZ.indexOf(o.SellerId) !== -1;
    if (isAmz) amazonSells = true;
    if (o.IsFulfilledByAmazon && !isAmz) fbaThirdListed++;
    if (o.IsBuyBoxWinner) { bbSeller = o.SellerId || ""; bbFba = Boolean(o.IsFulfilledByAmazon); }
  });
  const fbaThird = Math.max(fbaThirdListed, fbaCount - (amazonSells ? 1 : 0));
  return {
    asin: asin, buyBox: buyBox, lowest: lowest, price: buyBox || lowest || null,
    offers: total, offersFba: fbaCount, fbaThird: Math.max(0, fbaThird), amazonSells: amazonSells,
    thirdParty: Math.max(0, total - (amazonSells ? 1 : 0)), bbSeller: bbSeller, bbFba: bbFba,
    bbIsAmazon: AMZ.indexOf(bbSeller) !== -1, at: new Date().toISOString()
  };
}

/* Comisiones reales (las de TU cuenta) de hasta 20 ASIN por llamada.
   items: [{ asin, price }]. Devuelve { asin: respuesta compatible con fees.fromEstimate }. */
async function feesBatch(items) {
  const out = {};
  const list = (items || []).filter(function (x) { return x && x.asin && Number(x.price) > 0; });
  const keys = list.map(function (x) { return String(x.asin).toUpperCase() + "|" + priceKey(x.price); });
  const cached = await cache.getMany("sp_fee", keys);
  const need = [];
  list.forEach(function (x, i) { if (cached[keys[i]]) out[String(x.asin).toUpperCase()] = cached[keys[i]]; else need.push(x); });
  for (let i = 0; i < need.length; i += 20) {
    const chunk = need.slice(i, i + 20);
    const body = chunk.map(function (x) {
      return { IdType: "ASIN", IdValue: String(x.asin).toUpperCase(), FeesEstimateRequest: { MarketplaceId: config.market, IsAmazonFulfilled: true, Identifier: "fx-" + String(x.asin).toUpperCase(), PriceToEstimateFees: { ListingPrice: { CurrencyCode: "EUR", Amount: Math.round(Number(x.price) * 100) / 100 } } } };
    });
    const r = await call("/products/fees/v0/feesEstimate", { op: "getMyFeesEstimates", method: "POST", body: body });
    if (!r.ok) { if (!i) return { ok: false, reason: r.reason, message: r.message, byAsin: out }; break; }
    const arr = Array.isArray(r.data) ? r.data : ((r.data && r.data.payload) || []);
    for (let j = 0; j < arr.length; j++) {
      const res = arr[j];
      const id = res && res.FeesEstimateIdentifier;
      const asin = String((id && id.IdValue) || (chunk[j] && chunk[j].asin) || "").toUpperCase();
      if (!asin || String(res.Status) !== "Success") continue;
      const wrapped = { payload: { FeesEstimateResult: res } };
      out[asin] = wrapped;
      const src = chunk.filter(function (c) { return String(c.asin).toUpperCase() === asin; })[0];
      if (src) await cache.set("sp_fee", asin + "|" + priceKey(src.price), wrapped, 7 * cache.DAY);
    }
  }
  return { ok: true, byAsin: out };
}

/* Comprobacion de conexion: en que mercados esta dada de alta la cuenta. */
async function check() {
  if (!amazonReady()) return { ok: false, configured: false, reason: "faltan LWA_CLIENT_ID, LWA_CLIENT_SECRET o SPAPI_REFRESH_TOKEN" };
  const r = await getMarketplaceParticipations();
  if (!r.ok) return { ok: false, configured: true, reason: r.message || r.reason };
  const list = ((r.data && r.data.payload) || []).map(function (x) {
    return { id: x.marketplace && x.marketplace.id, country: x.marketplace && x.marketplace.countryCode, name: x.marketplace && x.marketplace.name, active: x.participation && x.participation.isParticipating, store: x.storeName || "" };
  });
  const here = list.filter(function (m) { return m.id === config.market; })[0] || null;
  return { ok: true, configured: true, marketplaces: list, current: here, sellerIdSet: Boolean(config.amazon.sellerId) };
}

function status() {
  return { configured: amazonReady(), sellerId: Boolean(config.amazon.sellerId), signing: Boolean(config.amazon.accessKeyId && config.amazon.secretAccessKey), usage: usage, breaker: breaker.snapshot()[B] || null };
}

module.exports = {
  call,
  backoffMs: retry.backoffMs,
  retryable: retry.retryable,
  searchCatalogItems, getCatalogItem, getItemOffers, getCompetitivePricing, getMyFeesEstimate, getListingsRestrictions,
  getMarketplaceParticipations, catalogByEans, offersBatch, feesBatch, summarizeOffers, slimItem, identifiersOf, check, status, usage,
  _setSleep: function (fn) { sleep = fn; }, _resetBuckets: function () { Object.keys(buckets).forEach(function (k) { delete buckets[k]; }); }
};
