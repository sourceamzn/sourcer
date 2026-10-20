const test = require("node:test");
const assert = require("node:assert");
const lidl = require("../src/adapters/lidl");

test("Lidl descarta alimentacion", function () {
  assert.strictEqual(lidl.isFood({ attrs: { category: "Food" } }), true);
  assert.strictEqual(lidl.isFood({ attrs: { category: "Categorías/Alimentación/Lácteos" } }), true);
  assert.strictEqual(lidl.isTarget({ attrs: { category: "Food" } }), false);
});

test("Lidl conserva menaje, herramientas y hogar", function () {
  assert.strictEqual(lidl.isTarget({ attrs: { category: "Categorías/Tienda de bricolaje/Taller/Herramientas" } }), true);
  assert.strictEqual(lidl.isTarget({ attrs: { category: "Categorías/Hogar y cocina/Pequeños electrodomésticos" } }), true);
  assert.strictEqual(lidl.isTarget({ attrs: { category: "Categorías/Jardín y barbacoa/Decoración" } }), true);
  assert.strictEqual(lidl.isTarget({ attrs: { category: "" } }), true);
});

test("Lidl conserva textil, juguetes y deporte", function () {
  assert.strictEqual(lidl.isTarget({ attrs: { category: "Categorías/Textiles/Camisetas" } }), true);
  assert.strictEqual(lidl.isTarget({ attrs: { category: "Categorías/El mundo de los niños/Juguetes" } }), true);
  assert.strictEqual(lidl.isTarget({ attrs: { category: "Categorías/Deportes/Fitness" } }), true);
});
