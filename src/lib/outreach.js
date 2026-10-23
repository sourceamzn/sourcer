"use strict";
/* SECUENCIA DE CORREOS a fabricantes/distribuidores guardados.

   1. Correo de bienvenida (abre la conversacion pidiendo tarifa).
   2. Si no contestan: seguimiento en el MISMO hilo cada 2-3 dias (aleatorio),
      dentro del horario laboral, hasta OUTREACH_MAX_ATTEMPTS (10) en total.
   3. Cada pasada se lee el buzon (IMAP): si contestan, se para la secuencia,
      el contacto pasa a "Ha respondido", se marca como favorito y se crea una
      alerta. Si piden la baja, se para y se marca "Descartado". Si el correo
      rebota, se prueba el siguiente email del contacto.
   Nada se envia sin SMTP configurado ni sin los datos del remitente. */

const docs = require("./docstore");
const smtp = require("./smtp");
const imapLib = require("./imap");
const store = require("./store");
const events = require("./events");
const { config } = require("../config");

const COLL = "contacts";
let running = false;

function cfg() { return config.outreach; }
function mailReady() {
  const s = config.mail.smtp;
  return Boolean(s.host && s.user && s.pass && s.from);
}
function imapReady() {
  const i = config.mail.imap;
  return Boolean(i.host && i.user && i.pass);
}
function nowIso() { return new Date().toISOString(); }

async function getSender() { return (await docs.get("settings", "sender")) || {}; }
async function setSender(s) {
  const clean = {};
  ["name", "company", "cif", "phone", "web", "position"].forEach(function (k) { clean[k] = String((s && s[k]) || "").trim().slice(0, 120); });
  await docs.put("settings", "sender", clean);
  return clean;
}
function senderOk(sd) { return Boolean(sd && sd.company && sd.name); }
async function getState() { return (await docs.get("settings", "outreach_state")) || { imap: {}, sent: {} }; }
async function putState(st) { return docs.put("settings", "outreach_state", st); }

/* ---------- horario (zona Europa/Madrid por defecto) ---------- */
function range(spec, def) {
  const m = String(spec || def).match(/^(\d+)\s*-\s*(\d+)$/);
  return m ? [Number(m[1]), Number(m[2])] : def.split("-").map(Number);
}
function localParts(d, tz) {
  const f = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", hour: "numeric", minute: "numeric", hour12: false, year: "numeric", month: "2-digit", day: "2-digit" });
  const p = {};
  f.formatToParts(d).forEach(function (x) { p[x.type] = x.value; });
  const wd = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[p.weekday] || 1;
  return { wd: wd, hour: Number(p.hour) % 24, minute: Number(p.minute), ymd: p.year + "-" + p.month + "-" + p.day };
}
function inWindow(d) {
  const c = cfg();
  const h = range(c.hours, "9-19"), w = range(c.weekdays, "1-5");
  const lp = localParts(d, c.tz);
  return lp.wd >= w[0] && lp.wd <= w[1] && lp.hour >= h[0] && lp.hour < h[1];
}
/* Siguiente envio: +2..3 dias (aleatorio) y, si cae fuera de horario, al
   siguiente hueco laborable con unos minutos aleatorios (no a la hora en punto). */
function nextSendAt(from, rnd) {
  const c = cfg();
  rnd = rnd || Math.random;
  const days = c.minDays + rnd() * Math.max(0, c.maxDays - c.minDays);
  let d = new Date(from.getTime() + days * 86400000);
  for (let i = 0; i < 24 * 8 && !inWindow(d); i++) {
    d = new Date(d.getTime() + 3600000);
    if (inWindow(d)) d = new Date(d.getTime() - localParts(d, c.tz).minute * 60000 + Math.floor(rnd() * 90) * 60000);
  }
  return d;
}

/* ---------- plantillas ---------- */
function productLines(c) {
  return (c.products || []).slice(0, 6).map(function (p) {
    return "- " + (p.name || "Producto") + (p.model ? (" · Ref. " + p.model) : "") + (p.ean ? (" · EAN " + p.ean) : "");
  });
}
function mainProduct(c) {
  const p = (c.products || [])[0] || {};
  return { name: p.name ? String(p.name).split(/[,|(]/)[0].trim().slice(0, 80) : "esta referencia", ean: p.ean || "", brand: p.brand || "", model: p.model || "" };
}
function signature(sd) {
  return [sd.name, sd.position, sd.company, sd.phone, sd.web].filter(Boolean).join("\n");
}
const OPTOUT = "Si no es la persona adecuada o prefieren no recibir más mensajes, respondan «baja» y no volveremos a escribirles.";
function firstSubject(c) {
  const p = mainProduct(c);
  const tail = ((p.brand ? p.brand + " " : "") + (p.model || p.ean || "")).trim();
  return "Solicitud de tarifa profesional" + (tail ? " · " + tail : "");
}
/* attempt: 1 = bienvenida; 2..10 = seguimientos en el mismo hilo. */
function template(c, sd, attempt) {
  const p = mainProduct(c);
  const firma = signature(sd);
  const company = sd.company || "nuestra empresa";
  const ref = p.name + (p.ean ? " (EAN " + p.ean + ")" : "");
  const subject = attempt <= 1 ? firstSubject(c) : ("Re: " + firstSubject(c));
  let body;
  switch (attempt) {
    case 1:
      body = "Hola,\n\nSomos " + company + ", empresa de comercio online con sede en España" + (sd.cif ? " (CIF " + sd.cif + ")" : "") + ". Estamos interesados en comprar de forma recurrente " + ((c.products || []).length > 1 ? "las siguientes referencias" : "la siguiente referencia") + " y nos gustaría conocer sus condiciones para clientes profesionales:\n\n" + (productLines(c).join("\n") || "- " + ref) + "\n\n¿Podrían indicarnos precio neto por unidad (sin IVA), descuentos por volumen, pedido mínimo, plazo y coste de envío y formas de pago?\n\nSi para trabajar con ustedes hay que darse de alta como cliente profesional, les facilitamos nuestros datos fiscales.";
      break;
    case 2: body = "Hola de nuevo,\n\nLes escribí hace unos días sobre " + ref + ". ¿Podrían indicarme si lo distribuyen y en qué condiciones para profesionales?"; break;
    case 3: body = "Hola,\n\n¿Es usted la persona adecuada para consultas de compra profesional? Si no es así, ¿podría indicarme a quién dirigirme para pedir tarifa de " + p.name + "?"; break;
    case 4: body = "Hola,\n\nSeguimos interesados en " + ref + ". Con el precio neto y el pedido mínimo podríamos valorar un primer pedido esta misma semana."; break;
    case 5: body = "Hola,\n\nLes escribo otra vez por si mi correo anterior se quedó en spam o se perdió. Nos interesa comprarles " + p.name + " de forma recurrente."; break;
    case 6: body = "Hola,\n\n¿Trabajan con clientes profesionales de comercio online? Si es así, ¿cuál es el proceso para darnos de alta y recibir su tarifa?"; break;
    case 7: body = "Hola,\n\nSolo necesitaría saber si tienen stock de " + p.name + " y un precio neto orientativo; con eso valoramos el pedido."; break;
    case 8: body = "Hola,\n\nSi les resulta más cómodo hablarlo por teléfono, pueden llamarme" + (sd.phone ? " al " + sd.phone : "") + " o indicarme cuándo les llamo yo."; break;
    case 9: body = "Hola,\n\nSi ustedes no trabajan esta referencia directamente, ¿nos podrían recomendar algún distribuidor en España que la tenga?"; break;
    default: body = "Hola,\n\nEste es mi último mensaje: entiendo que ahora no es buen momento. Si más adelante les interesa trabajar con nosotros, estaremos encantados de hablar. Gracias por su tiempo.";
  }
  const text = body + "\n\nUn saludo,\n\n" + (firma || company) + "\n\n" + OPTOUT;
  return { subject: subject, text: text };
}

/* ---------- control de la secuencia ---------- */
function startOutreach(c, opts) {
  opts = opts || {};
  const now = new Date();
  const o = c.outreach || {};
  if (o.state === "respondido" || o.state === "baja") return c;
  c.outreach = Object.assign({ attempts: 0, messageIds: [], emailIdx: 0, sentLog: [] }, o, {
    state: "activo", max: cfg().maxAttempts, startedAt: o.startedAt || now.toISOString(),
    nextAt: opts.at || (o.attempts ? (o.nextAt || now.toISOString()) : now.toISOString())
  });
  c.history = (c.history || []).concat([{ at: now.toISOString(), type: "secuencia", text: "Secuencia de correos iniciada (" + cfg().maxAttempts + " intentos máx.)" }]).slice(-100);
  return c;
}
function pauseOutreach(c) {
  if (c.outreach && c.outreach.state === "activo") {
    c.outreach.state = "pausado";
    c.history = (c.history || []).concat([{ at: nowIso(), type: "secuencia", text: "Secuencia pausada" }]).slice(-100);
  }
  return c;
}

async function sentToday(st) {
  const today = localParts(new Date(), cfg().tz).ymd;
  if (!st.sent || st.sent.day !== today) st.sent = { day: today, count: 0 };
  return st.sent;
}

function smtpOpts() {
  const s = config.mail.smtp;
  return { host: s.host, port: s.port, user: s.user, pass: s.pass, rejectUnauthorized: config.mail.tlsStrict };
}
function imapOpts() {
  const i = config.mail.imap;
  return { host: i.host, port: i.port, rejectUnauthorized: config.mail.tlsStrict };
}

async function sendAttempt(c, sd, session) {
  const o = c.outreach;
  const emails = c.emails || [];
  const to = emails[o.emailIdx || 0];
  if (!to) { o.state = "sin_email"; return { ok: false, reason: "sin_email" }; }
  const attempt = (o.attempts || 0) + 1;
  const t = template(c, sd, attempt);
  const s = config.mail.smtp;
  const first = (o.messageIds || [])[0];
  const r = await smtp.send(smtpOpts(), {
    from: s.from, fromName: s.fromName || [sd.name, sd.company].filter(Boolean).join(" · "),
    to: to, subject: t.subject, text: t.text,
    inReplyTo: attempt > 1 ? (o.messageIds[o.messageIds.length - 1] || first) : null,
    references: attempt > 1 ? o.messageIds.slice(-5) : null,
    listUnsubscribe: s.from
  });
  const now = new Date();
  o.attempts = attempt;
  o.messageIds = (o.messageIds || []).concat([r.messageId]).slice(-12);
  o.lastSentAt = now.toISOString();
  o.lastTo = to;
  o.sentLog = (o.sentLog || []).concat([{ at: o.lastSentAt, n: attempt, to: to, subject: t.subject }]).slice(-12);
  if (attempt >= (o.max || cfg().maxAttempts)) {
    o.state = "completado"; o.nextAt = null;
    if (c.status === "contactado" || c.status === "pendiente") c.status = "sin_respuesta";
  } else {
    o.nextAt = nextSendAt(now).toISOString();
  }
  if (c.status === "pendiente") { c.status = "contactado"; c.contactedAt = c.contactedAt || o.lastSentAt; }
  c.history = (c.history || []).concat([{ at: o.lastSentAt, type: "envio", text: "Correo " + attempt + "/" + (o.max || cfg().maxAttempts) + " enviado a " + to + (o.nextAt ? (" · siguiente: " + o.nextAt.slice(0, 16).replace("T", " ") + " UTC") : " · fin de la secuencia") }]).slice(-100);
  if (session && session.sentBox) { try { await session.imap.append(session.sentBox, r.raw); } catch (e) {} }
  try { events.add("outreach", { phase: "sent", contact: c.id, to: to, n: attempt }); } catch (e) {}
  return { ok: true, messageId: r.messageId };
}

/* ---------- lectura de respuestas ---------- */
const OPTOUT_RE = /\b(baja|darme de baja|no (?:nos |me )?interesa|no (?:vuelvan|vuelva) a escribir|unsubscribe|remove me|no estamos interesados)\b/i;
const BOUNCE_FROM = /mailer-daemon|postmaster|mail delivery|delivery subsystem/i;
const BOUNCE_SUBJ = /undeliver|delivery status|failure notice|returned mail|no se ha podido entregar|no entregado|mail delivery failed|delivery has failed/i;
const FREEMAIL = /^(gmail|googlemail|hotmail|outlook|live|yahoo|icloud|me|aol|gmx|proton|protonmail|yandex)\./i;

function baseDomain(h) { return String(h || "").toLowerCase().replace(/^www\./, "").split(".").slice(-2).join("."); }

function indexContacts(list) {
  const byMsg = {}, byEmail = {}, byDomain = {};
  list.forEach(function (c) {
    const o = c.outreach;
    if (!o || !o.attempts) return;
    (o.messageIds || []).forEach(function (m) { byMsg[m.toLowerCase()] = c; });
    (c.emails || []).forEach(function (e) { byEmail[String(e).toLowerCase()] = c; });
    const d = baseDomain(c.host);
    if (d) byDomain[d] = byDomain[d] || c;
  });
  return { byMsg: byMsg, byEmail: byEmail, byDomain: byDomain };
}

/* Decide a que contacto pertenece un mensaje y que es. Pura (testeable). */
function classifyMessage(msg, idx, ourAddress) {
  const h = imapLib.parseHeaders(msg.header);
  const from = imapLib.emailOf(h.from);
  if (!from || from === String(ourAddress || "").toLowerCase()) return null;
  const refs = ((h["in-reply-to"] || "") + " " + (h.references || "")).toLowerCase().match(/<[^>]+>/g) || [];
  const text = imapLib.readableText(msg.header, msg.text);
  let c = null, how = "";
  for (let i = 0; i < refs.length && !c; i++) { if (idx.byMsg[refs[i]]) { c = idx.byMsg[refs[i]]; how = "hilo"; } }
  const bounce = BOUNCE_FROM.test(h.from || "") || BOUNCE_SUBJ.test(h.subject || "");
  if (bounce && !c) {
    /* El rebote cita el mensaje original: se busca un Message-ID nuestro o un email del contacto en el texto. */
    const raw = String(msg.text || "").toLowerCase();
    Object.keys(idx.byMsg).some(function (m) { if (raw.indexOf(m) !== -1) { c = idx.byMsg[m]; how = "rebote"; return true; } return false; });
    if (!c) Object.keys(idx.byEmail).some(function (e) { if (raw.indexOf(e) !== -1) { c = idx.byEmail[e]; how = "rebote"; return true; } return false; });
  }
  if (!c && idx.byEmail[from]) { c = idx.byEmail[from]; how = "remitente"; }
  if (!c) {
    const d = from.split("@")[1] || "";
    if (d && !FREEMAIL.test(d) && idx.byDomain[baseDomain(d)]) { c = idx.byDomain[baseDomain(d)]; how = "dominio"; }
  }
  if (!c) return null;
  return {
    contact: c, how: how, from: from, subject: h.subject || "", date: h.date || "",
    kind: bounce ? "rebote" : (OPTOUT_RE.test(text) && text.length < 400 ? "baja" : "respuesta"),
    snippet: text.slice(0, 300)
  };
}

async function alert(c, title, detail) {
  try {
    await store.addAlert({ id: store.newId("al"), watch_id: "contact:" + c.id, kind: "respuesta", title: title.slice(0, 200), detail: String(detail || "").slice(0, 600), price: null, prev_price: null, pct: null, at: nowIso(), dismissed: false });
  } catch (e) {}
}

async function applyFinding(f) {
  const c = await docs.get(COLL, f.contact.id);
  if (!c) return;
  const o = c.outreach || (c.outreach = {});
  const now = nowIso();
  if (f.kind === "rebote") {
    const next = (o.emailIdx || 0) + 1;
    c.history = (c.history || []).concat([{ at: now, type: "rebote", text: "Correo rebotado (" + (c.emails[o.emailIdx || 0] || "") + ")" }]);
    if (c.emails && c.emails[next]) { o.emailIdx = next; o.nextAt = now; c.history.push({ at: now, type: "secuencia", text: "Se prueba el siguiente email: " + c.emails[next] }); }
    else { o.state = "rebotado"; o.nextAt = null; }
  } else if (f.kind === "baja") {
    o.state = "baja"; o.nextAt = null; c.status = "descartado";
    c.history = (c.history || []).concat([{ at: now, type: "respuesta", text: "Pidió la baja: «" + f.snippet.slice(0, 160) + "»" }]);
    await alert(c, "Baja: " + (c.company || c.title || c.host), f.snippet);
  } else {
    if (o.state === "respondido" && o.lastReplyFrom === f.from && o.lastReplySubject === f.subject) return;
    o.state = "respondido"; o.nextAt = null; o.repliedAt = now; o.lastReplyFrom = f.from; o.lastReplySubject = f.subject;
    c.status = "respondido"; c.starred = true;
    c.lastReply = { at: now, from: f.from, subject: f.subject, snippet: f.snippet };
    c.history = (c.history || []).concat([{ at: now, type: "respuesta", text: "Respuesta de " + f.from + ": «" + f.snippet.slice(0, 200) + "»" }]);
    await alert(c, "Ha respondido " + (c.company || c.title || c.host) + ((c.products || [])[0] ? " · " + String(c.products[0].name || "").slice(0, 60) : ""), f.from + ": " + f.snippet);
  }
  c.history = (c.history || []).slice(-100);
  c.updatedAt = now;
  await docs.put(COLL, c.id, c);
  try { events.add("outreach", { phase: f.kind, contact: c.id, from: f.from, how: f.how }); } catch (e) {}
}

async function openImap() {
  const i = config.mail.imap;
  const im = new imapLib.Imap(Object.assign(imapOpts(), { timeoutMs: 45000 }));
  await im.connect();
  await im.login(i.user, i.pass);
  return im;
}
async function findSentBox(im) {
  if (config.mail.imap.sentBox) return config.mail.imap.sentBox;
  try {
    const boxes = await im.list();
    const sp = boxes.filter(function (b) { return /\\Sent/i.test(b.flags); })[0];
    if (sp) return sp.name;
    const byName = boxes.filter(function (b) { return /(^|\.|\/)(sent|enviados|sent items|sent messages)$/i.test(b.name); })[0];
    return byName ? byName.name : "";
  } catch (e) { return ""; }
}

async function checkReplies(im, st) {
  const contacts = await docs.list(COLL);
  const idx = indexContacts(contacts);
  if (!Object.keys(idx.byMsg).length) return { checked: 0, found: 0 };
  const sel = await im.select("INBOX");
  st.imap = st.imap || {};
  if (st.imap.uidValidity !== sel.uidValidity) { st.imap = { uidValidity: sel.uidValidity, lastUid: 0 }; }
  let uids;
  if (st.imap.lastUid) uids = await im.uidSearch("UID " + (st.imap.lastUid + 1) + ":*");
  else {
    const since = new Date(Date.now() - 30 * 86400000);
    const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][since.getUTCMonth()];
    uids = await im.uidSearch("SINCE " + since.getUTCDate() + "-" + mon + "-" + since.getUTCFullYear());
  }
  uids = uids.filter(function (u) { return u > (st.imap.lastUid || 0); }).slice(-200);
  let found = 0;
  for (let i = 0; i < uids.length; i += 40) {
    const msgs = await im.fetchHeaders(uids.slice(i, i + 40), 4000);
    for (let j = 0; j < msgs.length; j++) {
      const f = classifyMessage(msgs[j], idx, config.mail.smtp.from);
      if (f) { found++; await applyFinding(f); }
    }
  }
  if (uids.length) st.imap.lastUid = Math.max.apply(null, [st.imap.lastUid || 0].concat(uids));
  return { checked: uids.length, found: found };
}

/* Una pasada: leer respuestas y enviar lo que toque. */
async function tick(reason) {
  if (running) return { ok: false, reason: "en_curso" };
  if (!cfg().enabled) return { ok: false, reason: "desactivado" };
  if (!mailReady()) return { ok: false, reason: "smtp_no_configurado" };
  running = true;
  const st = await getState();
  const out = { at: nowIso(), reason: reason || "timer", replies: null, sent: 0, errors: [] };
  let im = null, sentBox = "";
  try {
    if (imapReady()) {
      try {
        im = await openImap();
        out.replies = await checkReplies(im, st);
        st.lastCheck = out.at;
        if (cfg().saveSent) sentBox = await findSentBox(im);
      } catch (e) { out.errors.push("imap: " + String((e && e.message) || e).slice(0, 200)); }
    }
    const sd = await getSender();
    if (!senderOk(sd)) out.errors.push("faltan_datos_remitente");
    else if (!inWindow(new Date()) && reason !== "manual_force") out.skippedWindow = true;
    else {
      const sent = await sentToday(st);
      const due = (await docs.list(COLL)).filter(function (c) {
        const o = c.outreach;
        return o && o.state === "activo" && o.nextAt && Date.parse(o.nextAt) <= Date.now() && (c.emails || []).length;
      }).sort(function (a, b) { return Date.parse(a.outreach.nextAt) - Date.parse(b.outreach.nextAt); });
      for (let i = 0; i < due.length && out.sent < cfg().perTick && sent.count < cfg().dailyLimit; i++) {
        const c = await docs.get(COLL, due[i].id);
        if (!c || !c.outreach || c.outreach.state !== "activo") continue;
        try {
          const r = await sendAttempt(c, sd, im && sentBox ? { imap: im, sentBox: sentBox } : null);
          c.updatedAt = nowIso();
          await docs.put(COLL, c.id, c);
          if (r.ok) { out.sent++; sent.count++; }
        } catch (e) {
          const msg = String((e && e.message) || e).slice(0, 200);
          out.errors.push(c.id + ": " + msg);
          c.outreach.lastError = msg;
          /* Direccion rechazada por el servidor: se prueba el siguiente email. */
          if (/smtp_55\d/.test(msg) && c.emails[(c.outreach.emailIdx || 0) + 1]) c.outreach.emailIdx = (c.outreach.emailIdx || 0) + 1;
          else c.outreach.nextAt = new Date(Date.now() + 3 * 3600000).toISOString();
          c.history = (c.history || []).concat([{ at: nowIso(), type: "error", text: "No se pudo enviar: " + msg }]).slice(-100);
          await docs.put(COLL, c.id, c);
          if (/smtp_5(35|30)|auth/i.test(msg)) break; /* credenciales mal: no insistir */
        }
        if (i < due.length - 1) await new Promise(function (r) { setTimeout(r, 4000 + Math.random() * 6000); });
      }
    }
  } catch (e) {
    out.errors.push(String((e && e.message) || e).slice(0, 200));
  } finally {
    if (im) await im.logout();
    st.lastRun = out;
    try { await putState(st); } catch (e) {}
    running = false;
  }
  try { events.add("outreach", { phase: "tick", sent: out.sent, replies: out.replies ? out.replies.found : null, errors: out.errors.join(" | ").slice(0, 300) }); } catch (e) {}
  return Object.assign({ ok: true }, out);
}

async function testSend(to) {
  if (!mailReady()) return { ok: false, reason: "smtp_no_configurado" };
  const sd = await getSender();
  const s = config.mail.smtp;
  const r = await smtp.send(smtpOpts(), { from: s.from, fromName: s.fromName || [sd.name, sd.company].filter(Boolean).join(" · "), to: to || s.from, subject: "Prueba de envío · Sourcing FBA", text: "Correo de prueba enviado desde la herramienta.\n\nSi lo recibes, el SMTP está bien configurado." });
  let imap = null;
  if (imapReady()) {
    try { const im = await openImap(); const sel = await im.select("INBOX"); const sb = await findSentBox(im); await im.logout(); imap = { ok: true, inbox: sel, sentBox: sb || null }; }
    catch (e) { imap = { ok: false, reason: String((e && e.message) || e).slice(0, 200) }; }
  }
  return { ok: true, messageId: r.messageId, imap: imap };
}

let timer = null;
function startScheduler() {
  if (timer || !cfg().enabled) return;
  const ms = cfg().tickMin * 60000;
  setTimeout(function () { tick("startup").catch(function () {}); }, 60000).unref();
  timer = setInterval(function () { tick("timer").catch(function () {}); }, ms);
  if (timer.unref) timer.unref();
}

async function status() {
  const st = await getState();
  const sd = await getSender();
  const c = cfg();
  return {
    enabled: c.enabled, smtp: mailReady(), imap: imapReady(), autoStart: c.autoStart,
    from: config.mail.smtp.from || "", host: config.mail.smtp.host || "",
    rules: { maxAttempts: c.maxAttempts, minDays: c.minDays, maxDays: c.maxDays, dailyLimit: c.dailyLimit, hours: c.hours, weekdays: c.weekdays, tz: c.tz },
    sender: sd, senderOk: senderOk(sd), inWindow: inWindow(new Date()),
    lastRun: st.lastRun || null, lastCheck: st.lastCheck || null, sentToday: st.sent || null
  };
}

module.exports = {
  tick, testSend, status, startScheduler, startOutreach, pauseOutreach, template, firstSubject,
  getSender, setSender, senderOk, mailReady, inWindow, nextSendAt, classifyMessage, indexContacts, localParts
};
