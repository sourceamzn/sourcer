"use strict";
/* Fase 4 Â· puntuacion de coincidencia 0-100 (origen Amazon vs oferta).
   Sustituye la cadena de puertas binarias de la Fase 2: una oferta ya no se
   descarta por "no nombra la marca" o "dice otro color". Solo hay conflicto
   fuerte (descarte) cuando AMBOS lados dan el dato y no coincide:
     - EAN/UPC completo distinto
     - pack/cantidad distinta
     - codigo de modelo distinto
   El resto de diferencias restan puntos y dejan la oferta en "revisar".
   Regla de seguridad: "verificado" exige EAN exacto o marca+modelo sin
   conflicto; la puntuacion sola nunca asciende a verificado. */

const gtin = require("./gtin");
const identity = require("./identity");

const WEIGHTS = { model: 55, brand: 20, type: 15, measure: 8, pack: 8, color: 4 };
const BANDS = { verified: 80, review: 45 };

function norm(s) {
  return String(s == null ? "" : s).toLowerCase().normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function add(checks, notes, key, label, a, b, state, text) {
  checks.push({ key: key, label: label, source: a || "â€”", offer: b || "â€”", state: state });
  if (text && !notes.some(function (n) { return n.text === text; })) notes.push({ state: state, text: text });
}

/* Conflictos primero: el primer motivo que ve el usuario es el que descarta. */
function ordered(notes) {
  const fails = notes.filter(function (n) { return n.state === "fail"; }).map(function (n) { return n.text; });
  const oks = notes.filter(function (n) { return n.state === "ok"; }).map(function (n) { return n.text; });
  return fails.concat(oks).slice(0, 8);
}

function sameModels(a, b) {
  return (a || []).some(function (x) { return (b || []).indexOf(x) !== -1; });
}

function unitOf(z) {
  return String(z).replace(/^[\dx.]+/, "");
}

/* Misma logica que identity.compare: medida ok si comparten alguna; fail si
   hay la misma unidad con valor distinto (30 cm vs 40 cm). */
function measureState(srcSizes, offerSizes) {
  const common = srcSizes.filter(function (z) { return offerSizes.indexOf(z) !== -1; });
  const sameUnitDiff = srcSizes.some(function (z) {
    return offerSizes.some(function (y) { return unitOf(z) === unitOf(y) && z !== y; });
  });
  if (common.length && !sameUnitDiff) return "ok";
  if (sameUnitDiff) return "fail";
  return "na";
}

/* score(src, offer, ctx)
   src   = ficha congelada (identity.freezeCard)
   offer = { name, brand, ean, model }
   ctx   = { typeOk: true|false|undefined, typeReason } del filtro de tipo */
function score(src, offer, ctx) {
  src = src || {};
  offer = offer || {};
  ctx = ctx || {};
  const checks = [];
  const notes = [];
  let points = 0;
  let strong = false;

  const sEans = gtin.normalizeAll([].concat(src.eans || [], src.ean || []));
  const oEans = gtin.normalizeAll([].concat(offer.eans || [], offer.ean || []));
  let eanOk = false;
  if (sEans.length && oEans.length) {
    eanOk = gtin.intersects(sEans, oEans);
    if (eanOk) add(checks, notes, "ean", "EAN/UPC", sEans[0], oEans[0], "ok", "EAN/UPC coincide");
    else {
      strong = true;
      add(checks, notes, "ean", "EAN/UPC", sEans[0], oEans[0], "fail", "EAN/UPC distinto: es otro producto");
    }
  } else add(checks, notes, "ean", "EAN/UPC", sEans[0] || "", oEans[0] || "", "na", "");

  if (eanOk) {
    return {
      score: 100, band: "verificado", reasons: ordered(notes), checks: checks,
      strongConflict: false, eanOk: true, brandOk: true, modelOk: true
    };
  }

  const o = identity.identityOf(offer);

  /* Modelo: solo hay conflicto si AMBOS textos traen codigos. Para descartar
     se exigen codigos distintivos (>=4 caracteres): "4K", "5G" o "15M" son
     atributos, no modelos, y un falso conflicto tiraria una oferta valida. */
  const sModels = src.models || [];
  const oModels = o.models || [];
  const modelOk = sameModels(sModels, oModels);
  const distinctive = function (list) { return list.filter(function (c) { return c.length >= 4; }); };
  const sStrong = distinctive(sModels);
  const oStrong = distinctive(oModels);
  if (sModels.length && oModels.length) {
    if (modelOk) {
      points += WEIGHTS.model;
      add(checks, notes, "model", "Modelo", sModels.join(", "), oModels.join(", "), "ok", "Modelo " + sModels.slice(0, 2).join("/") + " coincide");
    } else if (sStrong.length && oStrong.length) {
      strong = true;
      add(checks, notes, "model", "Modelo", sModels.join(", "), oModels.join(", "), "fail",
        "Otro modelo: la oferta dice " + oStrong.slice(0, 2).join("/") + " y el origen " + sStrong.slice(0, 2).join("/"));
    } else {
      add(checks, notes, "model", "Modelo", sModels.join(", "), oModels.join(", "), "fail",
        "El codigo de modelo no coincide: confirmar antes de comprar");
    }
  } else add(checks, notes, "model", "Modelo", sModels.join(", "), oModels.join(", "), "na", "");

  /* Marca: en el campo marca o en el titulo. No nombrada = sin dato (na). */
  const brand = String(src.brand || "").trim();
  let brandOk = false;
  if (brand) {
    brandOk = norm([offer.brand, offer.name].join(" ")).indexOf(norm(brand)) !== -1;
    if (brandOk) {
      points += WEIGHTS.brand;
      add(checks, notes, "brand", "Marca", brand, offer.brand || "", "ok", "Marca " + brand + " coincide");
    } else add(checks, notes, "brand", "Marca", brand, offer.brand || "", offer.brand ? "fail" : "na",
      offer.brand ? "Marca distinta: la oferta dice " + offer.brand : "Marca no indicada en la oferta");
  } else add(checks, notes, "brand", "Marca", "", offer.brand || "", "na", "");

  /* Tipo de producto: lo calcula inverso con ptype/typeprofile. */
  if (ctx.typeOk === true) {
    points += WEIGHTS.type;
    add(checks, notes, "type", "Tipo de producto", "origen", "oferta", "ok", "Tipo de producto coincide");
  } else if (ctx.typeOk === false) {
    add(checks, notes, "type", "Tipo de producto", "origen", "oferta", "fail",
      ctx.typeReason || "Tipo de producto distinto");
  } else add(checks, notes, "type", "Tipo de producto", "", "", "na", "");

  /* Medida: no descarta, resta. */
  const sSizes = src.sizes || [];
  const oSizes = o.sizes || [];
  if (sSizes.length && oSizes.length) {
    const st = measureState(sSizes, oSizes);
    if (st === "ok") {
      points += WEIGHTS.measure;
      add(checks, notes, "measure", "Medida/talla", sSizes.join(", "), oSizes.join(", "), "ok", "Medida " + sSizes.join(", ") + " coincide");
    } else if (st === "fail") {
      points -= WEIGHTS.measure;
      add(checks, notes, "measure", "Medida/talla", sSizes.join(", "), oSizes.join(", "), "fail",
        "Medida distinta: origen " + sSizes.join(", ") + " y oferta " + oSizes.join(", "));
    } else add(checks, notes, "measure", "Medida/talla", sSizes.join(", "), oSizes.join(", "), "na", "");
  } else add(checks, notes, "measure", "Medida/talla", sSizes.join(", "), oSizes.join(", "), "na", "");

  /* Pack/cantidad: conflicto fuerte (2 uds vs 4 uds es otro articulo). */
  const sQty = String(src.quantity || "");
  const oQty = String(o.quantity || "");
  if (sQty && oQty) {
    if (sQty === oQty) {
      points += WEIGHTS.pack;
      add(checks, notes, "pack", "Pack/cantidad", sQty, oQty, "ok", "Pack " + sQty + " coincide");
    } else {
      strong = true;
      add(checks, notes, "pack", "Pack/cantidad", sQty, oQty, "fail", "Pack distinto: origen " + sQty + " y oferta " + oQty);
    }
  } else add(checks, notes, "pack", "Pack/cantidad", sQty, oQty, "na", "");

  /* Color: no descarta, resta. */
  const sColor = String(src.color || "");
  const oColor = String(o.color || "");
  if (sColor && oColor) {
    if (sColor === oColor) {
      points += WEIGHTS.color;
      add(checks, notes, "color", "Color", sColor, oColor, "ok", "Color " + sColor + " coincide");
    } else {
      points -= WEIGHTS.color;
      add(checks, notes, "color", "Color", sColor, oColor, "fail", "Color distinto: origen " + sColor + " y oferta " + oColor);
    }
  } else add(checks, notes, "color", "Color", sColor, oColor, "na", "");

  points = Math.max(0, Math.min(100, Math.round(points)));
  let band;
  if (strong) {
    band = "descartar";
    points = 0;
  } else if (brandOk && modelOk && sModels.length && oModels.length) {
    /* Marca+modelo sin conflicto: unica via a "verificado" sin EAN. */
    band = "verificado";
    points = Math.max(points, BANDS.verified);
  } else if (points >= BANDS.verified) {
    band = "revisar";
  } else if (points >= BANDS.review) {
    band = "revisar";
  } else {
    band = "descartar";
  }

  /* 1688 y otros mercados chinos: el titulo no tiene alfabeto latino y no se
     puede comparar por texto. No es "otro producto": es un candidato que hay
     que validar con la foto. Solo se descarta si hay conflicto fuerte. */
  const text = String(offer.name || "");
  const cjkOnly = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(text) && !/[a-zA-Z]/.test(text);
  if (cjkOnly && !strong && band === "descartar") {
    band = "revisar";
    notes.push({ state: "na", text: "Titulo en chino: compara la foto antes de comprar." });
  }

  return {
    score: points, band: band,
    reasons: ordered(notes).concat(cjkOnly && !strong ? ["Titulo en chino: compara la foto antes de comprar."] : []),
    checks: checks,
    strongConflict: strong, eanOk: false, brandOk: brandOk, modelOk: modelOk, noTextMatch: cjkOnly
  };
}

module.exports = { score, WEIGHTS, BANDS };

