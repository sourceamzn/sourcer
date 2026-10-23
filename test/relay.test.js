const test = require("node:test");
const assert = require("node:assert");
const http = require("http");

test("smtp: con relayUrl entrega el mensaje montado por HTTPS al puente", async () => {
  let body = null;
  const srv = http.createServer((req, res) => { let d = ""; req.on("data", (c) => d += c); req.on("end", () => { body = JSON.parse(d); res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(body.secret === "abc" ? { ok: true, response: "250 OK" } : { ok: false, reason: "secreto_incorrecto" })); }); });
  await new Promise((r) => srv.listen(0, r));
  const smtp = require("../src/lib/smtp");
  const url = "http://127.0.0.1:" + srv.address().port + "/relay-correo.php";
  const r = await smtp.send({ relayUrl: url, relaySecret: "abc", relayHost: "localhost", relayPort: 465, user: "info@x.com", pass: "p" }, { from: "info@x.com", to: "a@b.es", subject: "Hola", text: "Texto" });
  assert.equal(r.ok, true);
  assert.equal(r.via, "relay");
  assert.deepEqual(body.to, ["a@b.es"]);
  assert.match(body.raw, /Subject: Hola/);
  assert.match(body.raw, /Message-ID: </i);
  await assert.rejects(smtp.send({ relayUrl: url, relaySecret: "mal", user: "info@x.com", pass: "p" }, { from: "info@x.com", to: "a@b.es", subject: "x", text: "y" }), /relay_200|secreto_incorrecto/);
  srv.close();
});
