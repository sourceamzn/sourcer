const test = require("node:test");
const assert = require("node:assert");
const lidl = require("../src/adapters/lidl");

test("Lidl descarta alimentacion", function () {
  assert.strictEqual(lidl.isFood({ attrs: { category: "Food" } }), true);
  assert.strictEqual(lidl.isFood({ attrs: { category: "Categorías/Alimentación/Lácteos" } }), true);
});

test("Lidl conserva menaje, herramientas y hogar", function () {
  assert.strictEqual(lidl.isFood({ attrs: { category: "Categorías/Tienda de bricolaje/Taller/Herramientas" } }), false);
  assert.strictEqual(lidl.isFood({ attrs: { category: "Categorías/Hogar y cocina/Pequeños electrodomésticos" } }), false);
  assert.strictEqual(lidl.isFood({ attrs: { category: "" } }), false);
  assert.strictEqual(lidl.isTarget({ attrs: { category: "Categorías/Tienda de bricolaje/Taller/Herramientas" } }), true);
  assert.strictEqual(lidl.isTarget({ attrs: { category: "Categorías/Hogar y cocina/Pequeños electrodomésticos" } }), true);
  assert.strictEqual(lidl.isTarget({ attrs: { category: "Categorías/Jardín y barbacoa/Decoración" } }), true);
});

test("Lidl descarta textil, juguetes y deporte", function () {
  assert.strictEqual(lidl.isTarget({ attrs: { category: "Categorías/Textiles/Camisetas" } }), false);
  assert.strictEqual(lidl.isTarget({ attrs: { category: "Categorías/El mundo de los niños/Juguetes" } }), false);
  assert.strictEqual(lidl.isTarget({ attrs: { category: "Categorías/Deportes/Fitness" } }), false);
});
