"use strict";
/* Diario de pruebas: todo lo que pasa en la herramienta, 90 dias.

   Detalle: 1 ano. Ademas, un resumen por mes que se guarda PARA SIEMPRE
   (coleccion `journal_months`): sirve de historico para comparar meses y
   epocas del ano aunque el detalle ya se haya borrado.

   Busquedas de productos, radar, busquedas de proveedor, cruces de tarifa,
   decisiones del usuario (guardar, descartar, bloquear), correos enviados y
   recibidos, errores y correcciones («Esto esta mal»). Sirve para auditar
   las pruebas semana a semana y ver que falla y que funciona.

   Con DATABASE_URL: tabla `journal` (no se pierde al reiniciar).
   Sin ella: memoria (ultimos 3.000). */

const { config } = require("../config");
const KEEP_DAYS = 365;
const docs = require("./docstore");
const MEM_MAX = 3000;
const mem = [];
let pool = null, ready = null, disabled = false, pruneTimer = null, seq = 0;

function db() {
  if (disabled || !config.databaseUrl) return null;
  if (pool) return pool;
  try {
    const { Pool } = require("pg");
    const url = config.databaseUrl;
    const needsSsl = !/railway\.internal|localhost|127\.0\.0\.1/.test(url);
    pool = new Pool({ connectionString: url, ssl: needsSsl ? { rejectUnauthorized: false } : false, max: 2, connectionTimeoutMillis: 10000 });
    pool.on("error", function () {});
    return pool;
  } catch (e) { disabled = true; return null; }
}
function init() {
  const p = db();
  if (!p) return Promise.resolve(false);
  if (!ready) {
    ready = p.query("CREATE TABLE IF NOT EXISTS journal (id BIGSERIAL PRIMARY KEY, at TIMESTAMPTZ NOT NULL DEFAULT now(), kind TEXT NOT NULL, data JSONB NOT NULL)")
      .then(function () { return p.query("CREATE INDEX IF NOT EXISTS journal_at ON journal (at)"); })
      .then(function () {
        if (!pruneTimer) { pruneTimer = setInterval(prune, 6 * 3600000); if (pruneTimer.unref) pruneTimer.unref(); }
        return true;
      })
      .catch(function () { ready = null; return false; });
  }
  return ready;
}

/* Nunca guarda claves: se recortan textos y se tapan tokens. */
function scrub(v) {
  if (v == null) return v;
  if (typeof v === "number" || typeof v === "boolean") return v;
  if (Array.isArray(v)) return v.slice(0, 40).map(scrub);
  if (typeof v === "object") { const o = {}; Object.keys(v).slice(0, 40).forEach(function (k) { if (!/token|password|secret|apikey|api_key|authorization/i.test(k)) o[k] = scrub(v[k]); }); return o; }
  return String(v).replace(/(token|key|secret|password)(["'\s:=]+)([^\s"'&,}]{6,})/gi, "$1$2***").slice(0, 600);
}

function add(kind, data) {
  const row = { id: "m" + (++seq), at: new Date().toISOString(), kind: String(kind || "evt").slice(0, 40), data: scrub(data || {}) };
  mem.push(row);
  if (mem.length > MEM_MAX) mem.shift();
  init().then(function (ok) {
    if (ok) pool.query("INSERT INTO journal (kind, data) VALUES ($1, $2)", [row.kind, JSON.stringify(row.data)]).catch(function () {});
  }).catch(function () {});
}

async function list(opts) {
  opts = opts || {};
  const days = Math.min(Math.max(Number(opts.days) || 7, 1), KEEP_DAYS);
  const limit = Math.min(Math.max(Number(opts.limit) || 5000, 1), 20000);
  const since = new Date(Date.now() - days * 86400000);
  if (await init()) {
    try {
      const args = [since];
      let q = "SELECT id, at, kind, data FROM journal WHERE at >= $1";
      if (opts.kind) { args.push(String(opts.kind)); q += " AND kind = $2"; }
      q += " ORDER BY at DESC LIMIT " + limit;
      const r = await pool.query(q, args);
      return r.rows.map(function (x) { return { id: String(x.id), at: new Date(x.at).toISOString(), kind: x.kind, data: x.data }; });
    } catch (e) {}
  }
  return mem.filter(function (x) { return Date.parse(x.at) >= since.getTime() && (!opts.kind || x.kind === opts.kind); }).slice(-limit).reverse();
}

/* Resumen para el panel: cuantas cosas de cada tipo, correcciones por motivo
   y los errores mas repetidos. */
async function summary(days) {
  const rows = await list({ days: days || 7, limit: 20000 });
  const byKind = {}, fbReason = {}, errors = {};
  rows.forEach(function (r) {
    byKind[r.kind] = (byKind[r.kind] || 0) + 1;
    if (r.kind === "feedback" && r.data) { const k = (r.data.type || "") + ":" + (r.data.reason || ""); fbReason[k] = (fbReason[k] || 0) + 1; }
    if (r.kind === "error" && r.data) { const k = String(r.data.where || r.data.path || "") + " · " + String(r.data.msg || r.data.reason || r.data.error || "").slice(0, 80); errors[k] = (errors[k] || 0) + 1; }
  });
  const top = function (o, n) { return Object.keys(o).map(function (k) { return [k, o[k]]; }).sort(function (a, b) { return b[1] - a[1]; }).slice(0, n || 10); };
  return { days: days || 7, total: rows.length, byKind: byKind, feedback: top(fbReason, 15), errors: top(errors, 10), persistent: Boolean(pool && ready), first: rows.length ? rows[rows.length - 1].at : null };
}

async function prune() {
  try { await monthsUpdate(); } catch (e) {}
  if (!(await init())) return;
  try { await pool.query("DELETE FROM journal WHERE at < now() - interval '" + KEEP_DAYS + " days'"); } catch (e) {}
}

/* ---------- resumen mensual permanente ---------- */
function ym(d) { return new Date(d).toISOString().slice(0, 7); }
function summarizeRows(rows) {
  const byKind = {}, fb = {}, errors = {}, decisions = {}, fbType = {};
  let busqProd = 0, aptos = 0, busqProv = 0, provs = 0;
  rows.forEach(function (r) {
    const d = r.data || {};
    byKind[r.kind] = (byKind[r.kind] || 0) + 1;
    if (r.kind === "feedback") { const k = (d.type || "") + ":" + (d.reason || ""); fb[k] = (fb[k] || 0) + 1; fbType[d.type || ""] = (fbType[d.type || ""] || 0) + 1; }
    if (r.kind === "error") { const k = String(d.where || d.path || "") + " · " + String(d.msg || d.reason || "").slice(0, 80); errors[k] = (errors[k] || 0) + 1; }
    if (r.kind === "decision") decisions[d.what || "?"] = (decisions[d.what || "?"] || 0) + 1;
    if (r.kind === "busqueda_producto") { busqProd++; aptos += Number(d.counts && d.counts.apt) || 0; }
    if (r.kind === "busqueda_proveedor") { busqProv++; provs += (d.leads || []).length; }
  });
  const top = function (o, n) { return Object.keys(o).map(function (k) { return [k, o[k]]; }).sort(function (a, b) { return b[1] - a[1]; }).slice(0, n || 15); };
  return { total: rows.length, byKind: byKind, decisions: decisions, feedbackByType: fbType, feedback: top(fb, 20), errors: top(errors, 15), busquedasProducto: busqProd, aptosEnBusquedas: aptos, busquedasProveedor: busqProv, proveedoresVistos: provs };
}
async function monthRows(month) {
  const start = new Date(month + "-01T00:00:00Z"), end = new Date(start); end.setUTCMonth(end.getUTCMonth() + 1);
  if (await init()) {
    try {
      const r = await pool.query("SELECT at, kind, data FROM journal WHERE at >= $1 AND at < $2", [start, end]);
      return r.rows.map(function (x) { return { at: x.at, kind: x.kind, data: x.data }; });
    } catch (e) {}
  }
  return mem.filter(function (x) { const t = Date.parse(x.at); return t >= start.getTime() && t < end.getTime(); });
}
/* Actualiza el mes en curso y el anterior (el anterior queda cerrado). */
async function monthsUpdate() {
  const now = new Date();
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  for (const m of [ym(prev), ym(now)]) {
    const old = await docs.get("journal_months", m);
    if (old && old.closed) continue;
    const rows = await monthRows(m);
    if (!rows.length && !old) continue;
    let usageDoc = null;
    try { usageDoc = await docs.get("usage", m); } catch (e) {}
    await docs.put("journal_months", m, Object.assign({ month: m, updatedAt: new Date().toISOString(), closed: m !== ym(now) }, summarizeRows(rows), { usage: usageDoc ? usageDoc.total : null }));
  }
}
async function months() {
  try { await monthsUpdate(); } catch (e) {}
  return (await docs.list("journal_months")).sort(function (a, b) { return String(b.month).localeCompare(String(a.month)); });
}

module.exports = { add, list, summary, prune, months, monthsUpdate, _mem: mem, _reset: function () { mem.length = 0; } };
