const { config, amazonReady, keepaReady, feedReady, scrapingReady } = require("../config");
const { list } = require("../adapters");
const store = require("../lib/store");
const pkg = require("../../package.json");

/* Cobertura real por fuente: que fuentes existen, si estan operativas y cuantos
   productos de catalogo/tarifa ha registrado el backend. No inventa datos:
   "—" cuando no hay dato (p. ej. almacen sin inicializar). */
function readyMap() {
  return {
    amazon: amazonReady(),
    keepa: keepaReady(),
    inverso: keepaReady(),
    top20: keepaReady(),
    outletpc: true,
    lidl: true,
    iherb: scrapingReady() || feedReady("iherb"),
    storefronts: true,
    tarifas: true,
    liquidaciones: true,
    newsletters: true,
    zalandoprive: false
  };
}

async function coverage(req, res) {
  const ready = readyMap();
  const sources = list().map(function (a) {
    const r = Object.prototype.hasOwnProperty.call(ready, a.id) ? ready[a.id] : true;
    return { id: a.id, label: a.label, kind: a.kind, actions: a.actions, ok: !!r };
  });
  let mode = "uninitialized";
  let stats = null;
  try {
    mode = store.mode();
  } catch (e) {}
  try {
    stats = await store.stats();
  } catch (e) {
    stats = null;
  }
  const live = sources.filter(function (s) {
    return s.ok;
  }).length;
  res.json({
    ok: true,
    service: pkg.name,
    version: pkg.version,
    time: new Date().toISOString(),
    market: config.market,
    /* "ok" aqui es configuracion, no una llamada de red. La prueba real es
       POST /selftest, que devuelve resultados y una muestra de cada fuente. */
    okMeaning: "configurado; usa POST /selftest para verificar con datos reales",
    selftest: "/selftest",
    totals: { sources: sources.length, operative: live, notConfigured: sources.length - live },
    store: { mode: mode, stats: stats },
    sources: sources
  });
}

module.exports = coverage;
