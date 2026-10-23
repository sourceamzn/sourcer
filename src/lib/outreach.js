"use strict";
/* SECUENCIA DE CORREOS a fabricantes/distribuidores (Plan de contacto Brunea).

   Calendario (lib/calendar): correo 1 el dia 0, recordatorio el dia 3 y
   cierre el dia 7, en dias LABORABLES, solo de martes a jueves entre las 9:00
   y las 11:00 en la hora del destinatario. Si cae en festivo o fuera de
   martes-jueves, el siguiente dia valido. Recordatorios en el mismo hilo.
   Sin respuesta: el dia 14 (7 laborables tras el ultimo) se avisa para
   llamar o usar el formulario y, 60 dias despues, se reintenta una vez.

   Plantillas: las escribe el usuario (en espanol). Si el proveedor es de otro
   idioma, Haiku las traduce antes de enviar y se guarda la copia en espanol.
   Revision humana: los primeros N envios (20) y el primero de cada idioma
   quedan "pendientes de revisar" hasta que alguien los aprueba.

   Respuestas (IMAP + Haiku): si contesta cualquiera se para la secuencia al
   instante. Tarifa -> "Tarifa recibida"; pide datos/alta -> aviso para que
   lo apruebe una persona; pregunta por el canal -> aviso, la app NO responde;
   solo vende por distribuidores -> se crea el contacto del distribuidor;
   rechazo/baja -> no se vuelve a escribir. Nada se responde automaticamente. */

const docs = require("./docstore");
const smtp = require("./smtp");
const imapLib = require("./imap");
const store = require("./store");
const events = require("./events");
const cal = require("./calendar");
const { config } = require("../config");

const COLL = "contacts";
let running = false;

function cfg() { return config.outreach; }
function mailReady() { const s = config.mail.smtp; return Boolean(s.host && s.user && s.pass && s.from); }
function imapReady() { const i = config.mail.imap; return Boolean(i.host && i.user && i.pass); }
function nowIso() { return new Date().toISOString(); }
function hist(c, type, text) { c.history = (c.history || []).concat([{ at: nowIso(), type: type, text: String(text).slice(0, 500) }]).slice(-120); }

async function getSender() { return (await docs.get("settings", "sender")) || {}; }
async function setSender(s) {
  const clean = {};
  ["name", "company", "cif", "phone", "web", "position"].forEach(function (k) { clean[k] = String((s && s[k]) || "").trim().slice(0, 120); });
  await docs.put("settings", "sender", clean);
  return clean;
}
function senderOk(sd) { return Boolean(sd && sd.company && sd.name); }
async function getState() { return (await docs.get("settings", "outreach_state")) || { imap: {}, sent: {}, review: { approved: 0, langs: {} } }; }
async function putState(st) { return docs.put("settings", "outreach_state", st); }

/* ---------- idioma / zona del proveedor ---------- */
function localeFor(c) {
  const auto = cal.localeOf(c.host, c.pageLang);
  return {
    country: c.country || auto.country,
    lang: c.lang || auto.lang,
    tz: c.tz || auto.tz
  };
}
function windowOpts() { return { hours: cfg().hours, weekdays: cfg().weekdays }; }
function inWindowFor(c, d) {
  const loc = localeFor(c);
  const lp = cal.localParts(d || new Date(), loc.tz);
  const h = String(cfg().hours).split("-").map(Number);
  return cal.allowedDay(lp.ymd, loc.country, cfg().weekdays) && lp.hour >= h[0] && lp.hour < h[1];
}
/* Compatibilidad: ventana en la zona por defecto. */
function inWindow(d) { return inWindowFor({ host: "x.es" }, d); }

/* ---------- plantillas (las escribe el usuario; aqui no se inventa nada) ---------- */
const VARS = {
  marca: "Marca del producto", fabricante: "Fabricante (o la marca si no se sabe)",
  nombre_contacto: "Nombre de la persona de contacto; si no se sabe, «equipo de ventas»",
  lista_referencias: "Referencias (máx. 5), una por línea: «referencia – EAN»",
  referencias_resumidas: "Referencias en una frase: «la 374240 y la 374241»",
  volumen: "Unidades orientativas por referencia (si lo rellenas en el proveedor)",
  producto: "Nombre del primer producto", productos: "Lista de productos con referencia y EAN",
  ean: "EAN del primer producto", referencia: "Referencia del primer producto",
  proveedor: "Nombre o web del proveedor",
  nombre: "Tu nombre", cargo: "Tu cargo", empresa: "Tu empresa", cif: "Tu CIF", telefono: "Tu teléfono", web: "Tu web", email: "Tu email (remitente)",
  firma: "Tu firma: nombre · empresa, email · web"
};
const TEMPLATE_SYNTAX = "Bloque condicional: {si_volumen}…{/si_volumen} solo aparece si hay volumen. Valor por defecto: {nombre_contacto | equipo de ventas}.";

/* Plantillas del «Plan de primer contacto con fabricantes» (PDF del cliente),
   copiadas literalmente; lo que el PDF marca para rellenar va como variable.
   Se usan mientras no se guarden otras desde el editor. */
const PLAN_TEMPLATES = { items: [
  { subject: "Solicitud de tarifa y condiciones de alta como cliente – {marca}", subjectB: "Consulta de distribución – {marca}",
    body: "Buenos días {nombre_contacto | equipo de ventas},\n\nMe llamo {nombre} y escribo desde {empresa} ({web}), una tienda online con sede en Barcelona.\n\nEstamos incorporando {marca} a nuestro catálogo y nos gustaría comprar directamente al fabricante de forma recurrente. Nos interesan estas referencias:\n\n{lista_referencias}\n\n¿Podríais enviarnos la tarifa de distribuidor con EAN y las condiciones para darnos de alta como cliente (pedido mínimo, descuentos por volumen, forma de pago y plazo de entrega)? Si tenéis el catálogo completo de la gama, también nos vendría bien para valorar más referencias.\n\n{si_volumen}Calculamos pedidos de unas {volumen} unidades por referencia (stock para unos dos meses), y estamos abiertos a ajustar la cantidad según vuestros tramos de descuento.{/si_volumen}\n\nPuedo enviar la documentación de la empresa que necesitéis.\n\nUn saludo,\n{nombre} · {empresa}\n{email} · {web}" },
  { subject: "", body: "Buenos días {nombre_contacto | equipo de ventas},\n\nTe escribo por si mi mensaje anterior se ha quedado sin ver. Nos vendría muy bien recibir la tarifa de distribuidor de {referencias_resumidas}.\n\nSi el proceso para darse de alta es otro (un formulario, otra persona del equipo), dímelo y lo hago por ahí.\n\nGracias,\n{nombre} · {empresa}" },
  { subject: "", body: "Buenos días {nombre_contacto | equipo de ventas},\n\nNo quiero ser pesado. Si no es vuestro departamento, ¿podrías indicarme con quién debo hablar para solicitar tarifa de distribuidor? Si lo prefieres, lo hablamos por teléfono unos minutos: {telefono_kevin}.\n\nY si ahora mismo no trabajáis con nuevos distribuidores, también me ayuda saberlo para no volver a escribiros.\n\nMuchas gracias,\n{nombre} · {empresa}\n{email}" }
] };
async function getTemplates() {
  const t = await docs.get("settings", "templates");
  if (!t || !Array.isArray(t.items) || !t.items.length) return { items: JSON.parse(JSON.stringify(PLAN_TEMPLATES.items)), whatsapp: "", updatedAt: null, fromPlan: true };
  return { items: t.items, whatsapp: String(t.whatsapp || ""), updatedAt: t.updatedAt || null };
}
async function setTemplates(t) {
  const items = (Array.isArray(t && t.items) ? t.items : []).slice(0, 10).map(function (x) {
    return { subject: String((x && x.subject) || "").slice(0, 200), subjectB: String((x && x.subjectB) || "").slice(0, 200), body: String((x && x.body) || "").slice(0, 8000) };
  });
  const doc = { items: items, whatsapp: String((t && t.whatsapp) || "").slice(0, 2000), updatedAt: new Date().toISOString() };
  await docs.put("settings", "templates", doc);
  return doc;
}
function templateCount(tpl) {
  let n = 0;
  for (let i = 0; i < (tpl.items || []).length; i++) { if (String(tpl.items[i].body || "").trim()) n++; else break; }
  return n;
}
/* Correos de la secuencia: tantos como plantillas y como dias del calendario. */
function sequenceLength(tpl) { return Math.min(templateCount(tpl), cfg().steps.length, cfg().maxAttempts); }

function refOf(p) { return String(p.model || p.partNumber || "").trim() || String(p.name || "").split(/[,|(]/)[0].trim().slice(0, 60); }
function varsFor(c, sd) {
  const prods = (c.products || []).slice(0, 5);
  const p = prods[0] || {};
  const refs = prods.map(refOf).filter(Boolean);
  const resumidas = refs.length <= 1 ? (refs[0] ? "la referencia " + refs[0] : "las referencias que os indiqué")
    : ("las referencias " + refs.slice(0, -1).join(", ") + " y " + refs[refs.length - 1]);
  const from = config.mail.smtp.from || "";
  const web = sd.web || "";
  return {
    marca: p.brand || c.brand || "", fabricante: c.manufacturer || p.brand || c.brand || "",
    nombre_contacto: String(c.contactName || "").trim(),
    lista_referencias: prods.map(function (x) { return "- " + refOf(x) + (x.ean ? " – EAN " + x.ean : ""); }).join("\n"),
    referencias_resumidas: resumidas,
    volumen: c.volume ? String(c.volume).trim() : "",
    producto: p.name ? String(p.name).split(/[,|(]/)[0].trim().slice(0, 90) : "",
    productos: prods.map(function (x) { return "- " + (x.name || "Producto") + (x.model ? (" · Ref. " + x.model) : "") + (x.ean ? (" · EAN " + x.ean) : ""); }).join("\n"),
    ean: p.ean || "", referencia: p.model || "",
    proveedor: c.company || c.title || c.host || "",
    nombre: sd.name || "", cargo: sd.position || "", empresa: sd.company || "", cif: sd.cif || "", telefono: sd.phone || "", web: web, email: from,
    telefono_kevin: sd.phone || "",
    firma: [[sd.name, sd.company].filter(Boolean).join(" · "), [from, web].filter(Boolean).join(" · ")].filter(Boolean).join("\n")
  };
}
function fill(text, vars) {
  let t = String(text || "");
  /* Bloques condicionales {si_x}...{/si_x}: solo si la variable x tiene valor. */
  t = t.replace(/\{si_([a-z_]+)\}([\s\S]*?)\{\/si_\1\}/gi, function (m, k, inner) { return vars[k.toLowerCase()] ? inner : ""; });
  /* {variable | por defecto} y {variable}. */
  t = t.replace(/\{([a-z_]+)\s*(?:\|\s*([^}]*))?\}/gi, function (m, k, def) {
    k = k.toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(vars, k)) return m;
    const v = vars[k];
    return v ? v : (def != null ? def.trim() : (k === "nombre_contacto" ? "equipo de ventas" : ""));
  });
  return t.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
/* Variante A/B del asunto del correo 1 (fija por proveedor). */
function variantOf(c) {
  let h = 0;
  String(c.id || c.host || "").split("").forEach(function (ch) { h = (h * 31 + ch.charCodeAt(0)) >>> 0; });
  return h % 2 === 0 ? "A" : "B";
}
/* attempt 1..n. Los seguimientos sin asunto van en el mismo hilo ("Re: " + asunto del 1). */
function render(c, sd, tpl, attempt, variant) {
  const items = (tpl && tpl.items) || [];
  const t = items[attempt - 1];
  if (!t || !String(t.body || "").trim()) return null;
  const vars = varsFor(c, sd);
  const first = items[0] || {};
  const v = variant || (c.outreach && c.outreach.variant) || variantOf(c);
  const firstSubjectRaw = v === "B" && String(first.subjectB || "").trim() ? first.subjectB : first.subject;
  const firstSubject = fill(firstSubjectRaw, vars) || "Consulta de compra profesional";
  let subject = attempt === 1 ? firstSubject : fill(t.subject, vars);
  if (attempt > 1 && (!subject || /^re:\s*/i.test(subject))) subject = "Re: " + firstSubject;
  return { subject: subject, text: fill(t.body, vars), variant: first.subjectB ? v : "" };
}

/* ---------- control de la secuencia ---------- */
function planDates(c, rnd) {
  const loc = localeFor(c);
  const o = c.outreach;
  const steps = cfg().steps;
  const k = o.attempts || 0;
  if (k === 0) {
    const today = cal.todayIn(loc.tz);
    return cal.slotOn(today, loc, windowOpts(), rnd, new Date());
  }
  if (k >= steps.length) return null;
  return cal.dueAt(o.day0, steps[k], loc, windowOpts(), rnd);
}
function startOutreach(c, opts) {
  opts = opts || {};
  const o = c.outreach || {};
  if (["respondido", "baja", "rechazado"].indexOf(o.state) !== -1) return c;
  c.outreach = Object.assign({ attempts: 0, messageIds: [], emailIdx: 0, sentLog: [], retries: 0 }, o, {
    state: "activo", startedAt: o.startedAt || nowIso(), variant: o.variant || variantOf(c)
  });
  const at = opts.now ? new Date() : planDates(c);
  c.outreach.nextAt = at ? at.toISOString() : null;
  hist(c, "secuencia", "Secuencia iniciada · primer envío previsto: " + (at ? at.toISOString().slice(0, 16).replace("T", " ") + " UTC" : "—"));
  return c;
}
function pauseOutreach(c) {
  if (c.outreach && ["activo", "revision"].indexOf(c.outreach.state) !== -1) { c.outreach.state = "pausado"; hist(c, "secuencia", "Secuencia pausada"); }
  return c;
}

function sentCounters(st) {
  const today = cal.todayIn(cfg().tz);
  if (!st.sent || st.sent.day !== today) st.sent = { day: today, count: 0, newCount: 0 };
  if (st.sent.newCount == null) st.sent.newCount = 0;
  return st.sent;
}
function smtpOpts() { const s = config.mail.smtp; return { host: s.host, port: s.port, user: s.user, pass: s.pass, rejectUnauthorized: config.mail.tlsStrict }; }
function imapOpts() { const i = config.mail.imap; return { host: i.host, port: i.port, rejectUnauthorized: config.mail.tlsStrict }; }

/* Prepara el correo que toca (texto final, traducido si hace falta). */
async function prepare(c, sd, tpl) {
  const o = c.outreach;
  const attempt = (o.attempts || 0) + 1;
  const t = render(c, sd, tpl, attempt, o.variant);
  if (!t) return { ok: false, reason: "falta_plantilla_" + attempt };
  const loc = localeFor(c);
  const out = { n: attempt, subject: t.subject, text: t.text, lang: loc.lang, variant: t.variant, original: null, translated: false };
  if (loc.lang !== "es" && cfg().translate) {
    try {
      const ai = require("./ai");
      if (ai.ready()) {
        const tr = await ai.translateEmail({ subject: t.subject, text: t.text, lang: loc.lang });
        if (tr.ok) { out.original = { subject: t.subject, text: t.text }; out.subject = tr.subject; out.text = tr.text; out.translated = true; }
        else out.translateError = tr.reason;
      } else out.translateError = "ia_no_configurada";
    } catch (e) { out.translateError = String((e && e.message) || e); }
  }
  return { ok: true, mail: out };
}
/* ¿Necesita revision humana antes de salir? */
function needsReview(st, mail) {
  const rv = st.review || (st.review = { approved: 0, langs: {} });
  if ((rv.approved || 0) < cfg().reviewFirst) return "primeros_" + cfg().reviewFirst;
  if (cfg().reviewNewLanguage && mail.lang && mail.lang !== "es" && !rv.langs[mail.lang]) return "primer_envio_en_" + mail.lang;
  if (mail.lang !== "es" && !mail.translated) return "sin_traduccion";
  return "";
}

async function sendPrepared(c, sd, mail, session) {
  const o = c.outreach;
  const to = (c.emails || [])[o.emailIdx || 0];
  if (!to) { o.state = "sin_email"; return { ok: false, reason: "sin_email" }; }
  const s = config.mail.smtp;
  const first = (o.messageIds || [])[0];
  const r = await smtp.send(smtpOpts(), {
    from: s.from, fromName: s.fromName || [sd.name, sd.company].filter(Boolean).join(" · "),
    to: to, subject: mail.subject, text: mail.text,
    inReplyTo: mail.n > 1 ? (o.messageIds[o.messageIds.length - 1] || first) : null,
    references: mail.n > 1 ? o.messageIds.slice(-5) : null,
    listUnsubscribe: s.from
  });
  const now = new Date();
  if (mail.n === 1) o.day0 = cal.localParts(now, localeFor(c).tz).ymd;
  o.attempts = mail.n;
  o.messageIds = (o.messageIds || []).concat([r.messageId]).slice(-12);
  o.lastSentAt = now.toISOString();
  o.lastTo = to;
  o.sentLog = (o.sentLog || []).concat([{ at: o.lastSentAt, n: mail.n, to: to, subject: mail.subject, lang: mail.lang, variant: mail.variant || "" }]).slice(-12);
  o.draft = null;
  o.lastError = null;
  const seqLen = session.seqLen;
  if (mail.n >= seqLen) {
    o.state = "esperando"; /* fin de los correos: dia 14 -> llamar */
    o.callAt = cal.slotOn(cal.addWorkingDays(o.day0, (cfg().steps[seqLen - 1] || 0) + cfg().callAfterDays, localeFor(c).country), localeFor(c), windowOpts(), null, null);
    o.callAt = o.callAt ? o.callAt.toISOString() : null;
    o.nextAt = null;
  } else {
    const nx = planDates(c);
    o.nextAt = nx ? nx.toISOString() : null;
  }
  if (c.status === "pendiente") { c.status = "contactado"; c.contactedAt = c.contactedAt || o.lastSentAt; }
  hist(c, "envio", "Correo " + mail.n + "/" + seqLen + " enviado a " + to + (mail.translated ? " (traducido al " + mail.lang + ")" : "") + (o.nextAt ? " · siguiente: " + o.nextAt.slice(0, 16).replace("T", " ") + " UTC" : " · último correo de la secuencia"));
  if (session.imap && session.sentBox) {
    try {
      await session.imap.append(session.sentBox, r.raw);
      /* Copia interna del original en espanol cuando se traduce. */
      if (mail.original) {
        const copy = smtp.buildMessage({ from: s.from, fromName: "Copia interna", to: s.from, subject: "[Copia interna ES] " + mail.original.subject, text: "Original en español del correo enviado a " + to + ":\n\n" + mail.original.text });
        await session.imap.append(session.sentBox, copy.raw);
      }
    } catch (e) {}
  }
  try { events.add("outreach", { phase: "sent", contact: c.id, to: to, n: mail.n, lang: mail.lang }); } catch (e) {}
  return { ok: true, messageId: r.messageId };
}

/* Aprobar (opcionalmente editado) el correo pendiente de revision. */
async function approveDraft(c, edit) {
  const o = c.outreach;
  if (!o || o.state !== "revision" || !o.draft) return { ok: false, reason: "sin_borrador" };
  if (edit && edit.subject) o.draft.subject = String(edit.subject).slice(0, 300);
  if (edit && edit.text) o.draft.text = String(edit.text).slice(0, 10000);
  o.draft.approved = true;
  o.draft.approvedAt = nowIso();
  o.state = "activo";
  /* Sale en el siguiente hueco valido de su horario. */
  const at = cal.slotOn(cal.todayIn(localeFor(c).tz), localeFor(c), windowOpts(), null, new Date());
  o.nextAt = at ? at.toISOString() : nowIso();
  hist(c, "revision", "Correo " + o.draft.n + " aprobado" + (edit && (edit.subject || edit.text) ? " (editado)" : "") + " · sale " + o.nextAt.slice(0, 16).replace("T", " ") + " UTC");
  return { ok: true };
}
function rejectDraft(c) {
  const o = c.outreach;
  if (!o || o.state !== "revision") return { ok: false, reason: "sin_borrador" };
  o.draft = null; o.state = "pausado";
  hist(c, "revision", "Correo pendiente descartado: secuencia en pausa");
  return { ok: true };
}

/* ---------- lectura de respuestas ---------- */
const OPTOUT_RE = /\b(baja|darme de baja|no (?:nos |me )?interesa|no (?:vuelvan|vuelva|volv[aá]is) a escribir|unsubscribe|remove me|no estamos interesados)\b/i;
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

function classifyMessage(msg, idx, ourAddress) {
  const h = imapLib.parseHeaders(msg.header);
  const from = imapLib.emailOf(h.from);
  if (!from || from === String(ourAddress || "").toLowerCase()) return null;
  const refs = ((h["in-reply-to"] || "") + " " + (h.references || "")).toLowerCase().match(/<[^>]+>/g) || [];
  const text = imapLib.readableText(msg.header, msg.text);
  const full = imapLib.readableText(msg.header, msg.text, 3500);
  const auto = /auto-replied|auto-generated/i.test(h["auto-submitted"] || "") || Boolean(h["x-autorespond"] || h["x-autoreply"]) ||
    /fuera de (?:la )?oficina|out of (?:the )?office|respuesta autom[aá]tica|automatic reply|auto[- ]?reply|autoreply|acuse de recibo|hemos recibido su (?:correo|mensaje)|abwesenheit|absence|assente/i.test(h.subject || "");
  let c = null, how = "";
  for (let i = 0; i < refs.length && !c; i++) { if (idx.byMsg[refs[i]]) { c = idx.byMsg[refs[i]]; how = "hilo"; } }
  const bounce = BOUNCE_FROM.test(h.from || "") || BOUNCE_SUBJ.test(h.subject || "");
  if (bounce && !c) {
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
    kind: bounce ? "rebote" : (auto ? "automatica" : (OPTOUT_RE.test(text) && text.length < 400 ? "baja" : "respuesta")),
    snippet: text.slice(0, 300), full: full
  };
}

async function alert(c, title, detail) {
  try {
    await store.addAlert({ id: store.newId("al"), watch_id: "contact:" + c.id, kind: "respuesta", title: title.slice(0, 200), detail: String(detail || "").slice(0, 600), price: null, prev_price: null, pct: null, at: nowIso(), dismissed: false });
  } catch (e) {}
}
function label(c) { return c.company || c.title || c.host; }

/* "Solo vendemos por distribuidores": se crea el contacto del distribuidor indicado. */
async function createSuggestedDistributor(c, d) {
  if (!d) return null;
  let host = "";
  try { if (d.web) host = new URL(/^https?:/i.test(d.web) ? d.web : "https://" + d.web).hostname.replace(/^www\./, ""); } catch (e) {}
  if (!host && d.email) host = String(d.email).split("@")[1] || "";
  if (!host) return null;
  const prev = await docs.get(COLL, host);
  if (prev) return prev;
  const n = {
    id: host, host: host, url: d.web ? (/^https?:/i.test(d.web) ? d.web : "https://" + d.web) : "https://" + host,
    title: d.nombre || host, company: d.nombre || "", role: "distribuidor_oficial", roleLabel: "Distribuidor indicado por " + label(c),
    status: "pendiente", notes: "Indicado por " + label(c) + " (" + c.host + ")", products: (c.products || []).slice(0, 5),
    emails: d.email ? [String(d.email).toLowerCase()] : [], phones: d.telefono ? [String(d.telefono)] : [], whatsapp: [],
    createdAt: nowIso(), updatedAt: nowIso(), history: [{ at: nowIso(), type: "guardado", text: "Creado desde la respuesta de " + label(c) }]
  };
  await docs.put(COLL, host, n);
  return n;
}

async function applyFinding(f) {
  const c = await docs.get(COLL, f.contact.id);
  if (!c) return;
  const o = c.outreach || (c.outreach = {});
  const now = nowIso();
  let ai = null;
  if (f.kind === "respuesta" || f.kind === "baja") {
    try {
      const aiLib = require("./ai");
      if (aiLib.ready()) {
        const sd = await getSender();
        const r = await aiLib.analyzeReply({ products: c.products, supplier: label(c), subject: f.subject, text: f.full || f.snippet, senderName: sd.name, senderCompany: sd.company });
        if (r.ok) {
          ai = r.analysis;
          if (ai.tipo === "automatica") f.kind = "automatica";
          else if (ai.tipo === "baja") f.kind = "baja";
        }
      }
    } catch (e) {}
  }
  if (f.kind === "automatica") {
    hist(c, "automatica", "Respuesta automática de " + f.from + " (no para la secuencia): «" + String(f.subject || "").slice(0, 120) + "»");
    c.updatedAt = now; await docs.put(COLL, c.id, c); return;
  }
  if (f.kind === "rebote") {
    const next = (o.emailIdx || 0) + 1;
    hist(c, "rebote", "Correo rebotado (" + ((c.emails || [])[o.emailIdx || 0] || "") + ")");
    if (c.emails && c.emails[next]) { o.emailIdx = next; o.nextAt = now; hist(c, "secuencia", "Se prueba el siguiente email: " + c.emails[next]); }
    else { o.state = "rebotado"; o.nextAt = null; }
  } else if (f.kind === "baja") {
    o.state = "baja"; o.nextAt = null; o.callAt = null; o.retryAt = null; c.status = "rechazado";
    c.rejectReason = "Pidió no recibir más correos";
    hist(c, "respuesta", "Pidió la baja: «" + f.snippet.slice(0, 160) + "»");
    await alert(c, "Baja: " + label(c), f.snippet);
  } else {
    if (o.state === "respondido" && o.lastReplyFrom === f.from && o.lastReplySubject === f.subject) return;
    /* Contesta cualquiera: se para la secuencia al instante. */
    o.state = "respondido"; o.nextAt = null; o.callAt = null; o.retryAt = null; o.draft = null;
    o.repliedAt = now; o.repliedAfter = o.attempts || 0; o.lastReplyFrom = f.from; o.lastReplySubject = f.subject;
    c.status = "respondido"; c.starred = true;
    c.lastReply = { at: now, from: f.from, subject: f.subject, snippet: f.snippet, ai: ai };
    const tipo = ai ? ai.tipo : "";
    let title = "Ha respondido " + label(c), extra = "";
    if (tipo === "tarifa") { c.status = "tarifa"; title = "Tarifa recibida de " + label(c); extra = "Revisa la tarifa y decide el primer pedido."; }
    else if (tipo === "pide_alta" || tipo === "pide_info") { title = "Pide datos o documentación: " + label(c); extra = "Aprueba tú el envío de la documentación (la app no responde)."; }
    else if (tipo === "pregunta_canal") { title = "Pregunta por el canal de venta: " + label(c); extra = "Responde tú en persona. La app no contesta."; c.needsHuman = true; }
    else if (tipo === "solo_distribuidores") {
      const nd = await createSuggestedDistributor(c, ai.distribuidor_indicado);
      title = "Solo vende por distribuidores: " + label(c);
      extra = nd ? ("Creado el contacto del distribuidor indicado: " + nd.host + ".") : "No indicó qué distribuidor; revisa el correo.";
    } else if (tipo === "rechazo") {
      c.status = "rechazado"; o.state = "rechazado"; c.rejectReason = ai.resumen || "Rechazado";
      title = "Rechazado: " + label(c); extra = "No se le volverá a escribir.";
    }
    if (tipo && tipo !== "tarifa") c.needsHuman = true;
    hist(c, "respuesta", "Respuesta de " + f.from + ": «" + f.snippet.slice(0, 200) + "»" + (tipo ? " · IA: " + tipo : ""));
    await alert(c, title, [extra, ai && ai.resumen ? "IA: " + ai.resumen : "", f.from + ": " + f.snippet].filter(Boolean).join(" — "));
  }
  c.updatedAt = now;
  await docs.put(COLL, c.id, c);
  try { events.add("outreach", { phase: f.kind, contact: c.id, from: f.from, how: f.how, tipo: ai ? ai.tipo : "" }); } catch (e) {}
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

/* Dia 14 sin respuesta -> llamar/formulario; 60 dias despues -> reintento (una vez). */
async function followUpStates(out) {
  const list = await docs.list(COLL);
  const now = Date.now();
  for (let i = 0; i < list.length; i++) {
    const c = list[i], o = c.outreach;
    if (!o) continue;
    if (o.state === "esperando" && o.callAt && Date.parse(o.callAt) <= now) {
      o.state = "llamar"; c.status = "sin_respuesta";
      o.retryAt = cfg().retryDays && (o.retries || 0) < 1 ? new Date(now + cfg().retryDays * 86400000).toISOString() : null;
      hist(c, "secuencia", "Sin respuesta tras el último correo: toca llamar por teléfono o usar el formulario web." + (o.retryAt ? " Reintento por correo el " + o.retryAt.slice(0, 10) + "." : ""));
      await alert(c, "Sin respuesta: llama a " + label(c), "Pasados los correos del plan no ha contestado. " + ((c.phones || [])[0] ? "Teléfono: " + c.phones[0] + ". " : "") + (c.form ? "Formulario: " + c.form : ""));
      c.updatedAt = nowIso(); await docs.put(COLL, c.id, c); out.calls = (out.calls || 0) + 1;
    } else if (o.state === "llamar" && o.retryAt && Date.parse(o.retryAt) <= now && (o.retries || 0) < 1) {
      o.retries = (o.retries || 0) + 1;
      o.attempts = 0; o.messageIds = []; o.day0 = null; o.callAt = null; o.retryAt = null;
      startOutreach(c);
      hist(c, "secuencia", "Reintento a los " + cfg().retryDays + " días: se vuelve a empezar la secuencia (hilo nuevo).");
      c.status = "contactado";
      c.updatedAt = nowIso(); await docs.put(COLL, c.id, c); out.retries = (out.retries || 0) + 1;
    }
  }
}

async function tick(reason) {
  if (running) return { ok: false, reason: "en_curso" };
  if (!cfg().enabled) return { ok: false, reason: "desactivado" };
  if (!mailReady()) return { ok: false, reason: "smtp_no_configurado" };
  running = true;
  const st = await getState();
  st.review = st.review || { approved: 0, langs: {} };
  const out = { at: nowIso(), reason: reason || "timer", replies: null, sent: 0, toReview: 0, errors: [] };
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
    await followUpStates(out);
    const sd = await getSender();
    const tpl = await getTemplates();
    const seqLen = sequenceLength(tpl);
    if (!senderOk(sd)) out.errors.push("faltan_datos_remitente");
    else if (!seqLen) out.errors.push("faltan_plantillas: escribe al menos el correo 1");
    else {
      const sent = sentCounters(st);
      const force = reason === "manual_force";
      const due = (await docs.list(COLL)).filter(function (c) {
        const o = c.outreach;
        return o && o.state === "activo" && o.nextAt && Date.parse(o.nextAt) <= Date.now() && (c.emails || []).length;
      }).sort(function (a, b) { return Date.parse(a.outreach.nextAt) - Date.parse(b.outreach.nextAt); });
      for (let i = 0; i < due.length && out.sent < cfg().perTick && sent.count < cfg().dailyLimit; i++) {
        const c = await docs.get(COLL, due[i].id);
        if (!c || !c.outreach || c.outreach.state !== "activo") continue;
        const o = c.outreach;
        const n = (o.attempts || 0) + 1;
        if (n > seqLen) { o.state = "esperando"; o.nextAt = null; await docs.put(COLL, c.id, c); continue; }
        if (n === 1 && sent.newCount >= cfg().newPerDay) { out.rampLimited = true; continue; }
        if (!force && !inWindowFor(c, new Date())) { const nx = cal.slotOn(cal.todayIn(localeFor(c).tz), localeFor(c), windowOpts(), null, new Date()); o.nextAt = nx ? nx.toISOString() : o.nextAt; await docs.put(COLL, c.id, c); continue; }
        try {
          let mail;
          if (o.draft && o.draft.approved && o.draft.n === n) mail = o.draft;
          else {
            const p = await prepare(c, sd, tpl);
            if (!p.ok) { o.state = "pausado"; o.lastError = p.reason; hist(c, "error", "No se pudo preparar el correo " + n + ": " + p.reason); await docs.put(COLL, c.id, c); continue; }
            mail = p.mail;
            const why = needsReview(st, mail);
            if (why) {
              o.state = "revision"; o.draft = Object.assign({}, mail, { reason: why, createdAt: nowIso(), approved: false });
              hist(c, "revision", "Correo " + n + " pendiente de revisar (" + why + ")");
              await docs.put(COLL, c.id, c);
              out.toReview++;
              continue;
            }
          }
          const r = await sendPrepared(c, sd, mail, { imap: im && sentBox ? im : null, sentBox: im ? sentBox : "", seqLen: seqLen });
          if (r.ok) {
            out.sent++; sent.count++; if (n === 1) sent.newCount++;
            if (mail.approved) { st.review.approved = (st.review.approved || 0) + 1; st.review.langs[mail.lang] = true; }
          }
          c.updatedAt = nowIso();
          await docs.put(COLL, c.id, c);
        } catch (e) {
          const msg = String((e && e.message) || e).slice(0, 200);
          out.errors.push(c.id + ": " + msg);
          o.lastError = msg;
          if (/smtp_55\d/.test(msg) && c.emails[(o.emailIdx || 0) + 1]) o.emailIdx = (o.emailIdx || 0) + 1;
          else o.nextAt = new Date(Date.now() + 3 * 3600000).toISOString();
          hist(c, "error", "No se pudo enviar: " + msg);
          await docs.put(COLL, c.id, c);
          if (/smtp_5(35|30)|auth/i.test(msg)) break;
        }
        if (i < due.length - 1) await new Promise(function (r) { setTimeout(r, 4000 + Math.random() * 6000); });
      }
      if (out.toReview) {
        try { await store.addAlert({ id: store.newId("al"), watch_id: "outreach:review", kind: "respuesta", title: out.toReview + " correo(s) pendientes de revisar antes de enviar", detail: "Revísalos en Fabricantes / Distribuidores → «Pendientes de revisar».", price: null, prev_price: null, pct: null, at: nowIso(), dismissed: false }); } catch (e) {}
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
  try { events.add("outreach", { phase: "tick", sent: out.sent, review: out.toReview, replies: out.replies ? out.replies.found : null, errors: out.errors.join(" | ").slice(0, 300) }); } catch (e) {}
  return Object.assign({ ok: true }, out);
}

async function testSend(to) {
  if (!mailReady()) return { ok: false, reason: "smtp_no_configurado" };
  const sd = await getSender();
  const s = config.mail.smtp;
  const r = await smtp.send(smtpOpts(), { from: s.from, fromName: s.fromName || [sd.name, sd.company].filter(Boolean).join(" · "), to: to || s.from, subject: "Prueba de envío · Sourcing FBA", text: "Correo de prueba enviado desde la herramienta.\n\nSi lo recibes, el correo está bien configurado." });
  let imap = null;
  if (imapReady()) {
    try { const im = await openImap(); const sel = await im.select("INBOX"); const sb = await findSentBox(im); await im.logout(); imap = { ok: true, inbox: sel, sentBox: sb || null }; }
    catch (e) { imap = { ok: false, reason: String((e && e.message) || e).slice(0, 200) }; }
  }
  return { ok: true, messageId: r.messageId, imap: imap };
}

/* ---------- metricas (apartado 8 del plan) ---------- */
async function metrics() {
  const list = (await docs.list(COLL)).filter(function (c) { return c.outreach && c.outreach.attempts; });
  const replied = list.filter(function (c) { return c.outreach.repliedAt; });
  const byEmail = {};
  replied.forEach(function (c) { const k = String(c.outreach.repliedAfter || c.outreach.attempts || 0); byEmail[k] = (byEmail[k] || 0) + 1; });
  const hours = replied.map(function (c) {
    const first = (c.outreach.sentLog || [])[0];
    return first ? (Date.parse(c.outreach.repliedAt) - Date.parse(first.at)) / 3600000 : null;
  }).filter(function (x) { return x != null && x >= 0; });
  const withTariff = replied.filter(function (c) { return c.status === "tarifa" || (c.lastReply && c.lastReply.ai && c.lastReply.ai.tipo === "tarifa"); }).length;
  const ab = {};
  list.forEach(function (c) {
    const v = ((c.outreach.sentLog || [])[0] || {}).variant || "";
    if (!v) return;
    ab[v] = ab[v] || { sent: 0, replied: 0 };
    ab[v].sent++; if (c.outreach.repliedAt) ab[v].replied++;
  });
  const states = {};
  list.forEach(function (c) { states[c.outreach.state] = (states[c.outreach.state] || 0) + 1; });
  return {
    contacted: list.length, replied: replied.length,
    replyRate: list.length ? Math.round(replied.length / list.length * 1000) / 10 : 0,
    avgHoursToReply: hours.length ? Math.round(hours.reduce(function (a, b) { return a + b; }, 0) / hours.length) : null,
    tariffRate: replied.length ? Math.round(withTariff / replied.length * 1000) / 10 : 0,
    repliesByEmail: byEmail, ab: ab, states: states
  };
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
  const tpl = await getTemplates();
  return {
    enabled: c.enabled, smtp: mailReady(), imap: imapReady(), autoStart: c.autoStart,
    from: config.mail.smtp.from || "", host: config.mail.smtp.host || "",
    rules: { steps: c.steps, callAfterDays: c.callAfterDays, retryDays: c.retryDays, dailyLimit: c.dailyLimit, newPerDay: c.newPerDay, hours: c.hours, weekdays: c.weekdays, reviewFirst: c.reviewFirst, reviewNewLanguage: c.reviewNewLanguage, translate: c.translate },
    review: { approved: (st.review && st.review.approved) || 0, langs: Object.keys((st.review && st.review.langs) || {}) },
    sender: sd, senderOk: senderOk(sd),
    ai: await require("./ai").status(),
    templates: tpl, templateCount: templateCount(tpl), sequenceLength: sequenceLength(tpl), vars: VARS, syntax: TEMPLATE_SYNTAX,
    lastRun: st.lastRun || null, lastCheck: st.lastCheck || null, sentToday: st.sent || null
  };
}

module.exports = {
  tick, testSend, status, metrics, startScheduler, startOutreach, pauseOutreach, approveDraft, rejectDraft,
  __applyForTests: applyFinding,
  PLAN_TEMPLATES, render, fill, varsFor, getTemplates, setTemplates, templateCount, sequenceLength, VARS,
  getSender, setSender, senderOk, mailReady, inWindow, inWindowFor, localeFor, classifyMessage, indexContacts, needsReview, prepare, variantOf
};
