const test = require("node:test");
const assert = require("node:assert");

function memDocs() {
  const docs = require("../src/lib/docstore");
  const mem = {};
  docs._setForTests({ kind: "mem",
    async list(c) { return Object.values(mem[c] || {}).map((x) => JSON.parse(JSON.stringify(x))); },
    async get(c, id) { return (mem[c] || {})[id] ? JSON.parse(JSON.stringify(mem[c][id])) : null; },
    async put(c, id, d) { mem[c] = mem[c] || {}; mem[c][id] = JSON.parse(JSON.stringify(d)); return d; },
    async del(c, id) { const h = !!(mem[c] && mem[c][id]); if (h) delete mem[c][id]; return h; } });
  return mem;
}

test("finder: filtros estrictos de Buy Box compartida primero; si dan poco, se relajan y se suman", async () => {
  const { config } = require("../src/config");
  config.keepa.apiKey = "k";
  const sent = [];
  global.fetch = async function (url, opts) {
    const sel = JSON.parse(opts.body);
    sent.push(sel);
    let asins = [];
    if (sel.buyBoxStatsSellerCount90_gte) asins = ["B0STRICT01", "B0STRICT02"];
    else if (sel.buyBoxStatsAmazon90_lte != null) asins = ["B0STRICT02", "B0MEDIUM01"];
    else if (sel.current_NEW_FBA_gte) asins = Array.from({ length: 30 }, (_, i) => "B0OLD" + String(i).padStart(5, "0"));
    return { ok: true, status: 200, headers: new Map(), text: async () => JSON.stringify({ asinList: asins, tokensConsumed: 10 }) };
  };
  const inv = require("../src/adapters/inverso");
  const notes = [];
  const r = await inv.finderSafe({ domainId: 9, perPage: 100 }, notes, null, { minSales: 20 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.asins.slice(0, 3), ["B0STRICT01", "B0STRICT02", "B0MEDIUM01"], "lo estricto va primero");
  assert.equal(sent[0].buyBoxStatsSellerCount90_gte, 2);
  assert.equal(sent[0].buyBoxStatsAmazon90_lte, 30);
  assert.equal(sent[0].salesRankDrops90_gte, 60, "20 ventas/mes ~ 60 caidas de BSR en 90 d");
  assert.equal(sent[0].offerCountFBA_gte, 2);
  assert.ok(/Buy Box compartida/.test(notes.join(" ")));
  assert.equal(inv.salesShare({ sales: 300, fbaThird: 4, amazonSells: true }), 50);
});

test("radar: guarda lo nuevo, excluye lo visto y no repite descartados", async () => {
  memDocs();
  const radar = require("../src/lib/radar");
  require("../src/lib/keepacost").usage.tokensLeft = null;
  const calls = [];
  let batch = [
    { asin: "B0RAD00001", title: "Freidora", estado: "apt", sales: 300, fbaThird: 3, plan: { priceMax: 30, reasons: [] } },
    { asin: "B0RAD00002", title: "Hervidor", estado: "casi", sales: 80, plan: { priceMax: 10, reasons: ["aviso"] } },
    { asin: "B0RAD00003", title: "Marca propia", estado: "descarte", plan: {} }
  ];
  radar._setDeps({ inverso: { keepaReady: () => true, actions: { candidates: async (b) => { calls.push(b); return { ok: true, data: { candidates: batch.filter((c) => b.exclude.indexOf(c.asin) === -1) } }; } } } });
  await radar.setCfg({ enabled: true, categories: [{ id: "599391031", name: "Hogar y cocina" }] });
  let r = await radar.run("manual");
  assert.equal(r.ok, true);
  assert.equal(r.run.nuevos, 2);
  let items = await radar.list();
  assert.deepEqual(items.map((x) => x.asin).sort(), ["B0RAD00001", "B0RAD00002"]);
  assert.equal(items[0].status, "nuevo");
  await radar.setStatus("B0RAD00002", "descartado");
  batch.push({ asin: "B0RAD00004", title: "Batidora", estado: "apt", plan: {} });
  r = await radar.run("manual");
  assert.deepEqual(calls[1].exclude.sort(), ["B0RAD00001", "B0RAD00002"], "no paga fichas ya vistas");
  assert.equal(r.run.nuevos, 1);
  items = await radar.list();
  assert.equal(items.find((x) => x.asin === "B0RAD00002").status, "descartado");
  assert.equal(items[0].asin, "B0RAD00004");
  assert.equal((await radar.getCfg()).lastRun.nuevos, 1);
});
