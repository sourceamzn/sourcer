const test = require("node:test");
const assert = require("node:assert");

test("proveedores: repetir la busqueda no relee webs; solo lo nuevo se analiza y se marca", async () => {
  require("../src/lib/cache")._reset();
  const docs = require("../src/lib/docstore");
  const mem = {};
  docs._setForTests({ kind: "mem",
    async list(c) { return Object.values(mem[c] || {}); }, async get(c, id) { return (mem[c] || {})[id] || null; },
    async put(c, id, d) { mem[c] = mem[c] || {}; mem[c][id] = d; return d; }, async del() { return true; } });
  const discovery = require("../src/adapters/discovery");
  let hosts = ["distrib-acme.es", "mayorista-hogar.es"];
  discovery.searchQueries = async function (qs) {
    return { ok: true, engines: ["brave"], errors: [], cachedQueries: 0, results: hosts.map(function (h, i) { return { url: "https://" + h + "/acme", title: "Acme distribuidor oficial mayorista " + h, description: "Distribuidor mayorista de Acme. Tarifa profesional B2B.", query: qs[0].q, position: i + 1, engine: "brave" }; }) };
  };
  const pages = [];
  global.fetch = async function (url) {
    pages.push(String(url));
    return { ok: true, status: 200, headers: new Map(), text: async function () { return "<html><body>" + "Distribuidor oficial Acme para profesionales. Acceso clientes, tarifa B2B. ".repeat(10) + "8410000000017</body></html>"; } };
  };
  const fab = require("../src/adapters/fabricantes");
  const body = { ean: "8410000000017", brand: "Acme", name: "Acme batidora" };
  const r1 = await fab.find(body, {});
  assert.equal(r1.ok, true);
  const read1 = pages.length;
  assert.ok(read1 >= 2, "la primera vez lee las webs");
  assert.equal(r1.data.reuse.firstTime, true);
  const r2 = await fab.find(body, {});
  assert.equal(pages.length, read1, "la segunda vez no lee nada");
  assert.ok(r2.data.reuse.reused >= 2);
  assert.equal(r2.data.reuse.newCount, 0);
  hosts = hosts.concat(["nuevo-distrib.es"]);
  const r3 = await fab.find(body, {});
  assert.equal(pages.length, read1 + 1, "solo se lee la web nueva");
  assert.equal(r3.data.reuse.newCount, 1);
  assert.ok(r3.data.leads.some(function (l) { return l.host === "nuevo-distrib.es" && l.isNew; }));
});
