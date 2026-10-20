"use strict";
const test = require("node:test");
const assert = require("node:assert");
const icecat = require("../src/adapters/icecat");

test("Icecat toma el primer GTIN del array, no los concatena", function () {
  const item = icecat._toItem({
    GeneralInfo: {
      GTIN: ["4948570114344", "4056572878642"],
      Brand: "iiyama",
      Title: "iiyama ProLite X4071UHSU-B1",
      BrandPartCode: "X4071UHSU-B1",
      Category: { Name: { Value: "Computer Monitors", Language: "EN" } }
    }
  });
  assert.strictEqual(item.ean, "4948570114344");
  assert.strictEqual(item.model, "X4071UHSU-B1");
  assert.strictEqual(item.brand, "iiyama");
  assert.strictEqual(item.attrs.category, "Computer Monitors");
});

test("Icecat acepta un GTIN suelto y no inventa codigo", function () {
  const item = icecat._toItem({ GeneralInfo: { GTIN: "4948570114344", Title: "X" } });
  assert.strictEqual(item.ean, "4948570114344");
  assert.strictEqual(icecat._toItem({ GeneralInfo: { Title: "X" } }).ean, "");
});
test("Icecat acepta GTINs como lista de objetos", function () {
  const item = icecat._toItem({ GeneralInfo: { GTINs: [{ GTIN: "4948570114344", IsApproved: true }, { GTIN: "4056572878642" }] } });
  assert.strictEqual(item.ean, "4948570114344");
  assert.deepStrictEqual(item.attrs.eans, ["4948570114344", "4056572878642"]);
});