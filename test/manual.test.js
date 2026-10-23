const test = require("node:test");
const assert = require("node:assert");
const http = require("http");

test("outreach: mensaje a mano desde el chat va en el hilo y pausa la secuencia", async () => {
  let body = null;
  const srv = http.createServer((req, res) => { let d = ""; req.on("data", (c) => d += c); req.on("end", () => { body = JSON.parse(d); res.setHeader("Content-Type", "application/json"); res.end('{"ok":true,"response":"250 OK"}'); }); });
  await new Promise((r) => srv.listen(0, r));
  Object.assign(process.env, { SMTP_HOST: "x", SMTP_USER: "info@b.com", SMTP_PASS: "p", SMTP_FROM: "info@b.com", MAIL_RELAY_URL: "http://127.0.0.1:" + srv.address().port + "/r.php", MAIL_RELAY_SECRET: "s", IMAP_HOST: "" });
  for (const k of Object.keys(require.cache)) if (/src[\\/](config|lib[\\/]outreach)/.test(k)) delete require.cache[k];
  const docs = require("../src/lib/docstore");
  const mem = {};
  docs._setForTests({ kind: "mem", async list(c) { return Object.values(mem[c] || {}); }, async get(c, id) { return (mem[c] || {})[id] || null; }, async put(c, id, d) { mem[c] = mem[c] || {}; mem[c][id] = d; return d; }, async del() { return true; } });
  const outreach = require("../src/lib/outreach");
  const c = { id: "k.es", host: "k.es", status: "contactado", emails: ["a@k.es"], outreach: { state: "activo", attempts: 1, messageIds: ["<m1@b.com>"], sentLog: [{ subject: "Solicitud de tarifa" }] },
    thread: [{ dir: "out", subject: "Solicitud de tarifa", text: "hola" }, { dir: "in", msgId: "<r1@k.es>", subject: "Re: Solicitud de tarifa", text: "¿cuántas uds?" }] };
  const r = await outreach.sendManual(c, { text: "Unas 200 unidades." });
  assert.equal(r.ok, true);
  assert.match(body.raw, /In-Reply-To: <r1@k\.es>/i);
  assert.match(body.raw, /Subject: Re: Solicitud de tarifa/);
  assert.equal(c.thread.slice(-1)[0].manual, true);
  assert.equal(c.outreach.state, "pausado");
  assert.equal(c.manualMsgIds.length, 1);
  const idx = outreach.indexContacts([{ id: "z", host: "z.es", emails: ["q@z.es"], manualMsgIds: ["<x@b.com>"] }]);
  assert.ok(idx.byMsg["<x@b.com>"], "las respuestas a mensajes manuales se reconocen");
  srv.close();
});
