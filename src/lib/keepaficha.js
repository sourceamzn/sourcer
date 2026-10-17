"use strict";
/* Ficha de producto leida de Keepa. Todo se lee de forma DEFENSIVA: si un campo no
   existe o tiene otro tipo, queda vacio y se anota en `missing` (el llamador lo
   registra) en vez de inventarlo. Funciones puras. */

const gtin = require("./gtin");

function str(v) {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim() : (typeof v === "number" && isFinite(v) && v > 0 ? String(v) : "");
}
function posNum(v) {
  const n = Number(v);
  return isFinite(n) && n > 0 ? n : 0;
}
function strList(v, limit) {
  if (!Array.isArray(v)) return [];
  return v.map(str).filter(Boolean).slice(0, limit || 20);
}

/* Devuelve { ficha, missing }. Keepa da medidas en mm y peso en g (-1 = sin dato). */
function fichaOf(prod) {
  const p = prod && typeof prod === "object" ? prod : {};
  const missing = [];
  function take(name, val) {
    const empty = val === "" || val == null || val === 0 || (Array.isArray(val) && !val.length);
    if (empty) missing.push(name);
    return val;
  }
  const eans = gtin.normalizeAll([].concat(
    Array.isArray(p.eanList) ? p.eanList : [],
    Array.isArray(p.upcList) ? p.upcList : [],
    Array.isArray(p.gtinList) ? p.gtinList : []
  ));
  const dims = {
    lengthMm: posNum(p.itemLength), widthMm: posNum(p.itemWidth), heightMm: posNum(p.itemHeight),
    pkgLengthMm: posNum(p.packageLength), pkgWidthMm: posNum(p.packageWidth), pkgHeightMm: posNum(p.packageHeight)
  };
  Object.keys(dims).forEach(function (k) { if (!dims[k]) delete dims[k]; });
  const weight = { itemG: posNum(p.itemWeight), packageG: posNum(p.packageWeight) };
  if (!weight.itemG) delete weight.itemG;
  if (!weight.packageG) delete weight.packageG;
  const ficha = {
    eans: take("eans", eans),
    model: take("model", str(p.model)),
    partNumber: take("partNumber", str(p.partNumber)),
    manufacturer: take("manufacturer", str(p.manufacturer)),
    features: take("features", strList(p.features, 12)),
    description: take("description", str(p.description).slice(0, 1200)),
    packageQuantity: take("packageQuantity", posNum(p.packageQuantity)),
    numberOfItems: take("numberOfItems", posNum(p.numberOfItems)),
    dimensions: Object.keys(dims).length ? dims : take("dimensions", null) || {},
    weight: Object.keys(weight).length ? weight : take("weight", null) || {},
    color: str(p.color),
    size: str(p.size)
  };
  return { ficha: ficha, missing: missing };
}

/* Amazon vende de verdad si tiene presencia en la Buy Box de los ultimos 90 dias.
   Antes se miraba el precio actual de Amazon y outOfStockPercentage90 (que es una
   lista, no un numero), asi que casi nunca detectaba a Amazon.
   bb = resultado de buybox.analyze(). Sin historial de Buy Box se usa, en este orden,
   stats.buyBoxIsAmazon (si Keepa lo trae como booleano) y el precio actual de Amazon. */
const AMAZON_PRESENCE = 0.05;
function amazonSellsFrom(prod, bb, currentAmazonPrice) {
  if (bb && bb.known) return bb.amazonShare >= AMAZON_PRESENCE;
  const s = (prod && prod.stats) || {};
  if (typeof s.buyBoxIsAmazon === "boolean") return s.buyBoxIsAmazon;
  return Number(currentAmazonPrice) > 0;
}

module.exports = { fichaOf, amazonSellsFrom, AMAZON_PRESENCE };
