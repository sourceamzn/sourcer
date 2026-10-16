/* BIGBUY (mayorista, Valencia) como PROVEEDOR con API.

   BigBuy es mayorista de dropshipping: su API da catalogo, precio de coste
   (wholesalePrice, sin IVA), stock, imagenes y EAN. La API no tiene busqueda
   por palabra clave, asi que se descarga un snapshot del catalogo (paginado y
   cacheado) y se filtra en local por EAN o por tokens del titulo. El snapshot
   se refresca cada BIGBUY_CACHE_MIN minutos, de forma que la busqueda repetida
   es instantanea y no castiga la cuota.

   Auth: header  Authorization: Bearer <BIGBUY_API_KEY>
   Base: https://api.bigbuy.eu  (REST/JSON) */

const { config, bigbuyReady } = require("../config");
const { jsonFetch } = require("../lib/http");

const PAGE_SIZE = 100;
const MAX_PAGES = Math.max(1, parseInt(process.env.BIGBUY_MAX_PAGES || "4", 10) || 4);
const CACHE_MIN = Math.max(5, parseInt(process.env.BIGBUY_CACHE_MIN || "30", 10) || 30);

function base() {
  return config.bigbuy.base.replace(/\/+$/, "");
}

function apiKey() {
  // tolera comillas, saltos de linea y un "Bearer " pegado por error en Railway
  return String(config.bigbuy.apiKey || "")
    .replace(/[\r\n\t]+/g, "")
    .replace(/^["'\s]+|["'\s]+$/g, "")
    .replace(/^Bearer\s+/i, "")
    .trim();
}

function headers() {
  return { Authorization: "Bearer " + apiKey(), Accept: "application/json", "User-Agent": "sourcer/0.7" };
}

function bodyHint(res) {
  const d = res && res.data;
  if (!d) return res && res.error ? String(res.error) : "";
  if (typeof d === "string") return d.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 200);
  return String(d.message || d.error || d.code || JSON.stringify(d)).slice(0, 200);
}

async function bbGet(path, timeout) {
  return jsonFetch(base() + path, { method: "GET", headers: headers() }, timeout || 30000);
}

function tokensOf(value) {
  return String(value == null ? "" : value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(function (t) { return t.length > 2; });
}

function firstImage(p) {
  const imgs = p.images || [];
  const first = imgs[0];
  if (!first) return "";
  if (typeof first === "string") return first;
  return first.url || first.image || "";
}

function num(v) {
  const n = Number(v);
  return isFinite(n) ? n : null;
}

function toItem(p, info) {
  const name = (info && (info.name || info.title)) || p.name || "";
  const wholesale = num(p.wholesalePrice);
  const retail = num(p.retailPrice);
  const sku = String(p.sku || p.reference || p.id || "");
  return {
    source: "bigbuy",
    name: String(name || sku).slice(0, 200),
    brand: (info && info.manufacturer && info.manufacturer.name) || (p.manufacturer && p.manufacturer.name) || "",
    model: "",
    reference: sku,
    ean: String(p.ean13 || (info && info.ean13) || ""),
    price: wholesale != null ? wholesale : retail,
    oldPrice: retail != null && wholesale != null && retail > wholesale ? retail : null,
    stock: null,
    available: true,
    url: sku ? "https://www.bigbuy.eu/es/" + encodeURIComponent(sku) + ".html" : "https://www.bigbuy.eu/",
    image: firstImage(p),
    attrs: {
      description: String((info && (info.description || info.shortDescription)) || "").replace(/<[^>]+>/g, " ").slice(0, 300),
      currency: "EUR",
      priceIncludesVAT: false,
      platform: "bigbuy"
    },
    capturedAt: new Date().toISOString()
  };
}

let cached = { items: null, at: 0 };

async function snapshot() {
  if (cached.items && Date.now() - cached.at < CACHE_MIN * 60000) return { ok: true, items: cached.items };
  if (!bigbuyReady()) return { ok: false, reason: "bigbuy_not_configured", hint: "Configura BIGBUY_API_KEY (API de mayorista BigBuy)." };
  const items = [];
  const infoById = {};
  let fetchedAny = false;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const qs = "?isoCode=" + encodeURIComponent(config.bigbuy.iso) + "&page=" + page + "&pageSize=" + PAGE_SIZE;
    const productsRes = await bbGet("/rest/catalog/products.json" + qs);
    if (!productsRes.ok) {
      if (!fetchedAny) {
        const st = productsRes.status;
        const hint =
          st === 401 || st === 403
            ? "BigBuy rechaza la clave (" + st + "). Revisa que BIGBUY_API_KEY sea solo la clave (sin comillas ni 'Bearer'), que sea de PRODUCCION y que BIGBUY_BASE no este definida como sandbox. Respuesta: " + bodyHint(productsRes)
            : st === 429
              ? "Limite de BigBuy superado (products: 10 peticiones/hora). Se reintentara con la cache."
              : st === 409
                ? "BigBuy aun no tiene el catalogo en cache para tu cuenta (409). Reintenta mas tarde."
                : bodyHint(productsRes);
        return { ok: false, reason: "bigbuy_http_" + st, status: st, error: productsRes.error, hint: hint };
      }
      break;
    }
    const products = Array.isArray(productsRes.data) ? productsRes.data : (productsRes.data && productsRes.data.products) || [];
    if (!products.length) break;
    fetchedAny = true;
    const infoRes = await bbGet("/rest/catalog/productsinformation.json?isoCode=" + encodeURIComponent(config.bigbuy.iso) + "&page=" + page + "&pageSize=" + PAGE_SIZE);
    if (infoRes.ok && Array.isArray(infoRes.data)) {
      infoRes.data.forEach(function (it) { if (it && it.id != null) infoById[it.id] = it; });
    }
    products.forEach(function (p) {
      if (!p) return;
      items.push(toItem(p, infoById[p.id]));
    });
    if (products.length < PAGE_SIZE) break;
  }
  cached = { items: items, at: Date.now() };
  return { ok: true, items: items };
}

async function search(body) {
  body = body || {};
  const q = String((body && (body.query || body.q)) || "").trim();
  const ean = String((body && body.ean) || "").replace(/\D+/g, "");
  if (!q && ean.length < 8) return { ok: false, reason: "query_required" };
  const snap = await snapshot();
  if (!snap.ok) return { ok: false, reason: snap.reason, status: snap.status, error: snap.error, hint: snap.hint };
  const max = Math.min(Math.max(parseInt((body && body.max) || "12", 10) || 12, 1), 50);
  let items;
  if (ean.length >= 8) {
    items = snap.items.filter(function (it) { return it.ean && it.ean.indexOf(ean) !== -1; });
  } else {
    const tokens = tokensOf(q);
    items = snap.items
      .map(function (it) { return { it: it, s: score(it, tokens) }; })
      .filter(function (x) { return x.s > 0; })
      .sort(function (a, b) { return b.s - a.s; })
      .map(function (x) { return x.it; });
  }
  items = items.slice(0, max);
  return {
    ok: items.length > 0,
    reason: items.length ? null : "bigbuy_sin_resultados",
    data: { source: "bigbuy", query: q || ean, via: "catalogo", count: items.length, scanned: snap.items.length, items: items }
  };
}

function score(it, tokens) {
  if (!tokens.length) return 0;
  const hay = tokensOf(it.name + " " + it.brand + " " + it.reference);
  let hits = 0;
  tokens.forEach(function (t) {
    if (hay.some(function (w) { return w === t || w.indexOf(t) === 0 || t.indexOf(w) === 0; })) hits++;
  });
  return hits / tokens.length;
}

const bigbuy = {
  id: "bigbuy",
  label: "BigBuy (mayorista)",
  kind: "wholesale",
  supplier: true,
  actions: {
    ping: async () => ({
      ok: bigbuyReady(),
      configured: bigbuyReady(),
      reason: bigbuyReady() ? null : "bigbuy_not_configured",
      mode: bigbuyReady() ? "api_mayorista" : "sin_clave",
      base: base(),
      keyLength: apiKey().length,
      keyCleaned: apiKey() !== String(config.bigbuy.apiKey || ""),
      note: bigbuyReady()
        ? "Catalogo mayorista (precio neto sin IVA, EAN, stock, imagenes)."
        : "Sin BIGBUY_API_KEY: el proveedor esta apagado."
    }),
    search
  }
};

module.exports = bigbuy;
