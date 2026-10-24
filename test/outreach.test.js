const test = require("node:test");
const assert = require("node:assert");
/* Sin red en las pruebas: todos los dominios reciben correo. */
require("../src/lib/mx")._setResolver({ mx: async function () { return [{ exchange: "mx.test", priority: 10 }]; }, a: async function () { return ["127.0.0.1"]; } });
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
  config.outreach.reviewFirst = 0; /* aqui se prueba el envio; la revision tiene su propia prueba */
  const smtpMod = require("../src/lib/smtp");
  const origSend = smtpMod.send;
  smtpMod.send = (o, m) => origSend(Object.assign({}, o, { secure: false }), m);
  const imapMod = require("../src/lib/imap");
  const OrigImap = imapMod.Imap;
  imapMod.Imap = class extends OrigImap { constructor(o) { super(Object.assign({}, o, { secure: false })); } };
  try {
    const out = require("../src/lib/outreach");
    await out.setSender({ name: "Kevin", company: "Brunea Group", phone: "600000000" });
    /* Sin plantillas guardadas se usan las del Plan de contacto (PDF). */
    const def = await out.getTemplates();
    assert.equal(def.fromPlan, true);
    assert.equal(def.items.length, 3);
    const pdf = out.render({ id: "t.es", host: "t.es", products: [{ brand: "Tegui", model: "374240", ean: "8424299374240" }] }, { name: "Kevin De Porras", company: "Brunea Group", phone: "600 000 000", web: "www.bruneagroup.com" }, def, 1, "A");
    assert.equal(pdf.subject, "Solicitud de tarifa y condiciones de alta como cliente – Tegui");
    assert.match(pdf.text, /^Buenos días equipo de ventas,\n\nMe llamo Kevin De Porras y escribo desde Brunea Group \(www\.bruneagroup\.com\)/);
    assert.match(pdf.text, /- 374240 – EAN 8424299374240/);
    assert.match(out.render({ id: "t.es", host: "t.es", products: [{ brand: "Tegui", model: "374240" }] }, { name: "K", company: "B", phone: "600 000 000" }, def, 3, "A").text, /unos minutos: 600 000 000\./);
    await out.setTemplates({ items: [{ subject: "Tarifa {marca} {referencia}", body: "Hola {proveedor},\n{productos}\n{firma}" }, { subject: "", body: "Seguimiento sobre {producto}" }] });
    const c = { id: "distrib.es", host: "distrib.es", status: "pendiente", emails: ["ventas@distrib.es"], products: [{ key: "B0A", name: "Teléfono T-71U", ean: "8410000000000", brand: "Tegui", model: "374240" }], history: [] };
    out.startOutreach(c, { now: true });
    await docs.put("contacts", c.id, c);
    const r1 = await out.tick("manual_force");
    assert.equal(r1.sent, 1, JSON.stringify(r1));
    assert.equal(sentMail.length, 1);
    assert.match(sentMail[0], /Subject: Tarifa Tegui 374240/);
    const c1 = await docs.get("contacts", "distrib.es");
    assert.equal(c1.outreach.attempts, 1);
    assert.equal(c1.status, "contactado");
    const gap = (Date.parse(c1.outreach.nextAt) - Date.now()) / 86400000;
    assert.ok(gap >= 2.5 && gap <= 9, "siguiente: dia 3 laborable, martes a jueves: " + gap);
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

test("outreach: plantillas del usuario con variables; sin plantilla no hay correo", () => {
  const out = require("../src/lib/outreach");
  const c = { company: "Distrib SL", products: [{ name: "Batidora X200, 1000W", ean: "8412345678905", brand: "Acme", model: "X200" }] };
  const sd = { name: "Kevin", company: "Brunea Group", phone: "600" };
  const tpl = { items: [{ subject: "Tarifa {marca} {referencia}", body: "Hola {proveedor}, EAN {ean}.\n{firma}" }, { subject: "", body: "¿Novedades sobre {producto}?" }] };
  const t1 = out.render(c, sd, tpl, 1), t2 = out.render(c, sd, tpl, 2);
  assert.equal(t1.subject, "Tarifa Acme X200");
  assert.equal(t1.text.split("\n")[0], "Hola Distrib SL, EAN 8412345678905.");
  assert.match(t1.text, /Kevin · Brunea Group/);
  assert.equal(t2.subject, "Re: Tarifa Acme X200");
  assert.equal(t2.text, "¿Novedades sobre Batidora X200?");
  assert.equal(out.render(c, sd, tpl, 3), null);
  assert.equal(out.templateCount(tpl), 2);
  assert.equal(out.templateCount({ items: [] }), 0);
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
  assert.equal(out.classifyMessage(mk("ventas@acme.es", "Fuera de la oficina: Re: x", "Estoy de vacaciones"), idx, "me@me.es").kind, "automatica");
  assert.equal(out.classifyMessage(mk("ventas@acme.es", "Re: x", "hola", "Auto-Submitted: auto-replied\r\n"), idx, "me@me.es").kind, "automatica");
  assert.equal(out.classifyMessage(mk("me@me.es", "x", "x"), idx, "me@me.es"), null);
});

test("ia: Haiku lee la respuesta y extrae tarifa (API simulada)", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-test";
  const http = require("../src/lib/http");
  const orig = http.jsonFetch;
  let sentBody = null;
  http.jsonFetch = async (url, opts) => {
    sentBody = JSON.parse(opts.body);
    return { ok: true, status: 200, data: { usage: { input_tokens: 800, output_tokens: 200 }, content: [{ type: "text", text: '{"tipo":"tarifa","resumen":"Envian tarifa: 18,50 EUR sin IVA, minimo 24 uds.","precio_neto":18.5,"moneda":"EUR","iva_incluido":false,"pedido_minimo":"24 uds","condiciones":"Pago por transferencia","adjuntos_mencionados":true,"siguiente_paso":"Revisar la tarifa adjunta","borrador_respuesta":"Gracias..."}' }] } };
  };
  try {
    const ai = require("../src/lib/ai");
    const r = await ai.analyzeReply({ products: [{ name: "Batidora X200", ean: "8412345678905", priceMaxNet: 26.85 }], supplier: "Distrib", subject: "Re: tarifa", text: "Le adjunto tarifa. 18,50 sin IVA, pedido minimo 24.", senderName: "Kevin", senderCompany: "Brunea" });
    assert.ok(r.ok);
    assert.equal(r.analysis.tipo, "tarifa");
    assert.equal(r.analysis.precio_neto, 18.5);
    assert.equal(sentBody.model, "claude-haiku-5-5");
    assert.match(sentBody.messages[0].content, /sin mencionar Amazon/);
    const st = await ai.status();
    assert.equal(st.usage.calls, 1);
  } finally { http.jsonFetch = orig; delete process.env.ANTHROPIC_API_KEY; }
});

test("plan: plantillas del PDF con {nombre_contacto | equipo de ventas}, {lista_referencias} y bloque de volumen", () => {
  const out = require("../src/lib/outreach");
  const sd = { name: "Kevin De Porras", company: "Brunea Group", phone: "600000000", web: "www.bruneagroup.com" };
  const tpl = { items: [
    { subject: "Solicitud de tarifa y condiciones de alta como cliente – {marca}", subjectB: "Consulta de distribución – {marca}", body: "Buenos días {nombre_contacto | equipo de ventas},\n\nNos interesan estas referencias:\n\n{lista_referencias}\n\n{si_volumen}Calculamos pedidos de unas {volumen} unidades por referencia.{/si_volumen}\n\nUn saludo,\n{firma}" },
    { subject: "", body: "Nos vendría muy bien recibir la tarifa de distribuidor de {referencias_resumidas}." },
    { subject: "", body: "Si lo prefieres, lo hablamos por teléfono: {telefono_kevin}." }
  ] };
  const c = { id: "aaa.es", host: "aaa.es", products: [{ brand: "Tegui", model: "374240", ean: "8424299374240" }, { brand: "Tegui", model: "374241", ean: "8424299374241" }] };
  const a = out.render(c, sd, tpl, 1, "A");
  assert.equal(a.subject, "Solicitud de tarifa y condiciones de alta como cliente – Tegui");
  assert.match(a.text, /^Buenos días equipo de ventas,/);
  assert.match(a.text, /- 374240 – EAN 8424299374240\n- 374241 – EAN 8424299374241/);
  assert.doesNotMatch(a.text, /Calculamos/, "sin volumen no aparece el bloque");
  const b = out.render(Object.assign({}, c, { contactName: "Marta", volume: "100" }), sd, tpl, 1, "B");
  assert.equal(b.subject, "Consulta de distribución – Tegui");
  assert.match(b.text, /^Buenos días Marta,/);
  assert.match(b.text, /unas 100 unidades/);
  assert.equal(out.render(c, sd, tpl, 2, "A").subject, "Re: Solicitud de tarifa y condiciones de alta como cliente – Tegui");
  assert.match(out.render(c, sd, tpl, 2, "A").text, /las referencias 374240 y 374241/);
  assert.match(out.render(c, sd, tpl, 3, "A").text, /600000000/);
});

test("plan: calendario dias 0/3/7 laborables, martes a jueves 9-11 hora local, festivos", () => {
  const cal = require("../src/lib/calendar");
  const es = cal.localeOf("acme.es");
  const opts = { hours: "9-11", weekdays: "2-4" };
  /* Lunes 26/10/2026 -> primer hueco el martes 27 entre 9 y 11 (Madrid). */
  const s0 = cal.slotOn("2026-10-26", es, opts, () => 0.5);
  const lp = cal.localParts(s0, es.tz);
  assert.equal(lp.ymd, "2026-10-27");
  assert.ok(lp.hour >= 9 && lp.hour < 11);
  /* Dia 3 laborable = viernes 30 -> no es martes-jueves -> martes 3/11. */
  assert.equal(cal.localParts(cal.dueAt("2026-10-27", 3, es, opts, () => 0), es.tz).ymd, "2026-11-03");
  assert.equal(cal.localParts(cal.dueAt("2026-10-27", 7, es, opts, () => 0), es.tz).ymd, "2026-11-05");
  /* 8 de diciembre es festivo en Espana. */
  assert.equal(cal.isWorking("2026-12-08", "ES"), false);
  /* Hora del destinatario: en Alemania las 9:00 locales. */
  const de = cal.localeOf("firma.de");
  assert.equal(de.lang, "de");
  const sd = cal.slotOn("2026-10-27", de, opts, () => 0);
  assert.equal(cal.localParts(sd, "Europe/Berlin").hour, 9);
});

test("plan: los primeros envios y el primer envio de cada idioma quedan pendientes de revisar", () => {
  const { config } = require("../src/config");
  const out = require("../src/lib/outreach");
  const prev = config.outreach.reviewFirst;
  config.outreach.reviewFirst = 20;
  try {
    assert.match(out.needsReview({ review: { approved: 0, langs: {} } }, { lang: "es", translated: false }), /primeros_20/);
    assert.equal(out.needsReview({ review: { approved: 20, langs: { es: true } } }, { lang: "es", translated: false }), "");
    assert.match(out.needsReview({ review: { approved: 25, langs: { es: true } } }, { lang: "de", translated: true }), /primer_envio_en_de/);
    assert.equal(out.needsReview({ review: { approved: 25, langs: { es: true, de: true } } }, { lang: "de", translated: true }), "");
    assert.match(out.needsReview({ review: { approved: 25, langs: { es: true, de: true } } }, { lang: "de", translated: false }), /sin_traduccion/);
  } finally { config.outreach.reviewFirst = prev; }
});

test("plan: con revision, el correo no sale hasta aprobarlo (y luego sale el aprobado, editado)", async () => {
  const { config } = require("../src/config");
  const docs = require("../src/lib/docstore");
  const mem = {};
  docs._setForTests({ kind: "mem", async list(c) { return Object.values(mem[c] || {}).map((x) => JSON.parse(JSON.stringify(x))); }, async get(c, id) { const v = (mem[c] || {})[id]; return v ? JSON.parse(JSON.stringify(v)) : null; }, async put(c, id, d) { mem[c] = mem[c] || {}; mem[c][id] = JSON.parse(JSON.stringify(d)); return d; }, async del(c, id) { const h = !!(mem[c] && mem[c][id]); if (h) delete mem[c][id]; return h; } });
  const sentMail = [];
  const srv = await fakeSmtp(sentMail);
  Object.assign(config.mail.smtp, { host: "127.0.0.1", port: srv.address().port, user: "info@brunea.com", pass: "pw", from: "info@brunea.com", fromName: "" });
  Object.assign(config.mail.imap, { host: "", user: "", pass: "" });
  config.outreach.reviewFirst = 20;
  const smtpMod = require("../src/lib/smtp");
  const origSend = smtpMod.send;
  smtpMod.send = (o, m) => origSend(Object.assign({}, o, { secure: false }), m);
  try {
    const out = require("../src/lib/outreach");
    await out.setSender({ name: "Kevin", company: "Brunea Group" });
    await out.setTemplates({ items: [{ subject: "Tarifa {marca}", body: "Hola {nombre_contacto | equipo de ventas}" }] });
    const c = { id: "rev.es", host: "rev.es", status: "pendiente", emails: ["ventas@rev.es"], products: [{ brand: "Acme", model: "X1" }], history: [] };
    out.startOutreach(c, { now: true }); await docs.put("contacts", c.id, c);
    const r1 = await out.tick("manual_force");
    assert.equal(r1.sent, 0); assert.equal(r1.toReview, 1);
    let c1 = await docs.get("contacts", "rev.es");
    assert.equal(c1.outreach.state, "revision");
    assert.equal(c1.outreach.draft.text, "Hola equipo de ventas");
    await out.approveDraft(c1, { text: "Hola equipo de ventas (revisado)" });
    c1.outreach.nextAt = new Date(Date.now() - 1000).toISOString();
    await docs.put("contacts", c1.id, c1);
    const r2 = await out.tick("manual_force");
    assert.equal(r2.sent, 1, JSON.stringify(r2));
    const body = sentMail[0].split("\r\n\r\n")[1].replace(/\s+/g, "");
    assert.equal(Buffer.from(body, "base64").toString("utf8"), "Hola equipo de ventas (revisado)");
    const st = await out.status();
    assert.equal(st.review.approved, 1);
  } finally { smtpMod.send = origSend; srv.close(); config.outreach.reviewFirst = 0; }
});

test("plan: respuestas -> rechazo no se vuelve a escribir; solo distribuidores crea el contacto indicado; canal avisa a una persona", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-test";
  const docs = require("../src/lib/docstore");
  const mem = {};
  docs._setForTests({ kind: "mem", async list(c) { return Object.values(mem[c] || {}).map((x) => JSON.parse(JSON.stringify(x))); }, async get(c, id) { const v = (mem[c] || {})[id]; return v ? JSON.parse(JSON.stringify(v)) : null; }, async put(c, id, d) { mem[c] = mem[c] || {}; mem[c][id] = JSON.parse(JSON.stringify(d)); return d; }, async del(c, id) { const h = !!(mem[c] && mem[c][id]); if (h) delete mem[c][id]; return h; } });
  const http = require("../src/lib/http");
  const orig = http.jsonFetch;
  let next = null;
  http.jsonFetch = async () => ({ ok: true, status: 200, data: { usage: {}, content: [{ type: "text", text: JSON.stringify(next) }] } });
  try {
    const out = require("../src/lib/outreach");
    const base = (id) => ({ id: id, host: id, status: "contactado", emails: ["ventas@" + id], products: [{ brand: "Acme" }], outreach: { state: "activo", attempts: 1, messageIds: ["<m-" + id + "@b.com>"], nextAt: new Date().toISOString() }, history: [] });
    for (const id of ["r1.es", "r2.es", "r3.es"]) await docs.put("contacts", id, base(id));
    const idx = out.indexContacts(await docs.list("contacts"));
    const mk = (id, text) => ({ header: "From: ventas@" + id + "\r\nSubject: Re: tarifa\r\nIn-Reply-To: <m-" + id + "@b.com>\r\n\r\n", text });
    /* rechazo */
    next = { tipo: "rechazo", resumen: "No trabajan con nuevos clientes" };
    const f1 = out.classifyMessage(mk("r1.es", "No trabajamos con nuevos clientes"), idx, "info@b.com");
    await require("../src/lib/outreach").__applyForTests(f1);
    let c = await docs.get("contacts", "r1.es");
    assert.equal(c.status, "rechazado"); assert.equal(c.outreach.state, "rechazado"); assert.equal(c.outreach.nextAt, null);
    /* solo distribuidores */
    next = { tipo: "solo_distribuidores", resumen: "Solo por distribuidor", distribuidor_indicado: { nombre: "Distrib Norte", web: "www.distribnorte.es", email: "pedidos@distribnorte.es" } };
    await out.__applyForTests(out.classifyMessage(mk("r2.es", "Solo vendemos a traves de Distrib Norte"), idx, "info@b.com"));
    const nd = await docs.get("contacts", "distribnorte.es");
    assert.ok(nd); assert.equal(nd.status, "pendiente"); assert.deepEqual(nd.emails, ["pedidos@distribnorte.es"]);
    /* pregunta por el canal */
    next = { tipo: "pregunta_canal", resumen: "Preguntan donde venden", borrador_respuesta: null };
    await out.__applyForTests(out.classifyMessage(mk("r3.es", "¿Donde venden sus productos?"), idx, "info@b.com"));
    c = await docs.get("contacts", "r3.es");
    assert.equal(c.needsHuman, true); assert.equal(c.outreach.state, "respondido");
  } finally { http.jsonFetch = orig; delete process.env.ANTHROPIC_API_KEY; }
});

test("contactos: se prefieren los correos de ventas y se evitan soporte/SAT", () => {
  const cs = require("../src/lib/contactscan");
  const r = cs.rankEmails(["soporte@acme.es", "sat@acme.es", "info@acme.es", "distribuidores@acme.es"], "acme.es");
  assert.equal(r[0], "distribuidores@acme.es");
  assert.deepEqual(r.slice(-2).sort(), ["sat@acme.es", "soporte@acme.es"]);
});
