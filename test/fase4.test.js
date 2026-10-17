const { test } = require("node:test");
const assert = require("node:assert/strict");
const identity = require("../src/lib/identity");
const match = require("../src/lib/match");
const enrich = require("../src/lib/enrich");

function card(o) {
  return identity.identityOf(o || {});
}

test("match: EAN exacto = 100 y verificado", () => {
  const src = card({ ean: "4006381333931", brand: "Acme", model: "ZX-200", name: "Acme ZX-200 taladro" });
  const r = match.score(src, { name: "Acme ZX-200 taladro", ean: "4006381333931" });
  assert.equal(r.score, 100);
  assert.equal(r.band, "verificado");
  assert.equal(r.eanOk, true);
  assert.equal(r.strongConflict, false);
});

test("match: EAN distinto es conflicto fuerte (descarte)", () => {
  const src = card({ ean: "4006381333931", brand: "Acme", model: "ZX-200", name: "Acme ZX-200 taladro" });
  const r = match.score(src, { name: "Acme ZX-200 taladro", ean: "8412345678905" });
  assert.equal(r.strongConflict, true);
  assert.equal(r.band, "descartar");
  assert.equal(r.score, 0);
  assert.match(r.reasons[0], /EAN/);
});

test("match: marca+modelo sin EAN asciende a verificado", () => {
  const src = card({ brand: "Sony", model: "WH-1000XM5", name: "Sony WH-1000XM5 auriculares" });
  const r = match.score(src, { name: "Sony WH-1000XM5 auriculares" });
  assert.equal(r.band, "verificado");
  assert.ok(r.score >= 80);
  assert.equal(r.eanOk, false);
});

test("match: codigo de modelo distinto cuando ambos lo dan = conflicto fuerte", () => {
  const src = card({ brand: "Sony", model: "WH-1000XM5", name: "Sony WH-1000XM5" });
  const r = match.score(src, { name: "Sony WH-1000XM4" });
  assert.equal(r.strongConflict, true);
  assert.equal(r.band, "descartar");
  assert.match(r.reasons[0], /modelo/i);
});

test("match: pack distinto = conflicto fuerte", () => {
  const src = card({ brand: "Acme", name: "Acme pilas AA pack de 2" });
  const r = match.score(src, { name: "Acme pilas AA pack de 4" });
  assert.equal(r.strongConflict, true);
  assert.equal(r.band, "descartar");
  assert.match(r.reasons[0], /Pack/i);
});

test("match: color distinto no descarta; queda a revisar", () => {
  const src = card({ brand: "Acme", name: "Acme soporte de pared 500 ml pack de 2 negro" });
  const r = match.score(src, { name: "Acme soporte de pared 500 ml pack de 2 blanco" }, { typeOk: true });
  assert.equal(r.strongConflict, false);
  assert.equal(r.band, "revisar");
  assert.ok(r.score >= 45 && r.score < 80);
});

test("match: si la oferta no da modelo no hay conflicto y queda a revisar", () => {
  const src = card({ brand: "Acme", model: "ZX-200", name: "Acme ZX-200 soporte 500 ml pack de 2 negro" });
  const r = match.score(src, { name: "Acme soporte 500 ml pack de 2 negro" }, { typeOk: true });
  assert.equal(r.strongConflict, false);
  assert.equal(r.band, "revisar");
});

test("match: codigos cortos (15M vs 20M) no cuentan como otro modelo", () => {
  const src = card({ brand: "Acme", name: "Acme cable 15M" });
  const r = match.score(src, { name: "Acme cable 20M" }, { typeOk: true });
  assert.equal(r.strongConflict, false);
});

test("match: sin ninguna evidencia se descarta", () => {
  const src = card({ brand: "Acme", model: "ZX-200", name: "Acme ZX-200 soporte" });
  const r = match.score(src, { name: "Cosa cualquiera de otra marca" });
  assert.equal(r.band, "descartar");
  assert.equal(r.strongConflict, false);
});

test("enrich: lee JSON-LD Product simple (gtin, mpn, brand)", () => {
  const html = '<html><script type="application/ld+json">' + JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Product",
    name: "Sony WH-1000XM5",
    brand: { "@type": "Brand", name: "Sony" },
    gtin13: "4006381333931",
    mpn: "WH1000XM5"
  }) + "</script></html>";
  const d = enrich.parseJsonLd(html);
  assert.equal(d.name, "Sony WH-1000XM5");
  assert.equal(d.brand, "Sony");
  assert.equal(d.gtin, "4006381333931");
  assert.equal(d.mpn, "WH1000XM5");
});

test("enrich: acepta @graph y arrays", () => {
  const graph = '<script type="application/ld+json">' + JSON.stringify({
    "@context": "https://schema.org",
    "@graph": [
      { "@type": "WebSite", name: "Tienda" },
      { "@type": "Product", name: "P", brand: "Acme", gtin: "8412345678905", sku: "SKU-1" }
    ]
  }) + "</script>";
  assert.equal(enrich.parseJsonLd(graph).brand, "Acme");
  const arr = '<script type="application/ld+json">' + JSON.stringify([{ "@type": "Product", name: "P2", mpn: "M2" }]) + "</script>";
  assert.equal(enrich.parseJsonLd(arr).mpn, "M2");
});

test("enrich: sin Product o sin identificador devuelve null", () => {
  assert.equal(enrich.parseJsonLd('<script type="application/ld+json">{"@type":"WebSite","name":"X"}</script>'), null);
  assert.equal(enrich.parseJsonLd('<script type="application/ld+json">{"@type":"Product","name":"X"}</script>'), null);
  assert.equal(enrich.parseJsonLd("<html>sin json-ld</html>"), null);
});

test("enrich: rellena ean/marca/modelo y usa cache por URL", async () => {
  let calls = 0;
  const data = { gtin: "4006381333931", brand: "Acme", mpn: "ZX-200", sku: "S-1" };
  const fake = async function () { calls++; return data; };
  const offers = [{ url: "https://a.example/p/1" }, { url: "https://b.example/p/2" }, { url: "" }];
  const r = await enrich.enrich(offers, { max: 5, concurrency: 2, fetchPage: fake });
  assert.equal(r.tried, 2);
  assert.equal(r.found, 2);
  assert.equal(offers[0].ean, "4006381333931");
  assert.equal(offers[0].brand, "Acme");
  assert.equal(offers[1].model, "ZX-200");
  assert.equal(calls, 2);
  const r2 = await enrich.enrich([offers[0]], { max: 5, cache: r.cache, fetchPage: fake });
  assert.equal(r2.tried, 1);
  assert.equal(calls, 2);
});

test("enrich: respeta el maximo de fichas por busqueda", async () => {
  let calls = 0;
  const fake = async function () { calls++; return { gtin: "8412345678905" }; };
  const offers = [{ url: "https://a.example/1" }, { url: "https://a.example/2" }, { url: "https://a.example/3" }];
  const r = await enrich.enrich(offers, { max: 1, fetchPage: fake });
  assert.equal(r.tried, 1);
  assert.equal(calls, 1);
});
