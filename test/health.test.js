const { test } = require("node:test");
const assert = require("node:assert/strict");

process.env.BIGBUY_API_KEY = '  "Bearer clave-de-prueba"  ';
process.env.APIFY_TOKEN = "apify-de-prueba";
process.env.ALIEXPRESS_APP_KEY = "app-key";
process.env.ALIEXPRESS_APP_SECRET = "app-secret";
process.env.CJ_API_KEY = "cj-key";

const health = require("../src/routes/health");

function snapshot() {
  let body = null;
  health({}, { json: (value) => { body = value; } });
  return body;
}

test("health publica los proveedores con API", () => {
  const body = snapshot();
  assert.equal(body.sources.bigbuy, true);
  assert.equal(body.sources.aliexpress, true);
  assert.equal(body.sources.cj, true);
  assert.equal(body.sources.gshopping_ean, true);
});

test("health no filtra las claves", () => {
  const raw = JSON.stringify(snapshot());
  assert.equal(raw.includes("clave-de-prueba"), false);
  assert.equal(raw.includes("app-secret"), false);
  assert.equal(raw.includes("cj-key"), false);
});
