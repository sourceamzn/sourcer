"use strict";
const test = require("node:test");
const assert = require("node:assert");
const cascade = require("../src/lib/cascade");

test("matchKey ignora query y barra final", function () {
  assert.strictEqual(cascade.matchKey({ url: "https://X.com/p/1/?ref=a#b" }), "https://x.com/p/1");
  assert.strictEqual(cascade.matchKey({ ean: "123-456", price: 10 }), "ean:123456|10");
});

test("mergeMatches deduplica por URL y respeta la fase 1", function () {
  const p1 = [{ url: "https://a.com/1", price: 9, phase: 1, matchBand: "verificado" }];
  const p2 = [{ url: "https://a.com/1/", price: 8, phase: 2, matchBand: "verificado" },
              { url: "https://b.com/2", price: 7, phase: 2, matchBand: "verificado" }];
  const out = cascade.mergeMatches(p1, p2);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].price, 7);
  assert.strictEqual(out[1].phase, 1);
});

test("mergeMatches ordena sin precio al final por relevancia", function () {
  const out = cascade.mergeMatches([{ url: "u1", price: 0, rel: 2 }, { url: "u2", price: 5 }], []);
  assert.strictEqual(out[0].url, "u2");
  assert.strictEqual(out[1].url, "u1");
});

test("mergeSearched se queda con la entrada que trajo datos", function () {
  const s1 = [{ source: "cj", ok: false, count: 0, phase: 1 }];
  const s2 = [{ source: "cj", ok: true, count: 3, phase: 2 }, { source: "lidl", ok: true, count: 1 }];
  const out = cascade.mergeSearched(s1, s2);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].count, 3);
});

test("summarize conserva contadores de la fase 1 y añade fases", function () {
  const s = cascade.summarize({ exact: 2, raw: 10 }, 2, 5);
  assert.strictEqual(s.exact, 2);
  assert.strictEqual(s.phase1, 2);
  assert.strictEqual(s.phase2, 5);
  assert.strictEqual(s.cascade, true);
});
