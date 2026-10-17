"use strict";
/* Fase 4 · enriquecimiento de ofertas "a revisar" sin EAN.
   Abre la ficha del proveedor y lee el JSON-LD de producto (gtin13, mpn, sku,
   brand). No inventa nada: si la pagina no declara el dato, no se toca.
   Pensado para pocas URLs (maximo configurable) y cache por URL en la misma
   busqueda. La descarga se inyecta en tests para no depender de la red. */

const { jsonFetch } = require("./http");
const gtin = require("./gtin");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const MAX_HTML = 900000;

function ldBlocks(html) {
  const out = [];
  const re = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  const text = String(html || "");
  let m;
  while ((m = re.exec(text))) out.push(m[1]);
  return out;
}

function productsOf(node, acc) {
  if (!node) return acc;
  if (Array.isArray(node)) {
    node.forEach(function (n) { productsOf(n, acc); });
    return acc;
  }
  if (typeof node !== "object") return acc;
  const type = node["@type"];
  const types = Array.isArray(type) ? type : [type];
  if (types.some(function (t) { return String(t || "").toLowerCase() === "product"; })) acc.push(node);
  if (node["@graph"]) productsOf(node["@graph"], acc);
  Object.keys(node).forEach(function (k) {
    if (k === "@graph") return;
    const v = node[k];
    if (v && typeof v === "object") productsOf(v, acc);
  });
  return acc;
}

function brandOf(p) {
  const b = p && p.brand;
  if (typeof b === "string") return b.trim();
  if (Array.isArray(b)) {
    for (let i = 0; i < b.length; i++) {
      const v = brandOf({ brand: b[i] });
      if (v) return v;
    }
    return "";
  }
  if (b && typeof b === "object" && b.name) return String(b.name).trim();
  return "";
}

function gtinOf(p) {
  if (!p) return "";
  const keys = ["gtin13", "gtin12", "gtin14", "gtin8", "gtin", "ean", "isbn"];
  for (let i = 0; i < keys.length; i++) {
    const n = gtin.normalize(p[keys[i]]);
    if (n) return n;
  }
  return "";
}

/* Devuelve { name, brand, gtin, mpn, sku } del primer Product con
   identificador, o null si la pagina no lo declara. */
function parseJsonLd(html) {
  const blocks = ldBlocks(html);
  for (let i = 0; i < blocks.length; i++) {
    let data;
    try {
      data = JSON.parse(String(blocks[i]).replace(/^\s*<!--/, "").replace(/-->\s*$/, "").trim());
    } catch (e) {
      continue;
    }
    const list = productsOf(data, []);
    if (!list.length) continue;
    const withId = list.filter(function (p) { return gtinOf(p) || p.mpn || p.sku; });
    const p = withId[0] || list[0];
    const g = gtinOf(p);
    const mpn = String(p.mpn || "").trim();
    const sku = String(p.sku || "").trim();
    if (!g && !mpn && !sku) continue;
    return {
      name: String(p.name || "").trim().slice(0, 300),
      brand: brandOf(p),
      gtin: g,
      mpn: mpn.slice(0, 80),
      sku: sku.slice(0, 80)
    };
  }
  return null;
}

async function fetchPage(url, timeoutMs) {
  const r = await jsonFetch(url, {
    headers: {
      "User-Agent": UA,
      "Accept": "text/html,application/xhtml+xml",
      "Accept-Language": "es-ES,es;q=0.9,en;q=0.8"
    },
    redirect: "follow"
  }, timeoutMs || 6000);
  if (!r.ok || typeof r.data !== "string") return null;
  return parseJsonLd(r.data.slice(0, MAX_HTML));
}

/* enrich(offers, { max, concurrency, timeoutMs, cache, fetchPage })
   Muta cada oferta con .enriched y, si procede, rellena ean/brand/model.
   Devuelve { tried, found, cache }. */
async function enrich(offers, opts) {
  opts = opts || {};
  const max = Math.max(0, opts.max == null ? 6 : opts.max);
  const concurrency = Math.max(1, opts.concurrency || 3);
  const timeoutMs = Math.max(1000, opts.timeoutMs || 6000);
  const cache = opts.cache || new Map();
  const fetchOne = opts.fetchPage || fetchPage;
  const list = (Array.isArray(offers) ? offers : []).filter(function (o) {
    return o && o.url && /^https?:\/\//i.test(String(o.url));
  }).slice(0, max);
  let index = 0;
  async function worker() {
    while (index < list.length) {
      const o = list[index++];
      const key = String(o.url);
      let data = cache.get(key);
      if (data === undefined) {
        try { data = await fetchOne(key, timeoutMs); } catch (e) { data = null; }
        cache.set(key, data);
      }
      if (!data) continue;
      o.enriched = data;
      if (!o.ean && data.gtin) o.ean = data.gtin;
      if (!o.brand && data.brand) o.brand = data.brand;
      if (!o.model) o.model = data.mpn || data.sku || "";
    }
  }
  const workers = [];
  for (let w = 0; w < Math.min(concurrency, list.length); w++) workers.push(worker());
  await Promise.all(workers);
  return {
    tried: list.length,
    found: list.filter(function (o) { return o.enriched; }).length,
    cache: cache
  };
}

module.exports = { parseJsonLd, enrich, fetchPage, gtinOf };
