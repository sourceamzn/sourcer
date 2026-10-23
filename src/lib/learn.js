"use strict";
/* Aprendizaje con el uso (fase 1).

   La app no reentrena ningun modelo: recuerda lo que pasa y lo usa en la
   siguiente busqueda. Todo se deriva del ESTADO ACTUAL de cada contacto (no
   de contadores que se suman), asi deshacer un cambio deshace tambien lo
   aprendido y nunca se cuenta dos veces lo mismo.

   Coleccion `learn_domains` (id = dominio):
     { host, title, role, status, saved, replied, tariff, rejected, discarded,
       blocked, marginHits, brands[], score, updatedAt }

   - Reputacion de webs: guardada / responde / manda tarifa / tarifa con
     margen suben; rechazo / quitada / bloqueada bajan.
   - Marca -> distribuidor: las marcas de los productos guardados con cada
     contacto (y las de los productos con margen de sus tarifas).
   - Webs bloqueadas («No es proveedor»): no vuelven a salir.
   Cada dato se puede ver y olvidar desde la pantalla «Aprendizaje». */

const docs = require("./docstore");
const COLL = "learn_domains";

function norm(s) {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}
function hostOf(h) { return String(h || "").toLowerCase().replace(/^https?:\/\//, "").replace(/^www\d?\./, "").split("/")[0]; }

function scoreOf(d) {
  if (!d) return 0;
  let s = 0;
  if (d.saved) s += 5;
  if (d.replied) s += 15;
  if (d.tariff) s += 25;
  s += Math.min(d.marginHits || 0, 20) * 2;
  if (d.rejected) s -= 30;
  if (d.discarded) s -= 10;
  if (d.blocked) s -= 100;
  return s;
}

async function getDomain(host) { return docs.get(COLL, hostOf(host)); }
async function putDomain(d) {
  d.score = scoreOf(d);
  d.updatedAt = new Date().toISOString();
  await docs.put(COLL, d.host, d);
  return d;
}

/* Recalcula lo aprendido de un contacto a partir de su estado actual. */
async function syncContact(c) {
  try {
    if (!c || !(c.host || c.id)) return null;
    const host = hostOf(c.host || c.id);
    const d = (await getDomain(host)) || { host: host, marginHits: 0, marginBrands: [] };
    const st = String(c.status || "");
    d.title = c.company || c.title || d.title || host;
    d.url = c.url || d.url || ("https://" + host);
    d.role = c.role || d.role || "";
    d.status = st;
    d.saved = true;
    d.discarded = false;
    d.replied = ["respondido", "negociando", "tarifa"].indexOf(st) !== -1;
    d.tariff = st === "tarifa" || ((c.attachments || []).length > 0);
    d.rejected = ["rechazado", "descartado"].indexOf(st) !== -1;
    const brands = {};
    (c.products || []).forEach(function (p) { if (p && p.brand && norm(p.brand)) brands[norm(p.brand)] = p.brand; });
    (d.marginBrands || []).forEach(function (b) { if (norm(b)) brands[norm(b)] = brands[norm(b)] || b; });
    d.brands = Object.keys(brands).map(function (k) { return brands[k]; }).slice(0, 60);
    return await putDomain(d);
  } catch (e) { return null; }
}

/* El contacto se quita de la lista: senal negativa suave (puede ser limpieza). */
async function contactRemoved(host) {
  try {
    const d = await getDomain(host);
    if (!d) return null;
    d.saved = false; d.discarded = true;
    return await putDomain(d);
  } catch (e) { return null; }
}

/* Un cruce de tarifa de este proveedor ha dado productos con margen. */
async function tariffResult(host, rows) {
  try {
    if (!host) return null;
    host = hostOf(host);
    const good = (rows || []).filter(function (r) { return r.verdict === "oportunidad" || r.verdict === "revisar" || r.verdict === "justo"; });
    const d = (await getDomain(host)) || { host: host, title: host, saved: false };
    d.marginHits = good.length;
    const bs = {};
    good.forEach(function (r) { const b = r.amzBrand || r.brand; if (b && norm(b)) bs[norm(b)] = b; });
    d.marginBrands = Object.keys(bs).map(function (k) { return bs[k]; }).slice(0, 60);
    d.tariff = true;
    const all = {};
    (d.brands || []).concat(d.marginBrands).forEach(function (b) { if (norm(b)) all[norm(b)] = b; });
    d.brands = Object.keys(all).map(function (k) { return all[k]; }).slice(0, 60);
    return await putDomain(d);
  } catch (e) { return null; }
}

async function block(host, info) {
  host = hostOf(host);
  if (!host) return null;
  const d = (await getDomain(host)) || { host: host, title: (info && info.title) || host, url: (info && info.url) || ("https://" + host) };
  d.blocked = true;
  d.blockedAt = new Date().toISOString();
  return putDomain(d);
}
async function unblock(host) {
  const d = await getDomain(host);
  if (!d) return null;
  d.blocked = false;
  return putDomain(d);
}
async function forget(host) { return docs.del(COLL, hostOf(host)); }
async function forgetBrand(host, brand) {
  const d = await getDomain(host);
  if (!d) return null;
  const n = norm(brand);
  d.brands = (d.brands || []).filter(function (b) { return norm(b) !== n; });
  d.marginBrands = (d.marginBrands || []).filter(function (b) { return norm(b) !== n; });
  d.forgotBrands = (d.forgotBrands || []).concat([n]).slice(-100);
  return putDomain(d);
}

async function all() { return (await docs.list(COLL)).map(function (d) { d.score = scoreOf(d); return d; }); }

/* Lo que necesita una busqueda de proveedores para una o varias marcas. */
async function forSearch(brandList) {
  const list = await all();
  const want = {};
  (brandList || []).forEach(function (b) { if (norm(b)) want[norm(b)] = 1; });
  const byHost = {}, blocked = {}, known = [];
  list.forEach(function (d) {
    byHost[d.host] = d;
    if (d.blocked) blocked[d.host] = 1;
    if (d.blocked || d.rejected) return;
    const hit = (d.brands || []).filter(function (b) { return want[norm(b)] && (d.forgotBrands || []).indexOf(norm(b)) === -1; });
    if (hit.length && d.score > 0) known.push({ d: d, brand: hit[0] });
  });
  known.sort(function (a, b) { return b.d.score - a.d.score; });
  return { byHost: byHost, blocked: blocked, known: known.slice(0, 5) };
}

function whyText(d, brand) {
  const parts = [];
  if (d.tariff) parts.push(d.marginHits ? ("su tarifa tiene " + d.marginHits + " producto(s) con margen") : "te mandó tarifa");
  else if (d.replied) parts.push("te respondió");
  else if (d.saved) parts.push("lo guardaste");
  if (brand) parts.unshift("ya lo usaste para " + brand);
  return parts.join(" · ");
}

/* Aplica lo aprendido a la lista de pistas de una busqueda de proveedores:
   - quita las webs bloqueadas (quedan aparte, por si quieres verlas),
   - sube/baja la puntuacion segun la reputacion,
   - anade arriba los distribuidores ya conocidos de esa marca aunque Google
     no los haya devuelto. */
function apply(leads, learned, leadsLib) {
  const out = [], hidden = [];
  const seen = {};
  (leads || []).forEach(function (l) {
    const h = hostOf(l.host || l.url);
    const d = learned.byHost[h];
    if (learned.blocked[h]) { hidden.push(l); return; }
    if (d) {
      l.score = (l.score || 0) + d.score;
      l.learned = { score: d.score, why: whyText(d, ""), status: d.status || "" };
      if (d.rejected) l.learned.why = "te dijo que no";
    }
    seen[h] = 1;
    out.push(l);
  });
  learned.known.forEach(function (k) {
    const d = k.d;
    const ex = out.filter(function (l) { return hostOf(l.host || l.url) === d.host; })[0];
    const why = whyText(d, k.brand);
    if (ex) { ex.learned = { score: d.score, why: why, known: true, status: d.status || "" }; ex.score += 50; return; }
    out.unshift({
      host: d.host, url: d.url || ("https://" + d.host), title: d.title || d.host,
      role: d.role || "distribuidor_oficial", roleLabel: (leadsLib && leadsLib.ROLE_LABEL[d.role]) || "Distribuidor conocido",
      score: 300 + d.score, signals: [], snippet: "",
      learned: { score: d.score, why: why, known: true, status: d.status || "" }
    });
  });
  return { leads: out, hidden: hidden };
}

module.exports = { syncContact, contactRemoved, tariffResult, block, unblock, forget, forgetBrand, all, forSearch, apply, scoreOf, norm, hostOf };
