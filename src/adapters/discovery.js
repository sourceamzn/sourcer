/* DESCUBRIMIENTO DE PROVEEDORES por buscador (Brave Search API).

   El problema que resuelve: hasta ahora "buscar proveedores" consultaba 12 webs
   fijas por scraping -> siempre lo mismo y casi siempre vacio. Aqui, dado un
   EAN (o marca + modelo + nombre), se lanza una busqueda web y se devuelven
   paginas de mayoristas/distribuidores/fabricantes reales. Cada consulta da
   resultados distintos y cubre proveedores que no estan en el catalogo fijo.

   Es una fuente de PROVEEDOR: devuelve enlaces (sin precio). Se integra igual
   que las demas en la Fase 2 de la busqueda inversa y en "Proveedores". */

const { config, discoveryReady, apifyReady } = require("../config");
const apify = require("../lib/apify");
const { jsonFetch } = require("../lib/http");
const eanLib = require("../lib/ean");
const web = require("./web");

const SUPPLIER_HINTS = [
  "mayorista", "al por mayor", "por mayor", "distribuidor", "wholesale", "supplier",
  "proveedor", "dropshipping", "alibaba", "aliexpress", "1688", "bigbuy", "fabricante",
  "import", "b2b", "trade"
];

/* Dominios que no son proveedores: se descartan del resultado. */
const BLOCKED = [
  "amazon.", "google.", "youtube.", "facebook.", "instagram.", "pinterest.", "wikipedia.",
  "tiktok.", "twitter.", "x.com", "linkedin.", "reddit.", "ebay.", "pccomponentes.com"
];

function digits(value) {
  const m = String(value == null ? "" : value).match(/\d+/g);
  return m ? m.join("") : "";
}

function hostOf(url) {
  try {
    return new URL(String(url || "")).hostname.replace(/^www\./, "");
  } catch (e) {
    return "";
  }
}

function isBlocked(url) {
  const host = hostOf(url);
  return !host || BLOCKED.some(function (b) { return host.indexOf(b) !== -1; });
}

/* El buscador no entiende un EAN suelto: casi ninguna tienda lo indexa y
   Google devuelve paginas que solo lo citan. Se prioriza marca+modelo (lo que
   escribe una persona) y el EAN queda como una variante mas. */
function withBrand(brand, text) {
  const b = String(brand || "").trim();
  const t = String(text || "").trim();
  if (!b) return t;
  if (!t) return b;
  return t.toLowerCase().indexOf(b.toLowerCase()) !== -1 ? t : (b + " " + t);
}

function buildQuery(body) {
  body = body || {};
  const brand = String(body.brand || "").trim();
  const model = String(body.model || body.partNumber || "").trim();
  const name = String(body.name || body.title || body.query || "").trim();
  /* El titulo de Amazon describe el producto mejor que un codigo interno:
     "Anker P31i Bluetooth Headphones" encuentra tiendas; "D1202" a secas no. */
  if (brand && name) {
    let short = name.split(/\s+/).slice(0, 10).join(" ");
    if (model && short.toLowerCase().indexOf(model.toLowerCase()) === -1) short += " " + model;
    return { q: withBrand(brand, short).slice(0, 110), via: "marca+titulo" };
  }
  if (brand && model) return { q: withBrand(brand, model), via: "marca+modelo" };
  const e = digits(body.ean);
  if (e.length >= 8) return { q: e, via: "ean" };
  const parts = [brand, model, name].filter(Boolean);
  return { q: parts.join(" ").trim(), via: "titulo" };
}

/* Variantes de busqueda: el mismo producto desde varios angulos para que
   Google no devuelva solo mayoristas chinos ni una unica tienda. Incluye
   color/talla cuando el origen los conoce. */
function queryVariants(q, body) {
  const base = String(q || "").trim();
  if (!base) return [];
  const color = String((body && (body.color || (body.attrs && body.attrs.color))) || "").trim();
  const size = String((body && (body.size || (body.attrs && body.attrs.size))) || "").trim();
  const withVariant = [base, color, size].filter(Boolean).join(" ").trim();
  const ean = digits(body && body.ean);
  const brand = String((body && body.brand) || "").trim();
  const model = String((body && (body.model || body.partNumber)) || "").trim();
  const queries = [];
  function add(x) {
    x = String(x || "").replace(/\s+/g, " ").trim();
    if (x && queries.indexOf(x) === -1) queries.push(x);
  }
  /* En modo exacto el EAN manda: primero el codigo tal cual y citado, luego
     marca+modelo y por ultimo las variantes comerciales. Asi Google Search
     cubre tiendas que no aparecen en Google Shopping. */
  if (body && body.__eanExact && ean) {
    add(ean);
    add('"' + ean + '"');
    add("EAN " + ean);
    add([ean, brand, model].filter(Boolean).join(" "));
  }
  add(withVariant);
  add(base + " mayorista");
  add(base + " distribuidor");
  add(base + " wholesale");
  add(base + " supplier");
  add(base + " al por mayor");
  add(base + " proveedor");
  /* El EAN solo como comprobacion final: no debe desplazar a marca+modelo. */
  if (ean && ean.length >= 8) add(ean + " " + [brand, model].filter(Boolean).join(" ").trim());
  return queries.slice(0, 6);
}

function toItem(r) {
  const host = hostOf(r.url);
  const hay = ((r.title || "") + " " + (r.description || "")).toLowerCase();
  return {
    source: "discovery",
    name: String(r.title || host || "").slice(0, 180),
    brand: "",
    model: "",
    reference: "",
    ean: "",
    price: null,
    oldPrice: null,
    stock: null,
    available: true,
    url: r.url || "",
    image: "",
    supplier: host,
    isSupplier: true,
    matchedHint: SUPPLIER_HINTS.some(function (h) { return hay.indexOf(h) !== -1; }),
    attrs: {
      description: String(r.description || "").slice(0, 300),
      domain: host,
      currency: "",
      platform: "discovery"
    },
    capturedAt: new Date().toISOString()
  };
}

async function braveSearch(q, count) {
  const url =
    "https://api.search.brave.com/res/v1/web/search?q=" +
    encodeURIComponent(q) +
    "&count=" + count +
    "&country=" + encodeURIComponent(config.discovery.country) +
    "&search_lang=" + encodeURIComponent(config.discovery.lang);
  const res = await jsonFetch(
    url,
    { method: "GET", headers: { Accept: "application/json", "X-Subscription-Token": config.discovery.apiKey } },
    20000
  );
  if (!res.ok) return { ok: false, reason: "brave_http_" + res.status, status: res.status };
  const results = (res.data && res.data.web && res.data.web.results) || [];
  return { ok: true, results: results };
}

async function braveMany(q, count, body) {
  const all = [];
  const variants = queryVariants(q, body).slice(0, 4);
  for (let i = 0; i < variants.length; i++) {
    const r = await braveSearch(variants[i], count);
    if (!r.ok) continue;
    r.results.forEach(function (x) { all.push(x); });
    if (all.length >= count * 2) break;
  }
  return all.length ? { ok: true, results: all } : { ok: false, reason: "brave_sin_resultados" };
}

function decodeEntities(s) {
  return String(s || "")
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ");
}

function cleanText(s) {
  return decodeEntities(String(s || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function decodeLink(href) {
  let h = decodeEntities(href);
  if (h.indexOf("//duckduckgo.com/l/") === 0) h = "https:" + h;
  try {
    const u = new URL(h);
    const target = u.searchParams.get("uddg");
    if (target) h = decodeURIComponent(target);
  } catch (e) {}
  return h;
}

function parseWebResults(html) {
  const out = [];
  const ddg = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = ddg.exec(html))) out.push({ url: decodeLink(m[1]), title: cleanText(m[2]), description: "" });
  if (out.length) {
    /* Snippets de DuckDuckGo, en el mismo orden. */
    const sn = [];
    const re = /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
    while ((m = re.exec(html))) sn.push(cleanText(m[1]));
    out.forEach(function (x, i) { if (sn[i]) x.description = sn[i]; });
    return out;
  }
  const bing = /<li[^>]+class="[^"]*b_algo[^"]*"[^>]*>[\s\S]*?<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<p[^>]*>([\s\S]*?)<\/p>)?/gi;
  while ((m = bing.exec(html))) {
    out.push({ url: decodeLink(m[1]), title: cleanText(m[2]), description: cleanText(m[3] || "") });
  }
  return out;
}

/* Sin APIFY_TOKEN ni BRAVE_API_KEY no se apaga el descubrimiento: se usa la
   busqueda web del servidor (DuckDuckGo HTML y Bing como respaldo). No es
   Google pago, pero mantiene la busqueda abierta en todo Internet. */
async function webMany(q, count, body) {
  const variants = queryVariants(q, body).slice(0, 3);
  /* En paralelo: si DuckDuckGo tarda o bloquea, Bing no espera detras. */
  const batches = await Promise.all(variants.map(async function (v) {
    try {
      let r = await web.actions.search({ query: v, engine: "ddg" });
      if (!r.ok) r = await web.actions.search({ query: v, engine: "bing" });
      return r.ok ? parseWebResults(r.html) : [];
    } catch (e) {
      return [];
    }
  }));
  const all = [];
  batches.forEach(function (list) { list.forEach(function (x) { all.push(x); }); });
  return all.length ? { ok: true, results: all, engine: "web" } : { ok: false, reason: "web_sin_resultados" };
}

/* Motor principal: Google Search Scraper de Apify. Devuelve el mismo formato
   {title,url,description} que Brave para compartir el resto del flujo. */
function pushResult(out, o) {
  if (!o) return;
  const url = o.url || o.link || o.href || "";
  if (!/^https?:\/\//i.test(String(url))) return;
  out.push({ title: o.title || o.name || "", url: url, description: o.description || o.snippet || "" });
}

async function apifySearch(q, count, body) {
  /* Menos variantes y mas tiempo: el actor necesita arrancar en frio y cada
     consulta extra lo hacia morir a los 50 s sin devolver nada. */
  const queries = queryVariants(q, body).slice(0, 4).join("\n");
  const r = await apify.runActor(
    config.apify.actors.search,
    {
      queries: queries,
      countryCode: config.apify.country,
      languageCode: config.discovery.lang,
      resultsPerPage: Math.min(Math.max(count, 10), 20),
      maxPagesPerQuery: body && body.__eanExact ? 2 : 1,
      mobileResults: false,
      saveHtml: false,
      saveHtmlToKeyValueStore: false
    },
    { estCost: 0.02, timeoutSec: 90 }
  );
  let r2 = r;
  /* Reintento solo si el 400 no es un timeout: repetir un actor agotado gasta
     otros 50 s y deja la busqueda sin presupuesto para el fallback web. */
  if (!r.ok && r.reason === "actor_http_400" && !/timed[\s-]?out/i.test(String(r.detail || ""))) {
    r2 = await apify.runActor(config.apify.actors.search, { queries: q, countryCode: config.apify.country, languageCode: config.discovery.lang }, { estCost: 0.01, timeoutSec: 90 });
  }
  if (!r2.ok) return { ok: false, reason: r2.reason, status: r2.status, detail: r2.detail };
  const results = [];
  r2.items.forEach(function (page) {
    if (!page) return;
    /* Formato del Google Search Scraper: una pagina por consulta. */
    ((page.organicResults) || []).forEach(function (o) { pushResult(results, o); });
    /* Tolerancia con actores que devuelven resultados planos o anidados. */
    ["results", "items", "organic", "newsResults"].forEach(function (k) {
      if (Array.isArray(page[k])) page[k].forEach(function (o) { pushResult(results, o); });
    });
    if (page.url || page.link) pushResult(results, page);
  });
  return results.length ? { ok: true, results: results } : { ok: false, reason: "sin_resultados" };
}

async function search(body) {
  body = body || {};
  const built = buildQuery(body);
  if (!built.q) return { ok: false, reason: "query_required" };
  const max = Math.min(Math.max(parseInt((body && body.max) || "30", 10) || 30, 3), 40);
  let q = built.q;
  let via = built.via;
  /* Si arrancamos por EAN, se enriquece con marca + nombre para que aparezcan
     proveedores reales del producto y no webs que solo citan el numero. */
  if (via === "ean") {
    const info = await eanLib.lookup(q);
    if (info.ok) {
      const extra = [info.data.brand, info.data.name].filter(Boolean).join(" ").trim();
      if (extra) q = q + " " + extra;
    }
  }
  /* Los motores se lanzan a la vez: si Apify tarda 90 s o falla, la busqueda
     web sin clave ya trae resultados y no se queda esperando detras. */
  const count = Math.min(max * 2, 40);
  function settle(p, name) {
    return p.then(function (r) { return { engine: name, r: r }; })
      .catch(function (e) { return { engine: name, r: { ok: false, reason: String((e && e.message) || e) } }; });
  }
  /* Los motores de pago se esperan; el respaldo web (DuckDuckGo/Bing) solo
     entra si lo anterior no trae nada util. Antes se lanzaba siempre y podia
     colgar la fuente entera aunque Google/Brave ya hubieran respondido. */
  function withCap(p, ms, label) {
    return Promise.race([
      p,
      new Promise(function (resolve) {
        const t = setTimeout(function () { resolve({ engine: label, r: { ok: false, reason: "timeout" } }); }, ms);
        if (t.unref) t.unref();
      })
    ]);
  }
  const jobs = [];
  if (apifyReady()) jobs.push(settle(apifySearch(q, count, body), "apify"));
  if (config.discovery.apiKey) jobs.push(settle(braveMany(q, count, body), "brave"));
  let settled = [];
  if (jobs.length) {
    settled = await Promise.all(jobs);
    const found = settled.reduce(function (n, s) { return n + ((s.r && s.r.results) ? s.r.results.length : 0); }, 0);
    if (found < 5) settled.push(await withCap(settle(webMany(q, count, body), "web"), 12000, "web"));
  } else {
    settled = [await withCap(settle(webMany(q, count, body), "web"), 20000, "web")];
  }
  const results = [];
  const engines = [];
  let reason = "sin_motor", status = 0;
  settled.forEach(function (s) {
    if (s.r && s.r.ok && s.r.results && s.r.results.length) {
      s.r.results.forEach(function (x) { results.push(x); });
      engines.push(s.engine);
    } else if (s.r && s.r.reason) {
      reason = s.r.reason;
      if (s.r.status) status = s.r.status;
    }
  });
  if (!results.length) return { ok: false, reason: reason, status: status };
  const seen = {};
  const items = results
    .filter(function (x) { return x && x.url && !isBlocked(x.url); })
    .filter(function (x) {
      const h = hostOf(x.url);
      if (seen[h]) return false;
      seen[h] = 1;
      return true;
    })
    .map(toItem);
  /* Se conservan todas las paginas unicas (una por dominio), primero las que
     tienen senales de mayorista/distribuidor/fabricante. El cotejo posterior
     (ficha, foto, caracteristicas) decide cuales son el mismo producto; no se
     descartan aqui por no llevar la palabra "mayorista" en el snippet. */
  const hinted = items.filter(function (x) { return x.matchedHint; });
  const rest = items.filter(function (x) { return !x.matchedHint; });
  const kept = hinted.concat(rest).slice(0, max);
  return {
    ok: kept.length > 0,
    reason: kept.length ? null : "discovery_sin_resultados",
    data: { source: "discovery", engine: engines.join("+") || "web", query: q, via: via, count: kept.length, items: kept }
  };
}

const discovery = {
  id: "discovery",
  label: "Descubrimiento de proveedores (buscador)",
  kind: "discovery",
  supplier: true,
  actions: {
    ping: async () => ({
      ok: true,
      configured: true,
      reason: null,
      mode: apifyReady() ? "apify_google_search" : discoveryReady() ? "brave_search" : "web_fallback",
      note: apifyReady() || discoveryReady()
        ? "Descubre paginas de proveedor por EAN o marca + modelo."
        : "Sin APIFY_TOKEN ni BRAVE_API_KEY: usa DuckDuckGo/Bing en el servidor como respaldo."
    }),
    lookup: async (body) => await eanLib.lookup(body && body.ean),
    search
  }
};

module.exports = discovery;
