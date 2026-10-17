"use strict";
/* Reparto de la Buy Box en N dias a partir de Keepa buyBoxSellerIdHistory
   (pares [minutoKeepa, sellerId]). Funcion pura: sin datos devuelve null.

   Ademas del reparto, clasifica a cada vendedor como Amazon, fabricante/marca o
   tercero. El fabricante se detecta con el campo `manufacturer` de Keepa y el
   nombre del vendedor, ignorando la forma juridica (SL, SA, GmbH, Ltd...). */

const AMAZON_SELLERS = ["A1AT7YVPFBWXBL", "ATVPDKIKX0DER", "A3JWKAKR8XB7XF", "A1X6FK5RDHNB96", "A13V1IB3VIYZZH", "APJ6JRA9NG5V4", "A11IL2PNWYJU7H", "A1PA6795UKMFR9", "A2EUQ1WTGCTBG2", "A1F83G8C2ARO7P"];
const KEEPA_EPOCH_MIN = 21564000; /* minutos Keepa -> unix: (m + 21564000) * 60000 */

const LEGAL_SUFFIXES = {
  sl: 1, slu: 1, sll: 1, sa: 1, sau: 1, sas: 1, sarl: 1, srl: 1, spa: 1,
  gmbh: 1, ltd: 1, limited: 1, inc: 1, llc: 1, corp: 1, corporation: 1,
  company: 1, co: 1, kg: 1, ag: 1, bv: 1, nv: 1, oy: 1, ab: 1, as: 1,
  aps: 1, pty: 1, plc: 1, sro: 1, spzoo: 1
};
const GENERIC = { the: 1, group: 1, official: 1, store: 1, shop: 1, brand: 1 };

function num(v, d) {
  if (v == null || v === "") return d == null ? 0 : d;
  const n = Number(v);
  return isFinite(n) ? n : (d == null ? 0 : d);
}
function round3(n) {
  return Math.round((isFinite(n) ? n : 0) * 1000) / 1000;
}
function norm(s) {
  return String(s == null ? "" : s).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}
/* "ACME, S.L." -> "acme"; "Acme GmbH & Co. KG" -> "acme". */
function companyKey(s) {
  let n = norm(s);
  n = n.replace(/\bs\s+l\s+u\b/g, "slu").replace(/\bs\s+l\b/g, "sl").replace(/\bs\s+a\s+u\b/g, "sau").replace(/\bs\s+a\b/g, "sa");
  const parts = n.split(" ").filter(Boolean);
  while (parts.length > 1 && LEGAL_SUFFIXES[parts[parts.length - 1]]) parts.pop();
  return parts.join(" ");
}
function sameCompany(a, b) {
  const x = companyKey(a), y = companyKey(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.length >= 4 && y.length >= 4 && (x.indexOf(y) !== -1 || y.indexOf(x) !== -1)) return true;
  const tx = x.split(" ").filter(function (t) { return t.length >= 3 && !GENERIC[t]; });
  const ty = y.split(" ").filter(function (t) { return t.length >= 3 && !GENERIC[t]; });
  if (!tx.length || !ty.length) return false;
  let common = 0;
  tx.forEach(function (t) { if (ty.indexOf(t) !== -1) common++; });
  return common > 0 && common >= Math.min(2, Math.min(tx.length, ty.length));
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

/* El vendedor dominante es el fabricante si su nombre coincide con la marca o
   con el fabricante de Keepa, ignorando sufijos societarios. */
function isBrandSeller(sellerName, brand) {
  const s = String(sellerName == null ? "" : sellerName).trim();
  const b = String(brand == null ? "" : brand).trim();
  if (!s || !b) return null; /* sin dato */
  return sameCompany(s, b);
}
function isManufacturerSeller(sellerName, brand, manufacturer) {
  const s = String(sellerName == null ? "" : sellerName).trim();
  if (!s) return null;
  const m = String(manufacturer == null ? "" : manufacturer).trim();
  const b = String(brand == null ? "" : brand).trim();
  if (!m && !b) return null;
  if (m && sameCompany(s, m)) return true;
  if (b && sameCompany(s, b)) return true;
  return false;
}

function roleOf(id, name, ctx) {
  if (AMAZON_SELLERS.indexOf(id) !== -1) return "amazon";
  if (!name) return "desconocido";
  const own = isManufacturerSeller(name, ctx && ctx.brand, ctx && ctx.manufacturer);
  if (own === true) return "fabricante";
  if (own === false) return "tercero";
  return "desconocido";
}

/* Devuelve el reparto y el desglose por vendedor.
   ctx opcional: { brand, manufacturer, sellerName, sellerNames:{id:name} }.
   `classified` solo es true cuando hay datos para asignar roles; si no, el
   llamador no debe sacar conclusiones sobre fabricante/terceros. */
function analyze(hist, days, nowMs, ctx) {
  const sh = shares(hist, days, nowMs);
  if (!sh) return { known: false, classified: false, breakdown: [], sellers: 0 };
  const names = (ctx && ctx.sellerNames) || {};
  const entries = Object.keys(sh).map(function (id) {
    return { id: id, share: sh[id], name: String(names[id] || "") };
  }).sort(function (a, b) { return b.share - a.share; });
  if (ctx && ctx.sellerName && entries.length && !entries[0].name) entries[0].name = String(ctx.sellerName);
  const classified = Boolean(ctx && (ctx.brand || ctx.manufacturer || ctx.sellerName || Object.keys(names).length));
  entries.forEach(function (e) { e.role = roleOf(e.id, e.name, ctx); });

  let amazon = 0, manufacturer = 0, third = 0, unknown = 0;
  let thirdSellers = 0, manufacturerSellers = 0, unknownSellers = 0, topThird = 0;
  entries.forEach(function (e) {
    if (e.role === "amazon") amazon += e.share;
    else if (e.role === "fabricante") { manufacturer += e.share; manufacturerSellers++; }
    else if (e.role === "tercero") { third += e.share; thirdSellers++; if (e.share > topThird) topThird = e.share; }
    else { unknown += e.share; unknownSellers++; }
  });
  const top = entries[0] || { id: "", name: "", share: 0 };
  return {
    known: true,
    classified: classified,
    amazonShare: round3(amazon),
    manufacturerShare: round3(manufacturer),
    thirdShare: round3(third),
    unknownShare: round3(unknown),
    topSeller: top.id,
    topSellerName: top.name,
    topShare: round3(top.share),
    topThirdShare: round3(topThird),
    thirdSellers: thirdSellers,
    manufacturerSellers: manufacturerSellers,
    unknownSellers: unknownSellers,
    sellers: entries.length,
    amazonOnly: amazon >= 0.97,
    breakdown: entries.map(function (e) {
      return { id: e.id, name: e.name, share: round3(e.share), role: e.role };
    })
  };
}

function pct(n) {
  return (Math.round((isFinite(n) ? n : 0) * 1000) / 10).toLocaleString("es-ES", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + " %";
}
function threshold(v, fallback) {
  const n = num(v, fallback);
  return n > 1 ? n / 100 : n;
}

/* Resumen final para planFor. kinds que bloquean: amazon, fabricante,
   amazon+fabricante y terceros. `a_revisar` y `sin_dato` nunca descartan. */
function verdict(an, sellerName, brand, manufacturer, opts) {
  if (!an || !an.known) return { kind: "sin_dato", note: "Sin historial de Buy Box en Keepa." };
  const o = opts || {};
  const manMin = threshold(o.manufacturerMin, 0.95);
  const thirdMax = threshold(o.thirdMax, 0.05);
  const singleThird = threshold(o.singleThird, 0.97);

  let amazon = num(an.amazonShare);
  let man, third, unknown, thirdSellers, topThird;
  if (an.classified) {
    man = num(an.manufacturerShare);
    third = num(an.thirdShare);
    unknown = num(an.unknownShare);
    thirdSellers = num(an.thirdSellers);
    topThird = num(an.topThirdShare);
  } else {
    /* Compatibilidad: solo se conoce el vendedor dominante. */
    man = 0; third = 0; unknown = 0;
    if (!an.amazonOnly && num(an.topShare) >= 0.97) {
      const own = isManufacturerSeller(sellerName, brand, manufacturer);
      if (own === true) man = num(an.topShare);
      else if (own === false) third = num(an.topShare);
      else unknown = num(an.topShare);
    }
    unknown += Math.max(0, 1 - amazon - man - third - unknown);
    thirdSellers = third > 0 ? 1 : 0;
    topThird = third;
  }

  const base = {
    amazonShare: round3(amazon), manufacturerShare: round3(man), thirdShare: round3(third),
    unknownShare: round3(unknown), thirdSellers: thirdSellers,
    breakdown: an.breakdown || []
  };
  const pack = function (kind, note) { return Object.assign({ kind: kind, note: note }, base); };

  if (amazon + man >= manMin - 1e-9) {
    if (man <= 1e-4) return pack("amazon", "Buy Box 90 d: Amazon " + pct(amazon) + ".");
    if (amazon <= 1e-4) return pack("fabricante", "Buy Box 90 d: fabricante/marca " + pct(man) + ".");
    return pack("amazon+fabricante", "Buy Box 90 d: Amazon " + pct(amazon) + " + fabricante " + pct(man) + " = " + pct(amazon + man) + ".");
  }
  if (unknown <= 1e-4 && third < thirdMax - 1e-9) {
    return pack("terceros", "Buy Box 90 d: terceros solo " + pct(third) + " (por debajo del " + pct(thirdMax) + ").");
  }
  if (thirdSellers === 1 && topThird >= singleThird - 1e-9) {
    return pack("a_revisar", "Buy Box 90 d: un unico vendedor tercero concentra " + pct(topThird) + "; a revisar (no se descarta).");
  }
  if (unknown > 1e-4) {
    return pack("sin_dato", "Buy Box 90 d: no se pudo identificar a todos los vendedores (" + pct(unknown) + " sin nombre).");
  }
  return pack("mixto", "Buy Box 90 d: Amazon " + pct(amazon) + ", fabricante " + pct(man) + ", terceros " + pct(third) + " en " + num(an.sellers) + " vendedor(es).");
}

module.exports = { analyze, shares, verdict, isBrandSeller, isManufacturerSeller, sameCompany, companyKey, AMAZON_SELLERS };
