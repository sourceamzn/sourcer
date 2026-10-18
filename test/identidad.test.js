const { test } = require("node:test");
const assert = require("node:assert/strict");
const identity = require("../src/lib/identity");
const match = require("../src/lib/match");
const specs = require("../src/lib/specs");
const casos = require("./fixtures/identidad.json");

function card(o) {
  return identity.identityOf(o || {});
}

/* Tabla de decision: cada fila del fixture es un contrato verificable. */
test("identidad: tabla de decision origen vs oferta", () => {
  casos.forEach(function (c) {
    const r = identity.decideIdentity(card(c.src), c.offer, c.ctx || {});
    const e = c.expect || {};
    if (e.verdict) assert.equal(r.verdict, e.verdict, c.name + ": veredicto");
    if (e.notVerdict) assert.notEqual(r.verdict, e.notVerdict, c.name + ": no debe ser " + e.notVerdict);
    if (e.eanOk != null) assert.equal(r.eanOk, e.eanOk, c.name + ": eanOk");
    if (e.strongConflict != null) assert.equal(r.strongConflict, e.strongConflict, c.name + ": strongConflict");
    if (e.noTextMatch != null) assert.equal(r.noTextMatch, e.noTextMatch, c.name + ": noTextMatch");
    (e.conflicts || []).forEach(function (k) {
      assert.ok(r.conflicts.indexOf(k) !== -1, c.name + ": falta el conflicto " + k);
    });
    if (e.conflicts && !e.conflicts.length) assert.equal(r.conflicts.length, 0, c.name + ": no debe haber conflictos");
  });
});

/* Una sola funcion de decision: match.score no puede tener reglas propias. */
test("identidad: match.score delega en decideIdentity", () => {
  const src = card({ brand: "Acme", model: "ZX-200", name: "Acme ZX-200 soporte negro" });
  const offer = { name: "Acme ZX-200 soporte blanco" };
  const ctx = { typeOk: true };
  assert.deepEqual(match.score(src, offer, ctx), identity.decideIdentity(src, offer, ctx));
});

test("identidad: especificacion clave distinta descarta", () => {
  const src = card({ brand: "Acme", model: "ZX-200", name: "Acme ZX-200", features: ["Capacidad: 500 ml"] });
  const s = specs.fromSource({ features: ["Capacidad: 500 ml"] });
  const r = identity.decideIdentity(src, { name: "Acme ZX-200", features: ["Capacidad: 750 ml"] }, { specs: s });
  assert.equal(r.verdict, "descartar");
  assert.equal(r.specConflict, true);
  assert.ok(r.conflicts.indexOf("spec") !== -1);
});

test("identidad: especificacion igual suma y permite verificar", () => {
  const src = card({ brand: "Acme", model: "ZX-200", name: "Acme ZX-200", features: ["Capacidad: 500 ml"] });
  const s = specs.fromSource({ features: ["Capacidad: 500 ml"] });
  const r = identity.decideIdentity(src, { name: "Acme ZX-200", features: ["Capacidad: 500 ml"] }, { specs: s });
  assert.equal(r.verdict, "verificado");
  assert.equal(r.specConflict, false);
});

test("identidad: compare conserva los nombres historicos", () => {
  const src = card({ ean: "4006381333931", brand: "Sony", model: "WH-1000XM5", name: "Sony WH-1000XM5" });
  assert.equal(identity.compare(src, { name: "Sony WH-1000XM5", ean: "4006381333931" }).verdict, "exacto");
  assert.equal(identity.compare(src, { name: "Sony WH-1000XM5" }).verdict, "probable");
  const negro = card({ brand: "Sony", model: "WH-1000XM5", name: "Sony WH-1000XM5 negro" });
  const cmp = identity.compare(negro, { name: "Sony WH-1000XM5 blanco" });
  assert.equal(cmp.verdict, "variante");
  assert.ok(cmp.conflicts.indexOf("color") !== -1);
  assert.equal(identity.compare(src, { name: "Sony WH-1000XM5", ean: "8412345678905" }).verdict, "distinto");
});

/* Un dato ausente nunca inventa un conflicto. */
test("identidad: atributo no declarado no descarta", () => {
  const src = card({ brand: "Acme", model: "ZX-200", name: "Acme ZX-200 soporte negro talla M pack de 2" });
  const r = identity.decideIdentity(src, { name: "Acme ZX-200" });
  assert.equal(r.verdict, "verificado");
  ["size", "color", "quantity"].forEach(function (k) {
    assert.equal(r.conflicts.indexOf(k), -1, "no debe haber conflicto " + k);
  });
});
