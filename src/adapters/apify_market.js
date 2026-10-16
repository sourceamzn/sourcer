/* Fuentes de PROVEEDOR/FABRICANTE vía Apify (una sola clave: APIFY_TOKEN).

   1688, Alibaba, Made-in-China, Google Shopping y busqueda por foto.
   Cada actor tiene su propio esquema de entrada (verificado en su ficha de
   Apify); la salida se mapea de forma tolerante. Todo resultado de 1688 /
   Alibaba / Made-in-China / foto es un CANDIDATO: hay que validar modelo y
   variante. Los precios que NO estan en EUR no se convierten (no se inventan
   cambios): se devuelven como texto (priceText) y price = null.
   Amazon no se rasca nunca (solo Keepa). */

const { config, apifyReady } = require("../config");
const apify = require("../lib/apify");
const { marketQuery } = require("../lib/translate");

function first(o, keys) {
  for (let i = 0; i < keys.length; i++) {
    const v = o && o[keys[i]];
    if (v != null && v !== "") return v;
  }
  return null;
}

function priceOf(v) {
  if (v == null) return null;
  if (typeof v === "number") return v > 0 ? v : null;
  if (typeof v === "object") return priceOf(first(v, ["min", "value", "amount", "price", "from"]));
  const m = String(v).replace(/\s/g, "").match(/\d+(?:[.,]\d+)?/);
  if (!m) return null;
  const n = parseFloat(m[0].replace(",", "."));
  return n > 0 ? n : null;
}

/* "10,000 wp" -> 10000 (cantidad minima de pedido). */
function moqOf(v) {
  if (v == null) return null;
  if (typeof v === "number") return v > 0 ? v : null;
  const m = String(v).replace(/[,\s]/g, "").match(/\d+/);
  return m ? parseInt(m[0], 10) : null;
}

function imageOf(o) {
  const v = first(o, ["image", "imageUrl", "image_url", "img", "mainImage", "thumbnail", "picUrl", "pic", "images"]);
  if (Array.isArray(v)) return String((v[0] && (v[0].url || v[0])) || "");
  return v ? String(v.url || v) : "";
}

function currencyOf(o) {
  return String(first(o, ["currency_code", "currency", "currencyCode"]) || "").trim();
}

function isEur(cur, id) {
  if (id === "gshopping") return true; /* se pide country=es */
  return /€|eur/i.test(cur);
}

function toItem(o, id, label, candidate) {
  const url = String(first(o, ["product_url", "url", "link", "productUrl", "detailUrl", "itemUrl", "href"]) || "");
  const supplier = String(first(o, ["company_name", "shop_name", "supplier", "supplierName", "companyName", "sellerName", "seller_name", "seller", "merchant", "store", "source"]) || label);
  const cur = currencyOf(o);
  const lo = priceOf(first(o, ["priceNumeric", "min_price", "price_min", "price", "priceMin", "minPrice", "unitPrice", "salePrice", "extractedPrice", "priceRange"]));
  const hi = priceOf(first(o, ["max_price", "price_max", "priceMax", "maxPrice"]));
  const eur = isEur(cur, id);
  let priceText = "";
  if (lo && !eur) {
    const sym = cur || "";
    priceText = (sym ? sym + " " : "") + lo + (hi && hi !== lo ? "–" + hi : "");
  }
  const moq = moqOf(first(o, ["moq", "min_order", "minOrder", "minimumOrder", "minOrderQuantity", "minOrderQuantity"]));
  const platform = String(first(o, ["provider", "platform", "marketplace"]) || id);
  return {
    source: id,
    name: String(first(o, ["title", "product_name", "name", "subject", "productName", "productTitle"]) || "").slice(0, 180),
    brand: "",
    model: "",
    reference: "",
    ean: "",
    price: eur ? lo : null,
    priceText: priceText,
    oldPrice: null,
    stock: null,
    available: true,
    limit: null,
    minOrder: moq,
    url: url,
    image: imageOf(o),
    supplier: supplier,
    isSupplier: true,
    candidate: Boolean(candidate),
    attrs: {
      currency: cur,
      platform: platform,
      factory: /manufactur|factory|fabric/i.test(String(first(o, ["business_type", "seller_type", "sellerType"]) || "")) || o.is_factory === true || o.isFactory === true,
      note: candidate ? "Candidato: validar modelo y variante antes de comprar." : ""
    },
    capturedAt: new Date().toISOString()
  };
}

function dedupe(items, max) {
  const seen = {};
  return items.filter(function (it) {
    if (!it.url || seen[it.url]) return false;
    seen[it.url] = 1;
    return true;
  }).slice(0, max);
}

function queryOf(body) {
  const b = body || {};
  const parts = [b.brand, b.model, b.name].map(function (x) { return String(x == null ? "" : x).trim(); }).filter(Boolean);
  return String(b.query || parts.join(" ") || "").trim();
}

/* Entradas EXACTAS por actor (esquema de su ficha en Apify). */
const BUILDERS = {
  /* datacach/1688-search-scraper (pay-per-event): keywords[] + maxItemsPerKeyword. */
  a1688: function (q, max) { return { keywords: [q], maxItemsPerKeyword: Math.min(Math.max(max, 3), 60), searchType: "pcmarket", proxyConfiguration: { useApifyProxy: true } }; },
  alibaba: function (q, max) { return { searchQueries: [q], maxProductsPerQuery: max, maxConcurrency: 3, proxyConfig: { useApifyProxy: true }, timeoutSecs: 90 }; },
  mic: function (q, max) { return { searchMode: "keyword", keyword: q, maxResults: max }; },
  aliexpress: function (q, max) { return { keyword: q, query: q, maxItems: max }; },
  shopping: function (q, max) {
    return { queries: [q], maxResults: Math.max(max, 20), country: String(config.apify.country || "es").toLowerCase(), language: "es", sortBy: "price_low" };
  }
};

function makeAdapter(def) {
  const id = def.id;
  function actorId() { return config.apify.actors[def.actor]; }

  async function search(body) {
    let q = queryOf(body);
    if (!q) return { ok: false, reason: "query_required" };
    /* Mercados chinos: sin marca y en su idioma (1688=zh, Alibaba/MIC=en). */
    if (def.lang) {
      if (/^\d{8,14}$/.test(q) && !(body && (body.name || body.model))) return { ok: false, reason: "sin_resultados", detail: "EAN no sirve en este mercado" };
      const adapted = await marketQuery(body && (body.name || body.model || body.brand) ? body : { name: q }, def.lang);
      if (adapted) q = adapted;
    }
    if (!apifyReady()) return { ok: false, reason: "apify_sin_token" };
    if (!actorId()) return { ok: false, reason: "actor_no_configurado" };
    const max = Math.min(Math.max(parseInt((body && body.max) || "12", 10) || 12, 3), 30);
    const op = (body && body.__op) || apify.newOp();
    const r = await apify.runActor(actorId(), BUILDERS[def.actor](q, max), { op: op, estCost: def.estCost || 0.03, timeoutSec: def.timeoutSec || 40 });
    if (!r.ok) return { ok: false, reason: r.reason, detail: r.detail };
    const items = dedupe(r.items.map(function (o) { return toItem(o, id, def.label, def.candidate); }), max);
    return {
      ok: items.length > 0,
      reason: items.length ? null : "sin_resultados",
      data: { source: id, query: q, cached: Boolean(r.cached), count: items.length, items: items }
    };
  }

  return {
    id: id,
    label: def.label,
    kind: "supplier_market",
    supplier: true,
    actions: {
      ping: async function () {
        const ok = apifyReady() && Boolean(actorId());
        return {
          ok: ok,
          configured: ok,
          reason: ok ? null : !apifyReady() ? "apify_sin_token" : "actor_no_configurado",
          mode: ok ? "apify:" + actorId() : "sin_clave",
          note: def.candidate ? "Resultados = candidatos: validar modelo y variante." : "Precios de comparacion en Google Shopping."
        };
      },
      search: search
    }
  };
}

/* Busqueda por foto (Amazon/Keepa -> 1688, Alibaba, AliExpress, Made-in-China...). */
async function searchByImage(body) {
  const b = body || {};
  const image = String(b.image || b.imageUrl || "").trim();
  if (!/^https?:\/\//i.test(image)) return { ok: false, reason: "imagen_requerida" };
  if (!apifyReady()) return { ok: false, reason: "apify_sin_token" };
  const actor = config.apify.actors.image;
  if (!actor) return { ok: false, reason: "actor_no_configurado" };
  const max = Math.min(Math.max(parseInt(b.max || "20", 10) || 20, 3), 40);
  const r = await apify.runActor(
    actor,
    { imageUrls: [image], targets: ["1688", "alibaba", "aliexpress", "made-in-china", "chinagoods", "yiwugo"], maxProducts: max },
    { estCost: 0.10, timeoutSec: 90, op: apify.newOp() }
  );
  if (!r.ok) return { ok: false, reason: r.reason, detail: r.detail };
  const items = dedupe(r.items.map(function (o) { return toItem(o, "foto", "Búsqueda por foto", true); }), max);
  return {
    ok: items.length > 0,
    reason: items.length ? null : "sin_resultados",
    data: { source: "foto", cached: Boolean(r.cached), count: items.length, items: items }
  };
}

const a1688 = makeAdapter({ id: "a1688", actor: "a1688", label: "1688 (Apify)", lang: "zh", candidate: true, estCost: 0.03, timeoutSec: 45 });
const alibaba = makeAdapter({ id: "alibaba", actor: "alibaba", label: "Alibaba (Apify)", lang: "en", candidate: true, estCost: 0.03, timeoutSec: 60 });
const madeinchina = makeAdapter({ id: "madeinchina", actor: "mic", label: "Made-in-China (Apify)", lang: "en", candidate: true, estCost: 0.03, timeoutSec: 45 });
const gshopping = makeAdapter({ id: "gshopping", actor: "shopping", label: "Google Shopping (Apify)", candidate: false, estCost: 0.02, timeoutSec: 45 });
const aliexpressApify = makeAdapter({ id: "aliexpress_apify", actor: "aliexpress", label: "AliExpress texto (Apify)", candidate: true, estCost: 0.03 });

const foto = {
  id: "foto",
  label: "Búsqueda por foto (Apify)",
  kind: "supplier_market",
  /* No participa en searchSuppliers (necesita imagen, no texto): sin accion search. */
  actions: {
    ping: async function () {
      const ok = apifyReady() && Boolean(config.apify.actors.image);
      return { ok: ok, configured: ok, reason: ok ? null : "apify_sin_token", mode: ok ? "apify:" + config.apify.actors.image : "sin_clave", note: "Resultados = candidatos: validar modelo y variante." };
    },
    image: searchByImage
  }
};

module.exports = { a1688, alibaba, madeinchina, gshopping, aliexpressApify, foto, searchByImage };
