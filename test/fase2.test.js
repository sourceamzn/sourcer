const { test } = require("node:test");
const assert = require("node:assert/strict");
const buybox = require("../src/lib/buybox");
const coverage = require("../src/lib/coverage");
const plan = require("../src/lib/plan");
const identity = require("../src/lib/identity");

/* ---------- Buy Box 90 d ---------- */
const KEEPA_EPOCH_MIN = 21564000;
const DAY = 86400000;
function keepaMin(daysAgo) {
  return Math.floor((Date.now() - daysAgo * DAY) / 60000) - KEEPA_EPOCH_MIN;
}

test("buybox: Amazon domina el 90 d -> kind amazon", () => {
  const hist = [keepaMin(100), "A1AT7YVPFBWXBL", keepaMin(10), "A1AT7YVPFBWXBL"];
  const an = buybox.analyze(hist, 90);
  assert.equal(an.known, true);
  assert.equal(an.amazonOnly, true);
  assert.equal(buybox.verdict(an, "", "Acme").kind, "amazon");
});
test("buybox: un unico vendedor con nombre de marca -> fabricante", () => {
  const hist = [keepaMin(80), "SELLER-1", keepaMin(5), "SELLER-1"];
  const an = buybox.analyze(hist, 90);
  assert.equal(an.topShare, 1);
  assert.equal(buybox.verdict(an, "Acme Official", "Acme").kind, "fabricante");
  assert.equal(buybox.verdict(an, "Random Store", "Acme").kind, "a_revisar");
});
test("buybox: sin historial no inventa (sin_dato) y no bloquea", () => {
  assert.equal(buybox.analyze([], 90).known, false);
  assert.equal(buybox.verdict({ known: false }, "", "Acme").kind, "sin_dato");
  assert.equal(buybox.isBrandSeller("", "Acme"), null);
});
test("buybox: los tramos de -1/-2 (sin Buy Box) no cuentan", () => {
  const hist = [keepaMin(80), "-1", keepaMin(5), "-1"];
  assert.equal(buybox.analyze(hist, 90).known, false);
});
test("buybox: fabricante por manufacturer y sufijos societarios", () => {
  assert.equal(buybox.isManufacturerSeller("ACME, S.L.", "", "Acme"), true);
  assert.equal(buybox.isManufacturerSeller("Acme GmbH", "Acme", "Acme Manufacturing"), true);
  assert.equal(buybox.isManufacturerSeller("Acme Ltd.", "Acme", ""), true);
  assert.equal(buybox.isManufacturerSeller("Random Store", "Acme", "Acme"), false);
  assert.equal(buybox.isManufacturerSeller("", "Acme", "Acme"), null);
});
test("buybox: desglose Amazon/fabricante/terceros con vendedores distintos", () => {
  const hist = [
    keepaMin(90), "A1AT7YVPFBWXBL",
    keepaMin(60), "SELLER-M",
    keepaMin(30), "SELLER-T"
  ];
  const an = buybox.analyze(hist, 90, undefined, {
    brand: "Acme", manufacturer: "Acme",
    sellerNames: { "A1AT7YVPFBWXBL": "Amazon", "SELLER-M": "Acme SL", "SELLER-T": "Random Store" }
  });
  assert.equal(an.classified, true);
  assert.equal(an.sellers, 3);
  assert.equal(an.thirdSellers, 1);
  assert.ok(Math.abs(an.amazonShare - 0.333) < 0.01);
  assert.ok(Math.abs(an.manufacturerShare - 0.333) < 0.01);
  assert.ok(Math.abs(an.thirdShare - 0.333) < 0.01);
  assert.equal(an.breakdown.filter((x) => x.role === "fabricante").length, 1);
});
test("buybox: Amazon + fabricante >= 95 % no apto", () => {
  const an = {
    known: true, classified: true, amazonShare: 0.4, manufacturerShare: 0.55,
    thirdShare: 0, unknownShare: 0, thirdSellers: 0, topThirdShare: 0, sellers: 2
  };
  assert.equal(buybox.verdict(an, "", "Acme", "Acme").kind, "amazon+fabricante");
});
test("buybox: terceros < 5 % no apto", () => {
  const an = {
    known: true, classified: true, amazonShare: 0.5, manufacturerShare: 0.44,
    thirdShare: 0.04, unknownShare: 0, thirdSellers: 1, topThirdShare: 0.04, sellers: 3
  };
  assert.equal(buybox.verdict(an, "", "Acme", "Acme").kind, "terceros");
});

/* ---------- planFor: formula y regla Buy Box configurable ---------- */
test("plan: sin coste maximo positivo descarta siempre", () => {
  const p = plan.planFor({ pvp: 1, sales: 20 }, plan.PLAN_DEFAULT);
  assert.equal(p.costMax, 0);
  assert.equal(p.estado, "descarte");
});
test("plan: Buy Box solo Amazon descarta con bbRule=1 y solo avisa con bbRule=0", () => {
  const m = { pvp: 50, sales: 20, buyBox: { known: true, amazonOnly: true, amazonShare: 1, topShare: 1 }, brand: "Acme" };
  const on = plan.planFor(m, plan.PLAN_DEFAULT);
  assert.equal(on.costMax > 0, true);
  assert.equal(on.buyBox.kind, "amazon");
  assert.equal(on.estado, "descarte");
  const off = plan.planFor(m, Object.assign({}, plan.PLAN_DEFAULT, { bbRule: 0 }));
  assert.equal(off.estado, "apt");
  assert.equal(off.buyBox.rule, false);
});
test("plan: Buy Box solo fabricante se trata igual y es configurable", () => {
  const m = { pvp: 50, sales: 20, buyBox: { known: true, amazonShare: 0, topShare: 1 }, sellerName: "Acme SL", brand: "Acme" };
  assert.equal(plan.planFor(m, plan.PLAN_DEFAULT).estado, "descarte");
  assert.equal(plan.planFor(m, Object.assign({}, plan.PLAN_DEFAULT, { bbRule: 0 })).estado, "apt");
});
test("plan: sin dato de Buy Box no se descarta", () => {
  const m = { pvp: 50, sales: 20, buyBox: { known: false }, brand: "Acme" };
  const p = plan.planFor(m, plan.PLAN_DEFAULT);
  assert.equal(p.buyBox.kind, "sin_dato");
  assert.equal(p.estado, "apt");
});
test("plan: Amazon + fabricante >= 95 % descarta", () => {
  const m = {
    pvp: 50, sales: 20, brand: "Acme", manufacturer: "Acme",
    buyBox: { known: true, classified: true, amazonShare: 0.4, manufacturerShare: 0.56, thirdShare: 0.04, unknownShare: 0, thirdSellers: 1, topThirdShare: 0.04, sellers: 3 }
  };
  const p = plan.planFor(m, plan.PLAN_DEFAULT);
  assert.equal(p.buyBox.kind, "amazon+fabricante");
  assert.equal(p.estado, "descarte");
  assert.ok(p.reasons.join(" ").indexOf("No hay hueco") !== -1);
});
test("plan: terceros < 5 % descarta", () => {
  const m = {
    pvp: 50, sales: 20, brand: "Acme",
    buyBox: { known: true, classified: true, amazonShare: 0.5, manufacturerShare: 0.44, thirdShare: 0.04, unknownShare: 0, thirdSellers: 1, topThirdShare: 0.04, sellers: 3 }
  };
  assert.equal(plan.planFor(m, plan.PLAN_DEFAULT).estado, "descarte");
});
test("plan: un unico tercero con la Buy Box (97 %) no es oportunidad: no se comparte (regla del cliente)", () => {
  const m = {
    pvp: 50, sales: 20, brand: "Acme",
    buyBox: { known: true, classified: true, amazonShare: 0, manufacturerShare: 0, thirdShare: 0.97, unknownShare: 0, thirdSellers: 1, topThirdShare: 0.97, sellers: 1 }
  };
  const normal = plan.planFor(m, plan.PLAN_DEFAULT);
  assert.equal(normal.buyBox.kind, "a_revisar");
  assert.equal(normal.estado, "descarte");
  assert.equal(normal.buyBox.requireTwoSellers, false);
  const strict = plan.planFor(m, Object.assign({}, plan.PLAN_DEFAULT, { requireTwoSellers: 1 }));
  assert.equal(strict.estado, "descarte");
  assert.ok(strict.reasons.join(" ").indexOf("2 vendedores distintos") !== -1);
  const off = plan.planFor(m, Object.assign({}, plan.PLAN_DEFAULT, { bbRule: 0 }));
  assert.equal(off.estado, "apt");
});
test("plan: menos de 2 vendedores FBA descarta; 2 o mas no bloquea", () => {
  const base = { pvp: 50, sales: 20, brand: "Acme" };
  const one = plan.planFor(Object.assign({}, base, { offersFba: 1 }), plan.PLAN_DEFAULT);
  assert.equal(one.estado, "descarte");
  assert.ok(one.reasons.join(" ").indexOf("2 FBA") !== -1);
  const two = plan.planFor(Object.assign({}, base, { offersFba: 2 }), plan.PLAN_DEFAULT);
  assert.equal(two.estado, "apt");
  const off = plan.planFor(Object.assign({}, base, { offersFba: 1 }), Object.assign({}, plan.PLAN_DEFAULT, { bbRule: 0 }));
  assert.equal(off.estado, "casi");
});
test("plan: exige 2 FBA de terceros y no cuenta Amazon", () => {
  const base = { pvp: 50, sales: 20, brand: "Acme", offersFba: 2, amazonSells: true, fbaThird: 1 };
  const one = plan.planFor(base, plan.PLAN_DEFAULT);
  assert.equal(one.estado, "descarte");
  assert.ok(one.reasons.join(" ").indexOf("FBA de terceros") !== -1);
  const two = plan.planFor(Object.assign({}, base, { fbaThird: 2 }), plan.PLAN_DEFAULT);
  assert.equal(two.estado, "apt");
  assert.equal(two.buyBox.fbaThirdSellers, 2);
});
test("planParams: lee bbRule de params o filters y mantiene el resto a 0", () => {
  assert.equal(plan.planParams({ filters: { bbRule: 0 } }).bbRule, 0);
  assert.equal(plan.planParams({ params: { bbRule: "0" } }).bbRule, 0);
  assert.equal(plan.planParams({}).bbRule, 1);
  const p = plan.planParams({});
  assert.equal(p.minBB, 0);
  assert.equal(p.minSales, 0);
  assert.equal(p.minFba, 2);
});

/* ---------- cobertura por busqueda ---------- */
test("coverage: cuenta fuentes, resultados y descartes sin inventar", () => {
  const cv = coverage.buildCoverage({
    searched: [
      { source: "a", ok: true, count: 3, rawCount: 8, queryStats: [{ via: "ean", raw: 5, kept: 2 }, { via: "marca+modelo", raw: 3, kept: 1 }] },
      { source: "b", ok: false, reason: "tiempo_agotado", count: 0 },
      { source: "c", ok: false, reason: "sin_resultados", count: 0 },
      { source: "d", ok: false, reason: "apify_http_403", count: 0 }
    ],
    rejected: [
      { kind: "identidad" }, { reason: "EAN distinto: es otro producto." },
      { kind: "tipo" }, { reason: "No es un producto (enlace de menu o pagina legal)." }
    ],
    matches: [{ state: "verificado" }, { state: "candidato" }, { match: "probable" }],
    queries: [{ via: "ean" }, { via: "marca+modelo" }, { via: "titulo_en" }],
    identity: { ean: "4006381333931", brand: "Acme", models: ["zx200"] }
  });
  assert.equal(cv.sources.total, 4);
  assert.equal(cv.sources.responded, 1);
  assert.equal(cv.sources.timeout, 1);
  assert.equal(cv.sources.empty, 1);
  assert.equal(cv.sources.error, 1);
  assert.equal(cv.sources.coveragePct, 25);
  assert.equal(cv.results.raw, 8);
  assert.equal(cv.results.kept, 3);
  assert.equal(cv.results.dropped, 5);
  assert.equal(cv.results.rejected, 4);
  assert.equal(cv.results.matches, 3);
  assert.equal(cv.rejected.identity, 2);
  assert.equal(cv.rejected.type, 1);
  assert.equal(cv.rejected.junk, 1);
  assert.equal(cv.queries.planned, 3);
  assert.equal(cv.queries.used, 2);
  assert.equal(cv.identity.strength, "alta");
  assert.match(cv.note, /1\/4/);
});
test("coverage: sin datos devuelve ceros y no revienta", () => {
  const cv = coverage.buildCoverage({});
  assert.equal(cv.sources.total, 0);
  assert.equal(cv.sources.coveragePct, 0);
  assert.equal(cv.results.raw, 0);
  assert.equal(cv.queries.used, 0);
  assert.equal(cv.identity.strength, "muy_baja");
});

/* ---------- identidad: puntuacion ponderada sin EAN ---------- */
test("identity: marca+modelo sin EAN da 85 puntos y estado verificado", () => {
  const src = identity.identityOf({ brand: "Acme", name: "Acme ZX-200 taladro 18V" });
  const cmp = identity.compare(src, { name: "Acme ZX-200 taladro", brand: "Acme" });
  assert.equal(cmp.eanOk, false);
  assert.equal(cmp.verdict, "probable");
  assert.equal(cmp.score, 85);
  assert.equal(identity.stateOf({}, cmp), "verificado");
});
test("identity: un conflicto de pack limita el score a 20", () => {
  const src = identity.identityOf({ brand: "Acme", name: "Acme ZX-200 taladro pack de 2" });
  const cmp = identity.compare(src, { name: "Acme ZX-200 taladro pack de 4", brand: "Acme" });
  assert.equal(cmp.verdict, "variante");
  assert.ok(cmp.score <= 20);
});
test("identity: EAN correcto puntua 100 y gana a cualquier combinacion sin EAN", () => {
  const src = identity.identityOf({ ean: "4006381333931", brand: "Acme", name: "Acme ZX-200" });
  const cmp = identity.compare(src, { name: "Acme ZX-200", brand: "Acme", ean: "4006381333931" });
  assert.equal(cmp.verdict, "exacto");
  assert.equal(cmp.score, 100);
  assert.equal(identity.stateOf({}, cmp), "verificado");
});
