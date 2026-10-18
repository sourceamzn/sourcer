"use strict";
/* Formula del PDF para el precio maximo de compra, el descuento necesario y
   el estado del candidato. Funcion pura y aislada (sin Keepa, sin red) para
   poder probarla y reutilizarla desde cualquier adaptador. */

const buybox = require("./buybox");
const fees = require("./fees");

const TIERS = [
  { max: 9, margin: 18, roi: 30, label: "menos de 10/mes" },
  { max: 49, margin: 15, roi: 25, label: "10 a 49/mes" },
  { max: 99, margin: 12.5, roi: 25, label: "50 a 99/mes" },
  { max: 1e9, margin: 10, roi: 20, label: "100 o mas/mes" }
];
const PLAN_DEFAULT = {
  vat: 21, recargo: 5.2, referral: 15, fbaFee: 3.5, storage: 0, digital: 0, inbound: 0.30,
  minBB: 0, minSales: 0, minHistory: 0, minThirdParty: 0, minFba: 2,
  maxDiscount: 0, nearPct: 8, tiers: TIERS,
  /* 1 = descarta si en 90 d la Buy Box fue solo de Amazon o solo del
     fabricante/marca; 0 = solo aviso. */
  bbRule: 1,
  /* Regla Buy Box: Amazon + fabricante >= 95 % o terceros < 5 % = no apto.
     Ademas se exigen al menos 2 vendedores FBA distintos: con uno solo no
     hay competencia real en la Buy Box. */
  bbManufacturerMin: 95, bbThirdMax: 5, bbSingleThird: 97,
  requireTwoSellers: 1
};

function num(v, d) {
  if (v == null || v === "") return d == null ? 0 : d;
  const n = Number(v);
  return isFinite(n) ? n : d == null ? 0 : d;
}
function round2(n) {
  return Math.round((isFinite(n) ? n : 0) * 100) / 100;
}
/* Avisos de restricciones (array de textos o de objetos de la API). */
function restrictionNotes(v) {
  if (!v) return [];
  const arr = Array.isArray(v) ? v : [v];
  const out = [];
  arr.forEach(function (x) {
    const s = typeof x === "string" ? x : String((x && (x.message || x.reason || x.reasonCode)) || "");
    if (s && out.indexOf(s) === -1) out.push(s);
  });
  return out;
}

function planParams(body) {
  const src = (body && (body.params || body.filters)) || {};
  const p = Object.assign({}, PLAN_DEFAULT);
  Object.keys(PLAN_DEFAULT).forEach(function (k) {
    if (src[k] != null && src[k] !== "") p[k] = num(src[k], PLAN_DEFAULT[k]);
  });
  if (Array.isArray(src.tiers) && src.tiers.length) p.tiers = src.tiers;
  return p;
}

function tierFor(sales, p) {
  const arr = p.tiers || TIERS;
  for (let i = 0; i < arr.length; i++) if (sales <= arr[i].max) return arr[i];
  return arr[arr.length - 1];
}

/* ---------- Precio maximo de compra (formula literal del PDF) ----------
   1. PV = precio Buy Box media 90 dias, venta SIN IVA (a descontar).
   2. Tarifas reales F = (referencia + FBA + almacenamiento + servicios digitales) x 1,21 + 0,30 envio a FBA.
   3. Coste real maximo = min( (PV - F)/(1 + ROI min), (PV - F) - (margen min x PV) ).
   4. Precio maximo en web del proveedor (con IVA, sin recargo) = coste real maximo / 1,262 x 1,21.
   5. Descuento necesario = 1 - precio maximo / PVP de referencia. */
function planFor(m, p) {
  p = p || PLAN_DEFAULT;
  const pvp = num(m.pvp);
  const sales = num(m.sales);
  const tier = tierFor(sales, p);
  const vat = num(p.vat) / 100, recargo = num(p.recargo) / 100;
  const PV = pvp > 0 ? pvp / (1 + vat) : 0;
  /* Tarifas reales del producto (Keepa/SP-API/manual) o estimacion del PDF. */
  const rates = fees.resolve(m, p);
  const referencia = PV * (rates.referralPct / 100);
  const F = (referencia + rates.fbaFee + num(p.storage) + num(p.digital)) * (1 + vat) + num(p.inbound);
  const cRoi = (PV - F) / (1 + tier.roi / 100);
  const cMargin = PV - F - (tier.margin / 100) * PV;
  const costMax = Math.max(0, Math.min(cRoi, cMargin));
  const priceMax = costMax > 0 ? (costMax / (1 + vat + recargo)) * (1 + vat) : 0;
  const discount = pvp > 0 ? 1 - priceMax / pvp : 0;
  const discPct = round2(discount * 100);

  /* Reglas duras: beneficio neto y Buy Box con competencia real (2 FBA). Sin
     coste maximo positivo la operacion pierde dinero; con Amazon/fabricante
     dominando o un solo vendedor FBA no hay hueco. El resto de criterios del
     PDF (precio minimo, ventas, historial, descuento necesario) son AVISOS
     configurables: informan, no descartan. */
  const reasons = [];
  const thirdParty = num(m.thirdParty, 0);
  const historyDays = m.historyDays == null ? null : num(m.historyDays);
  const fbaKnown = m.offersFba != null && m.offersFba !== "";
  const fba = num(m.offersFba, 0);
  const lowFba = fbaKnown && fba < num(p.minFba);
  const lowFbaBlocked = num(p.bbRule, 1) > 0 && lowFba;
  const privateLabel = !!m.privateLabel || (fbaKnown && num(m.thirdParty, 0) <= 1 && fba <= 1);
  /* Regla Buy Box 90 d: Amazon+fabricante >= 95 % o terceros < 5 % = no apto
     (configurable). Ademas, si hay historial clasificado, se exigen al menos
     2 vendedores terceros distintos: con un solo vendedor no hay competencia. */
  const bbv = buybox.verdict(m.buyBox, m.sellerName, m.brand, m.manufacturer, {
    manufacturerMin: p.bbManufacturerMin, thirdMax: p.bbThirdMax, singleThird: p.bbSingleThird
  });
  const twoSellers = num(p.requireTwoSellers, 1) > 0;
  const singleSeller = num(p.bbRule, 1) > 0 && twoSellers && bbv.kind !== "sin_dato" &&
    bbv.thirdSellers != null && num(bbv.thirdSellers) < 2;
  const bbBlocked = singleSeller || (num(p.bbRule, 1) > 0 && (
    bbv.kind === "amazon" || bbv.kind === "fabricante" ||
    bbv.kind === "amazon+fabricante" || bbv.kind === "terceros"
  ));
  const hardDrop = costMax <= 0 || bbBlocked || lowFbaBlocked;
  const restricted = restrictionNotes(m.restrictions);
  if (bbBlocked) reasons.push("No apto: " + bbv.note + " No hay hueco para revender.");
  if (singleSeller && ["amazon", "fabricante", "amazon+fabricante", "terceros"].indexOf(bbv.kind) === -1) {
    reasons.push("Buy Box 90 d: solo " + num(bbv.thirdSellers) + " vendedor(es) tercero(s); se exigen 2 vendedores distintos. No apto.");
  }
  if (costMax <= 0) reasons.push("Con las tarifas reales no queda coste maximo positivo: no hay beneficio neto.");
  if (lowFbaBlocked) reasons.push("Solo " + fba + " vendedor(es) FBA (minimo " + p.minFba + "): descartado, no hay 2 FBA.");
  else if (lowFba) reasons.push("Solo " + fba + " vendedor(es) FBA (minimo " + p.minFba + "): EN REVISION, no apto.");
  if (privateLabel && !lowFbaBlocked) reasons.push("Marca privada con exclusividad probable (un unico vendedor): EN REVISION, no apto.");
  if (!hardDrop) {
    if (pvp > 0 && pvp < num(p.minBB)) reasons.push("Precio Buy Box " + round2(pvp) + " EUR por debajo del minimo (" + p.minBB + " EUR): el descuento necesario puede no conseguirse.");
    if (sales < num(p.minSales)) reasons.push("Ventas/mes " + round2(sales) + " por debajo del minimo (" + p.minSales + "): poca rotacion.");
    if (num(p.minThirdParty) > 0 && thirdParty < num(p.minThirdParty)) reasons.push("Solo " + thirdParty + " vendedor(es) tercero(s): si solo vende la marca, es marca privada.");
    if (historyDays != null && historyDays < num(p.minHistory)) reasons.push("Historial en Keepa de " + historyDays + " dias (minimo " + p.minHistory + "): listing nuevo, a revisar.");
    if (num(p.maxDiscount) > 0 && discPct > num(p.maxDiscount)) reasons.push("Descuento necesario " + discPct + " % supera el tope " + p.maxDiscount + " %: dificil de conseguir.");
    if (m.brandRestricted) reasons.push("Marca restringida: se puede solicitar en Seller Central (solo aviso).");
    if (restricted.length) reasons.push("Restricciones de Amazon: " + restricted.join(" · ") + " (solo aviso).");
    if (m.hazmat) reasons.push("Posible hazmat: se vende por FBM (solo aviso).");
    if (m.amazonOnly) reasons.push("Amazon es el unico otro vendedor: dificilmente cede la Buy Box.");
  }
  const estado = hardDrop ? "descarte" : (reasons.length ? "casi" : "apt");

  return {
    pvp: round2(pvp), pvNet: round2(PV), tier: { margin: tier.margin, roi: tier.roi, label: tier.label },
    referral: round2(referencia), feesReal: round2(F), costMax: round2(costMax),
    priceMax: round2(priceMax), discount: discPct, estado: estado, reasons: reasons,
    fees: {
      referralPct: round2(rates.referralPct), fbaFee: round2(rates.fbaFee),
      source: rates.source, partial: Boolean(rates.partial)
    },
    restrictions: restricted,
    buyBox: {
      kind: bbv.kind, note: bbv.note, rule: num(p.bbRule, 1) > 0,
      amazonShare: bbv.amazonShare, manufacturerShare: bbv.manufacturerShare,
      thirdShare: bbv.thirdShare, unknownShare: bbv.unknownShare,
      thirdSellers: bbv.thirdSellers, fbaSellers: fbaKnown ? fba : null,
      requireTwoSellers: twoSellers, singleSeller: singleSeller,
      breakdown: bbv.breakdown || []
    }
  };
}

module.exports = { TIERS, PLAN_DEFAULT, planParams, tierFor, planFor };
