process.env.IMAGE_AI_ENABLED = "true"; /* la comparacion de fotos va apagada por defecto */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const image = require("../src/lib/imagecheck");
const vision = require("../src/lib/vision");

function png(width) {
  const b = Buffer.alloc(24);
  b[0] = 0x89; b.write("PNG", 1, "ascii"); b.writeUInt32BE(width || 800, 16); b.writeUInt32BE(600, 20);
  return b;
}

function openaiReply(same, confidence) {
  return JSON.stringify({
    choices: [{
      message: {
        content: JSON.stringify({ same: same, confidence: confidence, reason: "Comparacion de prueba" })
      }
    }]
  });
}

function fakeFetch(reply, counter) {
  return async function (url, init) {
    if (String(url).indexOf("api.openai.com") !== -1) {
      if (counter) counter.calls++;
      return { ok: true, status: 200, text: async function () { return reply; } };
    }
    const b = png(String(url).indexOf("a.jpg") !== -1 ? 800 : 600);
    return {
      ok: true,
      status: 200,
      headers: {
        get: function (name) {
          if (name === "content-type") return "image/png";
          return String(b.length);
        }
      },
      arrayBuffer: async function () { return b; }
    };
  };
}

test("imagecheck.visualCompare sin vision: heuristicas y 'sin confirmar visualmente'", async () => {
  const r = await image.visualCompare("https://img.example/a.jpg", "https://img.example/b.jpg", {
    enabled: false,
    fetch: fakeFetch(openaiReply(true, "alta"))
  });
  assert.equal(r.state, "unknown");
  assert.equal(r.confirmed, false);
  assert.match(r.reason, /sin confirmar visualmente/i);
});

test("imagecheck.visualCompare: misma imagen de Amazon no llama a vision", async () => {
  const r = await image.visualCompare(
    "https://m.media-amazon.com/images/I/71abcL._AC_SL1500_.jpg",
    "https://m.media-amazon.com/images/I/71abcL._AC_SX679_.jpg",
    { provider: "openai", apiKey: "x", fetch: fakeFetch(openaiReply(false, "alta")) }
  );
  assert.equal(r.state, "same");
  assert.equal(r.same, true);
  assert.equal(r.provider, "heuristica");
});

test("vision: foto igual con confianza alta confirma", async () => {
  vision.clearCache();
  const r = await vision.compare("https://img.example/a.jpg", "https://img.example/b.jpg", {
    provider: "openai", apiKey: "test", cacheMin: 0,
    fetch: fakeFetch(openaiReply(true, "alta"))
  });
  assert.equal(r.state, "same");
  assert.equal(r.same, true);
  assert.equal(r.confirmed, true);
  assert.equal(r.provider, "openai");
});

test("vision: foto distinta solo descarta con confianza alta", async () => {
  vision.clearCache();
  const high = await vision.compare("https://img.example/a.jpg", "https://img.example/b.jpg", {
    provider: "openai", apiKey: "test", cacheMin: 0,
    fetch: fakeFetch(openaiReply(false, "alta"))
  });
  assert.equal(high.state, "different");
  assert.equal(high.confirmed, true);

  vision.clearCache();
  const low = await vision.compare("https://img.example/a.jpg", "https://img.example/b.jpg", {
    provider: "openai", apiKey: "test", cacheMin: 0,
    fetch: fakeFetch(openaiReply(false, "baja"))
  });
  assert.equal(low.state, "unknown");
  assert.equal(low.confirmed, false);
});

test("vision: cache por par de URLs evita la segunda llamada", async () => {
  vision.clearCache();
  const counter = { calls: 0 };
  const opts = {
    provider: "openai", apiKey: "test", cacheMin: 60,
    fetch: fakeFetch(openaiReply(true, "alta"), counter)
  };
  await vision.compare("https://img.example/a.jpg", "https://img.example/b.jpg", opts);
  const second = await vision.compare("https://img.example/a.jpg", "https://img.example/b.jpg", opts);
  assert.equal(counter.calls, 1);
  assert.equal(second.cached, true);
  assert.equal(second.state, "same");
});

test("vision: presupuesto agotado no llama al modelo", async () => {
  const b = vision.budget(1);
  assert.equal(b.take(), true);
  assert.equal(b.take(), false);
  assert.equal(b.used, 1);
});

test("vision: parseVerdict tolera texto alrededor del JSON", () => {
  const v = vision.parseVerdict('Claro: {"same": true, "confidence": "media", "reason": "Mismo articulo"} fin');
  assert.equal(v.same, true);
  assert.equal(v.confidence, "media");
  assert.equal(v.reason, "Mismo articulo");
  assert.equal(vision.parseVerdict("sin json"), null);
});
