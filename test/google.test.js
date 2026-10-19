"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { mapEanRows, gshopping, gshoppingEan } = require("../src/adapters/apify_market");
const { config } = require("../src/config");
const apify = require("../src/lib/apify");

const EAN = "4006381333931";
const ROW = {
  gtin: EAN,
  title: "Maquina de coser Silvercrest",
  brand: "Silvercrest",
  currency: "EUR",
  offersCount: 3,
  offersAvailable: 2,
  offers: [
    { store: "Tienda A", price: "299.99", shippingPrice: "4.95", totalPrice: "304.94", url: "https://a.example/p", availability: "InStock", condition: "New" },
    { store: "Tienda B", price: 289.99, shipping: "0", totalPrice: 289.99, url: "https://b.example/p", availability: "OutOfStock", condition: "New" },
    { store: "Tienda A", price: "299.99", shippingPrice: "4.95", totalPrice: "304.94", url: "https://a.example/p", availability: "InStock" }
  ]
};

test("google EAN: convierte ofertas en resultados con precio, envio y stock", () => {
  const items = mapEanRows([ROW], EAN, 20);
  assert.equal(items.length, 2);
  assert.equal(items[0].supplier, "Tienda B");
  assert.equal(items[0].price, 289.99);
  assert.equal(items[0].ean, EAN);
  assert.equal(items[1].supplier, "Tienda A");
  assert.equal(items[1].shipping, 4.95);
  assert.equal(items[1].available, true);
  assert.equal(items[0].available, false);
  assert.equal(items[0].attrs.offersCount, 3);
  assert.equal(items[0].attrs.gtinMatches, null);
});

test("google EAN: usa el enlace directo de la tienda, no la redireccion de Google", () => {
  const row = Object.assign({}, ROW, {
    offers: [
      { store: "Tienda C", price: "10.00", storeUrl: "https://c.example/p", url: "https://www.google.com/url?q=abc" },
      { store: "Tienda D", price: "12.00", url: "https://www.google.com/url?q=def" }
    ]
  });
  const items = mapEanRows([row], EAN, 10);
  assert.equal(items.length, 2);
  assert.equal(items[0].url, "https://c.example/p");
  assert.equal(items[0].attrs.storeUrl, "https://c.example/p");
  assert.equal(items[1].url, "https://www.google.com/url?q=def");
});

test("google EAN: descarta una fila de otro codigo y respeta moneda no EUR", () => {
  const other = Object.assign({}, ROW, { gtin: "8412345678905" });
  assert.equal(mapEanRows([other], EAN, 20).length, 0);
  const usd = Object.assign({}, ROW, { currency: "USD", offers: [{ store: "Shop", price: "199.99", url: "https://us.example/p" }] });
  const items = mapEanRows([usd], EAN, 20);
  assert.equal(items.length, 1);
  assert.equal(items[0].price, null);
  assert.equal(items[0].priceText, "USD 199.99");
});

test("google keyword: manda EAN, marca/modelo y titulo en la misma ejecucion", async () => {
  const oldToken = config.apify.token;
  const oldActor = config.apify.actors.shopping;
  const original = apify.runActor;
  let captured = null;
  config.apify.token = "test-token";
  config.apify.actors.shopping = "automation-lab/google-shopping-scraper";
  apify.runActor = async function (actor, input) {
    captured = { actor, input };
    return { ok: true, items: [{ title: "Maquina de coser", priceNumeric: 299, currency: "EUR", merchant: "Tienda", productUrl: "https://shop.example/p", query: EAN }] };
  };
  try {
    const r = await gshopping.actions.search({ ean: EAN, brand: "Silvercrest", name: "Maquina de coser", max: 24 });
    assert.equal(r.ok, true);
    assert.equal(captured.actor, "automation-lab/google-shopping-scraper");
    assert.deepEqual(captured.input.queries.slice(0, 2), ["Silvercrest Maquina de coser", EAN]);
    assert.equal(captured.input.sortBy, "relevance");
    assert.equal(captured.input.country, config.apify.country);
  } finally {
    apify.runActor = original;
    config.apify.token = oldToken;
    config.apify.actors.shopping = oldActor;
  }
});

test("google EAN: el adaptador pide gtins e includeOffers", async () => {
  const oldToken = config.apify.token;
  const oldActor = config.apify.actors.shoppingEan;
  const original = apify.runActor;
  let captured = null;
  config.apify.token = "test-token";
  config.apify.actors.shoppingEan = "scrapewise/google-shopping";
  apify.runActor = async function (actor, input) {
    captured = { actor, input };
    return { ok: true, items: [ROW] };
  };
  try {
    const r = await gshoppingEan.actions.search({ ean: EAN, max: 24 });
    assert.equal(r.ok, true);
    assert.equal(r.data.count, 2);
    assert.equal(captured.actor, "scrapewise/google-shopping");
    assert.deepEqual(captured.input.gtins, [EAN]);
    assert.equal(captured.input.includeOffers, true);
    assert.equal(captured.input.includeStoreLink, true);
    assert.equal(captured.input.country, config.apify.country);
  } finally {
    apify.runActor = original;
    config.apify.token = oldToken;
    config.apify.actors.shoppingEan = oldActor;
  }
});
