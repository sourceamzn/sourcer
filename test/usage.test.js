const test = require("node:test");
const assert = require("node:assert");

function loadRouter(path) {
  try { return require(path); } catch (e) {
    const Module = require("module");
    const orig = Module._load;
    Module._load = function (name) {
      if (name === "express") return { Router() {
        const routes = [];
        const r = { handle(req, res, next) { for (const rt of routes) { if (rt.m === req.method && rt.p === req.url) return rt.h(req, res); } next(); } };
        ["get", "post", "put", "patch", "delete"].forEach((m) => { r[m] = (p, h) => routes.push({ m: m.toUpperCase(), p, h }); });
        return r;
      } };
      return orig.apply(this, arguments);
    };
    delete require.cache[require.resolve(path)];
    const r = require(path);
    Module._load = orig;
    return r;
  }
}
function call(router, method, url, body) {
  return new Promise((resolve) => {
    const req = { method, url, body, params: {}, query: {}, headers: {} };
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(d) { resolve({ status: this.statusCode, body: d }); } };
    router.handle(req, res, () => resolve({ status: 404 }));
  });
}

test("usage: suma por servicio y dia, y el panel devuelve estado, coste y avisos", async () => {
  const docs = require("../src/lib/docstore");
  const mem = {};
  docs._setForTests({ kind: "mem",
    async list(c) { return Object.values(mem[c] || {}); }, async get(c, id) { return (mem[c] || {})[id] ? JSON.parse(JSON.stringify(mem[c][id])) : null; },
    async put(c, id, d) { mem[c] = mem[c] || {}; mem[c][id] = JSON.parse(JSON.stringify(d)); return d; }, async del() { return true; } });
  const usage = require("../src/lib/usage");
  usage._reset();
  usage.add("keepa", { tokens: 120, requests: 3 });
  usage.add("brave", { queries: 1500 });
  usage.add("ai", { calls: 10, inTok: 200000, outTok: 20000, estUsd: 0.3 });
  await new Promise((r) => setTimeout(r, 20));
  await usage.flush();
  const m = Object.values(mem.usage)[0];
  assert.equal(m.total.keepa.tokens, 120);
  assert.equal(m.total.brave.queries, 1500);
  const { config } = require("../src/config");
  config.keepa.apiKey = ""; config.apify.token = ""; config.discovery.apiKey = "brave-key";
  const router = loadRouter("../src/routes/usage");
  const r = await call(router, "GET", "/");
  assert.equal(r.body.ok, true);
  const brave = r.body.services.find((s) => s.id === "brave");
  assert.equal(brave.status, "ok");
  assert.equal(brave.costEur, Math.round((1500 * 0.005 - 5) * 0.92 * 100) / 100, "1.500 consultas = 7,5 $ - 5 $ de credito");
  assert.ok(brave.dashboard.indexOf("brave.com") !== -1);
  assert.equal(r.body.services.find((s) => s.id === "keepa").status, "off");
  assert.ok(r.body.services.some((s) => s.id === "ai"));
  assert.equal(r.body.days.length, 30);
  assert.ok(r.body.days[29].svc.keepa.tokens >= 120);
});
