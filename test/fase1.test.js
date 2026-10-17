const { test } = require("node:test");
const assert = require("node:assert/strict");
const gtin = require("../src/lib/gtin");
const { buildQueries } = require("../src/lib/queries");
const { fichaOf, amazonSellsFrom } = require("../src/lib/keepaficha");
const identity = require("../src/lib/identity");

/* ---------- gtin ---------- */
test("gtin: normaliza UPC-12, EAN-8 y EAN-13 a 13 digitos", () => {
  assert.equal(gtin.normalize("036000291452"), "0036000291452");
  assert.equal(gtin.normalize("96385074"), "0000096385074");
  assert.equal(gtin.normalize("4006381333931"), "4006381333931");
  assert.equal(gtin.normalize("123"), "");
  assert.equal(gtin.normalize(""), "");
});
test("gtin: un EAN no coincide por ser subcadena de otro", () => {
  assert.equal(gtin.same("4006381333931", "006381333931"), false);
  assert.equal(gtin.same("036000291452", "0036000291452"), true);
});
test("gtin: normalizeAll quita duplicados y basura", () => {
  assert.deepEqual(gtin.normalizeAll(["036000291452", "0036000291452", "x", null]), ["0036000291452"]);
});

/* ---------- identity.compare ---------- */
test("identity: EAN corto contenido en uno largo ya NO es exacto", () => {
  const src = identity.identityOf({ ean: "12345678", name: "Producto A" });
  const cmp = identity.compare(src, { name: "Producto A", ean: "9912345678901" });
  assert.equal(cmp.eanOk, false);
  assert.equal(cmp.verdict, "distinto");
});
test("identity: UPC de 12 y EAN de 13 con ceros son el mismo", () => {
  const src = identity.identityOf({ ean: "036000291452", name: "Cosa" });
  const cmp = identity.compare(src, { name: "Cosa", ean: "0036000291452" });
  assert.equal(cmp.eanOk, true);
  assert.equal(cmp.verdict, "exacto");
});
test("identity: coincide con cualquiera de los EAN del origen, no solo el primero", () => {
  const src = identity.identityOf({ ean: "4006381333931", eans: ["4006381333931", "5449000000996"], name: "Bebida" });
  const cmp = identity.compare(src, { name: "Bebida", ean: "5449000000996" });
  assert.equal(cmp.eanOk, true);
});
test("identity: EAN distinto sigue siendo distinto", () => {
  const src = identity.identityOf({ ean: "4006381333931", name: "Z" });
  assert.equal(identity.compare(src, { name: "Z", ean: "5449000000996" }).verdict, "distinto");
});

/* ---------- cascada de consultas ---------- */
test("queries: con EAN ya no busca solo el EAN", () => {
  const q = buildQueries({ ean: "4006381333931", brand: "Acme", model: "ZX-200", name: "Acme ZX-200 taladro inalambrico 18V negro con dos baterias" });
  assert.ok(q.length >= 3);
  assert.equal(q[0].via, "ean");
  assert.ok(q.some((x) => x.via === "marca+modelo" && /Acme/.test(x.q) && /ZX-200/.test(x.q)));
  assert.ok(q.some((x) => x.via === "marca+titulo"));
});
test("queries: referencia sola y modelo solo si no hay marca+modelo", () => {
  const q = buildQueries({ brand: "Foo", model: "AB-1234", partNumber: "PN-998877", name: "Foo AB-1234 lampara" }, { maxQueries: 6 });
  assert.ok(q.some((x) => x.via === "referencia" && x.q === "PN-998877"));
  assert.equal(q.some((x) => x.via === "modelo"), false);
  const q2 = buildQueries({ model: "AB-1234", name: "Lampara AB-1234" }, { maxQueries: 6 });
  assert.ok(q2.some((x) => x.via === "modelo" && x.q === "AB-1234"));
});
test("queries: paso en ingles marcado para fuentes internacionales", () => {
  const q = buildQueries({ brand: "Foo", name: "Foo lampara de mesa" }, { maxQueries: 6 });
  const en = q.find((x) => x.via === "titulo_en");
  assert.ok(en && en.intl && en.lazyEnglish);
});
test("queries: sin repetidos y respeta el tope", () => {
  const q = buildQueries({ brand: "Foo", model: "Foo", name: "Foo" }, { maxQueries: 3 });
  const keys = q.filter((x) => x.q).map((x) => x.q.toLowerCase());
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(q.length <= 3);
});
test("queries: sin datos devuelve lista vacia", () => {
  assert.deepEqual(buildQueries({}), []);
});
test("queries: producto cualquiera sin EAN usa marca+titulo", () => {
  const q = buildQueries({ brand: "Zumo", name: "Zumo exprimidor manual de acero inoxidable" });
  assert.equal(q[0].via, "marca+titulo");
});

/* ---------- ficha Keepa ---------- */
test("keepaficha: lee todos los EAN y UPC, campos extra y anota lo que falta", () => {
  const { ficha, missing } = fichaOf({
    eanList: ["4006381333931", "5449000000996"], upcList: ["036000291452"],
    model: "ZX-200", partNumber: "PN1", manufacturer: "Acme", features: ["a", "b"], description: "desc",
    packageQuantity: 2, numberOfItems: 4, itemLength: 300, itemWidth: 200, itemHeight: 100, itemWeight: 1500
  });
  assert.equal(ficha.eans.length, 3);
  assert.equal(ficha.model, "ZX-200");
  assert.equal(ficha.packageQuantity, 2);
  assert.equal(ficha.dimensions.lengthMm, 300);
  assert.equal(ficha.weight.itemG, 1500);
  assert.ok(missing.indexOf("model") === -1);
});
test("keepaficha: producto vacio no revienta ni inventa", () => {
  const { ficha, missing } = fichaOf({ eanList: [-1], model: -1, features: "x" });
  assert.deepEqual(ficha.eans, []);
  assert.equal(ficha.model, "");
  assert.ok(missing.indexOf("eans") !== -1);
  assert.deepEqual(ficha.features, []);
  assert.deepEqual(fichaOf(null).ficha.eans, []);
});

/* ---------- amazonSells ---------- */
test("amazonSells: usa la Buy Box de 90 d", () => {
  assert.equal(amazonSellsFrom({}, { known: true, amazonShare: 0.4 }, 0), true);
  assert.equal(amazonSellsFrom({}, { known: true, amazonShare: 0 }, 19.9), false); /* precio actual ya no manda */
  assert.equal(amazonSellsFrom({}, { known: true, amazonShare: 0.01 }, 0), false);
});
test("amazonSells: sin Buy Box usa buyBoxIsAmazon y luego el precio actual", () => {
  assert.equal(amazonSellsFrom({ stats: { buyBoxIsAmazon: true } }, { known: false }, 0), true);
  assert.equal(amazonSellsFrom({ stats: { buyBoxIsAmazon: false } }, { known: false }, 15), false);
  assert.equal(amazonSellsFrom({}, { known: false }, 15), true);
  assert.equal(amazonSellsFrom({}, null, 0), false);
});
