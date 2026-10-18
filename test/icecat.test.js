const { test } = require("node:test");
const assert = require("node:assert/strict");

process.env.ICECAT_USERNAME = "sourcer";
process.env.ICECAT_PASSWORD = "secreto";

const icecat = require("../src/adapters/icecat");

function fakeResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Map(),
    text: async () => (typeof body === "string" ? body : JSON.stringify(body))
  };
}

test("icecat ping confirma usuario y contrasena", async () => {
  const out = await icecat.actions.ping();
  assert.equal(out.ok, true);
  assert.equal(out.configured, true);
  assert.equal(out.auth, "basic");
});

test("icecat exige GTIN o marca+MPN, no texto libre", async () => {
  const out = await icecat.actions.search({ query: "taladro bosch" });
  assert.equal(out.ok, false);
  assert.equal(out.reason, "ean_required");
});

test("icecat lookup normaliza la ficha y autentica sin exponer la clave", async () => {
  const realFetch = global.fetch;
  let seen = null;
  global.fetch = async (url, opts) => {
    seen = { url: String(url), opts };
    return fakeResponse(200, {
      status: "success",
      data: {
        GeneralInfo: {
          Title: "Taladro X",
          Brand: "Marca",
          GTIN: "8412345678905",
          ProductCode: "MPN-1",
          IcecatId: 77,
          Category: { Name: "Taladros" },
          Description: { ShortDesc: "<b>Hola</b> mundo" }
        },
        Image: { HighPic: "https://img.example/1.jpg" }
      }
    });
  };
  try {
    const out = await icecat.actions.lookup({ ean: "8412345678905" });
    assert.equal(out.ok, true);
    const item = out.data.items[0];
    assert.equal(item.ean, "8412345678905");
    assert.equal(item.brand, "Marca");
    assert.equal(item.model, "MPN-1");
    assert.equal(item.image, "https://img.example/1.jpg");
    assert.equal(item.attrs.category, "Taladros");
    assert.equal(item.attrs.description, "Hola mundo");
    assert.equal(seen.opts.headers.Authorization.indexOf("Basic "), 0);
    assert.equal(seen.url.indexOf("secreto"), -1);
    assert.ok(seen.url.indexOf("GTIN=8412345678905") !== -1);
  } finally {
    global.fetch = realFetch;
  }
});

test("icecat explica el 401 (credenciales o IP)", async () => {
  const realFetch = global.fetch;
  global.fetch = async () => fakeResponse(401, { status: "error", msg: "Unauthorized" });
  try {
    const out = await icecat.actions.lookup({ ean: "8412345678905" });
    assert.equal(out.ok, false);
    assert.equal(out.reason, "icecat_http_401");
    assert.ok(/IP/.test(out.hint));
  } finally {
    global.fetch = realFetch;
  }
});
