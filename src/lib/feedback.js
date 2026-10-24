"use strict";
/* «Esto esta mal»: correcciones del usuario y lo que la herramienta aprende.

   Cada correccion:
   1. queda en el diario (para la auditoria semanal);
   2. se convierte en una regla fija cuando se puede (esa web es una tienda,
      ese EAN no es ese ASIN, ese proveedor no vende esa marca...);
   3. si corrige a la IA, se guarda como ejemplo y se le ensena en las
      siguientes consultas del mismo tipo.
   Todo se puede deshacer (DELETE /feedback/:id). */

const crypto = require("crypto");
const docs = require("./docstore");
const learn = require("./learn");
const journal = require("./journal");

const COLL = "feedback", EX = "ai_examples", BAD = "badmatch", BADOFF = "badoffer", WINS = "wins";
function urlKey(u) {
  try { const x = new URL(String(u)); return (x.hostname.replace(/^www\./, "") + x.pathname.replace(/\/+$/, "")).toLowerCase(); } catch (e) { return String(u || "").toLowerCase().slice(0, 300); }
}
/* Quita de una lista de ofertas las que el usuario marco como otro producto. */
async function filterOffers(productKeys, matches) {
  const keys = (productKeys || []).filter(Boolean);
  if (!keys.length || !(matches || []).length) return { matches: matches || [], removed: 0 };
  const bad = {};
  for (const k of keys) { const d = await docs.get(BADOFF, String(k)); (d && d.urls || []).forEach(function (u) { bad[u] = 1; }); }
  if (!Object.keys(bad).length) return { matches: matches, removed: 0 };
  const out = matches.filter(function (m) { return !(m && m.url && bad[urlKey(m.url)]); });
  return { matches: out, removed: matches.length - out.length };
}

const REASONS = {
  lead: { es_tienda: "Es una tienda, no un proveedor", es_fabricante: "Es el fabricante", es_distribuidor: "Es distribuidor oficial", es_mayorista: "Es mayorista", no_vende_marca: "No vende esta marca", no_es_proveedor: "No es proveedor (ocultar siempre)", otro: "Otro" },
  producto: { veredicto_mal: "El veredicto está mal", marca_propia: "Es marca propia / un solo vendedor", buybox_amazon: "La Buy Box es de Amazon o de la marca", precio_mal: "El precio de Amazon está mal", no_es_lo_buscado: "No es lo que buscaba", otro: "Otro" },
  tarifa: { no_es_el_mismo: "El EAN no es este producto de Amazon", precio_tarifa_mal: "El precio de la tarifa está mal leído", veredicto_mal: "El veredicto está mal", pack_mal: "El pack / unidades está mal", otro: "Otro" },
  ia_respuesta: { tipo_mal: "La IA entendió mal la respuesta", resumen_mal: "El resumen está mal", otro: "Otro" },
  oferta: { no_es_el_mismo: "No es el mismo producto", precio_mal: "El precio está mal leído", no_disponible: "No está disponible / enlace roto", otro: "Otro" },
  /* Lo que sale bien tambien ensena. */
  acierto: { buena_oportunidad: "Buena oportunidad", comprado: "Lo he comprado", proveedor_bueno: "Buen proveedor", tarifa_buena: "Tarifa útil", oferta_buena: "Oferta correcta" },
  /* Lo que la herramienta no encontro y encontraste tu. */
  manual: { encontrado_a_mano: "Proveedor que encontré yo" }
};
const ROLE_OF = { es_tienda: "minorista", es_fabricante: "fabricante", es_distribuidor: "distribuidor_oficial", es_mayorista: "mayorista" };

/* Foto de lo que se veia al corregir (para auditar), con tope de tamano. */
function ctxOf(c) {
  if (!c || typeof c !== "object") return null;
  try { const j = JSON.stringify(c); return j.length <= 4000 ? JSON.parse(j) : { recortado: j.slice(0, 4000) }; } catch (e) { return null; }
}
function s(v, n) { return v == null ? "" : String(v).trim().slice(0, n || 200); }

async function create(input) {
  input = input || {};
  const type = s(input.type, 20), reason = s(input.reason, 40);
  if (!REASONS[type] || !REASONS[type][reason]) return { ok: false, reason: "motivo_no_valido" };
  const t = input.target || {};
  const target = { asin: s(t.asin, 20).toUpperCase(), ean: s(t.ean, 20), host: learn.hostOf(t.host || t.url || ""), url: s(t.url, 300), title: s(t.title, 200), brand: s(t.brand, 80), query: s(t.query, 120), snippet: s(t.snippet, 400), runId: s(t.runId, 60), contactId: s(t.contactId, 200) };
  const fb = { id: "fb" + Date.now().toString(36) + crypto.randomBytes(3).toString("hex"), at: new Date().toISOString(), type: type, reason: reason, label: REASONS[type][reason], target: target, correct: s(input.correct, 40), note: s(input.note, 300), context: ctxOf(input.context), effects: [] };
  /* Reglas fijas */
  if (type === "lead" && target.host) {
    if (ROLE_OF[reason]) { const r = await learn.setRole(target.host, ROLE_OF[reason]); fb.effects.push({ kind: "role", host: target.host, prev: r && r.prev }); }
    if (reason === "no_vende_marca" && target.brand) { await learn.notBrand(target.host, target.brand); fb.effects.push({ kind: "notBrand", host: target.host, brand: target.brand }); }
    if (reason === "no_es_proveedor") { await learn.block(target.host, { title: target.title, url: target.url }); fb.effects.push({ kind: "block", host: target.host }); }
    if (ROLE_OF[reason]) await example(fb, "proveedores_clasificar", { web: target.host, titulo: target.title, fragmento: target.snippet, rol_correcto: ROLE_OF[reason] });
  }
  if (type === "oferta" && reason === "no_es_el_mismo" && target.url && (target.asin || target.ean)) {
    const k = target.asin || target.ean, u = urlKey(target.url);
    const d = (await docs.get(BADOFF, k)) || { key: k, urls: [] };
    if (d.urls.indexOf(u) === -1) d.urls.push(u);
    await docs.put(BADOFF, k, d);
    fb.effects.push({ kind: "badoffer", key: k, url: u });
  }
  if (type === "manual" && target.host) {
    await learn.manualFound(target.host, target.brand, target.title, target.url);
    fb.effects.push({ kind: "manual", host: target.host, brand: target.brand });
  }
  if (type === "acierto") {
    if (reason === "proveedor_bueno" && target.host) { await learn.goodMark(target.host, true); fb.effects.push({ kind: "good", host: target.host }); }
    if ((reason === "comprado" || reason === "buena_oportunidad") && (target.asin || target.ean)) {
      await docs.put(WINS, fb.id, { id: fb.id, at: fb.at, reason: reason, asin: target.asin, ean: target.ean, title: target.title, brand: target.brand, context: fb.context });
      fb.effects.push({ kind: "win" });
    }
  }
  if (type === "tarifa" && reason === "no_es_el_mismo" && target.ean && target.asin) {
    const d = (await docs.get(BAD, target.ean)) || { ean: target.ean, asins: [] };
    if (d.asins.indexOf(target.asin) === -1) d.asins.push(target.asin);
    await docs.put(BAD, target.ean, d);
    fb.effects.push({ kind: "badmatch", ean: target.ean, asin: target.asin });
  }
  if (type === "producto" && reason === "no_es_lo_buscado" && target.query && target.title) {
    await example(fb, "productos_titulos", { busqueda: target.query, titulo: target.title, descartar: true });
  }
  if (type === "ia_respuesta" && reason === "tipo_mal" && fb.correct) {
    await example(fb, "respuesta", { fragmento: target.snippet, tipo_correcto: fb.correct });
  }
  await docs.put(COLL, fb.id, fb);
  journal.add("feedback", { id: fb.id, type: type, reason: reason, target: target, correct: fb.correct, note: fb.note, context: fb.context });
  return { ok: true, feedback: fb };
}

async function example(fb, purpose, data) {
  await docs.put(EX, fb.id, { id: fb.id, purpose: purpose, data: data, at: fb.at });
  fb.effects.push({ kind: "example", purpose: purpose });
}

async function remove(id) {
  const fb = await docs.get(COLL, id);
  if (!fb) return { ok: false, reason: "no_encontrado" };
  for (const e of fb.effects || []) {
    try {
      if (e.kind === "role") await learn.setRole(e.host, e.prev || null);
      if (e.kind === "notBrand") await learn.notBrand(e.host, e.brand, true);
      if (e.kind === "block") await learn.unblock(e.host);
      if (e.kind === "badmatch") {
        const d = await docs.get(BAD, e.ean);
        if (d) { d.asins = d.asins.filter(function (a) { return a !== e.asin; }); if (d.asins.length) await docs.put(BAD, e.ean, d); else await docs.del(BAD, e.ean); }
      }
      if (e.kind === "example") await docs.del(EX, fb.id);
      if (e.kind === "badoffer") {
        const d = await docs.get(BADOFF, e.key);
        if (d) { d.urls = d.urls.filter(function (u) { return u !== e.url; }); if (d.urls.length) await docs.put(BADOFF, e.key, d); else await docs.del(BADOFF, e.key); }
      }
      if (e.kind === "manual") await learn.manualFound(e.host, e.brand, "", "", true);
      if (e.kind === "good") await learn.goodMark(e.host, false);
      if (e.kind === "win") await docs.del(WINS, fb.id);
    } catch (x) {}
  }
  await docs.del(COLL, id);
  journal.add("feedback_deshecho", { id: id, type: fb.type, reason: fb.reason });
  return { ok: true };
}

async function list() {
  return (await docs.list(COLL)).sort(function (a, b) { return String(b.at).localeCompare(String(a.at)); });
}

/* Ultimas correcciones para ensenarselas a la IA. */
async function examples(purpose, n) {
  const all = await docs.list(EX);
  return all.filter(function (x) { return x.purpose === purpose; }).sort(function (a, b) { return String(b.at).localeCompare(String(a.at)); }).slice(0, n || 8).map(function (x) { return x.data; });
}

/* EAN -> ASIN que el usuario dijo que no son ese producto. */
async function badMatches() {
  const out = {};
  (await docs.list(BAD)).forEach(function (d) { out[d.ean] = d.asins || []; });
  return out;
}

async function wins() { return (await docs.list(WINS)).sort(function (a, b) { return String(b.at).localeCompare(String(a.at)); }); }

module.exports = { REASONS, create, remove, list, examples, badMatches, filterOffers, urlKey, wins };
