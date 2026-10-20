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

function buildUrl(query, offset, size) {
  const params = new URLSearchParams({
    q: query,
    locale: LOCALE,
    assortment: ASSORTMENT,
    version: VERSION,
    fetchsize: String(size || FETCHSIZE),
    offset: String(offset || 0)
  });
  return API + "?" + params.toString();
}

async function fetchOnce(url) {
  return jsonFetch(url, { method: "GET", headers: headers() }, 25000);
}

/* Lidl responde 200 con cuerpo vacio cuando la consulta no es de texto
   (los EAN no estan indexados). Eso no es un fallo del parser: es "0 resultados". */
function emptyData(query, offset, fetchsize) {
  return {
    source: "lidl",
    query: query || "",
    count: 0,
    numFound: 0,
    offset: offset || 0,
    fetchsize: fetchsize || FETCHSIZE,
    locale: LOCALE,
    currency: "EUR",
    items: []
  };
}

function isCode(query) {
  return /^\d{8,14}$/.test(String(query || "").trim());
}

/* Lidl mezcla alimentacion con bazar. Para sourcing se descarta solo la alimentacion: menaje, herramientas, hogar, jardin, textil, juguetes y deporte se conservan. */
const FOOD_CATEGORY = /(^|\/)(food|alimentaci[oó]n|bebidas?|frescos?|carnes?|carnicer[ií]a|pescader[ií]a|panader[ií]a|fruter[ií]a|verduras?|l[aá]cteos?|congelados?|despensa|ultramarinos)(\/|$)/i;


function categoryOf(item) {
  return String((item && item.attrs && item.attrs.category) || "").trim();
}

function isFood(item) {
  const category = categoryOf(item);
  return !!category && FOOD_CATEGORY.test(category);
}

function isTarget(item) {
  return !isFood(item);
}

function filterTarget(list) {
  let dropped = 0;
  const items = (list || []).filter(function (it) {
    if (isTarget(it)) return true;
    dropped++;
    return false;
  });
  return { items: items, dropped: dropped };
}

async function search(body) {
  const query = String((body && (body.query || body.q)) || "").trim();
  if (!query) return { ok: false, reason: "query_required" };
  const offset = Math.max(parseInt((body && body.offset) || "0", 10) || 0, 0);
  const url = buildUrl(query, offset);

  let res = await fetchOnce(url);
  if ((!res.ok || res.status === 401) ) res = await fetchOnce(url);
  if (!res.ok) {
    if (res.status === 401 && isCode(query)) {
      return {
        ok: true,
        empty: true,
        reason: "lidl_no_ean",
        hint: "Lidl no indexa EAN: busca por marca + modelo o por nombre.",
        data: emptyData(query, offset, FETCHSIZE)
      };
    }
    return {
      ok: false,
      reason: res.status === 401 ? "lidl_throttled" : "lidl_http_" + res.status,
      status: res.status,
      error: res.error,
      hint: res.status === 401 ? "Lidl limito la peticion; reintenta en unos segundos." : "Activa un proveedor de scraping si persiste."
    };
  }
  const payload = res.data;
  if (payload == null || payload === "") {
    return {
      ok: true,
      empty: true,
      reason: isCode(query) ? "lidl_no_ean" : "lidl_sin_respuesta",
      hint: isCode(query)
        ? "Lidl no indexa EAN: busca por marca + modelo o por nombre. La ficha se coteja despues por identidad."
        : "Lidl devolvio una respuesta vacia para esa busqueda.",
      data: emptyData(query, offset, FETCHSIZE)
    };
  }
  if (!payload || !Array.isArray(payload.items)) {
    /* Algunas palabras genericas ("deporte") devuelven una redireccion a una
       categoria, no productos. Se trata como cero, no como parser roto. */
    if (payload && (payload.redirectURL || payload.resultType === "redirect" || payload.type === "redirect")) {
      return {
        ok: true,
        empty: true,
        reason: "lidl_redirect",
        hint: "Lidl redirige esa busqueda a una categoria; prueba una palabra mas concreta (p. ej. 'mancuernas').",
        data: emptyData(query, offset, FETCHSIZE)
      };
    }
    /* Lidl contesta un documento de busqueda sin "items" cuando no hay
       coincidencias (tipico con EAN). Es un cero legitimo, no un parser roto. */
    if (payload && (payload.resultType === "search" || payload.type === "search" ||
        payload.resultType === "empty" || payload.type === "empty")) {
      return {
        ok: true,
        empty: true,
        reason: isCode(query) ? "lidl_no_ean" : "lidl_sin_resultados",
        hint: isCode(query) ? "Lidl no indexa EAN: usa marca + modelo o el nombre del producto." : null,
        data: emptyData(query, offset, FETCHSIZE)
      };
    }
    if (payload && Number(payload.numFound) === 0) {
      return { ok: true, empty: true, reason: "lidl_sin_resultados", data: emptyData(query, offset, FETCHSIZE) };
    }
    return {
      ok: false,
      reason: "lidl_unexpected_payload",
      numFound: payload && payload.numFound,
      shape: Array.isArray(payload) ? "array" : typeof payload,
      keys: payload && typeof payload === "object" ? Object.keys(payload).slice(0, 12) : [],
      snippet: typeof payload === "string" ? payload.slice(0, 180) : null,
      contentType: (res.headers && res.headers["content-type"]) || null
    };
  }
  const mapped = payload.items
    .map(function (it) {
      return (it && it.gridbox && it.gridbox.data) || (it && it.resultClass === "product" ? it : null);
    })
    .filter(Boolean)
    .map(mapLidlItem);
  const kept = filterTarget(mapped);
  return {
    ok: true,
    data: {
      source: "lidl",
      query,
      count: kept.items.length,
      numFound: payload.numFound || mapped.length,
      foodDropped: kept.dropped,
      offset,
      fetchsize: FETCHSIZE,
      locale: LOCALE,
      currency: "EUR",
      items: kept.items
    }
  };
}

/* Barrido del catalogo sin palabra clave: q vacio devuelve el surtido general de lidl.es. */
async function browse(body) {
  body = body || {};
  const offset = Math.max(parseInt(body.offset || "0", 10) || 0, 0);
  const url = buildUrl("", offset);
  let res = await fetchOnce(url);
  if (!res.ok || res.status === 401) res = await fetchOnce(url);
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
  if (payload == null || payload === "") {
    return {
      ok: true,
      empty: true,
      reason: "lidl_sin_respuesta",
      data: { source: "lidl", kind: "browse", count: 0, numFound: 0, offset, fetchsize: FETCHSIZE, locale: LOCALE, currency: "EUR", items: [] }
    };
  }
  if (!payload || !Array.isArray(payload.items)) {
    if (payload && (payload.resultType === "search" || payload.type === "search" ||
        payload.resultType === "empty" || payload.type === "empty" || Number(payload.numFound) === 0)) {
      return {
        ok: true,
        empty: true,
        reason: "lidl_sin_resultados",
        data: { source: "lidl", kind: "browse", count: 0, numFound: 0, offset, fetchsize: FETCHSIZE, locale: LOCALE, currency: "EUR", items: [] }
      };
    }
    return {
      ok: false,
      reason: "lidl_unexpected_payload",
      numFound: payload && payload.numFound,
      shape: Array.isArray(payload) ? "array" : typeof payload,
      keys: payload && typeof payload === "object" ? Object.keys(payload).slice(0, 12) : [],
      snippet: typeof payload === "string" ? payload.slice(0, 180) : null,
      contentType: (res.headers && res.headers["content-type"]) || null
    };
  }
  const mapped = payload.items
    .map(function (it) {
      return (it && it.gridbox && it.gridbox.data) || (it && it.resultClass === "product" ? it : null);
    })
    .filter(Boolean)
    .map(mapLidlItem);
  const kept = filterTarget(mapped);
  kept.items.forEach(function (it) {
    if (it.oldPrice && it.price && it.oldPrice > it.price) {
      it.discountPct = Math.round((1 - it.price / it.oldPrice) * 100);
    }
  });
  return {
    ok: true,
    data: {
      source: "lidl",
      kind: "browse",
      count: kept.items.length,
      numFound: payload.numFound || mapped.length,
      foodDropped: kept.dropped,
      offset,
      fetchsize: FETCHSIZE,
      locale: LOCALE,
      currency: "EUR",
      items: kept.items
    }
  };
}

const lidl = {
  id: "lidl",
  label: "Lidl",
  kind: "scraping",
  /* Lidl no publica EAN: no entra en la fase 1 (EAN exacto). Si entra en la
     fase 2 (marca/modelo/titulo), donde la nueva regla permite resultados. */
  ean: false,
  actions: {
    /* Ping real: no basta con "la fuente existe". Se pide una busqueda minima
       y se devuelve evidencia (cuantos resultados y una muestra). */
    ping: async () => {
      const started = Date.now();
      const res = await fetchOnce(buildUrl("leche", 0, 1));
      const payload = res.data;
      const raw = res.ok && payload && Array.isArray(payload.items) ? payload.items[0] : null;
      const item = raw ? mapLidlItem((raw.gridbox && raw.gridbox.data) || raw) : null;
      return {
        ok: !!(res.ok && item && (item.name || item.reference)),
        configured: true,
        mode: "tienda_api",
        ms: Date.now() - started,
        status: res.status,
        count: payload && Array.isArray(payload.items) ? payload.items.length : 0,
        sample: item ? { name: String(item.name || "").slice(0, 90), price: item.price, url: item.url } : null,
        reason: res.ok ? (item ? null : "lidl_sin_resultados") : "lidl_http_" + res.status,
        note: "Busqueda real contra la API publica de lidl.es (sin claves)."
      };
    },
    feed: feedAction("lidl", mapping),
    search,
    browse
  }
};

module.exports = lidl;
module.exports.isFood = isFood;
module.exports.isTarget = isTarget;
