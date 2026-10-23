const test = require("node:test");
const assert = require("node:assert");

function stubAnthropic(handler) {
  const http = require("../src/lib/http");
  const orig = http.jsonFetch;
  const calls = [];
  http.jsonFetch = async (url, opts) => {
    if (String(url).indexOf("api.anthropic.com") !== -1) {
      const body = JSON.parse(opts.body);
      calls.push(body);
      const json = handler(body);
      return { ok: true, status: 200, data: { usage: { input_tokens: 500, output_tokens: 150 }, content: [{ type: "text", text: JSON.stringify(json) }] } };
    }
    return orig(url, opts);
  };
  return { calls, restore() { http.jsonFetch = orig; } };
}
function memDocs() {
  const docs = require("../src/lib/docstore");
  const mem = {};
  docs._setForTests({ kind: "mem", async list(c) { return Object.values(mem[c] || {}); }, async get(c, id) { return (mem[c] || {})[id] || null; }, async put(c, id, d) { mem[c] = mem[c] || {}; mem[c][id] = JSON.parse(JSON.stringify(d)); return d; }, async del(c, id) { const h = !!(mem[c] && mem[c][id]); if (h) delete mem[c][id]; return h; } });
}

test("ia proveedores: Haiku añade busquedas y reclasifica webs (blog fuera, mayorista dentro)", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-test";
  memDocs();
  const disc = require("../src/adapters/discovery");
  const origSearch = disc.searchQueries;
  let sentQueries = [];
  disc.searchQueries = async (qs) => { sentQueries = qs.map((x) => x.q); return { ok: true, engines: ["stub"], errors: [], results: [
    { url: "https://www.electro-suministros.es/tegui-374240", title: "Tegui 374240 telefono T-71U", description: "Ref 374240", query: qs[0].q, group: "ean", position: 1 },
    { url: "https://blogdeporteros.com/review-t71u", title: "Review del Tegui T-71U", description: "Nuestra opinion", query: qs[0].q, group: "ean", position: 2 }
  ] }; };
  const st = stubAnthropic((body) => {
    if (/Propon como maximo 3 busquedas/.test(body.messages[0].content)) return { titular_marca: "Legrand Group España", consultas: ["Legrand Group España distribuidores material electrico"] };
    return { webs: [{ id: 0, rol: "mayorista", vende_producto: true, motivo: "almacen de material electrico profesional" }, { id: 1, rol: "irrelevante", vende_producto: false, motivo: "blog de opiniones" }] };
  });
  try {
    const fab = require("../src/adapters/fabricantes");
    const r = await fab.find({ ean: "8410000000000", brand: "Legrand", model: "374240", name: "Telefono T-71U de TEGUI 374240" });
    assert.ok(r.ok);
    assert.ok(sentQueries.includes("Legrand Group España distribuidores material electrico"), "consulta de la IA lanzada");
    const d = r.data;
    const es = d.leads.find((l) => l.host === "electro-suministros.es");
    assert.equal(es.role, "mayorista");
    assert.equal(es.ai.vende, true);
    assert.ok(d.retailers.some((l) => l.host === "blogdeporteros.com" && l.role === "irrelevante"));
    assert.equal(d.ai.used, true);
    assert.ok(st.calls.every((c) => /haiku/.test(c.model)), "solo Haiku");
  } finally { st.restore(); disc.searchQueries = origSearch; delete process.env.ANTHROPIC_API_KEY; }
});

test("ia productos: Haiku quita repuestos ANTES de pedir Buy Box y sugiere busquedas", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-test";
  process.env.KEEPA_API_KEY = process.env.KEEPA_API_KEY || "x";
  const { config } = require("../src/config");
  config.keepa.apiKey = config.keepa.apiKey || "x";
  memDocs();
  const http = require("../src/lib/http");
  const orig = http.jsonFetch;
  const keepaDeep = [];
  http.jsonFetch = async (url, opts) => {
    if (String(url).indexOf("api.anthropic.com") !== -1) {
      return { ok: true, status: 200, data: { usage: {}, content: [{ type: "text", text: JSON.stringify({ descartar: [{ asin: "B0AIDROP02", motivo: "es una cuchilla de repuesto" }], sugerencias: ["batidora de vaso", "picadora"] }) }] } };
    }
    const u = new URL(url); const path = u.pathname.slice(1); const p = Object.fromEntries(u.searchParams);
    if (path === "search") return { ok: true, status: 200, data: { tokensConsumed: 10, tokensLeft: 900, products: [{ asin: "B0AIKEEP01" }, { asin: "B0AIDROP02" }, { asin: "B0AIKEEP03" }] } };
    if (path === "query") return { ok: true, status: 200, data: { tokensConsumed: 10, tokensLeft: 900, asinList: [] } };
    if (path === "product") {
      const as = p.asin.split(",");
      if (p.buybox) keepaDeep.push(...as);
      return { ok: true, status: 200, data: { tokensConsumed: as.length, tokensLeft: 900, products: as.map((a) => { const cur = []; cur[1] = 4500; cur[3] = 300; cur[11] = 6; return { asin: a, title: a === "B0AIDROP02" ? "Batidora: vaso medidor" : "Batidora de mano 1000W", stats: { current: cur, avg90: [], buyBoxStats: { A1: { percentageWon: 50, isFBA: true }, A2: { percentageWon: 50, isFBA: true } } } }; }) } };
    }
    return { ok: true, status: 200, data: {} };
  };
  try {
    const inv = require("../src/adapters/inverso");
    const r = await inv.actions.candidates({ query: "batidora", limit: 10, useHistory: false, filters: { minFbaThird: 2, bbRule: 1, requireTwoSellers: 0 } });
    assert.ok(r.ok, JSON.stringify(r).slice(0, 300));
    assert.ok(!keepaDeep.includes("B0AIDROP02"), "no se paga Buy Box del descartado");
    assert.ok(keepaDeep.includes("B0AIKEEP01"));
    assert.deepEqual(r.data.aiSuggestions, ["batidora de vaso", "picadora"]);
    assert.equal(r.data.aiDropped[0].asin, "B0AIDROP02");
  } finally { http.jsonFetch = orig; delete process.env.ANTHROPIC_API_KEY; }
});

test("ia: sin clave no se llama a la IA y todo sigue funcionando", async () => {
  delete process.env.ANTHROPIC_API_KEY;
  const ai = require("../src/lib/ai");
  assert.equal(ai.ready(), false);
  const r = await ai.reviewTitles("x", [{ asin: "B0", title: "t" }]);
  assert.equal(r.ok, false);
});
