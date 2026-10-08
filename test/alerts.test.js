const os = require("os");
const path = require("path");

process.env.ALERTS_DATA_FILE = path.join(os.tmpdir(), "brunea-alerts-test-" + Date.now() + ".json");
process.env.ALERTS_ENABLED = "false";
delete process.env.DATABASE_URL;

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const app = require("../src/server");

let server;
let base;

before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = "http://127.0.0.1:" + server.address().port;
});

after(() => {
  if (server) server.close();
});

async function call(method, route, body) {
  const res = await fetch(base + route, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body == null ? undefined : JSON.stringify(body)
  });
  return { status: res.status, body: await res.json() };
}

test("GET /alerts responde ok y sin backend externo", async () => {
  const out = await call("GET", "/alerts");
  assert.equal(out.status, 200);
  assert.equal(out.body.ok, true);
  assert.ok(Array.isArray(out.body.watches));
  assert.ok(Array.isArray(out.body.alerts));
});

test("POST /alerts/watch exige fuente", async () => {
  const out = await call("POST", "/alerts/watch", { name: "Sin fuente" });
  assert.equal(out.status, 400);
  assert.equal(out.body.reason, "source_required");
});

test("POST /alerts/watch crea una vigilancia", async () => {
  const out = await call("POST", "/alerts/watch", { source: "lidl", name: "Freidora de aire", price: 39.99, targetPct: 5 });
  assert.equal(out.status, 200);
  assert.equal(out.body.ok, true);
  assert.ok(out.body.watch.id);
  assert.equal(out.body.watch.source, "lidl");
  assert.equal(out.body.watch.base_price, 39.99);
  assert.equal(out.body.watch.target_pct, 5);
});

test("POST /alerts/watch/:id actualiza el umbral", async () => {
  const created = await call("POST", "/alerts/watch", { source: "outletpc", name: "Auriculares", price: 20 });
  const id = created.body.watch.id;
  const out = await call("POST", "/alerts/watch/" + id, { targetPct: 8 });
  assert.equal(out.status, 200);
  assert.equal(out.body.watch.target_pct, 8);
});

test("POST /alerts/dismiss con id desconocido devuelve 404", async () => {
  const out = await call("POST", "/alerts/dismiss", { id: "no-existe" });
  assert.equal(out.status, 404);
  assert.equal(out.body.reason, "alert_not_found");
});

test("DELETE /alerts/watch/:id elimina la vigilancia", async () => {
  const created = await call("POST", "/alerts/watch", { source: "lidl", name: "Borrar", price: 10 });
  const id = created.body.watch.id;
  const out = await call("DELETE", "/alerts/watch/" + id);
  assert.equal(out.status, 200);
  assert.equal(out.body.ok, true);
});

test("POST /alerts/run ejecuta el ciclo sin error", async () => {
  const out = await call("POST", "/alerts/run", {});
  assert.equal(out.status, 200);
  assert.equal(out.body.ok, true);
  assert.ok(out.body.summary);
});

test("store: historico de precios, aviso y descarte", async () => {
  const store = require("../src/lib/store");
  await store.init();
  await store.saveWatch({ id: "w_test_1", source: "lidl", name: "Producto", base_price: 10, last_price: 10, target_pct: 5, active: true });
  await store.recordPrice("w_test_1", 9);
  assert.equal((await store.priceHistory("w_test_1")).length, 1);
  await store.addAlert({ id: "al_test_1", watch_id: "w_test_1", kind: "price_drop", title: "Producto", price: 9, prev_price: 10, pct: 10, at: new Date().toISOString(), dismissed: false });
  assert.ok((await store.listAlerts({ includeDismissed: false })).some((a) => a.id === "al_test_1"));
  await store.dismissAlert("al_test_1");
  assert.ok(!(await store.listAlerts({ includeDismissed: false })).some((a) => a.id === "al_test_1"));
  assert.equal(await store.deleteWatch("w_test_1"), true);
});
