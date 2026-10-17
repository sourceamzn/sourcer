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

/* ---------- parametros del proceso (mismos tramos y fiscalidad del PDF) ---------- */
const TIERS = [
  { max: 9, margin: 18, roi: 30, label: "menos de 10/mes" },
  { max: 49, margin: 15, roi: 25, label: "10 a 49/mes" },
  { max: 99, margin: 12.5, roi: 25, label: "50 a 99/mes" },
  { max: 1e9, margin: 10, roi: 20, label: "100 o mas/mes" }
];
const PLAN_DEFAULT = {
  vat: 21, recargo: 5.2, referral: 15, fbaFee: 3.5, storage: 0, digital: 0, inbound: 0.30,
  minBB: 30, minSales: 10, minHistory: 90, minThirdParty: 0, minFba: 2,
  maxDiscount: 0, nearPct: 8, tiers: TIERS
};
function planParams(body) {
  const src = (body && (body.params || body.filters)) || {};
  const p = Object.assign({}, PLAN_DEFAULT);
  Object.keys(PLAN_DEFAULT).forEach(function (k) {
    if (src[k] != null && src[k] !== "") p[k] = num(src[k], PLAN_DEFAULT[k]);
  });
  if (Array.isArray(src.tiers) && src.tiers.length) p.tiers = src.tiers;
  return p;
}
function tierFor(sales, p) {
  const arr = p.tiers || TIERS;
  for (let i = 0; i < arr.length; i++) if (sales <= arr[i].max) return arr[i];
  return arr[arr.length - 1];
}

/* ---------- Fase 1 · Precio maximo de compra (formula literal del PDF) ----------
   1. PV = precio Buy Box media 90 dias, venta SIN IVA (a descontar).
   2. Tarifas reales F = (referencia + FBA + almacenamiento + servicios digitales) x 1,21 + 0,30 envío a FBA.
   3. Coste real maximo = min( (PV - F)/(1 + ROI min), (PV - F) - (margen min x PV) ).
   4. Precio maximo en web del proveedor (con IVA, sin recargo) = coste real maximo / 1,262 x 1,21.
   5. Descuento necesario = 1 - precio maximo / PVP de referencia. */
function planFor(m, p) {
  p = p || PLAN_DEFAULT;
  const pvp = num(m.pvp);
  const sales = num(m.sales);
  const tier = tierFor(sales, p);
  const vat = num(p.vat) / 100, recargo = num(p.recargo) / 100;
  const PV = pvp > 0 ? pvp / (1 + vat) : 0;
  const referencia = PV * (num(p.referral) / 100);
  const F = (referencia + num(p.fbaFee) + num(p.storage) + num(p.digital)) * (1 + vat) + num(p.inbound);
  const cRoi = (PV - F) / (1 + tier.roi / 100);
  const cMargin = PV - F - (tier.margin / 100) * PV;
  const costMax = Math.max(0, Math.min(cRoi, cMargin));
  const priceMax = costMax > 0 ? (costMax / (1 + vat + recargo)) * (1 + vat) : 0;
  const discount = pvp > 0 ? 1 - priceMax / pvp : 0;
  const discPct = round2(discount * 100);

  /* Única regla dura del motor: beneficio neto. Sin coste maximo positivo la
     operacion pierde dinero -> descarte. El resto de criterios del PDF (Buy Box
     minima, ventas, vendedores terceros, historial, descuento necesario) pasa a
     AVISOS configurables: informan, no descartan. */
  const reasons = [];
  const thirdParty = num(m.thirdParty, 0);
  const historyDays = m.historyDays == null ? null : num(m.historyDays);
  const fbaKnown = m.offersFba != null && m.offersFba !== "";
  const fba = num(m.offersFba, 0);
  const lowFba = fbaKnown && fba < num(p.minFba);
  const privateLabel = !!m.privateLabel || (fbaKnown && num(m.thirdParty, 0) <= 1 && fba <= 1);
  const hardDrop = costMax <= 0;
  if (costMax <= 0) reasons.push("Con las tarifas reales no queda coste maximo positivo: no hay beneficio neto.");
  if (lowFba) reasons.push("Solo " + fba + " vendedor(es) FBA (minimo " + p.minFba + "): EN REVISION, no apto.");
  if (privateLabel) reasons.push("Marca privada con exclusividad probable (un unico vendedor): EN REVISION, no apto.");
  if (!hardDrop) {
    if (pvp > 0 && pvp < num(p.minBB)) reasons.push("Precio Buy Box " + round2(pvp) + " € por debajo del minimo (" + p.minBB + " €): el descuento necesario puede no conseguirse.");
    if (sales < num(p.minSales)) reasons.push("Ventas/mes " + round2(sales) + " por debajo del minimo (" + p.minSales + "): poca rotacion.");
    if (num(p.minThirdParty) > 0 && thirdParty < num(p.minThirdParty)) reasons.push("Solo " + thirdParty + " vendedor(es) tercero(s): si solo vende la marca, es marca privada.");
    if (historyDays != null && historyDays < num(p.minHistory)) reasons.push("Historial en Keepa de " + historyDays + " dias (minimo " + p.minHistory + "): listing nuevo, a revisar.");
    if (num(p.maxDiscount) > 0 && discPct > num(p.maxDiscount)) reasons.push("Descuento necesario " + discPct + " % supera el tope " + p.maxDiscount + " %: dificil de conseguir.");
    if (m.brandRestricted) reasons.push("Marca restringida: se puede solicitar en Seller Central (solo aviso).");
    if (m.hazmat) reasons.push("Posible hazmat: se vende por FBM (solo aviso).");
    if (m.amazonOnly) reasons.push("Amazon es el unico otro vendedor: dificilmente cede la Buy Box.");
  }
  const estado = hardDrop ? "descarte" : (reasons.length ? "casi" : "apt");

  return {
    pvp: round2(pvp), pvNet: round2(PV), tier: { margin: tier.margin, roi: tier.roi, label: tier.label },
    referral: round2(referencia), feesReal: round2(F), costMax: round2(costMax),
    priceMax: round2(priceMax), discount: discPct, estado: estado, reasons: reasons
  };
}

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
  let offersFba = fbaFromOffers(prod);
  if (offersFba == null && posNum(s.offerCountFBA) > 0) offersFba = posNum(s.offerCountFBA);
  const amazonSells = keepaCur(prod, 0, true) > 0 || num(s.outOfStockPercentage90) < 0;
  const thirdParty = offersTotal > 0 ? Math.max(0, offersTotal - (amazonSells ? 1 : 0)) : (offersFba || 0);
  const ean = (prod && prod.eanList && prod.eanList[0]) || (prod && prod.upcList && prod.upcList[0]) || "";
  return {
    asin: String((prod && prod.asin) || "").toUpperCase(),
    title: (prod && prod.title) || "",
    brand: (prod && prod.brand) || "",
    image: keepaImageUrl(prod),
    imageSource: keepaImageUrl(prod) ? "amazon (Keepa)" : "",
    url: prod && prod.asin ? "https://www.amazon.es/dp/" + String(prod.asin).toUpperCase() : "",
    pvp: round2(pvp), bsr: bsr, sales: Math.round(sales),
    thirdParty: Math.round(thirdParty), offersFba: offersFba == null ? null : Math.round(offersFba),
    historyDays: historyDays(prod), ean: String(ean || ""),
    categoryTree: (prod && prod.categoryTree) || []
  };
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
const MARKET = "https://www.amazon.es";
function supplierQuery(body) {
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
    return !skip[id] && a && a.actions && typeof a.actions.search === "function";
  }).sort(function (x, y) {
    const rx = rank[adapters[x].kind] != null ? rank[adapters[x].kind] : 5;
    const ry = rank[adapters[y].kind] != null ? rank[adapters[y].kind] : 5;
    return rx - ry;
  });
  const sq = supplierQuery(body);
  const qTokens = tokensOf([body && body.brand, body && body.model, body && body.name].filter(Boolean).join(" ") || sq.q);
  const eanQ = digits(body && body.ean);
  const q = sq.q;
  const srcId = identity.identityOf(body || {});
  const ptype = require("../lib/ptype");
  const srcText = [body && body.name, body && body.title, body && body.query].filter(Boolean).join(" ");
  /* Puerta de tipo de producto: palabras que dicen QUE es (telefonillo, teclado...),
     sin marca, modelo, medidas ni colores. La oferta debe compartir al menos una. */
  const brandToks = tokensOf(body && body.brand);
  const NOISE = { negro: 1, blanco: 1, rojo: 1, azul: 1, verde: 1, gris: 1, black: 1, white: 1, red: 1, blue: 1, nuevo: 1, original: 1, oferta: 1, envio: 1, gratis: 1, new: 1, free: 1, shipping: 1, cm: 1, mm: 1, kg: 1, ml: 1, uds: 1, ud: 1, pcs: 1, compatible: 1, incluye: 1, with: 1 };
  const typeToks = tokensOf((body && body.name) || (body && body.title) || "").filter(function (t) {
    return t.length >= 4 && !/\d/.test(t) && !NOISE[t] && brandToks.indexOf(t) === -1;
  }).slice(0, 8);
  function typeGate(name) {
    if (!typeToks.length) return true;
    const have = tokensOf(name);
    const hits = typeToks.filter(function (t) {
      return have.some(function (w) { return w === t || (w.length >= 5 && t.length >= 5 && (w.indexOf(t.slice(0, 5)) === 0)); });
    }).length;
    return hits >= Math.max(1, Math.ceil(typeToks.length * 0.34));
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
  function modelGate(name) {
    if (!srcCodes.length) return { ok: true };
    const oc = modelCodes(name);
    if (!oc.length) return { ok: true };
    const hit = oc.some(function (c) { return srcCodes.some(function (s) { return c === s || (c.length >= 5 && s.length >= 5 && (c.indexOf(s) !== -1 || s.indexOf(c) !== -1)); }); });
    return hit ? { ok: true } : { ok: false, reason: "Otro modelo: la oferta dice " + oc.slice(0, 2).join("/") + " y el origen " + srcCodes.slice(0, 2).join("/") + "." };
  }
  /* Puerta de marca: si el origen tiene marca, la oferta debe nombrarla (en el
     titulo o en su campo marca) o coincidir en codigo de modelo. Misma categoria
     con otra marca NO es el mismo producto. */
  const brandNorm = String((body && body.brand) || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "");
  function brandGate(it, name) {
    if (brandNorm.length < 3) return { ok: true };
    const hay = (String(name || "") + " " + String((it && it.brand) || "")).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "");
    if (hay.indexOf(brandNorm) !== -1) return { ok: true };
    const oc = modelCodes(name);
    if (srcCodes.length && oc.some(function (c) { return srcCodes.some(function (s) { return c === s; }); })) return { ok: true };
    return { ok: false, reason: "Marca no coincide: el origen es " + body.brand + " y la oferta no la indica." };
  }
  /* Puerta de color: si ambos dicen color y no comparten ninguno, es otra variante. */
  const COLORS = { negro: "n", black: "n", blanco: "b", white: "b", rojo: "r", red: "r", azul: "a", blue: "a", verde: "v", green: "v", gris: "g", grey: "g", gray: "g", rosa: "p", pink: "p", amarillo: "y", yellow: "y", naranja: "o", orange: "o", morado: "m", purple: "m", dorado: "d", gold: "d", plateado: "s", silver: "s", marron: "t", brown: "t", beige: "e" };
  function colorsOf(s) {
    const set = {};
    tokensOf(s).forEach(function (t) { if (COLORS[t]) set[COLORS[t]] = 1; });
    return Object.keys(set);
  }
  const srcColors = colorsOf(srcText + " " + ((body && body.color) || ""));
  function colorGate(name) {
    if (!srcColors.length) return { ok: true };
    const oc = colorsOf(name);
    if (!oc.length) return { ok: true };
    return oc.some(function (c) { return srcColors.indexOf(c) !== -1; }) ? { ok: true } : { ok: false, reason: "Otro color/variante respecto al origen." };
  }
  const rejected = [];
  const matches = [], above = [], searched = [];
  if (!q) return { q: "", via: "", matches: matches, searched: searched };
  const max = clampInt(body && body.max, 12, 3, 24);
  /* Presupuesto global y concurrencia: antes se consultaba fuente a fuente en
     serie y la peticion entera superaba el timeout del frontend (70 s) → la
     busqueda "no encontraba nada". Ahora van en paralelo con tope de tiempo. */
  const budgetMs = clampInt(body && body.budgetMs, 55000, 15000, 90000);
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
      const r = await withTimeout(
        adapters[id].actions.search({
          query: q,
          max: max,
          market: (body && body.market) || undefined,
          ean: (body && body.ean) || "",
          brand: (body && body.brand) || "",
          model: (body && body.model) || "",
          name: (body && body.name) || ""
        }),
        /* Las webs de catalogo fijo se cortan a 20 s; las que buscan en toda la red, al presupuesto. */
        Math.min(Math.max(5000, deadline - Date.now()), rank[adapters[id].kind] != null ? 55000 : 20000)
      );
      const data = r && r.ok ? r.data : null;
      let items = (data && data.items) || [];
      const rawCount = items.length;
      /* Filtro de relevancia: las webs de catalogo devuelven enlaces de menu
         (Facebook, "Finalizar compra", categorias) que no tienen que ver con
         el producto. Se descartan salvo coincidencia exacta por EAN. */
      const open = adapters[id].kind === "discovery" || adapters[id].kind === "supplier_market";
      items = items.filter(function (it) {
        if (eanQ.length >= 8 && it.ean && String(it.ean).indexOf(eanQ) !== -1) return true;
        const nm = String(it.name || "");
        /* Nombres sin alfabeto latino (1688, etc.): no se pueden comparar, se conservan como candidatos. */
        if (ptype.hasCJK(nm)) {
          const sz = ptype.sameTypeZh(srcText, nm);
          if (!sz.ok) { rejected.push({ source: id, name: nm.slice(0, 80), reason: sz.reason }); return false; }
          return true;
        }
        if (open && !/[a-z]{3}/i.test(nm.normalize("NFD").replace(/[\u0300-\u036f]/g, ""))) return true;
        const mg = modelGate(nm);
        if (!mg.ok) { rejected.push({ source: id, name: nm.slice(0, 80), reason: mg.reason }); return false; }
        const bg = brandGate(it, nm);
        if (!bg.ok) { rejected.push({ source: id, name: nm.slice(0, 80), reason: bg.reason }); return false; }
        const cg = colorGate(nm);
        if (!cg.ok) { rejected.push({ source: id, name: nm.slice(0, 80), reason: cg.reason }); return false; }
        const st = ptype.sameType(srcText, nm);
        if (!st.ok) { rejected.push({ source: id, name: nm.slice(0, 80), reason: st.reason }); return false; }
        const ok = relevance(nm, qTokens) >= (open ? 0.34 : 0.4) && typeGate(nm);
        if (!ok) rejected.push({ source: id, name: nm.slice(0, 80), reason: "No es el mismo tipo de producto." });
        return ok;
      });
      entry.count = items.length;
      entry.ok = items.length > 0;
      if (!items.length) entry.reason = rawCount ? "sin_coincidencias_relevantes" : ((r && r.reason) || "sin_resultados");
      if (r && r.detail && !items.length) entry.detail = String(r.detail).slice(0, 140);
      const label = adapters[id].label || id;
      items.forEach(function (it) {
        const price = num(it.price);
        const rec = {
          source: id, sourceLabel: label,
          name: it.name || "", brand: it.brand || "", ean: it.ean || "",
          price: price || null, oldPrice: num(it.oldPrice) || null,
          shipping: num(it.shipping) || null, stock: it.stock == null ? null : num(it.stock),
          limit: it.limit == null ? null : num(it.limit),
          url: it.url || "", image: it.image || "", candidate: Boolean(it.candidate),
          priceText: it.priceText || "", minOrder: it.minOrder || null,
          supplier: it.supplier || "", factory: Boolean(it.attrs && it.attrs.factory),
          rel: Math.round(relevance(it.name, qTokens) * 100) / 100,
          under: price > 0 && priceMax > 0 && price <= priceMax,
          meetsMax: price > 0 && priceMax > 0 ? price <= priceMax : null,
          currency: (it.attrs && it.attrs.currency) || (price > 0 ? "EUR" : ""),
          checkedAt: new Date().toISOString()
        };
        rec.role = roleOf(adapters[id], rec);
        const cmp = identity.compare(srcId, { name: it.name, brand: it.brand, ean: it.ean });
        rec.match = cmp.verdict === "exacto" ? "exacto" : cmp.verdict === "probable" ? "probable" : cmp.verdict === "variante" ? "variante" : "equivalente";
        if (cmp.verdict === "equivalente" && rec.rel >= 0.75 && !it.ean) rec.match = "equivalente";
        rec.identity = { verdict: cmp.verdict, reason: cmp.reason, checks: cmp.checks };
        if (cmp.verdict === "distinto") { rejected.push({ source: id, name: String(it.name || "").slice(0, 80), reason: cmp.reason }); return; }
        rec.imageOk = /^https?:\/\//i.test(String(rec.image || ""));
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
  if (!matches.length && priceMax > 0 && above.length) {
    above.sort(function (a, b) { return (a.price || 1e9) - (b.price || 1e9); });
    extra = above.slice(0, 8).map(function (x) { return Object.assign({}, x, { over: true }); });
  }
  return { q: q, via: sq.via, priceMax: round2(priceMax), matches: matches.concat(extra), searched: searched, identity: srcId, rejected: rejected.slice(0, 40) };
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

      const cands = products
        .map(metricsFromKeepa)
        .filter(function (m) { return m.asin && m.pvp > 0; })
        .map(function (m) {
          const plan = planFor(m, p);
          return Object.assign({}, m, { plan: plan, estado: plan.estado });
        })
        .sort(function (a, b) {
          const rank = { apt: 0, casi: 1, descarte: 2 };
          if (rank[a.estado] !== rank[b.estado]) return rank[a.estado] - rank[b.estado];
          return (a.plan.discount || 0) - (b.plan.discount || 0);
        });

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

    /* Calculo puro (misma formula) para una ficha manual. */
    plan: async function (body) {
      const p = planParams(body);
      const m = (body && body.metrics) || body || {};
      const plan = planFor({
        pvp: num(m.pvp || m.buybox90 || m.price),
        sales: num(m.sales),
        thirdParty: num(m.thirdParty),
        historyDays: m.historyDays == null ? null : num(m.historyDays),
        brandRestricted: !!m.brandRestricted, hazmat: !!m.hazmat, amazonOnly: !!m.amazonOnly
      }, p);
      return { ok: true, data: { source: "inverso", kind: "plan", plan: plan, params: p } };
    },

    /* Fase 2 · buscar donde comprar por debajo del precio maximo. */
    sources: async function (body, ctx, hooks) {
      const priceMax = num(body && (body.priceMax || body.maxPrice));
      const out = await searchSuppliers(body || {}, priceMax, hooks);
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
          priceMax: round2(priceMax), matches: out.matches, searched: out.searched,
          amazon: amazon, googleShopping: google, wholesaleDraft: wholesaleDraft,
          cheapestVerified: cheapestVerified(out.matches), cheapestProbable: cheapestVerified(out.matches, ["probable"]), identity: out.identity, rejected: out.rejected, scope: { sourcesQueried: (out.searched || []).length, sourcesWithData: (out.searched || []).filter(function (x) { return x.ok; }).length, note: "Solo las fuentes listadas en searched; no equivale a todo Internet." }
        }
      };
    }
  }
};

module.exports = inverso;
module.exports.planFor = planFor;
module.exports.metricsFromKeepa = metricsFromKeepa;
module.exports.keepaImageUrl = keepaImageUrl;
module.exports.keepaBestSellers = keepaBestSellers;
module.exports.keepaProductsByAsins = keepaProductsByAsins;
module.exports.keepaCategories = keepaCategories;
module.exports.keepaTokens = keepaTokens;
module.exports.keepaReady = keepaReady;
