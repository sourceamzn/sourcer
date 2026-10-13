/* Fabrica de adaptadores por perfil declarativo.

   Un "perfil" describe una fuente (dominio, plataforma, plantillas de busqueda
   y particularidades del PDF). La fabrica devuelve siempre el mismo contrato de
   adaptador { id, label, kind, actions } que consume backend/src/adapters/index.

   La lectura de HTML reutiliza la misma cascada que iherb: proveedor de
   scraping -> peticion directa -> r.jina.ai. El parseo del catalogo vive en
   lib/parse.js (JSON-LD, microdata, heuristica de anclas). */

const { feedReady } = require("../config");
const { feedAction } = require("./feed");
const { providerReady, providerUrl } = require("../lib/scrape");
const { jsonFetch } = require("../lib/http");
const parse = require("../lib/parse");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

const DEFAULT_MAPPING = {
  name: ["name", "nombre", "title", "titulo", "producto", "descripcion"],
  brand: ["brand", "marca", "fabricante"],
  model: ["model", "modelo"],
  reference: ["reference", "referencia", "ref", "sku", "mpn"],
  ean: ["ean", "upc", "gtin", "codigo_de_barras"],
  price: ["price", "precio", "pvp", "precio_venta"],
  net: ["net", "neto", "precio_neto", "precio_sin_iva", "coste"],
  stock: ["stock", "disponibilidad", "unidades"],
  url: ["url", "link", "enlace"],
  image: ["image", "imagen", "foto"]
};

async function fetchHtml(url) {
  if (providerReady()) {
    const proxied = providerUrl(url);
    if (proxied) {
      const res = await jsonFetch(proxied, { method: "GET", headers: { "User-Agent": UA } }, 60000);
      if (res.ok && typeof res.data === "string" && res.data.length > 400) return { ok: true, via: "proveedor", html: res.data };
    }
  }
  const direct = await jsonFetch(url, { method: "GET", headers: { "User-Agent": UA, Accept: "text/html" } }, 25000);
  if (direct.ok && typeof direct.data === "string" && !/just a moment|cf-challenge|attention required/i.test(direct.data)) {
    return { ok: true, via: "directo", html: direct.data };
  }
  const jina = await jsonFetch("https://r.jina.ai/" + url, { method: "GET", headers: { "User-Agent": UA } }, 45000);
  if (jina.ok && typeof jina.data === "string" && jina.data.length > 400 && !/just a moment/i.test(jina.data)) {
    return { ok: true, via: "r.jina.ai", html: jina.data };
  }
  return { ok: false, reason: providerReady() ? "fuente_bloqueada_proveedor_fallo" : "fuente_bloqueada", status: direct.status };
}

function searchUrlFor(profile, q) {
  if (profile.search && typeof profile.search.url === "function") return profile.search.url(q);
  if (profile.search && profile.search.url) return profile.search.url + encodeURIComponent(q);
  return profile.home + (q ? "?s=" + encodeURIComponent(q) : "");
}

function browseUrlFor(profile) {
  if (profile.browse && typeof profile.browse.url === "function") return profile.browse.url();
  if (profile.browse && profile.browse.url) return profile.browse.url;
  return profile.home;
}

function toItem(source, p, baseUrl, platform) {
  const ean = parse.detectEan(p.ean, p.sku);
  return {
    source,
    name: p.name || "",
    brand: p.brand || "",
    model: p.model || "",
    reference: p.sku || "",
    ean,
    price: p.price != null ? p.price : null,
    oldPrice: p.oldPrice != null ? p.oldPrice : null,
    stock: p.stock != null ? p.stock : null,
    available: p.stock == null ? true : p.stock > 0,
    url: p.url || baseUrl,
    image: p.image || "",
    attrs: {
      productType: p.brand || "",
      description: p.description || "",
      currency: p.currency || "EUR",
      ean: ean,
      platform: platform || ""
    },
    capturedAt: new Date().toISOString()
  };
}

async function shopifySuggest(home, q, max) {
  const url =
    home.replace(/\/+$/, "") +
    "/search/suggest.json?q=" +
    encodeURIComponent(q) +
    "&resources[type]=product&resources[limit]=" +
    max;
  const res = await jsonFetch(url, { method: "GET", headers: { "User-Agent": UA, Accept: "application/json" } }, 20000);
  const products =
    res.ok && res.data && res.data.resources && res.data.resources.results && res.data.resources.results.products;
  if (!products) return null;
  return products.map(function (p) {
    return {
      name: p.title || "",
      url: p.url ? new URL(p.url, home).href : home,
      image: p.featured_image && p.featured_image.url ? (p.featured_image.url.indexOf("//") === 0 ? "https:" + p.featured_image.url : p.featured_image.url) : "",
      brand: p.vendor || "",
      sku: "",
      ean: "",
      price: parse.parsePrice(p.price),
      currency: "EUR",
      description: ""
    };
  });
}

async function shopifyCatalog(home, max) {
  const url = home.replace(/\/+$/, "") + "/products.json?limit=" + max;
  const res = await jsonFetch(url, { method: "GET", headers: { "User-Agent": UA, Accept: "application/json" } }, 20000);
  const products = res.ok && res.data && res.data.products;
  if (!products) return null;
  return products.map(function (p) {
    const variants = (p.variants || []).map(function (v) {
      return { price: parse.parsePrice(v.price), compare: parse.parsePrice(v.compare_at_price), sku: v.sku || "", ean: parse.detectEan(v.barcode), available: v.available };
    });
    const first = variants[0] || {};
    const ean = variants.map(function (v) { return v.ean; }).filter(Boolean)[0] || "";
    return {
      name: p.title || "",
      url: home.replace(/\/+$/, "") + "/products/" + (p.handle || ""),
      image: ((p.images || [])[0] && (p.images[0].src || "")) || "",
      brand: p.vendor || "",
      sku: first.sku || "",
      ean,
      price: first.price != null ? first.price : null,
      oldPrice: first.compare != null ? first.compare : null,
      stock: p.variants && p.variants.length ? (first.available ? 1 : 0) : null,
      currency: "EUR",
      description: parse.stripTags(p.body_html || "").slice(0, 400)
    };
  });
}

function makeAdapter(profile) {
  const source = profile.id;
  const baseUrl = profile.home || "";

  async function collect(rawItems, via, mode) {
    const items = rawItems.map(function (p) {
      return toItem(source, p, baseUrl, profile.platform);
    });
    if (profile.platform === "shopify") {
      items.forEach(function (it) {
        if (it.oldPrice && it.price && it.oldPrice > it.price) {
          it.discountPct = Math.round((1 - it.price / it.oldPrice) * 100);
        }
      });
    }
    return { ok: items.length > 0, reason: items.length ? null : source + "_sin_resultados", via, mode, count: items.length, items };
  }

  async function search(body) {
    const q = String((body && (body.query || body.q)) || "").trim();
    if (!q) return { ok: false, reason: "query_required" };
    if (profile.requiresAuth) return { ok: false, reason: "requires_auth", hint: profile.authHint || "Requiere sesion autenticada." };
    const max = Math.min(Math.max(parseInt((body && body.max) || "24", 10) || 24, 1), 60);
    if (profile.platform === "shopify") {
      const s = await shopifySuggest(baseUrl, q, max);
      if (s && s.length) return Object.assign({ ok: true, data: await collect(s, "shopify-suggest", "search") });
    }
    const fetched = await fetchHtml(searchUrlFor(profile, q));
    if (!fetched.ok) {
      return { ok: false, reason: fetched.reason, status: fetched.status, hint: "Activa un proveedor de scraping (SCRAPER_PROVIDER + SCRAPER_API_KEY) si la fuente bloquea." };
    }
    const raw = parse.parseProducts(fetched.html, baseUrl, profile.platform);
    return { ok: true, data: await collect(raw, fetched.via, "search") };
  }

  async function browse(body) {
    body = body || {};
    if (profile.requiresAuth) return { ok: false, reason: "requires_auth", hint: profile.authHint || "Requiere sesion autenticada." };
    const max = Math.min(Math.max(parseInt(body.max || "24", 10) || 24, 1), 60);
    if (profile.platform === "shopify") {
      const c = await shopifyCatalog(baseUrl, max);
      if (c && c.length) return Object.assign({ ok: true, data: await collect(c, "shopify-catalog", "browse") });
    }
    const fetched = await fetchHtml(browseUrlFor(profile));
    if (!fetched.ok) {
      return { ok: false, reason: fetched.reason, status: fetched.status, hint: "Activa un proveedor de scraping si la fuente bloquea." };
    }
    const raw = parse.parseProducts(fetched.html, baseUrl, profile.platform);
    return { ok: true, data: await collect(raw, fetched.via, "browse") };
  }

  return {
    id: source,
    label: profile.label || source,
    kind: profile.kind || "scraping",
    actions: {
      ping: async () => {
        if (profile.requiresAuth) {
          return { ok: false, configured: false, reason: "requires_auth", mode: "bloqueado_login", note: profile.authHint || "Requiere sesion autenticada." };
        }
        const feed = feedReady(source);
        return {
          ok: true,
          configured: true,
          reason: null,
          mode: feed ? "feed" : providerReady() ? "lectura_web_proveedor" : "lectura_web",
          note: feed ? "feed configurado" : "lectura de catalogo (JSON-LD / microdata / anclas) sin claves"
        };
      },
      feed: feedAction(source, profile.mapping || DEFAULT_MAPPING),
      search,
      browse
    }
  };
}

module.exports = { makeAdapter, fetchHtml, DEFAULT_MAPPING, UA };
