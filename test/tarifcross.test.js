const test = require("node:test");
const assert = require("node:assert");

function ean13(base12) {
  let s = 0;
  for (let i = 0; i < 12; i++) s += Number(base12[i]) * (i % 2 ? 3 : 1);
  return base12 + ((10 - (s % 10)) % 10);
}

function memDocs() {
  const docs = require("../src/lib/docstore");
  const mem = {};
  docs._setForTests({
    kind: "mem",
    async list(c) { return Object.values(mem[c] || {}); },
    async get(c, id) { return (mem[c] || {})[id] ? JSON.parse(JSON.stringify(mem[c][id])) : null; },
    async put(c, id, d) { mem[c] = mem[c] || {}; mem[c][id] = JSON.parse(JSON.stringify(d)); return d; },
    async del(c, id) { const h = !!(mem[c] && mem[c][id]); if (h) delete mem[c][id]; return h; }
  });
  return mem;
}

test("tarifcross: cruza por lotes, solo pide Buy Box de los que dejan margen y ordena", async () => {
  memDocs();
  const cross = require("../src/lib/tarifcross");
  const keepaCost = require("../src/lib/keepacost");
  keepaCost.usage.tokensLeft = null;
  const A = ean13("841000000001"), B = ean13("841000000002"), C = ean13("841000000003"), D = ean13("841000000004");
  const prods = {
    [A]: { asin: "B0AAAAAAA1", eanList: [A], _m: { title: "Batidora X", pvp: 60, sales: 300, thirdParty: 5, fbaThird: 3, offersFba: 4, amazonSells: false } },
    [B]: { asin: "B0AAAAAAA2", eanList: [B], _m: { title: "Secador Y", pvp: 20, sales: 100, thirdParty: 4, fbaThird: 2, offersFba: 2 } },
    [D]: { asin: "B0AAAAAAA4", eanList: [D], _m: { title: "Marca propia Z", pvp: 60, sales: 200, thirdParty: 1, fbaThird: 1, offersFba: 1 } }
  };
  const calls = { code: [], deep: [] };
  cross._forTests.setDeps({
    keepaReady: () => true,
    sleep: async () => {},
    keepaRequest: async (path, params) => {
      const codes = params.code.split(",");
      calls.code.push(codes.length);
      return { ok: true, data: { tokensConsumed: codes.length, products: codes.map((c) => prods[c]).filter(Boolean) } };
    },
    keepaProductsByAsins: async (asins) => {
      calls.deep.push(asins.slice());
      return { ok: true, products: Object.values(prods).filter((p) => asins.includes(p.asin)) };
    },
    metricsFromKeepa: (p) => Object.assign({ asin: p.asin, url: "https://www.amazon.es/dp/" + p.asin, historyDays: 400 }, p._m)
  });
  const r = await cross.create({
    fileName: "tarifa.xlsx", vatMode: "sin",
    rows: [
      { ean: A, name: "Batidora", price: 15 }, { ean: B, name: "Secador", price: 18 },
      { ean: C, name: "No existe", price: 5 }, { ean: D, name: "Marca propia", price: 15 },
      { ean: "", name: "sin ean", price: 3 }, { ean: ean13("841000000005"), name: "sin precio", price: 0 }
    ]
  });
  assert.equal(r.ok, true);
  assert.equal(r.run.total, 4);
  assert.equal(r.run.sinEan, 1);
  assert.equal(r.run.sinPrecio, 1);
  for (let i = 0; i < 100 && !cross._forTests.idle(); i++) await new Promise((res) => setTimeout(res, 10));
  const out = await cross.get(r.run.id);
  assert.equal(out.run.state, "terminado");
  assert.equal(out.run.found, 3);
  assert.equal(out.run.notFound, 1);
  assert.deepEqual(calls.code, [4], "una sola llamada para los 4 EAN");
  assert.deepEqual(calls.deep, [["B0AAAAAAA1"]], "fase 2 solo para el que deja margen y tiene competencia");
  const byEan = {};
  out.rows.forEach((x) => { byEan[x.ean] = x; });
  assert.ok(["oportunidad", "revisar"].includes(byEan[A].verdict), byEan[A].verdict);
  assert.equal(byEan[A].phase, 2);
  assert.ok(byEan[A].profit > 0 && byEan[A].roi > 0);
  assert.equal(byEan[B].verdict, "sin_margen");
  assert.equal(byEan[D].verdict, "buybox_cerrada");
  assert.equal(out.rows[0].ean, A, "la oportunidad sale primero");
});

test("tarifcross: precio con IVA y anuncio en pack", () => {
  const cross = require("../src/lib/tarifcross");
  const t = cross._forTests;
  assert.equal(Math.round(t.netOf({ price: 12.1 }, "con", 21) * 100) / 100, 10);
  assert.equal(t.netOf({ price: 10 }, "sin", 21), 10);
  assert.equal(t.packOf({ title: "Pilas AA pack de 4" }), 4);
  assert.equal(t.packOf({ title: "Batidora de vaso 1000W" }), 1);
  assert.equal(t.packOf({ title: "Bolsas", packageQuantity: 3 }), 3);
});

test("mime: extrae adjuntos de tarifa (base64, nombre RFC 2231) e ignora imagenes inline", () => {
  const mime = require("../src/lib/mime");
  const csv = Buffer.from("EAN;Precio\n8410000000017;12,50\n", "utf8");
  const raw = [
    "From: Ventas <ventas@acme.es>", "Subject: Re: tarifa", 'Content-Type: multipart/mixed; boundary="XX"', "", "--XX",
    'Content-Type: multipart/alternative; boundary="YY"', "", "--YY", "Content-Type: text/plain; charset=utf-8", "", "Adjunto tarifa.", "--YY--", "",
    "--XX", "Content-Type: image/png", "Content-Disposition: inline", "Content-Transfer-Encoding: base64", "", "iVBORw0KGgo=", "",
    "--XX", "Content-Type: text/csv; name=\"x.csv\"", "Content-Disposition: attachment; filename*=utf-8''Tarifa%202026%20Espa%C3%B1a.csv",
    "Content-Transfer-Encoding: base64", "", csv.toString("base64"), "--XX--", ""
  ].join("\r\n");
  const at = mime.tariffAttachments(Buffer.from(raw, "latin1"));
  assert.equal(at.length, 1);
  assert.equal(at[0].filename, "Tarifa 2026 España.csv");
  assert.equal(at[0].data.toString("utf8"), csv.toString("utf8"));
  assert.equal(mime.isMultipart('Content-Type: multipart/mixed; boundary="XX"'), true);
});

test("outreach: una respuesta con tarifa adjunta se guarda y marca el contacto como tarifa", async () => {
  const mem = memDocs();
  const docs = require("../src/lib/docstore");
  const outreach = require("../src/lib/outreach");
  await docs.put("contacts", "acme.es", { id: "acme.es", host: "acme.es", title: "Acme", status: "contactado", emails: ["ventas@acme.es"], outreach: { state: "esperando", attempts: 1, messageIds: ["<m1@x>"] }, history: [] });
  await outreach.__applyForTests({
    contact: { id: "acme.es" }, kind: "respuesta", from: "ventas@acme.es", subject: "Re: alta", snippet: "Os paso tarifa", full: "Os paso tarifa",
    attachments: [{ filename: "tarifa.xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", size: 4, data: Buffer.from("abcd") }]
  });
  const c = await docs.get("contacts", "acme.es");
  assert.equal(c.status, "tarifa");
  assert.equal(c.attachments.length, 1);
  const stored = Object.values(mem.attachments || {});
  assert.equal(stored.length, 1);
  assert.equal(Buffer.from(stored[0].b64, "base64").toString(), "abcd");
});

test("imap: fetchFull descarga el mensaje completo como literal", async () => {
  const net = require("net");
  const { Imap } = require("../src/lib/imap");
  const msg = Buffer.from("Subject: x\r\nContent-Type: text/plain\r\n\r\nHola ñ\r\n", "utf8");
  const srv = net.createServer((sock) => {
    sock.write("* OK ready\r\n");
    let buf = "";
    sock.on("data", (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\r\n")) !== -1) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        const tag = line.split(" ")[0];
        if (/RFC822\.SIZE/.test(line)) sock.write("* 1 FETCH (UID 7 RFC822.SIZE " + msg.length + ")\r\n" + tag + " OK done\r\n");
        else if (/BODY\.PEEK\[\]/.test(line)) { sock.write("* 1 FETCH (UID 7 BODY[] {" + msg.length + "}\r\n"); sock.write(msg); sock.write(")\r\n" + tag + " OK done\r\n"); }
        else sock.write(tag + " OK\r\n");
      }
    });
  });
  await new Promise((r) => srv.listen(0, r));
  const im = new Imap({ host: "127.0.0.1", port: srv.address().port, secure: false, timeoutMs: 5000 });
  await im.connect();
  const r = await im.fetchFull(7, 1000);
  assert.equal(r.size, msg.length);
  assert.equal(r.raw.toString("utf8"), msg.toString("utf8"));
  const big = await im.fetchFull(7, 10);
  assert.equal(big.raw, null);
  await im.logout();
  srv.close();
});

test("tarifcross: tarifa PVP estima la compra con el descuento de distribuidor", () => {
  const cross = require("../src/lib/tarifcross");
  const t = cross._forTests;
  assert.equal(Math.round(t.netOf({ price: 121 }, "pvp", 21, 0.30) * 100) / 100, 70);
  const out = t.evaluate({ ean: "1", price: 60.5 }, { asin: "B0X", pvp: 60, sales: 300, thirdParty: 5, fbaThird: 3, offersFba: 4, historyDays: 400 }, require("../src/lib/plan").planParams({}), "pvp", 1, 0.30);
  assert.equal(out.pvpRef, 60.5);
  assert.ok(out.discNeeded > 0 && out.discNeeded < 100, String(out.discNeeded));
  assert.equal(out.estimated, true);
});
