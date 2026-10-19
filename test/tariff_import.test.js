"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { prepareRows, validGtin, sourceName } = require("../src/routes/tariffs");
const { parseBody } = require("../src/adapters/tarifa");

const COCA = "5449000000996";

test("validGtin acepta EAN-13, UPC-A, EAN-8 y GTIN-14 correctos", () => {
  assert.equal(validGtin(COCA), true);
  assert.equal(validGtin("4006381333931"), true);
  assert.equal(validGtin("1234567890128"), true);
  assert.equal(validGtin("036000291452"), true);
  assert.equal(validGtin("96385074"), true);
  assert.equal(validGtin("05449000000996"), true);
});

test("validGtin rechaza digitos de control incorrectos y longitudes raras", () => {
  assert.equal(validGtin("5449000000997"), false);
  assert.equal(validGtin("1234567890123"), false);
  assert.equal(validGtin("123456"), false);
  assert.equal(validGtin(""), false);
  assert.equal(validGtin("54490000009960"), false);
});

test("prepareRows valida EAN, precio y duplicados sin inventar datos", () => {
  const r = prepareRows([
    { ean: COCA, name: "Coca-Cola 33 cl", price: "0,70" },
    { ean: COCA, name: "Coca-Cola pack 6", price: "0.75" },
    { ean: "5449000000997", name: "EAN con check malo", price: "1,00" },
    { ean: "1234567890128", name: "Sin precio" },
    { name: "Sin EAN", price: "2,00" },
    { ean: "4006381333931", attrs: { marca: "STABILO", precio_neto: "1,25" } }
  ]);
  assert.equal(r.stats.received, 6);
  assert.equal(r.stats.valid, 2);
  assert.equal(r.stats.duplicates, 1);
  assert.equal(r.stats.ean_invalido, 1);
  assert.equal(r.stats.sin_precio, 1);
  assert.equal(r.stats.sin_ean, 1);
  const coca = r.items.filter((x) => x.ean === COCA)[0];
  assert.equal(coca.name, "Coca-Cola pack 6");
  assert.equal(coca.net, 0.75);
  assert.equal(coca.price, 0.75);
  const stab = r.items.filter((x) => x.ean === "4006381333931")[0];
  assert.equal(stab.brand, "STABILO");
  assert.equal(stab.net, 1.25);
});

test("prepareRows prefiere el precio neto y normaliza UPC de 12 a EAN-13", () => {
  const r = prepareRows([
    { ean: "036000291452", name: "Producto", price: "9,99", net: "5,00" },
    { ean: 4006381333931, name: "Numerico", price: 3.5 }
  ]);
  assert.equal(r.stats.valid, 2);
  const upc = r.items.filter((x) => x.ean === "0036000291452")[0];
  assert.ok(upc);
  assert.equal(upc.net, 5);
  assert.equal(upc.price, 9.99);
  assert.equal(r.items.filter((x) => x.ean === "4006381333931")[0].net, 3.5);
});

test("sourceName limpia nombres largos y evita vacios", () => {
  assert.equal(sourceName("  BigBuy  "), "BigBuy");
  assert.equal(sourceName(""), "import");
  assert.equal(sourceName(null), "import");
  assert.ok(sourceName("x".repeat(200)).length <= 60);
});

test("parseBody entiende cabeceras BigBuy (EAN13/PVD) y guarda el coste neto", async () => {
  const csv = [
    "ID;NAME;BRAND;PRICE;PVP_BIGBUY;PVD;IVA;EAN13;STOCK",
    'S1410928;"Jarra con Tapa y Pajita (500 ml)";2253;5,86;4,10;2,46;21;4899888126720;29544'
  ].join("\n");
  const out = await parseBody({ csv: csv });
  assert.equal(out.ok, true);
  const r = prepareRows(out.data.items);
  assert.equal(r.stats.valid, 1);
  assert.equal(r.items[0].ean, "4899888126720");
  assert.equal(r.items[0].net, 2.46);
  assert.equal(r.items[0].brand, "2253");
});
