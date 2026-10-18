const { test } = require("node:test");
const assert = require("node:assert/strict");
const identity = require("../src/lib/identity");
const match = require("../src/lib/match");
const enrich = require("../src/lib/enrich");
const specs = require("../src/lib/specs");
const image = require("../src/lib/imagecheck");

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

test("match: titulo solo en chino (1688) queda a revisar, no se descarta", () => {
  const src = card({ brand: "LEGO", model: "42151", name: "LEGO Technic 42151 Bugatti Bolide" });
  const r = match.score(src, { name: "乐高积木玩具赛车模型 儿童益智拼装玩具" }, { typeOk: true });
  assert.equal(r.strongConflict, false);
  assert.equal(r.band, "revisar");
  assert.equal(r.noTextMatch, true);
  assert.ok(r.reasons.some(function (x) { return /chino/i.test(x); }));
});

test("match: chino con EAN distinto sigue descartando", () => {
  const src = card({ ean: "5702017399573", brand: "LEGO", model: "42151", name: "LEGO Technic 42151" });
  const r = match.score(src, { name: "乐高积木玩具 42151", ean: "8412345678905" }, { typeOk: true });
  assert.equal(r.strongConflict, true);
  assert.equal(r.band, "descartar");
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

test("specs: lee additionalProperty, features y descripcion", () => {
  const s = specs.fromSource({
    features: ["Material: acero inoxidable", "Capacidad: 1,5 l"],
    description: "Potencia: 800 W. Voltaje: 220 V."
  });
  assert.equal(s.material.value.text, "acero inoxidable");
  assert.equal(s.capacity.value.n, 1500);
  assert.equal(s.capacity.value.unit, "volume");
  assert.equal(s.power.value.n, 800);
  assert.equal(s.voltage.value.n, 220);
  const ap = specs.fromSource({ additionalProperty: [{ name: "Peso", value: "1,2 kg" }] });
  assert.equal(ap.weight.value.n, 1200);
  assert.equal(ap.weight.value.unit, "mass");
});

test("match: caracteristica numerica distinta bloquea verificado", () => {
  const src = card({ brand: "Acme", model: "ZX-200", name: "Acme ZX-200", features: ["Capacidad: 500 ml"] });
  const s = specs.fromSource({ features: ["Capacidad: 500 ml"] });
  const r = match.score(src, { name: "Acme ZX-200", features: ["Capacidad: 750 ml"] }, { typeOk: true, specs: s });
  assert.equal(r.specConflict, true);
  assert.equal(r.band, "revisar");
  assert.ok(r.reasons.some(function (x) { return /Caracteristica distinta/i.test(x); }));
});

test("match: caracteristica coincidente suma y no bloquea", () => {
  const src = card({ brand: "Acme", model: "ZX-200", name: "Acme ZX-200", features: ["Capacidad: 500 ml"] });
  const s = specs.fromSource({ features: ["Capacidad: 500 ml"] });
  const r = match.score(src, { name: "Acme ZX-200", features: ["Capacidad: 500 ml"] }, { typeOk: true, specs: s });
  assert.equal(r.specConflict, false);
  assert.equal(r.band, "verificado");
  assert.ok(r.checks.some(function (c) { return c.key === "spec_capacity" && c.state === "ok"; }));
});

test("imagecheck: misma imagen de Amazon con distinto transform", () => {
  const a = image.imageRef("https://m.media-amazon.com/images/I/71abcL._AC_SL1500_.jpg");
  const b = image.imageRef("https://m.media-amazon.com/images/I/71abcL._AC_SX679_.jpg");
  assert.equal(a.key, "amazon:71abcl");
  assert.equal(a.key, b.key);
});

test("imagecheck: lee dimensiones PNG", () => {
  const b = Buffer.alloc(24);
  b[0] = 0x89; b.write("PNG", 1, "ascii"); b.writeUInt32BE(800, 16); b.writeUInt32BE(600, 20);
  const d = image.imageSize(b);
  assert.equal(d.width, 800);
  assert.equal(d.height, 600);
});

test("imagecheck: misma huella con URLs distintas = foto identica", async () => {
  const b = Buffer.alloc(24);
  b[0] = 0x89; b.write("PNG", 1, "ascii"); b.writeUInt32BE(800, 16); b.writeUInt32BE(600, 20);
  const fake = async function () {
    return { ok: true, status: 200, headers: { get: function () { return String(b.length); } }, arrayBuffer: async function () { return b; } };
  };
  const r = await image.compareImages("https://a.example/p.jpg", "https://b.example/q.jpg", { fetch: fake });
  assert.equal(r.state, "ok");
  assert.equal(r.same, true);
});

test("enrich: ficha de proveedor sin gtin pero con oferta, descripcion, color y talla", () => {
  const html = '<script type="application/ld+json">' + JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Product",
    name: "Camiseta Acme modelo ZX",
    brand: { name: "Acme" },
    color: "negro",
    size: "M",
    description: "Camiseta de algodon.",
    image: ["https://cdn.example/1.jpg"],
    offers: { "@type": "Offer", price: "19,95", priceCurrency: "EUR", availability: "https://schema.org/InStock" }
  }) + "</script>";
  const d = enrich.parseJsonLd(html, { allowNoId: true });
  assert.equal(d.name, "Camiseta Acme modelo ZX");
  assert.equal(d.brand, "Acme");
  assert.equal(d.color, "negro");
  assert.equal(d.size, "M");
  assert.equal(d.price, 19.95);
  assert.equal(d.currency, "EUR");
  assert.equal(d.availability, "InStock");
});

test("enrich: respaldo Open Graph cuando no hay JSON-LD de producto", () => {
  const html = '<html><head><meta property="og:title" content="Producto OG"><meta property="og:description" content="Descripcion OG"><meta property="og:image" content="https://cdn.example/og.jpg"><meta property="product:price:amount" content="12.50"><meta property="product:price:currency" content="EUR"></head></html>';
  const d = enrich.parseJsonLd(html, { allowNoId: true });
  assert.equal(d.name, "Producto OG");
  assert.equal(d.price, 12.5);
  assert.equal(d.currency, "EUR");
  assert.deepEqual(d.images, ["https://cdn.example/og.jpg"]);
});

test("identity: color y talla en campos aparte se comparan", () => {
  const src = identity.identityOf({ name: "Camiseta Acme", color: "negro", size: "M" });
  assert.equal(src.color, "negro");
  assert.ok(src.sizes.indexOf("talla m") !== -1 || src.sizes.indexOf("tallam") !== -1);
  const same = identity.compare(src, { name: "Camiseta Acme", color: "negro", size: "M" });
  assert.equal(same.conflicts.length, 0);
  const diff = identity.compare(src, { name: "Camiseta Acme", color: "blanco", size: "L" });
  assert.equal(diff.verdict, "variante");
  assert.ok(diff.conflicts.indexOf("color") !== -1);
  assert.ok(diff.conflicts.indexOf("size") !== -1);
});
