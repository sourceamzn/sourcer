"use strict";
/* Une las fuentes por EAN en una sola respuesta: ficha (Icecat), coste de
   proveedor (BigBuy) y ofertas de tienda (Google Shopping por EAN).

   Cada fuente se consulta en paralelo y con su propio tiempo maximo: si una
   tarda o falla, el resto sigue y la respuesta indica que falta y por que.
   Nunca se rellena un hueco con un dato estimado. */

const gtin = require("./gtin");

const DEFAULT_TIMEOUTS = { identity: 22000, supplier: 30000, offers: 60000 };

function num(v) {
  const n = Number(v);
  return isFinite(n) && n > 0 ? n : null;
}

function money(v) {
  const n = Number(v);
  return isFinite(n) && n >= 0 ? n : null;
}

function text(v) {
  return String(v == null ? "" : v).trim();
}

function clampMax(value, fallback, min, max) {
  const n = parseInt(value, 10);
  const v = isFinite(n) ? n : fallback;
  return Math.min(Math.max(v, min), max);
}

async function withTimeout(fn, ms) {
  let timer = null;
  try {
    return await Promise.race([
      Promise.resolve().then(fn),
      new Promise(function (resolve) {
        timer = setTimeout(function () { resolve({ __timeout: true }); }, Math.max(1000, ms));
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isSkipped(reason) {
  return /not_configured|sin_token|sin_clave|no_configurado/.test(String(reason || ""));
}

function summarize(id, ms, out) {
  if (out && out.__timeout) {
    return { id: id, ok: false, status: "timeout", ms: ms, count: 0, reason: "timeout", hint: "La fuente no respondio a tiempo. Reintenta: la primera consulta puede estar descargando catalogo." };
  }
  if (!out) return { id: id, ok: false, status: "error", ms: ms, count: 0, reason: "sin_respuesta", hint: "" };
  const items = (out.data && Array.isArray(out.data.items)) ? out.data.items : [];
  if (out.ok) return { id: id, ok: true, status: items.length ? "ok" : "empty", ms: ms, count: items.length, reason: null, hint: "" };
  return {
    id: id,
    ok: false,
    status: isSkipped(out.reason) ? "skipped" : "error",
    ms: ms,
    count: 0,
    reason: String(out.reason || "sin_datos"),
    hint: String(out.hint || out.detail || "")
  };
}

async function runSource(id, fn, ms) {
  const started = Date.now();
  let out;
  try {
    out = await withTimeout(fn, ms);
  } catch (e) {
    return {
      summary: { id: id, ok: false, status: "error", ms: Date.now() - started, count: 0, reason: String((e && e.message) || e), hint: "" },
      items: []
    };
  }
  const summary = summarize(id, Date.now() - started, out);
  const items = (out && out.ok && out.data && Array.isArray(out.data.items)) ? out.data.items : [];
  return { summary: summary, items: items };
}

function toProduct(item) {
  if (!item) return null;
  return {
    name: text(item.name),
    brand: text(item.brand),
    model: text(item.model),
    ean: text(item.ean),
    category: text(item.attrs && item.attrs.category),
    description: text(item.attrs && item.attrs.description),
    image: text(item.image),
    source: "icecat"
  };
}

function toSupplier(item) {
  const attrs = item.attrs || {};
  return {
    source: item.source || "bigbuy",
    provider: item.source === "bigbuy" ? "BigBuy" : text(item.source),
    title: text(item.name),
    reference: text(item.reference),
    netPrice: num(item.price),
    currency: text(attrs.currency) || "EUR",
    vatIncluded: attrs.priceIncludesVAT === true,
    stock: item.stock == null ? null : item.stock,
    available: item.available === true,
    moq: num(attrs.moq) || null,
    deliveryDays: num(attrs.deliveryDays) || null,
    url: text(item.url),
    image: text(item.image),
    capturedAt: text(item.capturedAt)
  };
}

function toOffer(item) {
  const attrs = item.attrs || {};
  const price = num(item.price);
  const shipping = money(item.shipping != null ? item.shipping : attrs.shipping);
  return {
    source: item.source || "gshopping_ean",
    shop: text(item.supplier || attrs.store),
    title: text(item.name),
    price: price,
    shipping: shipping,
    total: price == null ? null : price + (shipping || 0),
    currency: text(attrs.currency) || "EUR",
    condition: text(attrs.condition),
    availability: text(attrs.availability),
    available: item.available === true,
    url: text(item.url),
    image: text(item.image)
  };
}

function dedupeOffers(list) {
  const seen = {};
  const out = [];
  list.forEach(function (o) {
    const key = [o.url, o.shop, o.price == null ? "" : o.price.toFixed(2)].join("|");
    if (seen[key]) return;
    seen[key] = 1;
    out.push(o);
  });
  return out;
}

function byPrice(a, b) {
  const pa = a.netPrice != null ? a.netPrice : a.price;
  const pb = b.netPrice != null ? b.netPrice : b.price;
  if (pa == null && pb == null) return 0;
  if (pa == null) return 1;
  if (pb == null) return -1;
  return pa - pb;
}

function createResolver(deps, options) {
  const timeouts = Object.assign({}, DEFAULT_TIMEOUTS, (options && options.timeouts) || {});

  return async function resolve(rawEan, opts) {
    opts = opts || {};
    const ean = gtin.normalize(rawEan);
    if (!ean) return { ok: false, reason: "ean_invalido", ean: text(rawEan) };

    const started = Date.now();
    const max = clampMax(opts.max, 24, 3, 60);

    const results = await Promise.all([
      runSource("icecat", function () { return deps.identity.lookup({ ean: ean }); }, timeouts.identity),
      runSource("bigbuy", function () { return deps.supplier.search({ ean: ean, max: 12 }); }, timeouts.supplier),
      runSource("gshopping_ean", function () { return deps.offers.search({ ean: ean, max: max }); }, timeouts.offers)
    ]);

    const identity = results[0];
    const supplier = results[1];
    const offers = results[2];
    const sources = results.map(function (r) { return r.summary; });

    const product = toProduct(identity.items[0]);
    const supplierItems = supplier.items.map(toSupplier).sort(byPrice);
    const offerItems = dedupeOffers(offers.items.map(toOffer)).sort(byPrice);

    return {
      ok: true,
      ean: ean,
      product: product,
      suppliers: supplierItems,
      offers: offerItems,
      counts: { identity: product ? 1 : 0, suppliers: supplierItems.length, offers: offerItems.length },
      sources: sources,
      partial: sources.some(function (s) { return s.status === "error" || s.status === "timeout" || s.status === "skipped"; }),
      capturedAt: new Date().toISOString(),
      elapsedMs: Date.now() - started
    };
  };
}

module.exports = { createResolver, DEFAULT_TIMEOUTS, toProduct, toSupplier, toOffer, dedupeOffers, withTimeout };
