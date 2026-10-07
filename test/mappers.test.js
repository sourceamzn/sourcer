const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mapOutletProduct, mapLidlItem, mapIherbProduct, stripHtml, num } = require("../src/adapters/mappers");

test("stripHtml limpia etiquetas y entidades", () => {
  assert.equal(stripHtml("<p><strong>Hola</strong>&nbsp;mundo &amp; c</p>"), "Hola mundo & c");
});

test("num acepta coma decimal", () => {
  assert.equal(num("41,99"), 41.99);
  assert.equal(num("12.5 €"), 12.5);
  assert.equal(num(""), null);
});

test("mapOutletProduct normaliza un producto Shopify", () => {
  const node = {
    id: "gid://shopify/Product/1",
    title: "Logitech M238",
    handle: "logitech-m238",
    vendor: "LOGITECH",
    availableForSale: true,
    totalInventory: 7,
    productType: "",
    tags: ["estado-nuevo"],
    priceRange: { minVariantPrice: { amount: "9.99", currencyCode: "EUR" }, maxVariantPrice: { amount: "12.99", currencyCode: "EUR" } },
    featuredImage: { url: "https://cdn/img.jpg" },
    variants: { edges: [{ node: { title: "Default", sku: "sku-1", barcode: "5099206079441", price: { amount: "9.99", currencyCode: "EUR" }, compareAtPrice: { amount: "22.0", currencyCode: "EUR" }, availableForSale: true } }] }
  };
  const out = mapOutletProduct(node);
  assert.equal(out.source, "outletpc");
  assert.equal(out.name, "Logitech M238");
  assert.equal(out.brand, "LOGITECH");
  assert.equal(out.ean, "5099206079441");
  assert.equal(out.reference, "sku-1");
  assert.equal(out.price, 9.99);
  assert.equal(out.oldPrice, 22.0);
  assert.equal(out.stock, 7);
  assert.equal(out.available, true);
  assert.equal(out.url, "https://outlet-pc.es/products/logitech-m238");
  assert.equal(out.variants.length, 1);
});

test("mapLidlItem normaliza un item con gridbox", () => {
  const item = {
    resultClass: "product",
    gridbox: {
      data: {
        fullTitle: "PARKSIDE® Taladro de impacto »PSBM 750 C3«",
        title: "Taladro de impacto »PSBM 750 C3«",
        brand: { name: "PARKSIDE®" },
        erpNumber: "100400894",
        productId: 100400894,
        canonicalUrl: "/p/parkside-taladro/p100400894",
        image: "https://www.lidl.es/assets/x.jpg",
        ians: ["511006"],
        price: { price: 41.99, oldPrice: 44.99, tax: "21", currencyCode: "EUR" },
        stockAvailability: { onlineAvailable: true },
        keyfacts: { description: "<p>Taladro percutor</p>", supplementalDescription: "<p>750 W</p>", analyticsCategory: "Categorias/Taller/Taladros" }
      }
    }
  };
  const out = mapLidlItem(item);
  assert.equal(out.source, "lidl");
  assert.equal(out.brand, "PARKSIDE");
  assert.equal(out.reference, "100400894");
  assert.equal(out.price, 41.99);
  assert.equal(out.oldPrice, 44.99);
  assert.equal(out.available, true);
  assert.equal(out.stock, 1);
  assert.equal(out.url, "https://www.lidl.es/p/parkside-taladro/p100400894");
  assert.equal(out.attrs.tax, "21");
  assert.equal(out.attrs.description, "Taladro percutor");
});

test("mapIherbProduct normaliza un producto iHerb", () => {
  const out = mapIherbProduct({ id: "61864", name: "Gold C 1000 mg", brand: "California Gold Nutrition", upc: "898220012345", price: "9.60", listPrice: "12.00", url: "https://www.iherb.com/pr/x/61864" });
  assert.equal(out.source, "iherb");
  assert.equal(out.ean, "898220012345");
  assert.equal(out.price, 9.6);
  assert.equal(out.oldPrice, 12);
  assert.equal(out.url, "https://www.iherb.com/pr/x/61864");
});
