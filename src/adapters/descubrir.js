/* DESCUBRIR (orquestador multi-motor).
   Lanza EN PARALELO varios motores independientes; si uno falla (Apify sin
   credito, BigBuy con clave rechazada, sin clave...) el resto sigue y el motivo
   queda visible por motor. Nada de esto inventa datos: cada motor devuelve lo
   que la fuente real entrega.
   Motores:
   - keepa   : parte de Amazon (ya nace con ASIN, metricas y precio maximo de compra).
   - lidl / outletpc / iherb : tiendas fijas (browse o search).
   - explorar: Google Shopping via Apify (necesita credito).
   - brave   : buscador web (necesita BRAVE_API_KEY); solo se conservan resultados con precio legible. */

const { config } = require("../config");
const { jsonFetch } = require("../lib/http");
const explorarMod = require("./explorar");

const ENGINE_TIMEOUT_MS = 55000;
const SHOPS = ["lidl", "outletpc", "iherb"];
const AMAZON_HOST = /(^|\.)amazon\.|(^|\.)amzn\./i;

function withTimeout(p, ms, label) {
  return new Promise(function (resolve) {
    const t = setTimeout(function () { resolve({ ok: false, reason: "timeout", detail: label + " sin respuesta en " + Math.round(ms / 1000) + " s" }); }, ms);
    Promise.resolve(p).then(
      function (v) { clearTimeout(t); resolve(v); },
      function (e) { clearTimeout(t); resolve({ ok: false, reason: String((e && e.message) || e) }); }
    );
  });
}

/* Traduce el codigo tecnico del fallo a un texto que Kevin entiende. */
function humanReason(reason) {
  const r = String(reason || "");
  if (!r) return "";
  if (/apify_sin_token|sin_clave|not_configured|no_configurado/i.test(r)) return "sin clave configurada";
  if (/_(402|403)$|hard limit|credit/i.test(r)) return "sin crédito";
  if (/_401$/.test(r)) return "clave rechazada";
  if (/_429$/.test(r)) return "límite de uso alcanzado";
  if (/timeout/i.test(r)) return "tiempo agotado";
  if (/sin_resultados|sin_candidatos/i.test(r)) return "sin resultados";
  if (/keepa_sin_tokens/i.test(r)) return "sin tokens Keepa";
  return r.slice(0, 60);
}

function engineResult(id, label, res, items, extra) {
  const base = { id: id, label: label };
  if (res && res.ok && items.length) return Object.assign(base, { status: "ok", count: items.length }, extra || {});
  if (res && res.ok) return Object.assign(base, { status: "empty", count: 0, reason: "sin resultados" }, extra || {});
  return Object.assign(base, { status: "error", count: 0, reason: humanReason(res && (res.reason || res.error)) || "error" }, extra || {});
}

function unwrap(res) {
  const d = (res && (res.data || res)) || {};
  return d;
}

/* ---- motor: tiendas fijas y Google Shopping (adaptadores existentes) ---- */
async function runAdapter(id, label, query, max, seed, fresh) {
  const { adapters } = require("./index"); /* lazy: evita el ciclo */
  const ad = adapters[id];
  if (!ad) return { engine: engineResult(id, label, { ok: false, reason: "no_disponible" }, []), items: [] };
  const action = query ? "search" : "browse";
  if (typeof ad.actions[action] !== "function") return { engine: engineResult(id, label, { ok: false, reason: "accion_no_disponible" }, []), items: [] };
  const body = query ? { query: query, max: max, market: "amazon.es" } : { max: max, market: "amazon.es", seed: seed, fresh: fresh };
  const res = await withTimeout(ad.actions[action](body, {}), ENGINE_TIMEOUT_MS, label);
  const items = res && res.ok ? (unwrap(res).items || []) : [];
  items.forEach(function (it) { it.engine = id; });
  return { engine: engineResult(id, label, res, items), items: items };
}

/* ---- motor: Brave Search (solo resultados con precio legible) ---- */
function parsePrice(text) {
  const m = String(text || "").match(/(\d{1,4}(?:[.,]\d{1,2})?)\s?(?:€|eur\b)|(?:€)\s?(\d{1,4}(?:[.,]\d{1,2})?)/i);
  if (!m) return 0;
  const v = parseFloat(String(m[1] || m[2]).replace(",", "."));
  return v > 0 && v < 5000 ? v : 0;
}
async function runBrave(query, max) {
  const label = "Brave";
  if (!config.discovery || !config.discovery.apiKey) return { engine: { id: "brave", label: label, status: "error", count: 0, reason: "sin clave configurada (BRAVE_API_KEY)" }, items: [] };
  const q = query + " comprar precio";
  const url = "https://api.search.brave.com/res/v1/web/search?q=" + encodeURIComponent(q) + "&count=20&country=" + encodeURIComponent(config.discovery.country || "ES") + "&search_lang=" + encodeURIComponent(config.discovery.lang || "es");
  const res = await withTimeout(jsonFetch(url, { method: "GET", headers: { Accept: "application/json", "X-Subscription-Token": config.discovery.apiKey } }, 20000), ENGINE_TIMEOUT_MS, label);
  if (!res || !res.ok) return { engine: engineResult("brave", label, { ok: false, reason: res && (res.reason || ("brave_http_" + res.status)) }, []), items: [] };
  const results = (res.data && res.data.web && res.data.web.results) || [];
  const items = [];
  results.forEach(function (r) {
    let host = "";
    try { host = new URL(r.url).hostname.replace(/^www\./, ""); } catch (e) { return; }
    if (AMAZON_HOST.test(host)) return;
    const price = parsePrice((r.title || "") + " " + (r.description || ""));
    if (!price) return;
    const img = (r.thumbnail && (r.thumbnail.src || r.thumbnail.original)) || "";
    items.push({
      source: "brave", engine: "brave", name: String(r.title || "").replace(/<[^>]+>/g, "").slice(0, 180),
      brand: "", model: "", reference: "", ean: "", price: price, oldPrice: null, stock: null, available: true,
      url: String(r.url), image: String(img), supplier: host, isSupplier: false,
      attrs: { platform: "brave", merchant: host }, capturedAt: new Date().toISOString()
    });
  });
  const out = items.slice(0, max);
  const eng = engineResult("brave", label, { ok: true }, out);
  if (!out.length) eng.reason = "ninguna página con precio legible";
  return { engine: eng, items: out };
}

/* ---- motor: Amazon/Keepa (nace con ASIN) ---- */
async function runKeepa(query, max, seed) {
  const label = "Keepa";
  const inverso = require("./inverso");
  const term = query || explorarMod.CATEGORIES[Math.abs(parseInt(seed, 10) || 0) % explorarMod.CATEGORIES.length];
  const res = await withTimeout(inverso.actions.candidates({ query: term, limit: Math.min(Math.max(max, 6), 20) }), ENGINE_TIMEOUT_MS, label);
  if (!res || !res.ok) {
    return { engine: engineResult("keepa", label, { ok: false, reason: res && (res.reason || res.error) }, [], { term: term }), candidates: [] };
  }
  const cands = (unwrap(res).candidates || []).filter(function (c) { return c.asin; });
  return { engine: engineResult("keepa", label, { ok: true }, cands, { term: term }), candidates: cands.slice(0, max) };
}

async function run(body) {
  body = body || {};
  const query = String(body.query || "").trim();
  const max = Math.min(Math.max(parseInt(body.max || "24", 10) || 24, 6), 60);
  const seed = body.seed || Date.now();
  const fresh = body.fresh !== false;
  const only = Array.isArray(body.engines) && body.engines.length ? body.engines : null;
  const want = function (id) { return !only || only.indexOf(id) !== -1; };

  const jobs = [];
  if (want("keepa")) jobs.push(runKeepa(query, Math.ceil(max / 2), seed));
  SHOPS.forEach(function (id) { if (want(id)) jobs.push(runAdapter(id, id === "outletpc" ? "Outlet PC" : id === "lidl" ? "Lidl" : "iHerb", query, max, seed, fresh)); });
  if (want("explorar")) jobs.push(runAdapter("explorar", "Google Shopping (Apify)", query, max, seed, fresh));
  /* Brave necesita una consulta: sin palabra clave usa una categoria rotatoria. */
  if (want("brave")) {
    const bq = query || explorarMod.CATEGORIES[Math.abs(parseInt(seed, 10) || 0) % explorarMod.CATEGORIES.length];
    jobs.push(runBrave(bq, max));
  }

  const done = await Promise.all(jobs);
  const engines = [], items = [];
  let candidates = [];
  done.forEach(function (d) {
    engines.push(d.engine);
    if (d.items) items.push.apply(items, d.items);
    if (d.candidates) candidates = candidates.concat(d.candidates);
  });
  const anyData = engines.some(function (e) { return e.status === "ok"; });
  return {
    ok: anyData,
    reason: anyData ? null : "ningun_motor_con_datos",
    data: { source: "descubrir", kind: query ? "search" : "browse", query: query, engines: engines, items: items, candidates: candidates }
  };
}

module.exports = {
  id: "descubrir",
  label: "Descubrir (multi-motor)",
  kind: "discovery_multi",
  actions: {
    ping: async function () {
      return {
        ok: true,
        engines: {
          keepa: Boolean(config.keepa && config.keepa.apiKey),
          brave: Boolean(config.discovery && config.discovery.apiKey),
          apify: Boolean(config.apify && config.apify.token)
        }
      };
    },
    run: run
  },
  humanReason: humanReason
};
