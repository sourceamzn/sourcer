/* EXPLORAR (descubrimiento abierto de productos con precio, foto y tienda).

   Sustituye al "barrido" de 3-4 catalogos fijos: lanza consultas a Google
   Shopping (Apify) y devuelve productos de CUALQUIER tienda que Google indexe
   (merchant, precio en EUR, imagen y enlace directo).
   - Sin palabra clave (browse): elige varias categorias distintas en cada
     ejecucion (rotacion por semilla) para que el resultado cambie y sea diverso.
   - Con palabra clave (search): amplia con sinonimos y variantes comerciales.
   Solo se declara "consultada" si la peticion a Apify se ejecuto (evidencia en
   data.evidence). Es una fuente de PRODUCTO/precio, no un listado de proveedores. */

const { config, apifyReady } = require("../config");
const apify = require("../lib/apify");
const gtin = require("../lib/gtin");

const CATEGORIES = [
  "secador de pelo", "freidora de aire", "aspirador robot", "auriculares bluetooth", "cafetera monodosis",
  "batidora de mano", "plancha de pelo", "afeitadora electrica", "cepillo de dientes electrico", "robot de cocina",
  "purificador de aire", "humidificador", "ventilador de torre", "calefactor", "bascula de bano",
  "altavoz bluetooth", "cargador inalambrico", "powerbank", "camara de seguridad wifi", "bombilla inteligente",
  "organizador de cocina", "set de cuchillos", "sarten antiadherente", "olla a presion", "termo",
  "mochila antirrobo", "maleta cabina", "silla gaming", "escritorio elevable", "lampara led escritorio",
  "juguete educativo", "puzzle", "juego de mesa", "patinete electrico", "casco bicicleta",
  "masajeador cervical", "pistola de masaje", "esterilla yoga", "mancuernas ajustables", "comba fitness",
  "comedero automatico gatos", "cama perro", "rascador gatos", "colchon viscoelastica", "almohada cervical",
  "maquina de coser", "bordadora", "kit de costura", "tela para coser", "herramienta electrica",
  "sierra circular", "taladro percutor", "compresor de aire", "hidrolimpiadora", "deshumidificador"
];
const SYNONYMS = {
  "secador de pelo": ["secador cabello", "hair dryer"],
  "freidora de aire": ["air fryer", "freidora sin aceite"],
  "auriculares": ["cascos", "earbuds"],
  "aspirador": ["aspiradora", "vacuum"],
  "plancha de pelo": ["alisador", "hair straightener"]
};
const VARIANTS = ["", " oferta", " precio mayorista"];

function pick(list, n, seed) {
  const out = [];
  const used = {};
  let s = Math.abs(parseInt(seed, 10) || Date.now());
  while (out.length < Math.min(n, list.length)) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const i = s % list.length;
    if (used[i]) continue;
    used[i] = 1;
    out.push(list[i]);
  }
  return out;
}

function expand(q) {
  const base = String(q || "").trim().toLowerCase();
  const out = [base];
  Object.keys(SYNONYMS).forEach(function (k) {
    if (base.indexOf(k) !== -1) SYNONYMS[k].forEach(function (s) { out.push(base.replace(k, s)); });
  });
  VARIANTS.forEach(function (v) { if (v) out.push(base + v); });
  return out.filter(function (x, i) { return x && out.indexOf(x) === i; }).slice(0, 4);
}

function eanOf(o) {
  const sources = [o, o && o.productDetails, o && o.productInfo, o && o.offers && (Array.isArray(o.offers) ? o.offers[0] : o.offers)];
  const keys = ["gtin", "gtin13", "gtin12", "gtin14", "gtin8", "ean", "ean13", "upc", "barcode"];
  for (let s = 0; s < sources.length; s++) {
    const x = sources[s];
    if (!x || typeof x !== "object") continue;
    for (let i = 0; i < keys.length; i++) {
      const n = gtin.normalize(x[keys[i]]);
      if (n) return n;
    }
  }
  return "";
}

function toItem(o, query) {
  const price = Number(o.priceNumeric);
  const cur = String(o.currency || "EUR");
  const eur = /eur|�'�/i.test(cur) || !o.currency;
  return {
    source: "explorar",
    name: String(o.title || "").slice(0, 180),
    brand: "", model: "", reference: "", ean: eanOf(o),
    price: eur && price > 0 ? price : null,
    priceText: !eur && price > 0 ? cur + " " + price : "",
    oldPrice: null, stock: null, available: true,
    url: String(o.productUrl || o.url || o.link || ""),
    image: String(o.imageUrl || o.image || o.thumbnail || ""),
    supplier: String(o.merchant || o.seller || ""),
    isSupplier: false,
    attrs: { currency: cur, platform: "google_shopping", merchant: String(o.merchant || ""), rating: o.rating == null ? "" : String(o.rating), delivery: String(o.delivery || ""), query: query },
    capturedAt: o.scrapedAt || new Date().toISOString()
  };
}

async function run(queries, max, noCache) {
  if (!apifyReady()) return { ok: false, reason: "apify_sin_token" };
  const actor = config.apify.actors.shopping;
  if (!actor) return { ok: false, reason: "actor_no_configurado" };
  const op = apify.newOp();
  const t0 = Date.now();
  const r = await apify.runActor(
    actor,
    { queries: queries, maxResults: Math.max(40, max), country: String(config.apify.country || "es").toLowerCase(), language: "es", sortBy: "relevance" },
    { op: op, estCost: 0.03 * queries.length, timeoutSec: 90, noCache: noCache }
  );
  if (!r.ok) return { ok: false, reason: r.reason, detail: r.detail };
  const seen = {};
  const items = [];
  r.items.forEach(function (o) {
    const it = toItem(o, o.query || "");
    const k = it.url || (it.name + "|" + it.supplier);
    if (!it.name || seen[k]) return;
    seen[k] = 1;
    items.push(it);
  });
  return { ok: true, items: items, evidence: { actor: actor, queries: queries, ms: Date.now() - t0, cached: Boolean(r.cached), rawItems: r.items.length } };
}

function pack(res, mode, queries, max) {
  if (!res.ok) return { ok: false, reason: res.reason, detail: res.detail };
  /* Diversidad: no mas de 3 productos por tienda y mezcla entre consultas. */
  const perMerchant = {};
  const items = res.items.filter(function (it) {
    const m = it.supplier || "?";
    perMerchant[m] = (perMerchant[m] || 0) + 1;
    return perMerchant[m] <= 3;
  }).slice(0, max);
  return {
    ok: items.length > 0,
    reason: items.length ? null : "sin_resultados",
    data: { source: "explorar", kind: mode, count: items.length, queries: queries, evidence: res.evidence, items: items }
  };
}

async function browse(body) {
  body = body || {};
  const max = Math.min(Math.max(parseInt(body.max || "24", 10) || 24, 6), 60);
  const queries = pick(CATEGORIES, 4, body.seed);
  return pack(await run(queries, Math.max(20, Math.ceil(max / 2)), Boolean(body.fresh)), "browse", queries, max);
}

async function search(body) {
  body = body || {};
  const q = String(body.query || body.name || "").trim();
  if (!q) return { ok: false, reason: "query_required" };
  const max = Math.min(Math.max(parseInt(body.max || "24", 10) || 24, 6), 60);
  const queries = expand(q);
  return pack(await run(queries, max, Boolean(body.fresh)), "search", queries, max);
}

module.exports = {
  id: "explorar",
  label: "Explorar Internet (Google Shopping)",
  kind: "discovery_open",
  actions: {
    ping: async function () {
      const ok = apifyReady() && Boolean(config.apify.actors.shopping);
      return { ok: ok, configured: ok, reason: ok ? null : "apify_sin_token", mode: ok ? "apify:" + config.apify.actors.shopping : "sin_clave", note: "Productos con precio, foto y tienda de todo Google Shopping (no una lista fija de webs)." };
    },
    browse: browse,
    search: search
  },
  CATEGORIES: CATEGORIES,
  expand: expand
};