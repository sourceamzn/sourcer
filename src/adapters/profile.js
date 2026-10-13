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

/* Objetivos de barrido: la portada NO suele traer catalogo con precio. Se
   prefieren las paginas de ofertas/outlet declaradas en el perfil, y se admite
   una URL concreta enviada por el usuario en body.url. */
function browseTargetsFor(profile, body) {
  const urls = [];
  if (body && body.url) urls.push(String(body.url));
  const b = profile.browse || {};
  if (typeof b.url === "function") urls.push(b.url());
  else if (b.url) urls.push(b.url);
  if (Array.isArray(b.urls)) urls.push.apply(urls, b.urls);
  if (!urls.length) urls.push(profile.home);
  return urls.filter(function (u, i) { return u && urls.indexOf(u) === i; });
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

function tokensOf(value) {
  return String(value == null ? "" : value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(function (t) { return t.length > 2; });
}

function filterByQuery(items, q) {
  const tokens = tokensOf(q);
  if (!tokens.length) return items;
  return items.filter(function (it) {
    const hay = tokensOf((it.name || "") + " " + (it.brand || ""));
    return tokens.some(function (t) {
      return hay.some(function (w) { return w === t || w.indexOf(t) === 0 || t.indexOf(w) === 0; });
    });
  });
}

async function makeAdapter(profile) {
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
    if (fetched.ok) {
      const raw = parse.parseProducts(fetched.html, baseUrl, profile.platform);
      if (raw.length) return { ok: true, data: await collect(raw, fetched.via, "search") };
    }
    /* Sin resultados en el buscador: se barre la categoria/outlet y se filtra
       en local por similitud de titulo, para no depender del buscador del sitio. */
    const notes = [];
    for (const url of browseTargetsFor(profile, body)) {
      const page = await fetchHtml(url);
      if (!page.ok) { notes.push(page.reason || "fetch_failed"); continue; }
      const raw = filterByQuery(parse.parseProducts(page.html, baseUrl, profile.platform), q).slice(0, max);
      if (raw.length) return { ok: true, data: await collect(raw, page.via, "search") };
    }
    if (!fetched.ok) {
      return { ok: false, reason: fetched.reason, status: fetched.status, hint: "Activa un proveedor de scraping (SCRAPER_PROVIDER + SCRAPER_API_KEY) si la fuente bloquea." };
    }
    return { ok: true, data: await collect([], fetched.via, "search") };
  }

  async function browse(body) {
    body = body || {};
    if (profile.requiresAuth) return { ok: false, reason: "requires_auth", hint: profile.authHint || "Requiere sesion autenticada." };
    const max = Math.min(Math.max(parseInt(body.max || "24", 10) || 24, 1), 60);
    if (profile.platform === "shopify") {
      const c = await shopifyCatalog(baseUrl, max);
      if (c && c.length) return Object.assign({ ok: true, data: await collect(c, "shopify-catalog", "browse") });
    }
    const notes = [];
    let lastVia = "";
    for (const url of browseTargetsFor(profile, body)) {
      const fetched = await fetchHtml(url);
      if (!fetched.ok) { notes.push(fetched.reason || "fetch_failed"); continue; }
      lastVia = fetched.via;
      const raw = parse.parseProducts(fetched.html, baseUrl, profile.platform);
      if (raw.length) return { ok: true, data: await collect(raw, fetched.via, "browse") };
      notes.push(source + "_sin_productos_en_" + url);
    }
    return {
      ok: true,
      data: { ok: false, reason: source + "_sin_resultados", via: lastVia || null, mode: "browse", count: 0, items: [], tried: notes }
    };
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
      meta: async () => ({
        ok: true,
        id: source,
        label: profile.label || source,
        kind: profile.kind || "scraping",
        type: profile.type || "",
        requiresAuth: Boolean(profile.requiresAuth),
        particularities: profile.particularities || {},
        home: baseUrl
      }),
      search,
      browse
    }
  };
}

module.exports = { makeAdapter, fetchHtml, DEFAULT_MAPPING, UA };
