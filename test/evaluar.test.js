const test = require("node:test");
const assert = require("node:assert/strict");

const evaluar = require("../scripts/evaluar");

function verifiedOffer(overrides) {
  return Object.assign({
    source: "bigbuy",
    sourceLabel: "BigBuy",
    name: "Producto de prueba",
    price: 10,
    ean: "1234567890123",
    url: "https://www.bigbuy.eu/es/producto.html",
    match: "exacto",
    matchBand: "verificado",
    state: "verificado",
    matchScore: 100
  }, overrides || {});
}

function candidateOffer(overrides) {
  return Object.assign({
    source: "web",
    sourceLabel: "Mayorista",
    name: "Producto parecido",
    price: 9,
    url: "https://mayorista.example/producto",
    match: "equivalente",
    matchBand: "revisar",
    state: "candidato",
    matchScore: 60
  }, overrides || {});
}

test("parseCsv admite punto y coma, comillas y comentarios", function () {
  const text = "\uFEFF# comentario\nasin;nombre;notas\nB000000001;\"Secador, 2000 W\";\"dice \"\"hola\"\"\"\n";
  const rows = evaluar.parseCsv(text);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], ["asin", "nombre", "notas"]);
  assert.deepEqual(rows[1], ["B000000001", "Secador, 2000 W", 'dice "hola"']);
});

test("readCsv normaliza cabeceras con acentos y espacios", function () {
  const parsed = evaluar.readCsv("ASIN;Marca;Modelo;Precio máximo\nB000000001;Marca X;M-1;12,50\n");
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].precio_maximo, "12,50");
});

test("normalizeRow mapea espanol/ingles y convierte numeros europeos", function () {
  const row = evaluar.normalizeRow({
    asin: " b000000001 ",
    ean: "1234-5678-9012-3",
    marca: "Marca X",
    modelo: "M-1",
    proveedor_esperado: "BigBuy",
    precio_esperado: "1.234,56",
    precio_max: "12,50"
  });
  assert.equal(row.asin, "B000000001");
  assert.equal(row.ean, "1234567890123");
  assert.equal(row.supplier, "BigBuy");
  assert.equal(row.expectedPrice, 1234.56);
  assert.equal(row.priceMax, 12.5);
});

test("validateRow exige identidad y valida ASIN/EAN", function () {
  assert.equal(evaluar.validateRow(evaluar.normalizeRow({ nombre: "solo nombre" })).length, 1);
  assert.equal(evaluar.validateRow(evaluar.normalizeRow({ asin: "CORTO" })).length, 1);
  assert.equal(evaluar.validateRow(evaluar.normalizeRow({ ean: "123" })).length, 1);
  assert.equal(evaluar.validateRow(evaluar.normalizeRow({ asin: "B000000001" })).length, 0);
  assert.equal(evaluar.validateRow(evaluar.normalizeRow({ ean: "1234567890123" })).length, 0);
});

test("supplierMatches compara nombre, fuente y dominio", function () {
  const offer = verifiedOffer();
  assert.equal(evaluar.supplierMatches("BigBuy", offer), true);
  assert.equal(evaluar.supplierMatches("bigbuy.eu", offer), true);
  assert.equal(evaluar.supplierMatches("Otro", offer), false);
  assert.equal(evaluar.supplierMatches("", offer), false);
});

test("pickBest separa verificadas de candidatas y descarta las que superan el maximo", function () {
  const best = evaluar.pickBest([
    verifiedOffer({ price: 12 }),
    verifiedOffer({ price: 8, over: true }),
    candidateOffer({ price: 5 })
  ]);
  assert.equal(best.verifiedAll.length, 1);
  assert.equal(best.verified.price, 12);
  assert.equal(best.review.price, 5);
});

test("evaluateRow marca verificado con EAN exacto y proveedor esperado", function () {
  const row = evaluar.normalizeRow({
    asin: "B000000001",
    ean: "1234567890123",
    proveedor_esperado: "BigBuy",
    precio_max: "15"
  });
  const out = evaluar.evaluateRow(row, {
    state: "done",
    result: {
      matches: [verifiedOffer()],
      coverage: { sources: { coveragePct: 75 }, identity: { strength: "alta" } }
    }
  });
  assert.equal(out.verdict, "verificado");
  assert.equal(out.eanExact, true);
  assert.equal(out.supplierVerified, true);
  assert.equal(out.underMax, true);
  assert.equal(out.coveragePct, 75);
});

test("evaluateRow deja en solo_revisar cuando no hay verificado", function () {
  const row = evaluar.normalizeRow({ asin: "B000000001" });
  const out = evaluar.evaluateRow(row, {
    state: "done",
    result: {
      matches: [candidateOffer()],
      coverage: { sources: { coveragePct: 50 }, identity: { strength: "media" } }
    }
  });
  assert.equal(out.verdict, "solo_revisar");
  assert.equal(out.weakVerified, false);
  assert.equal(out.supplierVerified, null);
});

test("evaluateRow avisa de verificado con identidad debil", function () {
  const row = evaluar.normalizeRow({ asin: "B000000001" });
  const out = evaluar.evaluateRow(row, {
    state: "done",
    result: {
      matches: [verifiedOffer()],
      coverage: { sources: { coveragePct: 40 }, identity: { strength: "baja" } }
    }
  });
  assert.equal(out.verdict, "verificado");
  assert.equal(out.weakVerified, true);
});

test("evaluateRow no cuenta ofertas por encima del maximo", function () {
  const row = evaluar.normalizeRow({ asin: "B000000001", precio_max: "5" });
  const out = evaluar.evaluateRow(row, {
    state: "done",
    result: {
      matches: [verifiedOffer({ price: 20, over: true })],
      coverage: { sources: { coveragePct: 40 }, identity: { strength: "alta" } }
    }
  });
  assert.equal(out.verdict, "no_encontrado");
  assert.equal(out.price, null);
});

test("summarize agrega veredictos, EAN exacto y recobrado de proveedor", function () {
  const results = [
    { verdict: "verificado", eanExact: true, weakVerified: false, expectedSupplier: "BigBuy", supplierVerified: true, coveragePct: 80, rejectedTop: [{ kind: "identidad", count: 2, sample: "x" }] },
    { verdict: "verificado", eanExact: false, weakVerified: true, expectedSupplier: "BigBuy", supplierVerified: false, coveragePct: 60, rejectedTop: [] },
    { verdict: "solo_revisar", eanExact: false, weakVerified: false, expectedSupplier: "", supplierVerified: null, coveragePct: 40, rejectedTop: [{ kind: "tipo", count: 1, sample: "y" }] },
    { verdict: "no_encontrado", eanExact: false, weakVerified: false, expectedSupplier: "", supplierVerified: null, coveragePct: 20, rejectedTop: [] }
  ];
  const summary = evaluar.summarize(results);
  assert.equal(summary.total, 4);
  assert.equal(summary.verificado, 2);
  assert.equal(summary.soloRevisar, 1);
  assert.equal(summary.noEncontrado, 1);
  assert.equal(summary.eanExact, 1);
  assert.equal(summary.weakVerified, 1);
  assert.equal(summary.supplierExpected, 2);
  assert.equal(summary.supplierHit, 1);
  assert.equal(summary.supplierRecall, 50);
  assert.equal(summary.avgCoverage, 50);
  assert.equal(summary.topRejected[0].kind, "identidad");
});

test("parseArgs acepta opciones y URL sin barra final", function () {
  const opts = evaluar.parseArgs(["--csv", "lista.csv", "--base", "https://x.test/", "--limit", "3", "--dry-run"]);
  assert.equal(opts.csv, "lista.csv");
  assert.equal(opts.base, "https://x.test");
  assert.equal(opts.limit, 3);
  assert.equal(opts.dryRun, true);
});
