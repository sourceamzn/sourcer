"use strict";
/* Cobertura de una busqueda de proveedores: que fuentes se preguntaron, cuales
   respondieron, cuantos resultados se leyeron y cuantos sobrevivieron al filtro
   de identidad/tipo. Funcion pura: se calcula al final de la busqueda y viaja
   con el resultado del job para que el usuario sepa cuanto se cubrio de verdad. */

function pct(a, b) {
  return b > 0 ? Math.round((a / b) * 1000) / 10 : 0;
}

function reasonKind(entry) {
  const reason = String((entry && entry.reason) || "").toLowerCase();
  if (/tiempo|timeout|presupuesto/.test(reason)) return "timeout";
  if (/sin_|sin resultados|sin_coincidencias|empty|vacio/.test(reason)) return "empty";
  return "error";
}

function rejectKind(r) {
  const k = String((r && r.kind) || "").toLowerCase();
  if (k === "identidad" || k === "variante" || k === "modelo" || k === "marca" || k === "color") return "identity";
  if (k === "tipo") return "type";
  if (k === "menu" || k === "junk") return "junk";
  const s = String((r && r.reason) || "").toLowerCase();
  if (/ean|identidad|modelo|marca|color|variante/.test(s)) return "identity";
  if (/tipo de producto|mismo tipo|no es el mismo tipo/.test(s)) return "type";
  if (/menu|pagina legal|página legal/.test(s)) return "junk";
  return "other";
}

function buildCoverage(input) {
  input = input || {};
  const searched = Array.isArray(input.searched) ? input.searched : [];
  const rejected = Array.isArray(input.rejected) ? input.rejected : [];
  const matches = Array.isArray(input.matches) ? input.matches : [];
  const planned = Array.isArray(input.queries) ? input.queries : [];
  const identity = input.identity || {};

  const sources = { total: searched.length, responded: 0, empty: 0, error: 0, timeout: 0 };
  const byVia = {};
  let raw = 0;
  let kept = 0;

  searched.forEach(function (s) {
    if (s && s.ok) sources.responded++;
    else sources[reasonKind(s)]++;
    raw += Number((s && (s.rawCount != null ? s.rawCount : s.count)) || 0);
    kept += Number((s && s.count) || 0);
    ((s && s.queryStats) || []).forEach(function (q) {
      const via = String((q && q.via) || "otra");
      if (!byVia[via]) byVia[via] = { via: via, attempts: 0, raw: 0, kept: 0 };
      byVia[via].attempts += 1;
      byVia[via].raw += Number((q && q.raw) || 0);
      byVia[via].kept += Number((q && q.kept) || 0);
    });
  });

  const rejectedByKind = { identity: 0, type: 0, junk: 0, other: 0 };
  rejected.forEach(function (r) { rejectedByKind[rejectKind(r)]++; });

  const byState = {};
  matches.forEach(function (m) {
    const st = String((m && (m.state || m.match)) || "equivalente");
    byState[st] = (byState[st] || 0) + 1;
  });

  const has = {
    ean: Boolean(String(identity.ean || "").replace(/\D+/g, "")),
    brand: Boolean(String(identity.brand || "").trim()),
    model: Boolean(identity.models && identity.models.length)
  };
  const strength = has.ean ? "alta" : (has.brand && has.model ? "media" : ((has.brand || has.model) ? "baja" : "muy_baja"));
  const coveragePct = pct(sources.responded, sources.total);
  const note = sources.total
    ? ("Cobertura: " + sources.responded + "/" + sources.total + " fuentes con datos (" + coveragePct + " %). " +
       raw + " resultado(s) leido(s), " + kept + " tras el filtro de tipo, " +
       rejected.length + " descartado(s) por identidad/tipo. Identidad de origen: " + strength + ".")
    : "Sin fuentes consultadas.";

  return {
    sources: Object.assign({}, sources, { coveragePct: coveragePct }),
    results: {
      raw: raw, kept: kept, dropped: Math.max(0, raw - kept),
      rejected: rejected.length, matches: matches.length, byState: byState
    },
    rejected: rejectedByKind,
    queries: { planned: planned.length, used: Object.keys(byVia).length, byVia: Object.values(byVia) },
    identity: { hasEan: has.ean, hasBrand: has.brand, hasModel: has.model, strength: strength },
    note: note
  };
}

module.exports = { buildCoverage };
