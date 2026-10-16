/* DESCUBRIMIENTO DE PROVEEDORES por buscador (Brave Search API).

   El problema que resuelve: hasta ahora "buscar proveedores" consultaba 12 webs
   fijas por scraping -> siempre lo mismo y casi siempre vacio. Aqui, dado un
   EAN (o marca + modelo + nombre), se lanza una busqueda web y se devuelven
   paginas de mayoristas/distribuidores/fabricantes reales. Cada consulta da
   resultados distintos y cubre proveedores que no estan en el catalogo fijo.

   Es una fuente de PROVEEDOR: devuelve enlaces (sin precio). Se integra igual
   que las demas en la Fase 2 de la busqueda inversa y en "Proveedores". */

const { config, discoveryReady, apifyReady } = require("../config");
const apify = require("../lib/apify");
const { jsonFetch } = require("../lib/http");
const eanLib = require("../lib/ean");

const SUPPLIER_HINTS = [
  "mayorista", "al por mayor", "por mayor", "distribuidor", "wholesale", "supplier",
  "proveedor", "dropshipping", "alibaba", "aliexpress", "1688", "bigbuy", "fabricante",
  "import", "b2b", "trade"
];

/* Dominios que no son proveedores: se descartan del resultado. */
const BLOCKED = [
  "amazon.", "google.", "youtube.", "facebook.", "instagram.", "pinterest.", "wikipedia.",
  "tiktok.", "twitter.", "x.com", "linkedin.", "reddit.", "ebay.", "pccomponentes.com"
];

function digits(value) {
  const m = String(value == null ? "" : value).match(/\d+/g);
  return m ? m.join("") : "";
}

function hostOf(url) {
  try {
    return new URL(String(url || "")).hostname.replace(/^www\./, "");
  } catch (e) {
    return "";
  }
}

function isBlocked(url) {
  const host = hostOf(url);
  return !host || BLOCKED.some(function (b) { return host.indexOf(b) !== -1; });
}

function buildQuery(body) {
  const e = digits(body && body.ean);
  if (e.length >= 8) return { q: e, via: "ean" };
  const parts = [body && body.brand, body && body.model, body && body.name]
    .map(function (x) { return String(x == null ? "" : x).trim(); })
    .filter(Boolean);
  return { q: parts.join(" ").trim(), via: "titulo" };
}

function toItem(r) {
  const host = hostOf(r.url);
  const hay = ((r.title || "") + " " + (r.description || "")).toLowerCase();
  return {
    source: "discovery",
    name: String(r.title || host || "").slice(0, 180),
    brand: "",
    model: "",
    reference: "",
    ean: "",
    price: null,
    oldPrice: null,
    stock: null,
    available: true,
    url: r.url || "",
    image: "",
    supplier: host,
    isSupplier: true,
    matchedHint: SUPPLIER_HINTS.some(function (h) { return hay.indexOf(h) !== -1; }),
    attrs: {
      description: String(r.description || "").slice(0, 300),
      domain: host,
      currency: "",
      platform: "discovery"
    },
    capturedAt: new Date().toISOString()
  };
}

async function braveSearch(q, count) {
  const url =
    "https://api.search.brave.com/res/v1/web/search?q=" +
    encodeURIComponent(q) +
    "&count=" + count +
    "&country=" + encodeURIComponent(config.discovery.country) +
    "&search_lang=" + encodeURIComponent(config.discovery.lang);
  const res = await jsonFetch(
    url,
    { method: "GET", headers: { Accept: "application/json", "X-Subscription-Token": config.discovery.apiKey } },
    20000
  );
  if (!res.ok) return { ok: false, reason: "brave_http_" + res.status, status: res.status };
  const results = (res.data && res.data.web && res.data.web.results) || [];
  return { ok: true, results: results };
}

/* Motor principal: Google Search Scraper de Apify. Devuelve el mismo formato
   {title,url,description} que Brave para compartir el resto del flujo. */
async function apifySearch(q, count) {
  const queries = [q, q + " mayorista", q + " distribuidor fabricante"].join("\n");
  const r = await apify.runActor(
    config.apify.actors.search,
    {
      queries: queries,
      countryCode: config.apify.country,
      languageCode: config.discovery.lang,
      resultsPerPage: Math.min(Math.max(count, 10), 20),
      maxPagesPerQuery: 1,
      mobileResults: false,
      saveHtml: false,
      saveHtmlToKeyValueStore: false
    },
    { estCost: 0.01 }
  );
  if (!r.ok) return { ok: false, reason: r.reason, status: r.status };
  const results = [];
  r.items.forEach(function (page) {
    ((page && page.organicResults) || []).forEach(function (o) {
      if (o && o.url) results.push({ title: o.title, url: o.url, description: o.description });
    });
  });
  return results.length ? { ok: true, results: results } : { ok: false, reason: "sin_resultados" };
}

async function search(body) {
  body = body || {};
  const built = buildQuery(body);
  if (!built.q) return { ok: false, reason: "query_required" };
  if (!discoveryReady()) {
    return {
      ok: false,
      reason: "discovery_not_configured",
      hint: "Configura APIFY_TOKEN (recomendado) o BRAVE_API_KEY para descubrir paginas de proveedor."
    };
  }
  const max = Math.min(Math.max(parseInt((body && body.max) || "12", 10) || 12, 3), 20);
  let q = built.q;
  let via = built.via;
  /* Si arrancamos por EAN, se enriquece con marca + nombre para que aparezcan
     proveedores reales del producto y no webs que solo citan el numero. */
  if (via === "ean") {
    const info = await eanLib.lookup(q);
    if (info.ok) {
      const extra = [info.data.brand, info.data.name].filter(Boolean).join(" ").trim();
      if (extra) q = q + " " + extra;
    }
  }
  let r = { ok: false, reason: "sin_motor" };
  let engine = "";
  if (apifyReady()) {
    r = await apifySearch(q, Math.min(max * 2, 20));
    engine = "apify";
  }
  if (!r.ok && config.discovery.apiKey) {
    r = await braveSearch(q, Math.min(max * 2, 20));
    engine = "brave";
  }
  if (!r.ok) return { ok: false, reason: r.reason, status: r.status };
  const seen = {};
  const items = (r.results || [])
    .filter(function (x) { return x && x.url && !isBlocked(x.url); })
    .filter(function (x) {
      const h = hostOf(x.url);
      if (seen[h]) return false;
      seen[h] = 1;
      return true;
    })
    .slice(0, max)
    .map(toItem);
  return {
    ok: items.length > 0,
    reason: items.length ? null : "discovery_sin_resultados",
    data: { source: "discovery", engine: engine, query: q, via: via, count: items.length, items: items }
  };
}

const discovery = {
  id: "discovery",
  label: "Descubrimiento de proveedores (buscador)",
  kind: "discovery",
  supplier: true,
  actions: {
    ping: async () => ({
      ok: discoveryReady(),
      configured: discoveryReady(),
      reason: discoveryReady() ? null : "apify_not_configured",
      mode: apifyReady() ? "apify_google_search" : discoveryReady() ? "brave_search" : "sin_clave",
      note: discoveryReady()
        ? "Descubre paginas de proveedor por EAN o marca + modelo."
        : "Sin APIFY_TOKEN ni BRAVE_API_KEY: el descubrimiento esta apagado."
    }),
    lookup: async (body) => await eanLib.lookup(body && body.ean),
    search
  }
};

module.exports = discovery;
