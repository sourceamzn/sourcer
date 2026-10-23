"use strict";
/* Fabricantes / distribuidores guardados ("favoritos" de la busqueda de
   proveedores) con su estado de contacto. Un contacto = un dominio; puede
   estar ligado a varios productos.

   GET    /contacts                 -> lista
   POST   /contacts                 -> { lead, product } guarda o fusiona
   PATCH  /contacts/:id             -> { status, notes, emails, phones, event }
   DELETE /contacts/:id
   POST   /contacts/:id/scan        -> busca email/telefono/WhatsApp en su web */

const express = require("express");
const docs = require("../lib/docstore");
const contactScan = require("../lib/contactscan");
const outreach = require("../lib/outreach");
const { config } = require("../config");

const router = express.Router();
const COLL = "contacts";
const STATUS = ["pendiente", "contactado", "respondido", "tarifa", "negociando", "sin_respuesta", "rechazado", "descartado"];

/* Arranque automatico de la secuencia: con email, SMTP y datos del remitente. */
async function maybeAutoStart(c) {
  try {
    if (!config.outreach.autoStart || !outreach.mailReady()) return false;
    if (!(c.emails || []).length || c.outreach || c.status !== "pendiente") return false;
    if (!outreach.senderOk(await outreach.getSender())) return false;
    if (!outreach.templateCount(await outreach.getTemplates())) return false;
    outreach.startOutreach(c);
    return true;
  } catch (e) { return false; }
}

function ah(fn) {
  return function (req, res) {
    fn(req, res).catch(function (e) { res.status(500).json({ ok: false, reason: String((e && e.message) || e) }); });
  };
}
function str(v, n) { return v == null ? "" : String(v).trim().slice(0, n || 500); }
function hostOf(u) { try { return new URL(String(u)).hostname.toLowerCase().replace(/^www\d?\./, ""); } catch (e) { return ""; } }
function uniq(list, n) {
  const out = [];
  (list || []).forEach(function (x) { x = str(x, 200); if (x && out.indexOf(x) === -1) out.push(x); });
  return out.slice(0, n || 10);
}
function productOf(p) {
  p = p || {};
  return {
    key: str(p.asin || p.ean || p.name, 120), asin: str(p.asin, 20), ean: str(p.ean, 20),
    name: str(p.name || p.title, 200), brand: str(p.brand, 80), model: str(p.model || p.partNumber, 60),
    image: str(p.image, 500), priceMax: Number(p.priceMax) || 0, priceMaxNet: Number(p.priceMaxNet) || 0,
    breakEven: Number(p.breakEven) || 0, pvp: Number(p.pvp) || 0, addedAt: new Date().toISOString()
  };
}

router.get("/", ah(async function (req, res) {
  const list = await docs.list(COLL);
  res.json({ ok: true, store: docs.kind(), contacts: list });
}));

router.post("/", ah(async function (req, res) {
  const b = req.body || {};
  const lead = b.lead || {};
  const host = hostOf(lead.url) || str(lead.host, 120);
  if (!host) return res.status(400).json({ ok: false, reason: "lead_sin_web" });
  const now = new Date().toISOString();
  const prev = (await docs.get(COLL, host)) || {
    id: host, host: host, createdAt: now, status: "pendiente", notes: "", products: [], history: [],
    emails: [], phones: [], whatsapp: []
  };
  prev.url = str(lead.url, 500) || prev.url || ("https://" + host);
  prev.title = str(lead.title, 200) || prev.title || host;
  prev.role = str(lead.role, 40) || prev.role || "";
  prev.roleLabel = str(lead.roleLabel, 80) || prev.roleLabel || "";
  prev.distributorLink = str(lead.page && lead.page.distributorLink, 500) || prev.distributorLink || "";
  const c = lead.contact || {};
  prev.emails = uniq([].concat(prev.emails || [], c.emails || []), 8);
  prev.phones = uniq([].concat(prev.phones || [], c.phones || []), 6);
  const prod = productOf(b.product);
  prod.leadUrl = str(lead.url, 500);
  prod.price = lead.price && lead.price.price > 0 ? { price: Number(lead.price.price), vat: lead.price.vat || null } : null;
  prod.band = (lead.priceCheck && lead.priceCheck.band) || "";
  if (prod.key) {
    const i = prev.products.findIndex(function (x) { return x.key === prod.key; });
    if (i === -1) prev.products.unshift(prod); else prev.products[i] = Object.assign(prev.products[i], prod, { addedAt: prev.products[i].addedAt });
  }
  prev.history = (prev.history || []).concat([{ at: now, type: "guardado", text: "Guardado desde la busqueda de " + (prod.name || prod.asin || "producto") }]).slice(-100);
  prev.updatedAt = now;
  await maybeAutoStart(prev);
  await docs.put(COLL, host, prev);
  res.json({ ok: true, contact: prev });
}));

router.patch("/:id", ah(async function (req, res) {
  const id = str(req.params.id, 200);
  const c = await docs.get(COLL, id);
  if (!c) return res.status(404).json({ ok: false, reason: "no_encontrado" });
  const b = req.body || {};
  const now = new Date().toISOString();
  if (b.status && STATUS.indexOf(b.status) !== -1 && b.status !== c.status) {
    c.history = (c.history || []).concat([{ at: now, type: "estado", text: c.status + " -> " + b.status }]);
    c.status = b.status;
    if (b.status === "contactado" && !c.contactedAt) c.contactedAt = now;
    /* Si lo marcas tu como respondido/tarifa/descartado, se para la secuencia. */
    if (c.outreach && ["activo", "revision", "esperando", "llamar"].indexOf(c.outreach.state) !== -1 && ["respondido", "tarifa", "negociando", "descartado", "rechazado"].indexOf(b.status) !== -1) {
      c.outreach.state = b.status === "descartado" ? "parado" : "respondido"; c.outreach.nextAt = null;
    }
    if (b.status === "respondido" || b.status === "tarifa") c.starred = true;
  }
  if (b.notes != null) c.notes = str(b.notes, 4000);
  if (b.starred != null) c.starred = Boolean(b.starred);
  /* Datos que usan las plantillas del plan de contacto. */
  if (b.contactName != null) c.contactName = str(b.contactName, 80);
  if (b.volume != null) c.volume = str(b.volume, 40);
  if (b.lang != null) c.lang = str(b.lang, 5).toLowerCase();
  if (b.country != null) c.country = str(b.country, 2).toUpperCase();
  if (Array.isArray(b.emails)) c.emails = uniq(b.emails, 8);
  if (Array.isArray(b.phones)) c.phones = uniq(b.phones, 6);
  if (b.removeProduct) c.products = (c.products || []).filter(function (p) { return p.key !== b.removeProduct; });
  if (b.event && b.event.text) c.history = (c.history || []).concat([{ at: now, type: str(b.event.type, 20) || "nota", text: str(b.event.text, 500) }]);
  c.history = (c.history || []).slice(-100);
  c.updatedAt = now;
  await docs.put(COLL, id, c);
  res.json({ ok: true, contact: c });
}));

/* Vaciar la lista entera (empezar de cero). Exige { confirm: "VACIAR" }. */
router.post("/reset", ah(async function (req, res) {
  if (String((req.body || {}).confirm || "") !== "VACIAR") return res.status(400).json({ ok: false, reason: "falta_confirmacion" });
  const list = await docs.list(COLL);
  for (let i = 0; i < list.length; i++) await docs.del(COLL, list[i].id);
  res.json({ ok: true, deleted: list.length });
}));

router.delete("/:id", ah(async function (req, res) {
  const ok = await docs.del(COLL, str(req.params.id, 200));
  res.json({ ok: ok });
}));

router.post("/:id/scan", ah(async function (req, res) {
  const id = str(req.params.id, 200);
  const c = await docs.get(COLL, id);
  if (!c) return res.status(404).json({ ok: false, reason: "no_encontrado" });
  const r = await contactScan.scan(c.url || ("https://" + c.host), { maxPages: 6, timeoutMs: 8000 });
  const now = new Date().toISOString();
  c.emails = uniq([].concat(r.emails || [], c.emails || []), 8);
  c.phones = uniq([].concat(c.phones || [], r.phones || []), 6);
  c.whatsapp = uniq([].concat(c.whatsapp || [], r.whatsapp || []), 4);
  c.mobiles = uniq([].concat(c.mobiles || [], r.mobiles || []), 4);
  if (r.cif) c.cif = r.cif;
  if (r.company) c.company = r.company;
  if (r.form) c.form = r.form;
  if (r.pageLang) c.pageLang = r.pageLang;
  c.scannedAt = now;
  c.history = (c.history || []).concat([{ at: now, type: "datos", text: r.ok ? ("Datos de contacto: " + (r.emails || []).length + " email(s), " + (r.phones || []).length + " telefono(s), " + (r.whatsapp || []).length + " WhatsApp; " + r.pages.length + " pagina(s) leidas.") : ("No se pudo leer la web (" + (r.reason || "error") + ").") }]).slice(-100);
  c.updatedAt = now;
  await maybeAutoStart(c);
  await docs.put(COLL, id, c);
  res.json({ ok: true, contact: c, scan: { ok: r.ok, pages: r.pages, reason: r.reason || null } });
}));

/* Secuencia de correos de un contacto: start | pause | resume | sendnow */
router.post("/:id/outreach", ah(async function (req, res) {
  const id = str(req.params.id, 200);
  const c = await docs.get(COLL, id);
  if (!c) return res.status(404).json({ ok: false, reason: "no_encontrado" });
  const action = str((req.body || {}).action, 20);
  if (action === "start" || action === "resume" || action === "sendnow") {
    if (!(c.emails || []).length) return res.status(400).json({ ok: false, reason: "sin_email", hint: "Pulsa «Buscar email / teléfono» o añade un email a mano." });
    if (c.outreach && ["respondido", "baja", "rechazado"].indexOf(c.outreach.state) !== -1) return res.status(400).json({ ok: false, reason: "ya_respondio" });
    if (!outreach.templateCount(await outreach.getTemplates())) return res.status(400).json({ ok: false, reason: "faltan_plantillas", hint: "Escribe al menos el correo de bienvenida en «Plantillas de correo»." });
    outreach.startOutreach(c, action === "sendnow" ? { now: true } : {});
  } else if (action === "pause") outreach.pauseOutreach(c);
  else if (action === "approve") {
    const r = await outreach.approveDraft(c, { subject: (req.body || {}).subject, text: (req.body || {}).text });
    if (!r.ok) return res.status(400).json(r);
  } else if (action === "reject") {
    const r = outreach.rejectDraft(c);
    if (!r.ok) return res.status(400).json(r);
  }
  else return res.status(400).json({ ok: false, reason: "accion_desconocida" });
  c.updatedAt = new Date().toISOString();
  await docs.put(COLL, id, c);
  res.json({ ok: true, contact: c, mail: { smtp: outreach.mailReady() } });
}));

/* Iniciar la secuencia en todos los pendientes con email (o en los ids dados). */
router.post("/bulk-outreach", ah(async function (req, res) {
  const ids = Array.isArray((req.body || {}).ids) ? req.body.ids.map(function (x) { return str(x, 200); }) : null;
  const list = await docs.list(COLL);
  let started = 0;
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (ids && ids.indexOf(c.id) === -1) continue;
    if (!ids && c.status !== "pendiente") continue;
    if (!(c.emails || []).length || (c.outreach && c.outreach.state !== "pausado")) continue;
    outreach.startOutreach(c);
    c.updatedAt = new Date().toISOString();
    await docs.put(COLL, c.id, c);
    started++;
  }
  res.json({ ok: true, started: started });
}));

module.exports = router;
