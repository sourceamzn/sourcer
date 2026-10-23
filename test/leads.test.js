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
