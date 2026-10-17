"use strict";
/* Reparto de la Buy Box en N dias a partir de Keepa buyBoxSellerIdHistory
   (pares [minutoKeepa, sellerId]). Funcion pura: sin datos devuelve null (sin dato). */

const AMAZON_SELLERS = ["A1AT7YVPFBWXBL", "ATVPDKIKX0DER", "A3JWKAKR8XB7XF", "A1X6FK5RDHNB96", "A13V1IB3VIYZZH", "APJ6JRA9NG5V4", "A11IL2PNWYJU7H", "A1PA6795UKMFR9", "A2EUQ1WTGCTBG2", "A1F83G8C2ARO7P"];
const KEEPA_EPOCH_MIN = 21564000; /* minutos Keepa -> unix: (m + 21564000) * 60000 */

function norm(s) {
  return String(s == null ? "" : s).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

function shares(hist, days, nowMs) {
  if (!Array.isArray(hist) || hist.length < 2) return null;
  const now = nowMs || Date.now();
  const from = now - (days || 90) * 86400000;
  const tot = {};
  let sum = 0;
  for (let i = 0; i + 1 < hist.length; i += 2) {
    const t0 = (Number(hist[i]) + KEEPA_EPOCH_MIN) * 60000;
    const t1 = i + 2 < hist.length ? (Number(hist[i + 2]) + KEEPA_EPOCH_MIN) * 60000 : now;
    const id = String(hist[i + 1]);
    if (!isFinite(t0) || !isFinite(t1)) continue;
    const a = Math.max(t0, from), b = Math.min(t1, now);
    if (b <= a) continue;
    if (id === "-1" || id === "-2") continue; /* sin Buy Box / vendedor desconocido */
    tot[id] = (tot[id] || 0) + (b - a);
    sum += b - a;
  }
  if (sum <= 0) return null;
  const out = {};
  Object.keys(tot).forEach(function (k) { out[k] = tot[k] / sum; });
  return out;
}

/* Devuelve { known, amazonShare, topSeller, topShare, amazonOnly, sellers } */
function analyze(hist, days, nowMs) {
  const sh = shares(hist, days, nowMs);
  if (!sh) return { known: false };
  let amazon = 0, top = "", topShare = 0;
  Object.keys(sh).forEach(function (id) {
    if (AMAZON_SELLERS.indexOf(id) !== -1) amazon += sh[id];
    if (sh[id] > topShare) { topShare = sh[id]; top = id; }
  });
  return {
    known: true, amazonShare: Math.round(amazon * 1000) / 1000, topSeller: top, topShare: Math.round(topShare * 1000) / 1000,
    amazonOnly: amazon >= 0.97, sellers: Object.keys(sh).length
  };
}

/* El vendedor dominante es el fabricante si su nombre contiene la marca (o al reves). */
function isBrandSeller(sellerName, brand) {
  const s = norm(sellerName), b = norm(brand);
  if (!s || !b || b.length < 3) return null; /* sin dato */
  return s.indexOf(b) !== -1 || (s.length >= 4 && b.indexOf(s) !== -1);
}

/* Resumen final para planFor: kind = amazon | fabricante | mixto | sin_dato */
function verdict(an, sellerName, brand) {
  if (!an || !an.known) return { kind: "sin_dato", note: "Sin historial de Buy Box en Keepa." };
  if (an.amazonOnly) return { kind: "amazon", note: "Buy Box 90 d: Amazon " + Math.round(an.amazonShare * 100) + " %." };
  if (an.topShare >= 0.97) {
    const own = isBrandSeller(sellerName, brand);
    if (own === true) return { kind: "fabricante", note: "Buy Box 90 d: solo el fabricante/marca (" + sellerName + ")." };
    if (own === false) return { kind: "mixto", note: "Buy Box 90 d: un unico vendedor tercero (" + sellerName + "), no es la marca; revendible." };
    if (own === null) return { kind: "sin_dato", note: "Un unico vendedor tiene la Buy Box pero no se puede identificar si es el fabricante." };
  }
  return { kind: "mixto", note: "Buy Box repartida entre " + an.sellers + " vendedor(es); Amazon " + Math.round(an.amazonShare * 100) + " %." };
}

module.exports = { analyze, shares, verdict, isBrandSeller, AMAZON_SELLERS };
