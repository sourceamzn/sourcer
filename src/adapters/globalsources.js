/* Global Sources: directorio B2B (Hong Kong, desde 1971) centrado en China y
   Asia. Aporta lo que Alibaba/1688 no publican sin cuenta: sello "Verified
   Manufacturer" (ambito de fabricacion verificado por terceros), Business Type
   (Manufacturer / Trading Company / ...), numero de empleados, anos en la
   plataforma y mercados de exportacion, todo en HTML publico.

   Sin clave ni actor de Apify: dos peticiones HTTP y parseo con expresiones
   regulares sobre el HTML que sirve el servidor (SSR). Si la pagina de
   proveedores no responde, se usan las tarjetas de producto de la misma
   categoria, que traen precio orientativo y MOQ. */

const { jsonFetch } = require("../lib/http");
const scrape = require("../lib/scrape");
const { config } = require("../config");

const BASE = "https://www.globalsources.com";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const HEADERS = {
  "User-Agent": UA,
  "Accept-Language": "en-US,en;q=0.9",
  Accept: "text/html,application/xhtml+xml"
};

function text(v) {
  return String(v == null ? "" : v)
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter(function (t) { return t.length >= 3; });
}

/* "Blender manufacturer" -> "blender": las palabras de la consulta que ya
   anade el buscador no forman parte de la URL del directorio. */
function slugify(q) {
  return String(q || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\b(manufacturer|manufacturers|supplier|suppliers|factory|factories|wholesale|china|oem|odm)\b/g, " ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

const CACHE = new Map();
const CACHE_MS = 10 * 60 * 1000;

function sleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}

async function getHtml(url, timeoutMs) {
  const hit = CACHE.get(url);
  if (hit && Date.now() - hit.at < CACHE_MS) return { ok: hit.ok, status: hit.status, html: hit.html, cached: true };
  let out = { ok: false, status: 0, html: "" };
  for (let attempt = 0; attempt < 2; attempt++) {
    /* CloudFront corta por huella TLS a los clientes Node (403/429): por eso
       se usa el proveedor de scraping cuando esta configurado y la peticion
       directa solo como respaldo. */
    const target = attempt === 0 && scrape.providerReady() ? scrape.providerUrl(url) : url;
    if (!target) break;
    const r = await jsonFetch(target, { headers: HEADERS, redirect: "follow" }, timeoutMs || 20000);
    const html = typeof r.data === "string" ? r.data : "";
    out = { ok: Boolean(r.ok) && html.length > 500, status: r.status || 0, html: html };
    if (out.ok) break;
    /* Limite de peticiones o error temporal del servidor: se reintenta una vez. */
    if (out.status !== 429 && out.status < 500) break;
    await sleep(attempt === 0 ? 2500 : 0);
  }
  if (out.ok) CACHE.set(url, { at: Date.now(), ok: out.ok, status: out.status, html: out.html });
  return out;
}

/* La pagina de producto de una categoria enlaza sus subcategorias como
   "/category/<slug>-for-sale-price_<id>/". La lista de proveedores es la misma
   URL con "-manufacturer-supplier_<id>/". Se elige la categoria que mas
   palabras comparte con la consulta y, a igualdad, la mas general (slug corto). */
function pickCategory(html, query) {
  /* Singular tolerante: "blenders" debe casar con la consulta "blender". */
  const sing = function (t) { return t.replace(/s$/, ""); };
  const qt = tokens(query).map(sing);
  const re = /\/category\/([a-z0-9\-]+)-for-sale-price_(\d+)\//g;
  const seen = {};
  let best = null;
  let m;
  while ((m = re.exec(String(html || "")))) {
    const slug = m[1];
    const id = m[2];
    if (seen[id]) continue;
    seen[id] = 1;
    const st = tokens(slug);
    let score = 0;
    for (let i = 0; i < st.length; i++) if (qt.indexOf(sing(st[i])) !== -1) score++;
    if (!best || score > best.score || (score === best.score && st.length < tokens(best.slug).length)) {
      best = { slug: slug, id: id, score: score };
    }
  }
  return best;
}

function attrsOf(seg) {
  const out = {};
  const re = /<span class="attr"[^>]*>([^<]{2,40}?):\s*<\/span>\s*<span class="val"[^>]*>([\s\S]{0,300}?)<\/span>/g;
  let m;
  while ((m = re.exec(seg))) {
    const k = text(m[1]).toLowerCase();
    if (k) out[k] = text(m[2]);
  }
  return out;
}

function badgesOf(seg) {
  const out = [];
  const re = /alt="([A-Za-z ]{3,30})"/g;
  let m;
  while ((m = re.exec(seg))) out.push(m[1].toLowerCase());
  return out;
}

function isFactory(badges, businessType) {
  /* El HTML del sitio escribe "Verified Maufacturer" (sin la n) en algunas
     tarjetas: se aceptan las dos formas. */
  if (badges.some(function (b) { return /verified m[a-z]*facturer|premier m[a-z]*facturer|o2o m[a-z]*facturer/.test(b); })) return true;
  return /manufactur|factory|fabric/i.test(String(businessType || ""));
}

function splitCards(html) {
  return String(html || "").split(/<li class="item card-box/).slice(1);
}

/* Tarjetas de proveedor: nombre, sello, pais, anos, Business Type y empleados. */
function parseSuppliers(html, limit) {
  const max = Math.max(1, Math.min(Number(limit) || 20, 40));
  const items = [];
  const seen = {};
  const parts = splitCards(html);
  for (let i = 0; i < parts.length && items.length < max; i++) {
    const seg = parts[i];
    const nameM = seg.match(/class="tit"[^>]*>([\s\S]{1,200}?)<\/a>/);
    const urlM = seg.match(/href="(\/\/[a-z0-9.\-]+\.manufacturer\.globalsources\.com\/homepage_\d+\.htm)"/);
    if (!nameM || !urlM) continue;
    const name = text(nameM[1]).replace(/\s*\(\d+\)\s*$/, "");
    if (!name) continue;
    const key = String(urlM[1]).toLowerCase();
    const nkey = name.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (seen[key] || seen["n:" + nkey]) continue;
    seen[key] = 1;
    seen["n:" + nkey] = 1;
    const a = attrsOf(seg);
    const badges = badgesOf(seg);
    const businessType = a["business type"] || "";
    const factory = isFactory(badges, businessType);
    const verified = badges.some(function (b) { return b.indexOf("verified") === 0; });
    const empM = String(a["no. of employees"] || "").replace(/[,\s]/g, "").match(/\d+/);
    const yearsM = seg.match(/class="year-bg"[^>]*>\s*<i class="num"[^>]*>(\d+)<\/i>/);
    const countryM = seg.match(/class="gs-tag dot"[^>]*>\s*([^<]{2,40})</);
    const logoM = seg.match(/background-image:url\('([^']+)'\)/);
    const descM = seg.match(/class="text"[^>]*>([\s\S]{0,400}?)<\/p>/);
    const sellerType = /trading/i.test(businessType) && !factory ? "trading" : (factory ? "fabrica" : "sin_confirmar");
    items.push({
      source: "globalsources",
      name: name.slice(0, 180),
      brand: "",
      model: "",
      reference: "",
      ean: "",
      description: text(descM ? descM[1] : "").slice(0, 600),
      specs: Object.keys(a).map(function (k) { return k.charAt(0).toUpperCase() + k.slice(1) + ": " + a[k]; }).slice(0, 10),
      features: [],
      color: "",
      size: "",
      material: "",
      weight: "",
      price: null,
      priceText: "",
      oldPrice: null,
      stock: null,
      available: true,
      limit: null,
      minOrder: null,
      url: "https:" + urlM[1],
      image: logoM ? logoM[1] : "",
      supplier: name,
      supplierType: sellerType,
      factory: factory,
      verifiedSupplier: verified,
      moq: null,
      isSupplier: true,
      candidate: true,
      attrs: {
        platform: "globalsources",
        kind: "supplier",
        factory: factory,
        sellerType: businessType,
        sellerUrl: "https:" + urlM[1],
        verified: verified,
        badges: badges.slice(0, 4),
        country: countryM ? text(countryM[1]) : "",
        years: yearsM ? Number(yearsM[1]) : null,
        employees: empM ? Number(empM[0]) : null,
        mainProducts: a["main products"] || "",
        exportMarket: a["export market"] || ""
      }
    });
  }
  return items;
}

/* Tarjetas de producto: precio orientativo (normalmente USD, no se convierte),
   MOQ y el proveedor que lo vende. Sirven de respaldo cuando la lista de
   proveedores no devuelve tarjetas. */
function parseProducts(html, limit) {
  const max = Math.max(1, Math.min(Number(limit) || 20, 40));
  const items = [];
  const parts = splitCards(html);
  for (let i = 0; i < parts.length && items.length < max; i++) {
    const seg = parts[i];
    const nameM = seg.match(/class="product-name"[^>]*>([\s\S]{1,300}?)<\/a>/);
    if (!nameM) continue;
    const name = text(nameM[1]);
    if (!name) continue;
    const urlM = seg.match(/href="(https:\/\/www\.globalsources\.com\/[^"]+p\.htm)"/);
    const priceM = seg.match(/class="price"[^>]*>([\s\S]{0,60}?)<\/span>/);
    const unitM = seg.match(/class="unit"[^>]*>([^<]{0,20})</);
    const moqM = seg.match(/class="txt"[^>]*>\s*([\d.,]+)\s*([A-Za-z]+)\s*<i class="desc"[^>]*>\(MOQ\)/);
    const supM = seg.match(/class="name"[^>]*>\s*<a[^>]*>([\s\S]{0,200}?)<\/a>/);
    const supUrlM = seg.match(/class="name"[^>]*>\s*<a[^>]*href="(\/\/[a-z0-9.\-]+\.manufacturer\.globalsources\.com\/homepage_\d+\.htm)"/);
    const badges = badgesOf(seg);
    const factory = isFactory(badges, "");
    const priceText = text(priceM ? priceM[1] : "") + (unitM ? " " + text(unitM[1]) : "");
    items.push({
      source: "globalsources",
      name: name.slice(0, 180),
      brand: "",
      model: "",
      reference: "",
      ean: "",
      description: "",
      specs: [],
      features: [],
      color: "",
      size: "",
      material: "",
      weight: "",
      price: null,
      priceText: priceText.trim(),
      oldPrice: null,
      stock: null,
      available: true,
      limit: null,
      minOrder: moqM ? parseInt(String(moqM[1]).replace(/[.,]/g, ""), 10) : null,
      url: urlM ? urlM[1] : "",
      image: "",
      supplier: supM ? text(supM[1]).replace(/\s*\(\d+\)\s*$/, "") : "Global Sources",
      supplierType: factory ? "fabrica" : "sin_confirmar",
      factory: factory,
      verifiedSupplier: badges.some(function (b) { return b.indexOf("verified") === 0; }),
      moq: moqM ? parseInt(String(moqM[1]).replace(/[.,]/g, ""), 10) : null,
      isSupplier: true,
      candidate: true,
      attrs: {
        platform: "globalsources",
        kind: "product",
        factory: factory,
        sellerUrl: supUrlM ? "https:" + supUrlM[1] : "",
        verified: badges.some(function (b) { return b.indexOf("verified") === 0; }),
        badges: badges.slice(0, 4),
        moqText: moqM ? moqM[1] + " " + moqM[2] : ""
      }
    });
  }
  return items;
}

async function search(body) {
  const q = String((body && body.query) || "").trim();
  const limit = Math.max(1, Math.min(Number(body && body.max) || 20, 40));
  const tried = [];
  if (config.suppliers && config.suppliers.globalsources === false) {
    return { ok: true, query: q, items: [], tried: tried, count: 0, reason: "desactivada" };
  }
  if (!q) return { ok: true, query: "", items: [], tried: tried, count: 0 };
  const slug = slugify(q);
  if (!slug) return { ok: true, query: q, items: [], tried: tried, count: 0, reason: "consulta_sin_terminos" };
  const catUrl = BASE + "/manufacturers/" + slug + ".html";
  const first = await getHtml(catUrl, 20000);
  tried.push({ url: catUrl, status: first.status });
  if (!first.ok) return { ok: false, query: q, items: [], tried: tried, count: 0, reason: "categoria_no_encontrada" };
  let items = [];
  let via = "productos";
  const cat = pickCategory(first.html, q);
  if (cat) {
    const supUrl = BASE + "/category/" + cat.slug + "-manufacturer-supplier_" + cat.id + "/";
    const sup = await getHtml(supUrl, 25000);
    tried.push({ url: supUrl, status: sup.status });
    if (sup.ok) {
      items = parseSuppliers(sup.html, limit);
      if (items.length) via = "proveedores";
    }
  }
  if (!items.length) items = parseProducts(first.html, limit);
  return { ok: true, query: q, slug: slug, via: via, tried: tried, count: items.length, items: items.slice(0, limit) };
}

module.exports = {
  label: "Global Sources (fabricantes)",
  kind: "supplier_market",
  actions: {
    ping: async function () {
      const r = await getHtml(BASE + "/manufacturers/blender.html", 12000);
      return { ok: r.ok, status: r.status };
    },
    search: search
  },
  _slugify: slugify,
  _pickCategory: pickCategory,
  _parseSuppliers: parseSuppliers,
  _parseProducts: parseProducts
};
