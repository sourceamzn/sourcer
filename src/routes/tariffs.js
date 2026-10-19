"use strict";
/* Importacion de tarifas de proveedor al almacen.
   El navegador ya extrae el texto de PDF/Excel/CSV; aqui se valida el codigo
   de barras (digito de control), se normaliza el precio neto y se guarda para
   el cruce por EAN que usan la ficha del producto y la busqueda inversa. */

const { parseBody } = require("../adapters/tarifa");
const store = require("../lib/store");
const gtin = require("../lib/gtin");
const parse = require("../lib/parse");

const MAX_ROWS = 5000;
const BATCH = 500;

/* Digito de control GS1 (EAN-8/12/13 y GTIN-14). */
function validGtin(code) {
  const s = String(code == null ? "" : code);
  if (!/^(?:\d{8}|\d{12,14})$/.test(s)) return false;
  let sum = 0;
  let w = 3;
  for (let i = s.length - 2; i >= 0; i--) {
    sum += Number(s[i]) * w;
    w = w === 3 ? 1 : 3;
  }
  return (10 - (sum % 10)) % 10 === Number(s[s.length - 1]);
}

function sourceName(raw) {
  const s = String(raw == null ? "" : raw)
    .replace(/[^\wáéíóúüñÁÉÍÓÚÜÑ .:/()-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
  return s || "import";
}

function first() {
  for (let i = 0; i < arguments.length; i++) {
    const v = arguments[i];
    if (v != null && String(v).trim() !== "") return v;
  }
  return "";
}

/* Filas (ya normalizadas o con cabeceras en espanol/ingles) -> items listos
   para store.tariffUpsert. Nunca inventa EAN ni precio: lo que falta se
   cuenta y se explica en el informe. */
function prepareRows(rows) {
  const stats = { received: (rows || []).length, valid: 0, duplicates: 0, sin_ean: 0, ean_invalido: 0, sin_precio: 0 };
  const byEan = {};
  (rows || []).forEach(function (row) {
    if (!row || typeof row !== "object") {
      stats.sin_ean++;
      return;
    }
    const a = row.attrs || {};
    const ean = gtin.normalize(gtin.digitsOnly(first(row.ean, row.ean13, row.eans, a.ean, a.upc, a.gtin, a.gtin13, a.barcode, row.upc)));
    if (!ean) {
      stats.sin_ean++;
      return;
    }
    if (!validGtin(ean)) {
      stats.ean_invalido++;
      return;
    }
    const pvp = parse.parsePrice(first(row.price, row.pvp, a.price, a.precio, a.pvp, a.precio_venta));
    const net = parse.parsePrice(first(row.net, row.pvd, a.net, a.precio_neto, a.precio_sin_iva, a.sin_iva, a.coste));
    const price = net != null ? net : pvp;
    if (!(price > 0)) {
      stats.sin_precio++;
      return;
    }
    const item = {
      ean: ean,
      name: String(first(row.name, a.name, a.nombre, a.title, a.titulo, a.producto, a.descripcion) || "").slice(0, 240) || ("EAN " + ean),
      brand: String(first(row.brand, a.brand, a.marca, a.fabricante) || "").slice(0, 120),
      model: String(first(row.model, a.model, a.modelo) || "").slice(0, 120),
      reference: String(first(row.reference, a.reference, a.referencia, a.ref, a.sku, a.mpn, a.codigo) || "").slice(0, 120),
      net: price,
      price: pvp != null ? pvp : price,
      stock: parse.parsePrice(first(row.stock, a.stock, a.disponibilidad, a.unidades)),
      url: String(first(row.url, a.url, a.link, a.enlace) || "").slice(0, 500),
      image: String(first(row.image, a.image, a.imagen, a.foto) || "").slice(0, 500)
    };
    if (byEan[ean]) stats.duplicates++;
    byEan[ean] = item;
  });
  const items = Object.keys(byEan).map(function (k) { return byEan[k]; });
  stats.valid = items.length;
  return { items: items, stats: stats, sample: items.slice(0, 5) };
}

async function rowsFromBody(body) {
  if (Array.isArray(body.rows)) return { rows: body.rows, headers: Object.keys(body.rows[0] || {}) };
  if (body.feed) {
    const out = await parseBody({ feed: body.feed, source: "tarifas" });
    if (!out.ok) return { error: out.reason || "sin_filas" };
    return { rows: out.data.items, headers: out.data.headers || [] };
  }
  const text = body.csv != null ? body.csv : (body.tsv != null ? body.tsv : body.text);
  if (text == null || text === "") return { rows: [], headers: [] };
  const out = await parseBody({ csv: String(text), source: "tarifas" });
  if (!out.ok) return { error: out.reason || "sin_filas" };
  return { rows: out.data.items, headers: out.data.headers || [] };
}

async function importTariffs(req, res) {
  const body = req.body || {};
  let input;
  try {
    input = await rowsFromBody(body);
  } catch (e) {
    return res.status(500).json({ ok: false, reason: "import_error", detail: String((e && e.message) || e) });
  }
  if (input.error) return res.status(400).json({ ok: false, reason: input.error });
  if (!input.rows || !input.rows.length) {
    return res.status(400).json({ ok: false, reason: "sin_filas", hint: "Envia rows, csv/text o feed con EAN y precio." });
  }
  if (input.rows.length > MAX_ROWS) {
    return res.status(413).json({ ok: false, reason: "demasiadas_filas", max: MAX_ROWS, received: input.rows.length, hint: "Divide el fichero o envia lotes de 500 filas." });
  }
  const source = sourceName(body.source);
  const prepared = prepareRows(input.rows);
  let stored = 0;
  for (let i = 0; i < prepared.items.length; i += BATCH) {
    stored += await store.tariffUpsert(prepared.items.slice(i, i + BATCH), source);
  }
  const stats = prepared.stats;
  res.json({
    ok: true,
    data: {
      source: source,
      received: stats.received,
      valid: stats.valid,
      imported: stored,
      duplicates: stats.duplicates,
      sin_ean: stats.sin_ean,
      ean_invalido: stats.ean_invalido,
      sin_precio: stats.sin_precio,
      sample: prepared.sample,
      headers: input.headers || []
    }
  });
}

module.exports = { importTariffs, prepareRows, validGtin, sourceName, MAX_ROWS };
