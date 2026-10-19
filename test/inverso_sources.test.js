"use strict";
const test = require("node:test");
const assert = require("node:assert");
const inverso = require("../src/adapters/inverso");

test("sources conserva overMax, diagnosis y summary (no los borra)", () => {
  const out = {
    q: "4006381333931",
    via: "ean",
    matches: [{ price: 10, match: "exacto", currency: "EUR" }],
    overMax: [{ price: 99 }, { price: 120 }],
    diagnosis: { reason: "fuentes_sin_ean", message: "Las fuentes no publican EAN." },
    summary: { exact: 3, raw: 40, withEan: 1, differentEan: 2, noEan: 37, sourcesWithEan: 1 },
    searched: [{ source: "bigbuy", ok: false }, { source: "gshopping_ean", ok: true }],
    rejected: [],
    coverage: { sources: 2 },
    identity: { verdict: "exacto" }
  };
  const p = inverso.buildSourcesPayload(out, { asin: "b00test123", brand: "Marca", model: "M1" }, 50);
  assert.equal(p.ok, true);
  assert.equal(p.data.source, "inverso");
  assert.equal(p.data.priceMax, 50);
  assert.equal(p.data.overMax.length, 2);
  assert.equal(p.data.diagnosis.reason, "fuentes_sin_ean");
  assert.equal(p.data.summary.raw, 40);
  assert.equal(p.data.amazon, "https://www.amazon.es/dp/B00TEST123");
  assert.equal(p.data.googleShopping.includes("tbm=shop"), true);
  assert.equal(p.data.scope.sourcesQueried, 2);
  assert.equal(p.data.scope.sourcesWithData, 1);
});

test("sources no inventa campos cuando la busqueda viene vacia", () => {
  const p = inverso.buildSourcesPayload(null, {}, 0);
  assert.deepEqual(p.data.matches, []);
  assert.deepEqual(p.data.overMax, []);
  assert.equal(p.data.diagnosis, null);
  assert.equal(p.data.summary, null);
  assert.equal(p.data.amazon, "");
  assert.equal(p.data.googleShopping, "");
});

test("sources conserva la oferta mas barata ya calculada y la probable", () => {
  const cheap = { price: 5, match: "exacto", currency: "EUR" };
  const probable = { price: 4, match: "probable", currency: "EUR" };
  const p = inverso.buildSourcesPayload({ matches: [probable, cheap], searched: [] }, {}, 0);
  assert.equal(p.data.cheapestVerified, cheap);
  assert.equal(p.data.cheapestProbable, probable);
});
