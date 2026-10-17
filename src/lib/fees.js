"use strict";
/* Tarifas reales de Amazon por producto (Fase 5).
   - Keepa: `referralFeePercent` (tanto por ciento) y `fbaFees.pickAndPackFee`
     (centimos). Se leen de forma defensiva: cualquier valor ausente, no
     numerico o centinela (-1/-2) queda como "sin dato".
   - SP-API: `getMyFeesEstimate` devuelve una lista de conceptos; de ahi se
     derivan el % de referencia y la tarifa FBA.
   La formula de precio maximo sigue en lib/plan.js: aqui solo se normalizan
   los datos, sin decidir nada ni inventar cifras. */

const DEFAULTS = { referral: 15, fbaFee: 3.5 };

function round2(n) {
  return Math.round((isFinite(n) ? n : 0) * 100) / 100;
}
function validPct(v) {
  const n = Number(v);
  if (!isFinite(n) || n < 0 || n > 100) return null;
  return round2(n);
}
function validFee(v) {
  const n = Number(v);
  if (!isFinite(n) || n < 0 || n > 1000) return null;
  return round2(n);
}

/* Lee las tarifas que Keepa adjunta al producto (misma peticion `product`). */
function fromKeepa(prod) {
  const out = { referralPct: null, fbaFee: null, storageFee: null, source: "keepa", missing: [] };
  if (!prod || typeof prod !== "object") { out.missing.push("product"); return out; }
  const rp = validPct(prod.referralFeePercent);
  if (rp == null) out.missing.push("referralFeePercent"); else out.referralPct = rp;

  const f = prod.fbaFees;
  if (f && typeof f === "object") {
    const pp = validFee(Number(f.pickAndPackFee) / 100);
    if (pp == null) out.missing.push("fbaFees.pickAndPackFee"); else out.fbaFee = pp;
    const st = validFee(Number(f.storageFee) / 100);
    if (st != null) out.storageFee = st;
  } else {
    out.missing.push("fbaFees");
  }
  return out;
}

/* Deriva las tarifas de la respuesta de SP-API getMyFeesEstimate. */
function fromEstimate(data, price) {
  const out = { referralPct: null, fbaFee: null, total: null, currency: "", source: "spapi", missing: [] };
  let list = null;
  try { list = data.payload.FeesEstimateResult.FeesEstimate.FeeDetailList; } catch (e) {}
  if (!Array.isArray(list)) { out.missing.push("FeeDetailList"); return out; }

  let referral = null, fba = 0, hasFba = false, total = 0;
  list.forEach(function (x) {
    const t = String((x && x.FeeType) || "");
    const amount = x && x.FeeAmount;
    const amt = Number(amount && amount.Amount);
    if (!isFinite(amt)) return;
    total += amt;
    if (!out.currency && amount && amount.CurrencyCode) out.currency = String(amount.CurrencyCode);
    if (t === "ReferralFee") referral = amt;
    if (t === "FBAFees") { fba += amt; hasFba = true; }
  });

  const p = Number(price);
  if (referral != null && isFinite(p) && p > 0) out.referralPct = round2((referral / p) * 100);
  else out.missing.push("ReferralFee");
  if (hasFba) out.fbaFee = round2(fba); else out.missing.push("FBAFees");
  out.total = round2(total);
  return out;
}

/* Restricciones de listado (Listings Restrictions API) -> avisos legibles. */
function restrictionsFrom(data) {
  let list = null;
  try { list = data.payload.restrictions; } catch (e) {}
  if (!Array.isArray(list)) return [];
  const seen = {};
  const out = [];
  list.forEach(function (r) {
    const reasons = (r && r.reasons) || [];
    if (!Array.isArray(reasons)) return;
    reasons.forEach(function (x) {
      const msg = String((x && (x.message || x.reasonCode)) || "").trim();
      if (msg && !seen[msg]) { seen[msg] = 1; out.push(msg); }
    });
  });
  return out;
}

/* Elige tarifas reales si existen y completa con los valores por defecto.
   Acepta `m.fees` o, en una ficha manual, `m.referralFeePercent`/`m.fbaFee`. */
function resolve(m, p) {
  const params = p || {};
  const base = {
    referralPct: validFee(params.referral) != null ? round2(Number(params.referral)) : DEFAULTS.referral,
    fbaFee: validFee(params.fbaFee) != null ? round2(Number(params.fbaFee)) : DEFAULTS.fbaFee
  };
  let f = m && m.fees && typeof m.fees === "object" ? m.fees : null;
  if (!f && m && (m.referralFeePercent != null || m.fbaFee != null)) {
    f = { referralPct: m.referralFeePercent, fbaFee: m.fbaFee, source: m.feesSource || "manual" };
  }
  if (!f) return Object.assign({}, base, { source: "estimado", partial: true });

  const rp = validPct(f.referralPct != null ? f.referralPct : f.referralFeePercent);
  const ff = validFee(f.fbaFee != null ? f.fbaFee : f.pickAndPackFee);
  if (rp == null && ff == null) return Object.assign({}, base, { source: "estimado", partial: true });

  return {
    referralPct: rp == null ? base.referralPct : rp,
    fbaFee: ff == null ? base.fbaFee : ff,
    source: String(f.source || "real"),
    partial: rp == null || ff == null
  };
}

module.exports = { DEFAULTS, fromKeepa, fromEstimate, restrictionsFrom, resolve, validPct, validFee };
