"use strict";
/* Cache persistente compartida (Keepa, SP-API, buscador).

   - Nivel 1: memoria del proceso (rapido, se pierde al reiniciar).
   - Nivel 2: tabla Postgres `kv_cache` (sobrevive reinicios y despliegues).
     Valores comprimidos con gzip: una ficha de Keepa de 40 KB ocupa ~5 KB.
   Sin DATABASE_URL solo funciona el nivel 1.

   Cada clave lleva un espacio de nombres (`ns`) y una caducidad. Se borra
   lo caducado cada hora y, si la tabla pasa del tope, lo mas antiguo.
   El dia que haya varios usuarios, esta misma cache evita pagar dos veces
   el mismo EAN aunque lo busquen personas distintas. */

const zlib = require("zlib");
const { config } = require("../config");

const L1_MAX = 4000;
const L2_MAX_ROWS = Math.max(1000, parseInt(process.env.CACHE_MAX_ROWS || "60000", 10) || 60000);
const l1 = new Map();
const stats = { hits1: 0, hits2: 0, misses: 0, sets: 0, errors: 0, byNs: {} };

let pool = null, ready = null, disabled = false, pruneTimer = null;

function ns(n) { return (stats.byNs[n] = stats.byNs[n] || { hits: 0, misses: 0, sets: 0 }); }
function fullKey(n, k) { return n + ":" + String(k); }

function db() {
  if (disabled) return null;
  if (pool) return pool;
  if (!config.databaseUrl) return null;
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
    ready = p.query("CREATE TABLE IF NOT EXISTS kv_cache (k TEXT PRIMARY KEY, v BYTEA NOT NULL, exp TIMESTAMPTZ NOT NULL, at TIMESTAMPTZ NOT NULL DEFAULT now())")
      .then(function () { return p.query("CREATE INDEX IF NOT EXISTS kv_cache_exp ON kv_cache (exp)"); })
      .then(function () { schedulePrune(); return true; })
      .catch(function () { stats.errors++; ready = null; return false; });
  }
  return ready;
}

function l1Get(k) {
  const hit = l1.get(k);
  if (!hit) return undefined;
  if (hit.exp < Date.now()) { l1.delete(k); return undefined; }
  return hit.v;
}
function l1Set(k, v, exp) {
  if (l1.has(k)) l1.delete(k);
  else if (l1.size >= L1_MAX) l1.delete(l1.keys().next().value);
  l1.set(k, { v: v, exp: exp });
}

async function get(n, k) {
  const key = fullKey(n, k);
  const v1 = l1Get(key);
  if (v1 !== undefined) { stats.hits1++; ns(n).hits++; return v1; }
  if (await init()) {
    try {
      const r = await pool.query("SELECT v, exp FROM kv_cache WHERE k=$1 AND exp > now()", [key]);
      if (r.rows[0]) {
        const v = JSON.parse(zlib.gunzipSync(r.rows[0].v).toString("utf8"));
        l1Set(key, v, new Date(r.rows[0].exp).getTime());
        stats.hits2++; ns(n).hits++;
        return v;
      }
    } catch (e) { stats.errors++; }
  }
  stats.misses++; ns(n).misses++;
  return null;
}

/* Varias claves del mismo espacio en una sola consulta. Devuelve { clave: valor }. */
async function getMany(n, keys) {
  const out = {};
  const need = [];
  (keys || []).forEach(function (k) {
    const v = l1Get(fullKey(n, k));
    if (v !== undefined) { out[k] = v; stats.hits1++; ns(n).hits++; } else need.push(k);
  });
  if (need.length && (await init())) {
    try {
      const r = await pool.query("SELECT k, v, exp FROM kv_cache WHERE k = ANY($1) AND exp > now()", [need.map(function (k) { return fullKey(n, k); })]);
      r.rows.forEach(function (row) {
        const k = row.k.slice(n.length + 1);
        try {
          const v = JSON.parse(zlib.gunzipSync(row.v).toString("utf8"));
          out[k] = v;
          l1Set(row.k, v, new Date(row.exp).getTime());
          stats.hits2++; ns(n).hits++;
        } catch (e) { stats.errors++; }
      });
    } catch (e) { stats.errors++; }
  }
  need.forEach(function (k) { if (!(k in out)) { stats.misses++; ns(n).misses++; } });
  return out;
}

async function set(n, k, v, ttlMs) {
  if (v === undefined || !(ttlMs > 0)) return;
  const key = fullKey(n, k);
  const exp = Date.now() + ttlMs;
  l1Set(key, v, exp);
  stats.sets++; ns(n).sets++;
  if (await init()) {
    try {
      const buf = zlib.gzipSync(Buffer.from(JSON.stringify(v), "utf8"));
      await pool.query("INSERT INTO kv_cache (k, v, exp, at) VALUES ($1,$2,$3,now()) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v, exp=EXCLUDED.exp, at=now()", [key, buf, new Date(exp)]);
    } catch (e) { stats.errors++; }
  }
}

async function del(n, k) {
  const key = fullKey(n, k);
  l1.delete(key);
  if (await init()) { try { await pool.query("DELETE FROM kv_cache WHERE k=$1", [key]); } catch (e) { stats.errors++; } }
}

/* Vacia un espacio de nombres entero (o todo). */
async function clear(n) {
  Array.from(l1.keys()).forEach(function (k) { if (!n || k.indexOf(n + ":") === 0) l1.delete(k); });
  if (await init()) {
    try {
      if (n) await pool.query("DELETE FROM kv_cache WHERE k LIKE $1", [n.replace(/[%_]/g, "") + ":%"]);
      else await pool.query("DELETE FROM kv_cache");
    } catch (e) { stats.errors++; }
  }
}

async function prune() {
  if (!(await init())) return;
  try {
    await pool.query("DELETE FROM kv_cache WHERE exp <= now()");
    const c = await pool.query("SELECT count(*)::int AS n FROM kv_cache");
    const extra = (c.rows[0] && c.rows[0].n) - L2_MAX_ROWS;
    if (extra > 0) await pool.query("DELETE FROM kv_cache WHERE k IN (SELECT k FROM kv_cache ORDER BY at ASC LIMIT $1)", [extra]);
  } catch (e) { stats.errors++; }
}
function schedulePrune() {
  if (pruneTimer) return;
  pruneTimer = setInterval(function () { prune().catch(function () {}); }, 3600000);
  if (pruneTimer.unref) pruneTimer.unref();
}

async function snapshot() {
  const out = { mode: config.databaseUrl && !disabled ? "memoria+postgres" : "memoria", l1: l1.size, hits1: stats.hits1, hits2: stats.hits2, misses: stats.misses, sets: stats.sets, errors: stats.errors, byNs: stats.byNs };
  if (pool && ready) {
    try { const r = await pool.query("SELECT count(*)::int AS n, coalesce(sum(length(v)),0)::bigint AS bytes FROM kv_cache WHERE exp > now()"); out.rows = r.rows[0].n; out.mb = Math.round(Number(r.rows[0].bytes) / 1048576 * 10) / 10; } catch (e) {}
  }
  const tot = stats.hits1 + stats.hits2 + stats.misses;
  out.hitRate = tot ? Math.round(((stats.hits1 + stats.hits2) / tot) * 100) : null;
  return out;
}

/* Tamano de la base de datos (para el panel de APIs). */
async function dbInfo() {
  if (!(await init())) return null;
  try { const r = await pool.query("SELECT pg_database_size(current_database())::bigint AS b"); return { mb: Math.round(Number(r.rows[0].b) / 1048576) }; } catch (e) { return null; }
}

const HOUR = 3600000, DAY = 24 * HOUR;
module.exports = { get, getMany, set, del, clear, prune, snapshot, dbInfo, HOUR, DAY, _reset: function () { l1.clear(); Object.keys(stats.byNs).forEach(function (k) { delete stats.byNs[k]; }); } };
