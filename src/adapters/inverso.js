/* Adaptador de BUSQUEDA INVERSA (Amazon -> proveedor) del PDF del cliente
   "Busqueda inversa (Amazon -> proveedor) · @Kevin Axel".

   El flujo arranca de la DEMANDA, no del proveedor: primero detecta en
   Amazon.es productos que ya se venden bien, calcula cuanto se puede pagar como
   maximo (precio maximo de compra / descuento necesario) y DESCARTA antes de
   buscar proveedor lo que no tiene margen real. Solo despues busca donde
   comprar por debajo de ese precio.

   Acciones:
   - candidates: Fase 1. ASIN candidatos de Amazon.es (Keepa) con sus metricas
     (Buy Box 90 d, ventas/mes, historial, vendedores terceros) y el resultado
     del filtro de precio maximo / descuento necesario.
   - plan:       calculo puro del precio maximo, descuento necesario y estado
     (misma formula del PDF) para un candidato o una ficha manual.
   - sources:    Fase 2. Dada una identidad (ASIN/EAN/marca+modelo) busca en las
     fuentes del PDF donde se vende por debajo del precio maximo.
   - ping:       estado de las fuentes implicadas.

   Reglas del PDF que respeta:
   - Todo lo de Amazon por API (Keepa / SP-API); nunca scraping directo de Amazon.
   - El filtro de descuento necesario va ANTES de buscar proveedor (ahorro de tokens).
   - Marca restringida/hazmat SOLO se marca; marca privada (solo vende la marca)
     descarta. Las caidas de BSR son un suelo de ventas (no se dividen).
   - Sin ASIN/listing previo no hay oportunidad: nunca crea ASIN ni listings. */

const { config, keepaReady, amazonReady } = require("../config");
const { jsonFetch } = require("../lib/http");
const store = require("../lib/store");

const KEEPA = "https://api.keepa.com/";

/* ---------- utilidades ---------- */
function num(v, d) {
  if (v == null || v === "") return d == null ? 0 : d;
  const n = Number(v);
  return isFinite(n) ? n : d == null ? 0 : d;
}
/* Keepa devuelve -1/-2 cuando no hay dato: se normaliza a 0. */
function posNum(v) { const n = num(v); return n > 0 ? n : 0; }
function round2(n) {
  return Math.round((isFinite(n) ? n : 0) * 100) / 100;
}
function clampInt(v, def, min, max) {
  const n = parseInt(v, 10);
  if (!isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}
function digits(v) {
  const m = String(v == null ? "" : v).match(/\d+/g);
  return m ? m.join("") : "";
}

/* ---------- parametros del proceso (mismos tramos y fiscalidad del PDF) ----------
   La formula vive en lib/plan.js para poder probarla sin red ni Keepa. */
const planLib = require("../lib/plan");
const PLAN_DEFAULT = planLib.PLAN_DEFAULT;
const planParams = planLib.planParams;
const tierFor = planLib.tierFor;
const planFor = planLib.planFor;
const buybox = require("../lib/buybox");
const coverageLib = require("../lib/coverage");
const cascadeLib = require("../lib/cascade");
const keepaFicha = require("../lib/keepaficha");
const events = require("../lib/events");
const gtinLib = require("../lib/gtin");
const queriesLib = require("../lib/queries");
const feesLib = require("../lib/fees");
const spapi = require("../lib/spapi");

/* ---------- metricas desde un producto Keepa ---------- */
function keepaCur(prod, idx, scale) {
  try {
    const s = prod && prod.stats; if (!s) return 0;
    const c = s.current && s.current[idx]; if (c == null || c < 0) return 0;
    return scale ? round2(c / 100) : c;
  } catch (e) { return 0; }
}
function keepaAvg90(prod, idx, scale) {
  try {
    const s = prod && prod.stats; if (!s || !s.avg90) return 0;
    const c = s.avg90[idx]; if (c == null || c < 0) return 0;
    return scale ? round2(c / 100) : c;
  } catch (e) { return 0; }
}
function historyDays(prod) {
  try {
    const s = prod && prod.stats;
    if (s && s.first) return Math.max(0, Math.round((Date.now() - s.first) / 86400000));
    if (prod && prod.historyDays != null) return num(prod.historyDays);
  } catch (e) {}
  return null;
}
/* Keepa devuelve en imagesCSV solo el NOMBRE de archivo (p. ej. "61abc.jpg");
   la URL publica de Amazon se construye con el CDN de imagenes. Si ya viene
   una URL completa se respeta. Sin imagen -> "" (la interfaz lo indica). */
function keepaImageUrl(prod) {
  if (!prod) return "";
  let first = "";
  if (prod.imagesCSV) first = String(prod.imagesCSV).split(",")[0].trim();
  else if (Array.isArray(prod.images) && prod.images.length) {
    const im = prod.images[0];
    first = String((im && (im.l || im.m || im.url)) || im || "").trim();
  } else if (prod.image) first = String(prod.image).trim();
  if (!first) return "";
  if (/^https?:\/\//i.test(first)) return first;
  if (first.indexOf("//") === 0) return "https:" + first;
  return "https://m.media-amazon.com/images/I/" + first.replace(/^\/+/, "");
}
/* Vendedores FBA reales (terceros, sin Amazon) desde la lista `offers` de Keepa.
   null si el producto no trae ofertas. */
function fbaFromOffers(prod) {
  const offers = prod && Array.isArray(prod.offers) ? prod.offers : null;
  if (!offers || !offers.length) return null;
  const seen = {};
  offers.forEach(function (o) {
    if (!o || !o.isFBA || o.isAmazon) return;
    seen[String(o.sellerId || Math.random())] = 1;
  });
  return Object.keys(seen).length;
}
function metricsFromKeepa(prod) {
  const s = (prod && prod.stats) || {};
  const pvp = keepaAvg90(prod, 18, true) || keepaCur(prod, 18, true) || keepaCur(prod, 1, true) || keepaCur(prod, 0, true);
  const bsr = keepaCur(prod, 3, false);
  /* Ventas: monthlySold de Amazon si existe; si no, caidas de BSR 30 d (suelo, no se dividen). */
  const sales = num(s.monthlySold) || num(s.salesRankDrops30) || 0;
  /* Keepa usa centinelas negativos (-1/-2) para "sin dato": nunca deben contar. */
  const offersTotal = posNum(s.offerCount) || posNum(s.totalOfferCount) || 0;
  /* null = Keepa no dio dato (sin `offers` en la peticion). Antes valia 0 y
     disparaba siempre "menos de 2 FBA". */
  const fbaOffersList = fbaFromOffers(prod);
  let offersFba = fbaOffersList;
  if (offersFba == null && posNum(s.offerCountFBA) > 0) offersFba = posNum(s.offerCountFBA);
  const fx = keepaFicha.fichaOf(prod);
  if (fx.missing.length) { try { events.add("keepa", { phase: "ficha_missing", asin: prod && prod.asin, missing: fx.missing.join(",") }); } catch (e) {} }
  const brand = String((prod && prod.brand) || "").trim();
  const manufacturer = String(fx.ficha.manufacturer || "").trim();
  const sellerName = (prod && prod.__topSellerName) || "";
  /* Amazon vende si aparece en la Buy Box de 90 d (antes: precio actual + una lista mal leida). */
  const bb = buybox.analyze(prod && prod.buyBoxSellerIdHistory, 90, undefined, { brand: brand, manufacturer: manufacturer, sellerName: sellerName });
  const amazonSells = keepaFicha.amazonSellsFrom(prod, bb, keepaCur(prod, 0, true));
  const thirdParty = offersTotal > 0 ? Math.max(0, offersTotal - (amazonSells ? 1 : 0)) : (offersFba || 0);
  const fbaThird = fbaOffersList != null
    ? fbaOffersList
    : (offersFba == null ? null : Math.max(0, offersFba - (amazonSells ? 1 : 0)));
  const ean = fx.ficha.eans[0] || (prod && prod.eanList && prod.eanList[0]) || (prod && prod.upcList && prod.upcList[0]) || "";
  const out = {
    asin: String((prod && prod.asin) || "").toUpperCase(),
    title: (prod && prod.title) || "",
    brand: brand,
    manufacturer: manufacturer,
    image: keepaImageUrl(prod),
    imageSource: keepaImageUrl(prod) ? "amazon (Keepa)" : "",
    url: prod && prod.asin ? "https://www.amazon.es/dp/" + String(prod.asin).toUpperCase() : "",
    pvp: round2(pvp), bsr: bsr, sales: Math.round(sales),
    thirdParty: Math.round(thirdParty), offersFba: offersFba == null ? null : Math.round(offersFba),
    fbaThird: fbaThird == null ? null : Math.round(fbaThird),
    historyDays: historyDays(prod), ean: String(ean || ""),
    categoryTree: (prod && prod.categoryTree) || [],
    buyBox: bb, amazonSells: amazonSells,
    ficha: fx.ficha, eans: fx.ficha.eans,
    fees: feesLib.fromKeepa(prod),
    sellerName: sellerName
  };
  /* Historial crudo para clasificar los vendedores despues (no se serializa). */
  Object.defineProperty(out, "__bbHist", { value: prod && prod.buyBoxSellerIdHistory, enumerable: false });
  return out;
}

/* ---------- cliente Keepa (product / search / bestsellers / finder) ---------- */
async function keepaRequest(path, params, method, body) {
  const query = new URLSearchParams(Object.assign({ key: config.keepa.apiKey, domain: String(config.keepa.domain) }, params || {}));
  const opts = { method: method || "GET", headers: {} };
  if (body) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
  const res = await jsonFetch(KEEPA + path + "?" + query.toString(), opts, 40000);
  if (!res.ok) return { ok: false, reason: "keepa_http_" + res.status, error: res.error };
  const data = res.data;
  if (data && typeof data === "object" && data.error) return { ok: false, reason: "keepa_error", error: data.error };
  return { ok: true, data: data };
}
async function keepaProductsByAsins(asins, offers) {
  if (!asins || !asins.length) return { ok: true, products: [] };
  const out = [];
  /* `offers` (lista real de vendedores con flag FBA) cuesta ~6 tokens extra por
     cada 10 ofertas y producto. Sin ella Keepa no da el recuento FBA fiable. */
  const nOffers = offers === undefined ? 20 : Math.max(0, Math.min(parseInt(offers, 10) || 0, 100));
  for (let i = 0; i < asins.length; i += 100) {
    const chunk = asins.slice(i, i + 100).join(",");
    const params = { asin: chunk, stats: "1", buybox: "1" };
    if (nOffers >= 20) { params.offers = String(nOffers); params["only-live-offers"] = "1"; }
    const r = await keepaRequest("product", params);
    if (r.ok && r.data && Array.isArray(r.data.products)) out.push.apply(out, r.data.products);
  }
  return { ok: true, products: out };
}
const _sellerCache = {};
async function keepaSellerName(id) {
  if (!id) return "";
  if (_sellerCache[id] != null) return _sellerCache[id];
  const r = await keepaRequest("seller", { seller: id });
  let name = "";
  try { const s = r.ok && r.data && r.data.sellers && r.data.sellers[id]; name = (s && (s.sellerName || s.name)) || ""; } catch (e) {}
  _sellerCache[id] = name;
  return name;
}
async function keepaSearchProducts(term) {
  const r = await keepaRequest("search", { type: "product", term: String(term), stats: "1" });
  if (!r.ok) return { ok: false, reason: r.reason, error: r.error };
  return { ok: true, products: (r.data && r.data.products) || [] };
}
/* Terminos genericos de departamento amazon.es -> id raiz (top20.js). Coincidencia
   EXACTA de la consulta entera; ante cualquier duda devuelve null (= palabra). */
const CATEGORY_TERMS = [
  { id: "599391031", name: "Hogar y cocina", t: ["hogar", "hogar y cocina", "casa y cocina"] },
  { id: "599370031", name: "Electronica", t: ["electronica", "electronico", "electronicos", "electronica de consumo"] },
  { id: "5512276031", name: "Moda", t: ["moda", "ropa", "ropa y accesorios"] },
  { id: "667049031", name: "Informatica", t: ["informatica", "ordenadores", "computacion"] },
  { id: "6198054031", name: "Belleza", t: ["belleza", "cosmetica", "belleza y cuidado personal"] },
  { id: "2454136031", name: "Deportes y aire libre", t: ["deporte", "deportes", "deportes y aire libre"] },
  { id: "6198072031", name: "Alimentacion", t: ["alimentacion", "comida", "supermercado"] },
  { id: "599385031", name: "Juguetes y juegos", t: ["juguetes", "juguete", "juegos y juguetes", "juguetes y juegos"] },
  { id: "2454133031", name: "Bricolaje", t: ["bricolaje", "bricolaje y herramientas"] },
  { id: "3677430031", name: "Salud y cuidado personal", t: ["salud y cuidado personal"] },
  { id: "1951051031", name: "Coche y moto", t: ["coche y moto", "automocion"] },
  { id: "1571259031", name: "Jardin", t: ["jardin", "jardineria", "jardin y exterior"] }
];
function categoryFor(q) {
  const s = String(q || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  if (!s) return null;
  for (let i = 0; i < CATEGORY_TERMS.length; i++) if (CATEGORY_TERMS[i].t.indexOf(s) >= 0) return CATEGORY_TERMS[i];
  return null;
}

async function keepaBestSellers(categoryId, range) {
  const params = { category: String(categoryId) };
  if (range != null && String(range) !== "" && String(range) !== "0") params.range = String(range);
  const r = await keepaRequest("bestsellers", params);
  if (!r.ok) return { ok: false, reason: r.reason };
  const d = r.data || {};
  const asins = (d.bestSellersList && d.bestSellersList.asinList) || d.asinList || d.asins || [];
  return { ok: true, asins: Array.isArray(asins) ? asins : [], lastUpdate: d.lastUpdate || null, categoryId: d.categoryId || categoryId };
}
async function keepaCategories(categoryId) {
  /* Category Lookup: con category=0 devuelve todas las categorias raiz del
     marketplace. 1 token por llamada (cualquier numero de ids hasta 10). */
  const r = await keepaRequest("category", { category: String(categoryId == null ? 0 : categoryId), parents: "1" });
  if (!r.ok) return { ok: false, reason: r.reason };
  const d = r.data || {};
  const cats = d.categories || {};
  const out = Object.keys(cats).map(function (k) {
    const c = cats[k] || {};
    return { id: String(c.catId || k), name: c.name || "", parent: c.parent == null ? null : c.parent, isBrowseNode: c.isBrowseNode !== false };
  }).filter(function (c) { return c.id && c.name; });
  return { ok: true, categories: out, tokensConsumed: 1 };
}
/* Saldo de tokens de Keepa. Es una llamada de 0 tokens: sirve para explicar
   por que una busqueda no devuelve datos (cuenta sin saldo) en vez de dejarlo
   como un misterioso "sin_candidatos". */
async function keepaTokens() {
  try {
    const query = new URLSearchParams({ key: config.keepa.apiKey });
    const res = await jsonFetch(KEEPA + "token?" + query.toString(), { method: "GET" }, 15000);
    if (!res.ok) return null;
    const d = res.data || {};
    const refillMs = num(d.refillIn) || null;
    return {
      tokensLeft: num(d.tokensLeft),
      refillMinutes: refillMs ? Math.max(1, Math.round(refillMs / 60000)) : null,
      refillRate: num(d.refillRate)
    };
  } catch (e) { return null; }
}
async function keepaFinder(body) {
  /* Keepa Product Finder (POST /query). Se envia el cuerpo de seleccion tal cual
     (o construido desde los filtros del PDF) y se devuelven los ASIN. */
  const selection = (body && body.selection) || {
    domainId: config.keepa.domain,
    sort: [["current_SALES", "asc"]],
    productType: [0, 1],
    perPage: clampInt(body && body.limit, 10, 1, 50)
  };
  const r = await keepaRequest("query", {}, "POST", selection);
  if (!r.ok) return { ok: false, reason: r.reason };
  const d = r.data || {};
  const asins = d.asinList || d.asins || [];
  return { ok: true, asins: Array.isArray(asins) ? asins : [] };
}

/* ---------- Fase 2 · buscar proveedor por debajo del precio maximo ---------- */
const identity = require("../lib/identity");
const matchLib = require("../lib/match");
const enrichLib = require("../lib/enrich");
const specsLib = require("../lib/specs");
const imageLib = require("../lib/imagecheck");
const MARKET = "https://www.amazon.es";
function supplierQuery(body) {
  /* Primera consulta de la cascada (la lista completa la monta queries.buildQueries). */
  const first = queriesLib.buildQueries(body, { maxQueries: 1 })[0];
  if (first && first.q) return { q: first.q, via: first.via };
  const ean = digits(body && body.ean);
  if (ean.length >= 8) return { q: ean, via: "ean" };
  const raw = [body && body.brand, body && body.model, body && body.name].map(function (x) { return String(x == null ? "" : x).trim(); }).filter(Boolean);
  /* Sin repetir: si el titulo ya contiene la marca/modelo no se antepone otra vez. */
  const parts = [];
  raw.forEach(function (p) {
    const low = p.toLowerCase();
    if (!parts.some(function (x) { return x.toLowerCase().indexOf(low) !== -1; })) parts.push(p);
  });
  /* Un titulo de Amazon suele traer 150+ caracteres: se recorta a lo util. */
  return { q: parts.join(" ").replace(/\s+/g, " ").trim().slice(0, 110), via: "titulo" };
}
const STOPWORDS = { para: 1, con: 1, the: 1, and: 1, por: 1, una: 1, uno: 1, los: 1, las: 1, del: 1, que: 1, set: 1, pack: 1, sin: 1, de: 1, la: 1, el: 1, en: 1, y: 1, a: 1 };
function tokensOf(s) {
  return String(s == null ? "" : s).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ").trim().split(" ")
    .filter(function (t) { return t.length >= 2 && !STOPWORDS[t]; });
}
/* Fraccion de palabras de la busqueda que aparecen en el nombre del resultado. */
function relevance(name, qTokens) {
  if (!qTokens.length) return 1;
  const have = tokensOf(name);
  let hits = 0;
  qTokens.forEach(function (t) {
    if (have.some(function (w) { return w === t || (t.length >= 4 && w.length >= 4 && (w.indexOf(t) === 0 || t.indexOf(w) === 0)); })) hits++;
  });
  return hits / qTokens.length;
}
/* Oferta mas barata entre las que tienen precio en EUR y coinciden (exacto/probable). */
function cheapestVerified(matches, kinds) {
  kinds = kinds || ["exacto"];
  const c = (matches || []).filter(function (m) { return m.price > 0 && !m.over && kinds.indexOf(m.match) !== -1 && (!m.currency || m.currency === "EUR"); });
  c.sort(function (a, b) { return a.price - b.price; });
  return c[0] || null;
}
/* Candidato de la fase 2 que no se pudo verificar. Se devuelve aparte para
   enseñarlo como "no verificado": nunca cuenta como proveedor ni entra en el
   precio mas barato. */
function reviewRec(r) {
  return {
    source: r.source, sourceLabel: r.sourceLabel || r.source,
    name: String(r.name || "").slice(0, 140), price: r.price, currency: r.currency || "",
    url: r.url, image: r.image || "", brand: r.brand || "", ean: r.ean || "", model: r.model || "",
    matchScore: r.matchScore, matchBand: r.matchBand,
    reviewNote: String(r.reviewNote || "").slice(0, 220),
    matchReasons: (r.matchReasons || []).slice(0, 3)
  };
}
/* Tipo de proveedor segun la fuente y los datos de la oferta. */
function roleOf(adapter, rec) {
  if (rec.factory) return "fabricante";
  const k = adapter && adapter.kind;
  if (k === "wholesale") return "mayorista";
  if (k === "supplier_market") return rec.candidate ? "fabricante/mayorista (candidato)" : "reventa";
  if (k === "marketplace") return "reventa";
  if (k === "discovery") return "distribuidor (web)";
  return "tienda";
}
/* Resuelve la promesa o devuelve {ok:false,reason:"timeout"} si tarda demasiado,
   sin dejar timers colgando. */
function withTimeout(promise, ms) {
  let t;
  const timeout = new Promise(function (res) { t = setTimeout(function () { res({ ok: false, reason: "timeout" }); }, ms); });
  return Promise.race([promise, timeout]).then(
    function (v) { clearTimeout(t); return v; },
    function (e) { clearTimeout(t); throw e; }
  );
}
/* ---------- Fase 2 en modo EAN exacto ----------
   Solo se aceptan ofertas cuyo EAN/UPC coincida exactamente con el del
   producto. No hay cascada a marca/modelo/titulo, no hay "probable" y no se
   usa la foto para decidir. Las fuentes que no publican EAN se cuentan y se
   explican en el diagnostico, en vez de generar un cero silencioso. */
function eanFieldsOf(it) {
  return gtinLib.normalizeAll([].concat(
    it && it.ean, it && it.eans,
    it && it.gtin, it && it.barcode, it && it.upc,
    it && it.attrs && it.attrs.ean, it && it.attrs && it.attrs.eans,
    it && it.attrs && it.attrs.gtin, it && it.attrs && it.attrs.gtin13,
    it && it.attrs && it.attrs.barcode, it && it.attrs && it.attrs.upc,
    it && it.attrs && it.attrs.productID
  ));
}
function eanQueryList(body, srcEans) {
  const out = [];
  const seen = {};
  function add(q) {
    const v = String(q || "").replace(/\D+/g, "");
    if (!v || seen[v]) return;
    seen[v] = 1;
    out.push({ via: "ean", q: v });
  }
  const raw = gtinLib.normalize(body && body.ean);
  if (raw) add(raw);
  srcEans.forEach(add);
  return out.slice(0, 3);
}
function eanRecFromItem(id, label, it, srcEans, priceMax) {
  let price = num(it.price);
  let titlePrice = false;
  if (!(price > 0)) {
    const tm = String(it.name || "").match(/(?:desde|a partir de|from)\s*(\d{1,4}(?:[.,]\d{1,2})?)(?!\d)|(\d{1,4}(?:[.,]\d{1,2})?)\s*(?:€|eur\b)/i);
    const tv = tm ? num(String(tm[1] || tm[2]).replace(",", ".")) : 0;
    if (tv > 0) { price = tv; titlePrice = true; }
  }
  const rec = {
    source: id, sourceLabel: label,
    name: it.name || "", brand: it.brand || "", ean: srcEans[0] || "",
    model: it.model || (it.attrs && (it.attrs.model || it.attrs.reference)) || "",
    description: it.description || (it.attrs && it.attrs.description) || "",
    specs: it.specs || [], features: it.features || [],
    color: it.color || (it.attrs && (it.attrs.color || it.attrs.colour)) || "",
    size: it.size || (it.attrs && it.attrs.size) || "",
    material: it.material || (it.attrs && it.attrs.material) || "",
    weight: it.weight || (it.attrs && it.attrs.weight) || "",
    price: price || null, oldPrice: num(it.oldPrice) || null,
    shipping: num(it.shipping) || null, stock: it.stock == null ? null : num(it.stock),
    limit: it.limit == null ? null : num(it.limit),
    url: it.url || "", image: it.image || "", candidate: false,
    contactEmail: it.contactEmail || (it.attrs && it.attrs.email) || "",
    contactPhone: it.contactPhone || (it.attrs && it.attrs.phone) || "",
    via: it.__via || "ean", queryUsed: it.__q || (srcEans[0] || ""),
    priceText: it.priceText || "", minOrder: it.minOrder || null,
    supplier: it.supplier || "", factory: Boolean(it.attrs && it.attrs.factory),
    rel: 1, under: price > 0 && priceMax > 0 && price <= priceMax,
    meetsMax: price > 0 && priceMax > 0 ? price <= priceMax : null,
    currency: (it.attrs && it.attrs.currency) || (price > 0 ? "EUR" : ""),
    checkedAt: new Date().toISOString(),
    match: "exacto", state: "verificado", matchBand: "verificado",
    matchScore: 100, matchBasis: "ean", eanExact: true, matchReasons: ["EAN/UPC exacto."],
    identity: { verdict: "exacto", reason: "EAN/UPC exacto: mismo codigo normalizado.", checks: [], score: 100, matching: ["ean"], conflicting: [] },
    crossCheck: { photo: it.image ? "sin_verificar" : "sin_foto", title: Boolean(it.name), brand: Boolean(it.brand), model: Boolean(it.model), ean: true, description: Boolean(it.description), specs: (it.specs || []).length, color: Boolean(it.color), size: Boolean(it.size), material: Boolean(it.material), weight: Boolean(it.weight), price: price > 0, url: Boolean(it.url) }
  };
  rec.role = it.factory ? "fabricante" : "proveedor";
  if (titlePrice) { rec.priceFromTitle = true; rec.priceText = "desde " + price.toFixed(2).replace(".", ",") + " € (leido del titulo, confirmar)"; }
  if (price <= 0) { rec.noPrice = true; rec.priceText = rec.priceText || "Contactar para precio"; }
  return rec;
}
function eanZeroResult(body, priceMax, reason, message) {
  const srcId = identity.freezeCard(identity.identityOf(body || {}), body || {});
  const empty = coverageLib.buildCoverage({ searched: [], rejected: [], matches: [], queries: [], identity: srcId });
  return {
    q: "", via: "ean", priceMax: round2(priceMax), eanOnly: true,
    matches: [], overMax: [], searched: [], rejected: [], identity: srcId,
    coverage: empty,
    summary: { exact: 0, raw: 0, withEan: 0, differentEan: 0, noEan: 0, sourcesWithEan: 0, sourcesNoEan: 0 },
    diagnosis: { reason: reason || "producto_sin_ean", message: message || "Este producto no tiene EAN/UPC valido: no se puede buscar por coincidencia exacta." }
  };
}
async function searchSuppliersEan(body, priceMax, hooks, srcEans) {
  hooks = hooks || {};
  const { adapters } = require("./index");
  const skip = { amazon: 1, keepa: 1, web: 1, storefronts: 1, newsletters: 1 };
  const rank = { gshopping_ean: 0, discovery: 0, discovery_open: 0, supplier_market: 1, wholesale: 2, marketplace: 2 };
  const candidates = Object.keys(adapters).filter(function (id) {
    const a = adapters[id];
    /* En modo exacto no se consultan fuentes que declaran no publicar EAN:
       solo gastan tiempo y ocupan fichas de enriquecimiento. */
    return !skip[id] && a && a.ean !== false && !a.requiresAuth && a.actions && typeof a.actions.search === "function";
  }).sort(function (x, y) {
    const rx = rank[adapters[x].kind] != null ? rank[adapters[x].kind] : 5;
    const ry = rank[adapters[y].kind] != null ? rank[adapters[y].kind] : 5;
    return rx - ry;
  });
  const cfgS = config.suppliers || { maxResults: 20 };
  const max = clampInt(body && body.max, cfgS.maxResults || 20, 3, cfgS.maxResultsCap || 60);
  const qlist = eanQueryList(body, srcEans);
  if (!qlist.length) return eanZeroResult(body, priceMax, "producto_sin_ean");
  const budgetMs = clampInt(body && body.budgetMs, 110000, 15000, 180000);
  const deadline = Date.now() + budgetMs;
  const concurrency = Math.max(2, Math.min(clampInt(body && body.concurrency, 10, 1, 16), candidates.length || 1));
  const matches = [], above = [], searched = [], rejected = [], pendingAll = [];
  const seenKeys = {};
  let cursor = 0;
  const cfgM = config.match || {};
  const cfgEnrich = parseInt(cfgM.enrichMax, 10) || 0;
  const enrichMax = cfgEnrich > 0 ? Math.min(Math.max(cfgEnrich, 24), 60) : 0;

  function accept(rec, entry, recsOut) {
    const k = String(rec.dedupeKey || (String(rec.url || "") + "|" + String(rec.price || "")));
    if (k !== "|" && seenKeys[k]) return;
    if (k !== "|") seenKeys[k] = 1;
    entry.count++;
    if (recsOut) recsOut.push(rec);
    if (rec.price <= 0) { matches.push(rec); return; }
    if (priceMax > 0 && rec.price > priceMax) { rec.over = true; above.push(rec); return; }
    matches.push(rec);
  }

  async function runOne(id) {
    const entry = {
      source: id, sourceLabel: adapters[id].label || id, ok: false,
      count: 0, rawCount: 0, withEan: 0, differentEan: 0, noEan: 0,
      queryStats: [], startedAt: new Date().toISOString()
    };
    const recsOut = [];
    const t0 = Date.now();
    if (hooks.onStart) { try { hooks.onStart(id, entry.sourceLabel); } catch (e) {} }
    if (Date.now() > deadline) {
      entry.reason = "tiempo_agotado"; entry.ms = 0;
      searched.push(entry);
      if (hooks.onSource) { try { hooks.onSource(entry, []); } catch (e) {} }
      return;
    }
    try {
      const qq = qlist[0];
      const r = await withTimeout(adapters[id].actions.search({
        query: qq.q,
        max: max,
        market: (body && body.market) || undefined,
        ean: (body && body.ean) || srcEans[0],
        eans: srcEans,
        eanOnly: Boolean(body && body.eanOnly),
        __eanExact: Boolean(body && body.eanOnly),
        brand: (body && body.brand) || "",
        model: (body && body.model) || "",
        name: (body && body.name) || ""
      }), Math.min(Math.max(5000, deadline - Date.now()), sourceCap(adapters[id].kind)));
      const data = r && r.ok ? r.data : null;
      const items = (data && data.items) || [];
      entry.rawCount = items.length;
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const got = eanFieldsOf(it);
        if (got.length) {
          entry.withEan++;
          if (gtinLib.intersects(got, srcEans)) {
            const rec = eanRecFromItem(id, entry.sourceLabel, it, srcEans, priceMax);
            rec.ean = got.filter(function (e) { return srcEans.indexOf(e) !== -1; })[0] || srcEans[0];
            accept(rec, entry, recsOut);
          } else {
            entry.differentEan++;
            rejected.push({ source: id, kind: "identidad", name: String(it.name || "").slice(0, 80), reason: "EAN/UPC distinto: " + got.join(", ") + " no es " + srcEans.join(", ") + "." });
          }
        } else {
          entry.noEan++;
          if (it.url) pendingAll.push({ id: id, label: entry.sourceLabel, it: it, entry: entry, recsOut: recsOut, order: pendingAll.length });
          else rejected.push({ source: id, kind: "identidad", name: String(it.name || "").slice(0, 80), reason: "La oferta no publica EAN/UPC ni enlace a su ficha; no se puede verificar por codigo." });
        }
      }
      entry.ok = entry.count > 0;
      if (!entry.ok) entry.reason = entry.rawCount ? "sin_coincidencias_ean" : ((r && r.reason) || "sin_resultados");
      if (r && !r.ok && r.detail) entry.detail = String(r.detail).slice(0, 300);
      entry.ms = Date.now() - t0;
    } catch (e) {
      entry.reason = String((e && e.message) || e);
      entry.ms = Date.now() - t0;
    }
    searched.push(entry);
    if (hooks.onSource) { try { hooks.onSource(entry, recsOut); } catch (e) {} }
  }

  const workers = [];
  for (let w = 0; w < concurrency; w++) {
    workers.push((async function () {
      while (cursor < candidates.length) {
        const id = candidates[cursor++];
        await runOne(id);
      }
    })());
  }
  await Promise.all(workers);

  /* Tarifas/liquidaciones importadas por el usuario: cruce directo por EAN
     contra el almacen. Es la via que hace que una tarifa subida aparezca en la
     busqueda inversa sin depender de que la web del proveedor este indexada. */
  try {
    const rows = await store.tariffFind(srcEans);
    if (rows.length) {
      const entry = {
        source: "tarifas", sourceLabel: "Tarifas importadas", ok: false,
        count: 0, rawCount: rows.length, withEan: rows.length, differentEan: 0, noEan: 0,
        queryStats: [], startedAt: new Date().toISOString(), ms: 0
      };
      const recsOut = [];
      rows.forEach(function (row) {
        const it = {
          name: row.name || "", brand: row.brand || "", ean: row.ean,
          model: row.model || row.reference || "", reference: row.reference || "",
          price: row.net != null ? row.net : row.price,
          url: row.url || "", stock: row.stock == null ? null : row.stock,
          attrs: { ean: row.ean, reference: row.reference || "" },
          __via: "tarifa"
        };
        if (!(num(it.price) > 0)) return;
        const rec = eanRecFromItem("tarifas", "Tarifa importada: " + String(row.source || ""), it, srcEans, priceMax);
        rec.source = "tarifas";
        rec.sourceLabel = "Tarifa importada: " + String(row.source || "");
        rec.supplier = String(row.source || "");
        /* Un mismo EAN puede estar repetido en el almacen por reimportaciones
           con etiquetas de origen distintas. Se colapsa el duplicado exacto
           (mismo EAN, precio y stock) para no mostrar 24 veces el mismo
           proveedor. */
        rec.dedupeKey = "tarifa|" + row.ean + "|" + rec.price + "|" + String(row.stock == null ? "" : row.stock);
        accept(rec, entry, recsOut);
      });
      entry.ok = entry.count > 0;
      if (!entry.ok) entry.reason = "sin_precio";
      searched.push(entry);
      if (entry.ok && hooks.onSource) { try { hooks.onSource(entry, recsOut); } catch (e) {} }
    }
  } catch (e) { /* el almacen es opcional */ }

  /* Enriquecer las fichas sin EAN: si al abrirlas aparece el mismo codigo, se
     aceptan; si no, se rechazan. Nunca se acepta por parecido.
     Se priorizan Google Shopping/descubrimiento (donde de verdad hay tiendas
     de cualquier sector) y se limita cada fuente para que no acapare las
     fichas. Las que no caben se explican en el diagnostico. */
  const priorityOf = { discovery: 0, explorar: 0, gshopping: 0, bigbuy: 1, aliexpress: 1, cjdropshipping: 2, a1688: 2, alibaba: 2, madeinchina: 2 };
  const sortedPending = pendingAll.slice().sort(function (a, b) {
    const pa = priorityOf[a.id] != null ? priorityOf[a.id] : 3;
    const pb = priorityOf[b.id] != null ? priorityOf[b.id] : 3;
    return pa - pb || a.order - b.order;
  });
  const perSource = {}, pending = [];
  sortedPending.forEach(function (p) {
    if (pending.length >= enrichMax) return;
    perSource[p.id] = (perSource[p.id] || 0) + 1;
    if (perSource[p.id] <= 10) pending.push(p);
  });
  const notEnriched = pendingAll.filter(function (p) { return pending.indexOf(p) === -1; });
  notEnriched.slice(0, 40).forEach(function (p) {
    rejected.push({ source: p.id, kind: "identidad", name: String(p.it && p.it.name || "").slice(0, 80), reason: "No se pudo abrir su ficha para comprobar el EAN dentro del limite de " + enrichMax + " fichas." });
  });
  const recsBySource = {};
  pending.forEach(function (p) { recsBySource[p.entry.source] = p.recsOut; });
  if (pending.length && enrichMax > 0) {
    try {
      const recs = pending.map(function (p) { return eanRecFromItem(p.id, p.label, p.it, srcEans, priceMax); });
      await enrichLib.enrich(recs, { max: recs.length, concurrency: 6, timeoutMs: cfgM.enrichMs || 9000 });
      recs.forEach(function (rec, i) {
        const p = pending[i];
        const d = rec.enriched || {};
        const got = gtinLib.normalizeAll([].concat(d.gtin, d.ean, d.barcode, d.upc));
        if (got.length && gtinLib.intersects(got, srcEans)) {
          rec.ean = got.filter(function (e) { return srcEans.indexOf(e) !== -1; })[0] || srcEans[0];
          if (!(rec.price > 0) && d.price > 0) {
            rec.price = d.price; rec.priceFromPage = true;
            rec.currency = d.currency || rec.currency || "EUR";
            rec.under = priceMax > 0 ? rec.price <= priceMax : null;
            rec.meetsMax = priceMax > 0 ? rec.price <= priceMax : null;
          }
          if (!rec.image && d.images && d.images.length) rec.image = d.images[0];
          if (!rec.brand && d.brand) rec.brand = d.brand;
          rec.matchEnriched = { gtin: got[0] || "", mpn: d.mpn || "", sku: d.sku || "", price: d.price || null };
          accept(rec, p.entry, p.recsOut);
        } else {
          p.entry.noEan++;
          rejected.push({ source: p.id, kind: "identidad", name: String(rec.name || "").slice(0, 80), reason: got.length ? ("EAN/UPC leido en la ficha (" + got.join(", ") + ") no coincide.") : "La ficha no publica EAN/UPC." });
        }
      });
    } catch (e) {}
  }

  /* Se han podido aceptar ofertas despues de cerrar la fuente: recalcular. */
  searched.forEach(function (s) {
    s.ok = s.count > 0;
    if (!s.ok && !s.reason) s.reason = s.rawCount ? "sin_coincidencias_ean" : "sin_resultados";
  });
  /* Reemitir solo las fuentes que ganaron coincidencias al enriquecer. */
  Object.keys(recsBySource).forEach(function (srcId) {
    const entry = searched.filter(function (s) { return s.source === srcId; })[0];
    if (!entry || !entry.ok) return;
    if (hooks.onSource) { try { hooks.onSource(entry, recsBySource[srcId]); } catch (e) {} }
  });
  matches.sort(function (a, b) {
    const pa = a.price > 0, pb = b.price > 0;
    if (pa && pb) return a.price - b.price;
    if (pa) return -1;
    if (pb) return 1;
    return String(a.name || "").localeCompare(String(b.name || ""));
  });
  above.sort(function (a, b) { return (a.price || 1e9) - (b.price || 1e9); });
  const raw = searched.reduce(function (n, s) { return n + (s.rawCount || 0); }, 0);
  const withEan = searched.reduce(function (n, s) { return n + (s.withEan || 0); }, 0);
  const differentEan = searched.reduce(function (n, s) { return n + (s.differentEan || 0); }, 0);
  const noEan = searched.reduce(function (n, s) { return n + (s.noEan || 0); }, 0);
  const sourcesWithEan = searched.filter(function (s) { return (s.withEan || 0) > 0; }).length;
  const sourcesNoEan = searched.filter(function (s) { return (s.rawCount || 0) > 0 && !(s.withEan > 0); }).length;
  const missingKeys = searched.filter(function (s) { return /not_configured|actor_no_configurado|actor_http|api_key|apify|token|clave|missing/i.test(String(s.reason || "")); }).map(function (s) { return s.sourceLabel || s.source; });
  const exactTotal = matches.length + above.length;
  let diagnosis = null;
  if (!exactTotal) {
    const gtinMiss = searched.some(function (s) { return /GTIN_NOT_FOUND|INVALID_GTIN|NO_MATCHING_PRODUCTS/i.test(String(s.reason || "")); });
    const reason = gtinMiss ? "ean_no_vendido" : (!searched.length ? "sin_fuentes" : (!raw ? "sin_respuesta" : (!withEan ? "fuentes_sin_ean" : "ean_no_vendido")));
    const msg = reason === "sin_fuentes"
      ? "No hay fuentes de proveedores configuradas para buscar por EAN."
      : reason === "sin_respuesta"
        ? "Ninguna fuente devolvio resultados. Revisa las claves/API y la conexion."
        : reason === "fuentes_sin_ean"
          ? "Las fuentes respondieron pero no publican EAN/UPC. Conecta tarifas, mayoristas con EAN o descubrimiento con ficha verificable."
          : "Ninguna fuente conectada vende ese EAN/UPC. No es un fallo de coincidencia: no se muestran parecidos.";
    diagnosis = { reason: reason, message: msg, missingKeys: missingKeys, sourcesWithEan: sourcesWithEan, sourcesNoEan: sourcesNoEan };
  }
  const srcId = identity.freezeCard(identity.identityOf(body || {}), body || {});
  const coverage = coverageLib.buildCoverage({ searched: searched, rejected: rejected, matches: matches.concat(above), queries: qlist, identity: srcId });
  const cheapest = matches.filter(function (x) { return x.price > 0; }).sort(function (a, b) { return a.price - b.price; })[0] || null;
  return {
    q: srcEans[0] || "", via: "ean", priceMax: round2(priceMax), eanOnly: true,
    matches: matches, overMax: above.slice(0, 20), searched: searched, identity: srcId,
    rejected: rejected.slice(0, 120), coverage: coverage,
    cheapestVerified: cheapest,
    summary: { exact: exactTotal, raw: raw, withEan: withEan, differentEan: differentEan, noEan: noEan, sourcesWithEan: sourcesWithEan, sourcesNoEan: sourcesNoEan },
    diagnosis: diagnosis
  };
}

/* Respuesta de la fase 2 (proveedores). Conserva TODO lo que la UI necesita
   para explicar un cero: ofertas por encima del precio maximo, diagnostico y
   contadores por fuente. Antes se perdian y la pantalla decia "0 proveedores"
   sin motivo aparente. */
function buildSourcesPayload(out, body, priceMax) {
  out = out || {};
  const amazon = (body && body.asin) ? (MARKET + "/dp/" + String(body.asin).toUpperCase()) : "";
  const google = out.q ? ("https://www.google.com/search?tbm=shop&q=" + encodeURIComponent(out.q)) : "";
  const wholesaleDraft = body && body.brand
    ? ("Hola,\n\nSomos una tienda online y nos interesa distribuir productos de " + body.brand +
       ". Querriamos conocer sus condiciones mayoristas (precio neto, pedido minimo, plazos) para la referencia '" +
       (body.model || body.name || "") + "'.\n\nGracias.")
    : "";
  return {
    ok: true,
    data: {
      source: "inverso", kind: "sources", query: out.q, via: out.via,
      priceMax: round2(priceMax),
      matches: out.matches || [], searched: out.searched || [],
      overMax: out.overMax || [], diagnosis: out.diagnosis || null, summary: out.summary || null,
      review: out.review || [], phases: out.phases || null, policy: out.policy || "",
      queries: out.queries || [],
      amazon: amazon, googleShopping: google, wholesaleDraft: wholesaleDraft,
      cheapestVerified: out.cheapestVerified || cheapestVerified(out.matches),
      cheapestProbable: cheapestVerified(out.matches, ["probable"]),
      identity: out.identity, rejected: out.rejected, coverage: out.coverage,
      scope: { sourcesQueried: (out.searched || []).length, sourcesWithData: (out.searched || []).filter(function (x) { return x.ok; }).length, note: "Fuentes listadas y paginas descubiertas en Google; puede haber proveedores no indexados." }
    }
  };
}

/* Las webs de catalogo fijo (scraping/mayoristas) no deben comerse el
   presupuesto de la busqueda: se cortan a 25 s. El resto conserva el margen
   completo para actores lentos (Apify, descubrimiento). */
function sourceCap(kind) {
  return (kind === "scraping" || kind === "wholesale") ? 25000 : 110000;
}

async function searchSuppliers(body, priceMax, hooks) {
  hooks = hooks || {};
  const { adapters } = require("./index"); /* lazy: evita el ciclo index<->inverso */
  const skip = { amazon: 1, keepa: 1, web: 1, storefronts: 1, newsletters: 1, explorar: 1 };
  /* Primero las fuentes que buscan en toda la red (buscador, 1688, Alibaba,
     Google Shopping...) y las API de mayoristas: son las lentas y las que mas
     valen; las webs de catalogo fijo van detras. */
  const rank = { discovery: 0, supplier_market: 1, wholesale: 2, marketplace: 2 };
  const candidates = Object.keys(adapters).filter(function (id) {
    const a = adapters[id];
    return !skip[id] && a && !a.exactOnly && a.actions && typeof a.actions.search === "function";
  }).sort(function (x, y) {
    const rx = rank[adapters[x].kind] != null ? rank[adapters[x].kind] : 5;
    const ry = rank[adapters[y].kind] != null ? rank[adapters[y].kind] : 5;
    return rx - ry;
  });
  /* Ficha de Amazon: si el frontend no manda EAN/modelo/referencia, se leen de Keepa (1 llamada). */
  let kpProd = null;
  if (body && body.asin && keepaReady() && (!body.ean || !body.model || !body.partNumber || !body.categoryTree || !body.image)) {
    try {
      const kp = await withTimeout(keepaProductsByAsins([String(body.asin).toUpperCase()], 0), 6000);
      kpProd = (kp && kp.products && kp.products[0]) || null;
    } catch (e) {}
  }
  if (kpProd) {
    const fx = keepaFicha.fichaOf(kpProd);
    const f = fx.ficha;
    body = Object.assign({}, body, {
      eans: gtinLib.normalizeAll([].concat(body.eans || [], body.ean || [], f.eans)),
      ean: body.ean || f.eans[0] || "",
      model: body.model || f.model || "",
      partNumber: body.partNumber || f.partNumber || "",
      brand: body.brand || String(kpProd.brand || ""),
      categoryTree: body.categoryTree || kpProd.categoryTree || null,
      image: body.image || keepaImageUrl(kpProd),
      features: (body.features && body.features.length) ? body.features : (f.features || []),
      description: body.description || f.description || "",
      color: body.color || f.color || "",
      size: body.size || f.size || ""
    });
    try { events.add("job", { phase: "ficha", asin: body.asin, eans: (body.eans || []).length, model: body.model, partNumber: body.partNumber, missing: fx.missing.join(",") }); } catch (e) {}
  }
  const srcEans = gtinLib.normalizeAll([].concat((body && body.eans) || [], (body && body.ean) || []));
  /* Politica de identidad: "cascade" (por defecto en la 0.27) intenta EAN
     exacto y, solo si no queda nada verificado, marca+modelo+titulo+specs.
     "exact" conserva el comportamiento anterior. */
  const explicitPolicy = String((body && body.policy) || "").toLowerCase();
  const policy = explicitPolicy || ((body && body.eanOnly === true) ? "exact" : ((body && body.eanOnly === false) ? "keyword" : (config.match.policy || "exact")));
  if (policy === "cascade") return cascadeSuppliers(body, priceMax, hooks, srcEans);
  /* Modo exacto por defecto: sin EAN no se buscan parecidos. */
  if ((body && body.eanOnly) !== false) {
    if (!srcEans.length) {
      return eanZeroResult(body, priceMax, "producto_sin_ean",
        "Este producto no tiene EAN/UPC valido. El modo exacto solo busca por codigo de barras: no se muestran parecidos por marca, modelo o foto.");
    }
    return searchSuppliersEan(body, priceMax, hooks, srcEans);
  }
  const sq = supplierQuery(body);
  const cfgS = config.suppliers || { maxResults: 20, maxResultsCap: 40, maxQueries: 4, maxQueriesPaid: 2, enough: 5 };
  const qlist = queriesLib.buildQueries(body, { maxQueries: 5 });
  const qTokens = tokensOf([body && body.brand, body && body.model, body && body.name].filter(Boolean).join(" ") || sq.q);
  const q = sq.q;
  const srcId = identity.freezeCard(identity.identityOf(body || {}), body || {});
  const srcSpecs = specsLib.fromSource(body || {});
  const ptype = require("../lib/ptype");
  const srcText = [body && body.name, body && body.title, body && body.query].filter(Boolean).join(" ");
  /* Puerta de tipo de producto: palabras que dicen QUE es (telefonillo, teclado...),
     sin marca, modelo, medidas ni colores. La oferta debe compartir al menos una. */
  const brandToks = tokensOf(body && body.brand);
  const NOISE = { negro: 1, blanco: 1, rojo: 1, azul: 1, verde: 1, gris: 1, black: 1, white: 1, red: 1, blue: 1, nuevo: 1, original: 1, oferta: 1, envio: 1, gratis: 1, new: 1, free: 1, shipping: 1, cm: 1, mm: 1, kg: 1, ml: 1, uds: 1, ud: 1, pcs: 1, compatible: 1, incluye: 1, with: 1 };
  const typeToks = tokensOf((body && body.name) || (body && body.title) || "").filter(function (t) {
    return t.length >= 4 && !/\d/.test(t) && !NOISE[t] && brandToks.indexOf(t) === -1;
  }).slice(0, 8);
  function typeGate(name, openSrc) {
    if (!typeToks.length) return true;
    const have = tokensOf(name);
    const hits = typeToks.filter(function (t) {
      return have.some(function (w) { return w === t || (w.length >= 5 && t.length >= 5 && (w.indexOf(t.slice(0, 5)) === 0)); });
    }).length;
    return hits >= (openSrc ? 1 : Math.max(1, Math.ceil(typeToks.length * 0.34)));
  }
  /* Puerta de modelo: codigos alfanumericos (letras+digitos, p. ej. WH-1000XM5, SM-A546B).
     Si el origen los tiene, la oferta debe contener alguno; si muestra OTROS codigos y
     ninguno coincide, es otro modelo y se descarta. Sin codigos en la oferta no se decide. */
  function modelCodes(s) {
    const out = [];
    String(s || "").toUpperCase().replace(/[^A-Z0-9\-\/ ]+/g, " ").split(/\s+/).forEach(function (w) {
      const c = w.replace(/[\-\/]/g, "");
      if (c.length >= 3 && c.length <= 16 && /[A-Z]/.test(c) && /\d/.test(c) && !/^\d+(CM|MM|KG|ML|GB|TB|MAH|W|V|L|G|PCS|UDS|UD)$/.test(c) && !/^(USB|HDMI|WIFI|4K|8K|5G|3D)\d*$/.test(c)) out.push(c);
    });
    return out;
  }
  const srcCodes = modelCodes((body && body.model || "") + " " + srcText);
  const rejected = [];
  const matches = [], above = [], searched = [], review = [];
  if (!q) return { q: "", via: "", matches: matches, searched: searched, coverage: coverageLib.buildCoverage({ searched: searched, rejected: rejected, matches: matches }) };
  /* Perfil de tipo generico: categoria Keepa (hoja) + sustantivo del titulo, traducidos. Sin listas. */
  const typeprofile = require("../lib/typeprofile");
  const catTree = (body && body.categoryTree) || null;
  let tprof = { es: [], en: [], zh: [] };
  try {
    const tr = require("../lib/translate");
    const built = await withTimeout(typeprofile.buildProfile(
      { name: (body && (body.name || body.title)) || sq.q, brand: body && body.brand, categoryTree: catTree },
      { en: function (t) { return tr.translate(t, "en"); }, zh: function (t) { return tr.translate(t, "zh"); } }
    ), 9000);
    if (built && built.es) tprof = built;
  } catch (e) {}
  const weakId = !srcEans.length && !(body && body.brand) && !srcCodes.length;
  const max = clampInt(body && body.max, cfgS.maxResults, 3, cfgS.maxResultsCap);
  /* Fuentes internacionales: reciben ademas el titulo traducido al ingles. */
  const INTL_SOURCES = { alibaba: 1, madeinchina: 1, aliexpress: 1, aliexpress_apify: 1, cjdropshipping: 1, gshopping: 1, discovery: 1 };
  let _en = null;
  async function englishQuery() {
    if (_en !== null) return _en;
    try {
      const tr = require("../lib/translate");
      const v = await withTimeout(tr.marketQuery(body, "en").then(function (t) { return { ok: true, v: t }; }), 6000);
      _en = v && v.ok ? String(v.v || "").trim().slice(0, 110) : "";
    } catch (e) { _en = ""; }
    return _en;
  }
  /* Presupuesto global y concurrencia: antes se consultaba fuente a fuente en
     serie y la peticion entera superaba el timeout del frontend (70 s) → la
     busqueda "no encontraba nada". Ahora van en paralelo con tope de tiempo. */
  /* Los actores de Apify arrancan en frio y tardan 60-90 s. El trabajo es en
     segundo plano (el frontend consulta el estado), asi que se le da margen. */
  const budgetMs = clampInt(body && body.budgetMs, 110000, 15000, 180000);
  const deadline = Date.now() + budgetMs;
  const concurrency = Math.max(2, Math.min(clampInt(body && body.concurrency, 12, 1, 16), candidates.length || 1));
  let cursor = 0;

  async function runOne(id) {
    const entry = { source: id, sourceLabel: adapters[id].label || id, ok: false, count: 0, startedAt: new Date().toISOString() };
    const t0 = Date.now();
    const recsOut = [];
    if (hooks.onStart) { try { hooks.onStart(id, entry.sourceLabel); } catch (e) {} }
    if (Date.now() > deadline) { entry.reason = "tiempo_agotado"; entry.ms = 0; searched.push(entry); if (hooks.onSource) { try { hooks.onSource(entry, []); } catch (e) {} } return; }
    try {
      const open = adapters[id].kind === "discovery" || adapters[id].kind === "supplier_market";
      /* Cascada de consultas: se prueban en orden hasta tener suficientes resultados utiles.
         Las fuentes de pago (Apify) usan pocas; las que ya traducen su consulta, solo una. */
      const paid = open;
      /* El descubrimiento ya expande cada consulta a varios angulos dentro de
         Google; una sola llamada basta y evita multiplicar el coste/tiempo. */
      const budgetQ = adapters[id].ownQuery ? 1 : (id === "discovery" ? 1 : (paid ? cfgS.maxQueriesPaid : cfgS.maxQueries));
      const plan = [];
      for (let qi = 0; qi < qlist.length && plan.length < budgetQ; qi++) {
        const qq = qlist[qi];
        if (qq.intl && !INTL_SOURCES[id]) continue;
        plan.push(qq);
      }
      if (!plan.length) plan.push({ via: sq.via, q: q });
      const kept = [], seenKey = {};
      let r = null, rawCount = 0;
      const tried = [];
      const queryStats = [];
      const keepIfNew = function (it, qq) {
        const k = String(it.url || it.name || "").toLowerCase();
        if (k && seenKey[k]) return;
        if (k) seenKey[k] = 1;
        it.__via = qq.via; it.__q = qq.q;
        kept.push(it);
      };
      for (let pi = 0; pi < plan.length; pi++) {
        const qq = plan[pi];
        if (pi > 0 && Date.now() > deadline - 3000) break;
        let qText = qq.q;
        if (qq.lazyEnglish) { qText = await englishQuery(); if (!qText) continue; qq.q = qText; }
        tried.push(qq.via);
        r = await withTimeout(
          adapters[id].actions.search({
            query: qText,
            max: max,
            market: (body && body.market) || undefined,
            ean: (body && body.ean) || "",
            brand: (body && body.brand) || "",
            model: (body && body.model) || "",
            name: (body && body.name) || ""
          }),
          /* Las webs de catalogo fijo se cortan a 20 s; las que buscan en toda la red, al presupuesto. */
          Math.min(Math.max(5000, deadline - Date.now()), sourceCap(adapters[id].kind))
        );
        const data = r && r.ok ? r.data : null;
        const got = (data && data.items) || [];
        const beforeKept = kept.length;
        rawCount += got.length;
        runFilter(got).forEach(function (it) { keepIfNew(it, qq); });
        queryStats.push({ via: qq.via, q: qText, raw: got.length, kept: kept.length - beforeKept });
        if (kept.length >= cfgS.enough) break;
      }
      entry.queries = tried;
      entry.queryStats = queryStats;
      entry.rawCount = rawCount;
      let items = kept;
      function runFilter(list) {
      /* Filtro de relevancia: las webs de catalogo devuelven enlaces de menu
         (Facebook, "Finalizar compra", categorias) que no tienen que ver con
         el producto. Se descartan salvo coincidencia exacta por EAN. */
      return list.filter(function (it) {
        if (srcEans.length && it.ean && gtinLib.intersects(srcEans, it.ean)) return true;
        const nm = String(it.name || "");
        /* Enlaces de menu / paginas legales: sin precio ni foto no son un producto (vale para cualquier tienda). */
        if (typeprofile.isJunk(it, { open: open })) { rejected.push({ source: id, kind: "menu", name: nm.slice(0, 80), reason: "No es un producto (enlace de menu o pagina legal)." }); return false; }
        /* Nombres sin alfabeto latino (1688, etc.): no se pueden comparar, se conservan como candidatos. */
        if (ptype.hasCJK(nm)) {
          const sz = ptype.sameTypeZh(srcText, nm);
          if (!sz.ok) { rejected.push({ source: id, kind: "tipo", name: nm.slice(0, 80), reason: sz.reason }); return false; }
          /* Si el tipo de origen no es un concepto conocido no se puede comprobar un titulo chino: solo pasa si nombra un modelo del origen. */
          if (!ptype.conceptsOf(srcText).length) {
            const lat = nm.toLowerCase().replace(/[^a-z0-9]+/g, "");
            const hit = (srcId.models || []).some(function (m) { return lat.indexOf(m) !== -1; });
            /* Sin lista: el tipo se traduce al chino desde categoria+titulo y se busca en el titulo. */
            if (!hit && !typeprofile.zhOk(tprof, nm)) { rejected.push({ source: id, kind: "tipo", name: nm.slice(0, 80), reason: "Titulo chino sin ningun termino del tipo de producto." }); return false; }
          }
          return true;
        }
        if (open && !/[a-z]{3}/i.test(nm.normalize("NFD").replace(/[\u0300-\u036f]/g, ""))) return true;
        /* Fase 4: el tipo ya no descarta; solo alimenta la puntuacion (15 puntos).
           Modelo, marca y color tampoco descartan aqui: lo decide match.score. */
        const st = ptype.sameType(srcText, nm);
        const conceptHit = ptype.conceptsOf(srcText).some(function (c) { return ptype.conceptsOf(nm).indexOf(c) !== -1; });
        const profHit = (tprof.es.length + tprof.en.length) > 0 && typeprofile.hits(tprof, nm).length >= (open ? 1 : 2);
        it.__typeConflict = !st.ok;
        it.__typeOk = st.ok && (conceptHit || profHit || (relevance(nm, qTokens) >= (open ? 0.34 : 0.4) && typeGate(nm, open)));
        it.__typeReason = st.ok ? "" : st.reason;
        return true;
      });
      }
      entry.count = items.length;
      entry.ok = items.length > 0;
      if (!items.length) entry.reason = rawCount ? "sin_coincidencias_relevantes" : ((r && r.reason) || "sin_resultados");
      if (r && r.detail && !items.length) entry.detail = String(r.detail).slice(0, 140);
      const label = adapters[id].label || id;
      items.forEach(function (it) {
        let price = num(it.price);
        let titlePrice = false;
        if (!(price > 0)) {
          /* Sin campo precio: lee "desde 30,15 €" / "30,15 EUR" / "desde 30,15" del titulo. */
          const tm = String(it.name || "").match(/(?:desde|a partir de|from)\s*(\d{1,4}(?:[.,]\d{1,2})?)(?!\d)|(\d{1,4}(?:[.,]\d{1,2})?)\s*(?:€|eur\b)/i);
          const tv = tm ? num(String(tm[1] || tm[2]).replace(",", ".")) : 0;
          if (tv > 0) { price = tv; titlePrice = true; }
        }
        const rec = {
          source: id, sourceLabel: label,
          name: it.name || "", brand: it.brand || "", ean: it.ean || "",
          model: it.model || (it.attrs && (it.attrs.model || it.attrs.reference)) || "",
          description: it.description || (it.attrs && it.attrs.description) || "",
          specs: it.specs || [], features: it.features || [],
          color: it.color || (it.attrs && (it.attrs.color || it.attrs.colour)) || "",
          size: it.size || (it.attrs && it.attrs.size) || "",
          material: it.material || (it.attrs && it.attrs.material) || "",
          weight: it.weight || (it.attrs && it.attrs.weight) || "",
          price: price || null, oldPrice: num(it.oldPrice) || null,
          shipping: num(it.shipping) || null, stock: it.stock == null ? null : num(it.stock),
          limit: it.limit == null ? null : num(it.limit),
          url: it.url || "", image: it.image || "", candidate: Boolean(it.candidate),
          contactEmail: it.contactEmail || (it.attrs && it.attrs.email) || "",
          contactPhone: it.contactPhone || (it.attrs && it.attrs.phone) || "",
          via: it.__via || sq.via, queryUsed: it.__q || q,
          priceText: it.priceText || "", minOrder: it.minOrder || null,
          supplier: it.supplier || "", factory: Boolean(it.attrs && it.attrs.factory),
          rel: Math.round(relevance(it.name, qTokens) * 100) / 100,
          under: price > 0 && priceMax > 0 && price <= priceMax,
          meetsMax: price > 0 && priceMax > 0 ? price <= priceMax : null,
          currency: (it.attrs && it.attrs.currency) || (price > 0 ? "EUR" : ""),
          checkedAt: new Date().toISOString()
        };
        rec.role = roleOf(adapters[id], rec);
        /* Fase 4: puntuacion 0-100. Solo el conflicto fuerte (EAN, pack o
           modelo distintos) descarta; el resto queda "a revisar". */
        const mt = matchLib.score(srcId, {
          name: it.name, brand: it.brand, ean: it.ean,
          model: rec.model,
          specs: rec.specs, features: rec.features, description: rec.description,
          color: rec.color, size: rec.size, material: rec.material, weight: rec.weight,
          attrs: it.attrs
        }, { typeOk: it.__typeOk, typeReason: it.__typeReason, typeConflict: it.__typeConflict === true, sourceText: srcText, specs: srcSpecs });
        rec.matchScore = mt.score;
        rec.matchBand = mt.band;
        rec.matchReasons = mt.reasons;
        rec.matchChecks = mt.checks;
        rec.__typeOk = it.__typeOk === true;
        rec.__typeConflict = it.__typeConflict === true;
        rec.__typeReason = it.__typeReason || "";
        /* Los descubrimientos web llegan solo con titulo + URL: no se pueden
           juzgar hasta abrir la ficha. Se conservan como provisionales y el
           cotejo posterior (JSON-LD/Open Graph + foto) decide. El resto de
           fuentes mantiene el descarte inmediato ante conflicto. */
        if (mt.strongConflict || mt.typeConflict || (mt.band !== "verificado" && id !== "discovery")) {
          rejected.push({ source: id, kind: "identidad", name: String(it.name || "").slice(0, 80), reason: mt.reasons[0] || "Coincidencia insuficiente.", score: mt.score });
          return;
        }
        const cmp = identity.compare(srcId, { name: it.name, brand: it.brand, ean: it.ean, model: rec.model, color: rec.color, size: rec.size, attrs: it.attrs });
        rec.match = mt.band === "verificado" ? "exacto" : "equivalente";
        rec.matchBasis = mt.band === "verificado" ? (mt.eanOk ? "ean" : "marca+modelo") : "";
        rec.identity = { verdict: cmp.verdict, reason: mt.reasons.join(" · ") || cmp.reason, checks: mt.checks, score: mt.score, matching: cmp.matching, conflicting: cmp.conflicting };
        rec.imageOk = /^https?:\/\//i.test(String(rec.image || ""));
        if (titlePrice) { rec.priceFromTitle = true; rec.priceText = "desde " + price.toFixed(2).replace(".", ",") + " € (leído del título, confirmar)"; }
        if (price <= 0) { rec.noPrice = true; rec.priceText = rec.priceText || "Contactar para precio"; }
        if (mt.band !== "verificado") {
          rec.review = true;
          rec.provisional = id === "discovery";
          rec.reviewNote = mt.noTextMatch
            ? "Candidato a revisar: titulo en chino, compara la foto con la tuya."
            : (rec.provisional
              ? "Descubierto en la web: se abre su ficha para cotejar el producto."
              : "Candidato a revisar: coincidencia " + mt.score + "/100; compara la foto con la tuya.");
        }
        if (weakId) { rec.review = true; rec.reviewNote = rec.reviewNote || "Identidad de origen débil: candidato a revisar."; }
        rec.state = mt.band === "verificado" ? "verificado" : "candidato";
        recsOut.push(rec);
        if (price <= 0) { matches.push(rec); return; }
        if (priceMax > 0 && price > priceMax) { above.push(rec); return; }
        matches.push(rec);
      });
    } catch (e) {
      entry.reason = String((e && e.message) || e);
    }
    entry.ms = Date.now() - t0;
    searched.push(entry);
    if (hooks.onSource) { try { hooks.onSource(entry, recsOut); } catch (e) {} }
  }

  const workers = [];
  for (let w = 0; w < concurrency; w++) {
    workers.push((async function () {
      while (cursor < candidates.length) {
        const id = candidates[cursor++];
        await runOne(id);
      }
    })());
  }
  await Promise.all(workers);

  /* Fase 4 · las ofertas "a revisar" sin EAN se contrastan abriendo su ficha
     (JSON-LD: gtin/mpn/sku/marca) y se vuelven a puntuar. Si el EAN leido es
     distinto al de Amazon, caen como conflicto fuerte. */
  const cfgM = config.match || {};
  const enrichMax = cfgM.enrichMax == null ? 12 : cfgM.enrichMax;
  if (enrichMax > 0) {
    /* Tambien se cotejan las ofertas por encima del maximo: si no, un precio
       maximo bajo hacia desaparecer resultados verificados y el diagnostico
       decia "no hay ofertas verificables" cuando si las habia. */
    const targets = matches.concat(above).filter(function (r) {
      return !r.ean && /^https?:\/\//i.test(String(r.url || ""));
    }).sort(function (a, b) {
      /* Primero lo descubierto en la web abierta y lo que no trae precio:
         ahi esta la informacion que falta. */
      const da = a.source === "discovery" ? 0 : 1;
      const db = b.source === "discovery" ? 0 : 1;
      if (da !== db) return da - db;
      const oa = above.indexOf(a) !== -1 ? 1 : 0;
      const ob = above.indexOf(b) !== -1 ? 1 : 0;
      if (oa !== ob) return oa - ob;
      const pa = a.price > 0 ? 1 : 0;
      const pb = b.price > 0 ? 1 : 0;
      if (pa !== pb) return pa - pb;
      return (b.matchScore || 0) - (a.matchScore || 0);
    }).slice(0, enrichMax);
    if (targets.length) {
      try {
        await enrichLib.enrich(targets, { max: targets.length, concurrency: 4, timeoutMs: cfgM.enrichMs || 6000 });
        const removed = [];
        targets.forEach(function (rec) {
          const d = rec.enriched;
          if (!d) return;
          const offerName = d.name || rec.name;
          /* Rellenar los datos que la fuente no publicaba. Nunca se sobrescribe
             un dato que ya venia de la oferta. */
          if (!rec.brand && d.brand) rec.brand = d.brand;
          if (!rec.model && (d.mpn || d.sku)) rec.model = d.mpn || d.sku;
          if (!rec.description && d.description) rec.description = d.description;
          if (!rec.specs && d.specs && d.specs.length) rec.specs = d.specs;
          if (!rec.features && d.features && d.features.length) rec.features = d.features;
          if (!rec.color && d.color) rec.color = d.color;
          if (!rec.size && d.size) rec.size = d.size;
          if (!rec.material && d.material) rec.material = d.material;
          if (!rec.weight && d.weight) rec.weight = d.weight;
          if (!rec.image && d.images && d.images.length) { rec.image = d.images[0]; rec.imageOk = true; }
          if (!(rec.price > 0) && d.price > 0) {
            rec.price = d.price;
            rec.priceFromPage = true;
            rec.currency = d.currency || rec.currency || "EUR";
            rec.under = priceMax > 0 ? rec.price <= priceMax : null;
            rec.meetsMax = priceMax > 0 ? rec.price <= priceMax : null;
          }
          if (!rec.name || rec.name.length < 8) rec.name = offerName || rec.name;
          if (!rec.contactEmail && d.contactEmail) rec.contactEmail = d.contactEmail;
          if (!rec.contactPhone && d.contactPhone) rec.contactPhone = d.contactPhone;
          const mt = matchLib.score(srcId, {
            name: offerName, brand: rec.brand, ean: d.gtin || rec.ean,
            model: rec.model || d.mpn || d.sku || "",
            specs: rec.specs, features: rec.features, description: rec.description || "",
            color: rec.color || "", size: rec.size || "", material: rec.material || "", weight: rec.weight || "",
            attrs: d
          }, { typeOk: rec.__typeConflict === true ? false : rec.__typeOk, typeReason: rec.__typeReason || "", typeConflict: rec.__typeConflict === true, sourceText: srcText, specs: srcSpecs });
          rec.matchScore = mt.score;
          rec.matchBand = mt.band;
          rec.matchReasons = mt.reasons;
          rec.matchChecks = mt.checks;
          if (d.gtin) rec.ean = d.gtin;
          rec.match = mt.band === "verificado" ? "exacto" : "equivalente";
          rec.matchBasis = mt.band === "verificado" ? (mt.eanOk ? "ean" : "marca+modelo") : "";
          rec.state = mt.band === "verificado" ? "verificado" : "candidato";
          rec.review = mt.band !== "verificado";
          rec.matchEnriched = {
            gtin: d.gtin || "", mpn: d.mpn || "", sku: d.sku || "",
            price: d.price || null, currency: d.currency || "",
            color: d.color || "", size: d.size || "", material: d.material || "", weight: d.weight || "",
            specs: d.specs ? d.specs.length : 0, description: Boolean(d.description)
          };
          const cmp2 = identity.compare(srcId, {
            name: offerName, brand: rec.brand, ean: rec.ean, model: rec.model,
            color: rec.color, size: rec.size, attrs: d
          });
          rec.identity = {
            verdict: cmp2.verdict, reason: mt.reasons.join(" | ") || cmp2.reason,
            checks: mt.checks, score: mt.score, matching: cmp2.matching, conflicting: cmp2.conflicting
          };
          rec.strongConflict = Boolean(mt.strongConflict || mt.typeConflict);
          if (mt.band === "revisar" && !rec.strongConflict && !rec.imageConflict) review.push(rec);
          const wasAbove = above.indexOf(rec) !== -1;
          if (mt.strongConflict || mt.typeConflict || mt.band !== "verificado") removed.push(rec);
          else if (!wasAbove && priceMax > 0 && rec.price > priceMax) {
            /* La ficha decia un precio distinto: ya no cumple el maximo. No se
               borra, se devuelve como referencia por encima del maximo. */
            removed.push(rec);
            above.push(rec);
          }
        });
        removed.forEach(function (rec) {
          const i = matches.indexOf(rec);
          if (i !== -1) matches.splice(i, 1);
          /* Si estaba por encima del maximo y no se pudo verificar, deja de
             ser una referencia valida. */
          if (rec.matchBand !== "verificado") {
            const ai = above.indexOf(rec);
            if (ai !== -1) above.splice(ai, 1);
          }
          if (rec.matchBand === "descartar" || rec.matchScore === 0) {
            rejected.push({ source: rec.source, kind: "identidad", name: String(rec.name || "").slice(0, 80), reason: (rec.matchReasons && rec.matchReasons[0]) || "EAN distinto leido en la ficha del proveedor.", score: rec.matchScore });
          }
        });
        try { events.add("job", { phase: "match_enrich", tried: targets.length, found: targets.filter(function (r) { return r.enriched; }).length, discarded: removed.length }); } catch (e) {}
      } catch (e) {}
    }
  }
  /* Fase 4b · contraste de fotos. La vision es opcional: sin clave se usan
     las heuristicas y todo queda "sin confirmar visualmente". Una foto
     claramente distinta descarta; una foto igual solo suma evidencia y nunca
     verifica por si sola. */
  const cfgI = config.imageAi || {};
  const imageMax = cfgM.imageMax == null ? 8 : Math.max(0, Math.min(parseInt(cfgM.imageMax, 10) || 0, 20));
  const srcImage = body.image || srcId.image || "";
  if (imageMax > 0 && /^https?:\/\//i.test(String(srcImage))) {
    const imageTargets = matches.filter(function (r) {
      return /^https?:\/\//i.test(String(r.image || ""));
    }).sort(function (a, b) {
      /* Primero las ofertas a revisar: son las que mas necesitan la foto. */
      const ra = a.matchBand === "revisar" ? 0 : 1;
      const rb = b.matchBand === "revisar" ? 0 : 1;
      if (ra !== rb) return ra - rb;
      return (b.matchScore || 0) - (a.matchScore || 0);
    }).slice(0, imageMax);
    if (imageTargets.length) {
      const vision = require("../lib/vision");
      const budget = vision.budget(cfgI.max == null ? 10 : cfgI.max);
      let ii = 0;
      async function imageWorker() {
        while (ii < imageTargets.length) {
          const rec = imageTargets[ii++];
          try {
            const res = await imageLib.visualCompare(srcImage, rec.image, {
              timeoutMs: cfgM.imageMs || 5000,
              apiTimeoutMs: cfgI.timeoutMs || 12000,
              budget: budget,
              srcName: body.name || body.title || "",
              offerName: rec.name || "",
              brand: srcId.brand || "",
              model: (srcId.models && srcId.models[0]) || ""
            });
            rec.imageCheck = {
              state: res.state, same: Boolean(res.same), confirmed: Boolean(res.confirmed),
              reason: res.reason, provider: res.provider || "", cached: Boolean(res.cached)
            };
            rec.imageSame = Boolean(res.same);
            /* La foto se aplica con la MISMA funcion de decision: no hay una
               segunda regla en el adaptador. EAN igual sigue mandando. */
            const imgState = res.state === "same" ? "same" : (res.state === "different" ? "different" : "unknown");
            const mt2 = matchLib.score(srcId, {
              name: rec.name, brand: rec.brand, ean: rec.ean, model: rec.model,
              specs: rec.specs, features: rec.features, description: rec.description || "",
              color: rec.color || "", size: rec.size || "", material: rec.material || "", weight: rec.weight || ""
            }, {
              typeOk: rec.__typeConflict === true ? false : rec.__typeOk,
              typeReason: rec.__typeReason || "",
              typeConflict: rec.__typeConflict === true,
              sourceText: srcText, specs: srcSpecs,
              image: { state: imgState, same: Boolean(res.same), reason: res.reason }
            });
            rec.matchScore = mt2.score;
            rec.matchBand = mt2.band;
            rec.matchReasons = mt2.reasons;
            rec.matchChecks = mt2.checks;
            rec.match = mt2.band === "verificado" ? "exacto" : "equivalente";
            rec.matchBasis = mt2.band === "verificado" ? (mt2.eanOk ? "ean" : "marca+modelo") : "";
            rec.state = mt2.band === "verificado" ? "verificado" : "candidato";
            rec.review = mt2.band !== "verificado";
            rec.imageConflict = mt2.conflicts.indexOf("image") !== -1;
            rec.strongConflict = Boolean(mt2.strongConflict);
            if (rec.identity) {
              rec.identity.score = mt2.score;
              rec.identity.checks = mt2.checks;
              rec.identity.reason = mt2.reasons.join(" · ") || rec.identity.reason;
            }
            if (rec.imageConflict) {
              rec.reviewNote = res.reason;
            } else if (res.same) {
              rec.reviewNote = "La foto es la misma que la de Amazon. " + (rec.reviewNote || "");
            } else if (res.state === "unknown" && rec.matchBand !== "verificado") {
              rec.reviewNote = (res.reason || "Foto sin confirmar visualmente.") + " " + (rec.reviewNote || "");
            }
          } catch (e) {}
        }
      }
      const iw = [];
      for (let n = 0; n < Math.min(4, imageTargets.length); n++) iw.push(imageWorker());
      await Promise.all(iw);
      try {
        events.add("job", {
          phase: "image_check",
          tried: imageTargets.length,
          same: imageTargets.filter(function (r) { return r.imageSame; }).length,
          different: imageTargets.filter(function (r) { return r.imageConflict; }).length,
          unknown: imageTargets.filter(function (r) { return r.imageCheck && r.imageCheck.state === "unknown"; }).length,
          ai: Boolean(budget.used)
        });
      } catch (e) {}
    }
  }

  /* Regla dura: solo se muestra lo que queda VERIFICADO como el mismo
     producto. Los descubrimientos que no se pudieron cotejar (o que tras
     abrir su ficha siguen sin marca+modelo/EAN) no se muestran como si lo
     fueran; pasan al registro de descartes. Una foto distinta tambien cae. */
  for (let i = matches.length - 1; i >= 0; i--) {
    const r = matches[i];
    if (r.matchBand !== "verificado") {
      if (r.matchBand === "revisar" && !r.strongConflict && !r.imageConflict) review.push(r);
      matches.splice(i, 1);
      rejected.push({
        source: r.source, kind: "identidad", name: String(r.name || "").slice(0, 80),
        reason: r.imageConflict
          ? ((r.matchReasons && r.matchReasons[0]) || "La foto no coincide con la de Amazon.")
          : (r.enriched
            ? ((r.matchReasons && r.matchReasons[0]) || "No se pudo verificar que sea el mismo producto.")
            : "No se pudo abrir su ficha para cotejar el producto."),
        score: r.matchScore
      });
    }
  }

  function crossCheckOf(r) {
    const specs = (r.specs && r.specs.length) || (r.enriched && r.enriched.specs && r.enriched.specs.length) || 0;
    const photo = r.imageCheck
      ? (r.imageSame ? "identica" : (r.imageCheck.confirmed ? "distinta" : "sin_confirmar"))
      : (r.image ? "sin_verificar" : "sin_foto");
    return {
      photo: photo,
      photoReason: (r.imageCheck && r.imageCheck.reason) || "",
      photoConfirmed: Boolean(r.imageCheck && r.imageCheck.confirmed),
      photoProvider: (r.imageCheck && r.imageCheck.provider) || "",
      title: Boolean(r.name),
      brand: Boolean(r.brand || (r.enriched && r.enriched.brand)),
      model: Boolean(r.model || (r.matchEnriched && r.matchEnriched.mpn)),
      ean: Boolean(r.ean),
      description: Boolean(r.description || (r.enriched && r.enriched.description)),
      specs: specs,
      color: Boolean(r.color || (r.enriched && r.enriched.color)),
      size: Boolean(r.size || (r.enriched && r.enriched.size)),
      material: Boolean(r.material || (r.enriched && r.enriched.material)),
      weight: Boolean(r.weight || (r.enriched && r.enriched.weight)),
      price: r.price > 0,
      url: Boolean(r.url)
    };
  }
  matches.forEach(function (r) { r.crossCheck = crossCheckOf(r); delete r.__typeOk; delete r.__typeConflict; });

  /* Con precio en EUR: de mas barato a mas caro. Sin precio (enlaces de
     fabricante/mayorista, candidatos en USD/CNY): por relevancia, detras. */
  matches.sort(function (a, b) {
    const pa = a.price > 0, pb = b.price > 0;
    if (pa && pb) return a.price - b.price;
    if (pa) return -1;
    if (pb) return 1;
    return (b.rel || 0) - (a.rel || 0);
  });
  /* Si tras filtrar por precio no queda nada, mostramos las ofertas mas baratas
     por encima del maximo (marcadas «> max.») para que el usuario vea precios
     reales en vez de un "sin resultados" que parece un fallo del boton. */
  let extra = [];
  const aboveVerified = above.filter(function (x) { return x.matchBand === "verificado"; });
  if (!matches.length && priceMax > 0 && aboveVerified.length) {
    aboveVerified.sort(function (a, b) { return (a.price || 1e9) - (b.price || 1e9); });
    extra = aboveVerified.slice(0, 8).map(function (x) { return Object.assign({}, x, { over: true, crossCheck: x.crossCheck || crossCheckOf(x) }); });
  }
  const coverage = coverageLib.buildCoverage({
    searched: searched, rejected: rejected, matches: matches.concat(extra),
    queries: qlist, identity: srcId, candidates: candidates.length
  });
  /* Un recuento por fuente evita que 40 descartes de un catalogo generico
     oculten por que fallaron las fuentes que si podian traer el producto. */
  const rejectedBySource = {};
  rejected.forEach(function (x) { rejectedBySource[x.source] = (rejectedBySource[x.source] || 0) + 1; });
  /* Si no hay ninguna oferta bajo el maximo, `extra` ya muestra las mas
     baratas por encima; no se duplican en `overMax`. */
  const overMax = matches.length ? aboveVerified.slice(0, 12).map(function (x) {
    return Object.assign({}, x, { over: true, crossCheck: x.crossCheck || crossCheckOf(x) });
  }) : [];
  return {
    q: q, via: sq.via, priceMax: round2(priceMax),
    matches: matches.concat(extra), overMax: overMax,
    searched: searched, identity: srcId,
    rejected: rejected.slice(0, 120), rejectedBySource: rejectedBySource,
    review: config.match.reviewVisible === false ? [] : cascadeLib.dedupe(review.map(reviewRec), function (r) {
      return r.source + "|" + (r.url || r.name);
    }).slice(0, 40),
    queries: qlist.map(function (x) { return x.q; }).slice(0, 8),
    policy: "keyword",
    coverage: coverage
  };
}

/* ---------- Cascada de identidad ----------
   Un solo boton para el usuario:
     Fase 1. EAN/UPC exacto en todas las fuentes que publican codigo de barras.
     Fase 2. Solo si la fase 1 no dejo ninguna oferta verificada: marca+modelo
             y despues titulo+specs en catalogos/marketplaces que no publican
             EAN (CJ, AliExpress, 1688, Alibaba...). Cada candidato se coteja
             con la ficha de Amazon; los dudosos van a `review` y NUNCA cuentan
             como proveedor ni entran en el precio mas barato. */
async function cascadeSuppliers(body, priceMax, hooks, srcEans) {
  body = Object.assign({}, body || {});
  hooks = hooks || {};
  const allowKeyword = config.match.allowKeyword !== false;
  const totalMs = clampInt(body.budgetMs, 150000, 45000, 200000);
  const t0 = Date.now();
  let p1 = null, p1err = "", p2 = null, p2err = "";
  if (srcEans.length) {
    try {
      p1 = await searchSuppliersEan(Object.assign({}, body, {
        budgetMs: Math.min(60000, Math.max(25000, Math.round(totalMs * 0.4)))
      }), priceMax, hooks, srcEans);
    } catch (e) { p1err = String((e && e.message) || e); }
  }
  const p1split = cascadeLib.splitOver((p1 && p1.matches) || []);
  const p1matches = p1split.matches;
  const p1count = p1matches.length;
  if (allowKeyword && (!p1count || body.expand === true)) {
    const left = Math.max(30000, totalMs - (Date.now() - t0));
    try {
      p2 = await searchSuppliers(Object.assign({}, body, {
        eanOnly: false, policy: "keyword", budgetMs: left
      }), priceMax, hooks);
    } catch (e) { p2err = String((e && e.message) || e); }
  }
  const srcId = (p1 && p1.identity) || (p2 && p2.identity) ||
    identity.freezeCard(identity.identityOf(body), body);
  const searched = cascadeLib.mergeSearched(
    ((p1 && p1.searched) || []).map(function (e) { return Object.assign({ phase: 1 }, e); }),
    ((p2 && p2.searched) || []).map(function (e) { return Object.assign({ phase: 2 }, e); })
  );
  const p2split = cascadeLib.splitOver((p2 && p2.matches) || []);
  const p2matches = p2split.matches;
  const p2count = p2matches.length;
  const matches = cascadeLib.mergeMatches(p1matches, p2matches);
  const overMax = cascadeLib.dedupe([].concat(
    (p1 && p1.overMax) || [], p1split.over,
    (p2 && p2.overMax) || [], p2split.over
  )).sort(function (a, b) { return (a.price || 1e9) - (b.price || 1e9); }).slice(0, 12);
  const rejected = [].concat((p1 && p1.rejected) || [], (p2 && p2.rejected) || []).slice(0, 120);
  const review = config.match.reviewVisible === false ? [] : ((p2 && p2.review) || []).slice(0, 40);
  const rejectedBySource = {};
  rejected.forEach(function (x) { rejectedBySource[x.source] = (rejectedBySource[x.source] || 0) + 1; });
  const phases = {
    exact: { ran: srcEans.length > 0, matches: p1count, error: p1err || undefined },
    keyword: { ran: Boolean(p2), matches: p2count, error: p2err || undefined },
    elapsedMs: Date.now() - t0
  };
  const summary = cascadeLib.summarize((p1 && p1.summary) || (p2 && p2.summary), p1count, p2count);
  let diagnosis = null;
  if (!matches.length) {
    if (overMax.length) {
      diagnosis = { reason: "solo_por_encima", message: "Hay " + overMax.length + " oferta(s) verificada(s), pero por encima de tu precio maximo" + (priceMax > 0 ? " (" + round2(priceMax) + " EUR)" : "") + ": no dejan margen. Se listan como referencia." };
    } else if (!srcEans.length && !allowKeyword) {
      diagnosis = { reason: "producto_sin_ean", message: "El producto no tiene EAN/UPC y la busqueda por marca/modelo esta desactivada." };
    } else if (review.length) {
      diagnosis = { reason: "solo_revisar", message: "Hay " + review.length + " candidato(s) parecido(s) por marca/modelo/titulo, pero ninguno se pudo verificar como el mismo producto. No cuentan como proveedor." };
    } else if (!srcEans.length) {
      diagnosis = { reason: "sin_coincidencias", message: "Sin EAN/UPC no hay coincidencia exacta; la busqueda por marca+modelo y titulo+specs tampoco encontro ofertas verificables." };
    } else {
      diagnosis = { reason: "sin_coincidencias", message: "Ninguna fuente devolvio el EAN exacto" + (allowKeyword ? " y la busqueda por marca+modelo/titulo no encontro una coincidencia verificable." : ".") };
    }
  }
  let coverage = (p1 && p1.coverage) || (p2 && p2.coverage) || null;
  try {
    coverage = coverageLib.buildCoverage({
      searched: searched, rejected: rejected, matches: matches,
      queries: [].concat(srcEans.map(function (e) { return { via: "ean", q: e }; }), (p2 && p2.queries) || []),
      identity: srcId, candidates: (coverage && coverage.candidates) || 0
    });
  } catch (e) {}
  return {
    q: (p1 && p1.q) || (p2 && p2.q) || "", via: "cascade", policy: "cascade",
    priceMax: round2(priceMax), matches: matches, overMax: overMax, searched: searched,
    identity: srcId, rejected: rejected, rejectedBySource: rejectedBySource,
    review: review, queries: (p2 && p2.queries) || [], phases: phases,
    summary: summary, diagnosis: diagnosis, cheapestVerified: cheapestVerified(matches),
    coverage: coverage
  };
}

/* ---------- candidatos: pool grande, paginado y rotativo ----------
   La lista de Best Sellers de Keepa trae hasta 100.000 ASIN. Antes se cortaba
   a los primeros `limit`; ahora se recorre el pool por lotes, se excluyen los
   ASIN ya vistos y se devuelve una pagina estable. */
function seedHash(s) {
  let h = 2166136261;
  const str = String(s == null ? "" : s);
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function uniqAsins(list) {
  const seen = {};
  const out = [];
  (list || []).forEach(function (a) {
    const v = String(a || "").trim().toUpperCase();
    if (!v || seen[v]) return;
    seen[v] = 1;
    out.push(v);
  });
  return out;
}
function asinListOf(products) {
  return (products || []).map(function (p) { return p && p.asin; }).filter(Boolean);
}
async function candidatesLarge(body) {
  if (!keepaReady()) return { ok: false, reason: "keepa_not_configured", hint: "La busqueda inversa parte de la demanda en Amazon: configura KEEPA_API_KEY." };
  const p = planParams(body);
  const limit = clampInt(body && body.limit, 60, 10, 120);
  const includeDiscards = Boolean(body && body.includeDiscards);
  const seed = num(body && body.seed, Date.now()) || Date.now();
  const exclude = {};
  (Array.isArray(body && body.exclude) ? body.exclude : []).forEach(function (a) {
    const v = String(a || "").trim().toUpperCase();
    if (v) exclude[v] = 1;
  });
  let query = String((body && (body.query || body.q)) || "").trim();
  const rawCategory = body && (body.categoryId || body.category);
  let categoryDigits = digits(rawCategory);
  if (!query && !categoryDigits && String(rawCategory || "").trim()) query = String(rawCategory).trim();
  let categoryName = "";
  let mode = "palabra";
  if (!categoryDigits && !(body && body.finder)) {
    const cat = categoryFor(query);
    if (cat) { categoryDigits = cat.id; categoryName = cat.name; mode = "categoria"; query = ""; }
  } else if (categoryDigits) mode = "categoria";

  const notes = [], errors = [];
  let pool = [], via = "", bestsellerCalls = 0;

  /* Product Finder explicito. */
  if (body && body.finder) {
    const f = await keepaFinder(body);
    if (f.ok && f.asins.length) { pool = f.asins; via = "product_finder"; }
    else if (!f.ok) errors.push("finder:" + (f.reason || "error"));
  }

  /* Categoria: dos listas (rango actual + otro rotado por seed). */
  if (!pool.length && categoryDigits) {
    let ranges = [0, [30, 90, 180][Math.abs(seed) % 3]];
    if (body && body.range != null && String(body.range) !== "") ranges = [num(body.range)];
    for (let i = 0; i < ranges.length; i++) {
      const b = await keepaBestSellers(categoryDigits, ranges[i]);
      bestsellerCalls++;
      if (b.ok && b.asins.length) {
        pool = pool.concat(b.asins);
        via = via || "bestsellers";
        notes.push("Best Sellers " + (ranges[i] ? (ranges[i] + " d") : "actual") + ": " + b.asins.length + " ASIN.");
      } else if (!b.ok) errors.push("bestsellers:" + (b.reason || "error"));
    }
    if (pool.length && body && body.range == null) notes.push("Rangos usados: actual + " + ([30, 90, 180][Math.abs(seed) % 3]) + " d (rotacion por seed).");
  }

  /* Palabra clave: Product Finder por titulo (si esta disponible) y busqueda. */
  if (!pool.length && query) {
    const f = await keepaFinder({
      selection: {
        domainId: config.keepa.domain,
        title: query,
        perPage: Math.min(200, Math.max(50, limit * 2)),
        productType: [0, 1],
        sort: [["current_SALES", "desc"]]
      }
    });
    if (f.ok && f.asins.length) { pool = f.asins; via = "product_finder"; notes.push("Product Finder por titulo: " + f.asins.length + " ASIN."); }
    else if (!f.ok) errors.push("finder_titulo:" + (f.reason || "error"));
  }
  if (!pool.length && query) {
    const s = await keepaSearchProducts(query);
    if (s.ok) {
      pool = asinListOf(s.products);
      via = via || "search";
      notes.push("Busqueda '" + query + "': " + pool.length + " ASIN.");
    } else errors.push("search:" + (s.reason || "error"));
  }

  pool = uniqAsins(pool);
  if (!pool.length) {
    const attempted = (body && body.finder ? 1 : 0) + (categoryDigits ? 1 : 0) + (query ? 1 : 0);
    const tok = await keepaTokens();
    const tokHint = tok ? (" Tokens Keepa disponibles: " + tok.tokensLeft + (tok.refillMinutes ? (", reposicion en ~" + tok.refillMinutes + " min") : "") + ".") : "";
    if (!attempted) return { ok: false, reason: "parametros_vacios", hint: "Indica una categoria, un categoryId de Keepa o una palabra clave (p. ej. freidoras de aire).", notes: notes };
    if (errors.length && errors.length >= attempted) {
      const outOfTokens = errors.some(function (x) { return /keepa_http_(402|429)/.test(x); }) || (tok && tok.tokensLeft <= 0);
      if (outOfTokens) return { ok: false, reason: "keepa_sin_tokens", hint: "La cuenta de Keepa no tiene tokens disponibles (saldo " + (tok ? tok.tokensLeft : "?") + ")." + tokHint, notes: notes };
      const first = errors[0].split(":")[1] || "keepa_error";
      return { ok: false, reason: first, hint: "Keepa no respondio correctamente (" + errors.join(", ") + ")." + tokHint, notes: notes };
    }
    const noData = tok && tok.tokensLeft <= 0;
    return {
      ok: false,
      reason: noData ? "keepa_sin_tokens" : "sin_candidatos",
      hint: noData ? ("La cuenta de Keepa se quedo sin tokens." + tokHint) : ("Keepa no devolvio productos para " + (query ? ("'" + query + "'") : "esa categoria") + ". Prueba otra palabra clave o un node id de categoria." + tokHint),
      notes: notes
    };
  }

  const filteredPool = pool.filter(function (a) { return !exclude[a]; });
  notes.push("Pool: " + pool.length + " ASIN; " + filteredPool.length + " sin los ya vistos.");

  let cursor = 0, scanned = 0, out = [];
  const counts = { apt: 0, casi: 0, descarte: 0 };
  const maxScan = Math.min(filteredPool.length, Math.max(limit * 4, 120));
  while (out.length < limit && cursor < filteredPool.length && scanned < maxScan) {
    const take = Math.min(limit * 2, filteredPool.length - cursor, maxScan - scanned);
    const chunk = filteredPool.slice(cursor, cursor + take);
    cursor += take;
    scanned += take;
    if (!chunk.length) continue;
    const got = await keepaProductsByAsins(chunk, 0);
    const baseM = (got.products || []).map(metricsFromKeepa).filter(function (m) { return m.asin && m.pvp > 0; });
    /* Nombres de los vendedores con mas peso para separar Amazon, marca y terceros. */
    const bbCfg = config.buybox || { sellerLookups: 3 };
    let sellerLookups = 0;
    for (let i = 0; i < baseM.length; i++) {
      const m = baseM[i], bb = m.buyBox;
      if (!p.bbRule || !bb || !bb.known) continue;
      const ids = (bb.breakdown || []).filter(function (x) { return x.role !== "amazon"; })
        .slice(0, bbCfg.sellerLookups).map(function (x) { return x.id; });
      if (!ids.length) continue;
      const names = {};
      for (let j = 0; j < ids.length && sellerLookups < 15; j++) {
        sellerLookups++;
        names[ids[j]] = await keepaSellerName(ids[j]);
      }
      if (!Object.keys(names).length) continue;
      m.sellerNames = names;
      m.buyBox = buybox.analyze(m.__bbHist, 90, undefined, {
        brand: m.brand, manufacturer: m.manufacturer, sellerNames: names, sellerName: m.sellerName
      });
      m.sellerName = m.buyBox.topSellerName || m.sellerName;
      if (m.offersFba != null) m.fbaThird = Math.max(0, m.offersFba - (m.buyBox && m.buyBox.amazonShare > 0 ? 1 : 0));
    }
    baseM.forEach(function (m) {
      const plan = planFor(m, p);
      m.plan = plan;
      m.estado = plan.estado;
      counts[m.estado] = (counts[m.estado] || 0) + 1;
      if (includeDiscards || m.estado !== "descarte") out.push(m);
    });
  }
  if (!includeDiscards) notes.push("Se ocultan los descartados; activa 'Incluir descartados' para verlos.");

  const sortKey = String((body && body.sort) || "aptitud");
  const hash = function (asin) { return seedHash(seed + "|" + asin); };
  /* Margen potencial: parte del PVP que queda libre para pagar al proveedor.
     costMax ya descuenta comisiones, FBA, IVA/recargo y el ROI/margen minimo
     exigido por el tramo de ventas. Mas alto = mas colchon de beneficio. */
  const roomOf = function (m) {
    const pv = (m.plan && m.plan.pvp) || m.pvp || 0;
    return pv > 0 ? (m.plan.costMax || 0) / pv : 0;
  };
  const rankOf = function (m) { return m.estado === "apt" ? 0 : (m.estado === "casi" ? 1 : 2); };
  out.sort(function (a, b) {
    if (sortKey === "precio") {
      const d = (b.pvp || 0) - (a.pvp || 0); if (d) return d;
    } else if (sortKey === "descuento") {
      const d = ((b.plan && b.plan.discount) || 0) - ((a.plan && a.plan.discount) || 0); if (d) return d;
    } else if (sortKey === "ventas") {
      const d = (b.sales || 0) - (a.sales || 0); if (d) return d;
    } else if (sortKey === "aptitud") {
      /* Lo mas apto primero: aptos > casi > descartados y, dentro de cada
         grupo, la mejor combinacion de rotacion (ventas/mes y BSR) y margen. */
      const e = rankOf(a) - rankOf(b); if (e) return e;
      const d = (b.sales || 0) - (a.sales || 0); if (d) return d;
      const r = (a.bsr || 1e12) - (b.bsr || 1e12); if (r) return r;
      const m = roomOf(b) - roomOf(a); if (m) return m;
    } else {
      const d = (b.sales || 0) - (a.sales || 0); if (d) return d;
      const r = (a.bsr || 1e12) - (b.bsr || 1e12); if (r) return r;
      const m = roomOf(b) - roomOf(a); if (m) return m;
      const pr = (b.pvp || 0) - (a.pvp || 0); if (pr) return pr;
    }
    return hash(a.asin) - hash(b.asin);
  });
  out.slice(0, limit).forEach(function (m) {
    m.rotation = Math.round(m.sales || 0);
    delete m.__bbHist;
  });

  const tokensEstimate = scanned + bestsellerCalls * 50;
  notes.push("Escaneados " + scanned + " ASIN; coste Keepa estimado ~" + tokensEstimate + " tokens.");
  return {
    ok: true,
    data: {
      source: "inverso", kind: "candidates", via: via,
      query: query, mode: categoryDigits ? "categoria" : "palabra", categoryName: categoryName,
      count: Math.min(out.length, limit), counts: counts,
      candidates: out.slice(0, limit),
      pool: pool.length, poolRemaining: Math.max(0, filteredPool.length - cursor),
      hasMore: cursor < filteredPool.length,
      seed: seed, page: num(body && body.page, 0),
      params: p, notes: notes,
      filters: { minFbaThird: p.minFbaThird, bbRule: p.bbRule, includeDiscards: includeDiscards, sort: sortKey, limit: limit },
      cost: { asinsScanned: scanned, bestsellerCalls: bestsellerCalls, estimatedTokens: tokensEstimate }
    }
  };
}

/* ---------- adaptador ---------- */
const inverso = {
  id: "inverso",
  label: "Busqueda inversa (Amazon -> proveedor)",
  kind: "reverse",
  actions: {
    ping: async () => ({
      ok: true,
      keepa: keepaReady(),
      amazon: amazonReady(),
      reason: keepaReady() ? null : "keepa_not_configured",
      note: keepaReady()
        ? "Candidatos y metricas por Keepa (Buy Box 90 d, ventas, vendedores); proveedores por los adaptadores del PDF."
        : "Sin Keepa no se pueden detectar candidatos de Amazon (la busqueda inversa parte de la demanda)."
    }),

    /* Fase 1 · candidatos + filtro de precio maximo, todo ANTES de buscar proveedor. */
    candidates: async function (body) {
      return candidatesLarge(body);
    },

    /* Implementacion anterior, conservada para comparar/rollback manual. */
    candidatesLegacy: async function (body) {
      if (!keepaReady()) return { ok: false, reason: "keepa_not_configured", hint: "La busqueda inversa parte de la demanda en Amazon: configura KEEPA_API_KEY." };
      const p = planParams(body);
      const limit = clampInt(body && body.limit, 10, 1, 50);
      let query = String((body && (body.query || body.q)) || "").trim();
      const rawCategory = body && (body.categoryId || body.category);
      let categoryDigits = digits(rawCategory);
      /* Si escriben un texto (no un node id) en el campo de categoria, se usa
         tambien como palabra clave en vez de descartar la busqueda. */
      if (!query && !categoryDigits && String(rawCategory || "").trim()) query = String(rawCategory).trim();
      let products = [], via = "", notes = [], errors = [];

      /* Modo categoria: SOLO si la consulta entera es un termino generico de
         departamento y no hay id numerico ni finder. Todo lo demas = palabra. */
      let mode = "palabra", categoryName = "";
      if (!categoryDigits && !(body && body.finder)) {
        const cat = categoryFor(query);
        if (cat) { categoryDigits = cat.id; categoryName = cat.name; mode = "categoria"; query = ""; notes.push("Categoria detectada: " + cat.name + " (best sellers de amazon.es)"); }
      } else if (categoryDigits) { mode = "categoria"; }

      /* Fuentes del PDF, por orden: Product Finder, best sellers por categoria, busqueda por palabra clave. */
      if (body && body.finder) {
        const f = await keepaFinder(body);
        if (f.ok && f.asins.length) { const r = await keepaProductsByAsins(f.asins.slice(0, limit)); products = r.products; via = "product_finder"; }
        else { if (f.ok) notes.push("Product Finder sin resultados"); else errors.push("finder:" + (f.reason || "error")); }
      }
      if (!products.length && categoryDigits) {
        const b = await keepaBestSellers(categoryDigits);
        if (b.ok && b.asins.length) { const r = await keepaProductsByAsins(b.asins.slice(0, limit)); products = r.products; via = "bestsellers"; }
        else { if (b.ok) notes.push("Best sellers sin resultados"); else errors.push("bestsellers:" + (b.reason || "error")); }
      }
      if (!products.length && query) {
        const s = await keepaSearchProducts(query);
        if (s.ok) {
          products = s.products; via = via || "search"; notes.push("Busqueda '" + query + "': " + products.length + " resultado(s)");
          /* La busqueda no devuelve vendedores: se reconsultan los ASIN con `offers` para contar FBA reales. */
          const asins = products.map(function (x) { return x && x.asin; }).filter(Boolean).slice(0, limit);
          if (asins.length) {
            const full = await keepaProductsByAsins(asins);
            if (full.products && full.products.length) { products = full.products; notes.push("Vendedores FBA leidos de la lista de ofertas de Keepa."); }
          }
        }
        else errors.push("search:" + (s.reason || "error"));
      }
      if (!products.length) {
        /* Distinguir "Keepa fallo" de "no hay resultados": si todas las fuentes
           consultadas fallaron, el motivo real es el error, no la falta de datos. */
        const attempted = (body && body.finder ? 1 : 0) + (categoryDigits ? 1 : 0) + (query ? 1 : 0);
        const tok = await keepaTokens();
        const tokHint = tok ? (" Tokens Keepa disponibles: " + tok.tokensLeft + (tok.refillMinutes ? (", reposicion en ~" + tok.refillMinutes + " min") : "") + ".") : "";
        if (!attempted) {
          return { ok: false, reason: "parametros_vacios", hint: "Indica una categoria, un categoryId de Keepa o una palabra clave (p. ej. freidoras de aire).", notes: notes };
        }
        if (errors.length && errors.length >= attempted) {
          /* HTTP 402/429 de Keepa = cuenta sin saldo (no es un fallo del flujo). */
          const outOfTokens = errors.some(function (x) { return /keepa_http_(402|429)/.test(x); }) || (tok && tok.tokensLeft <= 0);
          if (outOfTokens) {
            return {
              ok: false,
              reason: "keepa_sin_tokens",
              hint: "La cuenta de Keepa no tiene tokens disponibles (saldo " + (tok ? tok.tokensLeft : "?") +
                "). Cada busqueda por palabra clave gasta ~10 tokens y cada ficha ~1; el refresco del Top 20 gasta ~70. " +
                "Con la recarga actual (~1 token/min) no da para la busqueda inversa: amplia al plan API de Keepa (desde 49 EUR/mes = 20 tokens/min)." + tokHint,
              notes: notes
            };
          }
          const first = errors[0].split(":")[1] || "keepa_error";
          return { ok: false, reason: first, hint: "Keepa no respondio correctamente (" + errors.join(", ") + ")." + tokHint, notes: notes };
        }
        const noData = tok && tok.tokensLeft <= 0;
        return {
          ok: false,
          reason: noData ? "keepa_sin_tokens" : "sin_candidatos",
          hint: noData
            ? ("La cuenta de Keepa se quedo sin tokens." + tokHint + " Reintenta cuando se reponga el saldo.")
            : ("Keepa no devolvio productos para " + (query ? ("'" + query + "'") : "esa categoria") + ". Prueba otra palabra clave o un node id de categoria." + tokHint),
          notes: notes
        };
      }

      /* Para separar fabricante de terceros se consulta el nombre de los
         vendedores con mas peso (Keepa seller, cacheado, max 15 por busqueda).
         Asi se puede sumar Amazon + fabricante y contar terceros distintos. */
      const baseM = products.map(metricsFromKeepa).filter(function (m) { return m.asin && m.pvp > 0; });
      const bbCfg = config.buybox || { sellerLookups: 3 };
      let sellerLookups = 0;
      for (let i = 0; i < baseM.length; i++) {
        const m = baseM[i], bb = m.buyBox;
        if (!p.bbRule || !bb || !bb.known) continue;
        const ids = (bb.breakdown || []).filter(function (x) { return x.role !== "amazon"; })
          .slice(0, bbCfg.sellerLookups).map(function (x) { return x.id; });
        if (!ids.length) continue;
        const names = {};
        for (let j = 0; j < ids.length && sellerLookups < 15; j++) {
          sellerLookups++;
          names[ids[j]] = await keepaSellerName(ids[j]);
        }
        if (!Object.keys(names).length) continue;
        m.sellerNames = names;
        m.buyBox = buybox.analyze(m.__bbHist, 90, undefined, {
          brand: m.brand, manufacturer: m.manufacturer, sellerNames: names, sellerName: m.sellerName
        });
        m.sellerName = m.buyBox.topSellerName || m.sellerName;
      }
      notes.push("Buy Box 90 d: " + baseM.filter(function (m) { return m.buyBox && m.buyBox.known; }).length + "/" + baseM.length + " con historial; " + sellerLookups + " vendedor(es) consultado(s).");

      /* Fase 5 · tarifas reales. Keepa las trae en la misma ficha; si falta
         alguna y SP-API esta configurado, se pide getMyFeesEstimate (maximo
         SPAPI_FEES_MAX por busqueda). Si tampoco hay dato, plan.js usa la
         estimacion del PDF y lo indica en `plan.fees.source`. */
      const cfgSp = config.spapi || {};
      let spFees = 0;
      if (amazonReady() && cfgSp.feesMax > 0) {
        const need = baseM.filter(function (m) {
          return !m.fees || m.fees.referralPct == null || m.fees.fbaFee == null;
        }).slice(0, cfgSp.feesMax);
        for (let i = 0; i < need.length; i++) {
          try {
            const r = await spapi.getMyFeesEstimate(need[i].asin, need[i].pvp, "EUR");
            if (!r.ok) continue;
            const f = feesLib.fromEstimate(r.data, need[i].pvp);
            if (f.referralPct != null || f.fbaFee != null) { need[i].fees = f; spFees++; }
          } catch (e) {}
        }
      }
      const realFees = baseM.filter(function (m) {
        return m.fees && !m.fees.partial && m.fees.source !== "estimado";
      }).length;
      if (baseM.length) {
        notes.push("Tarifas reales: " + realFees + "/" + baseM.length +
          (spFees ? " (" + spFees + " por SP-API)" : "") + "; el resto, estimacion del PDF.");
      }

      /* Restricciones de listado (solo aviso, nunca descarte). */
      let restricted = 0;
      let cands = baseM.map(function (m) {
        const plan = planFor(m, p);
        return Object.assign({}, m, { plan: plan, estado: plan.estado });
      });
      const rank = { apt: 0, casi: 1, descarte: 2 };
      const byRank = function (a, b) {
        if (rank[a.estado] !== rank[b.estado]) return rank[a.estado] - rank[b.estado];
        return (a.plan.discount || 0) - (b.plan.discount || 0);
      };
      if (amazonReady() && config.amazon.sellerId && cfgSp.restrictionsMax > 0 && cands.length) {
        const top = cands.slice().sort(byRank).slice(0, cfgSp.restrictionsMax);
        for (let i = 0; i < top.length; i++) {
          try {
            const r = await spapi.getListingsRestrictions(top[i].asin);
            if (!r.ok) continue;
            const rs = feesLib.restrictionsFrom(r.data);
            if (!rs.length) continue;
            top[i].restrictions = rs;
            restricted++;
            const plan = planFor(top[i], p);
            top[i].plan = plan;
            top[i].estado = plan.estado;
          } catch (e) {}
        }
        if (restricted) notes.push("Restricciones de listado en " + restricted + " candidato(s): solo aviso, no descarte.");
      }
      cands.sort(byRank);

      const counts = { apt: 0, casi: 0, descarte: 0 };
      cands.forEach(function (c) { counts[c.estado] = (counts[c.estado] || 0) + 1; });
      return {
        ok: true,
        data: {
          source: "inverso", kind: "candidates", via: via, query: query, mode: via === "search" ? "palabra" : mode, categoryName: categoryName,
          count: cands.length, counts: counts,
          candidates: cands.slice(0, limit * 3),
          params: p, notes: notes
        }
      };
    },

    /* Calculo puro (misma formula) para una ficha manual. Con ASIN y SP-API
       configurado se completan tarifas reales y restricciones de listado. */
    plan: async function (body) {
      const p = planParams(body);
      const m = Object.assign({}, (body && body.metrics) || body || {});
      const notes = [];
      const asin = String(m.asin || "").toUpperCase();
      const pvp = num(m.pvp || m.buybox90 || m.price);
      if (asin && amazonReady()) {
        const jobs = [spapi.getMyFeesEstimate(asin, pvp, "EUR").catch(function (e) {
          return { ok: false, reason: String((e && e.message) || e) };
        })];
        if (config.amazon.sellerId) {
          jobs.push(spapi.getListingsRestrictions(asin).catch(function (e) {
            return { ok: false, reason: String((e && e.message) || e) };
          }));
        }
        const got = await Promise.all(jobs);
        if (got[0] && got[0].ok) {
          const f = feesLib.fromEstimate(got[0].data, pvp);
          if (f.referralPct != null || f.fbaFee != null) {
            m.fees = f;
            notes.push("Tarifas reales por SP-API: referencia " + f.referralPct + " %, FBA " + f.fbaFee + " EUR.");
          } else {
            notes.push("SP-API no devolvio tarifas para " + asin + "; se usa la estimacion del PDF.");
          }
        }
        if (got[1] && got[1].ok) {
          const rs = feesLib.restrictionsFrom(got[1].data);
          if (rs.length) { m.restrictions = rs; notes.push("Restricciones de listado: " + rs.join(" · ")); }
        }
      }
      const plan = planFor({
        pvp: pvp,
        sales: num(m.sales),
        thirdParty: num(m.thirdParty),
        historyDays: m.historyDays == null ? null : num(m.historyDays),
        brandRestricted: !!m.brandRestricted, hazmat: !!m.hazmat, amazonOnly: !!m.amazonOnly,
        buyBox: m.buyBox || null, sellerName: m.sellerName || "",
        brand: m.brand || "", manufacturer: m.manufacturer || "",
        fees: m.fees || null, restrictions: m.restrictions || null
      }, p);
      return { ok: true, data: { source: "inverso", kind: "plan", plan: plan, params: p, notes: notes } };
    },

    /* Fase 2 · buscar donde comprar por debajo del precio maximo. */
    sources: async function (body, ctx, hooks) {
      const priceMax = num(body && (body.priceMax || body.maxPrice));
      const out = await searchSuppliers(body || {}, priceMax, hooks);
      return buildSourcesPayload(out, body, priceMax);
    }
  }
};

inverso.buildSourcesPayload = buildSourcesPayload;

module.exports = inverso;
module.exports.planFor = planFor;
module.exports.metricsFromKeepa = metricsFromKeepa;
module.exports.keepaImageUrl = keepaImageUrl;
module.exports.keepaBestSellers = keepaBestSellers;
module.exports.keepaProductsByAsins = keepaProductsByAsins;
module.exports.keepaCategories = keepaCategories;
module.exports.keepaTokens = keepaTokens;
module.exports.keepaReady = keepaReady;
