const test = require("node:test");
const assert = require("node:assert");

function memDocs() {
  const docs = require("../src/lib/docstore");
  const mem = {};
  docs._setForTests({
    kind: "mem",
    async list(c) { return Object.values(mem[c] || {}).map((x) => JSON.parse(JSON.stringify(x))); },
    async get(c, id) { return (mem[c] || {})[id] ? JSON.parse(JSON.stringify(mem[c][id])) : null; },
    async put(c, id, d) { mem[c] = mem[c] || {}; mem[c][id] = JSON.parse(JSON.stringify(d)); return d; },
    async del(c, id) { const h = !!(mem[c] && mem[c][id]); if (h) delete mem[c][id]; return h; }
  });
  return mem;
}

test("learn: reputacion desde el estado del contacto, marca->distribuidor y bloqueo", async () => {
  memDocs();
  const learn = require("../src/lib/learn");
  const leadsLib = require("../src/lib/leads");
  await learn.syncContact({ id: "robisa.es", host: "robisa.es", title: "Robisa", role: "distribuidor_oficial", status: "tarifa", products: [{ brand: "KODAK" }] });
  await learn.syncContact({ id: "malo.es", host: "malo.es", title: "Malo", status: "rechazado", products: [{ brand: "Kodak" }] });
  await learn.block("https://www.iso.org/x", { title: "ISO" });
  const L = await learn.forSearch(["kodak"]);
  assert.equal(L.known.length, 1, "solo el que dio tarifa; el que rechazo no se propone");
  assert.equal(L.known[0].d.host, "robisa.es");
  const leads = [{ host: "iso.org", url: "https://iso.org", score: 105, role: "sin_clasificar" }, { host: "otro.es", url: "https://otro.es", score: 90, role: "mayorista" }];
  const ap = learn.apply(leads, L, leadsLib);
  assert.equal(ap.hidden.length, 1);
  assert.equal(ap.leads[0].host, "robisa.es");
  assert.equal(ap.leads[0].learned.known, true);
  assert.match(ap.leads[0].learned.why, /KODAK/);
  ap.leads.sort(leadsLib.compareLeads);
  assert.equal(ap.leads[0].host, "robisa.es", "el conocido va primero al ordenar");
  /* Deshacer el estado deshace lo aprendido. */
  await learn.syncContact({ id: "robisa.es", host: "robisa.es", status: "pendiente", products: [{ brand: "KODAK" }] });
  const d = (await learn.all()).find((x) => x.host === "robisa.es");
  assert.equal(d.tariff, false);
  assert.equal(d.score, 5);
  /* Olvidar la marca. */
  await learn.forgetBrand("robisa.es", "kodak");
  assert.equal((await learn.forSearch(["KODAK"])).known.length, 0);
  /* Tarifa con margen. */
  await learn.tariffResult("acme.es", [{ verdict: "oportunidad", amzBrand: "Cosori" }, { verdict: "sin_margen", amzBrand: "X" }]);
  const k = await learn.forSearch(["cosori"]);
  assert.equal(k.known[0].d.host, "acme.es");
  assert.equal(k.known[0].d.marginHits, 1);
});
