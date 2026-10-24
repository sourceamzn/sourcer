"use strict";
/* Contabilidad y cache de Keepa.
   - Cada respuesta de Keepa trae tokensConsumed / tokensLeft / refillIn /
     refillRate: se acumulan por endpoint para ver en /health que gasta mas.
   - Cache por ASIN (y por variante: con/sin buybox, con/sin offers) para no
     pagar dos veces la misma ficha en pocas horas (buscar -> abrir ficha ->
     buscar proveedores pedian el mismo ASIN 3 veces).
   Coste de referencia (docs Keepa): producto 1 token; buybox +2 por producto;
   offers +6 por cada pagina de 10 ofertas; search 10 por pagina; finder
   ~10 + 1 por cada 100 ASIN; bestsellers 50; seller 1. */

const events = require("./events");

const usage = { requests: 0, consumed: 0, cacheHits: 0, byPath: {}, tokensLeft: null, refillRate: null, refillInMs: null, at: null };

function note(path, data) {
  usage.requests += 1;
  const c = Number(data && data.tokensConsumed) || 0;
  usage.consumed += c;
  const p = usage.byPath[path] = usage.byPath[path] || { requests: 0, consumed: 0 };
  p.requests += 1;
  p.consumed += c;
  if (data && data.tokensLeft != null) usage.tokensLeft = Number(data.tokensLeft);
  if (data && data.refillRate != null) usage.refillRate = Number(data.refillRate);
  if (data && data.refillIn != null) usage.refillInMs = Number(data.refillIn);
  usage.at = new Date().toISOString();
  try { require("./usage").add("keepa", { tokens: c, requests: 1 }); } catch (e) {}
  try { events.add("keepa_cost", { path: path, consumed: c, left: usage.tokensLeft }); } catch (e) {}
}

function ttlMs() {
  const m = parseInt(process.env.KEEPA_CACHE_MIN || "360", 10);
  return (isFinite(m) && m >= 0 ? m : 360) * 60000;
}
const MAX = 3000;
const cache = new Map();
/* variant: "b" (con buybox), "p" (sin buybox), "o20" (con 20 ofertas)... Una
   ficha con buybox sirve tambien a quien la pide sin buybox. */
function get(asin, variant) {
  const ttl = ttlMs();
  if (!ttl) return null;
  const keys = variant === "p" ? [asin + "|b", asin + "|p"] : [asin + "|" + variant];
  for (let i = 0; i < keys.length; i++) {
    const hit = cache.get(keys[i]);
    if (hit && Date.now() - hit.t <= ttl) { usage.cacheHits += 1; return hit.v; }
    if (hit) cache.delete(keys[i]);
  }
  return null;
}
function set(asin, variant, prod) {
  if (!ttlMs() || !asin || !prod) return;
  if (cache.size >= MAX) cache.delete(cache.keys().next().value);
  cache.set(asin + "|" + variant, { t: Date.now(), v: prod });
}
/* Cuantos tokens se pueden gastar ahora sin vaciar la cuenta (reserva para
   abrir fichas y buscar proveedores). null = desconocido. */
function budget(reserve) {
  if (usage.tokensLeft == null) return null;
  return Math.max(0, usage.tokensLeft - (reserve == null ? 30 : reserve));
}
function snapshot() {
  return Object.assign({}, usage, { cacheSize: cache.size, cacheMin: Math.round(ttlMs() / 60000) });
}

module.exports = { note, get, set, budget, snapshot, usage, ttlMs };
