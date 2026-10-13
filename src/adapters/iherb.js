const { feedReady } = require("../config");
const { feedAction } = require("./feed");
const { mapIherbProduct, stripHtml } = require("./mappers");
const { providerReady, providerUrl } = require("../lib/scrape");
const { jsonFetch } = require("../lib/http");

const mapping = {
  name: ["name", "nombre", "title", "titulo", "producto"],
  brand: ["brand", "marca", "fabricante"],
  ean: ["upc", "ean", "gtin"],
  size: ["size", "tamaño", "tamano", "peso"],
  quantity: ["quantity", "cantidad", "unidades"],
  format: ["format", "formato"],
  variant: ["variant", "variante", "sabor"],
  price: ["price", "precio", "pvp"],
  stock: ["stock", "disponibilidad"],
  url: ["url", "link", "enlace"],
  image: ["image", "imagen", "foto"]
};

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

function searchUrl(query) {
  return "https://www.iherb.com/search?kw=" + encodeURIComponent(query);
}

async function fetchHtml(url) {
  if (providerReady()) {
    const proxied = providerUrl(url);
    if (proxied) {
      const res = await jsonFetch(proxied, { method: "GET", headers: { "User-Agent": UA } }, 60000);
      if (res.ok && typeof res.data === "string" && res.data.length > 500) return { ok: true, via: "provider", html: res.data };
    }
  }
  const direct = await jsonFetch(url, { method: "GET", headers: { "User-Agent": UA, Accept: "text/html" } }, 25000);
  if (direct.ok && typeof direct.data === "string" && !/just a moment|cf-challenge/i.test(direct.data)) {
    return { ok: true, via: "directo", html: direct.data };
  }
  const jina = await jsonFetch("https://r.jina.ai/" + url, { method: "GET", headers: { "User-Agent": UA, "x-respond-with": "html" } }, 45000);
  if (jina.ok && typeof jina.data === "string" && jina.data.length > 500 && !/just a moment/i.test(jina.data)) {
    return { ok: true, via: "r.jina.ai", html: jina.data };
  }
  return { ok: false, reason: providerReady() ? "iherb_blocked_provider_failed" : "iherb_blocked", status: direct.status };
}

function parseHtml(html) {
  const items = [];
  const seen = {};
  const ldRe = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = ldRe.exec(html))) {
    let json;
    try {
      json = JSON.parse(m[1].trim());
    } catch (e) {
      continue;
    }
    const lists = Array.isArray(json) ? json : [json];
    lists.forEach(function (node) {
      const list = (node && node.itemListElement) || (node && node["@type"] === "ItemList" && node.itemListElement);
      (list || []).forEach(function (entry) {
        const p = entry.item || entry;
        const url = p && (p.url || p["@id"]);
        const id = url && (url.match(/\/(\d+)(?:$|[?#])/) || [])[1];
        if (!id || seen[id]) return;
        seen[id] = true;
        items.push({
          id,
          name: p && (p.name || p.title),
          url,
          image: p && (p.image || (Array.isArray(p.image) ? p.image[0] : "")),
          brand: p && p.brand ? (p.brand.name || p.brand) : "",
          price: p && p.offers ? (p.offers.price || (Array.isArray(p.offers) && p.offers[0] && p.offers[0].price)) : null
        });
      });
    });
  }
  if (items.length) return items;

  const anchorRe = /<a[^>]+href=["']([^"']*\/pr\/[^"']+?\/(\d+))["'][^>]*>([\s\S]*?)<\/a>/gi;
  while ((m = anchorRe.exec(html))) {
    const id = m[2];
    if (seen[id]) continue;
    seen[id] = true;
    const inner = m[3] || "";
    const titleAttr = (m[0].match(/title=["']([^"']+)["']/i) || [])[1];
    const name = titleAttr || stripHtml(inner).slice(0, 160);
    const img = (m[0].match(/<img[^>]+src=["']([^"']+)["']/i) || [])[1];
    items.push({ id, name, url: "https://www.iherb.com" + m[1], image: img || "" });
  }
  return items;
}

async function search(body) {
  const query = String((body && (body.query || body.q)) || "").trim();
  if (!query) return { ok: false, reason: "query_required" };
  const fetched = await fetchHtml(searchUrl(query));
  if (!fetched.ok) {
    return {
      ok: false,
      reason: fetched.reason,
      status: fetched.status,
      hint: "iHerb esta tras Cloudflare. Configura SCRAPER_PROVIDER (scraperapi, scrapingbee, scrapfly, scrapingant, zenrows) y su clave, o aporta un feed CSV con UPC."
    };
  }
  const raw = parseHtml(fetched.html);
  const items = raw.map(mapIherbProduct).filter(Boolean);
  return {
    ok: items.length > 0,
    reason: items.length ? null : "iherb_no_results",
    data: { source: "iherb", query, count: items.length, via: fetched.via, items }
  };
}

/* Barrido del catalogo/ofertas sin palabra clave (PDF: barrido diario). */
async function browse(body) {
  body = body || {};
  const url = String(body.url || "https://es.iherb.com/");
  const fetched = await fetchHtml(url);
  if (!fetched.ok) {
    return {
      ok: false,
      reason: fetched.reason,
      status: fetched.status,
      hint: "iHerb esta tras Cloudflare. Configura SCRAPER_PROVIDER (scraperapi, scrapingbee, scrapfly, scrapingant, zenrows) y su clave, o aporta un feed CSV con UPC."
    };
  }
  const raw = parseHtml(fetched.html);
  const items = raw.map(mapIherbProduct).filter(Boolean);
  return {
    ok: true,
    data: { source: "iherb", kind: "browse", url, count: items.length, via: fetched.via, items }
  };
}

const iherb = {
  id: "iherb",
  label: "iHerb",
  kind: "scraping",
  actions: {
    ping: async () => ({
      ok: providerReady() || feedReady("iherb"),
      configured: providerReady() || feedReady("iherb"),
      reason: providerReady() ? null : feedReady("iherb") ? "feed_ready" : "cloudflare_requires_provider",
      mode: providerReady() ? "proveedor_scraping" : feedReady("iherb") ? "feed" : "bloqueado_cloudflare",
      note: providerReady() ? null : "iHerb usa Cloudflare: la busqueda real necesita proveedor de scraping o feed con UPC."
    }),
    feed: feedAction("iherb", mapping),
    search,
    browse
  }
};

module.exports = iherb;
