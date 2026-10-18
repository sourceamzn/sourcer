"use strict";
/* Fase 4 · enriquecimiento de ofertas "a revisar" sin EAN.
   Abre la ficha del proveedor y lee el JSON-LD de producto (gtin13, mpn, sku,
   brand). No inventa nada: si la pagina no declara el dato, no se toca.
   Pensado para pocas URLs (maximo configurable) y cache por URL en la misma
   busqueda. La descarga se inyecta en tests para no depender de la red. */

const { jsonFetch, isSafeRemoteUrl } = require("./http");
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

function textOf(v) {
  if (typeof v === "string") return v.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  if (typeof v === "number" && isFinite(v)) return String(v);
  if (v && typeof v === "object" && v.value != null) return textOf(v.value);
  return "";
}

function imagesOf(p) {
  const out = [];
  function add(v) {
    if (!v) return;
    if (typeof v === "string") { if (/^https?:\/\//i.test(v)) out.push(v); return; }
    if (Array.isArray(v)) { v.forEach(add); return; }
    if (typeof v === "object") add(v.url || v.contentUrl || v["@id"]);
  }
  add(p && p.image);
  add(p && p.images);
  return Array.from(new Set(out)).slice(0, 6);
}

function numberOf(v) {
  if (v == null) return null;
  if (typeof v === "number") return isFinite(v) && v > 0 ? v : null;
  const m = String(v).replace(/\s/g, "").replace(/[^\d,.\-]/g, "").match(/-?\d+(?:[.,]\d+)?/);
  if (!m) return null;
  const n = parseFloat(m[0].replace(",", "."));
  return isFinite(n) && n > 0 ? n : null;
}

/* Ofertas del JSON-LD: precio, moneda, disponibilidad y enlace. Puede haber
   una o varias; se ordenan de mas barata a mas cara. */
function offersOf(p) {
  const raw = p && p.offers;
  const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  const out = [];
  list.forEach(function (o) {
    if (!o || typeof o !== "object") return;
    const price = numberOf(o.price != null ? o.price : (o.lowPrice != null ? o.lowPrice : o.highPrice));
    if (!(price > 0)) return;
    out.push({
      price: price,
      currency: String(o.priceCurrency || o.currency || "").trim().toUpperCase(),
      url: String(o.url || "").trim(),
      availability: String(o.availability || "").replace(/^https?:\/\/schema\.org\//i, "")
    });
  });
  out.sort(function (a, b) { return a.price - b.price; });
  return out;
}

/* Contacto publicado en la ficha (mailto o correo visible). Se usa para que
   el usuario pueda pedir precio/condiciones sin salir de la herramienta. */
function contactsOf(html) {
  const text = String(html || "");
  const emails = [];
  const re = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
  let m;
  while ((m = re.exec(text))) {
    const e = m[0].toLowerCase();
    if (/\.(png|jpe?g|gif|webp|svg)$/i.test(e)) continue;
    if (/@(?:example|domain|email|sentry|wixpress|2x|3x)\./i.test(e)) continue;
    if (emails.indexOf(e) === -1) emails.push(e);
  }
  const phones = [];
  const tel = /href\s*=\s*["']tel:([^"']+)["']/gi;
  while ((m = tel.exec(text))) {
    const p = m[1].replace(/[^\d+().\s-]/g, "").trim();
    if (p && phones.indexOf(p) === -1) phones.push(p);
  }
  return { emails: emails.slice(0, 3), phones: phones.slice(0, 3) };
}

function attrsOfTag(tag) {
  const out = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let m;
  while ((m = re.exec(tag))) out[m[1].toLowerCase()] = m[3] != null ? m[3] : (m[4] != null ? m[4] : m[5]);
  return out;
}

function metaMap(html) {
  const out = {};
  const tags = String(html || "").match(/<meta\b[^>]*>/gi) || [];
  tags.forEach(function (tag) {
    const a = attrsOfTag(tag);
    const key = String(a.property || a.name || a.itemprop || "").toLowerCase();
    if (key && a.content != null && out[key] == null) out[key] = String(a.content).trim();
  });
  return out;
}

/* Respaldo para fichas sin JSON-LD: Open Graph y metadatos de producto.
   Solo se usa cuando el llamador pide permitir fichas sin identificador. */
function metaOf(html) {
  const m = metaMap(html);
  const contacts = contactsOf(html);
  const title = m["og:title"] || m["twitter:title"] || (String(html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "";
  const image = m["og:image"] || m["og:image:secure_url"] || m["twitter:image"] || "";
  const amount = numberOf(m["product:price:amount"] || m["og:price:amount"] || m["price"]);
  const currency = String(m["product:price:currency"] || m["og:price:currency"] || "").trim().toUpperCase();
  const brand = String(m["product:brand"] || m["og:brand"] || "").trim();
  const mpn = String(m["product:retailer_item_id"] || m["product:sku"] || m["mpn"] || "").trim();
  const name = textOf(title);
  const description = textOf(m["og:description"] || m["description"] || m["twitter:description"] || "");
  if (!name && !description && !(amount > 0) && !image) return null;
  return {
    name: name.slice(0, 300),
    brand: brand,
    gtin: "",
    mpn: mpn.slice(0, 80),
    sku: "",
    description: description.slice(0, 1200),
    specs: [],
    features: [],
    images: image ? [image] : [],
    color: "",
    size: "",
    material: "",
    weight: "",
    price: amount,
    currency: currency,
    availability: "",
    offerUrl: "",
    contactEmail: contacts.emails[0] || "",
    contactPhone: contacts.phones[0] || "",
    source: "meta"
  };
}

function specsOf(p) {
  const out = [];
  [p && p.additionalProperty, p && p.additionalProperties, p && p.hasAdditionalProperty].forEach(function (list) {
    if (!Array.isArray(list)) list = list ? [list] : [];
    list.forEach(function (x) {
      if (x && x.name != null && x.value != null) out.push({ name: String(x.name).trim(), value: textOf(x.value) });
    });
  });
  return out.filter(function (x) { return x.name && x.value; }).slice(0, 24);
}

function featuresOf(p) {
  const out = [];
  [p && p.features, p && p.featureList].forEach(function (list) {
    if (!Array.isArray(list)) return;
    list.forEach(function (x) {
      const v = textOf(x);
      if (v) out.push(v);
    });
  });
  return out.slice(0, 20);
}

/* Devuelve los datos del primer Product con identificador, o null si la
   pagina no lo declara. Con opts.allowNoId=true tambien acepta fichas sin
   gtin/mpn/sku (necesario para paginas de proveedor descubiertas por Google)
   y cae a Open Graph/metadatos si no hay JSON-LD de producto. */
function parseJsonLd(html, opts) {
  opts = opts || {};
  const allowNoId = Boolean(opts.allowNoId);
  const contacts = contactsOf(html);
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
    const name = String(p.name || "").trim();
    if (!allowNoId && !g && !mpn && !sku) continue;
    if (allowNoId && !g && !mpn && !sku && !name) continue;
    const offers = offersOf(p);
    const best = offers[0] || null;
    return {
      name: name.slice(0, 300),
      brand: brandOf(p),
      gtin: g,
      mpn: mpn.slice(0, 80),
      sku: sku.slice(0, 80),
      description: textOf(p.description).slice(0, 1200),
      specs: specsOf(p),
      features: featuresOf(p),
      images: imagesOf(p),
      color: textOf(p.color),
      size: textOf(p.size),
      material: textOf(p.material),
      weight: textOf(p.weight),
      price: best ? best.price : null,
      currency: best ? best.currency : "",
      availability: best ? best.availability : "",
      offerUrl: best ? best.url : "",
      offers: offers.slice(0, 5),
      contactEmail: contacts.emails[0] || "",
      contactPhone: contacts.phones[0] || "",
      source: "jsonld"
    };
  }
  return allowNoId ? metaOf(html) : null;
}

async function fetchPage(url, timeoutMs) {
  if (!isSafeRemoteUrl(url)) return null;
  const r = await jsonFetch(url, {
    headers: {
      "User-Agent": UA,
      "Accept": "text/html,application/xhtml+xml",
      "Accept-Language": "es-ES,es;q=0.9,en;q=0.8"
    },
    redirect: "follow"
  }, timeoutMs || 6000);
  let html = r.ok && typeof r.data === "string" ? r.data : "";
  /* Muchas fichas de proveedor bloquearon la descarga directa (el log de
     match_enrich daba found:0). Se reintenta con el lector web del backend,
     que cae a r.jina.ai, sin dejar colgado el trabajo. */
  if (!html) {
    try {
      const web = require("../adapters/web");
      const w = await Promise.race([
        web.actions.read({ url: url }),
        new Promise(function (res) { setTimeout(function () { res(null); }, Math.max(3000, timeoutMs || 6000)); })
      ]);
      if (w && w.ok && w.text) html = w.text;
    } catch (e) {}
  }
  if (!html) return null;
  return parseJsonLd(html.slice(0, MAX_HTML), { allowNoId: true });
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
    return o && o.url && isSafeRemoteUrl(String(o.url));
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
      if (!o.description && data.description) o.description = data.description;
      if (!o.specs && data.specs && data.specs.length) o.specs = data.specs;
      if (!o.features && data.features && data.features.length) o.features = data.features;
      if (!o.images && data.images && data.images.length) o.images = data.images;
      if (!o.image && data.images && data.images.length) o.image = data.images[0];
      if (!(o.price > 0) && data.price > 0) {
        o.price = data.price;
        o.priceFromPage = true;
      }
      if (!o.currency && data.currency) o.currency = data.currency;
      if (!o.color && data.color) o.color = data.color;
      if (!o.size && data.size) o.size = data.size;
      if (!o.material && data.material) o.material = data.material;
      if (!o.weight && data.weight) o.weight = data.weight;
      if (!o.offerUrl && data.offerUrl) o.offerUrl = data.offerUrl;
      if (!o.availability && data.availability) o.availability = data.availability;
      if (!o.contactEmail && data.contactEmail) o.contactEmail = data.contactEmail;
      if (!o.contactPhone && data.contactPhone) o.contactPhone = data.contactPhone;
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

module.exports = { parseJsonLd, enrich, fetchPage, gtinOf, contactsOf };
