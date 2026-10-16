/* Cliente minimo de Apify (una sola clave: APIFY_TOKEN).

   runActor(actorId, input, opts) lanza el actor de forma sincrona
   (run-sync-get-dataset-items) y devuelve { ok, items, reason, cached }.
   - Cache en memoria (APIFY_CACHE_MIN) para no pagar dos veces la misma consulta.
   - Tope de coste por operacion (APIFY_MAX_COST_PER_OP, USD): se acumula el coste
     estimado por contexto de operacion y se corta al superarlo.
   - Motivos claros: apify_sin_token, actor_no_configurado, tope_de_coste,
     actor_http_<status>, actor_error, sin_resultados. */

const { config, apifyReady } = require("../config");

const cache = new Map();
const CACHE_MAX = 300;

function actorPath(id) {
  return String(id || "").trim().replace("/", "~");
}

function keyOf(actor, input) {
  return actor + "|" + JSON.stringify(input || {});
}

function cacheGet(k) {
  const ttl = config.apify.cacheMin * 60000;
  if (!ttl) return null;
  const hit = cache.get(k);
  if (!hit) return null;
  if (Date.now() - hit.t > ttl) { cache.delete(k); return null; }
  return hit.items;
}

function cacheSet(k, items) {
  if (!config.apify.cacheMin) return;
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(k, { t: Date.now(), items: items });
}

/* Contexto de operacion: acumula el coste para respetar el tope. */
function newOp() {
  return { spent: 0, calls: 0 };
}

async function runActor(actorId, input, opts) {
  opts = opts || {};
  if (!apifyReady()) return { ok: false, reason: "apify_sin_token", items: [] };
  if (!actorId) return { ok: false, reason: "actor_no_configurado", items: [] };
  const op = opts.op || null;
  const cap = config.apify.maxCostPerOp;
  if (op && cap > 0 && op.spent >= cap) return { ok: false, reason: "tope_de_coste", items: [] };

  const k = keyOf(actorId, input);
  const cached = cacheGet(k);
  if (cached) return { ok: true, items: cached, cached: true };

  const timeoutSec = opts.timeoutSec || config.apify.timeoutSec;
  const params = ["token=" + encodeURIComponent(config.apify.token), "timeout=" + timeoutSec];
  if (cap > 0) params.push("maxTotalChargeUsd=" + (op ? Math.max(0.01, cap - op.spent) : cap).toFixed(2));
  if (opts.limit) params.push("limit=" + opts.limit);
  const url = config.apify.base + "/v2/acts/" + actorPath(actorId) + "/run-sync-get-dataset-items?" + params.join("&");

  const ctrl = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, (timeoutSec + 8) * 1000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(input || {}),
      signal: ctrl.signal
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
    if (op) { op.calls += 1; op.spent += Number(opts.estCost) || 0.01; }
    if (!res.ok) {
      /* El token nunca se devuelve ni se registra. */
      const msg = data && data.error && data.error.message ? String(data.error.message).slice(0, 160) : "";
      return { ok: false, reason: "actor_http_" + res.status, detail: msg, items: [] };
    }
    const items = Array.isArray(data) ? data : [];
    if (!items.length) return { ok: false, reason: "sin_resultados", items: [] };
    cacheSet(k, items);
    return { ok: true, items: items };
  } catch (e) {
    const aborted = e && e.name === "AbortError";
    return { ok: false, reason: aborted ? "actor_timeout" : "actor_error", items: [] };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { runActor, newOp, apifyReady };
