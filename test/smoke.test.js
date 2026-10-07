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

async function post(path, body) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {})
  });
  return { status: res.status, body: await res.json() };
}

test("GET /health responde ok sin claves", async () => {
  const res = await fetch(base + "/health");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(typeof body.sources, "object");
  assert.ok(Array.isArray(body.adapters));
});

test("las seis fuentes estan registradas", async () => {
  const body = await (await fetch(base + "/health")).json();
  const ids = body.adapters.map((a) => a.id).sort();
  assert.deepEqual(ids, ["amazon", "iherb", "keepa", "lidl", "outletpc", "web"]);
});

test("POST /sourcing/web/ping responde sin claves", async () => {
  const out = await post("/sourcing/web/ping");
  assert.equal(out.status, 200);
  assert.equal(out.body.source, "web");
  assert.equal(out.body.configured, true);
});

test("POST /sourcing/amazon/ping avisa de que no esta configurado", async () => {
  const out = await post("/sourcing/amazon/ping");
  assert.equal(out.status, 200);
  assert.equal(out.body.source, "amazon");
  assert.equal(out.body.configured, false);
});

test("POST /sourcing/keepa/ping avisa de que no esta configurado", async () => {
  const out = await post("/sourcing/keepa/ping");
  assert.equal(out.status, 200);
  assert.equal(out.body.source, "keepa");
  assert.equal(out.body.configured, false);
});

test("una fuente desconocida devuelve 404", async () => {
  const out = await post("/sourcing/nope/ping");
  assert.equal(out.status, 404);
  assert.equal(out.body.reason, "source_not_found");
});

test("una accion desconocida devuelve 404", async () => {
  const out = await post("/sourcing/amazon/noexiste");
  assert.equal(out.status, 404);
  assert.equal(out.body.reason, "action_not_found");
});

test("amazon/listing exige asin", async () => {
  const out = await post("/sourcing/amazon/listing", {});
  assert.equal(out.status, 200);
  assert.equal(out.body.ok, false);
  assert.equal(out.body.reason, "asin_required");
});

test("outletpc/search exige consulta", async () => {
  const out = await post("/sourcing/outletpc/search", {});
  assert.equal(out.status, 200);
  assert.equal(out.body.reason, "query_required");
});

test("lidl/search exige consulta", async () => {
  const out = await post("/sourcing/lidl/search", {});
  assert.equal(out.status, 200);
  assert.equal(out.body.reason, "query_required");
});

test("iherb/search exige consulta", async () => {
  const out = await post("/sourcing/iherb/search", {});
  assert.equal(out.status, 200);
  assert.equal(out.body.reason, "query_required");
});
