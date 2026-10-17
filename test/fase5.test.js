const { test } = require("node:test");
const assert = require("node:assert/strict");
const fees = require("../src/lib/fees");
const plan = require("../src/lib/plan");
const retry = require("../src/lib/retry");

/* ---------- fees: lectura defensiva de Keepa ---------- */
test("fees: Keepa con referralFeePercent y fbaFees en centimos", () => {
  const f = fees.fromKeepa({ referralFeePercent: 15, fbaFees: { pickAndPackFee: 350 } });
  assert.equal(f.referralPct, 15);
  assert.equal(f.fbaFee, 3.5);
  assert.equal(f.source, "keepa");
  assert.deepEqual(f.missing, []);
});
test("fees: centinelas y campos ausentes quedan sin dato, no en 0", () => {
  const f = fees.fromKeepa({ referralFeePercent: -1, fbaFees: { pickAndPackFee: -2 } });
  assert.equal(f.referralPct, null);
  assert.equal(f.fbaFee, null);
  assert.ok(f.missing.indexOf("referralFeePercent") !== -1);
  assert.ok(f.missing.indexOf("fbaFees.pickAndPackFee") !== -1);
});
test("fees: producto sin fbaFees no inventa tarifa", () => {
  const f = fees.fromKeepa({ referralFeePercent: 8 });
  assert.equal(f.referralPct, 8);
  assert.equal(f.fbaFee, null);
  assert.ok(f.missing.indexOf("fbaFees") !== -1);
});
test("fees: resolve usa lo real y completa lo que falte con el PDF", () => {
  const p = { referral: 15, fbaFee: 3.5 };
  const full = fees.resolve({ fees: { referralPct: 8, fbaFee: 5, source: "keepa" } }, p);
  assert.equal(full.referralPct, 8);
  assert.equal(full.fbaFee, 5);
  assert.equal(full.partial, false);
  const half = fees.resolve({ fees: { referralPct: 10 } }, p);
  assert.equal(half.referralPct, 10);
  assert.equal(half.fbaFee, 3.5);
  assert.equal(half.partial, true);
  const none = fees.resolve({}, p);
  assert.equal(none.source, "estimado");
  assert.equal(none.referralPct, 15);
  assert.equal(none.fbaFee, 3.5);
});

/* ---------- fees: respuesta de SP-API ---------- */
test("fees: fromEstimate deriva % de referencia y tarifa FBA", () => {
  const data = {
    payload: {
      FeesEstimateResult: {
        FeesEstimate: {
          FeeDetailList: [
            { FeeType: "ReferralFee", FeeAmount: { Amount: 15, CurrencyCode: "EUR" } },
            { FeeType: "FBAFees", FeeAmount: { Amount: 4.2, CurrencyCode: "EUR" } },
            { FeeType: "VariableClosingFee", FeeAmount: { Amount: 0, CurrencyCode: "EUR" } }
          ]
        }
      }
    }
  };
  const f = fees.fromEstimate(data, 100);
  assert.equal(f.referralPct, 15);
  assert.equal(f.fbaFee, 4.2);
  assert.equal(f.total, 19.2);
  assert.equal(f.currency, "EUR");
  assert.equal(f.source, "spapi");
});
test("fees: fromEstimate sin FeeDetailList no rompe", () => {
  const f = fees.fromEstimate({ payload: {} }, 50);
  assert.equal(f.referralPct, null);
  assert.equal(f.fbaFee, null);
  assert.ok(f.missing.indexOf("FeeDetailList") !== -1);
});

/* ---------- restricciones de listado ---------- */
test("fees: restrictionsFrom aplana y deduplica motivos", () => {
  const rs = fees.restrictionsFrom({
    payload: {
      restrictions: [
        { reasons: [{ reasonCode: "APPROVAL_REQUIRED", message: "Aprobacion requerida" }, { message: "Marca restringida" }] },
        { reasons: [{ message: "Aprobacion requerida" }] }
      ]
    }
  });
  assert.deepEqual(rs, ["Aprobacion requerida", "Marca restringida"]);
});
test("fees: sin restricciones devuelve lista vacia", () => {
  assert.deepEqual(fees.restrictionsFrom({ payload: { restrictions: [] } }), []);
  assert.deepEqual(fees.restrictionsFrom({}), []);
});

/* ---------- plan: tarifas reales y avisos ---------- */
test("plan: usa la tarifa real en vez de la estimacion y lo indica", () => {
  const p = Object.assign({}, plan.PLAN_DEFAULT);
  const m = {
    pvp: 121, sales: 20,
    fees: { referralPct: 8, fbaFee: 5, source: "keepa" }
  };
  const r = plan.planFor(m, p);
  assert.equal(r.fees.referralPct, 8);
  assert.equal(r.fees.fbaFee, 5);
  assert.equal(r.fees.source, "keepa");
  assert.equal(r.fees.partial, false);
  assert.equal(r.referral, 8);
  assert.ok(Math.abs(r.feesReal - 16.03) < 0.01);
  assert.equal(r.estado, "apt");
});
test("plan: sin tarifas reales marca la estimacion", () => {
  const r = plan.planFor({ pvp: 121, sales: 20 }, plan.PLAN_DEFAULT);
  assert.equal(r.fees.source, "estimado");
  assert.equal(r.fees.referralPct, 15);
  assert.equal(r.fees.fbaFee, 3.5);
  assert.equal(r.referral, 15);
});
test("plan: restricciones de listado son aviso, nunca descarte", () => {
  const m = { pvp: 50, sales: 20, restrictions: ["Aprobacion requerida"] };
  const r = plan.planFor(m, plan.PLAN_DEFAULT);
  assert.equal(r.estado, "casi");
  assert.ok(r.reasons.join(" ").indexOf("Restricciones de Amazon") !== -1);
  assert.equal(plan.planFor({ pvp: 50, sales: 20 }, plan.PLAN_DEFAULT).estado, "apt");
});

/* ---------- SP-API: reintentos ---------- */
test("spapi: 429 y 5xx son reintentables; 400/404 no", () => {
  assert.equal(retry.retryable(429), true);
  assert.equal(retry.retryable(503), true);
  assert.equal(retry.retryable(0), true);
  assert.equal(retry.retryable(400), false);
  assert.equal(retry.retryable(404), false);
});
test("spapi: backoff respeta Retry-After y crece con jitter", () => {
  assert.equal(retry.backoffMs(0, "2", 600), 2000);
  assert.ok(retry.backoffMs(0, "0.5", 600) === 500);
  const b = retry.backoffMs(1, null, 600);
  assert.ok(b >= 900 && b <= 1500);
  const capped = retry.backoffMs(9, null, 600);
  assert.ok(capped >= 6000 && capped <= 10000);
});
