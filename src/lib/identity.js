"use strict";
/* Identidad de producto.
   decideIdentity() es la UNICA funcion que decide si una oferta es el mismo
   producto. Cualquier otro modulo (match, compare, inverso) delega en ella.

   Orden de decision (fijo):
     1. Codigo de barras: igual -> verificado; distinto -> descartar.
     2. Conflictos duros (solo si AMBOS lados declaran el dato): accesorio o
        repuesto, modelo, marca, pack, talla/medida, color y especificacion
        clave. Un conflicto duro descarta siempre.
     3. Evidencia positiva: suma puntos, nunca asciende sola a verificado.
     4. Foto: si llega un cotejo visual concluyente, se aplica aqui (el
        resultado se calcula fuera y se pasa en ctx.image).
     5. Un unico veredicto: verificado / revisar / descartar.

   Nunca inventa: si un lado no declara el atributo, no hay conflicto (na). */

const gtin = require("./gtin");
const specsLib = require("./specs");

const WEIGHTS = { model: 55, brand: 20, type: 15, measure: 8, pack: 8, color: 4, spec: 10 };
const BANDS = { verified: 80, review: 45 };

const COLORS = ["negro", "blanco", "rojo", "azul", "verde", "amarillo", "rosa", "gris", "naranja", "morado", "violeta", "lila", "marron", "beige", "dorado", "plateado", "turquesa", "celeste",
  "black", "white", "red", "blue", "green", "yellow", "pink", "grey", "gray", "orange", "purple", "brown", "gold", "silver"];
const COLOR_MAP = { black: "negro", white: "blanco", red: "rojo", blue: "azul", green: "verde", yellow: "amarillo", pink: "rosa", grey: "gris", gray: "gris", orange: "naranja", purple: "morado", brown: "marron", gold: "dorado", silver: "plateado" };

/* Repuestos/accesorios: si la oferta los nombra y el origen no, es otro
   producto aunque comparta marca y modelo (cesta, filtro, funda...). */
const SPARE_WORDS = ["repuesto", "repuestos", "recambio", "recambios", "cesta", "cestas",
  "filtro", "filtros", "funda", "fundas", "cable", "cables", "adaptador", "adaptadores",
  "cargador", "cargadores", "bateria", "baterias", "junta", "juntas"];

/* Codigos que no identifican un producto por si solos: cortos (S5, X1, 4K),
   solo letras o genericos. No pueden ascender a "verificado" ni descartar
   como "otro modelo" (un falso conflicto tiraria una oferta valida). */
const GENERIC_MODELS = ["4k", "8k", "5g", "4g", "3g", "2g", "hd", "fhd", "uhd", "led", "lcd",
  "usb", "wifi", "bt", "pro", "max", "plus", "mini", "air", "gen"];

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

/* Talla declarada en un campo (M, XL, 42...), no solo "talla M" dentro del
   titulo. Se usa para no comparar una prenda M con una L como si fuera igual. */
function sizeField(v) {
  const s = norm(v);
  if (!s) return [];
  if (/^(xxs|xs|s|m|l|xl|xxl|xxxl|2xl|3xl|4xl|5xl|6xl|\d{1,3}(?:[.,]\d+)?)$/.test(s)) {
    return ["talla" + s.replace(",", ".")];
  }
  return sizesOf(s);
}

function identityOf(o) {
  o = o || {};
  const attrs = o.attrs || {};
  const base = [o.brand, o.model, o.name || o.title].filter(Boolean).join(" ");
  const sizeText = [o.size, attrs.size, attrs.talla, attrs.dimensions, attrs.dimensiones, attrs.medidas, base].filter(Boolean).join(" ");
  const explicitColor = colorOf(String(o.color || attrs.color || attrs.colour || ""));
  const sizes = sizesOf(sizeText).concat(sizeField(o.size || attrs.size || attrs.talla || ""));
  return {
    ean: String(o.ean || "").replace(/\D+/g, ""),
    eans: gtin.normalizeAll([].concat(o.eans || [], o.ean || [])),
    brand: String(o.brand || attrs.brand || "").trim(),
    models: modelsOf((o.model ? o.model + " " : "") + String(o.name || o.title || "")),
    quantity: quantityOf(o.name || o.title),
    sizes: Array.from(new Set(sizes)),
    color: explicitColor || colorOf(base)
  };
}

function add(checks, notes, key, label, a, b, state, text) {
  checks.push({ key: key, label: label, source: a || "—", offer: b || "—", state: state });
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

function isGenericModel(code) {
  const c = String(code == null ? "" : code).toLowerCase();
  if (c.length < 4) return true;
  if (!/\d/.test(c)) return true;
  if (GENERIC_MODELS.indexOf(c) !== -1) return true;
  if (/^[a-z]\d{1,2}$/.test(c)) return true;
  return false;
}

function spareConflict(src, offer, sourceText) {
  /* Sin el texto del origen no se puede saber si la palabra sobra (una ficha
     congelada no conserva el titulo): en ese caso no se inventa el conflicto. */
  const known = [sourceText, src.name, src.title].filter(function (x) { return String(x || "").trim(); });
  if (!known.length) return "";
  const s = " " + norm(known.concat([src.brand, (src.models || []).join(" ")]).filter(Boolean).join(" ")) + " ";
  const o = " " + norm([offer.name, offer.brand, offer.model].filter(Boolean).join(" ")) + " ";
  for (let i = 0; i < SPARE_WORDS.length; i++) {
    if (o.indexOf(" " + SPARE_WORDS[i] + " ") !== -1 && s.indexOf(" " + SPARE_WORDS[i] + " ") === -1) return SPARE_WORDS[i];
  }
  if (o.indexOf(" compatible con ") !== -1 && s.indexOf(" compatible con ") === -1) return "compatible con";
  const b = norm(src.brand);
  if (b && o.indexOf(" para " + b + " ") !== -1 && s.indexOf(" para " + b + " ") === -1) return "para " + b;
  return "";
}

function unitOf(z) {
  if (/^talla/.test(z)) return "talla";
  return String(z).replace(/^[\dx.]+/, "");
}

/* Medida ok si comparten alguna; conflicto si hay la misma unidad con valor
   distinto (30 cm vs 40 cm, talla M vs talla L). */
function measureState(srcSizes, offerSizes) {
  const common = srcSizes.filter(function (z) { return offerSizes.indexOf(z) !== -1; });
  const sameUnitDiff = srcSizes.some(function (z) {
    return offerSizes.some(function (y) { return unitOf(z) === unitOf(y) && z !== y; });
  });
  if (common.length && !sameUnitDiff) return "ok";
  if (sameUnitDiff) return "fail";
  return "na";
}

/* decideIdentity(src, offer, ctx)
   src   = ficha congelada (identity.freezeCard)
   offer = oferta del proveedor (name, brand, ean, model, color, size...)
   ctx   = { typeOk, typeReason, typeConflict, sourceText, specs, image }
           image = { state: "same"|"different"|"unknown", same, reason } o null

   Devuelve SIEMPRE la misma forma: verdict, score, reasons, checks,
   conflicts, strongConflict y los indicadores de cada atributo. */
function decideIdentity(src, offer, ctx) {
  src = src || {};
  offer = offer || {};
  ctx = ctx || {};
  const checks = [];
  const notes = [];
  const conflicts = [];
  let points = 0;
  let strong = false;
  let variantConflict = false;

  function hard(key, label, a, b, text) {
    strong = true;
    if (conflicts.indexOf(key) === -1) conflicts.push(key);
    add(checks, notes, key, label, a, b, "fail", text);
  }

  const sEans = gtin.normalizeAll([].concat(src.eans || [], src.ean || []));
  const oEans = gtin.normalizeAll([].concat(offer.eans || [], offer.ean || []));
  let eanOk = false;
  let eanDifferent = false;
  if (sEans.length && oEans.length) {
    eanOk = gtin.intersects(sEans, oEans);
    if (eanOk) add(checks, notes, "ean", "EAN/UPC", sEans[0], oEans[0], "ok", "EAN/UPC coincide");
    else {
      eanDifferent = true;
      hard("ean", "EAN/UPC", sEans[0], oEans[0], "EAN/UPC distinto: es otro producto");
    }
  } else add(checks, notes, "ean", "EAN/UPC", sEans[0] || "", oEans[0] || "", "na", "");

  /* Paso 1: el codigo de barras manda. Igual = verificado. */
  if (eanOk) {
    return {
      verdict: "verificado", band: "verificado", score: 100, reasons: ordered(notes),
      checks: checks, conflicts: [], strongConflict: false,
      eanOk: true, eanDifferent: false, brandOk: true, modelOk: true,
      typeConflict: false, variantConflict: false, specConflict: false,
      noTextMatch: false, image: ctx.image || null
    };
  }

  /* Paso 2: accesorio o tipo de producto distinto. */
  let typeConflict = false;
  if (ctx.typeConflict === true) {
    typeConflict = true;
    hard("type", "Tipo de producto", "origen", "oferta",
      ctx.typeReason || "Tipo de producto distinto: no es el mismo producto.");
  }

  const o = identityOf(offer);

  /* Modelo: conflicto solo si AMBOS traen codigos distintivos. */
  const sModels = src.models || [];
  const oModels = o.models || [];
  const modelOk = sameModels(sModels, oModels);
  const distinctive = function (list) { return list.filter(function (c) { return !isGenericModel(c); }); };
  const matchedModels = sModels.filter(function (m) { return oModels.indexOf(m) !== -1; });
  const distinctiveMatch = matchedModels.some(function (m) { return !isGenericModel(m); });
  const sStrong = distinctive(sModels);
  const oStrong = distinctive(oModels);
  if (sModels.length && oModels.length) {
    if (modelOk) {
      points += WEIGHTS.model;
      add(checks, notes, "model", "Modelo", sModels.join(", "), oModels.join(", "), "ok", "Modelo " + sModels.slice(0, 2).join("/") + " coincide");
    } else if (sStrong.length && oStrong.length) {
      hard("model", "Modelo", sModels.join(", "), oModels.join(", "),
        "Otro modelo: la oferta dice " + oStrong.slice(0, 2).join("/") + " y el origen " + sStrong.slice(0, 2).join("/"));
    } else {
      add(checks, notes, "model", "Modelo", sModels.join(", "), oModels.join(", "), "fail",
        "El codigo de modelo no coincide: confirmar antes de comprar");
    }
  } else add(checks, notes, "model", "Modelo", sModels.join(", "), oModels.join(", "), "na", "");

  /* Marca: conflicto duro solo si la oferta declara una marca distinta. */
  const brand = String(src.brand || "").trim();
  let brandOk = false;
  if (brand) {
    brandOk = norm([offer.brand, offer.name].join(" ")).indexOf(norm(brand)) !== -1;
    if (brandOk) {
      points += WEIGHTS.brand;
      add(checks, notes, "brand", "Marca", brand, offer.brand || "", "ok", "Marca " + brand + " coincide");
    } else if (String(offer.brand || "").trim()) {
      hard("brand", "Marca", brand, offer.brand, "Marca distinta: la oferta dice " + offer.brand + " y el origen " + brand);
    } else {
      add(checks, notes, "brand", "Marca", brand, "", "na", "Marca no indicada en la oferta");
    }
  } else add(checks, notes, "brand", "Marca", "", offer.brand || "", "na", "");

  /* Tipo: accesorio o repuesto NUNCA puede verificarse. */
  if (typeConflict) {
    /* Ya anotado como conflicto duro. */
  } else {
    const spare = spareConflict(src, offer, ctx.sourceText);
    const typeReason = String(ctx.typeReason || "");
    const accessoryReason = /accesorio|repuesto|replacement|spare|recambio/i.test(typeReason);
    if (spare) {
      typeConflict = true;
      hard("type", "Tipo de producto", "origen", "oferta",
        "Es un accesorio o repuesto (\"" + spare + "\"), no el producto.");
    } else if (ctx.typeOk === false && accessoryReason) {
      typeConflict = true;
      hard("type", "Tipo de producto", "origen", "oferta", typeReason || "Es un accesorio o repuesto, no el producto.");
    } else if (ctx.typeOk === true) {
      points += WEIGHTS.type;
      add(checks, notes, "type", "Tipo de producto", "origen", "oferta", "ok", "Tipo de producto coincide");
    } else if (ctx.typeOk === false) {
      add(checks, notes, "type", "Tipo de producto", "origen", "oferta", "na",
        "No se pudo confirmar el tipo de producto; se usa marca+modelo.");
    } else add(checks, notes, "type", "Tipo de producto", "", "", "na", "");
  }

  /* Talla/medida: conflicto duro si la misma unidad trae valores distintos. */
  const sSizes = src.sizes || [];
  const oSizes = o.sizes || [];
  if (sSizes.length && oSizes.length) {
    const st = measureState(sSizes, oSizes);
    if (st === "ok") {
      points += WEIGHTS.measure;
      add(checks, notes, "size", "Medida/talla", sSizes.join(", "), oSizes.join(", "), "ok", "Medida " + sSizes.join(", ") + " coincide");
    } else if (st === "fail") {
      variantConflict = true;
      hard("size", "Medida/talla", sSizes.join(", "), oSizes.join(", "),
        "Medida distinta: origen " + sSizes.join(", ") + " y oferta " + oSizes.join(", "));
    } else add(checks, notes, "size", "Medida/talla", sSizes.join(", "), oSizes.join(", "), "na", "");
  } else add(checks, notes, "size", "Medida/talla", sSizes.join(", "), oSizes.join(", "), "na", "");

  /* Pack/cantidad: conflicto duro (2 uds vs 4 uds es otro articulo). */
  const sQty = String(src.quantity || "");
  const oQty = String(o.quantity || "");
  if (sQty && oQty) {
    if (sQty === oQty) {
      points += WEIGHTS.pack;
      add(checks, notes, "quantity", "Pack/cantidad", sQty, oQty, "ok", "Pack " + sQty + " coincide");
    } else {
      variantConflict = true;
      hard("quantity", "Pack/cantidad", sQty, oQty, "Pack distinto: origen " + sQty + " y oferta " + oQty);
    }
  } else add(checks, notes, "quantity", "Pack/cantidad", sQty, oQty, "na", "");

  /* Color: conflicto duro si ambos lo declaran y no coincide. */
  const sColor = String(src.color || "");
  const oColor = String(o.color || "");
  if (sColor && oColor) {
    if (sColor === oColor) {
      points += WEIGHTS.color;
      add(checks, notes, "color", "Color", sColor, oColor, "ok", "Color " + sColor + " coincide");
    } else {
      variantConflict = true;
      hard("color", "Color", sColor, oColor, "Color distinto: origen " + sColor + " y oferta " + oColor);
    }
  } else add(checks, notes, "color", "Color", sColor, oColor, "na", "");

  /* Caracteristicas tecnicas: misma caracteristica, misma unidad y valor
     numerico distinto = conflicto duro. */
  const sSpecs = ctx.specs || {};
  const oSpecs = specsLib.fromSource(offer);
  let specConflict = false;
  if (Object.keys(sSpecs).length || Object.keys(oSpecs).length) {
    const sc = specsLib.compare(sSpecs, oSpecs);
    sc.checks.forEach(function (c) { checks.push(c); });
    if (sc.okCount) {
      points += Math.min(WEIGHTS.spec, sc.okCount * 5);
      notes.push({ state: "ok", text: "Caracteristicas coincidentes: " + sc.checks.filter(function (c) { return c.state === "ok"; }).map(function (c) { return c.label; }).join(", ") });
    }
    if (sc.conflicts.length) {
      specConflict = true;
      hard("spec", "Caracteristicas", sc.conflicts.map(function (c) { return c.source; }).join(", "), sc.conflicts.map(function (c) { return c.offer; }).join(", "),
        "Caracteristica distinta: " + sc.conflicts.map(function (c) {
          return c.label + " origen " + c.source + " y oferta " + c.offer;
        }).join("; "));
    } else if (!sc.okCount && Object.keys(sSpecs).length) {
      notes.push({ state: "na", text: "La oferta no declara caracteristicas comparables." });
    }
  }

  /* Paso 4: foto. Solo un cotejo concluyente ("different") descarta; "same"
     suma evidencia pero no verifica por si solo. */
  const img = ctx.image || null;
  if (img && img.state === "different") {
    hard("image", "Foto", "foto origen", "foto oferta",
      img.reason || "Las fotos son claramente distintas: no es el mismo producto.");
  } else if (img && img.state === "same") {
    points += WEIGHTS.measure;
    add(checks, notes, "image", "Foto", "foto origen", "foto oferta", "ok", img.reason || "La foto coincide con la del origen");
  } else if (img && img.state === "unknown") {
    add(checks, notes, "image", "Foto", "foto origen", "foto oferta", "na",
      img.reason || "No se pudo confirmar visualmente la foto.");
  }

  points = Math.max(0, Math.min(100, Math.round(points)));
  let band;
  if (strong) {
    band = "descartar";
    points = 0;
  } else if (brandOk && modelOk && distinctiveMatch && !specConflict && !variantConflict && !typeConflict) {
    /* Marca+modelo distintivo sin conflicto: unica via a "verificado" sin EAN. */
    band = "verificado";
    points = Math.max(points, BANDS.verified);
  } else if (brandOk && !specConflict && !variantConflict && !typeConflict) {
    /* Marca correcta y sin conflicto de tipo/specs: es un CANDIDATO (nivel 3),
       no un descarte. Antes caia a "descartar" por no tener modelo y la web
       que si vendia el producto acababa fuera de la lista. */
    band = "revisar";
    points = Math.max(points, BANDS.review);
  } else if (points >= BANDS.review) {
    band = "revisar";
  } else {
    band = "descartar";
  }

  /* 1688 y otros mercados chinos: el titulo no tiene alfabeto latino y no se
     puede comparar por texto. No es "otro producto": es un candidato que hay
     que validar con la foto. Solo se descarta si hay conflicto duro. */
  const text = String(offer.name || "");
  const cjkOnly = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(text) && !/[a-zA-Z]/.test(text);
  if (cjkOnly && !strong && band === "descartar") {
    band = "revisar";
    notes.push({ state: "na", text: "Titulo en chino: compara la foto antes de comprar." });
  }

  const reasons = ordered(notes);
  if (cjkOnly && !strong) reasons.push("Titulo en chino: compara la foto antes de comprar.");

  return {
    verdict: band, band: band, score: points, reasons: reasons, checks: checks,
    conflicts: conflicts, strongConflict: strong,
    eanOk: false, eanDifferent: eanDifferent, brandOk: brandOk, modelOk: modelOk,
    noTextMatch: cjkOnly, specConflict: specConflict,
    typeConflict: typeConflict, variantConflict: variantConflict, image: img
  };
}

/* Compatibilidad: compare() es una vista de decideIdentity() con los nombres
   historicos (exacto / distinto / variante / probable / equivalente). */
function compare(src, offer) {
  const d = decideIdentity(src, offer, {});
  const checks = d.checks;
  const W = { ean: 100, model: 60, brand: 25, size: 10, quantity: 8, color: 6 };
  let score = 0;
  const matching = [];
  checks.forEach(function (c) {
    if (c.state === "ok") { score += W[c.key] || 0; matching.push(c.key); }
  });
  if (d.conflicts.length) score = Math.min(score, 20);
  score = Math.max(0, Math.min(100, score));

  const labels = checks.filter(function (c) { return c.state === "fail"; }).map(function (c) { return c.label.toLowerCase(); });
  let verdict, reason;
  if (d.eanDifferent) { verdict = "distinto"; reason = "EAN distinto: es otro producto."; }
  else if (d.verdict === "descartar" && d.conflicts.length) {
    verdict = "variante";
    reason = "Difiere en " + labels.join(", ") + ": no es el mismo producto.";
  } else if (d.eanOk) { verdict = "exacto"; reason = "EAN/UPC coincide y no hay conflicto de atributos."; }
  else if (d.verdict === "verificado") { verdict = "probable"; reason = "Marca y modelo coinciden pero sin EAN: confirmar antes de comprar."; }
  else { verdict = "equivalente"; reason = "Sin EAN ni marca+modelo coincidentes: producto parecido, no verificado."; }

  return {
    verdict: verdict, reason: reason, checks: checks, conflicts: d.conflicts.slice(),
    eanOk: d.eanOk, score: score, matching: matching, conflicting: d.conflicts.slice()
  };
}

/* Ficha congelada: copia inmutable de lo que Amazon dice del producto. */
function freezeCard(id, body) {
  const card = Object.assign({}, id, {
    asin: String((body && body.asin) || "").toUpperCase(),
    image: String((body && (body.image || body.img)) || "")
  });
  card.eans = Object.freeze((card.eans || []).slice());
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
  if (ok.model && !rec.review && cmp.score >= 60) return "verificado";
  if (ok.brand && [ok.size, ok.quantity, ok.color].filter(Boolean).length >= 2 && !rec.review) return "probable";
  return "candidato";
}

module.exports = { freezeCard, stateOf, identityOf, compare, decideIdentity, modelsOf, sizesOf, quantityOf, colorOf, WEIGHTS, BANDS };
