"use strict";
const test = require("node:test");
const assert = require("node:assert");
const iy = require("../src/adapters/importyeti");

test("ImportYeti: la consulta se convierte en slug de producto", function () {
  assert.strictEqual(iy._slugify("blender manufacturer"), "blender");
  assert.strictEqual(iy._slugify("Cafetera exprés"), "cafetera-expres");
});

test("ImportYeti: un envio de aduanas se marca como fabrica con evidencia", function () {
  const it = iy._toItem({
    supplier_name: "Jing Bo Viet Nam",
    supplier_link: "/supplier/jing-bo-viet-nam",
    matching_shipments: 7336,
    specialization: 96.83,
    supplier_country_code: "VN",
    supplier_address: "Binh Duong Vietnam"
  });
  assert.strictEqual(it.name, "Jing Bo Viet Nam");
  assert.strictEqual(it.url, "https://www.importyeti.com/supplier/jing-bo-viet-nam");
  assert.strictEqual(it.supplierType, "fabrica");
  assert.strictEqual(it.factory, true);
  assert.strictEqual(it.evidence.kind, "customs");
  assert.strictEqual(it.evidence.shipments, 7336);
  assert.strictEqual(it.attrs.country, "VN");
  assert.strictEqual(it.price, null);
});

test("ImportYeti: sin clave no rompe, informa el motivo", async function () {
  const r = await iy.actions.search({ query: "blender" });
  assert.strictEqual(r.ok, false);
  assert.ok(r.reason === "importyeti_sin_clave" || r.reason === "sin_resultados");
});
