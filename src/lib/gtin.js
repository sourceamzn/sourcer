"use strict";
/* Normalizacion y comparacion de codigos de barras (EAN-8, UPC-A de 12, EAN-13, GTIN-14).
   Se compara SIEMPRE el codigo completo normalizado a 13 digitos: nunca por
   subcadena (un EAN corto contenido en otro largo daba falsos positivos). */

function digitsOnly(v) {
  return String(v == null ? "" : v).replace(/\D+/g, "");
}

/* Devuelve el codigo canonico (13 digitos) o "" si no parece un codigo valido.
   GTIN-14 con indicador distinto de 0 (caja/pack) se conserva en 14: es otro articulo. */
function normalize(v) {
  const d = digitsOnly(v);
  if (d.length === 8 || d.length === 12 || d.length === 13) return d.padStart(13, "0");
  if (d.length === 14) return d[0] === "0" ? d.slice(1) : d;
  return "";
}

/* Todos los codigos distintos y validos de una lista (o de un valor suelto). */
function normalizeAll(list) {
  const arr = Array.isArray(list) ? list : [list];
  const out = [];
  arr.forEach(function (x) {
    const n = normalize(x);
    if (n && out.indexOf(n) === -1) out.push(n);
  });
  return out;
}

function same(a, b) {
  const x = normalize(a), y = normalize(b);
  return Boolean(x && y && x === y);
}

/* Hay algun codigo en comun entre dos conjuntos. */
function intersects(listA, listB) {
  const a = normalizeAll(listA), b = normalizeAll(listB);
  return a.some(function (x) { return b.indexOf(x) !== -1; });
}

module.exports = { normalize, normalizeAll, same, intersects, digitsOnly };
