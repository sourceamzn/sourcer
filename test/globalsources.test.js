"use strict";
const test = require("node:test");
const assert = require("node:assert");
const gs = require("../src/adapters/globalsources");

test("Global Sources: la consulta inglesa se convierte en slug de directorio", function () {
  assert.strictEqual(gs._slugify("blender manufacturer"), "blender");
  assert.strictEqual(gs._slugify("Hand Blender Supplier"), "hand-blender");
  assert.strictEqual(gs._slugify("  Cafetera exprés  "), "cafetera-expres");
});

test("Global Sources: elige la categoria con mas palabras en comun", function () {
  const html = [
    '<a href="/category/bar-blenders-for-sale-price_32091/">x</a>',
    '<a href="/category/hand-blenders-for-sale-price_11111/">x</a>',
    '<a href="/category/kitchen-appliances-for-sale-price_24105/">x</a>'
  ].join("");
  const cat = gs._pickCategory(html, "hand blenders");
  assert.strictEqual(cat.id, "11111");
});

test("Global Sources: sello Verified Manufacturer y Business Type dan fabrica", function () {
  const html =
    '<ul class="supplier-list">' +
    '<li class="item card-box invalid"><div class="mod-supp-info">' +
    '<a href="//bana.manufacturer.globalsources.com/homepage_6008824819612.htm" class="tit"> Ningbo Bana Co.,Ltd </a>' +
    '<p class="gs-tag years"><em class="year-bg"><i class="num">11</i></em></p>' +
    '<img alt="Verified Maufacturer">' +
    '<em class="gs-tag dot">China</em>' +
    '<div class="img" style="background-image:url(\'https://s.globalsources.com/LOGO/a.jpg\');"></div>' +
    '<a class="txt-box"><p class="text">Factory from Ningbo</p><ul class="txt-list">' +
    '<li class="item"><span class="attr">Business Type:</span><span class="val">Manufacturer, Exporter</span></li>' +
    '<li class="item"><span class="attr">No. of Employees:</span><span class="val">3000</span></li>' +
    '<li class="item"><span class="attr">Main Products:</span><span class="val">Blenders</span></li>' +
    "</ul></a></div></li>" +
    '<li class="item card-box"><a href="//trade.manufacturer.globalsources.com/homepage_6008811111111.htm" class="tit">Trade Only Ltd</a>' +
    '<ul class="txt-list"><li class="item"><span class="attr">Business Type:</span><span class="val">Trading Company</span></li></ul></li>' +
    "</ul>";
  const items = gs._parseSuppliers(html, 5);
  assert.strictEqual(items.length, 2);
  assert.strictEqual(items[0].name, "Ningbo Bana Co.,Ltd");
  assert.strictEqual(items[0].url, "https://bana.manufacturer.globalsources.com/homepage_6008824819612.htm");
  assert.strictEqual(items[0].factory, true);
  assert.strictEqual(items[0].supplierType, "fabrica");
  assert.strictEqual(items[0].attrs.employees, 3000);
  assert.strictEqual(items[0].attrs.years, 11);
  assert.strictEqual(items[0].attrs.country, "China");
  assert.strictEqual(items[0].price, null);
  assert.strictEqual(items[1].supplierType, "trading");
  assert.strictEqual(items[1].factory, false);
});

test("Global Sources: sin lista de proveedores usa tarjetas de producto con MOQ", function () {
  const html =
    '<li class="item card-box invalid"><div class="mod-prod-info">' +
    '<a href="https://www.globalsources.com/Powder-puff/powder-puff-1222228600p.htm" class="product-name">Makeup Blender Sponge</a>' +
    '<span class="price"> US$ 0.15 - 0.18 </span><i class="unit">/ Piece</i>' +
    '<span class="txt"> 1000 Pieces <i class="desc">(MOQ)</i></span></div>' +
    '<img alt="Verified Maufacturer">' +
    '<div class="name"><a href="//bana.manufacturer.globalsources.com/homepage_6008824819612.htm">Ningbo Bana</a></div></li>';
  const items = gs._parseProducts(html, 5);
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].name, "Makeup Blender Sponge");
  assert.strictEqual(items[0].minOrder, 1000);
  assert.strictEqual(items[0].moq, 1000);
  assert.strictEqual(items[0].priceText, "US$ 0.15 - 0.18 / Piece");
  assert.strictEqual(items[0].price, null);
  assert.strictEqual(items[0].factory, true);
  assert.strictEqual(items[0].supplier, "Ningbo Bana");
});
