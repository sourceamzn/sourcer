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
const DEFAULT_LIMIT = 20;

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

/* ---------- leer (con cache) ---------- */
async function list(category, opts) {
  opts = opts || {};
  if (!keepaReady()) return { ok: false, reason: "keepa_not_configured" };
  const cat = String(category == null ? "" : category).replace(/\D/g, "");
  if (!cat) return { ok: false, reason: "category_required" };
  const key = listKey(cat, opts.range);
  const cached = await store.top20Get(key);
  const maxAge = (opts.refresh ? 0 : (config.top20.intervalHours || 6) * 3600 * 1000);

  if (cached && cached.data && !opts.refresh && fresh(cached.data.built || cached.at, maxAge)) {
    return { ok: true, cached: true, data: cached.data };
  }

  const built = await buildList(cat, opts);
  if (built.ok) {
    await store.top20Set(key, { data: built, at: store.nowIso() });
    return { ok: true, cached: false, data: built };
  }
  if (cached && cached.data) return { ok: true, cached: true, stale: true, data: cached.data, reason: built.reason };
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
  if (!cats.length) return { ok: false, reason: "sin_categorias_configuradas" };
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
  return {
    enabled: config.top20.enabled,
    intervalHours: config.top20.intervalHours,
    limit: config.top20.limit,
    categories: configuredCategories(),
    last: last
  };
}

module.exports = { categories, list, refresh, status, configuredCategories };
