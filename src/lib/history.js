"use strict";
/* Historial de busquedas (sin gastar tokens al reabrirlas).

   Reglas de retencion (pensadas para que la memoria no crezca sin control):
   - Busquedas de productos ("candidates"): se guardan las 30 mas recientes.
     Una busqueda identica (misma palabra/categoria y mismos filtros) de menos
     de 24 h se sirve desde aqui (0 tokens). Pasadas 24 h se sigue pudiendo
     abrir, marcada como "antigua", y "Refrescar" la repite en Keepa.
   - Busquedas de proveedores ("suppliers", por ASIN o EAN): se guardan las
     200 mas recientes; validas 14 dias. Al abrir la ficha de un producto ya
     buscado se ve el resultado guardado sin volver a gastar Apify.
   Se guarda solo lo que la interfaz necesita para pintar (sin historiales
   crudos de Keepa). */

const crypto = require("crypto");
const docs = require("./docstore");

const RULES = {
  candidates: { keep: 30, freshMs: 24 * 3600 * 1000 },
  suppliers: { keep: 200, freshMs: 14 * 24 * 3600 * 1000 }
};

function norm(s) {
  return String(s == null ? "" : s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();
}
function hash(s) {
  return crypto.createHash("sha1").update(String(s)).digest("hex").slice(0, 16);
}

/* Misma busqueda = misma consulta/categoria + mismos filtros + mismo orden. */
function candKey(body) {
  body = body || {};
  const f = body.filters || body.params || {};
  const parts = [
    norm(body.query || body.q), String(body.categoryId || body.category || "").trim(),
    String(body.sort || ""), String(body.limit || ""), body.includeDiscards ? "1" : "0",
    JSON.stringify(Object.keys(f).sort().map(function (k) { return [k, f[k]]; }))
  ];
  return "c_" + hash(parts.join("|"));
}
function supKey(body) {
  body = body || {};
  const asin = String(body.asin || "").trim().toUpperCase();
  if (asin) return "a_" + asin;
  const ean = String(body.ean || "").replace(/\D/g, "");
  if (ean) return "e_" + ean;
  return "";
}

/* Candidato sin los campos pesados que la interfaz no usa. */
function slimCandidate(c) {
  const o = Object.assign({}, c);
  delete o.categoryTree;
  if (o.ficha) {
    o.ficha = { eans: o.ficha.eans, model: o.ficha.model, partNumber: o.ficha.partNumber, manufacturer: o.ficha.manufacturer, color: o.ficha.color, size: o.ficha.size };
  }
  return o;
}

async function prune(kind) {
  const rule = RULES[kind];
  const list = await docs.list("hist_" + kind);
  if (list.length <= rule.keep) return 0;
  list.sort(function (a, b) { return String(b.savedAt).localeCompare(String(a.savedAt)); });
  const drop = list.slice(rule.keep);
  for (let i = 0; i < drop.length; i++) await docs.del("hist_" + kind, drop[i].id);
  return drop.length;
}

async function save(kind, id, meta, data) {
  if (!RULES[kind] || !id) return null;
  const doc = Object.assign({ id: id, kind: kind, savedAt: new Date().toISOString() }, meta || {}, { data: data });
  await docs.put("hist_" + kind, id, doc);
  try { await prune(kind); } catch (e) {}
  return doc;
}

async function get(kind, id) {
  if (!RULES[kind] || !id) return null;
  const d = await docs.get("hist_" + kind, id);
  if (!d) return null;
  const age = Date.now() - Date.parse(d.savedAt || 0);
  return Object.assign({}, d, { ageMs: age, fresh: age <= RULES[kind].freshMs });
}

async function list(kind) {
  if (!RULES[kind]) return [];
  const all = await docs.list("hist_" + kind);
  return all.map(function (d) {
    const age = Date.now() - Date.parse(d.savedAt || 0);
    const out = Object.assign({}, d, { ageMs: age, fresh: age <= RULES[kind].freshMs });
    delete out.data;
    return out;
  }).sort(function (a, b) { return String(b.savedAt).localeCompare(String(a.savedAt)); });
}

async function del(kind, id) {
  if (!RULES[kind]) return false;
  return docs.del("hist_" + kind, id);
}

module.exports = { RULES, candKey, supKey, slimCandidate, save, get, list, del, prune };
