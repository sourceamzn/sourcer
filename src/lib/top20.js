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

  const seen = {};
  const asins = [];
  const notes = [];
  let errs = 0;
  for (const cat of cats) {
    const b = await inverso.keepaBestSellers(cat, range);
    if (!b.ok) { errs++; notes.push(cat + ":" + (b.reason || "error")); continue; }
    (b.asins || []).slice(0, limit).forEach(function (a) {
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

  /* No gastar tokens si la cuenta esta a cero: se devuelve el motivo real en
     lugar de encadenar peticiones que Keepa rechaza con HTTP 429. */
  let bal = null;
  try { bal = inverso.keepaTokens ? await inverso.keepaTokens() : null; } catch (e) {}
  if (bal && typeof bal.tokensLeft === "number" && bal.tokensLeft <= 0) {
    if (cached && cached.data && cached.data.count) return { ok: true, cached: true, stale: true, data: cached.data };
    return {
      ok: false, reason: "keepa_sin_tokens",
      hint: "La cuenta de Keepa no tiene tokens (saldo " + bal.tokensLeft + (bal.refillMinutes ? (", reposicion en ~" + bal.refillMinutes + " min") : "") +
        "). El Top 20 une varios departamentos y gasta decenas de tokens por refresco; amplia el plan API de Keepa (desde 49 EUR/mes = 20 tokens/min)."
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

module.exports = { categories, list, refresh, status, configuredCategories };
