"use strict";
/* Cascada de consultas para buscar al proveedor de un producto de Amazon.
   Antes, si habia EAN, se buscaba SOLO el EAN (y casi ninguna tienda lo indexa).
   Ahora se prueban varias formas, de la mas precisa a la mas amplia, y se
   anota con cual salio cada resultado. Funcion pura: sin red ni claves. */

const gtin = require("./gtin");

function clean(s) {
  return String(s == null ? "" : s).replace(/[()\[\]{},;:|\\"*®™]+/g, " ").replace(/\s+/g, " ").trim();
}
function fold(s) {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}
function contains(hay, needle) {
  const h = fold(hay), n = fold(needle);
  return Boolean(n) && h.indexOf(n) !== -1;
}
function words(s, n) {
  return clean(s).split(" ").filter(Boolean).slice(0, n).join(" ");
}

/* Une trozos sin repetir los que ya estan contenidos en lo anterior. */
function joinUnique(parts) {
  const out = [];
  parts.forEach(function (p) {
    p = clean(p);
    if (!p) return;
    if (!out.some(function (x) { return contains(x, p); })) out.push(p);
  });
  return out.join(" ").trim();
}

/* body: { ean, eans[], brand, model, partNumber, reference, name, title, query }
   opts: { maxQueries (def 4), maxLen (def 110) }
   Devuelve [{ via, q, intl }]. `intl:true` = solo para fuentes internacionales
   (el texto en ingles lo traduce el llamador porque necesita red). */
function buildQueries(body, opts) {
  body = body || {};
  opts = opts || {};
  const maxLen = opts.maxLen || 110;
  const maxQ = Math.max(1, opts.maxQueries || 4);
  const brand = clean(body.brand);
  const model = clean(body.model);
  const title = clean(body.name || body.title || body.query);
  const out = [];
  const seen = {};
  function add(via, q, intl) {
    q = clean(q).slice(0, maxLen).trim();
    if (!q) return;
    const k = fold(q).replace(/[^a-z0-9]+/g, "");
    if (!k || seen[k]) return;
    seen[k] = 1;
    out.push({ via: via, q: q, intl: Boolean(intl) });
  }

  /* (a) EAN: el mas exacto. Se usa el primero valido (los demas, si existen, tambien se prueban al final). */
  const eans = gtin.normalizeAll([].concat(body.ean || [], body.eans || []));
  /* Se busca el codigo tal como lo dio el origen (sin ceros anadidos) cuando es posible. */
  const rawEan = gtin.digitsOnly(body.ean);
  if (eans.length) add("ean", rawEan.length >= 8 ? rawEan : eans[0]);

  /* (b) marca + modelo */
  if (model) add("marca+modelo", joinUnique([brand, model]));

  /* (c) referencia / part number sola (y el modelo solo si no hay referencia) */
  const ref = clean(body.partNumber || body.reference || body.mpn);
  if (ref) add("referencia", ref);
  if (model && brand) add("modelo", model);

  /* (d) marca + titulo recortado */
  if (title) add(brand || model ? "marca+titulo" : "titulo", joinUnique([brand, words(title, 12)]));

  /* (e) titulo en ingles para fuentes internacionales (se rellena fuera) */
  if (title) out.push({ via: "titulo_en", q: "", intl: true, lazyEnglish: true });

  /* Otros EAN del mismo producto, si los hay, van tras lo anterior. */
  eans.slice(1).forEach(function (e) { add("ean_alt", e); });

  /* Sin ningun dato util: al menos la consulta cruda. */
  if (!out.length && clean(body.query)) add("titulo", body.query);

  /* El tope respeta el orden; el paso en ingles se conserva siempre si cabe. */
  return out.slice(0, maxQ);
}

module.exports = { buildQueries, joinUnique, clean };
