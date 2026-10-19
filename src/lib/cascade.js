"use strict";
/* Mezcla de las dos fases de la cascada de identidad.
   Fase 1: EAN/UPC exacto. Fase 2: marca+modelo+titulo+specs (solo si la fase 1
   no dejo ninguna oferta verificada). Este modulo es puro para poder probarlo
   sin red: no conoce adaptadores ni Keepa. */

function matchKey(r) {
  r = r || {};
  const url = String(r.url || "").toLowerCase().replace(/[#?].*$/, "").replace(/\/+$/, "");
  if (url) return url;
  const ean = String(r.ean || "").replace(/\D+/g, "");
  if (ean) return "ean:" + ean + "|" + String(r.price || "");
  return String(r.name || "").toLowerCase() + "|" + String(r.price || "");
}

function dedupe(list, keyFn) {
  const seen = {};
  const out = [];
  (list || []).forEach(function (x) {
    if (!x) return;
    const k = keyFn ? keyFn(x) : matchKey(x);
    if (k && seen[k]) return;
    if (k) seen[k] = 1;
    out.push(x);
  });
  return out;
}

/* Una misma fuente puede aparecer en las dos fases. Se queda la entrada que
   trajo datos; si ambas trajeron, la de mas resultados. */
function mergeSearched(a, b) {
  const bySrc = {};
  const order = [];
  (a || []).concat(b || []).forEach(function (e) {
    if (!e || !e.source) return;
    const cur = bySrc[e.source];
    if (!cur) { bySrc[e.source] = e; order.push(e.source); return; }
    const ce = Number(cur.count) || 0, ne = Number(e.count) || 0;
    if (ne > ce || (ne === ce && !cur.ok && e.ok)) bySrc[e.source] = e;
    if (e.phase && !bySrc[e.source].phase) bySrc[e.source].phase = e.phase;
  });
  return order.map(function (k) { return bySrc[k]; });
}

/* Precio ascendente; los que no traen precio (fichas de fabricante, monedas
   distintas) detras, por relevancia. */
function sortMatches(list) {
  return (list || []).slice().sort(function (x, y) {
    const px = x.price > 0, py = y.price > 0;
    if (px && py) return x.price - y.price;
    if (px) return -1;
    if (py) return 1;
    return (y.rel || 0) - (x.rel || 0);
  });
}

/* Primero gana la fase 1: si el mismo producto ya entro por EAN exacto, no se
   sustituye por la version de la fase 2. */
function mergeMatches(a, b) {
  const list = dedupe((a || []).concat(b || []));
  list.forEach(function (r) {
    if (!r.matchBasis && r.matchBand === "verificado") r.matchBasis = "marca+modelo";
  });
  return sortMatches(list);
}

function summarize(sum, phase1, phase2) {
  const base = Object.assign({
    exact: 0, raw: 0, withEan: 0, differentEan: 0, noEan: 0,
    sourcesWithEan: 0, sourcesNoEan: 0
  }, sum || {});
  base.phase1 = phase1 || 0;
  base.phase2 = phase2 || 0;
  base.cascade = true;
  return base;
}

module.exports = { matchKey, dedupe, mergeSearched, mergeMatches, sortMatches, summarize };
