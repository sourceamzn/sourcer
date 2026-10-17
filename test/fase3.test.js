const { test } = require("node:test");
const assert = require("node:assert/strict");
const queries = require("../src/lib/queries");

function vias(list) {
  return list.map(function (x) { return x.via; });
}

test("queries: marca+titulo entra siempre y el modelo suelto no desplaza al titulo", () => {
  const list = queries.buildQueries({
    ean: "4006381333931",
    brand: "Acme",
    model: "ZX-200",
    name: "Acme ZX-200 taladro 18V",
    partNumber: "ZX200-P"
  }, { maxQueries: 5 });
  assert.ok(list.length <= 5);
  assert.ok(vias(list).indexOf("ean") !== -1);
  assert.ok(vias(list).indexOf("marca+modelo") !== -1);
  assert.ok(vias(list).indexOf("marca+titulo") !== -1);
  assert.equal(vias(list).indexOf("modelo"), -1);
});

test("queries: maximo duro de 5 consultas", () => {
  assert.equal(queries.MAX_QUERIES, 5);
  const list = queries.buildQueries({
    ean: "4006381333931",
    eans: ["8412345678905", "8412345678912"],
    brand: "Acme",
    model: "ZX-200",
    name: "Acme ZX-200 taladro 18V",
    partNumber: "ZX200-P"
  }, { maxQueries: 9 });
  assert.equal(list.length, 5);
});

test("queries: modelo suelto solo cuando no hay marca+modelo", () => {
  const list = queries.buildQueries({
    model: "ZX-200",
    name: "Taladro ZX-200 18V"
  }, { maxQueries: 5 });
  const v = vias(list);
  assert.ok(v.indexOf("modelo") !== -1);
  assert.ok(v.indexOf("titulo") !== -1);
  assert.equal(list.filter(function (x) { return x.via === "marca+modelo"; }).length, 0);
});

test("queries: sin marca, marca+titulo se convierte en titulo", () => {
  const list = queries.buildQueries({ model: "ZX-200", name: "Taladro ZX-200 18V" }, { maxQueries: 5 });
  assert.equal(list.filter(function (x) { return x.via === "marca+titulo"; }).length, 0);
  assert.ok(vias(list).indexOf("titulo") !== -1);
});

test("queries: joinUnique no duplica la marca si el titulo ya la contiene", () => {
  assert.equal(queries.joinUnique(["Acme", "Acme ZX-200 taladro"]), "Acme ZX-200 taladro");
  assert.equal(queries.joinUnique(["Acme", "ZX-200"]), "Acme ZX-200");
});
