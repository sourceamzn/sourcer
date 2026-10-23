const test = require("node:test");
const assert = require("node:assert");
const cs = require("../src/lib/contactscan");

test("contactscan: extrae emails (mailto, texto, [at]), WhatsApp, telefonos y CIF", () => {
  const acc = { emails: [], phones: [], whatsapp: [], cif: "", company: "", form: "", pages: [] };
  const html = '<a href="mailto:ventas@distrib-levante.es">Ventas</a> <p>info [at] distrib-levante.es</p>' +
    '<a href="https://wa.me/34612345678">WhatsApp</a> <a href="tel:+34 961 234 567">Llamar</a>' +
    '<p>Distribuciones Levante S.L. CIF: B12345678</p><img src="logo@2x.png"> <a href="/contacto">Contacto</a> <a href="/aviso-legal">Aviso legal</a>';
  const links = cs.extract(html, "https://distrib-levante.es/p/1", acc);
  assert.deepEqual(acc.emails.sort(), ["info@distrib-levante.es", "ventas@distrib-levante.es"]);
  assert.deepEqual(acc.whatsapp, ["34612345678"]);
  assert.ok(acc.phones.includes("+34961234567"));
  assert.equal(acc.cif, "B12345678");
  assert.ok(links.includes("https://distrib-levante.es/contacto"));
  assert.ok(links.includes("https://distrib-levante.es/aviso-legal"));
});

test("contactscan: ordena primero correos comerciales del propio dominio", () => {
  const r = cs.rankEmails(["pepe@gmail.com", "rrhh@acme.es", "ventas@acme.es"], "acme.es");
  assert.equal(r[0], "ventas@acme.es");
  assert.equal(r[2], "pepe@gmail.com");
});

test("contacts: guardar fusiona productos por dominio (almacen en memoria)", async () => {
  const docs = require("../src/lib/docstore");
  const mem = {};
  docs._setForTests({
    kind: "mem",
    async list(c) { return Object.values(mem[c] || {}); },
    async get(c, id) { return (mem[c] || {})[id] || null; },
    async put(c, id, d) { mem[c] = mem[c] || {}; mem[c][id] = JSON.parse(JSON.stringify(d)); return d; },
    async del(c, id) { const h = !!(mem[c] && mem[c][id]); if (h) delete mem[c][id]; return h; }
  });
  /* express puede no estar instalado en el entorno de pruebas: router minimo. */
  let router;
  try { router = require("../src/routes/contacts"); } catch (e) {
    const Module = require("module");
    const orig = Module._load;
    Module._load = function (name) {
      if (name === "express") {
        return { Router() {
          const routes = [];
          const r = { handle(req, res, next) {
            for (const rt of routes) {
              if (rt.m !== req.method) continue;
              const pr = rt.p.split("/"), ur = req.url.split("/");
              if (pr.length !== ur.length) continue;
              const params = {}; let ok = true;
              pr.forEach((seg, i) => { if (seg.startsWith(":")) params[seg.slice(1)] = decodeURIComponent(ur[i]); else if (seg !== ur[i]) ok = false; });
              if (ok) { req.params = params; return rt.h(req, res); }
            }
            next();
          } };
          ["get", "post", "patch", "delete"].forEach((m) => { r[m] = (p, h) => routes.push({ m: m.toUpperCase(), p, h }); });
          return r;
        } };
      }
      return orig.apply(this, arguments);
    };
    delete require.cache[require.resolve("../src/routes/contacts")];
    router = require("../src/routes/contacts");
    Module._load = orig;
  }
  async function call(method, path, body) {
    return new Promise((resolve) => {
      const req = { method, url: path, body, params: {}, query: {}, headers: {} };
      const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(d) { resolve({ status: this.statusCode, body: d }); }, setHeader() {}, getHeader() {}, end() { resolve({ status: this.statusCode }); } };
      router.handle(req, res, () => resolve({ status: 404 }));
    });
  }
  const lead = { url: "https://www.distrib-levante.es/acme/zx", title: "Distrib Levante", role: "mayorista", contact: { emails: ["ventas@distrib-levante.es"] } };
  await call("POST", "/", { lead, product: { asin: "B0A", name: "Batidora A", image: "https://x/a.jpg" } });
  const r2 = await call("POST", "/", { lead, product: { asin: "B0B", name: "Batidora B" } });
  assert.equal(r2.body.contact.id, "distrib-levante.es");
  assert.equal(r2.body.contact.products.length, 2);
  const r3 = await call("PATCH", "/distrib-levante.es", { status: "contactado", notes: "Pedir tarifa" });
  assert.equal(r3.body.contact.status, "contactado");
  assert.ok(r3.body.contact.contactedAt);
  const l = await call("GET", "/");
  assert.equal(l.body.contacts.length, 1);
  /* Deshacer: "Ha respondido" por error vuelve a "contactado" y recupera la secuencia. */
  const r4 = await call("PATCH", "/distrib-levante.es", { status: "respondido" });
  assert.equal(r4.body.contact.status, "respondido");
  const r5 = await call("PATCH", "/distrib-levante.es", { undo: true });
  assert.equal(r5.body.contact.status, "contactado");
  const r6 = await call("PATCH", "/distrib-levante.es", { undo: true });
  assert.equal(r6.status, 400);
  /* Quitar y recuperar de la papelera. */
  await call("DELETE", "/distrib-levante.es");
  assert.equal((await call("GET", "/")).body.contacts.length, 0);
  const r7 = await call("POST", "/distrib-levante.es/restore");
  assert.equal(r7.body.contact.status, "contactado");
  assert.equal((await call("GET", "/")).body.contacts.length, 1);
});
