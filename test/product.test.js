const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createResolver } = require("../src/lib/product");

const EAN = "8412345678905";

function fakeDeps(over) {
  return Object.assign({
    identity: {
      lookup: async () => ({
        ok: true,
        data: {
          items: [{
            name: "Taladro X",
            brand: "Marca",
            model: "M1",
            ean: EAN,
            image: "https://img.example/1.jpg",
            attrs: { category: "Taladros", description: "Ficha" }
          }]
        }
      })
    },
    supplier: {
      search: async () => ({
        ok: true,
        data: {
          items: [
            { source: "bigbuy", name: "Taladro X 20V", price: 20, reference: "SKU1", available: true, stock: 5, url: "https://bb/1", attrs: { currency: "EUR", priceIncludesVAT: false } },
            { source: "bigbuy", name: "Taladro X 18V", price: 18, reference: "SKU2", available: true, stock: 1, url: "https://bb/2", attrs: { currency: "EUR", priceIncludesVAT: false } }
          ]
        }
      })
    },
    offers: {
      search: async () => ({
        ok: true,
        data: {
          items: [
            { source: "gshopping_ean", name: "Taladro X", price: 30, shipping: 4, supplier: "Tienda A", url: "https://a", attrs: { currency: "EUR", condition: "Nuevo" } },
            { source: "gshopping_ean", name: "Taladro X", price: 30, shipping: 4, supplier: "Tienda A", url: "https://a", attrs: { currency: "EUR" } },
            { source: "gshopping_ean", name: "Taladro X", price: 25, shipping: 0, supplier: "Tienda B", url: "https://b", attrs: { currency: "EUR" } }
          ]
        }
      })
    }
  }, over);
}

test("product une ficha, proveedor y ofertas y ordena por coste", async () => {
  const resolve = createResolver(fakeDeps());
  const out = await resolve(EAN);

  assert.equal(out.ok, true);
  assert.equal(out.ean, EAN);
  assert.equal(out.product.name, "Taladro X");
  assert.equal(out.product.brand, "Marca");

  assert.equal(out.suppliers.length, 2);
  assert.equal(out.suppliers[0].netPrice, 18);
  assert.equal(out.suppliers[0].provider, "BigBuy");

  assert.equal(out.offers.length, 2, "la oferta duplicada se elimina");
  assert.equal(out.offers[0].shop, "Tienda B");
  assert.equal(out.offers[0].total, 25);
  assert.equal(out.offers[1].total, 34);

  assert.equal(out.counts.offers, 2);
  assert.equal(out.partial, false);
});

test("product marca la fuente que no responde sin romper el resto", async () => {
  const resolve = createResolver(fakeDeps({
    supplier: { search: () => new Promise(() => {}) }
  }), { timeouts: { supplier: 1000 } });

  const out = await resolve(EAN);
  assert.equal(out.ok, true);
  assert.equal(out.partial, true);
  assert.equal(out.sources.find((s) => s.id === "bigbuy").status, "timeout");
  assert.equal(out.offers.length, 2);
});

test("product distingue una fuente sin configurar de un error", async () => {
  const resolve = createResolver(fakeDeps({
    offers: { search: async () => ({ ok: false, reason: "apify_sin_token" }) }
  }));

  const out = await resolve(EAN);
  assert.equal(out.sources.find((s) => s.id === "gshopping_ean").status, "skipped");
  assert.equal(out.partial, true);
});

test("product rechaza un EAN invalido", async () => {
  const resolve = createResolver(fakeDeps());
  const out = await resolve("abc");
  assert.equal(out.ok, false);
  assert.equal(out.reason, "ean_invalido");
});

test("product no convierte un EAN corto en otro producto", async () => {
  const resolve = createResolver(fakeDeps());
  const out = await resolve("1234567890123");
  assert.equal(out.ok, true);
  assert.equal(out.ean, "1234567890123");
});
