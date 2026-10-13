/* Adaptador de tarifas y liquidaciones (canales del PDF).

   El PDF describe estos canales como PDF/Excel/CSV con referencia, EAN y precio
   neto (sin IVA): no se buscan en vivo, se cargan y se cruzan por EAN contra
   Amazon. El adaptador normaliza cualquiera de las formas de entrada a la misma
   lista de productos que consume el motor de match.

   Entradas aceptadas en el cuerpo:
   - csv / tsv / text : contenido en texto (el frontend ya extrae el texto de PDF/Excel)
   - rows             : array de objetos ya parseado
   - feed             : URL de un feed CSV remoto */

const { parseCsv, normalize } = require("./feed");
const { jsonFetch } = require("../lib/http");
const store = require("../lib/store");
const parse = require("../lib/parse");

const MAPPING = {
  name: ["name", "nombre", "title", "titulo", "producto", "descripcion", "descripción"],
  brand: ["brand", "marca", "fabricante"],
  model: ["model", "modelo"],
  reference: ["reference", "referencia", "ref", "sku", "mpn", "codigo", "código"],
  ean: ["ean", "upc", "gtin", "codigo_de_barras", "código_de_barras", "barcode"],
  net: ["net", "neto", "precio_neto", "precio_sin_iva", "sin_iva", "coste"],
  price: ["price", "precio", "pvp", "precio_venta"],
  stock: ["stock", "disponibilidad", "unidades", "cantidad"],
  url: ["url", "link", "enlace"],
  image: ["image", "imagen", "foto"]
};

function sourceOf(body) {
  const s = body && body.source;
  return s === "liquidaciones" ? "liquidaciones" : "tarifas";
}

function textToRows(body) {
  const raw = body && (body.csv || body.tsv || body.text || body.content);
  if (!raw) return null;
  const delimiter = body && body.tsv ? "\t" : null;
  let text = String(raw);
  if (delimiter) text = text.replace(/\n/g, delimiter + "\n");
  const parsed = parseCsv(text);
  if (parsed.rows && parsed.rows.length) return parsed;
  /* Fallback: lineas con patron EAN ... precio (tarifas en texto de PDF). */
  const rows = [];
  text.split(/\r?\n/).forEach(function (line) {
    const ean = parse.detectEan(line);
    const priceMatch = line.match(/([\d]+[.,][\d]{2})\s*(?:€|EUR)?\s*$/);
    if (ean && priceMatch) {
      rows.push({ ean, precio_neto: priceMatch[1], nombre: parse.stripTags(line.replace(/\s+/g, " ")).slice(0, 140) });
    }
  });
  return rows.length ? { headers: Object.keys(rows[0]), rows } : null;
}

function toRows(body) {
  if (body && Array.isArray(body.rows)) return { headers: Object.keys(body.rows[0] || {}), rows: body.rows };
  return textToRows(body);
}

async function parseBody(body) {
  body = body || {};
  const source = sourceOf(body);
  let rows = toRows(body);
  if (!rows && body.feed) {
    const res = await jsonFetch(String(body.feed), { method: "GET", headers: { Accept: "text/csv, */*" } }, 30000);
    if (!res.ok) return { ok: false, reason: "feed_http_" + res.status };
    rows = parseCsv(typeof res.data === "string" ? res.data : JSON.stringify(res.data));
  }
  if (!rows || !rows.rows || !rows.rows.length) return { ok: false, reason: "sin_filas", hint: "Aporta csv/tsv/text, filas ya parseadas o una URL de feed." };
  const items = rows.rows.map(function (r) {
    const it = normalize(r, MAPPING, source);
    it.source = source;
    const net = parse.parsePrice(it.attrs && it.attrs.net);
    if (net != null) {
      it.net = net;
      it.price = net; /* precio neto; el IVA/recargo se aplica en el motor */
    }
    return it;
  }).filter(function (it) { return it.ean || it.reference || it.name; });
  return { ok: items.length > 0, reason: items.length ? null : "sin_productos", data: { source, kind: "tarifa", count: items.length, headers: rows.headers, items } };
}

/* Cruce por EAN: devuelve las tarifas/liquidaciones ya importadas para uno o
   varios codigos de barras. Es la "tarifa cruzada por EAN" del PDF. */
async function lookupBody(body) {
  const raw = body && (body.eans || body.ean || body.codes || body.q);
  const list = Array.isArray(raw) ? raw : String(raw == null ? "" : raw).split(/[\s,;]+/);
  const eans = list.map(function (x) { return String(x == null ? "" : x).replace(/\D/g, ""); }).filter(function (d) { return d.length >= 8; });
  if (!eans.length) return { ok: true, data: { count: 0, items: [], hint: "Aporta ean (uno o varios) para cruzar la tarifa." } };
  const items = await store.tariffFind(eans);
  return { ok: true, data: { count: items.length, eans, items } };
}

const tarifa = {
  id: "tarifas",
  label: "Tarifas de mayoristas y fabricantes",
  kind: "file",
  actions: {
    ping: async () => ({ ok: true, configured: true, reason: null, mode: "fichero", note: "carga CSV/TSV/texto (o filas ya parseadas) y cruza por EAN" }),
    parse: parseBody,
    browse: parseBody,
    search: parseBody,
    lookup: lookupBody
  }
};

const liquidaciones = {
  id: "liquidaciones",
  label: "Listados de liquidación y obsoletos",
  kind: "file",
  actions: {
    ping: async () => ({ ok: true, configured: true, reason: null, mode: "fichero", note: "igual que una tarifa, con prioridad por fecha limite de liquidacion" }),
    parse: async (body) => parseBody(Object.assign({ source: "liquidaciones" }, body || {})),
    browse: async (body) => parseBody(Object.assign({ source: "liquidaciones" }, body || {})),
    search: async (body) => parseBody(Object.assign({ source: "liquidaciones" }, body || {})),
    lookup: lookupBody
  }
};

module.exports = { tarifa, liquidaciones, parseBody, lookupBody, MAPPING };
