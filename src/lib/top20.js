/* Top 20 · Mas vendidos de Amazon.es (guia de referencia).

   Fuente: Keepa Best Sellers (endpoint /bestsellers, domain 9 = amazon.es).
   REGLA: todo por API (Keepa); nunca scraping directo de Amazon.

   Arquitectura:
   - categories(): categoria raiz del marketplace via Keepa Category Lookup
     (category=0). Se cachea en el almacen.
   - list(): top de una categoria -> ASIN mejor vendidos (Keepa) -> productos
     (Keepa, con stats: precio, BSR, ventas) -> cache con sello de actualizacion.
   - refresh(): fuerza la reconstruccion de una o varias categorias (manual o
     programada por el planificador).

   El resultado se guarda en el almacen (fichero o Postgres) con la clave
   "list|<categoria>|<range>", de modo que el panel se sirve de cache hasta que
   pasa el intervalo de refresco. */

const { config, keepaReady } = require("../config");
const store = require("./store");
const inverso = require("../adapters/inverso");

const RANGES = [0, 30, 90, 180];
const CATEGORIES_KEY = "__categories__";
const AGG_KEY = "__all__";
const DEFAULT_LIMIT = 20;

/* Coste real en tokens de Keepa (docs oficiales). Lo que desangraba la cuenta
   NO eran las fichas (1 token/ASIN) sino las listas de Best Sellers, que
   cuestan 50 tokens FIJOS por cada llamada. Un "top" de 6 categorias = 6 x 50
   = 300 tokens por refresco; con la recarga anterior (~1/min) era imposible.
   Estos valores se usan para comprobar el saldo ANTES de gastar. */
const TOK_BESTSELLERS = 50;
const TOK_PRODUCT = 1;
const TOK_CATEGORY = 1;

/* Departamentos de referencia para "los mas vendidos de Amazon.es".
   Ordenados por peso de venta general: NO son las primeras categorias por id
   (esas caen en Libros / CD / Software y dan un top sesgado). Se pueden
   sobreescribir con TOP20_CATEGORIES. */
const MAJOR_CATEGORIES = [
  { id: "599391031", name: "Hogar y cocina" },
  { id: "599370031", name: "Electronica" },
  { id: "5512276031", name: "Moda" },
  { id: "667049031", name: "Informatica" },
  { id: "6198054031", name: "Belleza" },
  { id: "2454136031", name: "Deportes y aire libre" },
  { id: "6198072031", name: "Alimentacion y bebidas" },
  { id: "599385031", name: "Juguetes y juegos" },
  { id: "2454133031", name: "Bricolaje y herramientas" },
  { id: "3677430031", name: "Salud y cuidado personal" },
  { id: "1951051031", name: "Coche y moto" },
  { id: "1571259031", name: "Jardin" }
];

let last = { at: null, categories: 0, items: 0, errors: 0, actor: null };

function clamp(v, def, min, max) {
  const n = parseInt(v, 10);
  if (!isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

function ageMs(iso) {
  if (!iso) return Infinity;
  const t = new Date(iso).getTime();
  return isFinite(t) ? Date.now() - t : Infinity;
}

function fresh(iso, maxAgeMs) {
  return ageMs(iso) <= maxAgeMs;
}

function listKey(category, range) {
  return "list|" + String(category) + "|" + String(range || 0);
}

/* Coste estimado del refresco: 50 tokens por lista de best sellers + 1 por
   ficha + 1 de Category Lookup. */
function estimateBuildTokens(catsCount, limit) {
  const n = Math.max(1, parseInt(catsCount, 10) || 1);
  const lim = Math.max(1, parseInt(limit, 10) || DEFAULT_LIMIT);
  return n * TOK_BESTSELLERS + lim * TOK_PRODUCT + TOK_CATEGORY;
}
/* Coste de un refresco programado del panel (agregado o categorias concretas). */
function estimateRefreshTokens() {
  const cfg = configuredCategories();
  const n = cfg.length ? cfg.length : Math.min(config.top20.maxCategories || 6, MAJOR_CATEGORIES.length);
  return estimateBuildTokens(n, config.top20.limit || DEFAULT_LIMIT);
}
/* Saldo de tokens de Keepa (llamada de 0 tokens). */
async function balance() {
  try { return inverso.keepaTokens ? await inverso.keepaTokens() : null; } catch (e) { return null; }
}

/* ---------- categorias raiz ---------- */
async function categories(refresh) {
  if (!keepaReady()) return { ok: false, reason: "keepa_not_configured" };
  const cached = await store.top20Get(CATEGORIES_KEY);
  const maxAge = 7 * 24 * 3600 * 1000;
  if (cached && cached.value && !refresh && fresh(cached.at, maxAge)) {
    return { ok: true, cached: true, categories: cached.value, at: cached.at };
  }
  const lookup = inverso.keepaCategories ? await inverso.keepaCategories(0) : { ok: false, reason: "unsupported" };
  if (!lookup.ok || !lookup.categories || !lookup.categories.length) {
    if (cached && cached.value) return { ok: true, cached: true, stale: true, categories: cached.value, at: cached.at };
    return { ok: false, reason: lookup.reason || "sin_categorias" };
  }
  const roots = lookup.categories.filter(function (c) { return !c.parent; });
  const value = (roots.length ? roots : lookup.categories).map(function (c) { return { id: c.id, name: c.name }; });
  const at = store.nowIso();
  await store.top20Set(CATEGORIES_KEY, { value: value, at: at });
  return { ok: true, cached: false, categories: value, at: at };
}

/* ---------- construir la lista de una categoria ---------- */
async function buildList(category, opts) {
  opts = opts || {};
  const limit = clamp(opts.limit, config.top20.limit || DEFAULT_LIMIT, 1, 50);
  let range = parseInt(opts.range, 10);
  if (RANGES.indexOf(range) === -1) range = 0;

  const b = await inverso.keepaBestSellers(category, range);
  if (!b.ok) return { ok: false, reason: b.reason || "bestsellers_failed" };
  const asins = (b.asins || []).slice(0, limit);
  if (!asins.length) return { ok: false, reason: "sin_asins" };

  const r = await inverso.keepaProductsByAsins(asins);
  const byAsin = {};
  (r.products || []).forEach(function (p) { if (p && p.asin) byAsin[String(p.asin).toUpperCase()] = p; });

  const items = [];
  asins.forEach(function (asin, i) {
    const prod = byAsin[String(asin).toUpperCase()];
    if (!prod) return;
    const m = inverso.metricsFromKeepa(prod);
    if (!m.asin) return;
    m.rank = i + 1;
    m.category = String(category);
    m.amazon = m.url || ("https://www.amazon.es/dp/" + m.asin);
    m.google = "https://www.google.com/search?tbm=shop&q=" + encodeURIComponent(m.asin + " " + (m.title || "")).slice(0, 200);
    items.push(m);
  });

  return {
    ok: true,
    built: store.nowIso(),
    category: String(category),
    range: range,
    limit: limit,
    count: items.length,
    items: items
  };
}

/* ---------- "mas vendidos de Amazon.es" (agregado, sin elegir categoria) ---------- */
/* Categorias por defecto cuando no se indica ninguna: las configuradas o, si no,
   las raices principales de Amazon.es detectadas con Keepa Category Lookup. */
async function rootCategories() {
  const cfg = configuredCategories();
  if (cfg.length) return cfg;
  /* Sin TOP20_CATEGORIES: departamentos de venta general curados (los primeros
     maxCategories). Determinista y representativo de "lo mas vendido". */
  const max = config.top20.maxCategories || 6;
  return MAJOR_CATEGORIES.slice(0, max).map(function (c) { return c.id; });
}

/* Une los best sellers de las categorias raiz y ordena por ventas estimadas:
   es el "top general" de Amazon.es sin obligar a elegir categoria. */
async function buildAggregate(opts) {
  opts = opts || {};
  const limit = clamp(opts.limit, config.top20.limit || DEFAULT_LIMIT, 1, 100);
  let range = parseInt(opts.range, 10);
  if (RANGES.indexOf(range) === -1) range = 0;

  const cats = await rootCategories();
  if (!cats.length) return { ok: false, reason: "sin_categorias" };

  /* Tope de tokens: cada ficha que se pide a Keepa cuesta ~1 token. Antes se
     unian hasta `limit` ASIN por categoria (6 x 20 = 120) y se pedia la ficha
     de TODOS -> ~100+ tokens por refresco (una cuenta con deposito 60 no podia
     completarlo y se vaciaba). Ahora se reparte el cupo `limit` entre las
     categorias, de modo que el refresco cuesta ~`limit` tokens. */
  const perCat = Math.max(2, Math.ceil(limit / Math.max(1, cats.length)));

  const seen = {};
  const asins = [];
  const notes = [];
  let errs = 0;
  for (const cat of cats) {
    const b = await inverso.keepaBestSellers(cat, range);
    if (!b.ok) { errs++; notes.push(cat + ":" + (b.reason || "error")); continue; }
    (b.asins || []).slice(0, perCat).forEach(function (a) {
      const k = String(a).toUpperCase();
      if (!k || seen[k]) return;
      seen[k] = 1; asins.push(a);
    });
  }
  if (!asins.length) {
    const tok429 = notes.some(function (n) { return /keepa_http_(402|429)/.test(n); });
    return { ok: false, reason: tok429 ? "keepa_sin_tokens" : (errs ? "bestsellers_failed" : "sin_asins"), notes: notes, categories: cats };
  }

  const r = await inverso.keepaProductsByAsins(asins);
  const byAsin = {};
  (r.products || []).forEach(function (p) { if (p && p.asin) byAsin[String(p.asin).toUpperCase()] = p; });

  const items = [];
  asins.forEach(function (asin) {
    const prod = byAsin[String(asin).toUpperCase()];
    if (!prod) return;
    const m = inverso.metricsFromKeepa(prod);
    if (!m.asin) return;
    m.category = (m.categoryTree && m.categoryTree.length) ? m.categoryTree[m.categoryTree.length - 1] : "";
    m.amazon = m.url || ("https://www.amazon.es/dp/" + m.asin);
    m.google = "https://www.google.com/search?tbm=shop&q=" + encodeURIComponent(m.asin + " " + (m.title || "")).slice(0, 200);
    items.push(m);
  });
  items.sort(function (a, b) {
    const d = (b.sales || 0) - (a.sales || 0);
    if (d) return d;
    return (a.bsr || 1e12) - (b.bsr || 1e12);
  });
  const out = items.slice(0, limit).map(function (m, i) { m.rank = i + 1; return m; });
  if (!out.length) {
    /* Se obtuvieron ASIN pero ninguna ficha trajo datos (p. ej. Keepa sin saldo
       en la llamada de productos): no es un top valido. */
    const tok429 = notes.some(function (n) { return /keepa_http_(402|429)/.test(n); });
    return { ok: false, reason: tok429 ? "keepa_sin_tokens" : "sin_productos", notes: notes, categories: cats };
  }

  return {
    ok: true,
    built: store.nowIso(),
    category: AGG_KEY,
    range: range,
    limit: limit,
    count: out.length,
    categories: cats,
    items: out,
    notes: notes
  };
}

/* ---------- leer (con cache) ---------- */
async function list(category, opts) {
  opts = opts || {};
  if (!keepaReady()) return { ok: false, reason: "keepa_not_configured" };
  const raw = String(category == null ? "" : category).replace(/\D/g, "");
  const key = listKey(raw || AGG_KEY, opts.range);
  const cached = await store.top20Get(key);
  const maxAge = (opts.refresh ? 0 : (config.top20.intervalHours || 6) * 3600 * 1000);

  if (cached && cached.data && cached.data.count && !opts.refresh && fresh(cached.data.built || cached.at, maxAge)) {
    return { ok: true, cached: true, data: cached.data };
  }

  /* Modo "solo cache": el panel pide datos SIN permiso de gastar tokens (al
     abrir). Se sirve lo ultimo guardado; si no hay nada, no se construye. */
  if (opts.cache) {
    if (cached && cached.data && cached.data.count) return { ok: true, cached: true, stale: true, data: cached.data };
    return { ok: false, reason: "sin_cache", hint: "Todavia no hay Top 20 guardado. Pulsa «Actualizar» (consume tokens de Keepa)." };
  }

  /* Refresco automatico desactivado (TOP20_ENABLED=false): no se construye nada
     salvo que se pida expresamente (refresh manual). */
  if (!config.top20.enabled && !opts.refresh) {
    if (cached && cached.data && cached.data.count) return { ok: true, cached: true, stale: true, data: cached.data };
    return { ok: false, reason: "top20_auto_off", hint: "El Top 20 automatico esta desactivado (TOP20_ENABLED=false). Pulsa «Actualizar» para construirlo bajo demanda." };
  }

  /* TOPE DE GASTO: se calcula el coste en tokens y solo se construye si el
     saldo lo cubre entero. Best Sellers de Keepa cuesta 50 tokens por lista;
     sin este control el saldo caia en negativo cada vez que arrancaba. */
  const catsCount = raw ? 1 : (await rootCategories()).length;
  const need = Math.max(config.top20.minTokens || 0, estimateBuildTokens(catsCount, opts.limit || config.top20.limit || DEFAULT_LIMIT));
  const bal = await balance();
  const left = bal && typeof bal.tokensLeft === "number" ? bal.tokensLeft : null;
  if (left != null && left < need) {
    if (cached && cached.data && cached.data.count) return { ok: true, cached: true, stale: true, data: cached.data };
    return {
      ok: false,
      reason: left <= 0 ? "keepa_sin_tokens" : "keepa_pocos_tokens",
      tokensLeft: left,
      need: need,
      hint: "No se construye el Top 20 para no vaciar el saldo: este refresco necesita ~" + need +
        " tokens de Keepa (Best Sellers = 50 tokens por categoria) y quedan " + left + ". Reintenta cuando se repongan."
    };
  }

  const built = raw ? await buildList(raw, opts) : await buildAggregate(opts);
  if (built.ok && built.count > 0) {
    await store.top20Set(key, { data: built, at: store.nowIso() });
    return { ok: true, cached: false, data: built };
  }
  if (cached && cached.data && cached.data.count) return { ok: true, cached: true, stale: true, data: cached.data, reason: built.reason };
  return built;
}

/* ---------- refresco programado de categorias configuradas ---------- */
function configuredCategories() {
  return String(config.top20.categories || "")
    .split(",")
    .map(function (s) { return s.replace(/\D/g, "").trim(); })
    .filter(Boolean);
}

async function refresh(category) {
  const cats = category
    ? String(category).split(",").map(function (s) { return s.replace(/\D/g, "").trim(); }).filter(Boolean)
    : configuredCategories();
  if (!cats.length) {
    /* Sin TOP20_CATEGORIES: el panel "mas vendidos de Amazon.es" se refresca
       como agregado (no requiere categoria). */
    const r = await list("", { refresh: true });
    const okr = !!(r && r.ok);
    const items = (okr && r.data && r.data.count) || 0;
    last = {
      at: store.nowIso(),
      categories: (r && r.data && r.data.categories && r.data.categories.length) || MAJOR_CATEGORIES.length,
      items: items, errors: okr ? 0 : 1, reason: okr ? null : ((r && r.reason) || null), actor: "refresh"
    };
    return { ok: okr, aggregate: true, refreshed: [{ category: AGG_KEY, ok: okr, count: items, reason: (r && r.reason) || null }], at: last.at };
  }
  const out = [];
  let items = 0, errors = 0;
  for (const c of cats) {
    const r = await list(c, { refresh: true });
    if (r.ok) items += (r.data && r.data.count) || 0;
    else errors++;
    out.push({ category: c, ok: !!r.ok, count: r.ok ? (r.data && r.data.count) || 0 : 0, reason: r.reason || null });
  }
  last = { at: store.nowIso(), categories: cats.length, items: items, errors: errors, actor: "refresh" };
  return { ok: true, refreshed: out, at: last.at };
}

function status() {
  const cats = configuredCategories();
  return {
    enabled: config.top20.enabled,
    intervalHours: config.top20.intervalHours,
    limit: config.top20.limit,
    categories: cats,
    aggregate: cats.length === 0,
    maxCategories: config.top20.maxCategories,
    last: last
  };
}

module.exports = { categories, list, refresh, status, configuredCategories, estimateRefreshTokens, estimateBuildTokens };
