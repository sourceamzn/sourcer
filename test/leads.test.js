const test = require("node:test");
const assert = require("node:assert");
const leads = require("../src/lib/leads");

const EAN = "8412345678905";

test("leads: consultas replican la busqueda manual (EAN entre comillas + mayorista/distribuidor)", () => {
  const q = leads.buildLeadQueries({ ean: EAN, brand: "Acme", model: "ZX-200", manufacturer: "Acme Iberia S.L." });
  const texts = q.map((x) => x.q);
  assert.equal(texts[0], '"8412345678905" mayorista');
  assert.ok(texts.includes('"8412345678905" distribuidor'));
  assert.ok(texts.includes('"8412345678905" al por mayor'));
  assert.ok(texts.some((t) => /"Acme" distribuidor oficial/.test(t)));
  assert.ok(texts.some((t) => /"Acme" "ZX-200" mayorista/.test(t)));
  assert.ok(q.length <= 12);
});

test("leads: sin EAN se busca por marca; sin marca ni EAN no hay consultas", () => {
  assert.ok(leads.buildLeadQueries({ brand: "Acme" }).every((x) => x.group !== "ean"));
  assert.equal(leads.buildLeadQueries({ name: "batidora" }).length, 0);
});

const SERP = [
  { url: "https://www.mediamarkt.es/es/product/acme-zx200.html", title: "Acme ZX-200 | MediaMarkt", description: "Comprar Acme ZX-200 al mejor precio. Envío gratis. 49,99 €", query: '"8412345678905" mayorista', group: "ean", position: 1 },
  { url: "https://distribuciones-levante.com/acme/zx-200", title: "ACME ZX-200 - Distribuciones Levante, mayorista", description: "EAN 8412345678905. Venta solo a profesionales. Pedido mínimo 6 uds.", query: '"8412345678905" mayorista', group: "ean", position: 2 },
  { url: "https://www.acme.com/es/zx-200", title: "ZX-200 | Acme official", description: "Batidora ZX-200", query: '"Acme" official website', group: "marca", position: 1 },
  { url: "https://www.tiendacualquiera.es/acme-zx200", title: "Acme ZX200 batidora - Oferta", description: "Añadir al carrito. 52,90 € envío en 24h", query: '"8412345678905"', group: "ean", position: 3 },
  { url: "https://www.idealo.es/precios/acme-zx200", title: "Acme ZX-200 desde 47 €", description: "Compara precios", query: '"8412345678905"', group: "ean", position: 4 },
  { url: "https://www.ean-search.org/?q=8412345678905", title: "8412345678905 - ACME ZX-200", description: "EAN 8412345678905", query: '"8412345678905"', group: "ean", position: 5 },
  { url: "https://www.amazon.es/dp/B000000000", title: "Acme ZX-200", description: "", query: '"8412345678905"', group: "ean", position: 6 },
  { url: "https://importhogar.es/marcas/acme", title: "Importhogar · Distribuidor oficial Acme en España", description: "Hazte distribuidor", query: '"Acme" distribuidor oficial España', group: "marca", position: 1 }
];

test("leads: clasifica fabricante, distribuidor oficial y mayorista; aparta minoristas y comparadores", () => {
  const r = leads.rankLeads(SERP, { eans: [EAN], brand: "Acme", manufacturer: "Acme Iberia S.L." });
  const role = Object.fromEntries(r.leads.concat(r.retailers).map((l) => [l.host, l.role]));
  assert.equal(role["acme.com"], "fabricante");
  assert.equal(role["importhogar.es"], "distribuidor_oficial");
  assert.equal(role["distribuciones-levante.com"], "mayorista");
  assert.equal(role["mediamarkt.es"], "minorista");
  assert.equal(role["idealo.es"], "minorista");
  assert.equal(role["tiendacualquiera.es"], "minorista_probable");
  assert.equal(role["ean-search.org"], "info_ean");
  assert.equal(role["amazon.es"], undefined, "Amazon nunca es proveedor");
  assert.ok(r.retailers.every((l) => /minorista/.test(l.role)));
  /* Los proveedores van por delante de cualquier minorista y el mayorista con EAN visible puntua alto. */
  const lev = r.leads.find((l) => l.host === "distribuciones-levante.com");
  assert.equal(lev.eanOnSerp, true);
  assert.ok(r.leads[0].role !== "info_ean");
});

test("leads: la marca dentro de un dominio largo no confunde (lg != blog)", () => {
  assert.equal(leads.brandInHost("blog.example.com", leads.brandSlugs("LG")), false);
  assert.equal(leads.brandInHost("lg.com", leads.brandSlugs("LG")), true);
  assert.equal(leads.brandInHost("acmeiberia.es", leads.brandSlugs("Acme")), true);
  assert.equal(leads.brandInHost("superofertasdehogar.es", leads.brandSlugs("Hogar")), false);
});

test("leads: EAN con espacios o sin ceros se detecta, otro EAN no", () => {
  const f = leads.eanForms([EAN]);
  assert.ok(leads.textHasEan("Codigo: 8 412345 678905", f));
  assert.ok(!leads.textHasEan("Codigo: 84123456789050", f));
  assert.ok(leads.textHasEan("upc 012345678905", leads.eanForms(["012345678905"])));
});

test("leads: la pagina confirma B2B (precios tras registro, contacto, enlace a distribuidores)", () => {
  const html = '<html><body><a href="/area-profesionales">Área profesional</a><p>Precios solo para clientes registrados.</p>' +
    '<p>Ref ZX-200 EAN 8412345678905</p><p>Contacto: ventas@levante-distrib.es · 961 23 45 67</p></body></html>';
  const ps = leads.pageSignals(html, { eans: [EAN] }, "https://levante-distrib.es/p/1");
  assert.equal(ps.eanOnPage, true);
  assert.equal(ps.loginWall, true);
  assert.deepEqual(ps.emails, ["ventas@levante-distrib.es"]);
  assert.equal(ps.distributorLink, "https://levante-distrib.es/area-profesionales");
  const lead = { host: "levante-distrib.es", role: "sin_clasificar", signals: [], queries: ["q"], bestPosition: 3 };
  leads.applyPage(lead, ps);
  assert.equal(lead.role, "mayorista");
  assert.ok(lead.contact && lead.contact.emails.length === 1);
});

test("leads: un 'mayorista' por snippet que resulta ser tienda al consumidor baja a minorista", () => {
  const html = "<p>Añadir al carrito</p><p>Envío gratis</p><p>Opiniones</p><p>49,99 €</p><p>Oferta</p>";
  const lead = { host: "x.es", role: "mayorista", signals: ["mayorista"], queries: [], bestPosition: 1 };
  leads.applyPage(lead, leads.pageSignals(html, { eans: [EAN] }));
  assert.equal(lead.role, "minorista_probable");
});

test("inverso: Product Finder ordena por BSR ascendente (mas vendidos primero)", () => {
  const src = require("fs").readFileSync(require("path").join(__dirname, "../src/adapters/inverso.js"), "utf8");
  assert.ok(!/current_SALES",\s*"desc"/.test(src));
});

test("inverso: sin dato de ofertas, thirdParty es desconocido (null) y no descarta por 'sin competencia'", () => {
  const inv = require("../src/adapters/inverso");
  const m = inv.metricsFromKeepa({ asin: "B0TEST0001", title: "x", stats: { current: [-1, 2999, -1, 1500], avg90: [] } });
  assert.equal(m.thirdParty, null);
  const plan = require("../src/lib/plan");
  const p = plan.planFor(Object.assign({}, m, { pvp: 60, sales: 50 }), plan.PLAN_DEFAULT);
  assert.ok(!p.reasons.some((r) => /oferta\(s\) de terceros; con un unico vendedor/.test(r)));
  /* Con COUNT_NEW (csv 11) presente se usa como recuento de ofertas. */
  const cur = []; cur[3] = 1500; cur[11] = 7;
  const m2 = inv.metricsFromKeepa({ asin: "B0TEST0002", title: "x", stats: { current: cur } });
  assert.equal(m2.thirdParty, 7);
});

test("leads: caso real Tegui (EAN-8 rellenado con ceros, marca Keepa Legrand, titulo TEGUI)", () => {
  const b = { ean: "0000013008420", brand: "Legrand", manufacturer: "Legrand", model: "374240", name: "Teléfono Blanco Universal T-71U Serie 7 de TEGUI 374240" };
  const q = leads.buildLeadQueries(b).map((x) => x.q);
  assert.ok(!q.some((t) => t.includes("0000013008420")), "nunca se busca el EAN rellenado");
  assert.ok(q.includes('"13008420" "Legrand" mayorista'));
  assert.ok(q.includes('"Tegui" "374240"'));
  /* Con un EAN-13 real disponible, manda ese. */
  const q2 = leads.buildLeadQueries(Object.assign({}, b, { eans: ["8410256003749"] })).map((x) => x.q);
  assert.equal(q2[0], '"8410256003749" mayorista');
  /* tegui.es se reconoce como fabricante aunque Keepa diga Legrand. */
  const r = leads.rankLeads([{ url: "https://www.tegui.es/telefonos/374240", title: "Teléfono T-71U 374240", query: '"Tegui" "374240"', group: "modelo", position: 1 }],
    { eans: [b.ean], brand: "Legrand", brands: leads.brandCandidates(b) });
  assert.equal(r.leads[0].role, "fabricante");
});

test("leads: precio frente al maximo (B0DCW34G9T: PVP 64, max 32,48 con IVA)", () => {
  const plan = require("../src/lib/plan");
  const p = plan.planFor({ pvp: 64, sales: 23, fees: { referralPct: 7, fbaFee: 4.76, source: "keepa" } }, plan.PLAN_DEFAULT);
  assert.ok(Math.abs(p.priceMax - 32.48) < 0.05);
  assert.ok(Math.abs(p.priceMaxNet - p.priceMax / 1.21) < 0.02);
  assert.ok(p.breakEven > p.priceMax);
  const t = { priceMax: p.priceMax, priceMaxNet: p.priceMaxNet, breakEven: p.breakEven, breakEvenNet: p.breakEvenNet };
  /* Mayorista sin indicar IVA: se asume sin IVA (prudente). */
  assert.equal(leads.priceBand({ role: "mayorista", price: { price: 25, vat: null } }, t).band, "ok");
  assert.equal(leads.priceBand({ role: "mayorista", price: { price: 30, vat: null } }, t).band, "justo");
  assert.equal(leads.priceBand({ role: "mayorista", price: { price: 45, vat: "sin" } }, t).band, "caro");
  /* Tienda: 32 con IVA = 26,4 sin IVA -> deja margen. */
  assert.equal(leads.priceBand({ role: "minorista", price: { price: 32, vat: null } }, t).band, "ok");
  assert.equal(leads.priceBand({ role: "mayorista" }, t).band, "sin_precio");
  /* Orden: con margen > justo > sin precio > caro, aunque el caro sea fabricante. */
  const L = [
    { role: "fabricante", score: 130, priceCheck: { band: "caro" } },
    { role: "mayorista", score: 90, priceCheck: { band: "sin_precio" } },
    { role: "mayorista", score: 80, priceCheck: { band: "ok" } },
    { role: "distribuidor_oficial", score: 95, priceCheck: { band: "justo" } }
  ].sort(leads.compareLeads);
  assert.deepEqual(L.map((x) => x.priceCheck.band), ["ok", "justo", "sin_precio", "caro"]);
});

test("leads: lee precio y si es con o sin IVA", () => {
  assert.deepEqual(leads.priceFromText("Precio: 24,90 € + IVA"), { price: 24.9, vat: "sin" });
  assert.deepEqual(leads.priceFromText("PVP 39,95 € IVA incluido"), { price: 39.95, vat: "con" });
  const h = '<script type="application/ld+json">{"@type":"Product","offers":{"price":"18.50","priceCurrency":"EUR"}}</script><p>Precios sin IVA</p>';
  const r = leads.priceFromHtml(h);
  assert.equal(r.price, 18.5);
  assert.equal(r.vat, "sin");
});

test("regla Buy Box: sin 2 FBA de terceros que la compartan -> descarte (sin pedir ofertas)", () => {
  const inv = require("../src/adapters/inverso");
  const plan = require("../src/lib/plan");
  const P = Object.assign({}, plan.PLAN_DEFAULT, { requireTwoSellers: 0 });
  const cur = []; cur[1] = 5500; cur[3] = 20; cur[10] = -1; cur[11] = 3; cur[18] = 6400;
  /* Caso B0DCW34G9T: ninguna oferta FBA de terceros. */
  const m0 = inv.metricsFromKeepa({ asin: "B0DCW34G9T", title: "x", stats: { current: cur, avg90: [] } });
  assert.equal(m0.fbaThird, 0);
  assert.equal(plan.planFor(Object.assign({}, m0, { pvp: 64, sales: 23 }), P).estado, "descarte");
  /* Buy Box 90 d: Amazon + 1 FBA de tercero -> descarte. */
  const cur2 = cur.slice(); cur2[10] = 5900;
  const bst1 = { ATVPDKIKX0DER: { percentageWon: 70, isFBA: true }, A1SELLERFBA: { percentageWon: 30, isFBA: true } };
  const m1 = inv.metricsFromKeepa({ asin: "B0X1", title: "x", stats: { current: cur2, avg90: [], buyBoxStats: bst1 } });
  assert.equal(m1.fbaThird, 1);
  assert.equal(plan.planFor(Object.assign({}, m1, { pvp: 64, sales: 23 }), P).estado, "descarte");
  /* 2 FBA de terceros que la ganan -> no se descarta por esta regla. */
  const bst2 = { A1SELLERFBA: { percentageWon: 55, isFBA: true }, A2OTHERFBA: { percentageWon: 45, isFBA: true } };
  const m2 = inv.metricsFromKeepa({ asin: "B0X2", title: "x", stats: { current: cur2, avg90: [], buyBoxStats: bst2 } });
  assert.equal(m2.fbaThird, 2);
  assert.ok(!plan.planFor(Object.assign({}, m2, { pvp: 64, sales: 23 }), P).reasons.some((r) => /FBA de terceros/.test(r)));
});

test("historial: la misma busqueda de <24 h se sirve guardada (0 llamadas a Keepa)", async () => {
  process.env.KEEPA_API_KEY = process.env.KEEPA_API_KEY || "x";
  const { config } = require("../src/config");
  config.keepa.apiKey = config.keepa.apiKey || "x";
  const docs = require("../src/lib/docstore");
  const mem = {};
  docs._setForTests({ kind: "mem", async list(c) { return Object.values(mem[c] || {}); }, async get(c, id) { return (mem[c] || {})[id] || null; }, async put(c, id, d) { mem[c] = mem[c] || {}; mem[c][id] = JSON.parse(JSON.stringify(d)); return d; }, async del(c, id) { const h = !!(mem[c] && mem[c][id]); if (h) delete mem[c][id]; return h; } });
  const http = require("../src/lib/http");
  const orig = http.jsonFetch;
  let calls = 0;
  http.jsonFetch = async (url) => {
    calls++;
    const u = new URL(url); const path = u.pathname.slice(1); const p = Object.fromEntries(u.searchParams);
    if (path === "search") return { ok: true, status: 200, data: { tokensConsumed: 10, tokensLeft: 900, products: [{ asin: "B0HIST0001" }, { asin: "B0HIST0002" }] } };
    if (path === "query") return { ok: true, status: 200, data: { tokensConsumed: 10, tokensLeft: 900, asinList: [] } };
    if (path === "product") { const as = p.asin.split(","); return { ok: true, status: 200, data: { tokensConsumed: 1, tokensLeft: 900, products: as.map((a) => { const cur = []; cur[1] = 4000; cur[3] = 500; cur[11] = 6; return { asin: a, title: "Freidora de aire 5L", stats: { current: cur, avg90: [], buyBoxStats: { A1: { percentageWon: 50, isFBA: true }, A2: { percentageWon: 50, isFBA: true } } } }; }) } }; }
    return { ok: true, status: 200, data: { tokensConsumed: 0 } };
  };
  try {
    const inv = require("../src/adapters/inverso");
    const body = { query: "freidora", limit: 10, filters: { minFbaThird: 2, bbRule: 1, requireTwoSellers: 0 } };
    const r1 = await inv.actions.candidates(body);
    assert.ok(r1.ok && r1.data.candidates.length > 0, "primera busqueda con resultados: " + JSON.stringify(r1).slice(0, 600));
    const n1 = calls;
    const r2 = await inv.actions.candidates(Object.assign({}, body, { seed: 999 }));
    assert.equal(r2.data.fromHistory, true);
    assert.equal(calls, n1, "sin llamadas nuevas a Keepa");
    assert.equal(r2.data.candidates.length, r1.data.candidates.length);
    const r3 = await inv.actions.candidates(Object.assign({}, body, { refresh: true }));
    assert.ok(!r3.data.fromHistory);
    const h = require("../src/lib/history");
    assert.equal((await h.list("candidates")).length, 1);
  } finally { http.jsonFetch = orig; }
});
