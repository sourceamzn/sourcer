const test = require("node:test");
const assert = require("node:assert");
const net = require("net");
const os = require("os");
const path = require("path");
process.env.ALERTS_DATA_FILE = path.join(os.tmpdir(), "alerts-test-" + process.pid + ".json");

const smtp = require("../src/lib/smtp");
const imapLib = require("../src/lib/imap");

test("smtp: el mensaje lleva asunto UTF-8, hilo y cuerpo en base64", () => {
  const m = smtp.buildMessage({ from: "compras@acme.es", fromName: "Kevin · Brunea", to: "ventas@x.es", subject: "Solicitud de tarifa · Teléfono", text: "Hola,\nañadir", inReplyTo: "<a@acme.es>", references: ["<a@acme.es>"] });
  assert.match(m.raw, /^From: =\?UTF-8\?B\?/m);
  assert.match(m.raw, /^Subject: =\?UTF-8\?B\?/m);
  assert.match(m.raw, /^In-Reply-To: <a@acme\.es>$/m);
  const body = m.raw.split("\r\n\r\n")[1].replace(/\s+/g, "");
  assert.equal(Buffer.from(body, "base64").toString("utf8"), "Hola,\r\nañadir");
  assert.match(m.messageId, /^<.+@acme\.es>$/);
});

function fakeSmtp(store) {
  return new Promise((resolve) => {
    const srv = net.createServer((s) => {
      let data = false, buf = "";
      s.write("220 fake ESMTP\r\n");
      s.on("data", (d) => {
        buf += d.toString("utf8");
        if (data) {
          const i = buf.indexOf("\r\n.\r\n");
          if (i === -1) return;
          store.push(buf.slice(0, i)); buf = buf.slice(i + 5); data = false; s.write("250 OK queued\r\n");
        }
        let nl;
        while (!data && (nl = buf.indexOf("\r\n")) !== -1) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 2);
          if (/^EHLO/i.test(line)) s.write("250-fake\r\n250 AUTH PLAIN LOGIN\r\n");
          else if (/^AUTH PLAIN/i.test(line)) s.write(Buffer.from(line.slice(11), "base64").toString().split("\u0000")[2] === "pw" ? "235 ok\r\n" : "535 bad\r\n");
          else if (/^MAIL FROM/i.test(line) || /^RCPT TO/i.test(line)) s.write("250 ok\r\n");
          else if (/^DATA/i.test(line)) { s.write("354 go\r\n"); data = true; }
          else if (/^QUIT/i.test(line)) { s.write("221 bye\r\n"); s.end(); }
        }
      });
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

test("smtp: envia por un servidor real (falso) con AUTH PLAIN", async () => {
  const got = [];
  const srv = await fakeSmtp(got);
  try {
    const r = await smtp.send({ host: "127.0.0.1", port: srv.address().port, secure: false, user: "u", pass: "pw" }, { from: "a@acme.es", to: "b@x.es", subject: "Hola", text: "Prueba\n.linea con punto" });
    assert.ok(r.ok);
    assert.equal(got.length, 1);
    assert.match(got[0], /Message-ID: </);
    await assert.rejects(smtp.send({ host: "127.0.0.1", port: srv.address().port, secure: false, user: "u", pass: "MAL" }, { from: "a@acme.es", to: "b@x.es", subject: "x", text: "x" }), /smtp_535/);
  } finally { srv.close(); }
});

/* IMAP falso: un buzon con mensajes definidos por la prueba. */
function fakeImap(box) {
  return new Promise((resolve) => {
    const srv = net.createServer((s) => {
      s.write("* OK fake IMAP ready\r\n");
      let buf = "", pendingAppend = null;
      s.on("data", (d) => {
        buf += d.toString("utf8");
        if (pendingAppend) {
          if (Buffer.byteLength(buf) < pendingAppend.n + 2) return;
          box.appended.push(buf.slice(0, pendingAppend.n)); buf = ""; s.write(pendingAppend.tag + " OK APPEND done\r\n"); pendingAppend = null; return;
        }
        let nl;
        while ((nl = buf.indexOf("\r\n")) !== -1) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 2);
          const [tag, ...rest] = line.split(" "); const cmd = rest.join(" ");
          if (/^LOGIN/i.test(cmd)) s.write(tag + " OK logged\r\n");
          else if (/^LIST/i.test(cmd)) s.write('* LIST (\\HasNoChildren) "." INBOX\r\n* LIST (\\HasNoChildren \\Sent) "." INBOX.Sent\r\n' + tag + " OK\r\n");
          else if (/^SELECT/i.test(cmd)) s.write("* OK [UIDVALIDITY 7] ok\r\n* OK [UIDNEXT " + (box.msgs.length + 1) + "] ok\r\n" + tag + " OK [READ-WRITE] done\r\n");
          else if (/^UID SEARCH/i.test(cmd)) s.write("* SEARCH " + box.msgs.map((m) => m.uid).join(" ") + "\r\n" + tag + " OK\r\n");
          else if (/^UID FETCH/i.test(cmd)) {
            const want = cmd.split(" ")[2].split(",").map(Number);
            box.msgs.filter((m) => want.includes(m.uid)).forEach((m, i) => {
              const h = Buffer.from(m.header), t = Buffer.from(m.text);
              s.write("* " + (i + 1) + " FETCH (UID " + m.uid + " BODY[HEADER.FIELDS (FROM SUBJECT)] {" + h.length + "}\r\n");
              s.write(h); s.write(" BODY[TEXT]<0> {" + t.length + "}\r\n"); s.write(t); s.write(")\r\n");
            });
            s.write(tag + " OK fetched\r\n");
          } else if (/^APPEND/i.test(cmd)) { const n = Number(cmd.match(/\{(\d+)\}$/)[1]); pendingAppend = { tag, n }; s.write("+ go\r\n"); return; }
          else if (/^LOGOUT/i.test(cmd)) { s.write("* BYE\r\n" + tag + " OK\r\n"); s.end(); }
          else s.write(tag + " BAD unknown\r\n");
        }
      });
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

test("imap: lee cabeceras y texto con literales (acentos incluidos)", async () => {
  const box = { appended: [], msgs: [{ uid: 5, header: "From: Ventas <ventas@x.es>\r\nSubject: =?UTF-8?B?" + Buffer.from("Re: Solicitud · teléfono").toString("base64") + "?=\r\n\r\n", text: "Hola, adjuntamos tarifa. Saludos cordiales." }] };
  const srv = await fakeImap(box);
  try {
    const im = new imapLib.Imap({ host: "127.0.0.1", port: srv.address().port, secure: false });
    await im.connect(); await im.login("u", "p");
    const sel = await im.select("INBOX");
    assert.equal(sel.uidValidity, 7);
    const uids = await im.uidSearch("UID 1:*");
    assert.deepEqual(uids, [5]);
    const msgs = await im.fetchHeaders(uids, 2000);
    const h = imapLib.parseHeaders(msgs[0].header);
    assert.equal(h.subject, "Re: Solicitud · teléfono");
    assert.equal(imapLib.emailOf(h.from), "ventas@x.es");
    assert.match(msgs[0].text, /adjuntamos tarifa/);
    await im.append("INBOX.Sent", "Subject: x\r\n\r\nhola");
    assert.equal(box.appended.length, 1);
    await im.logout();
  } finally { srv.close(); }
});

test("outreach: envia la bienvenida, programa el seguimiento y detecta la respuesta (alerta + favorito)", async () => {
  const { config } = require("../src/config");
  const docs = require("../src/lib/docstore");
  const mem = {};
  docs._setForTests({ kind: "mem", async list(c) { return Object.values(mem[c] || {}).map((x) => JSON.parse(JSON.stringify(x))); }, async get(c, id) { const v = (mem[c] || {})[id]; return v ? JSON.parse(JSON.stringify(v)) : null; }, async put(c, id, d) { mem[c] = mem[c] || {}; mem[c][id] = JSON.parse(JSON.stringify(d)); return d; }, async del(c, id) { const h = !!(mem[c] && mem[c][id]); if (h) delete mem[c][id]; return h; } });
  const sentMail = [];
  const smtpSrv = await fakeSmtp(sentMail);
  const box = { appended: [], msgs: [] };
  const imapSrv = await fakeImap(box);
  Object.assign(config.mail.smtp, { host: "127.0.0.1", port: smtpSrv.address().port, user: "compras@acme.es", pass: "pw", from: "compras@acme.es", fromName: "" });
  Object.assign(config.mail.imap, { host: "127.0.0.1", port: imapSrv.address().port, user: "compras@acme.es", pass: "pw", sentBox: "" });
  config.outreach.enabled = true;
  const smtpMod = require("../src/lib/smtp");
  const origSend = smtpMod.send;
  smtpMod.send = (o, m) => origSend(Object.assign({}, o, { secure: false }), m);
  const imapMod = require("../src/lib/imap");
  const OrigImap = imapMod.Imap;
  imapMod.Imap = class extends OrigImap { constructor(o) { super(Object.assign({}, o, { secure: false })); } };
  try {
    const out = require("../src/lib/outreach");
    await out.setSender({ name: "Kevin", company: "Brunea Group", phone: "600000000" });
    const c = { id: "distrib.es", host: "distrib.es", status: "pendiente", emails: ["ventas@distrib.es"], products: [{ key: "B0A", name: "Teléfono T-71U", ean: "8410000000000", brand: "Tegui", model: "374240" }], history: [] };
    out.startOutreach(c);
    await docs.put("contacts", c.id, c);
    const r1 = await out.tick("manual_force");
    assert.equal(r1.sent, 1, JSON.stringify(r1));
    assert.equal(sentMail.length, 1);
    assert.match(sentMail[0], /Subject: =\?UTF-8\?B\?/);
    const c1 = await docs.get("contacts", "distrib.es");
    assert.equal(c1.outreach.attempts, 1);
    assert.equal(c1.status, "contactado");
    const gap = (Date.parse(c1.outreach.nextAt) - Date.now()) / 86400000;
    assert.ok(gap >= 1.9 && gap <= 6, "siguiente en 2-3 dias (ajustado a horario laboral): " + gap);
    assert.equal(box.appended.length, 1, "copia en Enviados");
    /* Llega la respuesta en el mismo hilo. */
    box.msgs.push({ uid: 11, header: "From: Juan <juan@distrib.es>\r\nSubject: Re: Solicitud\r\nIn-Reply-To: " + c1.outreach.messageIds[0] + "\r\n\r\n", text: "Buenos dias, le adjunto nuestra tarifa profesional." });
    const r2 = await out.tick("manual_force");
    assert.equal(r2.replies.found, 1, JSON.stringify(r2));
    const c2 = await docs.get("contacts", "distrib.es");
    assert.equal(c2.status, "respondido");
    assert.equal(c2.starred, true);
    assert.equal(c2.outreach.state, "respondido");
    assert.equal(sentMail.length, 1, "no se envia nada mas tras responder");
    const store = require("../src/lib/store");
    const al = await store.listAlerts({});
    assert.ok((al.alerts || al).some((a) => a.kind === "respuesta"));
  } finally {
    smtpMod.send = origSend; imapMod.Imap = OrigImap;
    smtpSrv.close(); imapSrv.close();
  }
});

test("outreach: plantillas 1..10 (bienvenida + seguimientos en el hilo, con baja)", () => {
  const out = require("../src/lib/outreach");
  const c = { products: [{ name: "Batidora X200, 1000W", ean: "8412345678905", brand: "Acme", model: "X200" }] };
  const sd = { name: "Kevin", company: "Brunea Group" };
  const t1 = out.template(c, sd, 1), t2 = out.template(c, sd, 2), t10 = out.template(c, sd, 10);
  assert.equal(t1.subject, "Solicitud de tarifa profesional · Acme X200");
  assert.equal(t2.subject, "Re: " + t1.subject);
  assert.match(t1.text, /EAN 8412345678905/);
  assert.doesNotMatch(t1.text + t2.text + t10.text, /amazon/i);
  for (let i = 1; i <= 10; i++) assert.match(out.template(c, sd, i).text, /«baja»/);
  assert.notEqual(out.template(c, sd, 3).text, out.template(c, sd, 4).text);
});

test("outreach: clasifica rebotes, bajas y respuestas por remitente/dominio", () => {
  const out = require("../src/lib/outreach");
  const c = { id: "acme.es", host: "acme.es", emails: ["ventas@acme.es"], outreach: { attempts: 1, messageIds: ["<m1@me.es>"] } };
  const idx = out.indexContacts([c]);
  const mk = (from, subj, text, extra) => ({ header: "From: " + from + "\r\nSubject: " + subj + "\r\n" + (extra || "") + "\r\n", text });
  assert.equal(out.classifyMessage(mk("ventas@acme.es", "Re: x", "Les enviamos la tarifa"), idx, "me@me.es").kind, "respuesta");
  assert.equal(out.classifyMessage(mk("pedro@acme.es", "Re: x", "hola"), idx, "me@me.es").how, "dominio");
  assert.equal(out.classifyMessage(mk("ventas@acme.es", "Re: x", "Por favor, baja"), idx, "me@me.es").kind, "baja");
  assert.equal(out.classifyMessage(mk("MAILER-DAEMON@mx.me.es", "Undelivered Mail", "Original message: <m1@me.es> to ventas@acme.es"), idx, "me@me.es").kind, "rebote");
  assert.equal(out.classifyMessage(mk("otro@gmail.com", "hola", "spam"), idx, "me@me.es"), null);
  assert.equal(out.classifyMessage(mk("me@me.es", "x", "x"), idx, "me@me.es"), null);
});
