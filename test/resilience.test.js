const test = require("node:test");
const assert = require("node:assert");

const { config } = require("../src/config");
const cache = require("../src/lib/cache");
const breaker = require("../src/lib/breaker");

test("breaker: abre tras N fallos, se cierra al ir bien", () => {
  breaker.reset();
  assert.equal(breaker.allow("x"), true);
  breaker.failure("x", "e1"); breaker.failure("x", "e2");
  assert.equal(breaker.allow("x"), true);
  breaker.failure("x", "e3");
  assert.equal(breaker.allow("x"), false);
  breaker.reset("x");
  breaker.failure("x", "clave", { hard: true });
  assert.equal(breaker.allow("x"), false);
  assert.equal(breaker.snapshot().x.lastError, "clave");
});

test("cache: guarda, caduca y lee varias claves", async () => {
  cache._reset();
  await cache.set("t", "a", { v: 1 }, 60000);
  await cache.set("t", "b", [1, 2], 1);
  await new Promise(function (r) { setTimeout(r, 5); });
  assert.deepEqual(await cache.get("t", "a"), { v: 1 });
  assert.equal(await cache.get("t", "b"), null);
  const many = await cache.getMany("t", ["a", "b", "c"]);
  assert.deepEqual(Object.keys(many), ["a"]);
});

test("mx: no envia a dominios que no reciben correo", async () => {
  cache._reset();
  const mx = require("../src/lib/mx");
  mx._setResolver({
    mx: async function (d) { if (d === "bueno.es") return [{ exchange: "mail.bueno.es", priority: 10 }]; const e = new Error("x"); e.code = "ENOTFOUND"; throw e; },
    a: async function (d) { if (d === "soloa.es") return ["1.2.3.4"]; const e = new Error("x"); e.code = "ENOTFOUND"; throw e; }
  });
  assert.equal((await mx.check("ventas@bueno.es")).ok, true);
  assert.equal((await mx.check("info@soloa.es")).ok, true);
  const bad = await mx.check("info@noexiste-xyz.es");
  assert.equal(bad.ok, false);
  assert.equal((await mx.check("sin-arroba")).ok, false);
});

test("buscador: Brave principal, Google (Apify) de respaldo y cache por consulta", async () => {
  cache._reset(); breaker.reset();
  config.discovery.apiKey = "brave-key";
  config.discovery.primary = "";
  config.discovery.mode = "fallback";
  config.discovery.minResults = 12;
  config.discovery.cacheDays = 30;
  config.apify.token = "apify-token";
  const apify = require("../src/lib/apify");
  let apifyCalls = 0;
  apify.runActor = async function (actor, input) {
    apifyCalls++;
    return { ok: true, items: input.queries.split("\n").map(function (q) { return { searchQuery: { term: q }, organicResults: [1, 2, 3, 4, 5, 6, 7, 8].map(function (i) { return { url: "https://g" + i + ".es/" + encodeURIComponent(q), title: "G" + i }; }) }; }) };
  };
  let braveOk = false, braveCalls = 0;
  global.fetch = async function (url) {
    if (/api\.search\.brave\.com/.test(url)) {
      braveCalls++;
      if (!braveOk) return { ok: false, status: 500, headers: new Map(), text: async function () { return "{}"; } };
      const q = new URL(url).searchParams.get("q");
      const results = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(function (i) { return { url: "https://b" + i + ".es/" + encodeURIComponent(q), title: "B" + i }; });
      return { ok: true, status: 200, headers: new Map(), text: async function () { return JSON.stringify({ web: { results: results } }); } };
    }
    return { ok: false, status: 404, headers: new Map(), text: async function () { return ""; } };
  };
  const discovery = require("../src/adapters/discovery");
  const qs = [{ q: "acme distribuidor oficial" }, { q: "acme mayorista" }];
  /* Brave falla -> respaldo */
  const r1 = await discovery.searchQueries(qs, { perQuery: 10, timeoutMs: 20000 });
  assert.equal(r1.ok, true);
  assert.ok(r1.engines.some(function (e) { return /apify.*respaldo/.test(e); }), r1.engines.join(","));
  assert.equal(apifyCalls, 1);
  /* Brave va bien -> no se gasta Apify */
  breaker.reset(); braveOk = true;
  const qs2 = [{ q: "zeta distribuidor oficial" }, { q: "zeta mayorista" }];
  const r2 = await discovery.searchQueries(qs2, { perQuery: 10, timeoutMs: 20000 });
  assert.deepEqual(r2.engines, ["brave"]);
  assert.equal(apifyCalls, 1);
  assert.equal(r2.results.length, 20);
  /* Repetir -> cache, sin llamadas */
  const n = braveCalls;
  const r3 = await discovery.searchQueries(qs2, { perQuery: 10, timeoutMs: 20000 });
  assert.equal(braveCalls, n);
  assert.equal(r3.cachedQueries, 2);
  assert.equal(r3.results.length, 20);
});

test("buscador: Brave sin cupo del mes -> se aparta y entra el respaldo sin insistir", async () => {
  cache._reset(); breaker.reset();
  delete process.env.BRAVE_RPS;
  config.discovery.apiKey = "brave-key"; config.apify.token = "apify-token"; config.discovery.minResults = 12; config.discovery.mode = "fallback";
  const apify = require("../src/lib/apify");
  apify.runActor = async function (a, input) { return { ok: true, items: input.queries.split("\n").map(function (q) { return { searchQuery: { term: q }, organicResults: [{ url: "https://g.es/" + encodeURIComponent(q), title: "G" }] }; }) }; };
  let braveCalls = 0;
  global.fetch = async function (url) {
    braveCalls++;
    return { ok: false, status: 429, headers: new Map([["x-ratelimit-limit", "1, 2000"], ["x-ratelimit-remaining", "0, 0"]]), text: async function () { return "{}"; } };
  };
  const discovery = require("../src/adapters/discovery");
  const r = await discovery.searchQueries([{ q: "cupo uno" }, { q: "cupo dos" }, { q: "cupo tres" }], { perQuery: 10, timeoutMs: 20000 });
  assert.equal(braveCalls, 1, "una sola llamada: el cupo esta agotado");
  assert.equal(discovery.braveStats.monthLeft, 0);
  assert.ok(r.engines.some(function (e) { return /apify/.test(e); }));
  assert.equal(breaker.allow("brave"), false);
  delete process.env.BRAVE_RPS;
});

test("buscador modo both: Brave y Google a la vez, se suman, y se mide que buscador trae proveedores utiles", async () => {
  cache._reset(); breaker.reset();
  const docs = require("../src/lib/docstore");
  const mem = {};
  docs._setForTests({ kind: "mem",
    async list(c) { return Object.values(mem[c] || {}); },
    async get(c, id) { return (mem[c] || {})[id] || null; },
    async put(c, id, d) { mem[c] = mem[c] || {}; mem[c][id] = JSON.parse(JSON.stringify(d)); return d; },
    async del(c, id) { const h = !!(mem[c] && mem[c][id]); if (h) delete mem[c][id]; return h; } });
  config.discovery.apiKey = "brave-key"; config.apify.token = "apify-token"; config.discovery.mode = "both";
  const apify = require("../src/lib/apify");
  apify.runActor = async function (a, input) { return { ok: true, items: input.queries.split("\n").map(function (q) { return { searchQuery: { term: q }, organicResults: [{ url: "https://comun.es/x", title: "C" }, { url: "https://sologoogle.es/x", title: "G" }] }; }) }; };
  global.fetch = async function (url) {
    const results = [{ url: "https://comun.es/y", title: "C" }, { url: "https://solobrave.es/y", title: "B" }];
    return { ok: true, status: 200, headers: new Map(), text: async function () { return JSON.stringify({ web: { results: results } }); } };
  };
  const discovery = require("../src/adapters/discovery");
  const r = await discovery.searchQueries([{ q: "marca both uno" }], { perQuery: 10, timeoutMs: 20000 });
  assert.deepEqual(r.engines.sort(), ["brave", "google(apify)"]);
  const hosts = r.results.map(function (x) { return new URL(x.url).hostname + ":" + x.engine; }).sort();
  assert.deepEqual(hosts, ["comun.es:brave", "comun.es:google", "solobrave.es:brave", "sologoogle.es:google"]);
  const learn = require("../src/lib/learn");
  await learn.engineHits([{ host: "comun.es", engines: ["brave", "google"] }, { host: "solobrave.es", engines: ["brave"] }, { host: "sologoogle.es", engines: ["google"] }]);
  await learn.syncContact({ id: "sologoogle.es", host: "sologoogle.es", status: "tarifa" });
  await learn.tariffResult("sologoogle.es", [{ verdict: "oportunidad" }]);
  const st = await learn.engineStats();
  assert.equal(st.soloBrave.proveedores, 1);
  assert.equal(st.soloGoogle.tarifas, 1);
  assert.equal(st.soloGoogle.conMargen, 1);
  assert.equal(st.ambos.proveedores, 1);
});
