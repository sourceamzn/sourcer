"use strict";
/* Identidad de producto: extrae atributos que distinguen variantes (modelo,
   pack, medida, color, voltaje) de un texto y compara origen vs oferta.
   Nunca inventa: si el texto no dice un atributo, queda vacio (na). */

const COLORS = ["negro", "blanco", "rojo", "azul", "verde", "amarillo", "rosa", "gris", "naranja", "morado", "violeta", "lila", "marron", "beige", "dorado", "plateado", "turquesa", "celeste",
  "black", "white", "red", "blue", "green", "yellow", "pink", "grey", "gray", "orange", "purple", "brown", "gold", "silver"];
const COLOR_MAP = { black: "negro", white: "blanco", red: "rojo", blue: "azul", green: "verde", yellow: "amarillo", pink: "rosa", grey: "gris", gray: "gris", orange: "naranja", purple: "morado", brown: "marron", gold: "dorado", silver: "plateado" };

function norm(s) {
  return String(s == null ? "" : s).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9.,x+\- ]+/g, " ").replace(/\s+/g, " ").trim();
}

function quantityOf(t) {
  const s = norm(t);
  let m = s.match(/\b(?:pack|lote|set|juego)\s*(?:de|of)?\s*(\d{1,3})\b/) || s.match(/\b(\d{1,3})\s*(?:uds|ud|unidades|unidad|piezas|pieza|pcs|pack|packs|x)\b/);
  return m ? String(parseInt(m[1], 10)) : "";
}

/* Medidas: 30x20x10 cm, 500 ml, 1,5 kg ... -> lista normalizada "30x20x10cm", "500ml". */
function sizesOf(t) {
  const s = norm(t).replace(/(\d),(\d)/g, "$1.$2");
  const out = [];
  let m;
  const dim = /(\d+(?:\.\d+)?(?:\s*x\s*\d+(?:\.\d+)?){1,2})\s*(cm|mm|m)\b/g;
  while ((m = dim.exec(s))) out.push(m[1].replace(/\s+/g, "") + m[2]);
  const one = /(?<![\dx.])(\d+(?:\.\d+)?)\s*(cm|mm|ml|cl|l|litros|kg|g|gr|w|v|mah|pulgadas)\b/g;
  while ((m = one.exec(s))) {
    let u = m[2];
    if (u === "litros") u = "l";
    if (u === "gr") u = "g";
    out.push(String(parseFloat(m[1])) + u);
  }
  const talla = s.match(/\btalla\s*:?\s*([a-z0-9]{1,4})\b/);
  if (talla) out.push("talla" + talla[1]);
  return Array.from(new Set(out));
}

function colorOf(t) {
  const words = norm(t).split(" ");
  const found = [];
  words.forEach(function (w) {
    const c = COLOR_MAP[w] || (COLORS.indexOf(w) !== -1 ? w : null);
    if (c && found.indexOf(c) === -1) found.push(c);
  });
  return found.length === 1 ? found[0] : "";
}

/* Codigos de modelo: tokens mixtos letra+numero (HP8280, XM4, 1000XM4) o numeros largos. */
function modelsOf(t) {
  const out = [];
  String(t == null ? "" : t).split(/[\s/,;()]+/).forEach(function (raw) {
    const w = raw.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "");
    if (w.length < 3) return;
    if (/^\d+(cm|mm|ml|kg|g|w|v|l|mah)$/.test(w)) return; /* medidas, no modelos */
    if (/[a-z]/.test(w) && /\d/.test(w)) out.push(w);
  });
  return Array.from(new Set(out));
}

function identityOf(o) {
  o = o || {};
  const text = [o.brand, o.model, o.name || o.title].filter(Boolean).join(" ");
  const attrs = o.attrs || {};
  return {
    ean: String(o.ean || "").replace(/\D+/g, ""),
    brand: String(o.brand || attrs.brand || "").trim(),
    models: modelsOf((o.model ? o.model + " " : "") + String(o.name || o.title || "")),
    quantity: quantityOf(o.name || o.title),
    sizes: sizesOf(text),
    color: colorOf(o.name || o.title)
  };
}

/* Compara origen (Amazon) con oferta. Devuelve checks y veredicto. */
function compare(src, offer) {
  const checks = [];
  const conflicts = [];
  function add(key, label, a, b, state) {
    checks.push({ key: key, label: label, source: a || "—", offer: b || "—", state: state });
    if (state === "fail") conflicts.push(key);
  }
  const sEan = src.ean, oEan = String(offer.ean || "").replace(/\D+/g, "");
  let eanOk = false;
  if (sEan.length >= 8 && oEan.length >= 8) {
    if (oEan.indexOf(sEan) !== -1 || sEan.indexOf(oEan) !== -1) { eanOk = true; add("ean", "EAN/UPC", sEan, oEan, "ok"); }
    else add("ean", "EAN/UPC", sEan, oEan, "fail");
  } else add("ean", "EAN/UPC", sEan, oEan, "na");

  const oText = String(offer.name || "") + " " + String(offer.brand || "");
  const oNorm = norm(oText);
  if (src.brand) {
    const b = norm(src.brand);
    add("brand", "Marca", src.brand, offer.brand || "", b && oNorm.indexOf(b) !== -1 ? "ok" : (offer.brand ? "fail" : "na"));
  } else add("brand", "Marca", "", offer.brand || "", "na");

  const oModels = modelsOf(oText);
  if (src.models.length && oModels.length) {
    const hit = src.models.some(function (m) { return oModels.indexOf(m) !== -1; });
    add("model", "Modelo", src.models.join(", "), oModels.join(", "), hit ? "ok" : "fail");
  } else add("model", "Modelo", src.models.join(", "), oModels.join(", "), "na");

  const oQty = quantityOf(oText);
  if (src.quantity && oQty) add("quantity", "Pack/cantidad", src.quantity, oQty, src.quantity === oQty ? "ok" : "fail");
  else if (src.quantity && !oQty && src.quantity !== "1") add("quantity", "Pack/cantidad", src.quantity, "", "na");
  else if (!src.quantity && oQty && oQty !== "1") add("quantity", "Pack/cantidad", "", oQty, "na");
  else add("quantity", "Pack/cantidad", src.quantity, oQty, "na");

  const oSizes = sizesOf(oText);
  if (src.sizes.length && oSizes.length) {
    const common = src.sizes.filter(function (z) { return oSizes.indexOf(z) !== -1; });
    /* Mismo tipo de medida (misma unidad) con valores distintos = conflicto. */
    const unit = function (z) { return z.replace(/^[\dx.]+/, ""); };
    const sameUnitDiff = src.sizes.some(function (z) {
      return oSizes.some(function (y) { return unit(z) === unit(y) && z !== y; }) && !oSizes.some(function (y) { return y === z; });
    });
    add("size", "Medida/talla", src.sizes.join(", "), oSizes.join(", "), common.length && !sameUnitDiff ? "ok" : (sameUnitDiff ? "fail" : "na"));
  } else add("size", "Medida/talla", src.sizes.join(", "), oSizes.join(", "), "na");

  const oColor = colorOf(oText);
  if (src.color && oColor) add("color", "Color", src.color, oColor, src.color === oColor ? "ok" : "fail");
  else add("color", "Color", src.color, oColor, "na");

  /* Veredicto */
  let verdict, reason;
  if (conflicts.indexOf("ean") !== -1) { verdict = "distinto"; reason = "EAN distinto: es otro producto."; }
  else if (conflicts.length) {
    verdict = "variante";
    reason = "Difiere en " + checks.filter(function (c) { return c.state === "fail"; }).map(function (c) { return c.label.toLowerCase(); }).join(", ") + ": no es el mismo producto.";
  } else if (eanOk) { verdict = "exacto"; reason = "EAN/UPC coincide y no hay conflicto de atributos."; }
  else {
    const okKeys = checks.filter(function (c) { return c.state === "ok"; }).map(function (c) { return c.key; });
    if (okKeys.indexOf("brand") !== -1 && okKeys.indexOf("model") !== -1) { verdict = "probable"; reason = "Marca y modelo coinciden pero sin EAN: confirmar antes de comprar."; }
    else { verdict = "equivalente"; reason = "Sin EAN ni marca+modelo coincidentes: producto parecido, no verificado."; }
  }
  return { verdict: verdict, reason: reason, checks: checks, conflicts: conflicts, eanOk: eanOk };
}

/* Ficha congelada: copia inmutable de lo que Amazon dice del producto. */
function freezeCard(id, body) {
  const card = Object.assign({}, id, {
    asin: String((body && body.asin) || "").toUpperCase(),
    image: String((body && (body.image || body.img)) || "")
  });
  card.models = Object.freeze((card.models || []).slice());
  card.sizes = Object.freeze((card.sizes || []).slice());
  return Object.freeze(card);
}

/* Estado visible: verificado (EAN, o marca+modelo coincidentes sin conflicto),
   candidato (parecido, a revisar con foto). El resto ya se descarta antes. */
function stateOf(rec, cmp) {
  if (!cmp || cmp.conflicts.length) return "candidato";
  if (cmp.eanOk) return "verificado";
  const ok = {};
  (cmp.checks || []).forEach(function (c) { if (c.state === "ok") ok[c.key] = 1; });
  if (ok.model && ok.brand && !rec.review) return "verificado";
  return "candidato";
}

module.exports = { freezeCard, stateOf, identityOf, compare, modelsOf, sizesOf, quantityOf, colorOf };
