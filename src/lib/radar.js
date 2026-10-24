"use strict";
/* Radar de oportunidades.

   Cada dia (a la hora elegida, hora de Madrid) recorre las categorias que
   tu marques con la misma busqueda que «Descubrir», pero con los filtros
   estrictos de arbitraje en Keepa: rotacion, Buy Box repartida entre varios
   vendedores en 90 d y Amazon sin acapararla. Solo guarda lo que sale
   «Oportunidad» o «Con avisos» y que no hayas visto ya: al abrir la app
   tienes la lista de lo nuevo, sin buscar a mano.

   Coste: los ASIN ya vistos (30 dias) o descartados se excluyen ANTES de
   pedir fichas, asi que solo se pagan tokens por productos nuevos. Si Keepa
   va justo de saldo, para y sigue al dia siguiente. */

const docs = require("./docstore");
const keepaCost = require("./keepacost");
const events = require("./events");

const CFG = "radar_cfg", ITEMS = "radar_items";
const DEFAULTS = { enabled: false, categories: [], hour: 7, limit: 30, priceMin: 15, priceMax: 200, filters: {}, lastRun: null };
const KEEP_DAYS = 60, MAX_ITEMS = 600, SEEN_DAYS = 30;

let running = false, timer = null, deps = null;
function inverso() { return (deps && deps.inverso) || require("../adapters/inverso"); }

function madrid(d) {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false });
  const p = {};
  f.formatToParts(d || new Date()).forEach(function (x) { p[x.type] = x.value; });
  return { ymd: p.year + "-" + p.month + "-" + p.day, hour: Number(p.hour) % 24 };
}

async function getCfg() {
  const c = await docs.get(CFG, "cfg");
  return Object.assign({}, DEFAULTS, c || {});
}
async function setCfg(patch) {
  const c = await getCfg();
  patch = patch || {};
  if (patch.enabled != null) c.enabled = Boolean(patch.enabled);
  if (Array.isArray(patch.categories)) c.categories = patch.categories.filter(function (x) { return x && /^\d+$/.test(String(x.id || "")); }).slice(0, 12).map(function (x) { return { id: String(x.id), name: String(x.name || x.id).slice(0, 60) }; });
  if (patch.hour != null) c.hour = Math.min(23, Math.max(0, parseInt(patch.hour, 10) || 0));
  if (patch.limit != null) c.limit = Math.min(60, Math.max(10, parseInt(patch.limit, 10) || 30));
  if (patch.priceMin != null) c.priceMin = Math.max(0, Number(patch.priceMin) || 0);
  if (patch.priceMax != null) c.priceMax = Math.max(0, Number(patch.priceMax) || 0);
  if (patch.filters && typeof patch.filters === "object") c.filters = patch.filters;
  await docs.put(CFG, "cfg", c);
  return c;
}

function compact(m, cat) {
  const pl = m.plan || {};
  return {
    asin: m.asin, title: String(m.title || "").slice(0, 160), brand: m.brand || "", image: m.image || "", ean: m.ean || "",
    url: m.url || "", pvp: m.pvp, sales: m.sales, salesShare: m.salesShare || 0, fbaThird: m.fbaThird, thirdParty: m.thirdParty,
    estado: m.estado, manufacturer: m.manufacturer || "", bsr: m.bsr || 0,
    plan: { priceMax: pl.priceMax, priceMaxNet: pl.priceMaxNet, breakEven: pl.breakEven, breakEvenNet: pl.breakEvenNet, discount: pl.discount, estado: pl.estado, reasons: (pl.reasons || []).slice(0, 4) },
    category: cat ? cat.name : ""
  };
}

async function list() {
  const all = await docs.list(ITEMS);
  const order = { nuevo: 0, visto: 1, descartado: 2 };
  return all.sort(function (a, b) {
    const d = (order[a.status] || 0) - (order[b.status] || 0); if (d) return d;
    return String(b.firstSeen).localeCompare(String(a.firstSeen));
  });
}

async function setStatus(asin, status) {
  const it = await docs.get(ITEMS, String(asin || "").toUpperCase());
  if (!it) return null;
  if (["nuevo", "visto", "descartado"].indexOf(status) === -1) return null;
  it.prevStatus = it.status;
  it.status = status;
  await docs.put(ITEMS, it.asin, it);
  return it;
}
async function markAllSeen() {
  const all = await docs.list(ITEMS);
  let n = 0;
  for (let i = 0; i < all.length; i++) if (all[i].status === "nuevo") { all[i].status = "visto"; await docs.put(ITEMS, all[i].asin, all[i]); n++; }
  return n;
}

async function prune() {
  const all = await docs.list(ITEMS);
  const cut = Date.now() - KEEP_DAYS * 86400000;
  const sorted = all.sort(function (a, b) { return String(b.lastSeen).localeCompare(String(a.lastSeen)); });
  for (let i = 0; i < sorted.length; i++) {
    const old = Date.parse(sorted[i].lastSeen || sorted[i].firstSeen || 0) < cut;
    if ((old && sorted[i].status !== "nuevo") || i >= MAX_ITEMS) await docs.del(ITEMS, sorted[i].asin);
  }
}

async function run(actor) {
  if (running) return { ok: false, reason: "ya_en_marcha" };
  running = true;
  const cfg = await getCfg();
  const out = { at: new Date().toISOString(), actor: actor || "manual", byCat: [], found: 0, nuevos: 0, stopped: "" };
  try {
    if (!cfg.categories.length) { out.stopped = "sin_categorias"; return { ok: false, reason: "sin_categorias" }; }
    if (!inverso().keepaReady()) { out.stopped = "keepa_no_configurado"; return { ok: false, reason: "keepa_no_configurado" }; }
    const items = await docs.list(ITEMS);
    const known = {};
    const seenCut = Date.now() - SEEN_DAYS * 86400000;
    items.forEach(function (x) { if (x.status === "descartado" || Date.parse(x.lastSeen || 0) > seenCut) known[x.asin] = x; });
    for (let i = 0; i < cfg.categories.length; i++) {
      const cat = cfg.categories[i];
      const b = keepaCost.budget(100);
      if (b != null && b < 250) { out.stopped = "keepa_sin_saldo"; break; }
      const before = keepaCost.usage.consumed;
      let r = null;
      try {
        r = await inverso().actions.candidates({
          query: "", categoryId: cat.id, limit: cfg.limit, sort: "aptitud", includeDiscards: false,
          priceMin: cfg.priceMin, priceMaxBB: cfg.priceMax, useHistory: false, refresh: true,
          seed: Math.floor(Math.random() * 2147483647), exclude: Object.keys(known).slice(0, 1500),
          filters: Object.assign({ bbRule: 1, minFbaThird: 2, requireTwoSellers: 0 }, cfg.filters || {})
        });
      } catch (e) { r = { ok: false, reason: String((e && e.message) || e) }; }
      const data = r && r.ok && (r.data && (r.data.data || r.data));
      const cands = (data && data.candidates) || [];
      let nuevos = 0, found = 0;
      for (let j = 0; j < cands.length; j++) {
        const m = cands[j];
        if (!m || !m.asin || (m.estado !== "apt" && m.estado !== "casi")) continue;
        found++;
        const asin = String(m.asin).toUpperCase();
        const prev = known[asin] || (await docs.get(ITEMS, asin));
        if (prev && prev.status === "descartado") continue;
        const it = Object.assign({}, prev || {}, compact(m, cat), { asin: asin, lastSeen: out.at, firstSeen: (prev && prev.firstSeen) || out.at, status: prev ? prev.status : "nuevo" });
        if (!prev) nuevos++;
        await docs.put(ITEMS, asin, it);
        known[asin] = it;
      }
      out.found += found; out.nuevos += nuevos;
      try { require("./usage").add("value", { radar: nuevos }); } catch (e) {}
      out.byCat.push({ id: cat.id, name: cat.name, found: found, nuevos: nuevos, tokens: Math.max(0, keepaCost.usage.consumed - before), error: r && r.ok ? "" : String((r && r.reason) || "error") });
    }
    await prune();
    return { ok: true, run: out };
  } finally {
    running = false;
    try { const c = await getCfg(); c.lastRun = out; await docs.put(CFG, "cfg", c); } catch (e) {}
    try { events.add("radar", { actor: out.actor, found: out.found, nuevos: out.nuevos, stopped: out.stopped }); } catch (e) {}
  }
}

/* Comprueba cada 10 min si toca la pasada del dia. */
async function tick() {
  try {
    const cfg = await getCfg();
    if (!cfg.enabled || !cfg.categories.length || running) return;
    const now = madrid();
    const last = cfg.lastRun && cfg.lastRun.actor === "auto" ? madrid(new Date(cfg.lastRun.at)).ymd : "";
    if (now.hour >= cfg.hour && last !== now.ymd) await run("auto");
  } catch (e) {}
}
function start() {
  if (timer) return;
  timer = setInterval(tick, 10 * 60000);
  if (timer.unref) timer.unref();
  const t = setTimeout(tick, 3 * 60000);
  if (t.unref) t.unref();
}

module.exports = { getCfg, setCfg, list, setStatus, markAllSeen, run, start, tick, status: function () { return { running: running }; }, _setDeps: function (d) { deps = d; }, _madrid: madrid };
