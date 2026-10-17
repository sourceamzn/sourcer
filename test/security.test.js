const { test } = require("node:test");
const assert = require("node:assert/strict");
const security = require("../src/lib/security");

function mockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    ended: false,
    status: function (n) { this.statusCode = n; return this; },
    json: function (o) { this.body = o; return this; },
    setHeader: function (k, v) { this.headers[String(k).toLowerCase()] = v; },
    end: function () { this.ended = true; }
  };
}
function run(mw, req) {
  const res = mockRes();
  let called = false;
  mw(req, res, function () { called = true; });
  return { res: res, next: called };
}

test("API key: 401 sin clave y 200 con clave", () => {
  const mw = security.apiKeyGuard({ keys: function () { return ["clave-buena"]; }, env: function () { return "production"; } });
  const no = run(mw, { headers: {} });
  assert.equal(no.res.statusCode, 401);
  assert.equal(no.next, false);
  const yes = run(mw, { headers: { "x-api-key": "clave-buena" } });
  assert.equal(yes.res.statusCode, 200);
  assert.equal(yes.next, true);
});
test("API key: en produccion sin API_KEYS falla cerrado", () => {
  const mw = security.apiKeyGuard({ keys: function () { return []; }, env: function () { return "production"; } });
  const out = run(mw, { headers: {} });
  assert.equal(out.res.statusCode, 503);
  assert.equal(out.next, false);
});
test("API key: en desarrollo sin API_KEYS deja pasar", () => {
  const mw = security.apiKeyGuard({ keys: function () { return []; }, env: function () { return "development"; } });
  const out = run(mw, { headers: {} });
  assert.equal(out.next, true);
});
test("CORS: cabecera solo para el origen permitido", () => {
  const mw = security.cors({ origins: function () { return "https://tools.bruneagroup.com"; } });
  const ok = run(mw, { method: "POST", headers: { origin: "https://tools.bruneagroup.com" } });
  assert.equal(ok.res.headers["access-control-allow-origin"], "https://tools.bruneagroup.com");
  assert.ok(String(ok.res.headers["access-control-allow-headers"]).indexOf("X-API-Key") !== -1);
  const bad = run(mw, { method: "POST", headers: { origin: "https://evil.example" } });
  assert.equal(bad.res.headers["access-control-allow-origin"], undefined);
});
test("CORS: el preflight responde 204 sin llegar a la ruta", () => {
  const mw = security.cors({ origins: function () { return "https://tools.bruneagroup.com"; } });
  const out = run(mw, { method: "OPTIONS", headers: { origin: "https://tools.bruneagroup.com" } });
  assert.equal(out.res.statusCode, 204);
  assert.equal(out.res.ended, true);
  assert.equal(out.next, false);
});
test("rate limit: corta con 429 al superar el minuto", () => {
  const mw = security.rateLimit({ scope: "test-" + Date.now(), limit: function () { return 2; } });
  const req = { headers: {}, ip: "127.0.0.1" };
  assert.equal(run(mw, req).next, true);
  assert.equal(run(mw, req).next, true);
  const third = run(mw, req);
  assert.equal(third.res.statusCode, 429);
  assert.equal(third.next, false);
  assert.ok(Number(third.res.headers["retry-after"]) >= 1);
});
test("beacon: rechaza cuerpos por encima del tope", () => {
  const mw = security.beaconGuard({ maxBytes: function () { return 1024; } });
  const out = run(mw, { headers: { "content-length": "2048" } });
  assert.equal(out.res.statusCode, 413);
  assert.equal(out.next, false);
});
test("parseList limpia comas y espacios", () => {
  assert.deepEqual(security.parseList(" a, b ,, c "), ["a", "b", "c"]);
});
