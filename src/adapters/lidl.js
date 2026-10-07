const { feedReady } = require("../config");
const { feedAction } = require("./feed");
const { mapLidlItem } = require("./mappers");
const { jsonFetch } = require("../lib/http");

const mapping = {
  name: ["name", "nombre", "title", "titulo", "producto", "descripcion"],
  brand: ["brand", "marca", "fabricante"],
  model: ["model", "modelo"],
  reference: ["reference", "referencia", "ref", "sku", "mpn"],
  ean: ["ean", "upc", "gtin"],
  price: ["price", "precio", "pvp", "precio_venta"],
  stock: ["stock", "disponibilidad", "unidades"],
  url: ["url", "link", "enlace"],
  image: ["image", "imagen", "foto"],
  measures: ["medidas", "measures", "tamaño", "dimensiones"],
  color: ["color"],
  pack: ["pack", "unidades", "cantidad"]
};

const API = "https://www.lidl.es/q/api/search";
const LOCALE = "es_ES";
const ASSORTMENT = "ES";
const VERSION = "2.1.0";
const FETCHSIZE = 48;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

function headers() {
  return {
    "User-Agent": UA,
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "es-ES,es;q=0.9",
    Referer: "https://www.lidl.es/",
    Origin: "https://www.lidl.es"
  };
}

function buildUrl(query, offset) {
  const params = new URLSearchParams({
    q: query,
    locale: LOCALE,
    assortment: ASSORTMENT,
    version: VERSION,
    fetchsize: String(FETCHSIZE),
    offset: String(offset || 0)
  });
  return API + "?" + params.toString();
}

async function fetchOnce(url) {
  return jsonFetch(url, { method: "GET", headers: headers() }, 25000);
}

async function search(body) {
  const query = String((body && (body.query || body.q)) || "").trim();
  if (!query) return { ok: false, reason: "query_required" };
  const offset = Math.max(parseInt((body && body.offset) || "0", 10) || 0, 0);
  const url = buildUrl(query, offset);

  let res = await fetchOnce(url);
  if ((!res.ok || res.status === 401) ) res = await fetchOnce(url);
  if (!res.ok) {
    return {
      ok: false,
      reason: res.status === 401 ? "lidl_throttled" : "lidl_http_" + res.status,
      status: res.status,
      error: res.error,
      hint: res.status === 401 ? "Lidl limito la peticion; reintenta en unos segundos." : "Activa un proveedor de scraping si persiste."
    };
  }
  const payload = res.data;
  if (!payload || !Array.isArray(payload.items)) {
    return { ok: false, reason: "lidl_unexpected_payload", numFound: payload && payload.numFound };
  }
  const items = payload.items
    .map(function (it) {
      return (it && it.gridbox && it.gridbox.data) || (it && it.resultClass === "product" ? it : null);
    })
    .filter(Boolean)
    .map(mapLidlItem);
  return {
    ok: true,
    data: {
      source: "lidl",
      query,
      count: items.length,
      numFound: payload.numFound || items.length,
      offset,
      fetchsize: FETCHSIZE,
      locale: LOCALE,
      currency: "EUR",
      items
    }
  };
}

const lidl = {
  id: "lidl",
  label: "Lidl",
  kind: "scraping",
  actions: {
    ping: async () => ({
      ok: true,
      configured: true,
      reason: null,
      mode: "tienda_api",
      note: "busqueda real via API publica de lidl.es (sin claves)"
    }),
    feed: feedAction("lidl", mapping),
    search
  }
};

module.exports = lidl;
